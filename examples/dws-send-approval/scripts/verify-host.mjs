// Runs against a real unpacked/installed host; uses its hook runner and approval
// broker with an inert exec tool. No Gateway, DWS process or IM message is started.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerControlCommands } from "../commands.mjs";
import { assertHostVersion, LISTENER_LANE } from "../config.mjs";
import { readConfig } from "../config.mjs";
import { buildRunRequest } from "../ingress.mjs";
import { createListenerService } from "../listener.mjs";
import { createPolicy } from "../policy.mjs";
import { SourceStore } from "../source-store.mjs";
import { config, host, event } from "../tests/fixtures.mjs";
const packageDir = resolve(process.argv[2]);
const version = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version;
assertHostVersion(version);
const dist = join(packageDir, "dist");
const files = await readdir(dist);
async function load(prefix, symbol) {
  for (const name of files.filter((s) => s.startsWith(prefix) && s.endsWith(".js"))) {
    const source = await readFile(join(dist, name), "utf8");
    const exports = source.slice(source.lastIndexOf("export {"));
    const alias = new RegExp("(?:[ {,])" + symbol + " as ([\\w$]+)(?:[, }])").exec(exports)?.[1];
    if (alias) {
      return (await import(pathToFileURL(join(dist, name))))[alias];
    }
  }
  throw new Error(`Cannot locate actual host export ${symbol}`);
}
const initialize = await load("hook-runner-global-", "initializeGlobalHookRunner");
const reset = await load("hook-runner-global-", "resetGlobalHookRunner");
const wrap = await load("agent-tools.before-tool-call-", "wrapToolWithBeforeToolCallHook");
const Broker = await load("agent-tools.before-tool-call-", "EmbeddedPluginApprovalBroker");
const setBroker = await load("agent-tools.before-tool-call-", "setEmbeddedPluginApprovalBroker");
const setEmbedded = await load("agent-tools.before-tool-call-", "setEmbeddedMode");
const authorize = await load("command-auth-", "resolveCommandAuthorization");
const enqueue = await load("command-queue-", "enqueueCommandInLane");
const setConcurrency = await load("command-queue-", "setCommandLaneConcurrency");
const laneSnapshot = await load("command-queue-", "getCommandLaneSnapshot");
const resolveLane = await load("lanes-", "resolveGlobalLane");
const registerCommand = await load("command-registration-", "registerPluginCommand");
const matchCommand = await load("commands-", "matchPluginCommand");
const executeCommand = await load("commands-", "executePluginCommand");
const folder = await mkdtemp(join(tmpdir(), "dws-host-compat-"));
const broker = new Broker();
let executions = 0,
  lastParams;
