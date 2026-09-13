import {
  createAgentEventCorrelator,
  type RuntimeAgentEvent,
  type RuntimeEventsLogger,
  type RuntimeEventsSurface,
} from "../platform/runtime-events";
import type { CardTaskProgressRefresh, DingTalkConfig } from "../platform/types";
import { getErrorMessage } from "../shared/utils";

const DEFAULT_START_DELAY_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const OPTIMISTIC_RUN_ID_CAPTURE_WINDOW_MS = 5_000;
const CORRELATION_CONSUMER = "card-task-progress";

/**
 * Tool events use `start` / `update` / `result` (`update` is a mid-call
 * progress tick and must not count). Only the terminal phase completes a step.
 *
 * A real-device run caught this: the counter previously matched `"end"`, which
 * the runtime never emits, so "已完成 N 步" stayed at 0 forever.
 */
function isToolCompletedPhase(phase: unknown): boolean {
  return phase === "result";
}

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

/**
 * Map a tool name to a short, sanitized task-kind label.
 *
 * Labels are bare kinds (no leading 正在) because the progress line renders them
 * as `{kind}中，已完成 N 步，耗时 …`. Only the normalized tool name is used —
 * raw arguments, commands, URLs and outputs never reach the card.
 */
function resolveTaskKind(toolName: unknown): string {
  const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  if (["read", "view", "find", "list", "glob"].includes(name)) {
    return "检查文件";
  }
  if (["write", "edit", "patch", "apply_patch"].includes(name)) {
    return "应用修改";
  }
  if (["web_search", "search", "fetch", "open", "open_url"].includes(name)) {
    return "查询资料";
  }
  if (name.includes("browser")) {
    return "验证页面";
  }
  if (["bash", "exec", "process", "exec_command"].includes(name)) {
    return "执行检查";
  }
  if (name.includes("database") || name.includes("sql") || name.includes("query")) {
    return "查询数据";
  }
  return "处理任务";
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
  let currentStage = "处理任务";
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

  /**
   * One compact line, rendered as a single card block.
   *
   * Real-device constraints: inside one multi-line markdown block the DingTalk
   * client only re-renders the trailing line (which froze the step count), so a
   * single line is both the most compact shape and the only one that updates
   * reliably at every refresh cadence.
   *
   * The leading task kind comes from the normalized tool name (never raw
   * arguments), and the elapsed value renders as `n 秒` or `n 分 n 秒`.
   */
  const render = (): string =>
    `${currentStage}中，已完成 ${completedSteps} 步，耗时 ${formatElapsed(Date.now() - startedAt)}`;

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
        void enqueueUpdate("heartbeat");
      }
    }, params.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    // Never keep the gateway process alive for a cosmetic heartbeat.
    heartbeatTimer.unref?.();
  };

  /**
   * Queue one card refresh.
   *
   * The debug line is the only observable trace of what the reader actually
   * sees (the rendered text never touches the API logs), and a real-device run
   * needed exactly this to prove the step counter advances.
   */
  const enqueueUpdate = (reason: "appearance" | "heartbeat" | "tool-event") => {
    if (disposed) {
      return updatePromise;
    }
    params.log?.debug?.(
      `[DingTalk][TaskProgress] Push reason=${reason} steps=${completedSteps} ` +
        `stage="${currentStage}" elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
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
    void enqueueUpdate("appearance");
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
      void enqueueUpdate("tool-event");
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
      currentStage = resolveTaskKind(agentEvent.data?.name);
      refreshProgress();
      return;
    }
    if (isToolCompletedPhase(agentEvent.data?.phase)) {
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
