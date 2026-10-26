import { Worker } from "node:worker_threads";
import { getDingTalkRuntime } from "../runtime";
import type { FeedbackContentJob } from "./feedback-reporting-content";
import {
  beginFeedbackForegroundActivity,
  onFeedbackForegroundActivity,
  stopFeedbackBackgroundWorkers,
} from "./feedback-reporting-events";
import type { ReportContent } from "./feedback-reporting-protocol";
import type { FeedbackRecord } from "./feedback-store";

export const FEEDBACK_DETAIL_LIMITS = {
  maxTranscriptBytes: 8 * 1024 * 1024,
  maxContentBytes: 128 * 1024,
  workerMemoryMb: 128,
  timeoutMs: 10_000,
};
let active: { controller: AbortController; done: Promise<void> } | undefined;
export async function cancelFeedbackDetailReads(): Promise<void> {
  const current = active;
  if (!current) {
    return;
  }
  current.controller.abort(new Error("detail_cancelled"));
  await current.done;
}
/** The caller must authorize the record first. One bounded read per instance, no queue. */
export async function readFeedbackDetailContent(
  record: FeedbackRecord,
  sessionStoreTemplate?: string,
  options: {
    signal?: AbortSignal;
    workerUrl?: URL;
    timeoutMs?: number;
    transcriptStorePath?: string;
  } = {},
): Promise<ReportContent> {
  if (active) {
    throw new Error("detail_busy");
  }
  const controller = new AbortController();
  let release!: () => void;
  const current = {
    controller,
    done: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  active = current;
  const end = beginFeedbackForegroundActivity();
  // Our own foreground span starts before subscribing; later input may cancel us.
  const unsubscribe = onFeedbackForegroundActivity((_id, started) => {
    if (started) {
      controller.abort(new Error("detail_cancelled"));
    }
  });
  const abort = () => controller.abort(new Error("detail_cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }
  const timeout = setTimeout(
    () => controller.abort(new Error("detail_timeout")),
    options.timeoutMs ?? FEEDBACK_DETAIL_LIMITS.timeoutMs,
  );
  let worker: Worker | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => {
        controller.signal.removeEventListener("abort", cancelled);
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      stopFeedbackBackgroundWorkers().then(
        () => {
          controller.signal.removeEventListener("abort", cancelled);
          resolve();
        },
        (error) => {
          controller.signal.removeEventListener("abort", cancelled);
          reject(error);
        },
      );
      if (controller.signal.aborted) {
        cancelled();
      }
    });
    controller.signal.throwIfAborted();
    const { history: _history, seen: _seen, ...projection } = record;
    const job: FeedbackContentJob = {
      record: projection,
      config: FEEDBACK_DETAIL_LIMITS,
      transcriptStorePath:
        options.transcriptStorePath ??
        getDingTalkRuntime().channel.session.resolveStorePath(sessionStoreTemplate, {
          agentId: record.agentId,
        }),
    };
    worker = new Worker(
      options.workerUrl ?? new URL("./feedback-detail-worker.js", import.meta.url),
      {
        workerData: { kind: "dingtalk-feedback-detail", job },
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: FEEDBACK_DETAIL_LIMITS.workerMemoryMb,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      },
    );
    worker.on("error", () => {});
    if (
      (worker.resourceLimits?.maxOldGenerationSizeMb ?? Infinity) >
      FEEDBACK_DETAIL_LIMITS.workerMemoryMb
    ) {
      throw new Error("detail_budget");
    }
    const running = worker;
    return await new Promise<ReportContent>((resolve, reject) => {
      const finish = () => {
        controller.signal.removeEventListener("abort", cancelled);
        running.off("message", message);
        running.off("error", error);
        running.off("exit", exited);
      };
      const message = (result: ReportContent) => {
        finish();
        resolve(result);
      };
      const error = () => {
        finish();
        reject(new Error("detail_budget"));
      };
      const exited = () => {
        finish();
        reject(new Error("detail_cancelled"));
      };
      const cancelled = () => {
        finish();
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      running.once("message", message);
      running.once("error", error);
      running.once("exit", exited);
      if (controller.signal.aborted) {
        cancelled();
      }
    });
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    options.signal?.removeEventListener("abort", abort);
    try {
      if (worker) {
        await worker.terminate();
      }
    } finally {
      if (active === current) {
        active = undefined;
      }
      end();
      release();
    }
  }
}
