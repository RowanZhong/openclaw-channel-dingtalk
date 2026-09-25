import { spawn } from "node:child_process";

export class IdentityError extends Error {
  constructor(state, message, retryable = false, retryAfterMs = 0) {
    super(message);
    this.identityState = state;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
export const cancelled = () => new IdentityError("stopped", "身份检测已取消。");

// Separate bootstrap runner: profile list must run without an already resolved profile.
// Never log raw stdout/stderr, which may contain account or credential diagnostics.
export function runIdentityCli(
  config,
  args,
  { signal, timeoutMs = 10000, spawnChild = spawn } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    let child,
      stdout = "",
      stderr = "",
      bytes = 0,
      failure,
      settled = false,
      timer,
      killer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    const terminate = (error) => {
      if (failure || settled) return;
      failure = error;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), 500);
      killer.unref?.();
    };
    const abort = () => terminate(cancelled());
    try {
      child = spawnChild(config.dwsPath, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return finish(new IdentityError("unavailable", "DWS 无法执行，请检查 dwsPath 和文件权限。"));
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(
      () => terminate(new IdentityError("failed", "DWS 身份查询超时。", true)),
      timeoutMs,
    );
    const collect = (chunk, isError) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024)
        return terminate(new IdentityError("failed", "DWS 身份查询输出超限。"));
      if (isError) stderr += chunk;
      else stdout += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.on("error", () =>
      finish(new IdentityError("unavailable", "DWS 无法执行，请检查 dwsPath 和文件权限。")),
    );
    child.on("close", (code) => {
      if (failure) return finish(failure);
      if (code !== 0) {
        let detail;
        try {
          detail = JSON.parse(stderr).error;
        } catch {
          /* No raw CLI diagnostics in user errors. */
        }
        const auth = ["authentication", "authorization", "auth", "permission"].includes(
          detail?.category,
        );
        const retry = !auth && detail?.retryable === true;
        const after = Number(detail?.retry_after_seconds);
        return finish(
          new IdentityError(
            auth ? "waiting_login" : "failed",
            auth
              ? "DWS 登录或授权不可用，请完成授权后重新检测。"
              : "DWS 身份查询失败，请检查授权、网络及配置目录权限。",
            retry,
            Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 3600000) : 0,
          ),
        );
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new IdentityError("failed", "DWS 身份查询未返回有效 JSON。"));
      }
    });
  });
}
