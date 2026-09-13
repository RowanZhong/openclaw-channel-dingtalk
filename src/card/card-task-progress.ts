import {
  createAgentEventCorrelator,
  type RuntimeAgentEvent,
  type RuntimeEventsLogger,
  type RuntimeEventsSurface,
} from "../platform/runtime-events";
import type { CardTaskProgressRefresh, DingTalkConfig } from "../types";
import { getErrorMessage } from "../utils";

const DEFAULT_START_DELAY_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const OPTIMISTIC_RUN_ID_CAPTURE_WINDOW_MS = 5_000;
const CORRELATION_CONSUMER = "card-task-progress";

/**
 * Decide whether the live task-progress block is allowed for this card.
 *
 * `cardTaskProgress` is tri-state on purpose: explicit `true`/`false` always
 * wins. When unset the block is on by default, except for an explicit
 * `cardStreamingMode: "off"` — that is a deliberate "keep card traffic
 * minimal" request, so progress stays quiet until the user opts back in.
 *
 * The runtime normalizes an omitted `cardStreamingMode` to `"off"` before the
 * config reaches this point, so the effective value alone cannot tell "omitted"
 * apart from "explicitly off". `cardStreamingModeConfigured` carries that
 * distinction; configs that never went through normalization (hand-built test
 * or embedded configs) fall back to "was a mode present at all".
 */
export function resolveCardTaskProgressEnabled(
  config: Pick<
    DingTalkConfig,
    "cardTaskProgress" | "cardStreamingMode" | "cardStreamingModeConfigured"
  >,
): boolean {
  if (config.cardTaskProgress === false) {
    return false;
  }
  if (config.cardTaskProgress === true) {
    return true;
  }
  const explicitlyConfigured =
    config.cardStreamingModeConfigured ?? config.cardStreamingMode !== undefined;
  if (!explicitlyConfigured) {
    return true;
  }
  return config.cardStreamingMode !== "off";
}

