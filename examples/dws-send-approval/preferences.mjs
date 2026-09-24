import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MAX_TARGETS = 20;
export const MAX_REPLY_CHARS = 160;
export function stableId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_+=:./$-]{1,128}$/.test(value);
}
export function idList(value) {
  const ids = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TARGETS || !ids.every(stableId)) {
    throw new Error(`需要 1..${MAX_TARGETS} 个稳定 ID，以英文逗号分隔。`);
  }
  return [...new Set(ids)];
}
export function replyRule(mode, text = "") {
  if (!["ai", "fixed", "off", "inbox"].includes(mode)) {
    throw new Error("回复模式必须是 ai、fixed、inbox 或 off。");
  }
  if (
    typeof text !== "string" ||
    [...text].some((char) => {
      const code = char.codePointAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  ) {
    throw new Error("回复设置含无效字符。");
  }
  text = text.trim();
  if (
    ["off", "inbox"].includes(mode)
      ? Boolean(text)
      : !text || text.length > (mode === "fixed" ? MAX_REPLY_CHARS : 2000)
  ) {
    throw new Error(`ai 要求 1..2000 字符；fixed 要求 1..${MAX_REPLY_CHARS} 字符；off 不带正文。`);
  }
  return { mode, text };
}
const DEFAULT_REPLY = {
  mode: "ai",
  text: "使用简洁、礼貌的中文回复。不确定的信息说明需要本人确认，不编造事实或承诺。",
};
export function initialPreferences(config) {
  const rules = {
    dm: { mode: "off", ids: [] },
    at: { mode: "off", ids: [] },
    sender: { mode: "off", ids: [] },
  };
  const { kind, target } = config.listener;
  if (["all-direct", "all-direct-and-at-me"].includes(kind)) {
    rules.dm.mode = "all";
  }
  if (["at-me", "all-group", "all-direct-and-at-me"].includes(kind)) {
    rules.at.mode = "all";
  }
  if (kind === "group") {
    rules.at = { mode: "groups", ids: [target] };
  }
  if (kind === "sender") {
    rules.sender = { mode: "users", ids: [target] };
  }
  return {
    version: 1,
    revision: 0,
    enabled: config.listener.enabled === true,
    rules,
    reply: { default: { ...DEFAULT_REPLY }, groups: [], users: [] },
  };
}
export function validatePreferences(value) {
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("个人设置格式无效。");
  }
  const rules = {};
  for (const [key, modes] of Object.entries({
    dm: ["off", "all", "users"],
    at: ["off", "all", "groups"],
    sender: ["off", "users"],
  })) {
    const rule = value.rules?.[key];
    if (!rule || !modes.includes(rule.mode) || !Array.isArray(rule.ids)) {
      throw new Error("监听规则无效。");
    }
    const targeted = ["users", "groups"].includes(rule.mode);
    if (!targeted && rule.ids.length) {
      throw new Error("关闭或全部范围不能带目标 ID。");
    }
    rules[key] = { mode: rule.mode, ids: targeted ? idList(rule.ids) : [] };
  }
  const replies = value.reply;
  if (!replies?.default) {
    throw new Error("缺少默认回复设置。");
  }
  const reply = { default: replyRule(replies.default.mode, replies.default.text) };
  for (const key of ["groups", "users"]) {
    if (!Array.isArray(replies[key]) || replies[key].length > MAX_TARGETS) {
      throw new Error("专属回复数量超限。");
    }
    const ids = new Set();
    reply[key] = replies[key].map((entry) => {
      if (!stableId(entry.id) || ids.has(entry.id)) {
        throw new Error("专属回复 ID 无效或重复。");
      }
      ids.add(entry.id);
      return { id: entry.id, ...replyRule(entry.mode, entry.text) };
    });
  }
  return { version: 1, revision: value.revision, enabled: value.enabled, rules, reply };
}

export class PreferenceStore {
  constructor(config) {
    this.config = config;
    this.value = null;
  }
  async load(stateDir) {
    this.path = join(stateDir, "dws-send-approval", "preferences.json");
    this.identity = {
      profile: this.config.profile,
      ownerUserId: this.config.ownerUserId,
      accountId: this.config.accountId,
    };
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8"));
      if (Object.entries(this.identity).some(([key, value]) => saved.identity?.[key] !== value)) {
        throw new Error("identity mismatch");
      }
      this.value = validatePreferences(saved.preferences);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error("个人设置损坏或账户绑定不匹配；未启动监听，请管理员检查。", {
          cause: error,
        });
      }
      this.value = validatePreferences(initialPreferences(this.config));
      await this.save(this.value);
    }
  }
  snapshot() {
    if (!this.value) {
      throw new Error("服务尚未初始化，个人设置不可用。");
    }
    return structuredClone(this.value);
  }
  async save(value) {
    const next = validatePreferences(value);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ identity: this.identity, preferences: next }), {
        mode: 0o600,
      });
      await rename(temporary, this.path);
      this.value = next;
    } finally {
      await rm(temporary, { force: true });
    }
    return this.snapshot();
  }
}
