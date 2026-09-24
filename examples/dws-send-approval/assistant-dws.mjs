import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { safeText } from "./assistant-settings.mjs";
import { stableId } from "./preferences.mjs";

export function runDws(config, args, { spawnChild = spawn, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(config.dwsPath, ["--profile", config.profile, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    let output = "",
      bytes = 0,
      finished = false;
    const finish = (error, value) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("DWS调用超时；发送结果需核实。"));
    }, timeoutMs);
    const read = (chunk, keep) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) {
        child.kill("SIGTERM");
        finish(new Error("DWS输出超限。"));
      } else if (keep) {
        output += chunk.toString("utf8");
      }
    };
    child.stdout.on("data", (c) => read(c, true));
    child.stderr.on("data", (c) => read(c, false));
    child.on("error", () => finish(new Error("DWS启动失败。")));
    child.on("close", (code) => {
      if (code !== 0) {
        return finish(new Error("DWS未确认成功，请检查授权和发送记录。"));
      }
      try {
        finish(null, JSON.parse(output));
      } catch {
        finish(new Error("DWS未返回可确认的JSON结果。"));
      }
    });
  });
}
export async function sendExact(config, draft, runner = runDws) {
  if (!stableId(draft.event.conversation_id)) {
    throw Object.assign(new Error("来源会话ID无效，未发送。"), { noSend: true });
  }
  const text = safeText(draft.text);
  const quoted = draft.reply?.direct !== true;
  const event = draft.event;
  if (quoted && (!stableId(event.message_id) || !stableId(event.sender_open_dingtalk_id))) {
    throw Object.assign(new Error("缺少原消息或发送者，无法引用回复；草稿已保留。"), {
      noSend: true,
    });
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        config.profile,
        event.conversation_id,
        event.message_id,
        draft.version,
        text,
      ]),
    )
    .digest("hex");
  const key = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  const args = quoted
    ? [
        "chat",
        "+messages-reply",
        "--conversation-id",
        event.conversation_id,
        "--message-id",
        event.message_id,
        "--ref-sender",
        event.sender_open_dingtalk_id,
        "--idempotency-key",
        key,
        "--text",
        text,
        "--yes",
        "--format",
        "json",
      ]
    : [
        "chat",
        "+messages-send",
        "--as",
        "user",
        "--chat-id",
        draft.event.conversation_id,
        "--text",
        text,
        "--title",
        "消息",
        "--yes",
        "--format",
        "json",
      ];
  const result = await runner(config, args);
  const payload =
    result?.outcome === "success" && result.ok === true && !result.dry_run ? result.data : result;
  if (quoted) {
    // DWS 1.0.58 reply returns raw MCP data plus im.message-reply.v1 context,
    // unlike +messages-send's normalized {ok,identity,tool} envelope.
    const receipt = payload?.result ?? payload?.data ?? payload;
    const acknowledged = [receipt?.openTaskId, receipt?.openMessageId, payload?.messageId].some(
      (id) => typeof id === "string" && id.length > 0,
    );
    if (
      result?.dry_run ||
      payload?.dryRun ||
      payload?.error ||
      receipt?.error ||
      payload?.ok === false ||
      payload?.success === false ||
      receipt?.success === false ||
      ["failed", "error", "rejected"].includes(
        String(receipt?.sendStatus ?? receipt?.status ?? payload?.deliveryStatus).toLowerCase(),
      ) ||
      payload?.contractVersion !== "im.message-reply.v1" ||
      payload?.conversationId !== event.conversation_id ||
      payload?.referencedMessage?.messageId !== event.message_id ||
      payload?.referencedMessage?.senderOpenDingTalkId !== event.sender_open_dingtalk_id ||
      payload?.idempotencyKey !== key ||
      !acknowledged
    ) {
      throw new Error("DWS未确认引用回复成功，请核实原消息；不会改成普通群消息重发。");
    }
  } else if (
    payload?.ok !== true ||
    payload?.identity !== "user" ||
    payload?.tool !== "send_personal_message" ||
    payload?.error
  ) {
    throw new Error("DWS未确认成功，请核实发送记录。");
  }
  return result;
}
