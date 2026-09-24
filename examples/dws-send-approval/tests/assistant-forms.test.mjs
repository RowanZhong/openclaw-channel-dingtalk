import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";
test("all control pages render without dropdown types or empty choice groups", async (t) => {
  const f = await fixture(t);
  const d = await f.incoming(f.event());
  for (const name of [
    "home",
    "listen",
    "listen-dm",
    "listen-at",
    "listen-sender",
    "directory",
    "reply",
    "reply-target",
    "reply-edit",
    "auto-manage",
    "notice-delivery",
    "notice-frequency",
    "notice-quiet",
    "notice-priority",
    "automation",
    "auto-new",
    "notifications",
    "pauses",
    "inbox",
    "history",
    "draft",
    "edit",
    "regenerate",
    "pause",
  ]) {
    const c = await f.assistant.show(name, { id: d.id });
    assert.ok(c.actions.length <= 6);
    for (const field of c.fields) {
      assert.ok(!["SELECT", "MULTI_SELECT"].includes(field.type));
      if (field.options) assert.ok(field.options.length);
    }
  }
});
test("reply targets require review and support applying one rule to several validated users", async (t) => {
  const f = await fixture(t);
  let c = await f.assistant.show("reply-target", { targetKind: "user" });
  await f.act(c, "load-reply", {
    targetInput: "U1\nU2",
    mode: "fixed",
    requirements: "已收到",
  });
  assert.equal(f.prefs.reply.users.length, 0);
  c = f.lastCard();
  assert.equal(c.args.targets.length, 2);
  await f.act(c, "save-reply", { mode: "fixed", requirements: "已收到" });
  assert.deepEqual(
    f.prefs.reply.users.map((x) => x.id),
    ["U1", "U2"],
  );
});
test("invalid target saves nothing, retains text and reports the error on the same page", async (t) => {
  const f = await fixture(t, {
    resolve: async () => {
      throw Error("UserId 无法匹配");
    },
  });
  const c = await f.assistant.show("listen-dm");
  await f.act(c, "save-listen", { dm: "users", dmIds: "BAD", at: "off", senderIds: "" });
  assert.equal(f.prefs.revision, 0);
  assert.equal(f.lastCard().name, "listen-dm");
  assert.equal(f.lastCard().fields.find((x) => x.name === "dmIds").defaultValue, "BAD");
  assert.match(
    f.cards.findLast((x) => x.data.card_status === "pending").data.description,
    /无法匹配/,
  );
});
test("priority contacts are validated and persisted as event IDs", async (t) => {
  const f = await fixture(t);
  const c = await f.assistant.show("notice-priority");
  await f.act(c, "save-notifications", { priorityUsers: "B,C" });
  assert.deepEqual(f.assistant.store.get("settings").notifications.priorityUsers, ["B", "C"]);
});
test("automatic answer targets use exact validation and revoke only selected saved rules", async (t) => {
  const f = await fixture(t);
  let c = await f.assistant.show("auto-new");
  await f.auto(c, {
    scope: "group",
    targetInput: "G1\nG2",
    answer: "收到",
    keywords: "通知",
    hours: "1",
    cooldown: "5",
  });
  const rules = f.assistant.store.get("settings").autoRules;
  assert.equal(rules.length, 2);
  c = await f.assistant.show("auto-manage");
  await f.act(c, "revoke-auto", { rules: [rules[0].id] });
  assert.deepEqual(
    f.assistant.store.get("settings").autoRules.map((x) => x.target),
    ["G2"],
  );
});

test("scope pages stay compact and saving one group preserves the others", async (t) => {
  const f = await fixture(t);
  const summary = await f.assistant.show("listen");
  assert.equal(summary.fields.length, 0);
  const before = structuredClone(f.prefs.rules);
  const dm = await f.assistant.show("listen-dm");
  assert.equal(dm.fields.length, 2);
  await f.act(dm, "save-listen", { dm: "users", dmIds: "U1" });
  assert.deepEqual(f.prefs.rules.at, before.at);
  assert.deepEqual(f.prefs.rules.sender, before.sender);
  assert.equal(f.lastCard().name, "listen");
  await f.act(await f.assistant.show("listen-sender"), "save-listen", {
    sender: "off",
    senderIds: "IGNORED",
  });
  assert.deepEqual(f.prefs.rules.sender, { mode: "off", ids: [] });
});

test("command presentation lookup caches names for cards without changing listening rules", async (t) => {
  const f = await fixture(t, {
    directoryRunner: async () => ({
      result: {
        conversationInfo: { openConversationId: "G1", singleChat: false, title: "项目群" },
      },
    }),
  });
  f.prefs.rules.at = { mode: "groups", ids: ["G1"] };
  const before = structuredClone(f.prefs);
  const directory = await f.assistant.presentationDirectory(["G1"]);
  assert.equal(directory.find((x) => x.id === "G1").name, "项目群");
  assert.deepEqual(f.prefs, before);
  await f.assistant.show("listen");
  assert.match(
    f.cards.findLast((x) => x.data.card_status === "pending").data.description,
    /项目群/,
  );
});
