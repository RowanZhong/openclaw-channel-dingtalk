import { parentPort, workerData } from "node:worker_threads";
import { collectReportContent } from "./feedback-reporting-content";
import { readSmallJson, reportPaths, writeReportJson } from "./feedback-reporting-io";
import {
  createReportEnvelope,
  retryDelay,
  REPORT_MAINTENANCE_VERSION,
  type ReportContent,
  type ReportJob,
  type ReportMaintenanceJob,
  type ReportWorkerJob,
  type ReportReceipt,
  type ReportResult,
  type ReportState,
} from "./feedback-reporting-protocol";
import { postFeedbackReport } from "./feedback-reporting-transport";

function needsLegacyReview(state: ReportState): boolean {
  return (
    !state.superseded &&
    state.maintenanceVersion !== REPORT_MAINTENANCE_VERSION &&
    state.envelope.content.status === "unverified" &&
    state.envelope.content.reason === "invalid_transcript"
  );
}
function removeBody(state: ReportState): void {
  state.envelope.content = {
    mode: "preserve",
    status: state.envelope.content.status,
    reason: state.envelope.content.reason,
    answerHash: state.envelope.answerHash,
  };
}
function receiptOf(state: ReportState): ReportReceipt {
  return {
    sourceRevision: state.sourceRevision,
    wireRevision: state.wireRevision,
    terminal:
      (state.delivered || Boolean(state.superseded)) && state.terminal && !needsLegacyReview(state),
    superseded: state.superseded,
    nextAttemptAt: state.nextAttemptAt,
    expiresAt: state.expiresAt,
    attempts: state.attempts,
    error: state.error,
    maintenanceVersion: state.maintenanceVersion,
  };
}

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
  // Clean stale terminal bodies without claiming delivery or submitting a new version.
  if (old?.superseded) {
    removeBody(old);
    old.maintenanceVersion = REPORT_MAINTENANCE_VERSION;
    await writeReportJson(paths.state, old);
  }
  let reviewed: ReportContent | undefined;
  if (sameSource && old.delivered && old.terminal && needsLegacyReview(old)) {
    reviewed = await collectReportContent(job);
    if (
      reviewed.status === old.envelope.content.status &&
      reviewed.reason === old.envelope.content.reason
    ) {
      old.maintenanceVersion = REPORT_MAINTENANCE_VERSION;
      await writeReportJson(paths.state, old);
      reviewed = undefined;
    }
  }
  if (sameSource && (old.delivered || old.superseded) && old.terminal && !reviewed) {
    old.maintenanceVersion = REPORT_MAINTENANCE_VERSION;
    removeBody(old);
    await writeReportJson(paths.state, old);
    const receipt = receiptOf(old);
    await writeReportJson(paths.receipt, receipt);
    return { kind: "done", receipt };
  }
  let state: ReportState;
  if (sameSource && !old.delivered && !old.superseded) {
    // Even a metadata-only fallback must replay the exact unacknowledged request.
    state = old;
  } else {
    let content: ReportContent;
    if (reviewed) {
      content = reviewed;
    } else if (old?.superseded) {
      content = await collectReportContent(job);
    } else if (old?.delivered && old.terminal && !needsLegacyReview(old)) {
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
      maintenanceVersion: REPORT_MAINTENANCE_VERSION,
    };
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
      state.wireRevision = ack.acceptedRevision;
      state.superseded = true;
      state.terminal = true;
      state.delivered = false;
      state.nextAttemptAt = 0;
      state.error = "remote_newer_snapshot";
      state.maintenanceVersion = REPORT_MAINTENANCE_VERSION;
      removeBody(state);
    } else {
      state.delivered = true;
      state.attempts = 0;
      delete state.error;
      const reviewPending = needsLegacyReview(state);
      state.nextAttemptAt = reviewPending
        ? Date.now() + 1000
        : state.terminal
          ? 0
          : Date.now() + 300_000;
      if (!reviewPending) {
        state.maintenanceVersion = REPORT_MAINTENANCE_VERSION;
      }
      if (state.terminal) {
        removeBody(state);
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
  const receipt = receiptOf(state);
  await writeReportJson(paths.receipt, receipt);
  return { kind: "done", receipt };
}

/** Metadata-discovered orphan cleanup; no credentials, transcript reads or network. */
export async function executeReportMaintenance(job: ReportMaintenanceJob): Promise<ReportResult> {
  const state = await readSmallJson<ReportState>(job.maintenance.state, 350 * 1024);
  if (
    state?.terminal &&
    state.superseded &&
    state.envelope?.source.accountId === job.maintenance.accountId
  ) {
    removeBody(state);
    state.maintenanceVersion = REPORT_MAINTENANCE_VERSION;
    await writeReportJson(job.maintenance.state, state);
    await writeReportJson(job.maintenance.receipt, receiptOf(state));
  }
  return { kind: "maintenance_done" };
}

if (parentPort && workerData?.kind === "dingtalk-feedback-report") {
  let busy = false;
  parentPort.on("message", (message: { kind: string; job: ReportWorkerJob }) => {
    if (message.kind !== "job" || busy) {
      return;
    }
    busy = true;
    ("maintenance" in message.job
      ? executeReportMaintenance(message.job)
      : executeReportJob(message.job)
    )
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
