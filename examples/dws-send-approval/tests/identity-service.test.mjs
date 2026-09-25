import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createIdentityService } from "../identity-service.mjs";
import { IdentityError, cancelled } from "../identity-cli.mjs";
import { readMessageEvent } from "../ingress.mjs";
import { cfg, profiles, answer, folder, context, until } from "./identity-fixtures.mjs";

async function harness(t, options = {}) {
  const dir = await folder(t),
    calls = [],
    built = [];
  let stopped = 0;
  const service = createIdentityService({}, cfg, {
    startupDelayMs: 100000,
    runner: async (_c, args) => {
      calls.push(args);
      return answer(args);
    },
    buildRuntime: async (resolved, ctx, controls) => {
      const runtime = {
        resolved,
        controls,
        service: { stop: async () => stopped++ },
        policy: () => "runtime",
      };
      built.push(runtime);
      return runtime;
    },
    ...options,
  });
  t.after(() => service.stop());
  return { dir, service, calls, built, stopped: () => stopped };
}
test("start returns synchronously, with no CLI, network or filesystem work on the host start path", async (t) => {
  const s = await harness(t);
  assert.equal(s.service.start(context(s.dir)), undefined);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await readdir(s.dir), []);
  assert.equal(s.service.status().state, "starting");
  await s.service.refresh();
  assert.equal(s.service.status().state, "ready");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][0], "profile");
  assert.equal(s.built[0].resolved.profile, "corp:owner");
  assert.deepEqual(s.built[0].resolved.listener.ignoreSenderOpenIds, []);
});
test("logged out preserves employee files and does not instantiate listener or assistant", async (t) => {
  const s = await harness(t, { runner: async () => ({ success: true, profiles: [] }) });
  const dir = join(s.dir, "dws-send-approval");
  await mkdir(dir);
  const file = join(dir, "preferences.json");
  await writeFile(file, "previous-personal-preferences");
  s.service.start(context(s.dir));
  await s.service.refresh();
  assert.equal(s.service.status().state, "waiting_login");
  assert.equal(s.built.length, 0);
  assert.deepEqual(await readdir(dir), ["preferences.json"]);
  assert.equal(await readFile(file, "utf8"), "previous-personal-preferences");
  assert.match(s.service.text(), /等待 DWS 登录/);
});
test("login followed by manual refresh discovers bot without enabling listening", async (t) => {
  let loggedIn = false;
  const s = await harness(t, {
    runner: async (_, args) => (loggedIn ? answer(args) : { success: true, profiles: [] }),
  });
  s.service.start(context(s.dir));
  await s.service.refresh();
  loggedIn = true;
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "ready");
  assert.equal(s.service.status().robot.openId, "open-bot");
  assert.equal(s.built[0].resolved.listener.enabled, false);
  assert.deepEqual(s.built[0].resolved.listener.ignoreSenderOpenIds, ["open-bot", "open-owner"]);
});
test("enabling resolves bot once; warm restart queries only local profile and reuses cache", async (t) => {
  let clock = Date.now();
  const s = await harness(t, { now: () => clock });
  s.service.start(context(s.dir));
  await s.service.refresh();
  await s.built[0].controls.prepareBot();
  assert.equal(s.calls.length, 5); // startup profile; enable profile + owner + bot search/find
  assert.deepEqual(s.built[0].resolved.listener.ignoreSenderOpenIds, ["open-bot", "open-owner"]);
  await s.service.refresh();
  assert.equal(s.calls.length, 6);
  assert.equal(s.service.status().cached, true);
  assert.equal(s.stopped(), 1);
  await s.built[1].controls.prepareBot();
  assert.equal(s.calls.length, 7);
  await s.service.refresh(true);
  assert.equal(s.calls.length, 11);
  clock += 24 * 60 * 60 * 1000;
  await s.service.refresh();
  assert.equal(s.calls.length, 12);
  assert.match(s.service.text(), /历史缓存（已过期，启用监听前重查）/);
  await s.built.at(-1).controls.prepareBot();
  assert.equal(s.calls.length, 16);
  assert.match(s.service.text(), /本次来源：DWS 查询/);
});
test("concurrent enable attempts share bot discovery", async (t) => {
  const s = await harness(t);
  s.service.start(context(s.dir));
  await s.service.refresh();
  await Promise.all(Array.from({ length: 8 }, () => s.built[0].controls.prepareBot()));
  assert.equal(s.calls.filter((a) => a.includes("find")).length, 1);
});
test("resolved owner and robot are excluded from every message subscription without filtering peers", async (t) => {
  const s = await harness(t);
  s.service.start(context(s.dir));
  await s.service.refresh(true);
  const config = s.built[0].resolved;
  for (const type of [
    "user_im_message_receive_o2o_all",
    "user_im_message_receive_at",
    "user_im_message_receive_from_user",
  ]) {
    for (const sender of ["open-owner", "open-bot", "peer"]) {
      const event = {
        type,
        event_id: "e",
        message_id: "m",
        conversation_id: "c",
        sender_open_dingtalk_id: sender,
        timestamp: Date.now(),
        content: "same reply text",
        sender: "同名员工",
      };
      const result = readMessageEvent(JSON.stringify(event), config, { keys: [type] });
      assert.equal(result === null, sender !== "peer");
    }
  }
});
test("owner lookup failure leaves no runtime, listener or partially trusted bot cache", async (t) => {
  const s = await harness(t, {
    runner: async (_, args) =>
      args.includes("contact") ? { success: true, result: [] } : answer(args),
  });
  s.service.start(context(s.dir));
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "failed");
  assert.equal(s.built.length, 0);
  assert.equal(s.service.status().owner, undefined);
});
test("explicit refresh requested during bootstrap is honored and serialized", async (t) => {
  let release,
    count = 0,
    active = 0,
    peak = 0;
  const gate = new Promise((r) => (release = r));
  const s = await harness(t, {
    runner: async (_, args) => {
      active++;
      peak = Math.max(peak, active);
      if (count++ === 0) await gate;
      active--;
      return answer(args);
    },
  });
  s.service.start(context(s.dir));
  const first = s.service.refresh();
  await until(() => count === 1);
  const forced = s.service.refresh(true);
  release();
  await Promise.all([first, forced]);
  assert.equal(s.service.status().robot.openId, "open-bot");
  assert.equal(peak, 1);
});
test("refresh detecting a different owner shuts down the old runtime without changing cached identity", async (t) => {
  let wrong = false;
  const s = await harness(t, {
    runner: async (_, args) => {
      if (wrong) {
        const p = profiles();
        p.profiles[0].userId = "other";
        return p;
      }
      return answer(args);
    },
  });
  s.service.start(context(s.dir));
  await s.service.refresh(true);
  const file = join(s.dir, "dws-send-approval/identity.json"),
    before = await readFile(file);
  wrong = true;
  await s.service.refresh();
  assert.equal(s.service.status().state, "account_mismatch");
  assert.equal(s.stopped(), 1);
  assert.throws(() => s.service.requireRuntime());
  assert.deepEqual(await readFile(file), before);
});
test("DWS OAuth application change cannot silently rebind existing employee data", async (t) => {
  let changed = false;
  const s = await harness(t, {
    runner: async (_, args) => {
      const p = answer(args);
      if (changed && args[0] === "profile") p.profiles[0].clientId = "new-oauth";
      return p;
    },
  });
  s.service.start(context(s.dir));
  await s.service.refresh();
  changed = true;
  await s.service.refresh();
  assert.equal(s.service.status().state, "account_mismatch");
  assert.equal(s.built.length, 1);
});
test("failure affects only listener-origin policy, never ordinary main sessions", async (t) => {
  const s = await harness(t, {
    runner: async () => {
      throw new IdentityError("waiting_login", "登录不可用");
    },
  });
  s.service.start(context(s.dir));
  await s.service.refresh();
  const call = { toolName: "exec", params: { command: "dws chat +messages-send --text hello" } };
  assert.equal(
    s.service.policy(call, { sessionKey: "agent:main:main", agentId: "main" }),
    undefined,
  );
  assert.equal(
    s.service.policy(call, { sessionKey: "agent:main:dws-listener:unknown", agentId: "main" })
      .block,
    true,
  );
});
test("stop aborts an in-flight query, creates no runtime, and cancels delayed startup", async (t) => {
  let entered = false,
    aborted = false;
  const s = await harness(t, {
    runner: (_, __, { signal }) =>
      new Promise((_, reject) => {
        entered = true;
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(cancelled());
          },
          { once: true },
        );
      }),
  });
  s.service.start(context(s.dir));
  const task = s.service.refresh();
  await until(() => entered);
  await s.service.stop();
  await task;
  assert.equal(aborted, true);
  assert.equal(s.service.status().state, "stopped");
  assert.equal(s.built.length, 0);
  await s.service.refresh(true);
  assert.equal(s.built.length, 0);
});
test("hung startup query is bounded and cannot fail host startup", async (t) => {
  const s = await harness(t, {
    budgetMs: 20,
    runner: (_, __, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(cancelled()), { once: true });
      }),
  });
  assert.equal(s.service.start(context(s.dir)), undefined);
  await s.service.refresh();
  assert.equal(s.service.status().state, "failed");
  assert.match(s.service.text(), /超时/);
});
test("automatic transient retries stop after two retries; auth failure never polls", async (t) => {
  let count = 0;
  const s = await harness(t, {
    startupDelayMs: 0,
    retryDelayMs: 5,
    runner: async () => {
      count++;
      throw new IdentityError("failed", "临时网络失败", true);
    },
  });
  s.service.start(context(s.dir));
  await until(() => count === 3);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(count, 3);
  let authCalls = 0;
  const auth = await harness(t, {
    startupDelayMs: 0,
    retryDelayMs: 5,
    runner: async () => {
      authCalls++;
      throw new IdentityError("waiting_login", "请登录");
    },
  });
  auth.service.start(context(auth.dir));
  await until(() => authCalls === 1);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(authCalls, 1);
});
test("a real runtime opens existing preferences only after identity and retains personal off state", async (t) => {
  const dir = await folder(t);
  const service = createIdentityService({ runtime: {} }, cfg, {
    startupDelayMs: 100000,
    runner: async (_, args) => answer(args),
  });
  t.after(() => service.stop());
  service.start(context(dir));
  await service.refresh();
  assert.equal(service.status().state, "ready");
  assert.equal(service.requireRuntime().service.status().state, "off");
  await service.requireRuntime().service.update((v) => {
    v.rules.dm = { mode: "all", ids: [] };
  });
  await service.refresh(true);
  assert.equal(service.requireRuntime().service.snapshot().rules.dm.mode, "all");
  assert.equal(service.requireRuntime().service.snapshot().enabled, false);
});

