/**
 * Cross-domain runtime agent-event infrastructure.
 *
 * Owns the generic OpenClaw `events.onAgentEvent` surface that several
 * domains consume: event typing, reference-counted fan-out, field accessors,
 * and run correlation. Domain owners (ack reactions, AI card task progress)
 * build their own behavior on top of these primitives instead of importing
 * each other's private modules.
 */

import { getErrorMessage } from "../utils";

export type RuntimeEventsLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type RuntimeAgentEvent = {
  stream?: string;
  runId?: string;
  sessionKey?: string;
  data?: {
    phase?: string;
    name?: string;
    args?: unknown;
    runId?: string;
    sessionKey?: string;
    toolCallId?: string;
    meta?: {
      runId?: string;
      sessionKey?: string;
    } | null;
  };
};

export type RuntimeEventsSurface = {
  onAgentEvent?: (listener: (event: unknown) => void) => () => void;
};

/**
 * Fan one upstream `onAgentEvent` subscription out to multiple local consumers.
 *
 * The upstream subscription is reference-counted: it is created with the first
 * local listener and released with the last one. Each listener is isolated so a
 * throwing consumer can neither starve the remaining consumers nor bubble back
 * into the host event emitter.
 */
export function createRuntimeEventsFanout(
  upstream: RuntimeEventsSurface | undefined,
  options: { log?: RuntimeEventsLogger } = {},
): RuntimeEventsSurface {
  const listeners = new Set<(event: unknown) => void>();
  let unsubscribeUpstream: (() => void) | undefined;

  const ensureUpstreamSubscription = () => {
    if (unsubscribeUpstream || !upstream?.onAgentEvent) {
      return;
    }
    unsubscribeUpstream = upstream.onAgentEvent((event: unknown) => {
      // Dispatch against a snapshot so a listener that unsubscribes another
      // listener during this event still receives the current event.
      const currentListeners = Array.from(listeners);
      for (const listener of currentListeners) {
        try {
          listener(event);
        } catch (error: unknown) {
          options.log?.warn?.(
            `[DingTalk][RuntimeEvents] Listener failed: ${getErrorMessage(error)}`,
          );
        }
      }
    });
  };

  return {
    onAgentEvent(listener: (event: unknown) => void) {
      listeners.add(listener);
      ensureUpstreamSubscription();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribeUpstream) {
          unsubscribeUpstream();
          unsubscribeUpstream = undefined;
        }
      };
    },
  };
}

function firstTrimmedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function getEventRunId(event: RuntimeAgentEvent | undefined): string | undefined {
  return firstTrimmedString(event?.runId, event?.data?.runId, event?.data?.meta?.runId);
}

export function getEventSessionKey(event: RuntimeAgentEvent | undefined): string | undefined {
  return firstTrimmedString(
    event?.sessionKey,
    event?.data?.sessionKey,
    event?.data?.meta?.sessionKey,
  );
}

export function describeEvent(event: RuntimeAgentEvent | undefined): string {
  const stream = firstTrimmedString(event?.stream) || "-";
  const phase = firstTrimmedString(event?.data?.phase) || "-";
  const toolName = firstTrimmedString(event?.data?.name) || "-";
  const toolCallId = firstTrimmedString(event?.data?.toolCallId) || "-";
  return (
    `stream=${stream} phase=${phase} runId=${getEventRunId(event) || "-"} ` +
    `sessionKey=${getEventSessionKey(event) || "-"} toolCallId=${toolCallId} toolName=${toolName}`
  );
}

/**
 * Build a predicate that decides whether an agent event belongs to one reply.
 *
 * Correlation prefers an already captured `runId`; otherwise it accepts events
 * whose `sessionKey` matches, and finally falls back to optimistically
 * capturing the first session-less lifecycle start inside a short window.
 *
 * `consumer` labels the debug logs so two consumers sharing the same session
 * (ack reactions and card task progress) stay distinguishable while triaging.
 */
export function createAgentEventCorrelator(params: {
  /** Short label identifying the consuming domain in debug logs. */
  consumer: string;
  sessionKey: string;
  enabled: boolean;
  createdAt: number;
  optimisticCaptureWindowMs: number;
  log?: RuntimeEventsLogger;
}) {
  const logPrefix = `[DingTalk][AgentEventCorrelation][${params.consumer}]`;
  let activeRunId: string | undefined;
  let correlationUnavailableLogged = false;
  let optimisticCaptureCount = 0;

  return (event: RuntimeAgentEvent | undefined): boolean => {
    const eventRunId = getEventRunId(event);
    const eventSessionKey = getEventSessionKey(event);
    const eventStream = firstTrimmedString(event?.stream) || "";
    const eventPhase = firstTrimmedString(event?.data?.phase) || "";

    if (activeRunId) {
      const matched = eventRunId === activeRunId;
      params.log?.debug?.(
        `${logPrefix} correlation by runId matched=${matched} activeRunId=${activeRunId} ` +
          `eventRunId=${eventRunId || "-"} eventSessionKey=${eventSessionKey || "-"}`,
      );
      return matched;
    }

    if (eventSessionKey === params.sessionKey) {
      if (eventRunId) {
        activeRunId = eventRunId;
        params.log?.debug?.(
          `${logPrefix} captured active runId=${activeRunId} from sessionKey=${params.sessionKey}`,
        );
      } else {
        params.log?.debug?.(
          `${logPrefix} correlated by sessionKey=${params.sessionKey} without runId`,
        );
      }
      return true;
    }

    if (
      optimisticCaptureCount === 0 &&
      eventStream === "lifecycle" &&
      eventPhase === "start" &&
      eventRunId &&
      !eventSessionKey &&
      Date.now() - params.createdAt <= params.optimisticCaptureWindowMs
    ) {
      optimisticCaptureCount += 1;
      activeRunId = eventRunId;
      params.log?.debug?.(
        `${logPrefix} optimistically captured active runId=${activeRunId} ` +
          `from first lifecycle event without sessionKey windowMs=${params.optimisticCaptureWindowMs}`,
      );
      return true;
    }

    if (!correlationUnavailableLogged && params.enabled) {
      correlationUnavailableLogged = true;
      params.log?.debug?.(
        `${logPrefix} ignored uncorrelated agent events; ` +
          `reason=${getErrorMessage(eventRunId || eventSessionKey || "waiting for sessionKey/runId match")}`,
      );
    }
    return false;
  };
}
