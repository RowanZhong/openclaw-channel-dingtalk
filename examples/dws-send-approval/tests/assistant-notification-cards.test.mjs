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

test("later immediate notifications exclude drafts already delivered in an earlier card", async (t) => {
  const f = await setup(t),
    first = await f.incoming(f.event());
  await f.flush();
  const second = await f.incoming(f.event()),
    third = await f.incoming(f.event());
  await f.flush(10000);
  const card = f.lastCard();
  assert.equal(card.name, "inbox");
  assert.deepEqual(
    card.refs.map((r) => r.id),
    [third.id, second.id],
  );
  assert.ok(!card.refs.some((r) => r.id === first.id));
});
test("notification pagination retains its original subset and covers later pages", async (t) => {
  const f = await setup(t);
  const old = await f.incoming(f.event());
  await f.flush();
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(await f.incoming(f.event()));
  await f.flush(10000);
  const list = f.lastCard();
  await f.act(list, "inbox", { page: 1 });
  assert.deepEqual(f.lastCard().args.notificationIds, list.args.notificationIds);
  assert.equal(f.lastCard().refs.length, 2);
  assert.ok(!f.lastCard().refs.some((r) => r.id === old.id));
  const next = await f.incoming(f.event());
  await f.flush(10000);
  assert.equal(f.lastCard().name, "draft");
  assert.equal(f.lastCard().refs[0].id, next.id);
});
test("opening one draft from a batch does not forget other previously notified drafts", async (t) => {
  const f = await setup(t),
    one = await f.incoming(f.event());
  await f.incoming(f.event());
  await f.flush();
  await f.act(f.lastCard(), "open-selected", { selected: [String(one.id)] });
  const next = await f.incoming(f.event());
  await f.flush(10000);
  assert.equal(f.lastCard().refs.length, 1);
  assert.equal(f.lastCard().refs[0].id, next.id);
});
test("restart reuses durable notification coverage while the existing card remains valid", async (t) => {
  const f = await setup(t);
  await f.incoming(f.event());
  await f.flush();
  const count = f.cards.length;
  await f.assistant.stop();
  await f.assistant.start({ stateDir: f.dir });
  await f.flush();
  assert.equal(f.cards.length, count);
});
test("failed card delivery does not consume notification coverage or suppress retry", async (t) => {
  let attempts = 0;
  const f = await setup(t, {
    transport: {
      sendCard: async () => {
        if (++attempts === 1) throw Error("temporary");
      },
      updateCard: async () => {},
    },
  });
  const d = await f.incoming(f.event());
  await f.flush();
  assert.equal(f.assistant.store.get("notificationCoverage"), undefined);
  await f.flush(30000);
  assert.equal(attempts, 2);
  assert.equal(f.assistant.store.get("notificationCoverage")[d.id].version, d.version);
});
test("regenerating from the original notification updates that card without a second push", async (t) => {
  let fail = false;
  const f = await setup(t, {
    draft: async () => {
      if (fail) throw Object.assign(Error("denied"), { code: "LLM_COMPLETION_NOT_AUTHORIZED" });
      return "收到。";
    },
  });
  await f.incoming(f.event());
  await f.flush();
  const track = f.lastCard().outTrackId;
  fail = true;
  await f.act(f.lastCard(), "regenerate");
  await f.act(f.lastCard(), "generate", { style: "", hint: "", material: "" });
  await f.flush(10000);
  assert.equal(new Set(f.cards.map((c) => c.outTrackId)).size, 1);
  assert.equal(f.lastCard().outTrackId, track);
  assert.equal(f.assistant.store.draft(1).status, "draft-error");
});
test("an expired approval card may be renewed after restart", async (t) => {
  const f = await setup(t);
  await f.incoming(f.event());
  await f.flush();
  const c = f.lastCard();
  f.assistant.store.card({ ...c, expires: Date.now() - 1 });
  await f.assistant.stop();
  await f.assistant.start({ stateDir: f.dir });
  await f.flush();
  assert.notEqual(f.lastCard().outTrackId, c.outTrackId);
});
test("configured digest summaries can still include previously notified pending work", async (t) => {
  const f = await setup(t),
    first = await f.incoming(f.event());
  await f.flush();
  const s = f.assistant.store.get("settings");
  s.notifications.mode = "digest";
  s.notifications.minutes = 1;
  f.assistant.store.set("settings", s);
  await f.incoming(f.event());
  await f.flush(60000);
  assert.equal(f.lastCard().name, "inbox");
  assert.ok(f.lastCard().refs.some((r) => r.id === first.id));
});

test("upgrade refreshes an existing single-draft legacy card instead of sending a duplicate", async (t) => {
  const f = await setup(t);
  await f.incoming(f.event());
  await f.flush();
  const c = f.lastCard();
  f.assistant.store.card({ ...c, deliveryState: undefined });
  f.assistant.store.set("notificationCoverage", {});
  await f.assistant.stop();
  await f.assistant.start({ stateDir: f.dir });
  await f.flush();
  assert.equal(new Set(f.cards.map((c) => c.outTrackId)).size, 1);
  assert.equal(f.lastCard().deliveryState, "delivered");
});
