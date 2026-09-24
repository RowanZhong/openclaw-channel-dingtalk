import assert from "node:assert/strict";
import test from "node:test";
import { resolveDisplayLabels } from "../assistant-directory.mjs";
import { fixture } from "./assistant-fixture.mjs";
const info = (title, singleChat, id = "CID") => ({
  success: true,
  result: { conversationInfo: { title, singleChat, openConversationId: id } },
});
test("stored open user IDs resolve through exact direct-conversation lookup", async () => {
  const rows = await resolveDisplayLabels({}, [{ kind: "user", id: "OPEN" }], [], {
    runner: async (_, args) => {
      assert.deepEqual(args, [
        "chat",
        "conversation-info",
        "--open-dingtalk-id",
        "OPEN",
        "--format",
        "json",
      ]);
      return info("方菲", true);
    },
  });
  assert.equal(rows[0].name, "方菲");
  assert.equal(rows[0].id, "OPEN");
  assert.equal(rows[0].lookupFailed, false);
});
test("invalid user lookup responses cannot supply a display name", async () => {
  for (const response of [info("错群", false), info("错人", true, ""), { success: false }]) {
    const [row] = await resolveDisplayLabels({}, [{ kind: "user", id: "OPEN" }], [], {
      runner: async () => response,
    });
    assert.equal(row.name, undefined);
    assert.equal(row.lookupFailed, true);
  }
});
test("temporary lookup failure retains a verified name and uses a short retry backoff", async () => {
  const before = [{ kind: "user", id: "OPEN", name: "方菲", lookupAt: 1 }];
  let count = 0;
  const runner = async () => {
    count++;
    throw Error("offline");
  };
  const rows = await resolveDisplayLabels({}, before, before, { runner, now: 4000000 });
  assert.equal(rows[0].name, "方菲");
  await resolveDisplayLabels({}, before, rows, { runner, now: 4000001 });
  assert.equal(count, 1);
  await resolveDisplayLabels({}, before, rows, { runner, now: 4060001 });
  assert.equal(count, 2);
});
test("opening scope card hydrates and persists both user and group names without changing scope", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    directoryRunner: async (_, args) => {
      calls++;
      return args[2] === "--group" ? info("OpenClaw Test", false, "G1") : info("方菲", true);
    },
  });
  f.prefs.rules.dm = { mode: "users", ids: ["OPEN"] };
  f.prefs.rules.at = { mode: "groups", ids: ["G1"] };
  const before = structuredClone(f.prefs);
  await f.assistant.show("listen");
  assert.match(f.cards.at(-1).data.description, /方菲/);
  assert.match(f.cards.at(-1).data.description, /OpenClaw Test/);
  assert.doesNotMatch(f.cards.at(-1).data.description, /名称待核实|暂未获取名称/);
  assert.deepEqual(f.prefs, before);
  assert.equal(calls, 2);
  await f.assistant.show("listen");
  assert.equal(calls, 2);
  assert.equal(f.assistant.store.get("directory").length, 2);
});
test("failed name lookup keeps a usable settings card with explicit ID and preserves existing name", async (t) => {
  const f = await fixture(t);
  f.prefs.rules.dm = { mode: "users", ids: ["OPEN"] };
  f.prefs.rules.at = { mode: "groups", ids: ["G1"] };
  f.assistant.store.set("directory", [
    { kind: "group", id: "G1", name: "OpenClaw Test", lookupAt: 1 },
  ]);
  await f.assistant.show("listen");
  const body = f.cards.at(-1).data.description;
  assert.match(body, /暂未获取名称（ID：OPEN）/);
  assert.match(body, /OpenClaw Test/);
});
