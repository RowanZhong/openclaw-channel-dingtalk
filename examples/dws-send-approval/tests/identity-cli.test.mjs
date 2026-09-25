import assert from "node:assert/strict";
import test from "node:test";
import { runIdentityCli } from "../identity-cli.mjs";

const run = (source, options = {}) =>
  runIdentityCli({ dwsPath: process.execPath }, ["-e", source], options);
test("bootstrap CLI captures JSON without invoking a shell", async () => {
  const result = await run(
    'process.stdout.write(JSON.stringify({ok:true,text:"$(echo secret); `id`"}))',
  );
  assert.deepEqual(result, { ok: true, text: "$(echo secret); `id`" });
});
test("missing executable is a contained unavailable state", async () => {
  await assert.rejects(runIdentityCli({ dwsPath: "/not-a-real-dws" }, []), {
    identityState: "unavailable",
  });
});
test("malformed output and raw secret stderr are not leaked into diagnostics", async () => {
  await assert.rejects(run('process.stdout.write("not json")'), { identityState: "failed" });
  await assert.rejects(run('process.stderr.write("TOKEN_SECRET");process.exit(1)'), (error) => {
    assert.equal(error.identityState, "failed");
    assert.doesNotMatch(error.message, /TOKEN_SECRET/);
    return true;
  });
});
test("auth failure is actionable and never automatically retryable", async () => {
  await assert.rejects(
    run(
      'process.stderr.write(JSON.stringify({error:{category:"authentication",retryable:true}}));process.exit(1)',
    ),
    (e) => e.identityState === "waiting_login" && !e.retryable,
  );
});
test("transient retry-after is bounded", async () => {
  await assert.rejects(
    run(
      'process.stderr.write(JSON.stringify({error:{category:"network",retryable:true,retry_after_seconds:9999999}}));process.exit(1)',
    ),
    (e) => e.retryable && e.retryAfterMs === 3600000,
  );
});
test("hung subprocess is terminated and SIGTERM-resistant process is killed", async () => {
  const started = Date.now();
  await assert.rejects(
    run('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)', { timeoutMs: 150 }),
    (e) => e.identityState === "failed" && e.retryable,
  );
  assert.ok(Date.now() - started < 2500);
});
test("abort terminates an active child and pre-abort never starts one", async () => {
  const c = new AbortController();
  const result = run("setInterval(()=>{},1000)", { signal: c.signal });
  c.abort();
  await assert.rejects(result, { identityState: "stopped" });
  await assert.rejects(
    runIdentityCli({ dwsPath: "/not-used" }, [], {
      signal: c.signal,
      spawnChild() {
        assert.fail("must not spawn");
      },
    }),
    { identityState: "stopped" },
  );
});
test("combined stdout and stderr are bounded to one MiB", async () => {
  await assert.rejects(
    run(
      'process.stdout.write("a".repeat(700000));process.stderr.write("b".repeat(700000));setInterval(()=>{},1000)',
    ),
    (e) => /输出超限/.test(e.message),
  );
});
