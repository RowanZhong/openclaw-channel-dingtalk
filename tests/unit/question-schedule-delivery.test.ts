import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mocks, setupSchedule, form } from "./fixtures/question-schedule";
import { QuestionScheduleStore } from "../../src/card/question-schedule-store";
import { MESSAGE_CHUNK_LIMIT } from "../../src/shared/message-chunker";

let h: ReturnType<typeof setupSchedule>;
beforeEach(() => { h = setupSchedule(); });
afterEach(() => h.cleanup());
const longAnswer = "START-ANSWER-" + "x".repeat(5000) + "-END-ANSWER";
const personal = { form: { ...form, target: { type: "user", id: "staff_A" } }, respondentNames: { staff_A: "测试成员" } };
const delivery = (id: string, sequence = 1) => h.store.get(id)!.resultDeliveries!.find(x => x.sequence === sequence)!;
const retry = (id: string, sequence = 1) => ({ action: "retry_result", scheduleId: id, sequence });
const acknowledged = (id: string, sequence = 1) => ({ ...retry(id, sequence), acknowledgeUncertainDelivery: true, attemptId: delivery(id, sequence).attempt?.id });
async function partial() {
  const bound = await h.bind(personal);
  const sent = await h.run(bound);
  mocks.send.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: "second chunk failed" });
  await h.submit(sent, "staff_A", { form: { progress: longAnswer } });
  return { bound, sent };
}

