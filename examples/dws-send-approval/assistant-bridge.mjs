export const BRIDGE_KEY = Symbol.for("openclaw.dingtalk.reply-assistant.v1");
export function bridge() {
  const value = (globalThis[BRIDGE_KEY] ??= { version: 1, assistants: new Map() });
  if (value.version !== 1 || !(value.assistants instanceof Map)) {
    throw new Error("钉钉卡片桥接版本不匹配。");
  }
  return value;
}
