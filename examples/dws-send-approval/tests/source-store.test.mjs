import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SourceStore } from "../source-store.mjs";
import { config, event, setup } from "./fixtures.mjs";

test("business-message dedupe persists across subscription IDs, event types and restart", async (t) => {
  const s = await setup(t);
  const restarted = new SourceStore(config);
  await restarted.load(s.folder);
  const duplicate = {
    ...event,
    event_id: "second-subscription-id",
    type: "user_im_message_receive_at",
  };
  assert.equal(restarted.has(duplicate), true);
  assert.equal(await restarted.claim(duplicate), null);
  assert.equal(restarted.records.size, 1);
  assert.equal(restarted.classify(s.ctx), "listener");
  const raw = await readFile(join(s.folder, "dws-send-approval", "sources.json"), "utf8");
  assert.doesNotMatch(raw, /message-1|conversation-1|hello/);
});

test("different messages, conversations and profiles are not collapsed", async (t) => {
  const s = await setup(t);
  for (const next of [
    { ...event, event_id: "next-message", message_id: "message-2" },
    { ...event, event_id: "next-conversation", conversation_id: "conversation-2" },
  ]) {
    assert.ok(await s.store.claim(next));
  }
  const otherProfile = new SourceStore({ ...config, profile: "other" });
  await otherProfile.load(s.folder);
  assert.ok(await otherProfile.claim(event));
});

test("0.2.0 records retain source protection and event-ID dedupe during upgrade", async (t) => {
  const s = await setup(t);
  const legacy = { ...s.record };
  delete legacy.messageKey;
  await writeFile(
    join(s.folder, "dws-send-approval", "sources.json"),
    JSON.stringify({ version: 1, records: [legacy] }),
  );
  const upgraded = new SourceStore(config);
  await upgraded.load(s.folder);
  assert.equal(upgraded.classify(s.ctx), "listener");
  assert.equal(await upgraded.claim(event), null);
  assert.ok(await upgraded.claim({ ...event, event_id: "new", message_id: "new" }));
  assert.equal(upgraded.classify(s.ctx), "listener");
});

test("invalid persisted message fingerprint fails closed", async (t) => {
  const s = await setup(t);
  await writeFile(
    join(s.folder, "dws-send-approval", "sources.json"),
    JSON.stringify({
      version: 1,
      records: [{ ...s.record, messageKey: "bad" }],
    }),
  );
  await assert.rejects(s.store.load(s.folder), /Cannot load/);
  assert.equal(s.store.classify(s.ctx), "unknown");
});