function resolveSafeStage(toolName: unknown): string {
  const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  if (["read", "view", "find", "list", "glob"].includes(name)) {
    return "正在检查文件";
  }
  if (["write", "edit", "patch", "apply_patch"].includes(name)) {
    return "正在应用修改";
  }
  if (["web_search", "search", "fetch", "open", "open_url"].includes(name)) {
    return "正在查询资料";
  }
  if (name.includes("browser")) {
    return "正在验证页面";
  }
  if (["bash", "exec", "process", "exec_command"].includes(name)) {
    return "正在执行检查";
  }
  if (name.includes("database") || name.includes("sql") || name.includes("query")) {
    return "正在查询数据";
  }
  return "正在处理任务";
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

export interface CardTaskProgressController {
  /** Wait for queued card updates to settle (test/observability helper). */
  awaitDrain(): Promise<void>;
  /**
   * Release timers and the runtime-event subscription, then remove the
   * progress block. Idempotent, and safe to call when nothing was rendered.
   *
   * `clearRemoteWhenEmpty` is for teardown paths that will never commit the
   * card (for example ask-user question-card takeover): when the progress block
   * was the only visible block, the local removal must also clear the remote
   * card, otherwise the reader keeps seeing a live-looking "任务处理中" card.
   */
  dispose(options?: { clearRemoteWhenEmpty?: boolean }): Promise<void>;
}

export interface ClearProgressOptions {
  /** Clear the remote card when removing progress leaves no visible block. */
  clearRemoteWhenEmpty?: boolean;
}

/**
 * Keep one replaceable "task in progress" block on an AI card.
 *
 * Returns a no-op controller when progress is disabled by config or when the
 * session key is unknown: without a session key the correlator could only rely
 * on its optimistic window, which surfaces as an intermittently missing block.
 */
export function createCardTaskProgressController(params: {
  sessionKey: string;
  enabled?: boolean;
  /**
   * `heartbeat` (default) coalesces stage/step changes into the 30s refresh;
   * `interval` pushes them on every correlated tool event, throttled further
   * down by the card draft loop's `cardStreamInterval`.
   */
  refresh?: CardTaskProgressRefresh;
  runtimeEvents?: RuntimeEventsSurface;
  updateProgress: (text: string) => Promise<void>;
  clearProgress: (options?: ClearProgressOptions) => Promise<void>;
  startDelayMs?: number;
  heartbeatIntervalMs?: number;
  log?: RuntimeEventsLogger;
}): CardTaskProgressController {
  const sessionKey = params.sessionKey?.trim() ?? "";
  if (params.enabled === false || !sessionKey) {
    params.log?.debug?.(
      `[DingTalk][TaskProgress] Disabled — enabled=${params.enabled !== false} hasSessionKey=${Boolean(sessionKey)}`,
    );
    return {
      async awaitDrain(): Promise<void> {},
      async dispose(): Promise<void> {},
    };
  }

  // Unknown values (hand-built config) fall back to the safe default.
  const refreshMode: CardTaskProgressRefresh =
    params.refresh === "interval" ? "interval" : "heartbeat";

  const startedAt = Date.now();
  let currentStage = "正在处理任务";
  let completedSteps = 0;
  let visible = false;
  let disposed = false;
  let updatePromise: Promise<void> = Promise.resolve();
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let startTimer: NodeJS.Timeout | undefined;
  const completedToolCalls = new Set<string>();
  const isCorrelatedEvent = createAgentEventCorrelator({
    consumer: CORRELATION_CONSUMER,
    sessionKey,
    enabled: true,
    createdAt: startedAt,
    optimisticCaptureWindowMs: OPTIMISTIC_RUN_ID_CAPTURE_WINDOW_MS,
    log: params.log,
  });

  const render = (): string => {
    const now = Date.now();
    return [
      "⏳ 任务处理中",
      `当前阶段：${currentStage}`,
      `已完成：${completedSteps} 步`,
      `已耗时：${formatElapsed(now - startedAt)}`,
    ].join("\n");
  };

  const awaitDrain = async (): Promise<void> => {
    await updatePromise.catch(() => undefined);
  };

  const cancelStartTimer = () => {
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = undefined;
    }
  };

  const ensureHeartbeat = () => {
    if (heartbeatTimer || disposed) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (visible) {
        void enqueueUpdate();
      }
    }, params.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    // Never keep the gateway process alive for a cosmetic heartbeat.
    heartbeatTimer.unref?.();
  };

  const enqueueUpdate = () => {
    if (disposed) {
      return updatePromise;
    }
    updatePromise = updatePromise
      .then(() => params.updateProgress(render()))
      .catch((error: unknown) => {
        params.log?.warn?.(
          `[DingTalk][TaskProgress] Card update failed: ${getErrorMessage(error)}`,
        );
      });
    return updatePromise;
  };

  /**
   * Make the block visible for the first time and start the heartbeat.
   *
   * The first appearance is always immediate. Later stage/step changes follow
   * `refreshMode`: `heartbeat` (default) leaves them to the next 30s refresh, so
   * a tool-heavy task cannot spend one DingTalk card update per tool event;
   * `interval` pushes them right away and lets `cardStreamInterval` throttle.
   */
  const showProgress = () => {
    if (disposed || visible) {
      return;
    }
    visible = true;
    // An early tool event already satisfied the startup delay.
    cancelStartTimer();
    ensureHeartbeat();
    void enqueueUpdate();
  };

  const refreshProgress = () => {
    if (disposed) {
      return;
    }
    if (!visible) {
      showProgress();
      return;
    }
    if (refreshMode === "interval") {
      void enqueueUpdate();
    }
  };

  const handleAgentEvent = (event: unknown) => {
    if (disposed) {
      return;
    }
    const agentEvent = event as RuntimeAgentEvent | undefined;
    if (agentEvent?.stream === "lifecycle" && agentEvent.data?.phase === "start") {
      void isCorrelatedEvent(agentEvent);
      return;
    }
    if (agentEvent?.stream !== "tool" || !isCorrelatedEvent(agentEvent)) {
      return;
    }

    if (agentEvent.data?.phase === "start") {
      currentStage = resolveSafeStage(agentEvent.data?.name);
      refreshProgress();
      return;
    }
    if (agentEvent.data?.phase === "end") {
      const toolCallId = agentEvent.data?.toolCallId?.trim();
      if (!toolCallId || !completedToolCalls.has(toolCallId)) {
        if (toolCallId) {
          completedToolCalls.add(toolCallId);
        }
        completedSteps += 1;
      }
      refreshProgress();
    }
  };

  const unsubscribe = params.runtimeEvents?.onAgentEvent?.(handleAgentEvent) ?? (() => {});
  startTimer = setTimeout(() => {
    showProgress();
  }, params.startDelayMs ?? DEFAULT_START_DELAY_MS);
  startTimer.unref?.();

  return {
    awaitDrain,
    async dispose(options: { clearRemoteWhenEmpty?: boolean } = {}): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      cancelStartTimer();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      // A host-provided unsubscribe must not skip the card cleanup below.
      try {
        unsubscribe();
      } catch (error: unknown) {
        params.log?.warn?.(
          `[DingTalk][TaskProgress] Unsubscribe failed: ${getErrorMessage(error)}`,
        );
      }
      await awaitDrain();
      if (visible) {
        await params.clearProgress(options);
      }
    },
  };
}
