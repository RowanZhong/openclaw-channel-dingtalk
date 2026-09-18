import { hasActiveDingTalkCollection } from "./ask-user-question";
import type { QuestionScheduleStore, ScheduledForm } from "./question-schedule-store";

/** A stopped sender may have reached DingTalk. Reconcile, but never resend implicitly. */
export function reconcileScheduledCard(
  store: QuestionScheduleStore,
  template: ScheduledForm,
  processId: string,
): ScheduledForm {
  if (template.lastRun?.state !== "sending" || template.lastRun.processId === processId) {
    return template;
  }
  return store.update(template.id, (current) => ({
    ...current!,
    lastOutcome: { ...current!.lastOutcome, status: "uncertain" },
    lastRun: { ...current!.lastRun!, state: "uncertain" },
  }));
}

/** Caller must verify current owner, conversation, agent and bot authorization. */
export function recoverScheduledCard(
  store: QuestionScheduleStore,
  template: ScheduledForm,
  sequence: number,
  acknowledged: boolean,
): void {
  const previous = template.lastRun;
  if (!acknowledged) {
    throw new Error(
      "Explicit acknowledgement is required: this occurrence may already have sent a card and will be abandoned, not resent",
    );
  }
  if (!previous || previous.sequence !== sequence || template.lastSequence !== sequence) {
    throw new Error(
      "Recovery sequence changed; list the schedule and confirm the currently blocked occurrence",
    );
  }
  if (previous.recoveredAt && template.lastOutcome?.status === "abandoned") {
    return;
  }
  if (previous.state !== "uncertain" || hasActiveDingTalkCollection(previous.questionId)) {
    throw new Error(
      "Only an uncertain, inactive card delivery can be recovered; an active send or collection cannot be replaced",
    );
  }
  store.update(template.id, (current) => ({
    ...current!,
    lastOutcome: { status: "abandoned", questionId: previous.questionId },
    lastRun: { ...previous, state: "abandoned", recoveredAt: Date.now() },
  }));
}
