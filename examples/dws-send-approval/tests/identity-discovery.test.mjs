import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  channelRobot,
  selectProfile,
  makeBinding,
  sameBinding,
  readIdentity,
  writeIdentity,
  validRobotCache,
  discoverRobot,
  discoverOwner,
  validOwnerCache,
  IDENTITY_TTL_MS,
} from "../identity-discovery.mjs";
import { cfg, host, profiles, search, find, folder } from "./identity-fixtures.mjs";
const binding = () => makeBinding(selectProfile(profiles(), cfg), cfg, channelRobot(cfg, host));

test("owner open ID is resolved by exact UserId in the bound profile, never by display name", async () => {
  const owner = await discoverOwner(
    binding(),
    async (args) => {
      assert.deepEqual(args, [
        "--profile",
        "corp:owner",
        "contact",
        "user",
        "search",
        "--query",
        "owner",
        "--format",
        "json",
      ]);
      return {
        success: true,
        result: [
          { userId: "other", name: "同名员工", openDingTalkId: "other-open" },
          { userId: "owner", openDingTalkId: "open-owner" },
        ],
      };
    },
    () => 100,
  );
  assert.deepEqual(owner, { openId: "open-owner", checkedAt: 100 });
  assert.equal(validOwnerCache({ owner }, 100), true);
  assert.equal(validOwnerCache({ owner }, 100 + IDENTITY_TTL_MS), false);
  assert.equal(validOwnerCache({}, 100), false);
});
test("missing, ambiguous or malformed owner open IDs prevent listener startup", async () => {
  for (const result of [
    undefined,
    [],
    [{ userId: "other", openDingTalkId: "open" }],
    [{ userId: "owner", openDingTalkId: "bad id" }],
    [
      { userId: "owner", openDingTalkId: "one" },
      { userId: "owner", openDingTalkId: "two" },
    ],
  ])
    await assert.rejects(discoverOwner(binding(), async () => ({ success: true, result })));
});

