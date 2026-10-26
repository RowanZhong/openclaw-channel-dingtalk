import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  readFeedbackDetailContent,
  cancelFeedbackDetailReads,
} from "../../src/command/feedback-detail-reader";
import {
  onFeedbackBackgroundStop,
  beginFeedbackForegroundActivity,
} from "../../src/command/feedback-reporting-events";
import { reportingFixture } from "./fixtures/feedback-reporting";
const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await cancelFeedbackDetailReads();
  for (const end of cleanups.splice(0)) end();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function setup(slow = false) {
  const f = await reportingFixture();
  dirs.push(f.dir);
  if (f.job.record.transcript?.status === "linked")
    f.job.record.transcript.localFile = f.sessionFile;
  const record: any = { ...f.job.record, seen: [], history: [] };
  let workerUrl = pathToFileURL(path.resolve("dist/feedback-detail-worker.js"));
  if (slow) {
    const file = path.join(f.dir, "slow.mjs");
    await writeFile(file, "setInterval(()=>{},1000);");
    workerUrl = pathToFileURL(file);
  }
  const options = { transcriptStorePath: f.job.transcriptStorePath, workerUrl, timeoutMs: 2000 };
  return { ...f, record, options };
}
describe("bounded explicit detail worker", () => {
  it("returns only the verified pair from the real worker", async () => {
    const f = await setup();
    const r = await readFeedbackDetailContent(f.record, undefined, f.options);
    expect(r).toMatchObject({ status: "available", question: "Question", answer: "Answer" });
    expect(JSON.stringify(r)).not.toContain("Never report this");
  });
  it("rejects whole-transcript work beyond the default budget", async () => {
    const f = await setup();
    await writeFile(f.sessionFile, "x".repeat(9 * 1024 * 1024));
    expect(await readFeedbackDetailContent(f.record, undefined, f.options)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
  });
  it("keeps long-line parsing and allocation off the caller and returns only a pending result", async () => {
    const f = await setup();
    await writeFile(
      f.sessionFile,
      [
        f.events[0],
        {
          type: "message",
          id: "unrelated",
          message: { role: "toolResult", content: "x".repeat(1200000) },
        },
        ...f.events.slice(1),
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const r = await readFeedbackDetailContent(f.record, undefined, f.options);
    expect(r).toMatchObject({ status: "pending", reason: "resource_budget" });
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(256);
  });
  it("limits concurrent detail reads to one without an unbounded wait queue", async () => {
    const f = await setup(true);
    const first = readFeedbackDetailContent(f.record, undefined, f.options);
    const cancelled = expect(first).rejects.toThrow("detail_cancelled");
    await sleep(20);
    await expect(readFeedbackDetailContent(f.record, undefined, f.options)).rejects.toThrow(
      "detail_busy",
    );
    await cancelFeedbackDetailReads();
    await cancelled;
  });
  it("cancels via the caller AbortSignal and then accepts a new read", async () => {
    const f = await setup(true);
    const controller = new AbortController();
    const run = readFeedbackDetailContent(f.record, undefined, {
      ...f.options,
      signal: controller.signal,
    });
    const expected = expect(run).rejects.toThrow("detail_cancelled");
    await sleep(20);
    controller.abort();
    await expected;
    const good = await setup();
    expect((await readFeedbackDetailContent(good.record, undefined, good.options)).status).toBe(
      "available",
    );
  });
  it("cancels for new foreground input but not its own foreground span", async () => {
    const f = await setup(true);
    const run = readFeedbackDetailContent(f.record, undefined, f.options);
    const expected = expect(run).rejects.toThrow("detail_cancelled");
    await sleep(20);
    const end = beginFeedbackForegroundActivity();
    end();
    await expected;
  });
  it("waits for background termination before starting the detail read", async () => {
    const f = await setup();
    let released = false;
    const off = onFeedbackBackgroundStop(async () => {
      await sleep(40);
      released = true;
    });
    cleanups.push(off);
    const run = readFeedbackDetailContent(f.record, undefined, f.options);
    await sleep(10);
    expect(released).toBe(false);
    expect((await run).status).toBe("available");
    expect(released).toBe(true);
  });
  it("includes background termination in the total cancellation deadline", async () => {
    const f = await setup();
    const off = onFeedbackBackgroundStop(() => new Promise<void>(() => {}));
    cleanups.push(off);
    await expect(
      readFeedbackDetailContent(f.record, undefined, { ...f.options, timeoutMs: 30 }),
    ).rejects.toThrow("detail_timeout");
  });
  it("terminates a slow detail worker on timeout", async () => {
    const f = await setup(true);
    await expect(
      readFeedbackDetailContent(f.record, undefined, { ...f.options, timeoutMs: 30 }),
    ).rejects.toThrow("detail_timeout");
  });
  it("does not start a read for an already cancelled request", async () => {
    const f = await setup();
    const c = new AbortController();
    c.abort();
    await expect(
      readFeedbackDetailContent(f.record, undefined, { ...f.options, signal: c.signal }),
    ).rejects.toThrow("detail_cancelled");
  });
});
