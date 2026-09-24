import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sendExact } from "../assistant-dws.mjs";
import { initialSettings } from "../assistant-settings.mjs";
import { AssistantStore } from "../assistant-store.mjs";
import { fixture } from "./assistant-fixture.mjs";

test("text fallback binds version and exposes literal full text without creating cards", async (t) => {
  const f = await fixture(t),
    d = await f.incoming(f.event({ content: "![secret](/private/file)" }));
  const preview = f.assistant.textPreview(d.id);
  assert.ok(preview.includes(`/ok ${d.id}-${d.version}`));
  assert.ok(!preview.includes("![secret]"));
  assert.ok(preview.includes(d.text));
  const c = await f.assistant.show("regenerate", { id: d.id });
  await f.act(c, "generate", { style: "", hint: "", material: "" });
  await assert.rejects(f.assistant.command("ok", { id: d.id, version: d.version }), /草稿已变化/);
  assert.equal(f.sends.length, 0);
  const next = f.assistant.store.draft(d.id);
  await f.assistant.command("ok", { id: d.id, version: next.version });
  assert.equal(f.sends.length, 1);
});
test("model context is bounded to five earlier messages in exactly the same conversation", async (t) => {
  const f = await fixture(t);
  await f.incoming(f.event({ conversation_id: "private-other", content: "不应出现在本会话" }));
  for (let i = 0; i < 8; i++)
    await f.incoming(f.event({ conversation_id: "one", content: `message-${i}` }));
  const data = f.models.at(-1)[0];
  assert.equal(data.context.length, 5);
  assert.equal(data.context[0].message, "message-2");
  assert.ok(!JSON.stringify(data).includes("不应出现在本会话"));
});
test("expired cards and drafts cannot authorize sends", async (t) => {
  const f = await fixture(t),
    d = await f.incoming(f.event()),
    c = await f.assistant.show("draft", { id: d.id });
  f.assistant.store.card({ ...c, expires: Date.now() - 1 });
  await f.act(c, "send");
  assert.equal(f.sends.length, 0);
  const c2 = await f.assistant.show("draft", { id: d.id });
  f.assistant.store.put({ ...d, expires: Date.now() - 1 });
  await f.act(c2, "send");
  assert.equal(f.sends.length, 0);
});
test("global hourly automation budget leaves additional replies for owner confirmation", async (t) => {
  const f = await fixture(t),
    s = initialSettings();
  s.autoRules = [
    {
      id: "r1",
      scope: "dm",
      target: "",
      text: "收到",
      keywords: [],
      expires: Date.now() + 3600000,
      cooldownMinutes: 30,
    },
  ];
  f.assistant.store.set("settings", s);
  f.assistant.store.set("auto-rate", { since: Date.now(), count: 30 });
  const d = await f.incoming(f.event());
  assert.equal(f.sends.length, 0);
  assert.equal(d.status, "pending");
  assert.equal(d.text, "收到");
  assert.equal(f.models.length, 0);
});
test("new message while drafting cannot revive or authorize superseded content", async (t) => {
  const releases = [];
  const f = await fixture(t, { draft: () => new Promise((resolve) => releases.push(resolve)) });
  const first = f.admit(f.event({ conversation_id: "same" }));
  await new Promise(setImmediate);
  const second = f.admit(f.event({ conversation_id: "same" }));
  await new Promise(setImmediate);
  releases[0]("旧草稿");
  await first;
  await new Promise(setImmediate);
  releases[1]("新草稿");
  await second;
  await f.assistant.idle();
  assert.equal(f.assistant.store.list(["pending"]).length, 1);
  assert.equal(f.assistant.store.list(["pending"])[0].text, "新草稿");
  assert.equal(f.sends.length, 0);
});
test("state identity mismatch fails closed without overwriting original account", async (t) => {
  const f = await fixture(t),
    other = new AssistantStore({ ...f.config, ownerUserId: "B" });
  await assert.rejects(other.open(f.dir), /账号不匹配/);
  assert.equal(f.assistant.store.get("identity").owner, "A");
});
test("send result must match the DWS 1.0.58 actual personal-message success contract", async () => {
  for (const result of [
    null,
    {},
    { ok: false },
    { dry_run: true },
    { ok: true, identity: "bot", tool: "send_personal_message" },
  ])
    await assert.rejects(
      sendExact(
        {},
        { event: { conversation_id: "chat1" }, reply: { direct: true }, text: "reply" },
        async () => result,
      ),
    );
});
test("card import source binds all six callbacks to generated variables, includes form and no remote widgets", async () => {
  const outer = JSON.parse(
      await readFile(new URL("../templates/dws-reply-assistant-card.json", import.meta.url)),
    ),
    editor = JSON.parse(outer.editorData);
  const nodes = [];
  const walk = (n) => {
    nodes.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(editor.schema.componentsTree[0]);
  assert.equal(nodes.filter((n) => n.componentName === "Form").length, 1);
  assert.equal(nodes[0].props.enableClickEvent, false);
  assert.equal(editor.useCustomWidgetInfo, false);
  assert.ok(Array.isArray(editor.mockData.cardData.form.fields));
  assert.equal(editor.mockData.cardData.card_status, "pending");
  assert.equal(nodes[0].props.actionType, undefined);
  const buttons = nodes.filter((n) => n.componentName === "SingleButton");
  assert.equal(buttons.length, 6);
  for (const [i, b] of buttons.entries()) {
    assert.equal(b.props.events[0].event.actionId.content, `\${action${i + 1}}`);
    assert.equal(b.props.disabledWhileForward, true);
  }
});

test("slow model does not prevent independent messages from durable admission", async (t) => {
  const releases = [];
  const f = await fixture(t, { draft: () => new Promise((resolve) => releases.push(resolve)) });
  await f.admit(f.event({ conversation_id: "one" }));
  await f.admit(f.event({ conversation_id: "two" }));
  assert.equal(f.assistant.store.list(["generating"]).length, 2);
  assert.equal(releases.length, 1);
  releases[0]("第一条");
  await new Promise(setImmediate);
  releases[1]("第二条");
  await f.assistant.idle();
  assert.equal(f.assistant.store.list(["pending"]).length, 2);
  assert.equal(f.sends.length, 0);
});
test("text-configured targets remain in card choices and navigation ignores unsaved inputs", async (t) => {
  const f = await fixture(t);
  f.prefs.rules.dm = { mode: "users", ids: ["B"] };
  const c = await f.assistant.show("listen-dm");
  assert.equal(c.fields.find((x) => x.name === "dmIds").defaultValue, "open:B");
  await f.act(c, "listen", { dm: "forged-value" });
  assert.equal(f.lastCard().name, "listen");
});
