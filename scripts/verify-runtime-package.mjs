import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
});
const [pack] = JSON.parse(output);
const files = new Set(
    pack.files.map((file) => String(file.path).replace(/^package\//u, "")),
);
const requiredFiles = ["docs/user/reference/feedback-reporting-api.md", "docs/user/reference/feedback-reporting-examples.json", "dist/feedback-reporting-worker.js", "docs/user/features/feedback-http-reporting.md", "docs/user/reference/feedback-reporting.openapi.json", "docs/user/reference/feedback-reporting-oceanbase.sql", "scripts/feedback-reporting-receiver.mjs", "dist/index.js", "dist/index.d.ts", "openclaw.plugin.json",
    "docs/assets/card-template-v2.json", "docs/user/features/card-feedback.md", "docs/user/getting-started/card-feedback-deployment.md", "scripts/feedback-export.mjs"];
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

const processExecutionCall = /(?<![.\w])(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/u;
if (processExecutionCall.test(runtime)) {
    throw new Error("Runtime package must not include process execution calls");
}

console.log(`Runtime package check passed: ${requiredFiles.join(", ")}`);
