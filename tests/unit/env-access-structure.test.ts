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
