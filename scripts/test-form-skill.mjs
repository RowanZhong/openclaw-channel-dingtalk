import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// These filenames contain dots, so unittest discovery cannot import them as modules.
// Run each suite directly and propagate failures to the existing pnpm test CI step.
for (const suite of ["resolver", "design", "design-groups", "timeout"]) {
  const result = spawnSync("python3", [`tests/unit/dingtalk-form-${suite}.test.py`], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`Form Skill tests require python3: ${result.error.message}\n`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