test("failed cleanup prevents a replacement and remains retryable without duplicate listeners", async (t) => {
  let cannotStop = true,
    starts = 0;
  const s = await harness(t, {
    buildRuntime: async () => {
      starts++;
      return {
        service: {
          stop() {
            if (cannotStop) throw Error("consumer still alive");
          },
        },
        policy() {},
      };
    },
  });
  s.service.start(context(s.dir));
  await s.service.refresh();
  await s.service.refresh(true);
  assert.equal(s.service.status().state, "failed");
  assert.equal(starts, 1);
  assert.match(s.service.text(), /旧监听尚未正常停止/);
  cannotStop = false;
  await s.service.refresh(true);
  assert.equal(starts, 2);
  assert.equal(s.service.status().state, "ready");
});

test("lazy robot discovery has its own total deadline after startup completes", async (t) => {
  const s = await harness(t, {
    budgetMs: 20,
    runner: async (_, args, { signal }) => {
      if (args[0] === "profile") return profiles();
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(cancelled()), { once: true }),
      );
    },
  });
  s.service.start(context(s.dir));
  await s.service.refresh();
  // Keep the test alive, as production has CLI handles but this fake does not.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(s.built[0].controls.prepareBot(), /超时/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(s.service.status().state, "failed");
});

test("a refresh cancels a concurrent enable lookup before building a replacement", async (t) => {
  let firstSearch = true,
    began = false;
  const s = await harness(t, {
    runner: async (_, args, { signal }) => {
      if (firstSearch && args.includes("search")) {
        firstSearch = false;
        began = true;
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(cancelled()), { once: true }),
        );
      }
      return answer(args);
    },
  });
  s.service.start(context(s.dir));
  await s.service.refresh();
  const enabling = assert.rejects(s.built[0].controls.prepareBot());
  await until(() => began);
  await s.service.refresh(true);
  await enabling;
  assert.equal(s.service.status().state, "ready");
  assert.equal(s.service.status().robot.openId, "open-bot");
  assert.equal(s.stopped(), 1);
});
