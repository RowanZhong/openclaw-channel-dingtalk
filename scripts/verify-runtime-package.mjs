import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [pack] = JSON.parse(output);
const files = new Set(pack.files.map((file) => String(file.path).replace(/^package\//u, "")));
const requiredFiles = ["dist/index.js", "dist/index.d.ts", "openclaw.plugin.json"];
const missingFiles = requiredFiles.filter((file) => !files.has(file));
const sourceMaps = [...files].filter((file) => file.endsWith(".map"));

if (missingFiles.length > 0) {
  throw new Error(`Runtime package is missing required file(s): ${missingFiles.join(", ")}`);
}
if (sourceMaps.length > 0) {
  throw new Error(`Runtime package must not include source maps: ${sourceMaps.join(", ")}`);
}

const runtime = readFileSync("dist/index.js", "utf8");
if (runtime.includes("child_process")) {
  throw new Error("Runtime package must not include child_process imports");
}

const processExecutionCall =
  /(?<![.\w])(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/u;
if (processExecutionCall.test(runtime)) {
  throw new Error("Runtime package must not include process execution calls");
}

// Secret resolvers must never receive the whole ambient environment: reading one
// authorized variable at a time keeps credential ownership with the host.
//
// This is a shape heuristic against the exact fingerprint that ClawHub flagged
// (Issue #608), not an exhaustive dataflow analysis: indirect forms such as
// `env: { ...process.env }`, `const e = process.env; env: e`, or `env: process.env
// as any` would not match.
const ambientEnvPassThrough = /\benv\s*:\s*process\.env\s*(?:,|\}|\))/u;
if (ambientEnvPassThrough.test(runtime)) {
  throw new Error("Runtime package must not pass the whole process.env to a secret resolver");
}

// The runtime bundle must not reach into ambient environment state at all.
//
// ClawHub's `suspicious.env_credential_access` rule ("environment variable access
// combined with network send") stayed open on the single-key read that used to
// resolve an `env` SecretInput. That read now happens inside the host SDK
// (`openclaw/plugin-sdk/secret-ref-readonly`), and this guard keeps a direct
// ambient read from silently reappearing in the published artifact.
//
// Only the documented non-credential card template id override is allowed; see
// `docs/user/reference/security-policies.md` (环境变量读取范围).
const allowedEnvKeys = new Set(["DINGTALK_CARD_TEMPLATE_ID"]);
const ambientEnvAccess = /\bprocess\s*\.\s*env\b(?:\s*\.\s*([A-Za-z_$][\w$]*)|(\s*\[[^\]]*\]))?/gu;
for (const [match, staticKey, computedKey] of runtime.matchAll(ambientEnvAccess)) {
  if (!computedKey && staticKey && allowedEnvKeys.has(staticKey)) {
    continue;
  }
  throw new Error(
    `Runtime package must not read ambient environment state outside the documented allowlist: ${match}`,
  );
}

console.log(`Runtime package check passed: ${requiredFiles.join(", ")}`);