test("profile is canonical and bound to the instance owner and DWS OAuth application", () => {
  assert.deepEqual(selectProfile(profiles(), cfg), {
    profile: "corp:owner",
    corpId: "corp",
    userId: "owner",
    dwsClientId: "oauth-code",
  });
  assert.throws(() => selectProfile(profiles(), { ...cfg, ownerUserId: "other" }), {
    identityState: "account_mismatch",
  });
  assert.throws(() => selectProfile(profiles(), { ...cfg, profile: "wrong" }), {
    identityState: "account_mismatch",
  });
  assert.equal(selectProfile(profiles(), { ...cfg, profile: "corp" }).profile, "corp:owner");
});
test("logged-out profiles do not invent an identity", () => {
  for (const data of [
    { success: true, profiles: [] },
    { ...profiles(), currentProfile: undefined },
  ]) {
    assert.throws(() => selectProfile(data, cfg), { identityState: "waiting_login" });
  }
});
test("invalid, duplicate and inconsistent profile payloads fail closed", () => {
  for (const edit of [
    (p) => (p.success = false),
    (p) => (p.profiles = {}),
    (p) => p.profiles.push(p.profiles[0]),
    (p) => (p.profiles[0].clientId = ""),
    (p) => (p.profiles[0].isCurrent = false),
    (p) => (p.currentProfile = "other"),
  ]) {
    const p = profiles();
    edit(p);
    assert.throws(() => selectProfile(p, cfg));
  }
  const p = profiles();
  p.profiles[0].status = "revoked";
  assert.throws(() => selectProfile(p, cfg), { identityState: "waiting_login" });
  p.profiles[0].status = "expired";
  assert.equal(selectProfile(p, cfg).userId, "owner");
});
test("default account honors its explicit override, then top-level; other named accounts must exist", () => {
  assert.equal(channelRobot(cfg, host), "robot-code");
  assert.equal(
    channelRobot(cfg, {
      channels: { dingtalk: { clientId: "root", accounts: { default: { clientId: "override" } } } },
    }),
    "override",
  );
  assert.throws(
    () => channelRobot(cfg, { channels: { dingtalk: { clientId: { ref: "unsupported" } } } }),
    { identityState: "unavailable" },
  );
  const named = { channels: { dingtalk: { accounts: { staff: { clientId: "named" } } } } };
  assert.throws(() => channelRobot(cfg, named), { identityState: "unavailable" });
  assert.equal(channelRobot({ ...cfg, accountId: "staff" }, named), "named");
  assert.throws(() => channelRobot({ ...cfg, accountId: "missing" }, host));
  assert.throws(() =>
    channelRobot(cfg, { channels: { dingtalk: { enabled: false, clientId: "robot-code" } } }),
  );
});
test("bot discovery binds robotCode before exact-name open ID lookup, with explicit profile", async () => {
  const calls = [];
  const robot = await discoverRobot(
    binding(),
    async (args) => {
      calls.push(args);
      if (args.includes("search"))
        return {
          success: true,
          robotList: [{ robotCode: "other", robotName: "干扰项" }, ...search().robotList],
        };
      return find();
    },
    () => 42,
  );
  assert.deepEqual(robot, { name: "小钉", openId: "open-bot", checkedAt: 42 });
  assert.equal(calls.length, 2);
  for (const a of calls) assert.deepEqual(a.slice(0, 2), ["--profile", "corp:owner"]);
  assert.equal(calls[1][calls[1].indexOf("--query") + 1], "小钉");
});
test("search paginates and find deduplicates repeated IDs across valid pages", async () => {
  const calls = [];
  const robot = await discoverRobot(binding(), async (args) => {
    calls.push(args);
    if (args.includes("search"))
      return args.includes("1") ? { success: true, robotList: [{ robotCode: "other" }] } : search();
    const r = find();
    if (!args.includes("--cursor")) Object.assign(r.result, { hasMore: true, nextCursor: "next" });
    return r;
  });
  assert.equal(robot.openId, "open-bot");
  assert.equal(calls.length, 4);
});
test("discovery refuses missing, duplicate or malformed bot identities", async () => {
  const badSearch = [
    { success: false },
    { success: true, robotList: [] },
    { success: true, robotList: [{ robotCode: "robot-code" }] },
    { success: true, robotList: [...search().robotList, ...search().robotList] },
  ];
  for (const data of badSearch) await assert.rejects(discoverRobot(binding(), async () => data));
  const badFind = [
    { success: true, result: {} },
    { success: true, result: { bots: [], hasMore: false } },
    {
      success: true,
      result: { bots: [{ name: "小钉", botOpenDingTalkId: "has space" }], hasMore: false },
    },
    {
      success: true,
      result: {
        bots: [...find().result.bots, { name: "小钉", botOpenDingTalkId: "second" }],
        hasMore: false,
      },
    },
  ];
  for (const data of badFind)
    await assert.rejects(
      discoverRobot(binding(), async (a) => (a.includes("search") ? search() : data)),
    );
});
test("malformed or endless pagination has strict bounds", async () => {
  for (const repeated of [true, false]) {
    let count = 0;
    await assert.rejects(
      discoverRobot(binding(), async (a) => {
        if (a.includes("search")) return search();
        const r = find();
        Object.assign(r.result, {
          hasMore: true,
          nextCursor: repeated ? "repeat" : String(++count),
        });
        return r;
      }),
    );
    assert.ok(count <= 5);
  }
  let pages = 0;
  await assert.rejects(
    discoverRobot(binding(), async () => {
      pages++;
      return { success: true, robotList: [{ robotCode: "different" }] };
    }),
  );
  assert.equal(pages, 5);
});
test("cache is atomic, owner-only, bound to all identity fields, and unchanged on mismatch", async (t) => {
  const dir = await folder(t),
    b = binding();
  const record = await readIdentity(dir, b);
  assert.deepEqual(record, { version: 1, binding: b });
  record.robot = { name: "小钉", openId: "open-bot", checkedAt: 100 };
  await writeIdentity(dir, record);
  const file = join(dir, "dws-send-approval/identity.json"),
    before = await readFile(file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readIdentity(dir, b), record);
  for (const key of Object.keys(b)) {
    await assert.rejects(readIdentity(dir, { ...b, [key]: "changed" }), {
      identityState: "account_mismatch",
    });
  }
  assert.deepEqual(await readFile(file), before);
  assert.equal(sameBinding(b, { ...b, extra: 1 }), false);
});
test("corrupt cache is preserved and cancelled writes leave no new data or temporary file", async (t) => {
  const dir = await folder(t),
    b = binding();
  await writeIdentity(dir, { version: 1, binding: b });
  const file = join(dir, "dws-send-approval/identity.json");
  await writeFile(file, "{broken");
  await assert.rejects(readIdentity(dir, b), { identityState: "failed" });
  const abort = AbortSignal.abort();
  await assert.rejects(writeIdentity(dir, { version: 1, binding: b }, abort));
  assert.equal(await readFile(file, "utf8"), "{broken");
  assert.deepEqual(await readdir(join(dir, "dws-send-approval")), ["identity.json"]);
});
test("cache expiry and clock rollback require a new bot lookup", () => {
  const record = { robot: { checkedAt: 100 } };
  assert.equal(validRobotCache(record, 100), true);
  assert.equal(validRobotCache(record, 100 + IDENTITY_TTL_MS - 1), true);
  assert.equal(validRobotCache(record, 100 + IDENTITY_TTL_MS), false);
  assert.equal(validRobotCache(record, 99), false);
  assert.equal(validRobotCache({}, 100), false);
});
