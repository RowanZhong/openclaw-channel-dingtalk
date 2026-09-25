// Uses the real host's service scheduler with controlled DWS dependencies.
// Does not start a Gateway, log out the employee, or use the employee state directory.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createIdentityService } from "../identity-service.mjs";
import { IdentityError, cancelled } from "../identity-cli.mjs";
import { readConfig } from "../config.mjs";

const host = resolve(process.argv[2]);
const stateDir = await mkdtemp(join(tmpdir(), "dws-host-startup-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = join(stateDir, "openclaw.json");
const version = JSON.parse(await readFile(join(host, "package.json"))).version;
const file = (await readdir(join(host, "dist"))).find((n) => /^services-[\w-]+\.js$/.test(n));
const { startPluginServices } = await import(pathToFileURL(join(host, "dist", file)));
const config = readConfig({ ownerUserId: "owner", dwsPath: "/not-used" }, { discovery: true });
const profile = {
  success: true,
  currentProfile: "corp:owner",
  profiles: [
    {
      profile: "corp:owner",
      corpId: "corp",
      userId: "owner",
      clientId: "oauth",
      isCurrent: true,
      status: "active",
    },
  ],
};
const results = [];
try {
  for (const scenario of ["logged-in-slow", "logged-out", "missing-binary", "hanging"]) {
    let nextStarted = false,
      calls = 0,
      handle;
    const service = createIdentityService({}, config, {
      startupDelayMs: 0,
      budgetMs: 800,
      runner: async (_, __, { signal }) => {
        calls++;
        if (scenario === "logged-out") return { success: true, profiles: [] };
        if (scenario === "missing-binary") throw new IdentityError("unavailable", "DWS missing");
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, scenario === "hanging" ? 10000 : 500);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(cancelled());
            },
            { once: true },
          );
        });
        return profile;
      },
      buildRuntime: async () => ({ service: { stop() {} }, policy() {} }),
    });
    const registry = {
      services: [
        { pluginId: "dws-send-approval", service },
        {
          pluginId: "independent-service",
          service: {
            id: "independent-service",
            start() {
              nextStarted = true;
            },
          },
        },
      ],
      httpRoutes: [],
      plugins: [],
    };
    try {
      const start = performance.now();
      handle = await startPluginServices({
        registry,
        config: { channels: { dingtalk: { clientId: "robot-code" } } },
      });
      const elapsedMs = performance.now() - start;
      assert.equal(nextStarted, true);
      assert.equal(calls, 0);
      assert.ok(elapsedMs < 250);
      const deadline = Date.now() + 2500;
      while (service.status().state === "starting" && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      const expected = {
        "logged-in-slow": "ready",
        "logged-out": "waiting_login",
        "missing-binary": "unavailable",
        hanging: "failed",
      }[scenario];
      assert.equal(service.status().state, expected);
      results.push({
        scenario,
        startupMs: Math.round(elapsedMs * 100) / 100,
        dependencyState: expected,
        independentServiceStarted: nextStarted,
      });
    } finally {
      await handle?.stop();
    }
  }
  process.stdout.write(JSON.stringify({ version, results }) + "\n");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
