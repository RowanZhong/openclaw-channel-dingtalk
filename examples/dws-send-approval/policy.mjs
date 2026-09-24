import { findDwsSendCommand } from "./command-policy.mjs";
import { MAX_REPLY_CHARS } from "./preferences.mjs";
import { prepareSend } from "./send-preview.mjs";

// These transfer work to a session whose origin could no longer be established.
const HANDOFF_TOOLS = new Set([
  "sessions_spawn",
  "spawn_agent",
  "sessions_send",
  "agent_send",
  "subagents",
  "cron",
]);

export function createPolicy(config, store) {
  return (event, ctx = {}) => {
    const source = store.classify(ctx);
    if (source === "ordinary") {
      return;
    }
    if (HANDOFF_TOOLS.has(event.toolName)) {
      return {
        block: true,
        blockReason: "DWS监听任务不支持跨会话转交或创建延迟任务；请在当前专用会话完成。",
      };
    }
    if (event.toolName !== "exec" || event.toolKind === "code_mode_exec") {
      return;
    }
    if (!findDwsSendCommand(event.params?.command, config.dwsPath)) {
      return;
    }
    if (source !== "listener") {
      return { block: true, blockReason: "无法验证DWS监听会话来源，发送已阻断。" };
    }
    if (config.mode === "block") {
      return { block: true, blockReason: "DWS监听任务的发送被配置为禁止。" };
    }
    // Approval cannot accurately describe a send with a caller-selected credential environment.
    if (event.params.env && Object.keys(event.params.env).length) {
      return { block: true, blockReason: "监听发送不允许覆盖exec环境变量。" };
    }
    try {
      const prepared = prepareSend(event.params.command, config);
      const reply = store.records.get(ctx.sessionKey)?.reply;
      if (reply) {
        if (reply.mode === "off") {
          throw new Error("本条消息设置为不回复。");
        }
        const conversationTarget =
          ["group", "chat-id"].includes(prepared.targetFlag) &&
          prepared.target === reply.conversationId;
        const privateTarget =
          reply.direct &&
          ["user", "open-dingtalk-id"].includes(prepared.targetFlag) &&
          prepared.target === reply.senderOpenId;
        if (!conversationTarget && !privateTarget) {
          throw new Error("只能回复来源会话，不能更换接收对象。");
        }
        if (prepared.body.length > MAX_REPLY_CHARS || prepared.title !== "消息") {
          throw new Error("正文超长或标题不是固定值“消息”。");
        }
        if (reply.mode === "fixed" && (prepared.kind !== "text" || prepared.body !== reply.text)) {
          throw new Error("固定回复正文必须与任务配置快照完全一致。");
        }
      }
      return {
        // A private snapshot also supports the 2026.7.1-2 hook merger; lower hooks may veto.
        params: { ...structuredClone(event.params), command: prepared.command },
        requireApproval: {
          title: reply
            ? `批准钉钉回复 · ${reply.scope}规则 v${reply.revision}`
            : "批准本次钉钉消息发送",
          description: prepared.description,
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: config.timeoutMs,
        },
      };
    } catch (error) {
      return { block: true, blockReason: `无法完整预览，发送已阻断：${error.message}` };
    }
  };
}
