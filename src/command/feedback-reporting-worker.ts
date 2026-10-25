import { parentPort, workerData } from "node:worker_threads";
import { collectReportContent } from "./feedback-reporting-content";
import { readSmallJson, reportPaths, writeReportJson } from "./feedback-reporting-io";
import {
  createReportEnvelope,
  retryDelay,
  type ReportContent,
  type ReportJob,
  type ReportReceipt,
  type ReportResult,
  type ReportState,
} from "./feedback-reporting-protocol";
import { postFeedbackReport } from "./feedback-reporting-transport";

export async function executeReportJob(job: ReportJob): Promise<ReportResult> {
  const paths = reportPaths(job.scope, job.record.outTrackId, job.config.destinationKey);
  const sourceRevision = job.record.reporting?.revision;
  if (!sourceRevision || job.record.reporting?.destinationKey !== job.config.destinationKey) {
    return { kind: "error", code: "scope_mismatch" };
  }
  const old = await readSmallJson<ReportState>(paths.state, 350 * 1024);
  if (
    old &&
    (old.destinationKey !== job.config.destinationKey ||
      !Number.isSafeInteger(old.wireRevision) ||
      !old.envelope)
  ) {
    throw new Error("invalid_outbox");
  }
  const sameSource = old?.sourceRevision === sourceRevision;
  if (sameSource && (old.delivered || old.superseded) && old.terminal) {
    const {
      sourceRevision,
      wireRevision,
      terminal,
      nextAttemptAt,
      expiresAt,
      attempts,
      error,
      superseded,
    } = old;
    const receipt = {
      sourceRevision,
      wireRevision,
      terminal,
      nextAttemptAt,
      expiresAt,
      attempts,
      error,
      superseded,
    };
    await writeReportJson(paths.receipt, receipt);
    return { kind: "done", receipt };
  }
  let state: ReportState;
  if (sameSource && !old.delivered && !job.metadataOnly) {
    state = old; // Replay the exact durable envelope after an uncertain delivery.
  } else {
    let content: ReportContent;
    if (old?.delivered && old.terminal) {
      content = {
        mode: "preserve",
        status: old.envelope.content.status,
        reason: old.envelope.content.reason,
        answerHash: job.record.answerHash,
      };
    } else if (old?.envelope.content.status === "available") {
      content = old.envelope.content;
    } else {
      content = await collectReportContent(job);
    }
    const revision = Math.max(sourceRevision, (old?.wireRevision ?? 0) + 1);
    state = {
      sourceRevision,
      wireRevision: revision,
      destinationKey: job.config.destinationKey,
      terminal: content.status !== "pending",
      delivered: false,
      envelope: createReportEnvelope(job, revision, content),
      attempts: old?.attempts ?? 0,
      nextAttemptAt: 0,
      expiresAt: Math.max(job.record.expiresAt, job.record.reporting.retainUntil),
    };
    // Persist before network I/O: a crash or ambiguous HTTP result is safe to replay.
    await writeReportJson(paths.state, state);
  }
  try {
    const ack = await postFeedbackReport(
      job.config.endpoint,
      job.token,
      state.envelope,
      job.config.requestTimeoutMs,
    );
    if (ack.status === "stale") {
      // Never manufacture a newer version for a stale local snapshot: that could
      // resurrect an old like after a receiver already stored a withdrawal.
      state.wireRevision = ack.acceptedRevision;
      state.superseded = true;
      state.terminal = true;
      state.delivered = false;
      state.nextAttemptAt = 0;
      state.error = "remote_newer_snapshot";
    } else {
      state.delivered = true;
      state.attempts = 0;
      delete state.error;
      state.nextAttemptAt = state.terminal ? 0 : Date.now() + 300_000;
      if (state.terminal) {
        state.envelope.content = {
          mode: "preserve",
          status: state.envelope.content.status,
          reason: state.envelope.content.reason,
          answerHash: job.record.answerHash,
        };
      }
    }
  } catch (error) {
    state.attempts++;
    state.nextAttemptAt = Date.now() + retryDelay(state.attempts);
    const message = (error as Error).message;
    state.error =
      /^(http_\d{3}|invalid_ack|request_timeout|response_size_limit|request_size_limit)$/.test(
        message,
      )
        ? message
        : "network_error";
  }
  await writeReportJson(paths.state, state);
  const receipt: ReportReceipt = {
    sourceRevision: state.sourceRevision,
    wireRevision: state.wireRevision,
    terminal: (state.delivered || Boolean(state.superseded)) && state.terminal,
    superseded: state.superseded,
    nextAttemptAt: state.nextAttemptAt,
    expiresAt: state.expiresAt,
    attempts: state.attempts,
    error: state.error,
  };
  await writeReportJson(paths.receipt, receipt);
  return { kind: "done", receipt };
}

if (parentPort && workerData?.kind === "dingtalk-feedback-report") {
  let busy = false;
  parentPort.on("message", (message: { kind: string; job: ReportJob }) => {
    if (message.kind !== "job" || busy) {
      return;
    }
    busy = true;
    executeReportJob(message.job)
      .then(
        (result) => parentPort!.postMessage(result),
        () =>
          parentPort!.postMessage({
            kind: "error",
            code: "worker_operation_failed",
          } satisfies ReportResult),
      )
      .finally(() => {
        busy = false;
      });
  });
}
