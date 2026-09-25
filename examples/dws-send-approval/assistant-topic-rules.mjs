// Topic scopes only narrow the listener's independently authorized sources.
export const TOPIC_LIMIT = 20;
export const TOPIC_ACTIONS = { auto: "自动发送固定说明", confirm: "模板由我确认", inbox: "只整理提醒" };
export const TOPIC_REASONS = {
  matched: "主题明确匹配", none: "未匹配指定主题", ambiguous: "主题不明确，需本人判断",
  partial: "包含其他问题，模板不能完整回应", excluded: "属于主题排除情形",
  conflict: "匹配规则冲突，需本人判断", invalid: "识别结果无效，未自动发送",
  failed: "主题识别未完成，可修改或重新拟稿", busy: "主题识别队列繁忙，转本人处理",
  changed: "主题设置已变化，请重新拟稿或修改规则", no_rules: "没有启用的主题，请核对设置",
  too_long: "消息过长，未自动判类", expired: "自动答复授权已到期，请本人确认",
};
export function initialTopics() { return { enabled: false, mode: "fallback", revision: 0, rules: [] }; }
export function topicText(value, max, optional = false) {
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim()) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value))
    throw new Error(`内容须为${optional ? 0 : 1}至${max}字符，不能包含控制字符。`);
  return value.trim();
}
export function validateTopicRule(r) {
  if (!r || typeof r.id !== "string" || !/^[\w-]{1,80}$/.test(r.id) || typeof r.enabled !== "boolean" ||
      !["all", "dm", "user", "group"].includes(r.scope) || !Array.isArray(r.targets) ||
      r.targets.length > 20 || r.targets.some((id) => typeof id !== "string" || !id || id.length > 512 || /[\s\p{C}]/u.test(id)) ||
      new Set(r.targets).size !== r.targets.length ||
      (["user", "group"].includes(r.scope) ? !r.targets.length : r.targets.length) ||
      !Object.hasOwn(TOPIC_ACTIONS, r.action) || !Number.isFinite(r.expires) || r.expires < 0 ||
      ![5, 30, 60, 1440].includes(r.cooldownMinutes)) throw new Error("主题规则范围或授权无效。");
  return { ...r, name: topicText(r.name, 60), description: topicText(r.description, 600),
    examples: topicText(r.examples, 600, true), exclusions: topicText(r.exclusions, 400, true),
    text: r.action === "inbox" ? "" : topicText(r.text, 160) };
}
export function validateTopics(value = initialTopics()) {
  if (!value || typeof value.enabled !== "boolean" || !["fallback", "only"].includes(value.mode) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.rules) ||
      value.rules.length > TOPIC_LIMIT || new Set(value.rules.map((r) => r?.id)).size !== value.rules.length)
    throw new Error("消息主题设置无效。");
  return { ...value, rules: value.rules.map(validateTopicRule) };
}
export function topicSourceMatches(rule, event, reply) {
  return rule.scope === "all" || (rule.scope === "dm" && reply.direct) ||
    (rule.scope === "user" && rule.targets.includes(event.sender_open_dingtalk_id)) ||
    (rule.scope === "group" && !reply.direct && rule.targets.includes(event.conversation_id));
}
export function eligibleTopics(topics, event, reply) {
  return topics.rules.filter((r) => r.enabled && topicSourceMatches(r, event, reply));
}
export function normalizeTopicDecision(value, rules) {
  if (!value || Array.isArray(value) || !["match", "none", "review"].includes(value.outcome) ||
      !Array.isArray(value.ruleIds) || typeof value.coversWholeMessage !== "boolean" ||
      !Object.hasOwn(TOPIC_REASONS, value.reason) ||
      Object.keys(value).some((k) => !["outcome", "ruleIds", "coversWholeMessage", "reason"].includes(k)) ||
      value.ruleIds.some((id) => typeof id !== "string" || !rules.some((r) => r.id === id)) ||
      new Set(value.ruleIds).size !== value.ruleIds.length)
    return { outcome: "review", reason: "invalid", ruleIds: [], coversWholeMessage: false };
  if (value.outcome === "match") {
    if (value.ruleIds.length !== 1) return { outcome: "review", reason: "conflict", ruleIds: [], coversWholeMessage: false };
    if (!value.coversWholeMessage || value.reason !== "matched")
      return { outcome: "review", reason: "partial", ruleIds: [], coversWholeMessage: false };
    return { outcome: "match", reason: "matched", ruleIds: value.ruleIds, coversWholeMessage: true };
  }
  if (value.outcome === "none" && !value.ruleIds.length && !value.coversWholeMessage && value.reason === "none")
    return { outcome: "none", reason: "none", ruleIds: [], coversWholeMessage: false };
  return { outcome: "review", reason: value.outcome === "review" ? value.reason : "invalid", ruleIds: [], coversWholeMessage: false };
}
export function topicDisposition(decision, rules, settings, reply, keywordMatches, now) {
  if (decision.outcome !== "match") return { kind: decision.outcome, reason: decision.reason };
  const rule = rules.find((r) => r.id === decision.ruleIds[0]);
  if (!rule) return { kind: "review", reason: "changed" };
  if (reply.mode === "inbox" || rule.action === "inbox") return { kind: "inbox", rule };
  if (rule.action === "confirm") return { kind: "confirm", rule };
  if (keywordMatches.some((r) => r.text !== rule.text)) return { kind: "review", reason: "conflict" };
  return { kind: rule.expires > now ? "auto" : "confirm", rule,
    reason: rule.expires > now ? "matched" : "expired" };
}
