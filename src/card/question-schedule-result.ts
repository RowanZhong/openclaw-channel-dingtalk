import type { DingTalkQuestionCollectionResult } from "../platform/types";

function inline(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]/g, " ").replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&");
}

/** Deterministic data rendering: answers never become an agent turn or a tool instruction. */
export function formatScheduledFormResult(
  result: DingTalkQuestionCollectionResult,
  names: Record<string, string>,
): string[] {
  const states = { submitted: "已完成", expired: "已超时", cancelled: "已取消" };
  const responseStates = {
    submitted: "已提交",
    empty: "空提交",
    cancelled: "已取消填写",
    missing: "未回应",
  };
  const blocks = [
    `- 表单标题：${inline(result.question_title)}\n- 收集状态：${states[result.status]}`,
  ];
  for (const response of result.responses) {
    const person = inline(names[response.respondent_user_id] || response.respondent_user_id);
    const heading = `- 填写人：${person}（${responseStates[response.status]}）`;
    blocks.push(heading);
    for (const answer of response.answers) {
      const label = inline(answer.question);
      if (answer.answer.length < 300 && !/[\r\n\u2028\u2029]/.test(answer.answer)) {
        blocks.push(`- ${label}：${inline(answer.answer)}`);
      } else {
        // Bound each message while preserving every answer character, including Markdown fences.
        const chars = Array.from(answer.answer);
        for (let offset = 0; offset < chars.length; offset += 1500) {
          const part = chars.slice(offset, offset + 1500).join("");
          const longestFence = Math.max(2, ...(part.match(/`+/g) ?? []).map((x) => x.length));
          const fence = "`".repeat(longestFence + 1);
          blocks.push(
            `${heading}\n- ${label}${offset ? "（续）" : ""}：\n\n${fence}\n${part}\n${fence}`,
          );
        }
      }
    }
  }
  const messages: string[] = [];
  for (const block of blocks) {
    const last = messages.length - 1;
    if (last >= 0 && messages[last].length + block.length + 2 <= 6000) {
      messages[last] += `\n\n${block}`;
    } else {
      messages.push(block);
    }
  }
  return messages;
}
