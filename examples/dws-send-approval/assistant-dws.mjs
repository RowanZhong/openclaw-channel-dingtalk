import { spawn } from "node:child_process";
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
    throw new Error("来源会话ID无效。");
  }
  const text = safeText(draft.text);
  const result = await runner(config, [
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
  ]);
  const payload =
    result?.outcome === "success" && result.ok === true && !result.dry_run ? result.data : result;
  if (
    payload?.ok !== true ||
    payload?.identity !== "user" ||
    payload?.tool !== "send_personal_message" ||
    payload?.error
  ) {
    throw new Error("DWS未确认成功，请核实发送记录。");
  }
  return result;
}
