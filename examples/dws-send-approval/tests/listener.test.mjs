import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { LISTENER_LANE, readConfig } from "../config.mjs";
import { readMessageEvent, buildRunRequest, createLineReader } from "../ingress.mjs";
import { createListenerService } from "../listener.mjs";
import { createPolicy } from "../policy.mjs";
import { initialPreferences } from "../preferences.mjs";
import { subscriptionPlan } from "../rules.mjs";
import { SourceStore } from "../source-store.mjs";
import { config, host, event, setup } from "./fixtures.mjs";

const until = async (predicate) => {
  for (let i = 0; i < 150; i++) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(predicate(), "condition did not settle");
};

async function serviceFixture(t, runtime = {}, settings = config) {
  const folder = await mkdtemp(join(tmpdir(), "dws-listener-test-"));
  const store = new SourceStore(settings);
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  const signals = [],
    runs = [],
    logs = [];
  child.kill = (signal) => {
    signals.push(signal);
    child.signalCode = signal;
    child.emit("exit");
  };
  const api = {
    runtime: {
      subagent: {
        run: async (args) => {
          runs.push(args);
          return { runId: "run", sessionKey: args.sessionKey };
        },
        waitForRun: async () => ({ status: "ok" }),
        ...runtime,
      },
    },
  };
  const service = createListenerService(api, settings, store, {
    spawn: (file, args, options) => {
      assert.equal(file, settings.dwsPath);
      assert.equal(options.shell, false);
      assert.deepEqual(args, subscriptionPlan(initialPreferences(settings), settings)[0].args);
      return child;
    },
  });
  const ctx = {
    config: host,
    stateDir: folder,
    logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
  };
  await service.start(ctx);
  t.after(async () => {
    await service.stop();
    await rm(folder, { recursive: true, force: true });
  });
  return { folder, service, child, signals, runs, logs, store };
}

