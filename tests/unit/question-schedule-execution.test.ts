import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mocks, setupSchedule, form } from "./fixtures/question-schedule";
import { recoverAskUserQuestionsForAccount } from "../../src/card/ask-user-question";

let h: ReturnType<typeof setupSchedule>;
beforeEach(() => { h = setupSchedule(); });
afterEach(() => h.cleanup());

describe("isolated native cron execution", () => {
  it("creates one targeted card directly without an inbound message or design turn", async () => {
    const bound = await h.bind();
    const sent = await h.run(bound);
    expect(sent.status).toBe("pending");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const body = mocks.post.mock.calls[0][1];
    expect(body.openSpaceId).toBe("dtv1.card//IM_GROUP.cid_team");
    expect(body.cardData.cardParamMap.question_title).toBe("项目进展");
    expect(h.api.runtime.channel.session.resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "default" });
    expect(mocks.inbound).not.toHaveBeenCalled();
  });
  it("rejects wrong task, wrong agent, regular sessions and sender-bearing invocations", async () => {
    const bound = await h.bind();
    for (const context of [
      { sessionKey: "agent:main:main" }, { agentId: "other" },
      { sessionKey: `agent:main:cron:${bound.jobId}:run:any` },
      { requesterSenderId: "staff_owner" }, { sessionKey: "agent:main:cron:another:trigger" },
    ]) expect((await h.run(bound, 1, context)).status).toBe("failed");
    expect((await h.chat({ action: "run", scheduleId: bound.scheduleId, sequence: 1 })).status).toBe("failed");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("does not execute a prepared but unbound template", async () => {
    const prepared = await h.prepare();
    expect((await h.run(prepared)).status).toBe("failed");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("replays a successful occurrence without another card", async () => {
    const bound = await h.bind();
    const first = await h.run(bound);
    expect(await h.run(bound)).toMatchObject({ status: "duplicate", questionId: first.questionId });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("reserves before awaiting the network to prevent concurrent duplicate sends", async () => {
    const bound = await h.bind();
    let release!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = h.run(bound);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect((await h.run(bound)).status).toBe("failed");
    release({ status: 200, data: {} });
    expect((await first).status).toBe("pending");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("skips overlapping occurrences, preserving active answers and advancing cron state", async () => {
    const bound = await h.bind();
    const first = await h.run(bound);
    await h.submit(first, "staff_A");
    expect((await h.run(bound, 2)).status).toBe("skipped");
    expect((await h.run(bound, 2)).status).toBe("duplicate");
    await h.submit(first, "staff_B");
    expect((await h.run(bound, 3)).status).toBe("pending");
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("blocks sequence rewinds and gaps", async () => {
    const bound = await h.bind();
    expect((await h.run(bound, 2)).status).toBe("failed");
    await h.run(bound);
    expect((await h.run(bound, 3)).status).toBe("failed");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("never retries an ambiguous card delivery automatically", async () => {
    const bound = await h.bind();
    mocks.post.mockRejectedValueOnce(new Error("network timed out after write"));
    expect((await h.run(bound)).status).toBe("failed");
    expect((await h.run(bound)).status).toBe("failed");
    expect((await h.run(bound, 2)).status).toBe("failed");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(h.store.get(bound.scheduleId)?.lastRun?.state).toBe("uncertain");
  });
  it("rechecks current owner, group and bot configuration before each run", async () => {
    const bound = await h.bind();
    for (const config of [
      { ...h.config, enabled: false }, { ...h.config, clientId: "another-org-bot" },
      { ...h.config, dmPolicy: "allowlist", allowFrom: ["other"] },
      { ...h.config, groupPolicy: "disabled" },
    ]) expect((await h.run(bound, 1, { runtimeConfig: { channels: { dingtalk: config } } })).status).toBe("failed");
    expect(mocks.post).not.toHaveBeenCalled();
    expect((await h.run(bound)).status).toBe("pending");
  });
  it("lets later occurrences run after a restart terminated the earlier live form", async () => {
    const bound = await h.bind();
    await h.run(bound);
    h.store.update(bound.scheduleId, (current) => ({ ...current!, lastRun: { ...current!.lastRun!, processId: "previous-process" } }));
    expect((await h.chat({ action: "list" })).schedules[0].lastRun.state).toBe("restart_terminated");
    expect((await h.run(bound, 2)).status).toBe("pending");
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });
  it("resumes after channel recovery terminates a card in the same gateway process", async () => {
    const bound = await h.bind();
    await h.run(bound);
    expect(await recoverAskUserQuestionsForAccount({ storePath: h.context.storePath, accountId: "default", config: h.config as any })).toBe(1);
    expect((await h.chat({ action: "list" })).schedules[0].lastRun.state).toBe("restart_terminated");
    expect((await h.run(bound, 2)).status).toBe("pending");
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("honors account-scoped pairing approvals and rejects revoked owners", async () => {
    const bound = await h.bind();
    h.config.dmPolicy = "pairing";
    expect((await h.run(bound)).status).toBe("failed");
    mocks.pairing.mockReturnValue(["staff_owner"]);
    expect((await h.run(bound)).status).toBe("pending");
    expect(mocks.pairing).toHaveBeenLastCalledWith("dingtalk", undefined, "default");
    mocks.pairing.mockReturnValue([]);
    expect((await h.run(bound, 2)).status).toBe("failed");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("does not let pairing approvals bypass an explicit allowlist", async () => {
    const bound = await h.bind();
    h.config.dmPolicy = "allowlist";
    mocks.pairing.mockReturnValue(["staff_owner"]);
    expect((await h.run(bound)).status).toBe("failed");
    expect(mocks.pairing).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("the generated script persists its sequence and propagates errors", async () => {
    const bound = await h.bind();
    const script = new Function("trigger", "catalog", "json", `return (async () => {${bound.cronJob.payload.script}})()`);
    let state: any;
    const invoke = vi.fn((input: any) => h.run(bound, input.sequence));
    const catalog = { search: vi.fn(async () => [invoke]) };
    await script({ state }, catalog, (output: any) => { state = output.state; });
    expect(state.sequence).toBe(1);
    await script({ state }, catalog, (output: any) => { state = output.state; });
    expect(state.sequence).toBe(2);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await h.chat({ action: "disable", scheduleId: bound.scheduleId });
    await expect(script({ state }, catalog, () => { throw new Error("must not commit failed state"); })).rejects.toThrow("disabled");
  });
  it("supports explicit personal targets without changing the result conversation", async () => {
    const bound = await h.bind({ form: { ...form, target: { type: "user", id: "staff_A" } }, respondentNames: { staff_A: "小林" } });
    const sent = await h.run(bound);
    expect(mocks.post.mock.calls[0][1].openSpaceId).toBe("dtv1.card//IM_ROBOT.staff_A");
    await h.submit(sent, "staff_A");
    expect(mocks.send.mock.calls[0][1]).toBe("user:staff_owner");
  });
});
