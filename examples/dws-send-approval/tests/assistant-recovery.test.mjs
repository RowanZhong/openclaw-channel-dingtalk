import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";
const denied = async () => {
  throw Object.assign(new Error("secret provider response"), {
    code: "LLM_COMPLETION_NOT_AUTHORIZED",
  });
};
const ref = (d) => ({ id: d.id, version: d.version });

test("failed AI draft exposes manual edit but not direct send", async (t) => {
  const f = await fixture(t, { draft: denied });
  const d = await f.incoming(f.event());
  assert.equal(d.status, "draft-error");
  assert.equal(f.sends.length, 0);
  const c = await f.assistant.show("draft", { id: d.id });
  assert.ok(c.actions.some((x) => x.op === "edit"));
  assert.ok(!c.actions.some((x) => x.op === "send"));
  const text = f.assistant.textPreview(d.id);
  assert.match(text, /修改 \/edit/);
  assert.doesNotMatch(text, /发送 \/ok|secret/);
  await assert.rejects(f.assistant.command("ok", ref(d)), /尚不可发送/);
});
test("card can send owner-written text after AI authorization failure", async (t) => {
  const f = await fixture(t, { draft: denied });
  const d = await f.incoming(f.event());
  await f.act(await f.assistant.show("draft", { id: d.id }), "edit");
  const editor = f.lastCard();
  await f.act(editor, "edit-send", { body: "本人填写的回复。" });
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].text, "本人填写的回复。");
  assert.equal(f.sends[0].event.conversation_id, d.event.conversation_id);
  assert.equal(f.assistant.store.draft(d.id).status, "sent");
  assert.equal(f.assistant.store.draft(d.id).error, undefined);
  await f.act(editor, "edit-send", { body: "再次发送" });
  assert.equal(f.sends.length, 1);
});
test("manual short command recovers a failed draft without generating again", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    draft: async () => {
      calls++;
      return denied();
    },
  });
  const d = await f.incoming(f.event());
  await f.assistant.command("edit", ref(d), "收到，谢谢。");
  assert.equal(calls, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.assistant.store.draft(d.id).error, undefined);
});
test("inbox-only messages can be answered manually with no model call", async (t) => {
  const f = await fixture(t);
  f.prefs.reply.default = { mode: "inbox", text: "" };
  const d = await f.incoming(f.event());
  assert.equal(d.status, "inbox");
  await f.assistant.command("edit", ref(d), "手动答复。");
  assert.equal(f.models.length, 0);
  assert.equal(f.sends.length, 1);
});
test("repaired model can regenerate and clear the failure without auto-sending", async (t) => {
  let broken = true;
  const f = await fixture(t, { draft: async () => (broken ? denied() : "恢复后的草稿。") });
  const d = await f.incoming(f.event());
  broken = false;
  await f.act(await f.assistant.show("regenerate", { id: d.id }), "generate", {
    style: "",
    hint: "",
    material: "",
  });
  const latest = f.assistant.store.draft(d.id);
  assert.equal(latest.status, "pending");
  assert.equal(latest.error, undefined);
  assert.equal(latest.text, "恢复后的草稿。");
  assert.equal(f.sends.length, 0);
});
test("manual recovery keeps expiration, revision, paused and platform-block guards", async (t) => {
  for (const mode of ["expired", "revision", "off", "block"]) {
    const f = await fixture(t, { draft: denied }, mode === "block" ? { mode: "block" } : {});
    const d = await f.incoming(f.event());
    if (mode === "expired") f.assistant.store.put({ ...d, expires: Date.now() - 1 });
    if (mode === "revision") f.prefs.revision++;
    if (mode === "off") f.prefs.enabled = false;
    await assert.rejects(f.assistant.command("edit", ref(d), "不得发送"));
    assert.equal(f.sends.length, 0);
  }
});
test("generating, superseded, uncertain and terminal records cannot use manual recovery", async (t) => {
  for (const status of [
    "generating",
    "superseded",
    "unknown",
    "sent",
    "ignored",
    "suppressed",
    "stale",
  ]) {
    const f = await fixture(t, { draft: denied });
    const d = await f.incoming(f.event());
    f.assistant.store.put({ ...d, status });
    await assert.rejects(f.assistant.command("edit", ref(d), "不得重发"));
    assert.equal(f.sends.length, 0);
  }
});
test("manual recovery rejects empty or overlong text without changing the record", async (t) => {
  const f = await fixture(t, { draft: denied });
  const d = await f.incoming(f.event());
  for (const body of ["", "x".repeat(161)])
    await assert.rejects(f.assistant.command("edit", ref(d), body));
  assert.equal(f.assistant.store.draft(d.id).status, "draft-error");
  assert.equal(f.sends.length, 0);
});
test("send-uncertain recovery does not advertise a retry command", async (t) => {
  const f = await fixture(t, {
    draft: denied,
    send: async () => {
      throw Error("network");
    },
  });
  const d = await f.incoming(f.event());
  await f.assistant.command("edit", ref(d), "测试。");
  assert.equal(f.assistant.store.draft(d.id).status, "unknown");
  assert.doesNotMatch(f.assistant.textPreview(d.id), /\/edit|\/ok/);
});