test("stdout before ready is buffered and JSON event fields cannot override the route", async (t) => {
  const s = await serviceFixture(t);
  const message = JSON.stringify({
    ...event,
    sessionKey: "agent:main:main",
    agentId: "other",
    deliver: true,
    lane: "main",
  });
  s.child.stdout.write(message.slice(0, 40));
  s.child.stdout.write(message.slice(40) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(s.runs.length, 0);
  s.child.stderr.write(
    "[event] ready event_key=user_im_message_receive_user bus_pid=1 subscribe_id=test\n",
  );
  await until(() => s.runs.length === 1);
  assert.match(s.runs[0].sessionKey, /^agent:main:dws-listener:[0-9a-f]{64}$/);
  assert.equal(s.runs[0].deliver, false);
  assert.equal(s.runs[0].lane, LISTENER_LANE);
  assert.notEqual(s.runs[0].lane, "main");
  assert.equal(s.runs[0].idempotencyKey, s.runs[0].sessionKey);
  assert.doesNotMatch(s.runs[0].message, /agent:main:main/);
  assert.equal(s.store.classify({ sessionKey: s.runs[0].sessionKey, agentId: "main" }), "listener");
});

test("duplicate delivery is ignored, including after restarting source storage", async (t) => {
  const s = await setup(t);
  assert.equal(await s.store.claim(event), null);
  const restarted = new SourceStore(config);
  await restarted.load(s.folder);
  assert.equal(await restarted.claim(event), null);
  assert.equal(restarted.classify(s.ctx), "listener");
  assert.notEqual(restarted.keyFor({ ...event, event_id: "next" }), s.record.sessionKey);
});

test("corrupt source storage fails closed and is not silently recreated", async (t) => {
  const s = await setup(t);
  await writeFile(join(s.folder, "dws-send-approval", "sources.json"), "{broken");
  const restarted = new SourceStore(config);
  await assert.rejects(restarted.load(s.folder), /Cannot load/);
  assert.equal(restarted.classify(s.ctx), "unknown");
  await assert.rejects(s.store.load(s.folder), /Cannot load/);
  assert.equal(s.store.classify(s.ctx), "unknown", "reload must not retain an earlier ready state");
  await rm(join(s.folder, "dws-send-approval", "sources.json"));
  await s.store.load(s.folder);
  assert.equal(s.store.classify(s.ctx), "unknown", "removed records must not survive a reload");
});

test("registry capacity stops admission instead of evicting protected records", async (t) => {
  const s = await setup(t);
  s.store.capacity = 1;
  await assert.rejects(s.store.claim({ ...event, event_id: "next", message_id: "next" }), /full/);
  assert.equal(s.store.classify(s.ctx), "listener");
});

test("raw envelopes, wrong event types and missing IDs are not dispatched", () => {
  for (const value of [
    { data: event },
    { ...event, event_id: "" },
    { ...event, type: "approval" },
    { ...event, content: {} },
  ]) {
    assert.throws(() => readMessageEvent(JSON.stringify(value), config));
  }
  assert.equal(
    readMessageEvent(JSON.stringify({ ...event, sender_open_dingtalk_id: "other" }), config),
    null,
  );
});

test("approval bot and own outgoing identities can be excluded using stable IDs", () => {
  const cfg = { ...config, listener: { kind: "all-direct", ignoreSenderOpenIds: ["bot", "self"] } };
  for (const sender of ["bot", "self"]) {
    assert.equal(
      readMessageEvent(
        JSON.stringify({
          ...event,
          type: "user_im_message_receive_o2o_all",
          sender_open_dingtalk_id: sender,
        }),
        cfg,
      ),
      null,
    );
  }
});

test("long partial lines fail without retaining unbounded data", () => {
  let failures = 0;
  const lines = [];
  const read = createLineReader(
    (s) => lines.push(s),
    () => failures++,
    12,
  );
  read("one\ntwo\n");
  read("x".repeat(13));
  read("ignored\n");
  assert.deepEqual(lines, ["one", "two"]);
  assert.equal(failures, 1);
});

test("oversize and invalid events stop the child without logging event content", async (t) => {
  const s = await serviceFixture(t);
  s.child.stdout.write('{"secret":"SYNTHETIC_PRIVATE"}\n');
  assert.deepEqual(s.signals, ["SIGTERM"]);
  assert.equal(s.runs.length, 0);
  assert.doesNotMatch(s.logs.join("\n"), /SYNTHETIC_PRIVATE/);
});

test("pre-ready queue has a hard limit", async (t) => {
  const s = await serviceFixture(t);
  for (let i = 0; i < 101; i++) {
    s.child.stdout.write(
      JSON.stringify({ ...event, event_id: `e${i}`, message_id: `m${i}` }) + "\n",
    );
  }
  assert.deepEqual(s.signals, ["SIGTERM"]);
  assert.equal(s.runs.length, 0);
});

test("uncertain admission is never automatically retried", async (t) => {
  let attempts = 0;
  const s = await serviceFixture(t, {
    run: async () => {
      attempts++;
      throw new Error("ambiguous transport failure");
    },
  });
  s.child.stderr.write("[event] ready event_key=user_im_message_receive_user\n");
  s.child.stdout.write(JSON.stringify(event) + "\n");
  await until(() => s.signals.length === 1);
  assert.equal(attempts, 1);
  assert.equal(await s.store.claim(event), null);
});

test("unexpected canonical session identity stops further admission", async (t) => {
  const s = await serviceFixture(t, {
    run: async () => ({ runId: "run", sessionKey: "agent:main:main" }),
  });
  s.child.stderr.write("[event] ready event_count=1\n");
  s.child.stdout.write(JSON.stringify(event) + "\n");
  await until(() => s.signals.length === 1);
  assert.ok(s.logs.some((m) => m.includes("unexpected listener run identity")));
});

test("service stops DWS gracefully; final output is never automatically delivered", async (t) => {
  const s = await serviceFixture(t);
  await s.service.stop();
  assert.deepEqual(s.signals, ["SIGTERM"]);
  assert.equal(s.child.stdin.writableEnded, true);
  const request = buildRunRequest(event, { sessionKey: "controlled" }, config);
  assert.equal(request.deliver, false);
  assert.equal(request.provider, undefined);
  assert.equal(request.cwd, undefined);
});

const combined = readConfig({
  ...config,
  listener: { enabled: true, kind: "all-direct-and-at-me", ignoreSenderOpenIds: ["approval-bot"] },
});
const direct = { ...event, type: "user_im_message_receive_o2o_all" };
const mention = {
  ...event,
  type: "user_im_message_receive_at",
  event_id: "mention-1",
  message_id: "group-message-1",
  conversation_id: "group-1",
};

test("combined subscriptions wait for aggregate readiness and share one serial approval chain", async (t) => {
  const waits = [];
  const s = await serviceFixture(
    t,
    {
      waitForRun: () => new Promise((resolve) => waits.push(resolve)),
    },
    combined,
  );
  s.child.stdout.write(JSON.stringify(direct) + "\n" + JSON.stringify(mention) + "\n");
  s.child.stderr.write("[event] ready event_key=user_im_message_receive_o2o_all\n");
  s.child.stderr.write("[event] ready event_count=1 bus_pid=1\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(s.runs.length, 0, "partial readiness dispatched work");
  s.child.stderr.write("[event] ready event_count=2 bus_pid=1\n");
  await until(() => waits.length === 1);
  assert.equal(s.runs.length, 1, "listener ran tasks concurrently");
  waits[0]({ status: "ok" });
  await until(() => waits.length === 2);
  assert.equal(s.runs.length, 2);
  const policy = createPolicy(combined, s.store);
  for (const run of s.runs) {
    assert.equal(run.lane, LISTENER_LANE);
    assert.equal(run.deliver, false);
    const ctx = { sessionKey: run.sessionKey, agentId: combined.agentId };
    assert.equal(s.store.classify(ctx), "listener");
    const result = policy(
      {
        toolName: "exec",
        params: {
          command: `dws chat +messages-send --chat-id ${JSON.parse(run.message.split("\n").slice(1).join("\n")).conversation_id} --text hello --yes`,
        },
      },
      ctx,
    );
    assert.deepEqual(result.requireApproval.allowedDecisions, ["allow-once", "deny"]);
  }
  waits[1]({ status: "ok" });
});

test("combined duplicate events do not fill the queue or run again after completion", async (t) => {
  const s = await serviceFixture(t, {}, combined);
  for (let i = 0; i < 150; i++) {
    // One business message can have different IDs/types on different subscriptions.
    s.child.stdout.write(
      JSON.stringify({
        ...direct,
        event_id: `duplicate-${i}`,
        type: i % 2 ? mention.type : direct.type,
      }) + "\n",
    );
  }
  assert.deepEqual(s.signals, []);
  s.child.stderr.write("[event] ready event_count=2 bus_pid=1\n");
  await until(() => s.runs.length === 1);
  s.child.stdout.write(JSON.stringify({ ...direct, event_id: "again-after-admission" }) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(s.runs.length, 1);
});

test("approval bot is excluded from both combined event types", async (t) => {
  const s = await serviceFixture(t, {}, combined);
  s.child.stderr.write("[event] ready event_count=2\n");
  for (const message of [direct, mention]) {
    s.child.stdout.write(
      JSON.stringify({ ...message, sender_open_dingtalk_id: "approval-bot" }) + "\n",
    );
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(s.runs.length, 0);
  assert.equal(s.store.records.size, 0);
});

test("unsubscribed group and OA events cannot enter the combined listener", () => {
  for (const type of ["user_im_message_receive_group_all", "user_oa_approval_task_created"]) {
    assert.throws(
      () => readMessageEvent(JSON.stringify({ ...event, type }), combined),
      /unexpected/,
    );
  }
});

test("combined consumer failure before all subscriptions are ready dispatches nothing", async (t) => {
  const s = await serviceFixture(t, {}, combined);
  s.child.stdout.write(JSON.stringify(direct) + "\n");
  s.child.stderr.write("[event] ready event_count=1\n");
  s.child.exitCode = 1;
  s.child.emit("exit");
  s.child.stderr.write("[event] ready event_count=2\n");
  assert.equal(s.runs.length, 0);
  assert.deepEqual(s.signals, ["SIGTERM"]);
  assert.ok(s.logs.some((m) => m.includes("no automatic restart")));
});
