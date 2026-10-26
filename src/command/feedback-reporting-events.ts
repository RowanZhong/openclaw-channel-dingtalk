import type { FeedbackScope } from "./feedback-store";
type Listener = (scope: FeedbackScope, cardId: string) => void;
const listeners = new Set<Listener>();
export function onFeedbackReportPending(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** A bounded in-memory hint only. Durable recovery comes from the rating record. */
export function notifyFeedbackReportPending(scope: FeedbackScope, cardId: string): void {
  for (const listener of listeners) {
    try {
      listener(scope, cardId);
    } catch {
      /* Optional reporting cannot fail a saved vote. */
    }
  }
}

const activityListeners = new Set<(id: string, active: boolean) => void>();
let activitySequence = 0;
export function onFeedbackForegroundActivity(
  listener: (id: string, active: boolean) => void,
): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}
export function beginFeedbackForegroundActivity(): () => void {
  if (!activityListeners.size) {
    return () => {};
  }
  const id = `dingtalk-inbound:${++activitySequence}`;
  const emit = (active: boolean) => {
    for (const listener of activityListeners) {
      try {
        listener(id, active);
      } catch {
        /* Optional reporting cannot fail input. */
      }
    }
  };
  emit(true);
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      emit(false);
    }
  };
}
export async function withFeedbackForegroundActivity<T>(run: () => Promise<T>): Promise<T> {
  const end = beginFeedbackForegroundActivity();
  try {
    return await run();
  } finally {
    end();
  }
}

const backgroundStops = new Set<() => Promise<void>>();
/** Detail reads wait for all report workers to actually exit before allocating. */
export function onFeedbackBackgroundStop(stop: () => Promise<void>): () => void {
  backgroundStops.add(stop);
  return () => {
    backgroundStops.delete(stop);
  };
}
export async function stopFeedbackBackgroundWorkers(): Promise<void> {
  await Promise.all([...backgroundStops].map((stop) => stop()));
}
