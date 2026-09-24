import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readConfig } from "../config.mjs";
import { PreferenceStore, initialPreferences } from "../preferences.mjs";
import { controls, settings, owner } from "./control-fixtures.mjs";

test("fresh deployment loads source guard and commands without starting DWS", async (t) => {
  const s = await controls(t);
  assert.equal(s.children.length, 0);
  assert.equal(s.sources.ready, true);
  assert.equal(s.service.status().state, "off");
  assert.deepEqual([...s.commands.keys()], ["dws-listen", "dws-reply"]);
  assert.match(await s.listen("on"), /尚未选择/);
  assert.equal(s.service.snapshot().enabled, false);
});

test("independent rule commands commute; sender off is not a private-chat exclusion", async (t) => {
  const s = await controls(t);
  await s.listen("at groups G1,G2");
  await s.listen("sender users U1");
  await s.listen("dm all");
  await s.listen("sender off");
  assert.deepEqual(s.service.snapshot().rules, {
    dm: { mode: "all", ids: [] },
    at: { mode: "groups", ids: ["G1", "G2"] },
    sender: { mode: "off", ids: [] },
  });
  assert.equal(s.children.length, 0);
  assert.match(await s.listen("on"), /启动中/);
  assert.equal(s.children.length, 1);
  s.children[0].ready();
  assert.match(await s.listen("status"), /已就绪/);
});

test("only trusted owner private channel metadata authorizes mutations", async (t) => {
  const s = await controls(t);
  for (const patch of [
    { senderId: "B" },
    { from: "group-1", to: "group-1" },
    { channel: "webchat" },
    { accountId: "other" },
    { isAuthorizedSender: false },
    { from: undefined },
    { sessionKey: "agent:main:dws-listener:forged" },
    { messageThreadId: "thread" },
  ]) {
    assert.match(await s.listen("dm all", { ...owner, ...patch }), /仅允许/);
    assert.match(await s.reply("default fixed hello", { ...owner, ...patch }), /仅允许/);
  }
  assert.equal(s.service.snapshot().revision, 0);
  await s.listen("dm all", {
    ...owner,
    senderId: "dd:owner",
    from: "dingtalk:owner",
    to: "user:owner",
  });
  assert.equal(s.service.snapshot().rules.dm.mode, "all");
});

test("invalid and multi-command input leaves settings untouched", async (t) => {
  const s = await controls(t);
  for (const args of [
    "dm users",
    "at users U1",
    "sender all",
    "dm all U1",
    "at groups G1;touch",
    "dm all\n/dws-listen on",
    "at groups " + Array.from({ length: 21 }, (_, i) => `G${i}`).join(","),
  ]) {
    assert.match(await s.listen(args), /操作未完成/);
  }
  assert.equal(s.service.snapshot().revision, 0);
});

test("concurrent updates serialize and persist without lost fields", async (t) => {
  const s = await controls(t);
  await Promise.all([
    s.listen("dm users U1,U2"),
    s.listen("at groups G1"),
    s.reply("default fixed received"),
  ]);
  const disk = JSON.parse(
    await readFile(join(s.folder, "dws-send-approval/preferences.json"), "utf8"),
  );
  assert.equal(disk.preferences.revision, 3);
  assert.equal(disk.preferences.reply.default.text, "received");
  assert.deepEqual(disk.preferences.rules.dm.ids, ["U1", "U2"]);
  assert.deepEqual(disk.preferences.rules.at.ids, ["G1"]);
});

test("persisted preferences win over a changed platform seed and survive reload", async (t) => {
  const s = await controls(t);
  await s.listen("dm users U1");
  await s.reply("group G1 fixed hello");
  const loaded = new PreferenceStore({
    ...settings,
    listener: { enabled: true, kind: "all-direct" },
  });
  await loaded.load(s.folder);
  assert.deepEqual(loaded.snapshot(), s.service.snapshot());
});

test("corruption and another employee binding cannot reset or reuse preferences", async (t) => {
  const s = await controls(t);
  await assert.rejects(
    new PreferenceStore({ ...settings, ownerUserId: "B" }).load(s.folder),
    /绑定/,
  );
  await writeFile(join(s.folder, "dws-send-approval/preferences.json"), "{SYNTHETIC_PRIVATE");
  await assert.rejects(new PreferenceStore(settings).load(s.folder), /个人设置损坏/);
});

test("legacy config seeds scoped rules with default off and documents narrower group migration", () => {
  for (const kind of [
    "all-direct",
    "at-me",
    "sender",
    "group",
    "all-group",
    "all-direct-and-at-me",
  ]) {
    const config = readConfig({
      ...settings,
      listener: {
        kind,
        ...(["sender", "group"].includes(kind) ? { target: "stable-id" } : {}),
        ignoreSenderOpenIds: ["bot"],
      },
    });
    const value = initialPreferences(config);
    assert.equal(value.enabled, false);
    if (kind === "group") {
      assert.deepEqual(value.rules.at, { mode: "groups", ids: ["stable-id"] });
    }
  }
});

test("private and sender scopes cannot enable without platform bot exclusion", async (t) => {
  const s = await controls(t, {}, readConfig({ ...settings, listener: {} }));
  await s.listen("dm all");
  assert.match(await s.listen("on"), /审批机器人/);
  await s.listen("dm off");
  await s.listen("sender users U1");
  assert.match(await s.listen("on"), /审批机器人/);
  assert.equal(s.children.length, 0);
});

test("opaque Base64-style group and user IDs remain literal; identity key order is irrelevant", async (t) => {
  const s = await controls(t);
  const id = "cidAb/c+D_1==$";
  await s.listen(`at groups ${id}`);
  await s.listen(`sender users ${id}`);
  assert.deepEqual(s.service.snapshot().rules.at.ids, [id]);
  const path = join(s.folder, "dws-send-approval/preferences.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.identity = { accountId: "default", ownerUserId: "owner", profile: "work" };
  await writeFile(path, JSON.stringify(saved));
  const restored = new PreferenceStore(settings);
  await restored.load(s.folder);
  assert.deepEqual(restored.snapshot(), s.service.snapshot());
});
