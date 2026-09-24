import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";

async function setup(t, extra = {}) {
  let now = Date.now();
  const f = await fixture(t, {
    now: () => now,
    notificationTimers: { setTimer: () => 1, clearTimer() {} },
    ...extra,
  });
  const settings = f.assistant.store.get("settings");
  settings.notifications.quietStart = settings.notifications.quietEnd = "00:00";
  f.assistant.store.set("settings", settings);
  return Object.assign(f, {
    async flush(ms = 2000) {
      now += ms;
      await f.assistant.flushNotifications();
      await f.assistant.idle();
    },
  });
}
test("first installation defaults to immediate; one ready draft pushes direct approval buttons", async (t) => {
  const f = await setup(t),
    d = await f.incoming(f.event());
  assert.equal(f.assistant.store.get("settings").notifications.mode, "immediate");
  assert.equal(f.cards.length, 0);
  await f.flush();
  const c = f.lastCard();
  assert.equal(c.name, "draft");
  assert.equal(c.lane, "notification");
  assert.equal(c.refs[0].id, d.id);
  for (const op of ["send", "edit", "ignore"]) assert.ok(c.actions.some((a) => a.op === op));
});
test("multiple ready drafts push a combined review list", async (t) => {
  const f = await setup(t);
  await f.incoming(f.event());
  await f.incoming(f.event());
  await f.flush();
  assert.equal(f.lastCard().name, "inbox");
  assert.equal(f.lastCard().refs.length, 2);
});
test("an approval push does not revoke or repaint a settings form", async (t) => {
  const f = await setup(t),
    c = await f.assistant.show("notice-delivery");
  await f.incoming(f.event());
  await f.flush();
  assert.equal(f.assistant.store.getCard(c.id).invalidated, undefined);
  assert.equal(f.cards.filter((r) => r.outTrackId === c.outTrackId).length, 1);
  await f.act(c, "save-notifications", { mode: "manual" });
  assert.equal(f.assistant.store.get("settings").notifications.mode, "manual");
});
test("a new notification preserves an editing form while stale version checks still prevent its send", async (t) => {
  const f = await setup(t);
  const first = await f.incoming(f.event({ conversation_id: "same" }));
  await f.flush();
  await f.act(f.lastCard(), "edit", { id: first.id });
  const editing = f.lastCard(),
    before = f.cards.filter((r) => r.outTrackId === editing.outTrackId).length;
  await f.incoming(f.event({ conversation_id: "same" }));
  await f.flush(10000);
  assert.equal(f.assistant.store.getCard(editing.id).invalidated, undefined);
  assert.equal(f.cards.filter((r) => r.outTrackId === editing.outTrackId).length, before);
  await f.act(editing, "edit-send", { body: "old input" });
  assert.equal(f.sends.length, 0);
});
test("opening another workspace card does not invalidate a pending notification card", async (t) => {
  const f = await setup(t);
  const old = await f.assistant.show();
  await f.incoming(f.event());
  await f.flush();
  const notice = f.lastCard();
  await f.assistant.show();
  assert.ok(f.assistant.store.getCard(old.id).invalidated);
  assert.equal(f.assistant.store.getCard(notice.id).invalidated, undefined);
  await f.act(notice, "send");
  assert.equal(f.sends.length, 1);
});
test("a successful automatic reply is silent in immediate mode; an uncertain send requests attention", async (t) => {
  for (const fails of [false, true]) {
    const f = await setup(
      t,
      fails
        ? {
            send: async () => {
              throw Error("timeout");
            },
          }
        : {},
    );
    const s = f.assistant.store.get("settings");
    s.autoRules = [
      {
        id: "r1",
        scope: "dm",
        target: "",
        text: "收到",
        keywords: [],
        expires: Date.now() + 86400000,
        cooldownMinutes: 30,
      },
    ];
    f.assistant.store.set("settings", s);
    await f.incoming(f.event());
    await f.flush();
    assert.equal(f.cards.length, fails ? 1 : 0);
    if (fails) assert.match(f.cards[0].data.description, /发送结果待核实/);
  }
});
