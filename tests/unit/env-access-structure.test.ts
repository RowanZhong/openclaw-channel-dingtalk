/**
 * Guards the ambient-environment access surface at the source level.
 *
 * ClawHub's `suspicious.env_credential_access` rule ("environment variable access
 * combined with network send") stayed open on the single-key env read that used to
 * resolve an `env` SecretInput. That read now happens inside the host SDK
 * (`openclaw/plugin-sdk/secret-ref-readonly`), and this test keeps production
 * source from reintroducing a direct ambient read. The published runtime bundle is
 * checked with the same syntax-aware guard by `scripts/verify-runtime-package.mjs`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { findAmbientEnvAccess } from "../../scripts/ambient-env-guard.mjs";

const repoRoot = resolve(__dirname, "../..");

/** Documented non-credential exception: see docs/user/reference/security-policies.md. */
const ALLOWED_STATIC_ENV_KEYS = new Set(["DINGTALK_CARD_TEMPLATE_ID"]);

function productionSourceFiles(): string[] {
    const srcEntries = readdirSync(resolve(repoRoot, "src"), { recursive: true }) as string[];
    return [
        "index.ts",
        ...srcEntries.filter((entry) => entry.endsWith(".ts")).map((entry) => `src/${entry}`),
    ];
}

function findViolations(): string[] {
    const violations: string[] = [];

    for (const file of productionSourceFiles()) {
        const content = readFileSync(resolve(repoRoot, file), "utf8");
        for (const violation of findAmbientEnvAccess(content, {
            allowedEnvKeys: ALLOWED_STATIC_ENV_KEYS,
            fileName: file,
            scriptKind: ts.ScriptKind.TS,
        })) {
            violations.push(`${file}: ${violation}`);
        }
    }

    return violations;
}

describe("ambient environment access structure", () => {
    it("never reads ambient environment state in production source", () => {
        expect(findViolations()).toEqual([]);
    });

    it("keeps SecretInput env resolution delegated to the host read-only resolver", () => {
        const source = readFileSync(resolve(repoRoot, "src/platform/secret-input.ts"), "utf8");

        expect(source).toContain("resolveReadOnlyEnvSecretRef");
        expect(source).not.toMatch(/process\s*\.\s*env/u);
    });
});

describe("ambient env guard", () => {
    function violationsFor(source: string): string[] {
        return findAmbientEnvAccess(source, { allowedEnvKeys: ALLOWED_STATIC_ENV_KEYS });
    }

    it.each([
        ["dot access", 'const secret = process.env.DINGTALK_CLIENT_SECRET;'],
        ["optional chain", 'const secret = process?.env?.DINGTALK_CLIENT_SECRET;'],
        ["computed env key", 'const secret = process["env"].DINGTALK_CLIENT_SECRET;'],
        ["global object", 'const secret = globalThis.process.env.DINGTALK_CLIENT_SECRET;'],
        ["dynamic single key", "function read(id) { return process.env[id]; }"],
        ["bare environment", "const ambient = process.env;"],
        ["spread environment", "const copy = { ...process.env };"],
        ["destructured env", "const { env } = process;"],
        ["renamed destructured env", "const { env: e } = process;"],
        ["string key destructuring", 'const { "env": e } = process;'],
        ["computed string key destructuring", 'const { ["env"]: e } = process;'],
        ["dynamic key destructuring", "const { [key]: e } = process;"],
        ["object rest destructuring", "const { ...proc } = process;"],
        ["object rest assignment", "({ ...proc } = process);"],
        ["process alias", "const proc = process;"],
        ["process hand-off", "consume(process);"],
        ["process module env import", 'import { env } from "node:process";'],
        ["process module default import", 'import proc from "node:process";'],
        ["process module require", 'const proc = require("node:process");'],
        ["process module dynamic import", 'const proc = await import("node:process");'],
        ["dynamic process property key", "const key = \"env\"; const secret = process[key];"],
        ["concatenated process property key", 'const secret = process["en" + "v"];'],
        ["plain assignment alias", "let proc;\nproc = process;\nconst secret = proc.env.X;"],
        ["logical-or alias", "const proc = fallback || process;"],
        ["nullish assignment alias", "let proc;\nproc ??= process;"],
        ["conditional alias", "const proc = flag ? process : fallback;"],
        ["sequence alias", "const proc = (0, process);"],
        ["shorthand object alias", "const holder = { process };\nconst secret = holder.process.env.X;"],
    ])("rejects %s", (_label, source) => {
        expect(violationsFor(source).length).toBeGreaterThan(0);
    });

    it.each([
        [
            "the documented template id override",
            'const templateId = process.env.DINGTALK_CARD_TEMPLATE_ID || "builtin.schema";',
        ],
        [
            "the documented template id override through bracket access",
            'const templateId = process.env["DINGTALK_CARD_TEMPLATE_ID"] || "builtin.schema";',
        ],
        ["non-environment process access", "const cwd = process.cwd(); const os = process.platform;"],
        ["destructuring non-environment properties", "const { platform, arch } = process;"],
        ["a type-only process check", 'const hasProcess = typeof process !== "undefined";'],
        ["a type-level process reference", "type Env = typeof process.env;"],
        [
            "a non-environment destructuring assignment",
            "let platform;\n({ platform } = process);",
        ],
        [
            "a non-environment parameter default",
            "function readPlatform({ platform } = process) { return platform; }",
        ],
    ])("allows %s", (_label, source) => {
        expect(violationsFor(source)).toEqual([]);
    });
});