try {
  const store = new SourceStore(config);
  await store.load(folder);
  const record = await store.claim(event);
  const ctx = {
    agentId: "main",
    sessionKey: record.sessionKey,
    runId: "test-run",
    config: host,
    workspaceDir: folder,
  };
  const policy = createPolicy(config, store);
  initialize({
    plugins: [{ id: "dws-send-approval", status: "loaded" }],
    hooks: [],
    typedHooks: [
      {
        pluginId: "dws-send-approval",
        hookName: "before_tool_call",
        priority: 1000,
        handler: policy,
      },
    ],
  });
  setEmbedded(true);
  setBroker(broker);
  const tool = wrap(
    {
      name: "exec",
      execute: async (_id, params) => {
        executions++;
        lastParams = params;
        return { content: [{ type: "text", text: "inert execution" }] };
      },
    },
    ctx,
    { emitDiagnostics: false },
  );
  const params = { command: "dws chat +messages-send --user open-b --text hello" };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  async function pendingCall(id, dispatch = (execute) => execute()) {
    const promise = dispatch(() => tool.execute(id, structuredClone(params)));
    // Both thrown blocked errors and blocked tool results are valid host contracts.
    const settled = promise.catch((error) => ({ blockedError: error.message }));
    for (let i = 0; i < 200 && !broker.listPending().length; i++) {
      await tick();
    }
    assert.equal(broker.listPending().length, 1, "host did not enter approval");
    return { settled, approval: broker.listPending()[0] };
  }
  const first = await pendingCall("allow-call");
  assert.equal(executions, 0, "exec ran before approval");
  assert.deepEqual(first.approval.request.allowedDecisions, ["allow-once", "deny"]);
  assert.equal(broker.resolve(first.approval.id, "allow-always"), false);
  assert.equal(broker.resolve(first.approval.id, "allow-once"), true);
  await first.settled;
  assert.equal(executions, 1);
  assert.match(lastParams.command, /'\/opt\/bin\/dws' '--profile' 'work'/);
  assert.equal(broker.resolve(first.approval.id, "allow-once"), false, "approval reused");
  const second = await pendingCall("deny-call");
  broker.resolve(second.approval.id, "deny");
  await second.settled;
  assert.equal(executions, 1, "denied call executed");
  // Fast host timeout substitute: shorten only the test broker's request timer.
  const originalRequest = broker.request.bind(broker);
  broker.request = (p) => originalRequest({ ...p, timeoutMs: 30 });
  const timeoutKeepAlive = setTimeout(() => {}, 1000);
  try {
    await tool.execute("timeout-call", structuredClone(params));
  } catch {
    /* fail closed */
  }
  clearTimeout(timeoutKeepAlive);
  broker.request = originalRequest;
  assert.equal(executions, 1, "expired call executed");
  const ordinary = wrap(
    {
      name: "exec",
      execute: async () => {
        executions++;
        return { content: [] };
      },
    },
    { ...ctx, sessionKey: "agent:main:main" },
    { emitDiagnostics: false },
  );
  await ordinary.execute("ordinary-call", params);
  assert.equal(executions, 2);
  // Actual host scheduler + actual approval broker, with inert tool execution.
  // Main has only one slot: this would hang until approval without the lane fix.
  setConcurrency("main", 1);
  const request = buildRunRequest(event, record, config);
  const listenerLane = resolveLane(request.lane);
  assert.equal(listenerLane, LISTENER_LANE);
  assert.notEqual(listenerLane, resolveLane(undefined));
  const held = await pendingCall("held-listener", (execute) => enqueue(listenerLane, execute));
  assert.equal(laneSnapshot(listenerLane).activeCount, 1);
  assert.equal(laneSnapshot(listenerLane).maxConcurrent, 1);
  let nextListenerStarted = false;
  const nextListener = enqueue(listenerLane, async () => {
    nextListenerStarted = true;
  });
  let timer;
  try {
    const mainResult = await Promise.race([
      enqueue("main", async () => "main-finished"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("main blocked by listener approval")), 1000);
      }),
    ]);
    assert.equal(mainResult, "main-finished");
    assert.equal(broker.listPending().length, 1, "approval was not still pending");
    assert.equal(nextListenerStarted, false, "listener lane is not serial");
    assert.equal(executions, 2, "listener tool ran without approval");
    broker.resolve(held.approval.id, "deny");
    await held.settled;
    await nextListener;
    assert.equal(nextListenerStarted, true);
    assert.equal(executions, 2);
  } finally {
    clearTimeout(timer);
  }
  for (const [senderId, allowed] of [
    ["owner", true],
    ["B", false],
  ]) {
    const auth = authorize({
      cfg: host,
      commandAuthorized: true,
      ctx: {
        Provider: "dingtalk",
        Surface: "dingtalk",
        SenderId: senderId,
        From: `dingtalk:${senderId}`,
        ChatType: "direct",
      },
    });
    assert.equal(auth.isAuthorizedSender, allowed, `DingTalk auth ${senderId}`);
  }
  const web = {
    Provider: "webchat",
    Surface: "webchat",
    SenderId: "web-owner",
    From: "webchat:web-owner",
    ChatType: "direct",
    GatewayClientScopes: ["operator.admin", "operator.approvals"],
  };
  const before = authorize({ cfg: {}, commandAuthorized: true, ctx: web });
  const after = authorize({ cfg: host, commandAuthorized: true, ctx: web });
  assert.equal(
    after.isAuthorizedSender,
    before.isAuthorizedSender,
    "DingTalk rule changed Web command access",
  );
  // Exercise actual host registration/matching/authorization/context forwarding.
  // Remain opted out throughout: no DWS or model call can be made by this test.
  const personal = readConfig({ ...config, listener: { ignoreSenderOpenIds: ["bot"] } });
  const personalSources = new SourceStore(personal);
  const personalApi = {
    runtime: {
      subagent: {
        run: () => {
          throw new Error("unexpected model run");
        },
      },
    },
    registerCommand: (definition) =>
      assert.equal(registerCommand("dws-send-approval-test", definition).ok, true),
  };
  const service = createListenerService(personalApi, personal, personalSources, {
    spawn: () => {
      throw new Error("unexpected DWS spawn");
    },
  });
  await service.start({ config: host, stateDir: folder, logger: { info() {}, error() {} } });
  try {
    registerControlCommands(personalApi, personal, service);
    const invoke = (body, overrides = {}) => {
      const matched = matchCommand(body, { channel: "dingtalk" });
      assert.ok(matched, `host did not match ${body}`);
      return executeCommand({
        command: matched.command,
        args: matched.args,
        commandBody: body,
        config: host,
        channel: "dingtalk",
        channelId: "dingtalk",
        accountId: "default",
        senderId: "owner",
        from: "owner",
        to: "owner",
        isAuthorizedSender: true,
        agentId: "main",
        sessionKey: "agent:main:main",
        ...overrides,
      });
    };
    await invoke("/dws-listen at groups G1,G2");
    await invoke("/dws-listen dm all");
    assert.equal(service.snapshot().enabled, false);
    await invoke("/dws-listen sender users attacker", {
      senderId: "B",
      from: "B",
      to: "B",
      isAuthorizedSender: false,
    });
    await invoke("/dws-listen sender users attacker", { from: "group-1", to: "group-1" });
    assert.equal(service.snapshot().rules.sender.mode, "off");
    await invoke("/dws-reply group G1 fixed safe-reply");
    assert.match((await invoke("/dws-reply preview group G1 sample")).text, /safe-reply/);
    assert.match((await invoke("/dws-listen status")).text, /已关闭/);
  } finally {
    await service.stop();
  }
  process.stdout.write(
    JSON.stringify({
      version,
      result: "passed",
      checks: [
        "pause-before-exec",
        "allow-once",
        "no-allow-always",
        "no-replay",
        "deny",
        "timeout",
        "ordinary-session",
        "owner-vs-B-command-auth",
        "web-auth-unchanged",
        "pending-listener-approval-does-not-block-main-at-concurrency-1",
        "listener-lane-concurrency-1",
        "owner-private-custom-command-dispatch",
        "custom-command-rejects-B-and-group",
        "default-off-preferences-and-fixed-preview",
      ],
    }) + "\n",
  );
} finally {
  broker.stop();
  setBroker(null);
  setEmbedded(false);
  reset();
  await rm(folder, { recursive: true, force: true });
}
