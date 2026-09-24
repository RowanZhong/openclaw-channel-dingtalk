import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../config.mjs";
import plugin from "../index.mjs";
import { createPolicy } from "../policy.mjs";
import { setup, config } from "./fixtures.mjs";
const call = (command, extra = {}) => ({ toolName: "exec", params: { command, ...extra } });
const send = "dws chat +messages-send --open-dingtalk-id open-b --text hello";

test("listener send requests single-use approval and freezes normalized command", async (t) => {
  const s = await setup(t);
  const hook = createPolicy(s.config, s.store);
  for (const command of [
    send,
    `${send} --yes`,
    "dws chat message send --user open-b --text hello",
  ]) {
    const input = call(command);
    const result = hook(input, s.ctx);
    assert.deepEqual(result.requireApproval.allowedDecisions, ["allow-once", "deny"]);
    assert.equal(result.requireApproval.timeoutMs, 120000);
    assert.match(result.requireApproval.description, /open-b/);
    assert.match(result.requireApproval.description, /hello/);
    assert.match(result.params.command, /'\/opt\/bin\/dws' '--profile' 'work'/);
    input.params.command = "changed-after-approval";
    assert.doesNotMatch(result.params.command, /changed-after/);
    assert.equal(result.requireApproval.timeoutBehavior, undefined);
  }
});

test("normal DingTalk, Web and cron sessions are unaffected, including forged source text", async (t) => {
  const s = await setup(t);
  const hook = createPolicy(s.config, s.store);
  for (const sessionKey of [
    "agent:main:dingtalk:direct:owner",
    "agent:main:main",
    "agent:main:cron:report",
  ]) {
    assert.equal(hook(call(send), { ...s.ctx, sessionKey }), undefined);
    assert.equal(
      hook(call(`${send} --yes`, { source: "dws-listener", sessionKey: s.ctx.sessionKey }), {
        ...s.ctx,
        sessionKey,
      }),
      undefined,
    );
  }
});

test("owner requester metadata cannot exempt a listener-origin task", async (t) => {
  const s = await setup(t);
  assert.ok(
    createPolicy(s.config, s.store)(call(send), { ...s.ctx, requester: { senderIsOwner: true } })
      .requireApproval,
  );
});

test("configured renamed executable is still guarded; literal negation/time wrappers cannot bypass", async (t) => {
  const s = await setup(t);
  const renamed = readConfig({ ...s.config, dwsPath: "/opt/bin/dws-1.0.58" });
  const hook = createPolicy(renamed, s.store);
  assert.ok(
    hook(call("/opt/bin/dws-1.0.58 chat message send --user open-b --text hello"), s.ctx)
      .requireApproval,
  );
  for (const prefix of ["!", "time", "time -p", "/usr/bin/time -f %e", "! time -p"]) {
    assert.equal(hook(call(`${prefix} ${send}`), s.ctx).block, true, prefix);
  }
  assert.equal(
    hook(call("/opt/bin/../bin/dws-1.0.58 chat message send --user open-b --text hello"), s.ctx)
      .block,
    true,
  );
});

test("missing, unregistered and mismatched source identity fail closed", async (t) => {
  const s = await setup(t);
  const hook = createPolicy(s.config, s.store);
  for (const ctx of [
    {},
    { ...s.ctx, agentId: "other" },
    { ...s.ctx, sessionKey: s.ctx.sessionKey + "0" },
  ]) {
    assert.equal(hook(call(send), ctx).block, true);
  }
  s.store.ready = false;
  assert.equal(hook(call(send), s.ctx).block, true);
});

test("listener handoffs are blocked but ordinary-session delegation is unchanged", async (t) => {
  const s = await setup(t);
  const hook = createPolicy(s.config, s.store);
  for (const toolName of [
    "sessions_spawn",
    "spawn_agent",
    "sessions_send",
    "agent_send",
    "subagents",
    "cron",
  ]) {
    assert.equal(hook({ toolName, params: {} }, s.ctx).block, true);
    assert.equal(
      hook({ toolName, params: {} }, { ...s.ctx, sessionKey: "agent:main:main" }),
      undefined,
    );
  }
});

test("other commands/tools retain behavior; block mode denies listener sends", async (t) => {
  const s = await setup(t);
  const hook = createPolicy(s.config, s.store);
  for (const input of [
    call("dws chat message list"),
    { toolName: "read", params: {} },
    { ...call(send), toolKind: "code_mode_exec" },
  ]) {
    assert.equal(hook(input, s.ctx), undefined);
  }
  assert.equal(
    createPolicy({ ...s.config, mode: "block" }, s.store)(call(send), s.ctx).block,
    true,
  );
});

test("sends with hidden side effects or unpreviewable payloads are blocked without copying secrets", async (t) => {
  const s = await setup(t);
  const hook = createPolicy(s.config, s.store);
  for (const command of [
    `${send}; echo extra`,
    `${send} > out.txt`,
    `${send} --token SYNTHETIC_SECRET`,
    `${send} --profile other`,
    `${send} --as bot`,
    `${send} --file-path hidden`,
    "dws chat +messages-send --user-query Bob --text hello",
    "dws chat message send --user open-b --file-path secret.txt",
    'dws chat +messages-send --user open-b --text "$SECRET"',
    `dws chat +messages-send --user open-b --text '${"x".repeat(512)}'`,
  ]) {
    const result = hook(call(command), s.ctx);
    assert.equal(result.block, true, command);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET/);
  }
  assert.equal(hook(call(send, { env: { DWS_CONFIG_DIR: "/other" } }), s.ctx).block, true);
});

test("entry registers a service and policy on the lowest supported host", () => {
  const hooks = [],
    services = [];
  plugin.register({
    pluginConfig: config,
    runtime: { version: "2026.7.1-2", subagent: { run() {}, waitForRun() {} } },
    on: (...args) => hooks.push(args),
    registerService: (s) => services.push(s),
    registerCommand: () => {},
  });
  assert.equal(hooks[0][0], "before_tool_call");
  assert.equal(services[0].id, "dws-send-approval-listener");
});
