import assert from "node:assert/strict";
import test from "node:test";
import { quietNow, initialSettings, validateSettings } from "../assistant-settings.mjs";
import { AssistantStore } from "../assistant-store.mjs";
import { fixture } from "./assistant-fixture.mjs";

test("owner-entered targets are validated before saving and directory validation does not enable listening", async (t) => {
  const f = await fixture(t);
  const c = await f.assistant.show("directory");
  await f.act(c, "search-directory", { kind: "user", query: "B" });
  assert.equal(f.lastCard().name, "search-results");
  assert.equal(f.assistant.store.get("directory")[0].userId, "B");
  const listen = await f.assistant.show("listen-dm");
  await f.act(listen, "save-listen", {
    dm: "users",
    dmIds: "B",
    at: "off",
    atIds: "",
    senderIds: "",
  });
  assert.deepEqual(f.prefs.rules.dm, { mode: "users", ids: ["B"] });
});
test("auto-rule form requires owner callback and invalid option cannot extend authorization", async (t) => {
  const f = await fixture(t),
    c = await f.assistant.show("auto-new");
  await f.auto(c, {
    scope: "dm",
    answer: "收到",
    hours: "9999999",
    cooldown: "30",
    keywords: "",
  });
  assert.equal(f.assistant.store.get("settings").autoRules.length, 0);
  const c2 = await f.assistant.show("auto-new");
  await f.auto(c2, {
    scope: "dm",
    answer: "收到",
    hours: "8",
    cooldown: "30",
    keywords: "",
  });
  assert.equal(f.assistant.store.get("settings").autoRules.length, 1);
});
test("regeneration and owner material only produce a new version awaiting approval", async (t) => {
  const f = await fixture(t),
    d = await f.incoming(f.event()),
    c = await f.assistant.show("regenerate", { id: d.id });
  await f.act(c, "generate", {
    style: "更正式",
    hint: "不要承诺时间",
    material: "只为本条提供的背景",
  });
  assert.equal(f.models.length, 2);
  assert.equal(f.models[1][2], "只为本条提供的背景");
  assert.equal(f.sends.length, 0);
  assert.ok(f.assistant.store.draft(d.id).version > d.version);
  assert.ok(!JSON.stringify(f.assistant.store.draft(d.id)).includes("只为本条提供的背景"));
});
test("pause conversation dismisses pending drafts and prevents further admission until resumed", async (t) => {
  const f = await fixture(t),
    e = f.event({ conversation_id: "chat_pause" }),
    d = await f.incoming(e),
    c = await f.assistant.show("pause", { id: d.id });
  await f.act(c, "pause-conversation", { hours: "8" });
  assert.equal(f.assistant.store.draft(d.id).status, "ignored");
  await f.incoming(f.event({ conversation_id: "chat_pause" }));
  assert.equal(f.models.length, 1);
  const pause = await f.assistant.show("pauses");
  await f.act(pause, "resume", { conversations: ["chat_pause"] });
  await f.incoming(f.event({ conversation_id: "chat_pause" }));
  assert.equal(f.models.length, 2);
});
test("pending drafts and cards recover while interrupted sends become uncertain", async (t) => {
  const f = await fixture(t),
    d = await f.incoming(f.event()),
    card = await f.assistant.show("draft", { id: d.id });
  const second = new AssistantStore(f.config);
  await second.open(f.dir);
  assert.equal(second.draft(d.id).text, d.text);
  assert.equal(second.getCard(card.id).owner, "A");
  second.put({ ...d, status: "sending" });
  second.close();
  const recovered = new AssistantStore(f.config);
  await recovered.open(f.dir);
  assert.equal(recovered.draft(d.id).status, "unknown");
  recovered.close();
});
test("quiet periods handle midnight and scoped settings remain validated", () => {
  const s = initialSettings();
  assert.equal(quietNow(s, Date.parse("2026-09-24T15:00:00Z")), true);
  assert.equal(quietNow(s, Date.parse("2026-09-24T04:00:00Z")), false);
  assert.throws(() =>
    validateSettings({ ...s, notifications: { ...s.notifications, minutes: 0 } }),
  );
});
test("card callback returns promptly while a send is still in progress", async (t) => {
  let release;
  const promise = new Promise((r) => (release = r));
  const f = await fixture(t, { send: () => promise }),
    d = await f.incoming(f.event()),
    c = await f.assistant.show("draft", { id: d.id });
  const idx = c.actions.findIndex((a) => a.op === "send");
  await f.assistant.handle({
    actionId: `dws-assistant:${c.id}:${idx}`,
    userId: "A",
    accountId: "default",
    outTrackId: c.outTrackId,
    values: {},
  });
  assert.equal(f.assistant.store.draft(d.id).status, "sending");
  release();
  await f.assistant.idle();
  assert.equal(f.assistant.store.draft(d.id).status, "sent");
});
