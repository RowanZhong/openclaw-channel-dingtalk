import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mocks, setupSchedule, form } from "./fixtures/question-schedule";

let h: ReturnType<typeof setupSchedule>;
beforeEach(() => { h = setupSchedule(); });
afterEach(() => h.cleanup());

describe("scheduled form setup and ownership", () => {
  it("prepares a disabled native cron script without sending or persisting credentials", async () => {
    const prepared = await h.prepare();
    expect(prepared.status).toBe("prepared");
    expect(prepared.cronJob).toMatchObject({ enabled: false, sessionTarget: "isolated", payload: { kind: "script", toolsAllow: ["dingtalk_form_schedule"] }, delivery: { mode: "none" } });
    expect(mocks.post).not.toHaveBeenCalled();
    const stored = fs.readFileSync(path.join(h.dir, "dingtalk-state/forms.schedules.json"), "utf8");
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("sessionWebhook");
  });
  it("deduplicates repeated preparation in one inbound request", async () => {
    expect((await h.prepare()).scheduleId).toBe((await h.prepare()).scheduleId);
    expect(h.store.list()).toHaveLength(1);
  });
  it("rejects an unpaired owner during setup instead of creating a doomed cron job", async () => {
    h.config.dmPolicy = "pairing";
    expect(await h.prepare()).toMatchObject({ status: "failed", error: expect.stringContaining("DM policy") });
    expect(h.store.list()).toEqual([]);
    mocks.pairing.mockReturnValue(["staff_owner"]);
    expect((await h.prepare()).status).toBe("prepared");
  });
  it("binds once, blocks reassignment and exposes the job for native cron management", async () => {
    const bound = await h.bind();
    expect((await h.chat({ action: "bind", scheduleId: bound.scheduleId, jobId: randomUUID() })).status).toBe("failed");
    expect((await h.chat({ action: "list" })).schedules).toEqual([expect.objectContaining({ scheduleId: bound.scheduleId, jobId: bound.jobId, templateEnabled: true })]);
    expect((await h.prepare()).status).toBe("bound");
  });
  it("isolates templates by owner, account, agent and origin conversation", async () => {
    const bound = await h.bind();
    for (const other of [
      { ...h.context, data: { ...h.context.data, senderStaffId: "other" } },
      { ...h.context, accountId: "other" },
      { ...h.context, resolvedRoute: { ...h.context.resolvedRoute, agentId: "other" } },
      { ...h.context, data: { ...h.context.data, conversationId: "other" } },
    ]) {
      expect((await h.chat({ action: "list" }, other)).schedules).toEqual([]);
      expect((await h.chat({ action: "disable", scheduleId: bound.scheduleId }, other)).status).toBe("failed");
    }
  });
  it("revokes future execution without deleting an active collection", async () => {
    const bound = await h.bind();
    const sent = await h.run(bound);
    expect((await h.chat({ action: "disable", scheduleId: bound.scheduleId })).status).toBe("disabled");
    expect((await h.run(bound, 2)).status).toBe("failed");
    expect((await h.manage({ action: "list" })).collections[0].questionId).toBe(sent.questionId);
  });
  it.each([0, 4321, 1.5])("rejects timeout %s before any job or card is created", async (timeoutMinutes) => {
    expect((await h.prepare({ form: { ...form, timeoutMinutes } })).status).toBe("failed");
    expect(h.store.list()).toEqual([]);
  });
  it("rejects invalid choices, duplicate keys and unexpected executable parameters", async () => {
    for (const invalid of [
      { ...form, fields: [{ name: "x", label: "x", type: "SELECT" }] },
      { ...form, fields: [...form.fields, ...form.fields] },
      { ...form, command: "run me" },
      { ...form, target: undefined },
    ]) expect((await h.prepare({ form: invalid })).status).toBe("failed");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("validates timezones, future dates and confirmed display-name membership", async () => {
    for (const invalid of [
      { schedule: { kind: "cron", expr: "0 17 * * 1-5", tz: "No/SuchZone" } },
      { schedule: { kind: "at", at: "2000-01-01T00:00:00Z" } },
      { respondentNames: { outsider: "陌生人" } },
    ]) expect((await h.prepare(invalid)).status).toBe("failed");
    expect((await h.prepare({ schedule: { kind: "cron", expr: "0 17 * * 1-5", tz: "Asia/Shanghai" } })).status).toBe("prepared");
  });
  it("does not treat collected answers as schedule-management authorization", async () => {
    h.context.isCollectionResult = true;
    expect((await h.prepare()).status).toBe("failed");
    expect(h.store.list()).toEqual([]);
  });
  it("fails closed if schedule state cannot be read", async () => {
    await h.prepare();
    fs.writeFileSync(path.join(h.dir, "dingtalk-state/forms.schedules.json"), "broken");
    expect((await h.prepare()).status).toBe("failed");
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
