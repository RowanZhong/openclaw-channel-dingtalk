// Real installed host completion pipeline, isolated state and localhost model fixture.
// No employee credentials, DWS calls or external model requests.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { draftReply } from "../assistant-model.mjs";
import { classifyTopic } from "../assistant-topic-model.mjs";
const host = resolve(process.argv[2]);
const version = JSON.parse(await readFile(join(host, "package.json"), "utf8")).version;
const dir = await mkdtemp(join(tmpdir(), "dws-model-host-"));
process.env.OPENCLAW_STATE_DIR = dir;
process.env.OPENCLAW_CONFIG_PATH = join(dir, "absent.json");
const requests = [],
  results = [],
  checks = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const input = JSON.parse(body);
  requests.push(input);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const classification = input.messages.some((m) => typeof m.content === "string" && m.content.includes('"ownerRules"'));
  const responseText = classification ? JSON.stringify({ outcome: "match", ruleIds: ["pdf"], coversWholeMessage: true, reason: "matched" }) : "测试已收到。";
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model };
  res.write(
    `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] })}\n\n`,
  );
  res.end(
    `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`,
  );
});
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const file = (await readdir(join(host, "dist"))).find(
    (n) => n.startsWith("runtime-llm.runtime-") && n.endsWith(".js"),
  );
  const { createRuntimeLlm } = await import(pathToFileURL(join(host, "dist", file)));
  const modern = version.startsWith("2026.8.");
  const names = ["main", "mail", "come", "bpm", "code"];
  const agents = names.map((id) => ({
    id,
    default: id === "main",
    model: { primary: `dws-fixture/${id}-model` },
    subagents: { allowAgents: names },
  }));
  let cfg;
  const configure = (roster) => ({
    agents: { defaults: { workspace: join(dir, "workspace") }, list: roster },
    models: {
      providers: {
        "dws-fixture": {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: "openai-completions",
          apiKey: "synthetic-local-only",
          models: names.map((id) => ({
            id: `${id}-model`,
            name: id,
            reasoning: false,
            input: ["text"],
            contextWindow: 32000,
            maxTokens: 400,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      },
    },
    plugins: { entries: { "dws-send-approval": { enabled: true } } },
  });
  cfg = configure(agents);
  const runtime = createRuntimeLlm({
    getConfig: () => cfg,
    authority: { caller: { kind: "plugin", id: "dws-send-approval" }, allowComplete: true },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const api = {
    config: cfg,
    runtime: {
      config: { current: () => cfg },
      llm: {
        complete: async (q) => {
          const result = await runtime.complete(q);
          results.push(result);
          return result;
        },
      },
    },
  };
  const draft = { reply: { text: "简短确认收到" }, event: { content: "真实宿主的本地模拟来信" } };
  async function run(name, target) {
    assert.equal(await draftReply(api, { agentId: target }, draft), "测试已收到。");
    assert.equal(results.at(-1).agentId, target);
    assert.equal(requests.at(-1).model, `${target}-model`);
    assert.equal(requests.at(-1).tools, undefined);
    assert.equal(requests.at(-1).messages.length, 2);
    checks.push(name);
  }
  await run("company-five-agents-default-main", "main");
  const topic = { id: "pdf", name: "导出PDF", description: "询问文档导出PDF的使用步骤", examples: "", exclusions: "故障和代执行", action: "auto", text: "固定操作说明" };
  assert.equal((await classifyTopic(api, { agentId: "main" }, "在哪里转PDF？", [topic])).outcome, "match");
  assert.equal(requests.at(-1).tools, undefined);
  checks.push("topic-classification-default-main-no-tools");
  // A reload must use the current config and default marker, not first position/main.
  cfg = configure(agents.map((a) => ({ ...a, default: a.id === "come" })));
  await run("reload-default-not-first-or-main", "come");
  const before = requests.length;
  await assert.rejects(draftReply(api, { agentId: "mail" }, draft), /cannot override .*agent/);
  assert.equal(requests.length, before);
  checks.push("non-default-denied-before-model-no-retry");
  if (modern) {
    cfg.agents.defaults.systemAgent = { agentId: "code" };
    await run("system-agent-matches-host", "code");
    delete cfg.agents.list;
    cfg.agents.entries = Object.fromEntries(agents.map(({ id, ...rest }) => [id, rest]));
    await run("keyed-agent-roster", "code");
  } else {
    cfg = configure(agents.map((a) => ({ ...a, default: false })));
    await run("legacy-first-agent-fallback", "main");
  }
  process.stdout.write(
    JSON.stringify({
      version,
      result: "passed",
      checks,
      modelCalls: requests.length,
      toolCalls: 0,
      externalRequests: 0,
    }) + "\n",
  );
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
