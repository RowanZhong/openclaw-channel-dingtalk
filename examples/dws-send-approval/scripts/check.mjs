import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of await readdir(root)) {
  if (name.endsWith(".mjs")) {
    execFileSync(process.execPath, ["--check", root + name], { stdio: "inherit" });
  }
}
