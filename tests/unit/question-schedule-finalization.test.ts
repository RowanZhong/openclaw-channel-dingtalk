import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mocks, setupSchedule } from "./fixtures/question-schedule";
import { queueScheduledResult } from "../../src/card/question-schedule-delivery";
import { QuestionScheduleStore } from "../../src/card/question-schedule-store";

let h: ReturnType<typeof setupSchedule>;
beforeEach(() => { h = setupSchedule(); });
afterEach(() => h.cleanup());

function blockCardUpdates() {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  mocks.update.mockImplementationOnce(async () => { entered(); await blocked; });
  return { release, started };
}

describe("scheduled result finalization across overlapping cron occurrences", () => {
  it("retains the last submission while the terminal card update overlaps the next cron", async () => {
    const bound = await h.bind();
    const first = await h.run(bound);
    await h.submit(first, "staff_A", { form: { progress: "FIRST-A" } });
    const card = blockCardUpdates();
    const submission = h.submit(first, "staff_B", { form: { progress: "FIRST-B" } });
    await card.started;
    const second = await h.run(bound, 2);
    expect(second.status).toBe("pending");
    mocks.send.mockResolvedValueOnce({ ok: false });
    card.release();
    await submission;
    const saved = h.store.get(bound.scheduleId)!;
    expect(saved.resultDeliveries?.[0]).toMatchObject({ sequence: 1, questionId: first.questionId, state: "uncertain" });
    expect(saved.resultDeliveries?.[0].chunks.join("\n")).toContain("FIRST-A");
    expect(saved.resultDeliveries?.[0].chunks.join("\n")).toContain("FIRST-B");
    expect(saved.lastRun).toMatchObject({ sequence: 2, state: "pending", questionId: second.questionId });
    expect(saved.resultRuns).toEqual([expect.objectContaining({ sequence: 2, questionId: second.questionId })]);
    const delivery = saved.resultDeliveries![0];
    expect((await h.chat({ action: "retry_result", scheduleId: bound.scheduleId, sequence: 1,
      acknowledgeUncertainDelivery: true, attemptId: delivery.attempt?.id })).status).toBe("delivered");
    expect(h.store.get(bound.scheduleId)?.lastRun).toMatchObject({ sequence: 2, state: "pending" });
  });

  it("retains partial answers when owner cancellation overlaps the next cron", async () => {
    const bound = await h.bind();
    const first = await h.run(bound);
    await h.submit(first, "staff_A", { form: { progress: "PARTIAL-A" } });
    const card = blockCardUpdates();
    const cancellation = h.manage({ action: "cancel", questionId: first.questionId });
    await card.started;
    expect((await h.run(bound, 2)).status).toBe("pending");
    mocks.send.mockResolvedValueOnce({ ok: false });
    card.release();
    expect(await cancellation).toMatchObject({ status: "cancelled", resultDeliveryError: true });
    const saved = h.store.get(bound.scheduleId)!;
    expect(saved.resultDeliveries?.[0].chunks.join("\n")).toContain("PARTIAL-A");
    expect(saved.resultDeliveries?.[0].chunks.join("\n")).toContain("已取消");
    expect(saved.lastRun?.sequence).toBe(2);
  });

  it("binds each retained occurrence to its exact question ID, rejecting forged old callbacks", async () => {
    const bound = await h.bind();
    const sent = await h.run(bound);
    const original = new QuestionScheduleStore(h.dir).get(bound.scheduleId)!;
    expect(original.resultRuns).toEqual([expect.objectContaining({ sequence: 1, questionId: sent.questionId })]);
    const forged: any = { question_id: "another-card", question_title: "forged", status: "submitted", target: { type: "user", id: "staff_A" }, responses: [] };
    expect(() => queueScheduledResult(h.store, bound.scheduleId, 1, forged)).toThrow("recorded scheduled occurrence");
    expect(() => queueScheduledResult(h.store, bound.scheduleId, 9, { ...forged, question_id: sent.questionId })).toThrow("recorded scheduled occurrence");
    expect(h.store.get(bound.scheduleId)).toEqual(original);
  });

  it("keeps separate results when two rounds finish in reverse order", async () => {
    const bound = await h.bind();
    const first = await h.run(bound);
    await h.submit(first, "staff_A", { form: { progress: "ROUND-ONE" } });
    const card = blockCardUpdates();
    const finishing = h.submit(first, "staff_B");
    await card.started;
    const second = await h.run(bound, 2);
    await h.submit(second, "staff_A", { form: { progress: "ROUND-TWO" } });
    await h.submit(second, "staff_B");
    expect(h.store.get(bound.scheduleId)?.resultDeliveries?.map(item => item.sequence)).toEqual([2]);
    card.release();
    await finishing;
    const saved = h.store.get(bound.scheduleId)!;
    expect(saved.resultDeliveries?.map(item => [item.sequence, item.state])).toEqual([[2, "delivered"], [1, "delivered"]]);
    expect(saved.resultRuns).toEqual([]);
    expect(saved.lastRun).toMatchObject({ sequence: 2, state: "completed", deliveryError: false });
    expect(mocks.send.mock.calls.map(call => call[2]).join("\n")).toContain("ROUND-ONE");
    expect(mocks.send.mock.calls.map(call => call[2]).join("\n")).toContain("ROUND-TWO");
  });

  it("does not overwrite a saved receipt with a different question or duplicate callback", async () => {
    const bound = await h.bind();
    const sent = await h.run(bound);
    await h.submit(sent, "staff_A");
    await h.submit(sent, "staff_B");
    const original = h.store.get(bound.scheduleId)!;
    const result: any = { question_id: sent.questionId, question_title: "changed", status: "submitted", responses: [] };
    queueScheduledResult(h.store, bound.scheduleId, 1, result);
    expect(h.store.get(bound.scheduleId)).toEqual(original);
    expect(() => queueScheduledResult(h.store, bound.scheduleId, 1, { ...result, question_id: "forged" })).toThrow("saved occurrence");
  });
});
