/** Developer acceptance probe. Run with an isolated OPENCLAW_STATE_DIR and host SDK. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveFeedbackReporting } from "../src/command/feedback-reporting-config";
import { collectReportContent } from "../src/command/feedback-reporting-content";
import type { ReportJob, ReportResult } from "../src/command/feedback-reporting-protocol";
import {
  completeFeedbackCard,
  registerFeedbackCard,
  applyFeedback,
  readFeedbackRecord,
} from "../src/command/feedback-store";
import { feedbackHttpReceiver } from "../tests/integration/fixtures/feedback-http-receiver";
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    version: { type: "string" },
    worker: { type: "string" },
  },
});
assert(values.root && values.version && values.worker, "Provide --root, --version and --worker");
await mkdir(values.root, { recursive: true });
const directory = await mkdtemp(path.join(path.resolve(values.root), "probe-"));
const receiver = await feedbackHttpReceiver(directory);
const sessionId = "11111111-1111-4111-8111-111111111111";
const target = {
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionId,
  storePath: path.join(directory, "agents/main/sessions/sessions.json"),
  env: { OPENCLAW_STATE_DIR: directory },
};
const scope = { accountId: "default", storePath: path.join(directory, "ratings/sessions.json") };
const config = resolveFeedbackReporting({
  enabled: true,
  endpoint: receiver.endpoint,
  tenantId: "test-org",
  instanceId: "test-instance",
  token: "test-only-token",
  idleMs: 1000,
})!;
const { token, ...publicConfig } = config;
const sdkEntry = "openclaw/plugin-sdk/session-transcript-runtime";
const sdk = await import(sdkEntry);
const answer = "Same fixed answer";
const checks: Record<string, boolean> = {};
async function worker(job: ReportJob) {
  const process = new Worker(path.resolve(values.worker!), {
    workerData: { kind: "dingtalk-feedback-report" },
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  try {
    return await new Promise<ReportResult>((resolve, reject) => {
      process.once("message", resolve);
      process.once("error", reject);
      process.once("exit", (code) => reject(new Error(`worker exited ${code}`)));
      process.postMessage({ kind: "job", job });
    });
  } finally {
    await process.terminate();
  }
}
try {
  await mkdir(path.dirname(target.storePath), { recursive: true });
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
  const append = (eventId: string, role: string, content: unknown) =>
    sdk.appendSessionTranscriptMessageByIdentity({
      ...target,
      eventId,
      message: {
        role,
        content,
        ...(role === "user" ? { senderId: "alice", sourceChannel: "dingtalk" } : {}),
      },
      updateMode: "none",
    });
  await append("q1", "user", "First question");
  await append("a1", "assistant", [
    { type: "thinking", thinking: "Never report this" },
    { type: "text", text: answer },
  ]);
  await append("q2", "user", "Different second question");
  await append("a2", "assistant", answer);
  await registerFeedbackCard(scope, {
    outTrackId: "host-card",
    ownerUserId: "alice",
    conversationId: "synthetic-test-group",
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    sourceMsgId: "platform-question-1",
  });
  await completeFeedbackCard(scope, "host-card", answer, undefined, {
    status: "linked",
    source: "runtime-events",
    sessionId,
    userMessageId: "q1",
    assistantMessageId: "a1",
  });
  await applyFeedback(
    scope,
    {
      outTrackId: "host-card",
      userId: "alice",
      eventId: "like-1",
      eventAt: Date.now(),
      vote: "like",
    },
    Date.now(),
    config,
  );
  const record = await readFeedbackRecord(scope, "host-card");
  assert(record);
  const job: ReportJob = {
    scope,
    record,
    config: publicConfig,
    token: String(token),
    transcriptStorePath: target.storePath,
  };
  const content = await collectReportContent(job);
  assert.equal(content.status, "available");
  assert.equal(content.question, "First question");
  assert.equal(content.answer, answer);
  assert(!JSON.stringify(content).includes("Never report this"));
  checks.sqliteExactPairAndSameTextIsolation = true;
  assert.equal(record.answerHash, createHash("sha256").update(answer).digest("hex"));
  receiver.control.loseAck = true;
  const uncertain = await worker(job);
  assert(uncertain.kind === "done" && !uncertain.receipt.terminal);
  receiver.control.loseAck = false;
  const recovered = await worker(job);
  assert(recovered.kind === "done" && recovered.receipt.terminal);
  assert.deepEqual(receiver.requests[0], receiver.requests[1]);
  checks.sqliteWorkerHttpLostAckRestart = true;
  const withdrawal = await applyFeedback(
    scope,
    {
      outTrackId: "host-card",
      userId: "alice",
      eventId: "withdraw-2",
      eventAt: Date.now(),
      vote: "none",
    },
    Date.now(),
    config,
  );
  assert("record" in withdrawal);
  job.record = withdrawal.record;
  const withdrawn = await worker(job);
  assert(withdrawn.kind === "done" && withdrawn.receipt.terminal);
  const row = receiver.read(receiver.requests[0].recordId)!;
  assert.equal(JSON.parse(row.snapshot).feedback.vote, "none");
  assert.equal(JSON.parse(row.content).question, "First question");
  checks.withdrawalPreservesCommittedBody = true;
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: "22222222-2222-4222-8222-222222222222", updatedAt: Date.now() },
  });
  assert.equal((await collectReportContent(job)).status, "available");
  checks.resetKeepsExactOldSession = true;
  const missingJob = structuredClone(job);
  assert(missingJob.record.transcript?.status === "linked");
  missingJob.record.transcript.sessionId = "33333333-3333-4333-8333-333333333333";
  assert.equal((await collectReportContent(missingJob)).status, "missing");
  checks.missingSession = true;
  const mismatch = structuredClone(job);
  mismatch.record.answerHash = "0".repeat(64);
  assert.equal((await collectReportContent(mismatch)).status, "unverified");
  checks.hashMismatch = true;
  process.stdout.write(
    JSON.stringify(
      {
        version: values.version,
        checks,
        receiverPort: Number(new URL(receiver.endpoint).port),
        pid: process.pid,
        runtime: process.version,
        sdk: "public session-store-runtime + session-transcript-runtime",
        result: "passed",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await receiver.close();
  await rm(directory, { recursive: true, force: true });
}
