import assert from "node:assert/strict";
import test from "node:test";
import { sendExact } from "../assistant-dws.mjs";
import { fixture } from "./assistant-fixture.mjs";

const draft = () => ({
  version: 2,
  text: "收到；$(literal)",
  reply: { direct: false },
  event: {
    conversation_id: "cid-group",
    message_id: "msg-original",
    sender_open_dingtalk_id: "D-sender",
  },
});
const config = { profile: "corp:A" };
function receipt(args) {
  const flag = (name) => args[args.indexOf(name) + 1];
  return {
    contractVersion: "im.message-reply.v1",
    result: { openTaskId: "task-1" },
    conversationId: flag("--conversation-id"),
    idempotencyKey: flag("--idempotency-key"),
    referencedMessage: {
      messageId: flag("--message-id"),
      senderOpenDingTalkId: flag("--ref-sender"),
    },
  };
}
test("group replies bind original message, sender and conversation through argv", async () => {
  let args;
  await sendExact(config, draft(), async (_, value) => {
    args = value;
    return receipt(value);
  });
  assert.equal(args[1], "+messages-reply");
  assert.equal(args[args.indexOf("--message-id") + 1], "msg-original");
  assert.equal(args[args.indexOf("--ref-sender") + 1], "D-sender");
  assert.equal(args[args.indexOf("--text") + 1], draft().text);
  assert.ok(args.includes("--yes"));
  assert.ok(!args.includes("+messages-send"));
});
test("reply idempotency stays stable for the same reviewed payload and changes with target or text", async () => {
  const keys = [];
  const runner = async (_, args) => {
    const value = receipt(args);
    keys.push(value.idempotencyKey);
    return value;
  };
  await sendExact(config, draft(), runner);
  await sendExact(config, draft(), runner);
  await sendExact(config, { ...draft(), text: "edited" }, runner);
  await sendExact(config, { ...draft(), event: { ...draft().event, message_id: "other" } }, runner);
  assert.equal(keys[0], keys[1]);
  assert.equal(new Set(keys).size, 3);
});
test("invalid group source never executes a normal send fallback", async () => {
  for (const field of ["conversation_id", "message_id", "sender_open_dingtalk_id"]) {
    let calls = 0;
    await assert.rejects(
      sendExact(config, { ...draft(), event: { ...draft().event, [field]: "" } }, async () => {
        calls++;
      }),
      (e) => e.noSend === true,
    );
    assert.equal(calls, 0);
  }
});
test("reply receipts reject mismatched context, dry runs and unacknowledged or failed writes", async () => {
  for (const mutate of [
    (r) => {
      r.conversationId = "other";
    },
    (r) => {
      r.referencedMessage.messageId = "other";
    },
    (r) => {
      r.referencedMessage.senderOpenDingTalkId = "other";
    },
    (r) => {
      r.idempotencyKey = "other";
    },
    (r) => {
      r.dryRun = true;
    },
    (r) => {
      r.dry_run = true;
    },
    (r) => {
      r.result = {};
    },
    (r) => {
      r.result.status = "FAILED";
    },
    (r) => {
      r.result.error = "failed";
    },
  ])
    await assert.rejects(
      sendExact(config, draft(), async (_, args) => {
        const r = receipt(args);
        mutate(r);
        return r;
      }),
    );
});
test("reply API errors are not retried using the ordinary message endpoint", async () => {
  const calls = [];
  await assert.rejects(
    sendExact(config, draft(), async (_, args) => {
      calls.push(args);
      throw Error("offline");
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "+messages-reply");
});
test("pre-send source validation failure keeps a reviewable draft instead of claiming an uncertain send", async (t) => {
  const f = await fixture(t, {
    send: async () => {
      throw Object.assign(Error("缺少原消息，未发送"), { noSend: true });
    },
  });
  const d = await f.incoming(f.event());
  await f.assistant.command("ok", { id: d.id, version: d.version });
  assert.equal(f.assistant.store.draft(d.id).status, "pending");
  assert.match(f.assistant.store.draft(d.id).error, /未发送/);
});
