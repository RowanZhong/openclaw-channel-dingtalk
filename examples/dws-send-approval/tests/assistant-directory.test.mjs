import assert from "node:assert/strict";
import test from "node:test";
import { resolveTargets, splitTargets, resolveGroupLabels } from "../assistant-directory.mjs";
const group = (id, title = "项目群") => ({ openConversationId: id, title });
test("target lists support commas, Chinese commas, newlines, and stable deduplication", () => {
  assert.deepEqual(splitTargets("U1，U2\nU1, U3"), ["U1", "U2", "U3"]);
  assert.throws(() => splitTargets(Array.from({ length: 21 }, (_, i) => String(i)).join(",")));
});
test("UserId must match returned userId exactly and maps to the event identity", async () => {
  const r = await resolveTargets({}, "user", "staff1", {
    runner: async (_, argv) => {
      assert.deepEqual(argv.slice(0, 5), ["contact", "user", "search", "--query", "staff1"]);
      return {
        success: true,
        result: [
          { userId: "staff1", openDingTalkId: "OPEN1", name: "甲" },
          { userId: "other", openDingTalkId: "OPEN2" },
        ],
      };
    },
  });
  assert.equal(r[0].id, "OPEN1");
  assert.equal(r[0].userId, "staff1");
});
for (const [name, result] of [
  ["missing", { success: true, result: [] }],
  [
    "ambiguous",
    {
      success: true,
      result: [
        { userId: "U", openDingTalkId: "A" },
        { userId: "U", openDingTalkId: "B" },
      ],
    },
  ],
  ["failed", { success: false, result: [] }],
])
  test(`user ${name} fails closed`, async () => {
    await assert.rejects(resolveTargets({}, "user", "U", { runner: async () => result }));
  });
test("duplicate group names on a later page cannot silently bind to the first result", async () => {
  let page = 0;
  const runner = async () => ({
    success: true,
    result: { groups: [group(page++ ? "G2" : "G1")], hasMore: page === 1, nextCursor: "next" },
  });
  await assert.rejects(resolveTargets({}, "group", "项目群", { runner }), /重名/);
  page = 0;
  const r = await resolveTargets({}, "group", "项目群#G2", { runner });
  assert.equal(r[0].id, "G2");
});
test("incomplete group pagination and fuzzy-only matches are rejected", async () => {
  await assert.rejects(
    resolveTargets({}, "group", "项目群", {
      runner: async () => ({
        result: { groups: [group("G1")], hasMore: true, nextCursor: "same" },
      }),
    }),
    /未完整/,
  );
  await assert.rejects(
    resolveTargets({}, "group", "项目群", {
      runner: async () => ({ result: { groups: [group("G1", "项目群2")], hasMore: false } }),
    }),
    /没有唯一/,
  );
});
test("legacy open IDs can only preserve existing configured subjects", async () => {
  const runner = async () => {
    throw Error("no call expected");
  };
  assert.equal(
    (await resolveTargets({}, "user", "open:OPEN1", { runner, existing: ["OPEN1"] }))[0].id,
    "OPEN1",
  );
  await assert.rejects(resolveTargets({}, "user", "open:OTHER", { runner, existing: ["OPEN1"] }));
});

test("group labels bind to the exact queried ID, and cache hits avoid CLI work", async () => {
  let calls = 0;
  const runner = async (_, args, options) => {
    calls++;
    assert.ok(options.timeoutMs <= 2000);
    assert.deepEqual(args, ["chat", "conversation-info", "--group", "G1", "--format", "json"]);
    return {
      result: {
        conversationInfo: { openConversationId: "G1", singleChat: false, title: "项目群" },
      },
    };
  };
  const rows = await resolveGroupLabels({}, ["G1", "G1"], [], { runner, now: 100000 });
  assert.equal(rows[0].name, "项目群");
  await resolveGroupLabels({}, ["G1"], rows, { runner, now: 100001 });
  assert.equal(calls, 1);
  const wrong = await resolveGroupLabels({}, ["G1"], [], {
    runner: async () => ({
      result: {
        conversationInfo: { openConversationId: "OTHER", title: "错误群", singleChat: false },
      },
    }),
  });
  assert.equal(wrong[0].name, undefined);
});
test("unavailable group labels retain the ID and throttle retry without failing settings", async () => {
  let calls = 0;
  const runner = async () => {
    calls++;
    throw Error("offline");
  };
  const rows = await resolveGroupLabels({}, ["G1"], [], { runner, now: 100000 });
  assert.equal(rows[0].id, "G1");
  await resolveGroupLabels({}, ["G1"], rows, { runner, now: 100001 });
  assert.equal(calls, 1);
});
test("group label lookups cap parallelism at four", async () => {
  let active = 0,
    peak = 0;
  const runner = async (_, args) => {
    peak = Math.max(peak, ++active);
    await new Promise(setImmediate);
    active--;
    return {
      result: { conversationInfo: { openConversationId: args[3], singleChat: false, title: "群" } },
    };
  };
  await resolveGroupLabels(
    {},
    Array.from({ length: 20 }, (_, i) => `G${i}`),
    [],
    { runner },
  );
  assert.equal(peak, 4);
});
