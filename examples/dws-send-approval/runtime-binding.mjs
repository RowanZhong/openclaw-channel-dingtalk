import { createHash } from "node:crypto";

const KEY = Symbol.for("openclaw.dws-send-approval.running.v1");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

// Some hosts register commands again during agent-runtime prewarming without
// starting those registrations' services. Resolve the live service at call time.
// Include the entire normalized config so a stale owner/profile cannot bind to it.
export function runtimeBinding(config) {
  const key = createHash("sha256")
    .update(JSON.stringify(canonical(config)))
    .digest("hex");
  const registry = (globalThis[KEY] ??= new Map());
  return {
    peek: () => registry.get(key),
    require() {
      const value = registry.get(key);
      if (!value) {
        throw new Error("服务尚未就绪，请稍后重试。");
      }
      return value;
    },
    publish(value) {
      if (registry.has(key)) {
        throw new Error("代回复服务已启动，不能重复启动。");
      }
      registry.set(key, value);
    },
    remove(value) {
      if (registry.get(key) === value) {
        registry.delete(key);
      }
    },
  };
}
