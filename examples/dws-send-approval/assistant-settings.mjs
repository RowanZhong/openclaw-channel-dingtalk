import { stableId } from "./preferences.mjs";
export function initialSettings() {
  return {
    version: 1,
    revision: 0,
    autoRules: [],
    pauses: {},
    notifications: {
      mode: "immediate",
      minutes: 15,
      quietStart: "22:00",
      quietEnd: "08:00",
      timezone: "Asia/Shanghai",
      priorityUsers: [],
    },
  };
}
export function safeText(text, max = 160) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > max ||
    [...text].some((char) => {
      const c = char.charCodeAt(0);
      return (
        (c < 32 && ![9, 10, 13].includes(c)) ||
        c === 127 ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069)
      );
    })
  ) {
    throw new Error(`文字需为1..${max}字符。`);
  }
  return text.trim();
}
export function validateSettings(value) {
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    !Array.isArray(value.autoRules) ||
    value.autoRules.length > 20
  ) {
    throw new Error("自动回复设置无效。");
  }
  for (const rule of value.autoRules) {
    if (
      !stableId(rule.id) ||
      !["all", "dm", "group", "user"].includes(rule.scope) ||
      (["group", "user"].includes(rule.scope) && !stableId(rule.target)) ||
      !Number.isFinite(rule.expires) ||
      !Number.isInteger(rule.cooldownMinutes) ||
      rule.cooldownMinutes < 1 ||
      rule.cooldownMinutes > 1440 ||
      !Array.isArray(rule.keywords) ||
      rule.keywords.length > 10 ||
      rule.keywords.some((k) => typeof k !== "string" || !k.trim() || k.length > 100)
    ) {
      throw new Error("自动规则范围、期限或频率无效。");
    }
    rule.text = safeText(rule.text);
  }
  if (new Set(value.autoRules.map((r) => r.id)).size !== value.autoRules.length) {
    throw new Error("自动规则重复。");
  }
  const n = value.notifications;
  if (
    !["immediate", "digest", "manual"].includes(n.mode) ||
    !Number.isInteger(n.minutes) ||
    n.minutes < 1 ||
    n.minutes > 1440 ||
    ![n.quietStart, n.quietEnd].every(
      (s) => typeof s === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s),
    ) ||
    !Array.isArray(n.priorityUsers) ||
    n.priorityUsers.length > 20 ||
    !n.priorityUsers.every(stableId)
  ) {
    throw new Error("提醒设置无效。");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: n.timezone });
  } catch {
    throw new Error("时区无效。");
  }
  if (
    !value.pauses ||
    typeof value.pauses !== "object" ||
    Object.keys(value.pauses).length > 200 ||
    Object.entries(value.pauses).some(([id, until]) => !stableId(id) || !Number.isFinite(until))
  ) {
    throw new Error("暂停设置无效。");
  }
  return structuredClone(value);
}
export function quietNow(settings, now) {
  const n = settings.notifications;
  if (n.quietStart === n.quietEnd) {
    return false;
  }
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: n.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return n.quietStart < n.quietEnd
    ? text >= n.quietStart && text < n.quietEnd
    : text >= n.quietStart || text < n.quietEnd;
}
export function autoAnswer(event, reply, settings, now) {
  if (
    reply.mode === "off" ||
    reply.mode === "inbox" ||
    settings.pauses[event.conversation_id] > now
  ) {
    return null;
  }
  const matches = settings.autoRules.filter(
    (r) =>
      r.expires > now &&
      (r.scope === "all" ||
        (r.scope === "dm" && reply.direct) ||
        (r.scope === "group" && r.target === event.conversation_id) ||
        (r.scope === "user" && r.target === event.sender_open_dingtalk_id)) &&
      (!r.keywords.length || r.keywords.some((k) => event.content.includes(k))),
  );
  // Overlapping, different answers need human review rather than an arbitrary winner.
  return matches.length && new Set(matches.map((r) => r.text)).size === 1 ? matches[0] : null;
}
