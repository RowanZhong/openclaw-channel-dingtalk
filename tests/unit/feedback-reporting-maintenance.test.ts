import { rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { collectLegacyTranscript } from "../../src/command/feedback-reporting-content";
import {
  readSmallJson,
  reportPaths,
  writeReportJson,
} from "../../src/command/feedback-reporting-io";
import {
  createReportEnvelope,
  REPORT_MAINTENANCE_VERSION,
  type ReportState,
} from "../../src/command/feedback-reporting-protocol";
import {
  executeReportJob,
  executeReportMaintenance,
} from "../../src/command/feedback-reporting-worker";
import { reportingFixture } from "./fixtures/feedback-reporting";
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup(mode: "normal" | "stale" | "invalid" = "normal") {
  const bodies: any[] = [];
  let response = mode;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw);
      bodies.push(b);
      res.end(
        response === "invalid"
          ? "{}"
          : JSON.stringify({
              schemaVersion: 1,
              recordId: b.recordId,
              acceptedRevision: response === "stale" ? 10 : b.revision,
              status: response === "stale" ? "stale" : "applied",
            }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const f = await reportingFixture(`http://127.0.0.1:${(server.address() as any).port}/report`);
  dirs.push(f.dir);
  if (f.job.record.transcript?.status === "linked")
    f.job.record.transcript.localFile = f.sessionFile;
  const paths = reportPaths(f.job.scope, "card-1", f.config.destinationKey);
  const legacy = async (
    delivered = true,
    content: any = { mode: "preserve", status: "unverified", reason: "invalid_transcript" },
  ) => {
    const state: ReportState = {
      sourceRevision: 1,
      wireRevision: 1,
      terminal: true,
      delivered,
      nextAttemptAt: 0,
      expiresAt: f.job.record.expiresAt,
      attempts: 0,
      destinationKey: f.config.destinationKey,
      envelope: createReportEnvelope(f.job, 1, content),
    };
    await writeReportJson(paths.state, state);
    return state;
  };
  return {
    ...f,
    paths,
    bodies,
    legacy,
    setResponse: (s: typeof mode) => {
      response = s;
    },
  };
}
describe("bounded legacy repair and stale cleanup", () => {
  it("classifies a valid oversized line as pending rather than corruption", async () => {
    const f = await setup();
    await writeFile(
      f.sessionFile,
      [
        f.events[0],
        {
          type: "message",
          id: "tool",
          message: { role: "toolResult", content: "x".repeat(1200000) },
        },
        ...f.events.slice(1),
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    expect(await collectLegacyTranscript(f.job, f.sessionFile)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
  });
  it("keeps real malformed JSON as unverified", async () => {
    const f = await setup();
    await writeFile(f.sessionFile, JSON.stringify(f.events[0]) + "\nnot-json\n");
    expect(await collectLegacyTranscript(f.job, f.sessionFile)).toMatchObject({
      status: "unverified",
      reason: "invalid_transcript",
    });
  });
  it("repairs an acknowledged old false terminal with a higher wire version", async () => {
    const f = await setup();
    await f.legacy();
    const result = await executeReportJob(f.job);
    expect(result).toMatchObject({
      kind: "done",
      receipt: { terminal: true, maintenanceVersion: 2, wireRevision: 2 },
    });
    expect(f.bodies[0].content).toMatchObject({
      mode: "replace",
      status: "available",
      answer: "Answer",
    });
  });
  it("keeps oversized repaired content pending and eligible for later collection", async () => {
    const f = await setup();
    await f.legacy();
    await writeFile(f.sessionFile, "x".repeat(1200000));
    await executeReportJob(f.job);
    expect(f.bodies[0].content).toMatchObject({ status: "pending", reason: "resource_budget" });
    expect(await readSmallJson(f.paths.receipt)).toMatchObject({
      terminal: false,
      maintenanceVersion: 2,
    });
  });
  it("marks an unchanged truly malformed terminal reviewed without re-upload", async () => {
    const f = await setup();
    await f.legacy();
    await writeFile(f.sessionFile, "bad-json\n");
    await executeReportJob(f.job);
    await executeReportJob(f.job);
    expect(f.bodies).toHaveLength(0);
    expect(await readSmallJson(f.paths.receipt)).toMatchObject({
      terminal: true,
      maintenanceVersion: REPORT_MAINTENANCE_VERSION,
    });
  });
  it("replays an unacknowledged old request exactly even under metadata-only fallback", async () => {
    const f = await setup();
    const original = await f.legacy(false, {
      mode: "replace",
      status: "unverified",
      reason: "invalid_transcript",
    });
    f.job.metadataOnly = true;
    expect(await executeReportJob(f.job)).toMatchObject({
      kind: "done",
      receipt: { terminal: false },
    });
    expect(f.bodies[0]).toEqual(original.envelope);
    f.job.metadataOnly = false;
    await executeReportJob(f.job);
    expect(f.bodies[1].revision).toBe(2);
    expect(f.bodies[1].content.status).toBe("available");
  });
  it("does not correct an old request when the reply is stale", async () => {
    const f = await setup("stale");
    await f.legacy(false, { mode: "replace", status: "unverified", reason: "invalid_transcript" });
    await executeReportJob(f.job);
    await executeReportJob(f.job);
    expect(f.bodies).toHaveLength(1);
    expect(await readSmallJson(f.paths.receipt)).toMatchObject({
      terminal: true,
      superseded: true,
      wireRevision: 10,
      maintenanceVersion: 2,
    });
  });
  it("retries an invalid acknowledgement before doing legacy correction", async () => {
    const f = await setup("invalid");
    const old = await f.legacy(false, {
      mode: "replace",
      status: "unverified",
      reason: "invalid_transcript",
    });
    await executeReportJob(f.job);
    f.setResponse("normal");
    await executeReportJob(f.job);
    expect(f.bodies[0]).toEqual(old.envelope);
    expect(f.bodies[1]).toEqual(old.envelope);
    await executeReportJob(f.job);
    expect(f.bodies[2].revision).toBe(2);
  });
  it("scrubs a new stale snapshot and re-reads on the next real rating", async () => {
    const f = await setup("stale");
    await executeReportJob(f.job);
    let state: any = await readSmallJson(f.paths.state);
    expect(state).toMatchObject({ superseded: true, delivered: false });
    expect(state.envelope.content.question).toBeUndefined();
    expect(state.envelope.content.answer).toBeUndefined();
    await rm(f.sessionFile);
    f.job.record.reporting!.revision++;
    f.job.record.vote = "none";
    f.setResponse("normal");
    await executeReportJob(f.job);
    expect(f.bodies[1]).toMatchObject({
      revision: 11,
      feedback: { vote: "none" },
      content: { mode: "replace", status: "missing" },
    });
  });
  it("cleans an old stale outbox even without its source record or transcript", async () => {
    const f = await setup();
    const old = await f.legacy(false, {
      mode: "replace",
      status: "available",
      question: "Question",
      answer: "Answer",
    });
    Object.assign(old, { superseded: true, wireRevision: 10 });
    await writeReportJson(f.paths.state, old);
    await rm(f.sessionFile);
    const result = await executeReportMaintenance({
      maintenance: { ...f.paths, accountId: "default" },
      config: { workerMemoryMb: 64 },
    });
    expect(result.kind).toBe("maintenance_done");
    const state: any = await readSmallJson(f.paths.state);
    expect(state.envelope.content.answer).toBeUndefined();
    expect(state.delivered).toBe(false);
    expect(f.bodies).toHaveLength(0);
  });
  it("does not scrub another account or mutate an uncertain in-flight request", async () => {
    const f = await setup();
    const old = await f.legacy(false, {
      mode: "replace",
      status: "available",
      question: "Question",
      answer: "Answer",
    });
    await executeReportMaintenance({
      maintenance: { ...f.paths, accountId: "default" },
      config: { workerMemoryMb: 64 },
    });
    expect(await readSmallJson(f.paths.state)).toEqual(old);
    old.superseded = true;
    await writeReportJson(f.paths.state, old);
    await executeReportMaintenance({
      maintenance: { ...f.paths, accountId: "different" },
      config: { workerMemoryMb: 64 },
    });
    expect((await readSmallJson<any>(f.paths.state))!.envelope.content.answer).toBe("Answer");
  });
});
