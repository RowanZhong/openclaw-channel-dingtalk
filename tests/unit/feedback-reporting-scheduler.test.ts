import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reportPaths,
  writeReportJson,
  readSmallJson,
} from "../../src/command/feedback-reporting-io";
import { FeedbackReportingService } from "../../src/command/feedback-reporting-service";
import { feedbackRecordPath } from "../../src/command/feedback-store";
import { reportingFixture } from "./fixtures/feedback-reporting";
const dirs: string[] = [];
const services: FeedbackReportingService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup() {
  const f = await reportingFixture();
  dirs.push(f.dir);
  let now = Date.now();
  const raw = {
    enabled: true,
    endpoint: f.config.endpoint,
    tenantId: f.config.tenantId,
    instanceId: f.config.instanceId,
    token: "test",
    idleMs: 1000,
  };
  const api: any = {
    config: {
      channels: {
        dingtalk: {
          clientId: "test",
          clientSecret: "test",
          feedbackEnabled: true,
          feedbackReporting: raw,
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      channel: {
        session: {
          resolveStorePath: (_s: any, o: any) =>
            o.agentId === "default" ? f.job.scope.storePath : f.job.transcriptStorePath,
        },
      },
    },
  };
  const s: any = new FeedbackReportingService(api, { now: () => now, scanPauseMs: 0 });
  services.push(s);
  s.stopped = false;
  s.schedule = vi.fn();
  const account = s.accounts[0];
  const recordFile = feedbackRecordPath(f.job.scope, "card-1");
  await mkdir(path.dirname(recordFile), { recursive: true });
  await writeFile(recordFile, JSON.stringify(f.job.record));
  return {
    ...f,
    s,
    account,
    recordFile,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("separate bounded ready and retry scheduling", () => {
  it("128 acknowledged pending tasks release every ready slot", async () => {
    const f = await setup();
    const receipt = {
      sourceRevision: 1,
      wireRevision: 1,
      terminal: false,
      nextAttemptAt: f.now() + 300000,
      expiresAt: f.job.record.expiresAt,
      attempts: 0,
      maintenanceVersion: 2,
    };
    f.s.runWorker = vi.fn().mockResolvedValue({ kind: "done", receipt });
    for (let i = 0; i < 128; i++) {
      const id = `old-${i}`;
      await writeFile(
        feedbackRecordPath(f.job.scope, id),
        JSON.stringify({ ...f.job.record, outTrackId: id }),
      );
      f.s.enqueue(f.account, id, 0);
      const [key, p] = [...f.s.queue.entries()][0];
      await f.s.process(key, p);
    }
    expect(f.s.status()).toMatchObject({ queued: 0, waiting: 128 });
    f.s.enqueue(f.account, "new", 0);
    expect([...f.s.queue.values()].map((p: any) => p.cardId)).toEqual(["new"]);
  });
  it("keeps ready capacity at 128 while prioritizing a fresh event over backlog", async () => {
    const f = await setup();
    for (let i = 0; i < 128; i++) f.s.enqueue(f.account, `old-${i}`, 0, false);
    f.s.activeKey = [...f.s.queue.keys()][0];
    const active = f.s.activeKey;
    f.s.enqueue(f.account, "fresh", f.now() + 1000);
    expect(f.s.queue.size).toBe(128);
    expect(f.s.queue.has(active)).toBe(true);
    expect(f.s.retries.size).toBe(1);
    expect([...f.s.queue.values()].some((x: any) => x.cardId === "fresh")).toBe(true);
  });
  it("limits waiting index to 1024 and retains earlier retry deadlines", async () => {
    const f = await setup();
    f.s.needsScan = false;
    for (let i = 0; i < 1024; i++) f.s.enqueue(f.account, `wait-${i}`, f.now() + 100000 + i, false);
    f.s.enqueue(f.account, "earlier", f.now() + 50000, false);
    expect(f.s.retries.size).toBe(1024);
    expect([...f.s.retries.values()].some((p: any) => p.cardId === "earlier")).toBe(true);
    expect([...f.s.retries.values()].some((p: any) => p.cardId === "wait-1023")).toBe(false);
    expect(f.s.needsScan).toBe(true);
  });
  it("never deletes durable source data on index overflow", async () => {
    const f = await setup();
    for (let i = 0; i < 1024; i++) f.s.enqueue(f.account, `wait-${i}`, f.now() + 1000, false);
    f.s.enqueue(f.account, "card-1", f.now() + 5000, false);
    expect(await readSmallJson(f.recordFile)).toMatchObject({ outTrackId: "card-1" });
    expect(f.s.retries.size).toBe(1024);
  });
  it("new ratings wake a waiting record early and increment its generation", async () => {
    const f = await setup();
    f.s.enqueue(f.account, "card-1", f.now() + 300000, false);
    f.s.enqueue(f.account, "card-1", f.now() + 1000);
    expect(f.s.status()).toMatchObject({ queued: 1, waiting: 0 });
    expect([...f.s.queue.values()][0]).toMatchObject({ generation: 1, due: f.now() + 1000 });
  });
  it("known deadlines promote directly without a directory rescan", async () => {
    const f = await setup();
    f.s.scan = vi.fn();
    f.s.enqueue(f.account, "card-1", f.now() + 1000, false);
    f.advance(1001);
    f.s.promoteRetry();
    expect(f.s.status()).toMatchObject({ queued: 1, waiting: 0 });
    expect(f.s.scan).not.toHaveBeenCalled();
  });
  it("account and destination identities remain isolated", async () => {
    const f = await setup();
    f.s.enqueue(f.account, "same", 0);
    f.s.enqueue({ ...f.account, scope: { ...f.account.scope, accountId: "other" } }, "same", 0);
    f.s.enqueue(
      { ...f.account, config: { ...f.account.config, destinationKey: "different" } },
      "same",
      0,
    );
    expect(f.s.queue.size).toBe(3);
  });
  it("a concurrent fresh hint is not delayed by an old result", async () => {
    const f = await setup();
    f.s.enqueue(f.account, "card-1", 0);
    const [key, p] = [...f.s.queue.entries()][0];
    const generation = p.generation;
    f.s.enqueue(f.account, "card-1", f.now() + 1000);
    f.s.defer(key, p, f.now() + 300000, generation);
    expect(f.s.queue.size).toBe(1);
    expect(p.due).toBeLessThanOrEqual(f.now() + 1000);
  });
  it("restart recovery places future receipts in the waiting index", async () => {
    const f = await setup();
    await writeReportJson(reportPaths(f.job.scope, "card-1", f.config.destinationKey).receipt, {
      sourceRevision: 1,
      wireRevision: 1,
      terminal: false,
      nextAttemptAt: f.now() + 300000,
      expiresAt: f.job.record.expiresAt,
      attempts: 0,
      maintenanceVersion: 2,
    });
    await f.s.scan();
    expect(f.s.status()).toMatchObject({ queued: 0, waiting: 1 });
  });
  it("a newer durable source ignores an older receipt retry deadline", async () => {
    const f = await setup();
    await writeReportJson(reportPaths(f.job.scope, "card-1", f.config.destinationKey).receipt, {
      sourceRevision: 0,
      wireRevision: 1,
      terminal: false,
      nextAttemptAt: f.now() + 300000,
      expiresAt: f.job.record.expiresAt,
      attempts: 0,
      maintenanceVersion: 2,
    });
    await f.s.scan();
    expect(f.s.queue.size).toBe(1);
    expect([...f.s.queue.values()][0].due).toBe(f.now());
  });
  it("discovers old terminal maintenance but skips already upgraded terminals", async () => {
    const f = await setup();
    const file = reportPaths(f.job.scope, "card-1", f.config.destinationKey).receipt;
    const receipt = {
      sourceRevision: 1,
      wireRevision: 1,
      terminal: true,
      nextAttemptAt: 0,
      expiresAt: f.job.record.expiresAt,
      attempts: 0,
    };
    await writeReportJson(file, receipt);
    await f.s.scan();
    expect(f.s.queue.size).toBe(1);
    f.s.queue.clear();
    await writeReportJson(file, { ...receipt, maintenanceVersion: 2 });
    await f.s.scan();
    expect(f.s.queue.size).toBe(0);
  });
  it("recovers stale cleanup from a receipt even if source rating is gone", async () => {
    const f = await setup();
    await rm(f.recordFile);
    const paths = reportPaths(f.job.scope, "card-1", f.config.destinationKey);
    await writeReportJson(paths.receipt, {
      sourceRevision: 1,
      wireRevision: 10,
      terminal: true,
      superseded: true,
      nextAttemptAt: 0,
      expiresAt: f.job.record.expiresAt,
      attempts: 0,
    });
    await f.s.scan();
    expect([...f.s.queue.values()][0]).toMatchObject({
      maintenance: { ...paths, accountId: "default" },
    });
  });
  it("selects a fresh rating ahead of 128 already-due old retries", async () => {
    const f = await setup();
    f.s.needsScan = false;
    for (let i = 0; i < 128; i++) f.s.enqueue(f.account, `old-${i}`, 0, false);
    f.s.enqueue(f.account, "fresh-priority", f.now());
    f.s.systemPressure = vi.fn().mockResolvedValue(false);
    f.s.process = vi.fn().mockResolvedValue(undefined);
    await f.s.tick();
    expect(f.s.process.mock.calls[0][1].cardId).toBe("fresh-priority");
  });
});
