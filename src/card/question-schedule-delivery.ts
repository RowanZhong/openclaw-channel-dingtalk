import { randomUUID } from "node:crypto";
import { sendMessage } from "../messaging/send-service";
import type { DingTalkConfig, DingTalkQuestionCollectionResult, Logger } from "../platform/types";
import { formatScheduledFormResult } from "./question-schedule-result";
import type {
  QuestionScheduleStore,
  ScheduledForm,
  ScheduledResultDelivery,
} from "./question-schedule-store";

const activeDeliveries = new Set<string>();
const COMPLETED_RECEIPTS_TO_KEEP = 20;
function key(store: QuestionScheduleStore, id: string, sequence: number): string {
  return JSON.stringify([store.storePath, id, sequence]);
}
function getDelivery(template: ScheduledForm, sequence: number): ScheduledResultDelivery {
  const delivery = template.resultDeliveries?.find((item) => item.sequence === sequence);
  if (!delivery) {
    throw new Error(
      "No retained result for this occurrence; older versions did not save failed summaries",
    );
  }
  return delivery;
}
function updateDelivery(
  store: QuestionScheduleStore,
  id: string,
  sequence: number,
  mutate: (delivery: ScheduledResultDelivery) => ScheduledResultDelivery,
): ScheduledResultDelivery {
  let result!: ScheduledResultDelivery;
  store.update(id, (current) => {
    const updated = mutate(getDelivery(current!, sequence));
    result = updated;
    const deliveries = current!.resultDeliveries!.map((item) =>
      item.sequence === sequence ? updated : item,
    );
    const completed = new Set(
      deliveries
        .filter((item) => item.state === "delivered")
        .toSorted((a, b) => b.sequence - a.sequence)
        .slice(0, COMPLETED_RECEIPTS_TO_KEEP),
    );
    return {
      ...current!,
      resultDeliveries: deliveries.filter(
        (item) => item.state !== "delivered" || completed.has(item),
      ),
      lastRun:
        current!.lastRun?.sequence === sequence
          ? { ...current!.lastRun, deliveryError: updated.state !== "delivered" }
          : current!.lastRun,
    };
  });
  // An old result can complete after many later runs; its receipt may already be pruned.
  return result;
}

/** Atomically save the complete result before marking collection completion or sending any part. */
export function queueScheduledResult(
  store: QuestionScheduleStore,
  id: string,
  sequence: number,
  collection: DingTalkQuestionCollectionResult,
): void {
  store.update(id, (current) => {
    if (current?.resultDeliveries?.some((item) => item.sequence === sequence)) {
      return current;
    }
    if (current?.lastRun?.sequence !== sequence) {
      throw new Error("Cannot replace a newer occurrence with a stale result callback");
    }
    const chunks = formatScheduledFormResult(collection, current.respondentNames);
    return {
      ...current,
      lastRun: {
        ...current.lastRun,
        state: "completed",
        resultStatus: collection.status,
        deliveryError: true,
      },
      resultDeliveries: [
        ...(current.resultDeliveries ?? []),
        {
          sequence,
          questionId: collection.question_id,
          createdAt: Date.now(),
          state: "pending",
          chunks,
          totalChunks: chunks.length,
          nextChunk: 0,
        },
      ],
    };
  });
}

export function listScheduledResultDeliveries(
  store: QuestionScheduleStore,
  template: ScheduledForm,
) {
  const stranded = template.resultDeliveries?.some(
    (item) =>
      item.state === "sending" && !activeDeliveries.has(key(store, template.id, item.sequence)),
  );
  if (stranded) {
    template = store.update(template.id, (current) => ({
      ...current!,
      resultDeliveries: current!.resultDeliveries?.map((item) =>
        item.state === "sending" && !activeDeliveries.has(key(store, template.id, item.sequence))
          ? { ...item, state: "uncertain" }
          : item,
      ),
    }));
  }
  // Do not expose saved answers as model context or through management responses.
  return (template.resultDeliveries ?? []).map((item) => ({
    sequence: item.sequence,
    questionId: item.questionId,
    state: item.state,
    sentChunks: item.nextChunk,
    totalChunks: item.totalChunks,
    attemptId: item.attempt?.id,
  }));
}

export async function deliverScheduledResult(params: {
  store: QuestionScheduleStore;
  template: ScheduledForm;
  sequence: number;
  processId: string;
  authorize: () => { config: DingTalkConfig; storePath: string };
  log: Logger;
  acknowledgeUncertainDelivery?: boolean;
  attemptId?: string;
}): Promise<void> {
  const { store, template, sequence } = params;
  const deliveryKey = key(store, template.id, sequence);
  if (activeDeliveries.has(deliveryKey)) {
    throw new Error("Result delivery is currently running; do not retry concurrently");
  }
  listScheduledResultDeliveries(store, store.get(template.id)!);
  let delivery = getDelivery(store.get(template.id)!, sequence);
  if (delivery.state === "delivered") {
    return;
  }
  if (
    delivery.state === "uncertain" &&
    (!params.acknowledgeUncertainDelivery ||
      !delivery.attempt?.id ||
      params.attemptId !== delivery.attempt.id)
  ) {
    throw new Error(
      "This result chunk may already be delivered. List its current attemptId and obtain acknowledgement of possible duplication before retrying",
    );
  }
  activeDeliveries.add(deliveryKey);
  try {
    // Persist explicit acknowledgement before attempting the uncertain chunk again.
    if (delivery.state === "uncertain") {
      delivery = updateDelivery(store, template.id, sequence, (item) => ({
        ...item,
        state: "pending",
        attempt: undefined,
      }));
    }
    while (delivery.nextChunk < delivery.totalChunks) {
      // Recheck current authorization before every chunk, including resumed deliveries.
      const { config, storePath } = params.authorize();
      const chunk = delivery.nextChunk;
      const text = delivery.chunks[chunk];
      if (typeof text !== "string") {
        throw new Error("Stored result chunk is missing; refusing an incomplete replay");
      }
      const attempt = { id: randomUUID(), processId: params.processId, chunk };
      delivery = updateDelivery(store, template.id, sequence, (item) => ({
        ...item,
        state: "sending",
        attempt,
      }));
      try {
        const origin = template.origin;
        const destination =
          origin.conversationType === "1"
            ? `user:${origin.senderId}`
            : `group:${origin.conversationId}`;
        const sent = await sendMessage(config, destination, text, {
          accountId: origin.accountId,
          storePath,
          log: params.log,
          forceMarkdown: true,
          title: "定时表单收集结果",
        });
        if (!sent.ok) {
          throw new Error(
            "Scheduled result delivery was not acknowledged; its current chunk may already have arrived",
          );
        }
        delivery = updateDelivery(store, template.id, sequence, (item) => {
          if (item.attempt?.id !== attempt.id) {
            throw new Error("Result delivery attempt changed; refusing to advance another attempt");
          }
          const nextChunk = chunk + 1;
          const completed = nextChunk === item.totalChunks;
          return {
            ...item,
            nextChunk,
            state: completed ? "delivered" : "pending",
            chunks: completed ? [] : item.chunks,
            attempt: undefined,
          };
        });
      } catch (error) {
        updateDelivery(store, template.id, sequence, (item) => {
          // A successful cursor write may have been followed by a storage verification error.
          if (item.nextChunk > chunk || item.attempt?.id !== attempt.id) {
            return item;
          }
          return { ...item, state: "uncertain" };
        });
        throw error;
      }
    }
  } finally {
    activeDeliveries.delete(deliveryKey);
  }
}
