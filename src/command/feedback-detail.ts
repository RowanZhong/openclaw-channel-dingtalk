import { createHash } from "node:crypto";
import { feedbackTranscriptText } from "../card/feedback-transcript";
import { getDingTalkRuntime } from "../runtime";
import { readFeedbackRecord, type FeedbackRecord, type FeedbackScope } from "./feedback-store";

export type FeedbackTranscriptReader = (target: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
}) => Promise<unknown[]>;

/** Read only when the user explicitly requests detail, never on the reply hot path. */
export async function readFeedbackTranscriptEvents(
  target: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
  },
  sessionStoreTemplate?: string,
): Promise<unknown[]> {
  const { readSessionTranscriptEvents } =
    await import("openclaw/plugin-sdk/session-transcript-runtime");
  const storePath = getDingTalkRuntime().channel.session.resolveStorePath(sessionStoreTemplate, {
    agentId: target.agentId,
  });
  return readSessionTranscriptEvents({ ...target, storePath });
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function quote(text: string, max: number): string {
  const shown =
    text.length > max
      ? `${text.slice(0, max)}\n（正文较长，此处仅展示前 ${max} 字符；完整内容保留在对应转录中。）`
      : text;
  return shown
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
export function resolveFeedbackTranscriptMessages(
  record: FeedbackRecord,
  events: unknown[],
):
  | {
      question: string;
      answer: string;
    }
  | undefined {
  const link = record.transcript;
  if (link?.status !== "linked") {
    return undefined;
  }
  let question: string | undefined;
  let answer: string | undefined;
  let questionIndex = -1;
  let answerIndex = -1;
  let duplicate = false;
  for (const [index, value] of events.entries()) {
    const entry = object(value);
    if (entry?.type === "session" && entry.id !== link.sessionId) {
      return undefined;
    }
    if (entry?.type !== "message") {
      continue;
    }
    const message = object(entry.message);
    if (entry.id === link.userMessageId) {
      if (questionIndex >= 0 || message?.role !== "user") {
        duplicate = true;
      }
      if (
        typeof message?.senderId === "string" &&
        message.senderId.replace(/^(?:dingtalk|dd|ding):/i, "") !== record.ownerUserId
      ) {
        return undefined;
      }
      if (message?.sourceChannel && message.sourceChannel !== "dingtalk") {
        return undefined;
      }
      question = feedbackTranscriptText(message);
      questionIndex = index;
    }
    if (entry.id === link.assistantMessageId) {
      if (answerIndex >= 0 || message?.role !== "assistant") {
        duplicate = true;
      }
      answer = feedbackTranscriptText(message);
      answerIndex = index;
    }
  }
  if (
    duplicate ||
    question === undefined ||
    answer === undefined ||
    questionIndex >= answerIndex ||
    createHash("sha256").update(answer).digest("hex") !== record.answerHash
  ) {
    return undefined;
  }
  return { question, answer };
}
export async function feedbackDetail(params: {
  scope: FeedbackScope;
  outTrackId: string;
  userId: string;
  readTranscript: FeedbackTranscriptReader;
}): Promise<string> {
  const record = await readFeedbackRecord(params.scope, params.outTrackId);
  // Authorize before loading any transcript, including a shared group session.
  if (!record || record.ownerUserId !== params.userId || record.expiresAt <= Date.now()) {
    return "未找到你有权查看且仍在保留期内的评价记录。";
  }
  if (!record.completedAt) {
    return "这张卡片没有正常完成的回答，暂不能反查正文。";
  }
  const link = record.transcript;
  if (link?.status !== "linked") {
    const reasons: Record<string, string> = {
      "events-unavailable": "系统未提供转录消息标识",
      "session-id-missing": "系统未提供实际会话标识",
      "question-not-observed": "本轮没有确认原问题标识",
      "answer-not-observed": "本轮没有确认回答标识",
      "ambiguous-turn": "存在多条候选消息，无法唯一确认",
      "content-mismatch": "卡片与转录文本不完全一致",
      "capture-limit": "内容超过轻量关联范围",
    };
    return `这条评价暂不能自动反查：${link ? reasons[link.reason] : "旧记录未保存消息 ID"}。评价记录仍保留，不会用其他回答代替。`;
  }
  let events: unknown[];
  try {
    events = await params.readTranscript({
      agentId: record.agentId,
      sessionKey: record.sessionKey,
      sessionId: link.sessionId,
    });
  } catch {
    return "对应会话转录当前无法读取，可能已清理、归档或变更存储位置；评价记录仍保留，不会改查新的会话。";
  }
  const result = resolveFeedbackTranscriptMessages(record, events);
  if (!result) {
    return "转录中的指定消息缺失或内容校验不一致，不能确认原问答；不会回退到最近回答。";
  }
  const votes = { none: "未评价 / 已撤销", like: "点赞", dislike: "点踩" };
  return [
    `### 评价对应的问答`,
    "",
    `- 卡片：${record.outTrackId}`,
    `- Agent：${record.agentId}`,
    `- 当前评价：${votes[record.vote]}`,
    "",
    "**原问题**",
    quote(result.question, 1000),
    "",
    "**回答**",
    quote(result.answer, 2500),
    "",
    "已按会话及消息 ID 精确定位，并核对回答指纹一致。",
  ].join("\n");
}
