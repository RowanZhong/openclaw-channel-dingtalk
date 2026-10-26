import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeedbackReportWorkerHost,
  FeedbackWorkerDeferred,
} from "../../src/command/feedback-reporting-worker-host";
import { reportingFixture } from "./fixtures/feedback-reporting";
const hosts: FeedbackReportWorkerHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) await host.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function setup(
  code = `parentPort.on('message',()=>parentPort.postMessage({kind:'done',heap:resourceLimits.maxOldGenerationSizeMb}));`,
  timeoutMs = 1000,
) {
  const f = await reportingFixture();
  dirs.push(f.dir);
  const file = path.join(f.dir, "worker.mjs");
  await writeFile(file, `import {parentPort,resourceLimits} from 'node:worker_threads';${code}`);
  let allowed = true;
  const host = new FeedbackReportWorkerHost({
    url: pathToFileURL(file),
    timeoutMs,
    allowed: () => allowed,
  });
  hosts.push(host);
  return {
    ...f,
    host,
    allow: (v: boolean) => {
      allowed = v;
    },
  };
}
describe("normal worker budget transitions and cancellation", () => {
  it("reuses the worker when budget is unchanged", async () => {
    const f = await setup();
    await f.host.run(f.job);
    await f.host.run(f.job);
    expect(f.host.started).toBe(1);
  });
  it("rebuilds larger-to-smaller budget without failing the job", async () => {
    const f = await setup();
    f.job.config.workerMemoryMb = 256;
    await f.host.run(f.job);
    f.job.config.workerMemoryMb = 64;
    const result: any = await f.host.run(f.job);
    expect(result.heap).toBe(64);
    expect(f.host.started).toBe(2);
  });
  it("rebuilds smaller-to-larger budget instead of retaining a false limit", async () => {
    const f = await setup();
    f.job.config.workerMemoryMb = 64;
    await f.host.run(f.job);
    f.job.config.workerMemoryMb = 256;
    expect(((await f.host.run(f.job)) as any).heap).toBe(256);
    expect(f.host.started).toBe(2);
  });
  it("does not allocate a worker while foreground work disallows it", async () => {
    const f = await setup();
    f.allow(false);
    await expect(f.host.run(f.job)).rejects.toBeInstanceOf(FeedbackWorkerDeferred);
    expect(f.host.started).toBe(0);
  });
  it("rechecks foreground state after awaiting budget termination", async () => {
    const f = await setup();
    f.job.config.workerMemoryMb = 256;
    await f.host.run(f.job);
    const worker = (f.host as any).worker;
    const original = worker.terminate.bind(worker);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(worker, "terminate").mockImplementation(async () => {
      await original();
      await gate;
      return 0;
    });
    f.job.config.workerMemoryMb = 64;
    const next = f.host.run(f.job);
    const expected = expect(next).rejects.toBeInstanceOf(FeedbackWorkerDeferred);
    await sleep(10);
    f.allow(false);
    const stop = f.host.stop();
    release();
    await expected;
    await stop;
    expect(f.host.started).toBe(1);
  });
  it("marks an explicit stop as deferral rather than a task failure", async () => {
    const f = await setup(`parentPort.on('message',()=>{});`);
    const run = f.host.run(f.job);
    const result = expect(run).rejects.toBeInstanceOf(FeedbackWorkerDeferred);
    await sleep(20);
    await f.host.stop();
    await result;
    expect(f.host.resident).toBe(false);
  });
  it("recognizes a stop even if foreground activity has already ended", async () => {
    const f = await setup(`parentPort.on('message',()=>{});`);
    const run = f.host.run(f.job);
    const result = expect(run).rejects.toBeInstanceOf(FeedbackWorkerDeferred);
    await sleep(20);
    f.allow(false);
    const stopped = f.host.stop();
    f.allow(true);
    await stopped;
    await result;
  });
  it("terminates a timed-out worker and allows a later job to start fresh", async () => {
    const f = await setup(`parentPort.on('message',()=>{});`, 30);
    await expect(f.host.run(f.job)).rejects.toThrow("worker_budget");
    expect(f.host.resident).toBe(false);
    expect(f.host.running).toBe(false);
  });
  it("does not mistake an unexpected worker exit for foreground deferral", async () => {
    const f = await setup(`parentPort.on('message',()=>process.exit(0));`);
    await expect(f.host.run(f.job)).rejects.toThrow("worker_stopped");
    expect(f.host.resident).toBe(false);
  });
  it("propagates actual worker failures and releases the isolate", async () => {
    const f = await setup(`parentPort.on('message',()=>{throw new Error('probe-failure');});`);
    await expect(f.host.run(f.job)).rejects.toThrow("probe-failure");
    expect(f.host.resident).toBe(false);
  });
});
