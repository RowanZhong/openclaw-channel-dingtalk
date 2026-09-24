import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./assistant-fixture.mjs";

test("card expiry is absolute across navigation, shown to owner, and disables mutation", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  const c = await f.assistant.show();
  assert.match(f.cards.at(-1).data.description, /有效至/);
  clock += 60000;
  await f.act(c, "listen");
  await f.act(f.lastCard(), "listen-dm");
  const next = f.lastCard();
  assert.equal(next.expires, c.expires);
  clock = c.expires;
  await f.assistant.maintenance();
  assert.equal(f.cards.at(-1).data.card_status, "expired");
  await f.act(next, "save-listen", { dm: "all", at: "off", senderIds: "" });
  assert.equal(f.prefs.revision, 0);
  assert.deepEqual(f.cards.at(-1).data.form.fields, []);
});
test("opening a fresh card invalidates historical controls before the expiry time", async (t) => {
  const f = await fixture(t),
    old = await f.assistant.show();
  const current = await f.assistant.show();
  await f.assistant.idle();
  await f.act(old, "toggle");
  assert.equal(f.prefs.enabled, true);
  assert.ok(f.assistant.store.getCard(old.id).invalidated);
  assert.equal(f.assistant.store.getCard(current.id).invalidated, undefined);
});
test("expiry is enforced even when platform repaint fails", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, {
    now: () => clock,
    transport: {
      sendCard: async () => {},
      updateCard: async () => {
        throw Error("offline");
      },
    },
  });
  const c = await f.assistant.show();
  clock = c.expires;
  await f.assistant.maintenance();
  await f.act(c, "toggle");
  assert.equal(f.prefs.revision, 0);
});
test("in-flight directory validation cannot apply after a newer card revokes the old one", async (t) => {
  let release;
  const f = await fixture(t, { resolve: () => new Promise((r) => (release = r)) });
  const c = await f.assistant.show("listen-dm");
  const operation = f.act(c, "save-listen", { dm: "users", dmIds: "B", at: "off", senderIds: "" });
  await new Promise(setImmediate);
  await f.assistant.show();
  release([{ kind: "user", id: "B", userId: "B", name: "B" }]);
  await operation;
  assert.equal(f.prefs.revision, 0);
});
