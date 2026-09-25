import assert from "node:assert/strict";
import test from "node:test";
import { AssistantStore } from "../assistant-store.mjs";
import { topicFixture, rule, match, none, review } from "./topic-fixture.mjs";

test("semantic match sends only the owner's exact stored template and persists the selected rule", async (t) => {
  const f = await topicFixture(t), d = await f.incoming(f.event({ content: "在线文档在哪里下载PDF版本？" }));
  assert.equal(f.sends.length, 1); assert.equal(f.models.length, 0);
  assert.equal(f.sends[0].text, rule().text); assert.equal(d.topic.ruleId, "pdf");
  assert.equal(d.status, "sent"); assert.equal(d.automatic, true);
});
test("topic filtering is opt-in and leaves ordinary AI drafting unchanged when disabled", async (t) => {
  const f = await topicFixture(t, {}, { enabled: false }); await f.incoming(f.event());
  assert.equal(f.classified.length, 0); assert.equal(f.models.length, 1); assert.equal(f.sends.length, 0);
});
test("topic rules never widen source permissions or bypass global pause/off", async (t) => {
  const f = await topicFixture(t); f.prefs.rules.dm = { mode: "users", ids: ["X"] };
  assert.equal(await f.incoming(f.event()), undefined);
  f.prefs.enabled = false; assert.equal(await f.incoming(f.event({ sender_open_dingtalk_id: "X" })), undefined);
  f.prefs.enabled = true; f.prefs.reply.default.mode = "off";
  assert.equal(await f.incoming(f.event({ sender_open_dingtalk_id: "X" })), undefined);
  assert.equal(f.classified.length, 0);
});
test("topic source restrictions run before classification and reject groups under a DM rule", async (t) => {
  const f = await topicFixture(t, {}, { mode: "only", rules: [rule({ scope: "dm" })] });
  const d = await f.incoming(f.event({ type: "user_im_message_receive_at", conversation_id: "G" }));
  assert.equal(d.status, "filtered"); assert.equal(f.classified.length, 0); assert.equal(f.sends.length, 0);
});
test("one classification includes all eligible topics, excluding unrelated senders and groups", async (t) => {
  const f = await topicFixture(t, {}, { rules: [rule(), rule({ id: "other", action: "confirm" }), rule({ id: "private", scope: "user", targets: ["X"] })] });
  await f.incoming(f.event()); assert.equal(f.classified.length, 1);
  assert.deepEqual(f.classified[0][1].map((r) => r.id), ["pdf", "other"]);
});
test("unmatched topics fall through to ordinary AI or disappear from pending according to mode", async (t) => {
  const f = await topicFixture(t, { classify: async () => none() });
  assert.equal((await f.incoming(f.event())).status, "pending"); assert.equal(f.models.length, 1);
  f.setTopics((x) => { x.mode = "only"; });
  const d = await f.incoming(f.event()); assert.equal(d.status, "filtered"); assert.equal(f.models.length, 1);
  assert.equal(f.sends.length, 0);
});
test("uncertain/partial/excluded results never trigger a broad legacy auto rule in either mode", async (t) => {
  for (const mode of ["only", "fallback"]) for (const reason of ["ambiguous", "partial", "excluded", "conflict"]) {
    const f = await topicFixture(t, { classify: async () => review(reason) }, { mode });
    const s = f.assistant.store.get("settings"); s.autoRules = [{ id: "legacy", scope: "all", target: "", keywords: [], text: "自动旧回复", expires: Date.now()+3600000, cooldownMinutes: 30 }];
    f.assistant.store.set("settings", s);
    const d = await f.incoming(f.event()); assert.equal(d.status, "topic-review"); assert.equal(f.sends.length, 0); assert.equal(f.models.length, 0);
  }
});
test("conflicting semantic and keyword templates require review", async (t) => {
  const f = await topicFixture(t), s = f.assistant.store.get("settings");
  s.autoRules = [{ id: "legacy", scope: "all", keywords: [], text: "另一个答案", expires: Date.now()+3600000, cooldownMinutes: 30 }]; f.assistant.store.set("settings", s);
  assert.equal((await f.incoming(f.event())).status, "topic-review"); assert.equal(f.sends.length, 0);
});
test("legacy automatic rules remain available for an explicit nonmatch in fallback mode", async (t) => {
  const f = await topicFixture(t, { classify: async () => none() }), s = f.assistant.store.get("settings");
  s.autoRules = [{ id: "legacy", scope: "all", keywords: [], text: "收到", expires: Date.now()+3600000, cooldownMinutes: 30 }]; f.assistant.store.set("settings", s);
  assert.equal((await f.incoming(f.event())).status, "sent"); assert.equal(f.sends[0].text, "收到");
});
test("confirmation, inbox and expired semantic authorization never auto-send", async (t) => {
  for (const [r, status] of [[rule({ action: "confirm" }), "pending"], [rule({ action: "inbox" }), "inbox"], [rule({ expires: 1 }), "pending"]]) {
    const f = await topicFixture(t, {}, { rules: [r] }); assert.equal((await f.incoming(f.event())).status, status);
    assert.equal(f.sends.length, 0); assert.equal(f.models.length, 0);
  }
});
test("existing inbox-only reply preference overrides semantic auto authorization", async (t) => {
  const f = await topicFixture(t); f.prefs.reply.default.mode = "inbox";
  assert.equal((await f.incoming(f.event())).status, "inbox"); assert.equal(f.sends.length, 0);
});
test("semantic sends share global hourly quota and rule/conversation cooldown", async (t) => {
  const f = await topicFixture(t), e = f.event({ conversation_id: "same" }); await f.incoming(e);
  assert.equal((await f.incoming(f.event({ conversation_id: "same" }))).status, "suppressed");
  f.assistant.store.set("auto-rate", { since: Date.now(), count: 30 });
  assert.equal((await f.incoming(f.event())).status, "pending"); assert.equal(f.sends.length, 1);
});
test("multiple matching IDs, unknown IDs, partial coverage and injected template fields are rejected", async (t) => {
  for (const result of [match("unknown"), { ...match(), ruleIds: ["pdf", "another"] }, { ...match(), coversWholeMessage: false }, { ...match(), text: "model supplied payload" }]) {
    const f = await topicFixture(t, { classify: async () => result }, { rules: [rule(), rule({ id: "another" })] });
    assert.equal((await f.incoming(f.event())).status, "topic-review"); assert.equal(f.sends.length, 0);
  }
});
test("classification failures stay editable even in topics-only mode", async (t) => {
  const f = await topicFixture(t, { classify: async () => { throw new Error("secret backend detail"); } }, { mode: "only" });
  const d = await f.incoming(f.event()); assert.equal(d.status, "topic-review"); assert.ok(!d.error.includes("secret"));
  const card = await f.assistant.show("edit", { id: d.id }); await f.act(card, "edit-send", { body: "我核对后答复。" });
  assert.equal(f.sends[0].text, "我核对后答复。");
});
test("disabling the last rule in topics-only mode cannot silently discard all incoming work", async (t) => {
  const f = await topicFixture(t, {}, { mode: "only", rules: [rule({ enabled: false })] });
  assert.equal((await f.incoming(f.event())).status, "topic-review"); assert.equal(f.classified.length, 0);
});
test("classification admission returns without waiting and changes during the model call cannot authorize a send", async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  const f = await topicFixture(t, { classify: () => gate }); const e = f.event();
  await f.admit(e); assert.equal(f.assistant.store.list()[0].status, "classifying");
  f.setTopics((x) => { x.enabled = false; }); release(match()); await f.assistant.idle();
  assert.equal(f.assistant.store.list()[0].status, "topic-review"); assert.equal(f.sends.length, 0);
});
test("new messages supersede old in-flight classification and duplicates never classify twice", async (t) => {
  let release, count = 0; const gate = new Promise((r) => { release = r; });
  const f = await topicFixture(t, { classify: async () => { count++; if (count === 1) return gate; return match(); } });
  const e1 = f.event({ conversation_id: "same" }); await f.admit(e1);
  await new Promise((r) => setImmediate(r));
  const e2 = f.event({ conversation_id: "same" }); await f.admit(e2); await f.admit(e2);
  release(match()); await f.assistant.idle(); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].event.message_id, e2.message_id);
  assert.equal(count, 2);
});
test("restarting interrupted classification produces a manual record and never retries automatic delivery", async (t) => {
  const f = await topicFixture(t, { classify: async () => review() }), d = await f.incoming(f.event());
  f.assistant.store.put({ ...d, status: "classifying" });
  const restored = new AssistantStore(f.config); await restored.open(f.dir);
  assert.equal(restored.draft(d.id).status, "topic-review"); restored.close(); assert.equal(f.sends.length, 0);
});
test("topic revision invalidates older approval versions; owner regeneration recovers without auto-send", async (t) => {
  const f = await topicFixture(t, {}, { rules: [rule({ action: "confirm" })] }), d = await f.incoming(f.event());
  f.setTopics((x) => { x.rules[0].text = "新的模板"; });
  await f.act(await f.assistant.show("draft", { id: d.id }), "send"); assert.equal(f.sends.length, 0);
  await f.act(await f.assistant.show("regenerate", { id: d.id }), "generate");
  assert.equal(f.models.length, 1); assert.equal(f.sends.length, 0);
  await f.act(await f.assistant.show("draft", { id: d.id }), "send"); assert.equal(f.sends.length, 1);
});
