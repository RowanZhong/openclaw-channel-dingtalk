import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";

test("automatic authorization requires all steps and final confirmation ignores forged form values", async (t) => {
  const f = await fixture(t);
  await f.act(await f.assistant.show("auto-new"), "auto-next", {
    scope: "group",
    targetInput: "G1,G2",
  });
  assert.equal(f.lastCard().name, "auto-content");
  await f.act(f.lastCard(), "auto-next", { answer: "已收到", keywords: "通知" });
  assert.equal(f.lastCard().name, "auto-limits");
  await f.act(f.lastCard(), "auto-next", { hours: "1" });
  await f.act(f.lastCard(), "auto-next", { cooldown: "30" });
  assert.equal(f.lastCard().name, "auto-review");
  assert.equal(f.assistant.store.get("settings").autoRules.length, 0);
  const card = f.lastCard();
  assert.match(
    f.cards.findLast((x) => x.data.card_status === "pending").data.description,
    /G1[\s\S]*G2[\s\S]*已收到[\s\S]*1小时/,
  );
  await f.act(card, "save-auto", {
    scope: "all",
    answer: "forged",
    hours: "168",
    targetInput: "OTHER",
  });
  const rules = f.assistant.store.get("settings").autoRules;
  assert.deepEqual(
    rules.map((r) => r.target),
    ["G1", "G2"],
  );
  assert.ok(rules.every((r) => r.text === "已收到" && r.scope === "group"));
});
test("wizard back preserves input, cancel creates no authorization, and target changes are revalidated", async (t) => {
  const f = await fixture(t);
  await f.act(await f.assistant.show("auto-new"), "auto-next", {
    scope: "group",
    targetInput: "G1",
  });
  await f.act(f.lastCard(), "auto-back", { answer: "草稿", keywords: "" });
  assert.equal(f.lastCard().name, "auto-new");
  await f.act(f.lastCard(), "auto-next", { scope: "user", targetInput: "U1" });
  assert.equal(f.lastCard().fields.find((x) => x.name === "answer").defaultValue, "草稿");
  assert.equal(f.lastCard().args.wizard.targets[0].kind, "user");
  await f.act(f.lastCard(), "automation");
  assert.equal(f.assistant.store.get("settings").autoRules.length, 0);
});
test("reminder subpages only save their own fields and reject invalid times atomically", async (t) => {
  const f = await fixture(t);
  const before = f.assistant.store.get("settings");
  await f.act(await f.assistant.show("notice-quiet"), "save-notifications", {
    quietStart: "99:00",
    quietEnd: "08:00",
    timezone: "Asia/Shanghai",
  });
  assert.deepEqual(f.assistant.store.get("settings"), before);
  await f.act(await f.assistant.show("notice-quiet"), "save-notifications", {
    quietStart: "21:00",
    quietEnd: "07:00",
    timezone: "Asia/Shanghai",
    mode: "immediate",
  });
  const next = f.assistant.store.get("settings").notifications;
  assert.equal(next.quietStart, "21:00");
  assert.equal(next.mode, before.notifications.mode);
  assert.equal(f.lastCard().name, "notifications");
});
test("all auto wizard pages have at most two inputs, navigation preserves absolute expiry", async (t) => {
  const f = await fixture(t);
  const first = await f.assistant.show("auto-new");
  await f.act(first, "auto-next", { scope: "dm", targetInput: "" });
  await f.act(f.lastCard(), "auto-next", { answer: "收到", keywords: "" });
  await f.act(f.lastCard(), "auto-next", { hours: "8" });
  await f.act(f.lastCard(), "auto-next", { cooldown: "30" });
  for (const page of ["auto-review", "auto-frequency", "auto-limits", "auto-content", "auto-new"]) {
    const card = f.lastCard();
    assert.equal(card.name, page);
    assert.ok(card.fields.length <= 2);
    assert.equal(card.expires, first.expires);
    if (page !== "auto-new") await f.act(card, "auto-back");
  }
});
test("authorization list pagination binds revocation to visible rules", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++)
    await f.auto(await f.assistant.show("auto-new"), {
      scope: "dm",
      answer: "收到",
      hours: "1",
      cooldown: "30",
    });
  const c = await f.assistant.show("auto-manage");
  assert.equal(c.fields[0].options.length, 5);
  const hidden = f.assistant.store.get("settings").autoRules[5].id;
  await f.act(c, "revoke-auto", { rules: [hidden] });
  assert.equal(f.assistant.store.get("settings").autoRules.length, 6);
});

test("each rendered page uses unique wire names so native form state cannot bleed across pages", async (t) => {
  const f = await fixture(t);
  f.prefs.reply.groups = [{ id: "G", mode: "ai", text: "简洁礼貌" }];
  const first = await f.assistant.show("reply-edit");
  const firstFields = f.cards.findLast((x) => x.data.card_status === "pending").data.form.fields;
  const second = await f.assistant.show("reply-edit", {
    targetKind: "group",
    targets: [{ kind: "group", id: "G", name: "群" }],
  });
  const secondFields = f.cards.findLast((x) => x.data.card_status === "pending").data.form.fields;
  assert.notEqual(firstFields[0].name, secondFields[0].name);
  assert.ok(secondFields.every((x) => x.name.startsWith(second.fieldPrefix)));
  await f.assistant.handle({
    actionId: `dws-assistant:${second.id}:0`,
    userId: "A",
    accountId: "default",
    outTrackId: second.outTrackId,
    values: { [first.fieldPrefix + "mode"]: "off", [first.fieldPrefix + "requirements"]: "forged" },
  });
  await f.assistant.idle();
  assert.equal(f.prefs.reply.groups[0].mode, "ai");
});
