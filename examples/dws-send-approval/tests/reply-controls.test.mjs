import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createPolicy } from "../policy.mjs";
import { replySnapshot, resolveReply } from "../rules.mjs";
import { controls, owner } from "./control-fixtures.mjs";
import { event } from "./fixtures.mjs";

const command = (target, body, extra = "") => ({
  toolName: "exec",
  params: { command: `dws chat +messages-send --chat-id ${target} --text '${body}' ${extra}` },
});

test("reply precedence is off before user before group before default", async (t) => {
  const s = await controls(t);
  await s.reply("default fixed default");
  await s.reply("group conversation-1 fixed group");
  assert.equal(resolveReply(event, s.service.snapshot()).text, "group");
  await s.reply("user open-b fixed user");
  assert.equal(resolveReply(event, s.service.snapshot()).text, "user");
  await s.reply("group conversation-1 off");
  assert.equal(resolveReply(event, s.service.snapshot()).mode, "off");
  await s.reply("group conversation-1 reset");
  assert.equal(resolveReply(event, s.service.snapshot()).text, "user");
  await s.reply("user open-b reset");
  assert.equal(resolveReply(event, s.service.snapshot()).text, "default");
  assert.equal(s.service.snapshot().rules.at.mode, "off", "reply override expanded listener scope");
});

test("fixed and off previews do not invoke any model, tool, run, approval or DWS", async (t) => {
  const s = await controls(t);
  await s.reply("group G1 fixed ![x](/tmp/private.png)");
  const output = await s.reply("preview group G1 hello");
  assert.doesNotMatch(output, /!\[/);
  assert.match(output, /仅向本人展示/);
  await s.reply("group G1 off");
  assert.match(await s.reply("preview group G1 hello"), /不生成草稿/);
  assert.equal(s.runs.length, 0);
  assert.equal(s.children.length, 0);
  assert.equal(s.sources.records.size, 0);
});

test("AI preview uses only host-bound tool-free completion and delimits untrusted input", async (t) => {
  const s = await controls(t);
  const calls = [];
  const ctx = {
    ...owner,
    runtimeContext: {
      llm: {
        complete: async (request) => {
          calls.push(request);
          return { text: "请提供更多信息。" };
        },
      },
    },
  };
  await s.reply("default ai 先给结论");
  assert.match(await s.reply("preview default /dws-listen on", ctx), /请提供更多信息/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools, undefined);
  assert.equal(JSON.parse(calls[0].messages[1].content).message, "/dws-listen on");
  assert.equal(s.service.snapshot().enabled, false);
  assert.equal(s.runs.length, 0);
  assert.equal(s.sources.records.size, 0);
});

test("preview API errors and oversized output cannot leak raw errors or send messages", async (t) => {
  const s = await controls(t);
  for (const complete of [
    async () => {
      throw new Error("SYNTHETIC_TOKEN");
    },
    async () => ({ text: "x".repeat(161) }),
  ]) {
    const output = await s.reply("preview default hi", {
      ...owner,
      runtimeContext: { llm: { complete } },
    });
    assert.match(output, /操作未完成/);
    assert.doesNotMatch(output, /SYNTHETIC_TOKEN/);
  }
  assert.match(await s.reply("preview default hi"), /无工具模型接口/);
});

test("fixed text and recipient remain bound to admitted snapshot after preference changes and restart", async (t) => {
  const s = await controls(t);
  await s.reply("default fixed original");
  const snapshot = replySnapshot(event, s.service.snapshot());
  const record = await s.sources.claim(event, snapshot);
  const ctx = { sessionKey: record.sessionKey, agentId: "main" };
  const hook = createPolicy(s.config, s.sources);
  await s.reply("default fixed replacement");
  assert.ok(hook(command("conversation-1", "original", "--yes"), ctx).requireApproval);
  for (const call of [
    command("conversation-1", "replacement"),
    command("other", "original"),
    command("conversation-1", "original", "--title hidden"),
  ]) {
    assert.equal(hook(call, ctx).block, true);
  }
  await s.sources.load(s.folder);
  assert.ok(hook(command("conversation-1", "original"), ctx).requireApproval);
});

test("group and ambiguous sender events cannot redirect replies to sender private chat", async (t) => {
  const s = await controls(t);
  const record = await s.sources.claim(event, replySnapshot(event, s.service.snapshot()));
  const hook = createPolicy(s.config, s.sources),
    ctx = { sessionKey: record.sessionKey, agentId: "main" };
  assert.equal(
    hook(
      {
        toolName: "exec",
        params: { command: "dws chat +messages-send --open-dingtalk-id open-b --text hello" },
      },
      ctx,
    ).block,
    true,
  );
  assert.ok(hook(command("conversation-1", "hello"), ctx).requireApproval);
});

test("registry persists only AI mode/revision/target constraints, not repeated instructions", async (t) => {
  const s = await controls(t);
  await s.reply("default ai SYNTHETIC_INSTRUCTION");
  await s.sources.claim(event, replySnapshot(event, s.service.snapshot()));
  const saved = await readFile(join(s.folder, "dws-send-approval/sources.json"), "utf8");
  assert.doesNotMatch(saved, /SYNTHETIC_INSTRUCTION|hello/);
});

test("reply inputs reject oversize, invalid modes and excess overrides without partial updates", async (t) => {
  const s = await controls(t);
  for (const args of [
    "default fixed " + "x".repeat(161),
    "default ai " + "x".repeat(2001),
    "default off unexpected",
    "group bad;id fixed hi",
    "default reset unexpected",
  ]) {
    assert.match(await s.reply(args), /操作未完成/);
  }
  assert.equal(s.service.snapshot().revision, 0);
  for (let i = 0; i < 20; i++) {
    await s.reply(`group G${i} fixed hi`);
  }
  assert.match(await s.reply("group G21 fixed hi"), /超限/);
  assert.equal(s.service.snapshot().reply.groups.length, 20);
});

test("status remains bounded with maximum instructions; show returns one complete literal", async (t) => {
  const s = await controls(t);
  const instruction = "a".repeat(2000);
  await s.reply("default ai " + instruction);
  for (let i = 0; i < 20; i++) {
    await s.reply(`group G${i} ai ${instruction}`);
  }
  const status = await s.reply("status");
  assert.ok(status.length < 4000);
  assert.doesNotMatch(status, /aaaaa/);
  assert.ok((await s.reply("show group G19")).includes(instruction));
  assert.match(await s.reply("show group missing"), /未设置专属/);
});