describe("durable scheduled result delivery", () => {
  it("reframes retained legacy chunks before retry without replaying the confirmed prefix", async () => {
    const { bound } = await partial();
    const previous = mocks.send.mock.calls[0][2];
    const remaining = "OLD-TAIL-" + "中".repeat(8000) + "-END";
    h.store.update(bound.scheduleId, current => ({ ...current!, resultDeliveries: current!.resultDeliveries!.map(item => ({
      ...item, chunks: [previous, remaining], totalChunks: 2,
    })) }));
    const before = mocks.send.mock.calls.length;
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
    const retried = mocks.send.mock.calls.slice(before).map(call => call[2] as string);
    expect(retried.every(text => Array.from(text).length <= MESSAGE_CHUNK_LIMIT)).toBe(true);
    expect(retried.join("")).toBe(remaining);
    expect(retried).not.toContain(previous);
    expect(delivery(bound.scheduleId)).toMatchObject({ state: "delivered", nextChunk: 1 + retried.length });
  });
  it("persists the whole result and cursor when a later chunk fails", async () => {
    const { bound } = await partial();
    const persisted = new QuestionScheduleStore(h.dir).get(bound.scheduleId)!;
    expect(persisted.resultDeliveries![0]).toMatchObject({ state: "uncertain", nextChunk: 1, totalChunks: 2 });
    expect(persisted.resultDeliveries![0].chunks.join("\n")).toContain("-END-ANSWER");
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(persisted.lastRun).toMatchObject({ state: "completed", deliveryError: true });
  });
  it("resumes from the unacknowledged chunk, clears answer bodies on completion and is idempotent", async () => {
    const { bound } = await partial();
    const second = mocks.send.mock.calls[1][2];
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect(mocks.send.mock.calls[2][2]).toBe(second);
    expect(mocks.send.mock.calls[2][1]).toBe("user:staff_owner");
    expect(delivery(bound.scheduleId)).toMatchObject({ state: "delivered", nextChunk: 2, chunks: [] });
    expect(h.store.get(bound.scheduleId)?.lastRun?.deliveryError).toBe(false);
    expect((await h.chat(retry(bound.scheduleId))).status).toBe("delivered");
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });
  it("requires explicit, current attempt acknowledgement and rejects a stale acknowledgement", async () => {
    const { bound } = await partial();
    const old = acknowledged(bound.scheduleId);
    expect((await h.chat(retry(bound.scheduleId))).status).toBe("failed");
    expect((await h.chat({ ...old, attemptId: "not-current" })).status).toBe("failed");
    mocks.send.mockResolvedValueOnce({ ok: false });
    expect((await h.chat(old)).status).toBe("failed");
    expect(delivery(bound.scheduleId).attempt?.id).not.toBe(old.attemptId);
    expect((await h.chat(old)).status).toBe("failed");
    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
  });
  it("recovers a persisted sending chunk after process restart without automatically resending", async () => {
    const { bound } = await partial();
    h.store.update(bound.scheduleId, current => ({ ...current!, resultDeliveries: current!.resultDeliveries!.map(item => ({ ...item, state: "sending", attempt: { ...item.attempt!, processId: "exited-process" } })) }));
    const listed = await h.chat({ action: "list" });
    expect(listed.schedules[0].resultDeliveries[0]).toMatchObject({ state: "uncertain", sentChunks: 1, totalChunks: 2 });
    expect(JSON.stringify(listed)).not.toContain("START-ANSWER");
    expect((await h.chat(retry(bound.scheduleId))).status).toBe("failed");
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });
  it("rejects concurrent retries even when the second caller acknowledges the live attempt", async () => {
    const { bound } = await partial();
    let release!: (value: unknown) => void;
    mocks.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = h.chat(acknowledged(bound.scheduleId));
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(3));
    expect((await h.chat({ action: "list" })).schedules[0].resultDeliveries[0].state).toBe("sending");
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("failed");
    release({ ok: true });
    expect((await running).status).toBe("delivered");
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });
  it("retains failed results after later runs and receipt pruning, without overwriting current run state", async () => {
    const { bound } = await partial();
    for (let sequence = 2; sequence <= 23; sequence++) {
      const sent = await h.run(bound, sequence);
      await h.submit(sent, "staff_A");
    }
    expect(h.store.get(bound.scheduleId)!.resultDeliveries).toHaveLength(21);
    expect(delivery(bound.scheduleId).state).toBe("uncertain");
    const lastRun = h.store.get(bound.scheduleId)!.lastRun;
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
    expect(h.store.get(bound.scheduleId)!.lastRun).toEqual(lastRun);
    expect(h.store.get(bound.scheduleId)!.resultDeliveries).toHaveLength(20);
  });
  it("keeps the original group destination when retrying after a later round starts", async () => {
    h.context.data.conversationType = "2";
    h.context.data.conversationId = "cid_origin_group";
    const { bound } = await partial();
    expect((await h.run(bound, 2)).status).toBe("pending");
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
    expect(mocks.send.mock.calls[2][1]).toBe("group:cid_origin_group");
    expect(h.store.get(bound.scheduleId)!.lastRun?.state).toBe("pending");
  });
  it("allows retry after disabling future schedules but does not restart the schedule", async () => {
    const { bound } = await partial();
    await h.chat({ action: "disable", scheduleId: bound.scheduleId });
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
    expect(h.store.get(bound.scheduleId)?.enabled).toBe(false);
  });
  it("rejects other owners, accounts, agents, conversations and result-derived contexts", async () => {
    const { bound } = await partial();
    for (const other of [
      { ...h.context, data: { ...h.context.data, senderStaffId: "other" } },
      { ...h.context, accountId: "other" },
      { ...h.context, resolvedRoute: { ...h.context.resolvedRoute, agentId: "other" } },
      { ...h.context, data: { ...h.context.data, conversationId: "other" } },
      { ...h.context, isCollectionResult: true },
    ]) expect((await h.chat(acknowledged(bound.scheduleId), other)).status).toBe("failed");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("rechecks bot and owner authorization before acknowledging or retrying saved answers", async () => {
    const { bound } = await partial();
    const before = delivery(bound.scheduleId);
    h.config.dmPolicy = "pairing";
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("failed");
    expect(delivery(bound.scheduleId)).toEqual(before);
    mocks.pairing.mockReturnValue(["staff_owner"]);
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
  });
  it("checks authorization between chunks and resumes an unsent chunk without uncertainty acknowledgement", async () => {
    const bound = await h.bind(personal);
    const sent = await h.run(bound);
    mocks.send.mockImplementationOnce(async () => { h.config.dmPolicy = "pairing"; return { ok: true }; });
    await h.submit(sent, "staff_A", { form: { progress: longAnswer } });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(delivery(bound.scheduleId)).toMatchObject({ state: "pending", nextChunk: 1 });
    mocks.pairing.mockReturnValue(["staff_owner"]);
    expect((await h.chat(retry(bound.scheduleId))).status).toBe("delivered");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("fails closed before sending if the chunk reservation cannot be saved", async () => {
    const bound = await h.bind(personal);
    const sent = await h.run(bound);
    const original = QuestionScheduleStore.prototype.update;
    const spy = vi.spyOn(QuestionScheduleStore.prototype, "update").mockImplementation(function (id, mutate) {
      return original.call(this, id, current => {
        const updated = mutate(current);
        if (updated.resultDeliveries?.some(x => x.state === "sending")) throw new Error("simulated disk failure");
        return updated;
      });
    });
    await h.submit(sent, "staff_A");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(delivery(bound.scheduleId).state).toBe("pending");
    spy.mockRestore();
    expect((await h.chat(retry(bound.scheduleId))).status).toBe("delivered");
  });
  it("requires acknowledgement if transport succeeds but cursor persistence fails", async () => {
    const bound = await h.bind(personal);
    const sent = await h.run(bound);
    const original = QuestionScheduleStore.prototype.update;
    let fail = true;
    const spy = vi.spyOn(QuestionScheduleStore.prototype, "update").mockImplementation(function (id, mutate) {
      return original.call(this, id, current => {
        const updated = mutate(current);
        if (fail && updated.resultDeliveries?.some(x => x.nextChunk > 0)) { fail = false; throw new Error("cursor write failed"); }
        return updated;
      });
    });
    await h.submit(sent, "staff_A");
    spy.mockRestore();
    expect(delivery(bound.scheduleId)).toMatchObject({ state: "uncertain", nextChunk: 0 });
    expect((await h.chat(retry(bound.scheduleId))).status).toBe("failed");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect((await h.chat(acknowledged(bound.scheduleId))).status).toBe("delivered");
  });
  it("does not manufacture missing legacy results or accept caller-provided content/targets", async () => {
    const bound = await h.bind(personal);
    expect((await h.chat(retry(bound.scheduleId))).status).toBe("failed");
    expect((await h.chat({ ...retry(bound.scheduleId), text: "injected", target: "other" })).status).toBe("failed");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
