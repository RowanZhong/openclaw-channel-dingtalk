import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { form, mocks, setupSchedule } from "./fixtures/question-schedule";
import { MESSAGE_CHUNK_LIMIT, splitMessageChunks } from "../../src/shared/message-chunker";

let h: ReturnType<typeof setupSchedule>;
beforeEach(() => { h = setupSchedule(); });
afterEach(() => h.cleanup());
const ids = Array.from({ length: 1000 }, (_, i) => `staff_${i}`);
const largeForm = { ...form, target: { type: "group", id: "cid_large", respondentUserIds: ids }, timeoutMinutes: 4320 };

describe("large scheduled collections", () => {
  it("collects 1000 concurrent respondents once with bounded card updates and transport-sized results", async () => {
    const bound = await h.bind({ form: largeForm, respondentNames: {} });
    const sent = await h.run(bound);
    expect(sent.status).toBe("pending");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const payload = mocks.post.mock.calls[0][1];
    expect(payload.openSpaceId).toContain("cid_large");
    expect(JSON.stringify(payload)).not.toContain("staff_999");
    let release!: () => void;
    mocks.update.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const submissions = ids.map(id => h.submit(sent, id, { form: { progress: `ANSWER-${id}-END` } }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await h.submit(sent, "outsider", { form: { progress: "UNAUTHORIZED" } });
    await h.submit(sent, ids[0], { form: { progress: "REPLACED" } });
    release();
    await Promise.all(submissions);
    expect(mocks.update.mock.calls.length).toBeLessThanOrEqual(2);
    expect(mocks.update.mock.calls.at(-1)?.[1]).toMatchObject({ card_status: "submitted", form_btn_text: "已结束" });
    const messages = mocks.send.mock.calls.map(call => call[2] as string);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(Array.from(message).length).toBeLessThanOrEqual(MESSAGE_CHUNK_LIMIT);
      expect(splitMessageChunks(message)).toEqual([message]);
    }
    const text = messages.join("\n");
    for (const id of ids) expect(text.split(`ANSWER-${id.replaceAll("_", "\\_")}-END`)).toHaveLength(2);
    expect(text).not.toContain("UNAUTHORIZED");
    expect(text).not.toContain("REPLACED");
    expect(h.store.get(bound.scheduleId)?.resultDeliveries).toEqual([
      expect.objectContaining({ sequence: 1, state: "delivered", chunks: [], nextChunk: messages.length }),
    ]);
  });

  it.each([1001, 0])("rejects %s respondents before card delivery", async (count) => {
    const result = await h.prepare({ form: { ...largeForm, target: { ...largeForm.target,
      respondentUserIds: Array.from({ length: count }, (_, i) => `staff_${i}`) } }, respondentNames: {} });
    expect(result.status).toBe("failed");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("keeps a 3-day collection open beyond 24 hours and expires exactly once at 4320 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const start = Date.now();
    const bound = await h.bind({ form: largeForm, respondentNames: {} });
    const sent = await h.run(bound);
    expect(Date.parse(sent.deadline)).toBe(start + 4320 * 60_000);
    await h.submit(sent, ids[0]);
    await vi.advanceTimersByTimeAsync(4320 * 60_000 - 1);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await h.manage({ action: "list" })).collections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.store.get(bound.scheduleId)?.lastRun).toMatchObject({ state: "completed", resultStatus: "expired" });
    const text = mocks.send.mock.calls.map(call => call[2]).join("\n");
    expect(text.match(/未回应/g)).toHaveLength(999);
    const count = mocks.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.send).toHaveBeenCalledTimes(count);
  });
});
