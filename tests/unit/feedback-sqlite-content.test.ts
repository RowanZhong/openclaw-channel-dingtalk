import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectSqliteFeedbackContent,
  type FeedbackRawDeltaReader,
} from "../../src/command/feedback-sqlite-content";
import { reportingFixture } from "./fixtures/feedback-reporting";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup() {
  const f = await reportingFixture();
  dirs.push(f.dir);
  return f;
}
const page = (events: any[], cursor = "end", hasMore = false) => ({
  kind: "page" as const,
  cursor,
  events: events.map((event, seq) => ({ event, seq })),
  serializedBytes: Buffer.byteLength(events.map((e) => JSON.stringify(e)).join("\n")),
  hasMore,
});
describe("optional bounded SQLite SDK adapter", () => {
  it("reads bounded pages and returns only exact verified visible messages", async () => {
    const f = await setup();
    const read = vi
      .fn()
      .mockResolvedValueOnce(page(f.events.slice(0, 2), "p1", true))
      .mockResolvedValueOnce(page(f.events.slice(2)));
    expect(await collectSqliteFeedbackContent(f.job, read)).toMatchObject({
      status: "available",
      answer: "Answer",
    });
    expect(read.mock.calls[0][0]).toMatchObject({
      sessionId:
        f.job.record.transcript!.status === "linked" ? f.job.record.transcript!.sessionId : "",
      maxBytes: 262144,
      maxEvents: 256,
    });
    expect(read.mock.calls[1][0].cursor).toBe("p1");
  });
  it("does not combine rows across a changed generation", async () => {
    const f = await setup();
    const read = vi
      .fn()
      .mockResolvedValueOnce(page(f.events.slice(0, 2), "p1", true))
      .mockResolvedValueOnce({ kind: "reset", cursor: "reset" });
    expect(await collectSqliteFeedbackContent(f.job, read)).toMatchObject({
      status: "pending",
      reason: "transcript_changed",
    });
  });
  it("reports missing scoped storage explicitly", async () => {
    const f = await setup();
    expect(
      await collectSqliteFeedbackContent(f.job, async () => ({ kind: "missing" })),
    ).toMatchObject({ status: "missing" });
  });
  it("rejects oversized single events without escalating to full hydration", async () => {
    const f = await setup();
    const read = vi
      .fn()
      .mockResolvedValue({ ...page([], "same", true), requiredBytes: 2 * 1024 * 1024 });
    expect(await collectSqliteFeedbackContent(f.job, read)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("expands one page only within the per-event and total budget", async () => {
    const f = await setup();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ...page([], "initial", true), requiredBytes: 300000 })
      .mockResolvedValueOnce(page(f.events));
    expect((await collectSqliteFeedbackContent(f.job, read)).status).toBe("available");
    expect(read.mock.calls[1][0].maxBytes).toBe(300000);
  });
  it("caps total transcript bytes across multiple valid pages", async () => {
    const f = await setup();
    f.job.config.maxTranscriptBytes = 262144;
    const read: FeedbackRawDeltaReader = async () => ({
      ...page([], "p1", true),
      serializedBytes: 262144,
    });
    expect(await collectSqliteFeedbackContent(f.job, read)).toMatchObject({ status: "pending" });
  });
  it("rejects mismatched owner and answer without exposing contents", async () => {
    const f = await setup();
    f.events[1].message!.senderId = "someone-else";
    const result = await collectSqliteFeedbackContent(f.job, async () => page(f.events));
    expect(result).toMatchObject({ status: "unverified", reason: "content_verification_failed" });
    expect(result.question).toBeUndefined();
  });
  it("rejects non-progressing cursors instead of looping forever", async () => {
    const f = await setup();
    const read = vi.fn().mockResolvedValue(page([], "p1", true));
    expect(await collectSqliteFeedbackContent(f.job, read)).toMatchObject({
      status: "pending",
      reason: "bounded_reader_unavailable",
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("enforces the final content budget", async () => {
    const f = await setup();
    f.job.config.maxContentBytes = 4;
    expect(await collectSqliteFeedbackContent(f.job, async () => page(f.events))).toMatchObject({
      status: "pending",
      reason: "content_budget",
    });
  });
  it("does not use an unavailable public reader on the legacy SDK", async () => {
    const f = await setup();
    expect(await collectSqliteFeedbackContent(f.job)).toMatchObject({
      status: "pending",
      reason: "bounded_reader_unavailable",
    });
  });
});
