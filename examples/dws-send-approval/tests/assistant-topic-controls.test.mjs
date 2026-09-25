import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";
import { match, none, rule } from "./topic-fixture.mjs";
import { cardFormFields } from "../assistant-card-protocol.mjs";
async function setup(t, extra = {}) {
  return fixture(t, { classify: async (_content, rules) => match(rules[0].id), ...extra });
}
async function wizard(f, values = {}, first) {
  const v = { scope: "all", targetInput: "", name: "导出PDF", description: "询问如何导出PDF", examples: "文档在哪转PDF", exclusions: "故障、代执行", action: "auto", text: "请参考导出PDF操作指引。", hours: "1", cooldown: "30", ...values };
  await f.act(first ?? await f.assistant.show("topic-new"), "topic-next", v);
  assert.equal(f.lastCard().name, "topic-definition");
  await f.act(f.lastCard(), "topic-next", v); assert.equal(f.lastCard().name, "topic-action");
  await f.act(f.lastCard(), "topic-next", v); assert.equal(f.lastCard().name, "topic-trial");
  await f.act(f.lastCard(), "topic-test", { sample: "在哪里下载PDF版本？" });
  assert.equal(f.sends.length, 0);
  await f.act(f.lastCard(), "topic-next"); assert.equal(f.lastCard().name, "topic-limits");
  await f.act(f.lastCard(), "topic-next", v); assert.equal(f.lastCard().name, "topic-review");
  return f.lastCard();
}
test("six-page wizard saves reviewed server state, uses unchanged form protocol and never starts listening", async (t) => {
  const f = await setup(t); f.prefs.enabled = false;
  const card = await wizard(f, { scope: "group", targetInput: "项目群,评审群" });
  assert.equal(f.assistant.store.get("settings").topics.rules.length, 0);
  await f.act(card, "topic-save", { text: "injected", scope: "all", hours: "99999" });
  const s = f.assistant.store.get("settings"); assert.equal(s.topics.enabled, true);
  assert.deepEqual(s.topics.rules[0].targets, ["项目群", "评审群"]);
  assert.equal(s.topics.rules[0].text, "请参考导出PDF操作指引。"); assert.equal(f.prefs.enabled, false);
  for (const c of f.assistant.store.listCards()) {
    assert.ok(c.actions.length <= 6); assert.ok(c.fields.length <= 4);
    assert.doesNotThrow(() => cardFormFields(c.fields)); assert.equal(c.protocol, 2);
  }
});
test("all topic scopes and handling actions are configurable without new template components", async (t) => {
  for (const scope of ["all", "dm", "user", "group"]) for (const action of ["auto", "confirm", "inbox"]) {
    const f = await setup(t), c = await wizard(f, { scope, action, targetInput: "U1,U2" });
    await f.act(c, "topic-save"); const r = f.assistant.store.get("settings").topics.rules[0];
    assert.equal(r.scope, scope); assert.equal(r.action, action);
    assert.equal(r.text, action === "inbox" ? "" : "请参考导出PDF操作指引。");
  }
});
test("automatic authorization cannot skip a successful semantic simulation", async (t) => {
  const f = await setup(t, { classify: async () => none() });
  await f.act(await f.assistant.show("topic-new"), "topic-next");
  await f.act(f.lastCard(), "topic-next", { name: "PDF", description: "使用方法" });
  await f.act(f.lastCard(), "topic-next", { action: "auto", text: "说明" });
  await f.act(f.lastCard(), "topic-next"); assert.equal(f.lastCard().name, "topic-trial");
  await f.act(f.lastCard(), "topic-test", { sample: "无关" });
  await f.act(f.lastCard(), "topic-next"); assert.equal(f.lastCard().name, "topic-trial");
  assert.equal(f.assistant.store.get("settings").topics.rules.length, 0);
});
test("editing an approved definition clears the old trial and requires retesting", async (t) => {
  const f = await setup(t); await wizard(f);
  await f.act(f.lastCard(), "topic-back"); await f.act(f.lastCard(), "topic-back");
  await f.act(f.lastCard(), "topic-back"); assert.equal(f.lastCard().name, "topic-action");
  await f.act(f.lastCard(), "topic-next", { text: "修改后的模板" });
  assert.equal(f.lastCard().args.wizard.testedMatch, undefined);
  await f.act(f.lastCard(), "topic-next"); assert.equal(f.lastCard().name, "topic-trial");
});
test("owner identity, card expiry, stale settings and duplicate submit guard topic authorization", async (t) => {
  const f = await setup(t), c = await wizard(f);
  await f.act(c, "topic-save", {}, { userId: "attacker" }); assert.equal(f.assistant.store.get("settings").topics.rules.length, 0);
  await f.act(c, "topic-save"); await f.act(c, "topic-save"); assert.equal(f.assistant.store.get("settings").topics.rules.length, 1);
  const stale = await wizard(f); const s = f.assistant.store.get("settings"); s.revision++; f.assistant.store.set("settings", s);
  await f.act(stale, "topic-save"); assert.equal(f.assistant.store.get("settings").topics.rules.length, 1);
});
test("saved rule can be viewed, tested without renewing, edited, disabled and deleted", async (t) => {
  const f = await setup(t); await f.act(await wizard(f), "topic-save");
  let r = f.assistant.store.get("settings").topics.rules[0];
  await f.act(await f.assistant.show("topic-manage"), "topic-open", { rules: [r.id] });
  await f.act(f.lastCard(), "topic-test-saved");
  await f.act(f.lastCard(), "topic-test", { sample: "如何转PDF" });
  assert.equal(f.assistant.store.get("settings").topics.rules[0].expires, r.expires);
  assert.equal(f.sends.length, 0);
  await f.act(await f.assistant.show("topic-detail", { id: r.id }), "topic-edit");
  const edit = f.lastCard(); await f.act(await wizard(f, { text: "新说明" }, edit), "topic-save");
  assert.equal(f.assistant.store.get("settings").topics.rules.length, 1);
  assert.equal(f.assistant.store.get("settings").topics.rules[0].text, "新说明");
  await f.act(await f.assistant.show("topic-manage"), "topic-disable", { rules: [r.id] });
  assert.equal(f.assistant.store.get("settings").topics.rules[0].enabled, false);
  await f.act(await f.assistant.show("topic-manage"), "topic-delete", { rules: [r.id] });
  assert.equal(f.assistant.store.get("settings").topics.rules.length, 0);
});
test("topic switch migration is explicit and mode changes retain listener preferences", async (t) => {
  const f = await setup(t); const before = structuredClone(f.prefs);
  await f.act(await f.assistant.show("topic-mode"), "topic-save-mode", { enabled: "on" });
  assert.equal(f.assistant.store.get("settings").topics.enabled, false);
  await f.act(await wizard(f, { action: "confirm" }), "topic-save");
  for (const mode of ["only", "fallback"]) for (const enabled of ["on", "off"]) {
    await f.act(await f.assistant.show("topic-mode"), "topic-save-mode", { mode, enabled });
    const topics = f.assistant.store.get("settings").topics;
    assert.equal(topics.enabled, enabled === "on"); assert.equal(topics.mode, mode);
  }
  assert.deepEqual(f.prefs, before);
});
test("management pagination only acts on displayed rules and all pages fit six buttons", async (t) => {
  const f = await setup(t), s = f.assistant.store.get("settings");
  s.topics.rules = Array.from({ length: 8 }, (_, i) => rule({ id: `r${i}`, name: `主题${i}` })); f.assistant.store.set("settings", s);
  const c = await f.assistant.show("topic-manage", { page: 1 }); assert.equal(c.actions.length, 6);
  await f.act(c, "topic-delete", { rules: ["r0"] }); assert.equal(f.assistant.store.get("settings").topics.rules.length, 8);
  await f.act(await f.assistant.show("topic-manage", { page: 1 }), "topic-delete", { rules: ["r3", "r4"] });
  assert.equal(f.assistant.store.get("settings").topics.rules.length, 6);
});
test("back navigation preserves unfinished input without retaining authorization evidence after edits", async (t) => {
  const f = await setup(t); await wizard(f);
  await f.act(f.lastCard(), "topic-back");
  await f.act(f.lastCard(), "topic-back", { hours: "24", cooldown: "60" });
  assert.equal(f.lastCard().args.wizard.hours, "24");
  await f.act(f.lastCard(), "topic-back", { sample: "另一个未提交的问法" });
  assert.equal(f.lastCard().args.wizard.sample, "另一个未提交的问法");
  await f.act(f.lastCard(), "topic-back", { text: "尚未提交的新模板" });
  assert.equal(f.lastCard().args.wizard.text, "尚未提交的新模板");
  assert.equal(f.lastCard().args.wizard.testedMatch, undefined);
  await f.act(f.lastCard(), "topic-back", { description: "尚未提交的新定义" });
  assert.equal(f.lastCard().args.wizard.description, "尚未提交的新定义");
  assert.equal(f.assistant.store.get("settings").topics.rules.length, 0);
});
