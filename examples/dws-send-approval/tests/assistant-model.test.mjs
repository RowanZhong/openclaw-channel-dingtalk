import assert from "node:assert/strict";
import test from "node:test";
import { completionAgent, draftFailure, draftReply } from "../assistant-model.mjs";

test("implicit and sole owners omit unnecessary host agent override", () => {
  for (const agents of [undefined, { list: [{ id: "main" }] }, { entries: { main: {} } }])
    assert.deepEqual(completionAgent({ config: { agents } }, { agentId: "main" }), {});
  assert.deepEqual(completionAgent({ config: { agents: { list: [{ id: "employee" }] } } }, { agentId: "employee" }), {});
});
test("ambiguous, empty, different and system agent owners retain explicit selection", () => {
  for (const agents of [{ list: [] }, { list: [{ id: "other" }] },
    { entries: { main: {}, other: {} } },
    { defaults: { systemAgent: { agentId: "other" } } }])
    assert.deepEqual(completionAgent({ config: { agents } }, { agentId: "main" }), { agentId: "main" });
});
test("default-owner completion succeeds with actual host override restriction", async () => {
  const result = await draftReply({ config: {}, runtime: { llm: { complete: async q => {
    assert.equal(q.agentId, undefined);
    assert.equal(q.tools, undefined);
    assert.equal(q.execution, undefined);
    return { text: "收到。" };
  } } } }, { agentId: "main" }, { reply: { text: "简短" }, event: { content: "测试" } });
  assert.equal(result, "收到。");
});
test("authorization denial never retries another agent or execution mode", async () => {
  let calls = 0;
  await assert.rejects(draftReply({ config: { agents: { list: [{ id: "other" }] } }, runtime: { llm: { complete: async q => {
    calls++; assert.equal(q.agentId, "main");
    throw Object.assign(new Error("denied"), { code: "LLM_COMPLETION_NOT_AUTHORIZED" });
  } } } }, { agentId: "main" }, { reply: { text: "简短" }, event: { content: "测试" } }), /denied/);
  assert.equal(calls, 1);
});
test("failure diagnostics do not expose arbitrary provider messages or error codes", () => {
  assert.equal(draftFailure(new Error("Plugin LLM completion cannot override the target agent.")).code, "LLM_COMPLETION_NOT_AUTHORIZED");
  const result = draftFailure({ code: "secret-token", message: "secret response" });
  assert.equal(result.code, "DRAFT_FAILED");
  assert.ok(!JSON.stringify(result).includes("secret"));
});
