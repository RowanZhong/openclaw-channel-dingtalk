import assert from "node:assert/strict";
import test from "node:test";
import { completionAgent, draftFailure, draftReply } from "../assistant-model.mjs";
let modern = false;
try {
  modern = Boolean(await import("openclaw/plugin-sdk/agent-scope-runtime"));
} catch {}
const api = (agents, extra = {}) => ({ config: { agents }, ...extra });
const choose = (agents, agentId = "main") => completionAgent(api(agents), { agentId });
const fleet = ["main", "mail", "come", "bpm", "code"].map((id) => ({
  id,
  ...(id === "main" ? { default: true } : {}),
}));
const draft = { reply: { text: "简短" }, event: { content: "测试" } };

test("company five-agent fleet uses marked main without an override", async () => {
  assert.deepEqual(await choose({ list: fleet }), {});
});
test("marked default need not be first or named main", async () => {
  assert.deepEqual(
    await choose({ list: [{ id: "helper" }, { id: "employee", default: true }] }, "employee"),
    {},
  );
});
test("implicit and sole targets omit unnecessary override", async () => {
  for (const agents of [undefined, { list: [{ id: "main" }] }])
    assert.deepEqual(await choose(agents), {});
  assert.deepEqual(await choose({ list: [{ id: "employee" }] }, "employee"), {});
});
test("empty roster follows the host's actual empty-agent semantics", async () => {
  if (modern)
    await assert.rejects(choose({ list: [] }), { code: "LLM_DRAFT_AGENT_NOT_CONFIGURED" });
  else assert.deepEqual(await choose({ list: [] }), {});
});
test("unmarked fleet follows the host first-entry or explicit-owner policy", async () => {
  assert.deepEqual(
    await choose({ list: [{ id: "main" }, { id: "other" }] }),
    modern ? { agentId: "main" } : {},
  );
});
test("multiple default markers do not silently override modern ambiguity", async () => {
  assert.deepEqual(
    await choose({
      list: [
        { id: "main", default: true },
        { id: "other", default: true },
      ],
    }),
    modern ? { agentId: "main" } : {},
  );
});
test("known non-default target retains host authorization", async () => {
  assert.deepEqual(await choose({ list: fleet }, "mail"), { agentId: "mail" });
});
test("missing target is rejected before a model request", async () => {
  await assert.rejects(choose({ list: fleet }, "missing"), {
    code: "LLM_DRAFT_AGENT_NOT_CONFIGURED",
  });
});
test("agent ID comparison uses the host normalization", async () => {
  assert.deepEqual(
    await choose({ list: [{ id: "Main", default: true }, { id: "other" }] }, "MAIN"),
    {},
  );
});
test("systemAgent precedence matches each actual host", async () => {
  const agents = { list: fleet, defaults: { systemAgent: { agentId: "mail" } } };
  assert.deepEqual(await choose(agents, "main"), modern ? { agentId: "main" } : {});
  assert.deepEqual(await choose(agents, "mail"), modern ? {} : { agentId: "mail" });
});
test("keyed entries and explicit ownership use modern host semantics", async () => {
  if (!modern) return;
  assert.deepEqual(await choose({ entries: { main: { default: true }, mail: {} } }), {});
  assert.deepEqual(
    await choose({ entries: { main: { default: true }, mail: {} }, ownership: "explicit" }),
    { agentId: "main" },
  );
  assert.deepEqual(
    await choose({
      entries: { main: {}, mail: {} },
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
    }),
    {},
  );
});
test("current runtime config supersedes registration snapshot", async () => {
  const active = api(
    { list: [{ id: "stale" }] },
    { runtime: { config: { current: () => ({ agents: { list: fleet } }) } } },
  );
  assert.deepEqual(await completionAgent(active, { agentId: "main" }), {});
  active.runtime.config.current = () => ({ agents: { list: [{ id: "mail" }] } });
  await assert.rejects(completionAgent(active, { agentId: "main" }), {
    code: "LLM_DRAFT_AGENT_NOT_CONFIGURED",
  });
});
test("missing or unexpanded config never silently becomes main", async () => {
  await assert.rejects(completionAgent({}, { agentId: "main" }), {
    code: "LLM_DRAFT_CONFIG_UNAVAILABLE",
  });
  await assert.rejects(choose({ list: { $include: "/not-read" } }), {
    code: "LLM_DRAFT_CONFIG_UNAVAILABLE",
  });
  await assert.rejects(
    completionAgent(api(undefined, { runtime: { config: { current: () => undefined } } }), {
      agentId: "main",
    }),
    { code: "LLM_DRAFT_CONFIG_UNAVAILABLE" },
  );
});
test("drafting omits target/model overrides and all agent execution features", async () => {
  const result = await draftReply(
    api(
      { list: fleet },
      {
        runtime: {
          llm: {
            complete: async (q) => {
              assert.equal(q.agentId, undefined);
              assert.equal(q.model, undefined);
              assert.equal(q.tools, undefined);
              assert.equal(q.execution, undefined);
              return { text: "收到。" };
            },
          },
        },
      },
    ),
    { agentId: "main" },
    draft,
  );
  assert.equal(result, "收到。");
});
test("authorization denial never retries another agent or execution mode", async () => {
  let calls = 0;
  await assert.rejects(
    draftReply(
      api(
        { list: fleet },
        {
          runtime: {
            llm: {
              complete: async (q) => {
                calls++;
                assert.equal(q.agentId, "mail");
                throw Object.assign(new Error("denied"), { code: "LLM_COMPLETION_NOT_AUTHORIZED" });
              },
            },
          },
        },
      ),
      { agentId: "mail" },
      draft,
    ),
    /denied/,
  );
  assert.equal(calls, 1);
});
test("diagnostics are useful without exposing provider messages or secrets", () => {
  assert.equal(
    draftFailure(new Error("Plugin LLM completion cannot override the target agent.")).code,
    "LLM_COMPLETION_NOT_AUTHORIZED",
  );
  assert.match(draftFailure({ code: "LLM_DRAFT_AGENT_NOT_CONFIGURED" }).message, /不在当前实例/);
  assert.match(draftFailure({ code: "LLM_DRAFT_CONFIG_UNAVAILABLE" }).message, /配置加载/);
  const result = draftFailure({ code: "secret-token", message: "secret response" });
  assert.equal(result.code, "DRAFT_FAILED");
  assert.ok(!JSON.stringify(result).includes("secret"));
});
