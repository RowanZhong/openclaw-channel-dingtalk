import assert from "node:assert/strict";
import test from "node:test";
import { createPolicy } from "../policy.mjs";
import { EVENTS } from "../rules.mjs";
import { controls, until } from "./control-fixtures.mjs";
import { event } from "./fixtures.mjs";
const direct = { ...event, type: EVENTS.direct };
const mention = {
  ...event,
  type: EVENTS.mention,
  event_id: "mention",
  message_id: "group-msg",
  conversation_id: "G1",
};

test("private plus multiple selected-group mentions share one consumer and independent tasks", async (t) => {
  const s = await controls(t);
  await s.listen("dm all");
  await s.listen("at groups G1,G2");
  await s.listen("on");
  assert.equal(s.children.length, 1);
  const child = s.children[0];
  child.ready();
  child.emitMessage({ ...mention, conversation_id: "G3", event_id: "outside" });
  child.emitMessage(direct);
  child.emitMessage(mention);
  await until(() => s.runs.length === 2);
  assert.equal(s.sources.records.size, 2);
  assert.notEqual(s.runs[0].sessionKey, s.runs[1].sessionKey);
  const targets = [...s.sources.records.values()].map((r) => r.reply.conversationId);
  assert.deepEqual(targets, ["conversation-1", "G1"]);
});

test("overlapping sender and mention subscriptions dedupe once before and after admission", async (t) => {
  const s = await controls(t);
  await s.listen("at groups G1");
  await s.listen("sender users open-b");
  await s.listen("on");
  assert.equal(s.children.length, 2);
  s.children[0].emitMessage(mention);
  s.children[1].emitMessage({ ...mention, type: EVENTS.sender, event_id: "sender-copy" });
  s.children[0].ready();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.runs.length, 0, "partial readiness admitted task");
  s.children[1].ready();
  await until(() => s.runs.length === 1);
  s.children[1].emitMessage({ ...mention, type: EVENTS.sender, event_id: "later-copy" });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.runs.length, 1);
});

test("selected private users use private subscription; sender scope includes unmentioned group messages", async (t) => {
  const s = await controls(t);
  await s.listen("dm users U1,U2");
  await s.listen("sender users U1");
  await s.listen("on");
  assert.equal(s.children.length, 2);
  assert.ok(s.children[0].args.includes(EVENTS.privateUser));
  assert.ok(s.children[0].args.includes(EVENTS.sender));
  assert.ok(!s.children[1].args.includes(EVENTS.sender));
  for (const child of s.children) {
    child.ready();
  }
  s.children[0].emitMessage({ ...event, sender_open_dingtalk_id: "other" });
  s.children[0].emitMessage({
    ...event,
    sender_open_dingtalk_id: "U1",
    conversation_id: "group-without-mention",
  });
  await until(() => s.runs.length === 1);
  assert.equal([...s.sources.records.values()][0].reply.conversationId, "group-without-mention");
});

test("off clears pending ingress but retains approval guard and single-flight task across on", async (t) => {
  const waits = [];
  const s = await controls(t, { waitForRun: () => new Promise((resolve) => waits.push(resolve)) });
  await s.listen("dm all");
  await s.listen("on");
  s.children[0].ready();
  s.children[0].emitMessage(direct);
  await until(() => waits.length === 1);
  s.children[0].emitMessage({ ...direct, event_id: "queued", message_id: "queued" });
  await s.listen("off");
  assert.equal(s.service.status().queued, 0);
  assert.equal(s.service.status().active, true);
  const run = s.runs[0];
  assert.ok(
    createPolicy(s.config, s.sources)(
      {
        toolName: "exec",
        params: { command: "dws chat +messages-send --open-dingtalk-id open-b --text hello" },
      },
      { sessionKey: run.sessionKey, agentId: "main" },
    ).requireApproval,
  );
  await s.listen("on");
  s.children[1].ready();
  s.children[0].emitMessage({ ...direct, event_id: "stale", message_id: "stale" });
  s.children[1].emitMessage({ ...direct, event_id: "new", message_id: "new" });
  assert.equal(s.runs.length, 1);
  waits[0]({ status: "ok" });
  await until(() => waits.length === 2);
  assert.equal(s.runs.length, 2);
  assert.match(s.runs[1].message, /"message_id":"new"/);
  waits[1]({ status: "ok" });
});

test("changing selected groups filters queued events without restarting same subscriptions", async (t) => {
  const waits = [];
  const s = await controls(t, { waitForRun: () => new Promise((resolve) => waits.push(resolve)) });
  await s.listen("at groups G1,G2");
  await s.listen("on");
  s.children[0].ready();
  s.children[0].emitMessage(mention);
  await until(() => waits.length === 1);
  s.children[0].emitMessage({
    ...mention,
    event_id: "queued-g2",
    message_id: "m2",
    conversation_id: "G2",
  });
  await s.listen("at groups G1");
  assert.equal(s.children.length, 1);
  assert.equal(s.service.status().queued, 0);
  waits[0]({ status: "ok" });
  await until(() => !s.service.status().active);
  assert.equal(s.runs.length, 1);
});

test("reply changes affect queued tasks but never rewrite admitted prompts", async (t) => {
  const waits = [];
  const s = await controls(t, { waitForRun: () => new Promise((resolve) => waits.push(resolve)) });
  await s.listen("dm all");
  await s.reply("default fixed original");
  await s.listen("on");
  s.children[0].ready();
  s.children[0].emitMessage(direct);
  await until(() => waits.length === 1);
  s.children[0].emitMessage({ ...direct, event_id: "second", message_id: "second" });
  await s.reply("default fixed replacement");
  waits[0]({ status: "ok" });
  await until(() => waits.length === 2);
  assert.match(s.runs[0].extraSystemPrompt, /original/);
  assert.match(s.runs[1].extraSystemPrompt, /replacement/);
  waits[1]({ status: "ok" });
});

test("off reply consumes no model task or source record", async (t) => {
  const s = await controls(t);
  await s.listen("at groups G1");
  await s.reply("group G1 off");
  await s.listen("on");
  s.children[0].ready();
  s.children[0].emitMessage(mention);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.runs.length, 0);
  assert.equal(s.sources.records.size, 0);
});

test("one consumer failure stops entire union instead of running with partial coverage", async (t) => {
  const s = await controls(t);
  await s.listen("at groups G1");
  await s.listen("dm users U1");
  await s.listen("on");
  s.children[0].ready();
  s.children[1].exitCode = 1;
  s.children[1].emit("exit");
  assert.equal(s.service.status().state, "failed");
  assert.equal(s.children[0].signalCode, "SIGTERM");
  s.children[0].emitMessage(mention);
  assert.equal(s.runs.length, 0);
});

test("disabling last active scope requires off first, preserving previous valid settings", async (t) => {
  const s = await controls(t);
  await s.listen("at all");
  await s.listen("on");
  s.children[0].ready();
  assert.match(await s.listen("at off"), /尚未选择/);
  assert.equal(s.service.snapshot().rules.at.mode, "all");
  await s.listen("off");
  await s.listen("at off");
  assert.equal(s.service.snapshot().rules.at.mode, "off");
});
