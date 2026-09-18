import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mocks, setupSchedule } from "./fixtures/question-schedule";
import { QuestionScheduleStore } from "../../src/card/question-schedule-store";

let h: ReturnType<typeof setupSchedule>;
beforeEach(() => { h = setupSchedule(); });
afterEach(() => h.cleanup());

async function stranded() {
  const bound = await h.bind();
  h.store.update(bound.scheduleId, current => ({ ...current!, lastSequence: 1, lastOutcome: { status: "sending" },
    lastRun: { sequence: 1, state: "sending", processId: "exited-process", startedAt: Date.now() - 120000, deadline: Date.now() - 60000 },
  }));
  return bound;
}
const recovery = (scheduleId: string, sequence = 1) => ({ action: "recover", scheduleId, sequence, acknowledgeUncertainDelivery: true });

describe("scheduled card delivery recovery", () => {
  it("durably exposes old-process sending as uncertain without sending a replacement", async () => {
    const bound = await stranded();
    expect((await h.chat({ action: "list" })).schedules[0].lastRun.state).toBe("uncertain");
    expect(new QuestionScheduleStore(h.dir).get(bound.scheduleId)?.lastOutcome?.status).toBe("uncertain");
    expect((await h.run(bound, 1)).status).toBe("failed");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("recovers without prior listing and consumes the failed cron sequence without resending", async () => {
    const bound = await stranded();
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("recovered");
    expect((await h.run(bound, 1))).toMatchObject({ status: "duplicate", outcome: "abandoned" });
    expect(mocks.post).not.toHaveBeenCalled();
    expect((await h.run(bound, 2)).status).toBe("pending");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("requires explicit acknowledgement and the exact blocked sequence", async () => {
    const bound = await stranded();
    expect((await h.chat({ ...recovery(bound.scheduleId), acknowledgeUncertainDelivery: false })).status).toBe("failed");
    expect((await h.chat(recovery(bound.scheduleId, 2))).status).toBe("failed");
    expect((await h.run(bound, 1)).status).toBe("failed");
  });
  it("is idempotent but rejects stale recovery after a subsequent occurrence starts", async () => {
    const bound = await stranded();
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("recovered");
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("recovered");
    await h.run(bound, 2);
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("failed");
  });
  it("does not enable a disabled template or change its cron binding", async () => {
    const bound = await stranded();
    await h.chat({ action: "disable", scheduleId: bound.scheduleId });
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("recovered");
    expect(h.store.get(bound.scheduleId)).toMatchObject({ enabled: false, jobId: bound.jobId, lastSequence: 1 });
    expect((await h.run(bound, 2)).status).toBe("failed");
  });
  it("rejects recovery by another owner, account, agent or origin conversation", async () => {
    const bound = await stranded();
    for (const other of [
      { ...h.context, data: { ...h.context.data, senderStaffId: "other" } },
      { ...h.context, accountId: "other" },
      { ...h.context, resolvedRoute: { ...h.context.resolvedRoute, agentId: "other" } },
      { ...h.context, data: { ...h.context.data, conversationId: "other" } },
    ]) expect((await h.chat(recovery(bound.scheduleId), other)).status).toBe("failed");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("rechecks owner authorization before accepting recovery", async () => {
    const bound = await stranded();
    h.config.dmPolicy = "pairing";
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("failed");
    mocks.pairing.mockReturnValue(["staff_owner"]);
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("recovered");
  });
  it("cannot take over a sending request still active in this process", async () => {
    const bound = await h.bind();
    let release!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = h.run(bound);
    await new Promise(resolve => setImmediate(resolve));
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("failed");
    release({ status: 200, data: {} });
    expect((await pending).status).toBe("pending");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("recovers a finished ambiguous network request without resending it", async () => {
    const bound = await h.bind();
    mocks.post.mockRejectedValueOnce(new Error("network interrupted"));
    expect((await h.run(bound)).status).toBe("failed");
    expect((await h.chat(recovery(bound.scheduleId))).status).toBe("recovered");
    expect((await h.run(bound)).status).toBe("duplicate");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("does not let collected answers authorize recovery", async () => {
    const bound = await stranded();
    expect((await h.chat(recovery(bound.scheduleId), { ...h.context, isCollectionResult: true })).status).toBe("failed");
  });
});
