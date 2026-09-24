import assert from "node:assert/strict";
import test from "node:test";
import { formatStatus, replyStatus } from "../commands.mjs";
import { fixture } from "./assistant-fixture.mjs";

test("every navigation button is dispatched to its declared page", async (t) => {
  const f = await fixture(t),
    d = await f.incoming(f.event());
  const pages = [
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
  ];
  const nav = new Set(pages);
  for (const page of pages) {
    const sample = await f.assistant.show(page, { id: d.id });
    for (const action of sample.actions.filter((a) => nav.has(a.op))) {
      const card = await f.assistant.show(page, { id: d.id });
      await f.act(card, action.op);
      assert.equal(f.lastCard().name, action.op, `${page} -> ${action.op}`);
    }
  }
});
test("all private/group range choices save the intended scope", async (t) => {
  const f = await fixture(t);
  for (const dm of ["off", "all", "users"])
    for (const at of ["off", "all", "groups"]) {
      await f.act(await f.assistant.show("listen-dm"), "save-listen", { dm, dmIds: "U1,U2" });
      await f.act(await f.assistant.show("listen-at"), "save-listen", { at, atIds: "G1\nG2" });
      await f.act(await f.assistant.show("listen-sender"), "save-listen", {
        sender: "users",
        senderIds: "U3",
      });
      assert.equal(f.prefs.rules.dm.mode, dm);
      assert.equal(f.prefs.rules.at.mode, at);
      assert.deepEqual(f.prefs.rules.sender.ids, ["U3"]);
    }
});
test("all reply modes, default reset and individual target reset work", async (t) => {
  const f = await fixture(t);
  for (const mode of ["ai", "fixed", "inbox", "off"]) {
    const c = await f.assistant.show("reply-edit");
    await f.act(c, "save-reply", { mode, requirements: "收到" });
    assert.equal(f.prefs.reply.default.mode, mode);
  }
  await f.act(await f.assistant.show("reply-edit"), "reset-reply");
  assert.equal(f.prefs.reply.default.mode, "ai");
  f.prefs.reply.users = [{ id: "U1", mode: "fixed", text: "收到" }];
  const c = await f.assistant.show("reply-edit", {
    targetKind: "user",
    targets: [{ kind: "user", id: "U1", userId: "U1", name: "甲" }],
  });
  await f.act(c, "reset-reply", { targetInput: "U1" });
  assert.equal(f.prefs.reply.users.length, 0);
});
test("every reminder mode and digest interval survives form submission", async (t) => {
  const f = await fixture(t);
  for (const mode of ["digest", "immediate", "manual"])
    for (const minutes of ["5", "15", "30", "60"]) {
      await f.act(await f.assistant.show("notice-delivery"), "save-notifications", {
        mode,
        minutes,
        priorityUsers: "",
      });
      await f.act(await f.assistant.show("notice-frequency"), "save-notifications", { minutes });
      const n = f.assistant.store.get("settings").notifications;
      assert.equal(n.mode, mode);
      assert.equal(n.minutes, Number(minutes));
    }
});
test("all auto-answer scopes, expiry choices and cooldown choices are accepted and revocable", async (t) => {
  const f = await fixture(t);
  for (const scope of ["dm", "all", "user", "group"])
    for (const hours of ["1", "8", "24", "168"]) {
      const c = await f.assistant.show("auto-new");
      await f.auto(c, {
        scope,
        hours,
        cooldown: "30",
        targetInput: scope === "user" ? "U1" : "G1",
        answer: "收到",
        keywords: "",
      });
      const rules = f.assistant.store.get("settings").autoRules;
      assert.equal(rules.at(-1).scope, scope);
      await f.act(await f.assistant.show("auto-manage"), "revoke-auto", {
        rules: rules.map((x) => x.id),
      });
    }
  for (const cooldown of ["5", "30", "60", "1440"]) {
    await f.auto(await f.assistant.show("auto-new"), {
      scope: "dm",
      hours: "1",
      cooldown,
      answer: "收到",
      keywords: "",
    });
    assert.equal(
      f.assistant.store.get("settings").autoRules.at(-1).cooldownMinutes,
      Number(cooldown),
    );
  }
});
test("all pause durations and regeneration styles accept native choice values", async (t) => {
  const f = await fixture(t);
  for (const hours of ["1", "8", "24", "87600"]) {
    const d = await f.incoming(f.event());
    await f.act(await f.assistant.show("pause", { id: d.id }), "pause-conversation", { hours });
    assert.ok(f.assistant.store.get("settings").pauses[d.event.conversation_id] > Date.now());
  }
  for (const style of ["", "更简短", "更正式"]) {
    const d = await f.incoming(f.event());
    await f.act(await f.assistant.show("regenerate", { id: d.id }), "generate", {
      style,
      hint: "",
      material: "",
    });
    assert.equal(f.assistant.store.draft(d.id).status, "pending");
  }
});
test("open selected, batch ignore and toggle controls mutate only intended state", async (t) => {
  const f = await fixture(t),
    d = await f.incoming(f.event());
  await f.act(await f.assistant.show("inbox"), "open-selected", { selected: [String(d.id)] });
  assert.equal(f.lastCard().name, "draft");
  await f.act(await f.assistant.show("inbox"), "ignore-selected", { selected: [String(d.id)] });
  assert.equal(f.assistant.store.draft(d.id).status, "ignored");
  await f.act(await f.assistant.show(), "toggle");
  assert.equal(f.prefs.enabled, false);
  await f.act(await f.assistant.show(), "toggle");
  assert.equal(f.prefs.enabled, true);
});
test("command status has headings, list items, separate next step and readable rule modes", async (t) => {
  const f = await fixture(t);
  const s = formatStatus({
    preferences: f.prefs,
    state: "ready",
    queued: 0,
    active: false,
    consumers: 1,
  });
  assert.match(s, /### 监听设置\n\n- 状态：已就绪/);
  assert.match(s, /\n- 私聊：全部/);
  assert.match(replyStatus(f.prefs), /### 回复设置[\s\S]*AI 起草/);
});

test("listen results show verified group names with IDs and an explicit fallback", async (t) => {
  const f = await fixture(t);
  f.prefs.rules.at = { mode: "groups", ids: ["G1", "G2"] };
  const s = formatStatus(
    { preferences: f.prefs, state: "off", queued: 0, active: false, consumers: 0 },
    [{ kind: "group", id: "G1", name: "项目协作群" }],
  );
  assert.match(s, /项目协作群 · ID：`G1`/);
  assert.match(s, /暂未获取名称 · ID：`G2`/);
});
