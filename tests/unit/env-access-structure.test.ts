/**
 * Guards the ambient-environment access surface at the source level.
 *
 * ClawHub's `suspicious.env_credential_access` rule ("environment variable access
 * combined with network send") stayed open on the single-key env read that used to
 * resolve an `env` SecretInput. That read now happens inside the host SDK
 * (`openclaw/plugin-sdk/secret-ref-readonly`), and this test keeps production
 * source from reintroducing a direct ambient read. The published runtime bundle is
 * checked independently by `scripts/verify-runtime-package.mjs`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

function readProductionSource(): Array<{ file: string; content: string }> {
    return productionSourceFiles().map((file) => ({
        file,
        content: readFileSync(resolve(repoRoot, file), "utf8"),
    }));
}

describe("ambient environment access structure", () => {
    it("never indexes the ambient environment in production source", () => {
        const offenders = readProductionSource()
            .filter(({ content }) => /process\s*\.\s*env\s*\[/u.test(content))
            .map(({ file }) => file);

        expect(offenders).toEqual([]);
    });

    it("reads only the documented static environment key in production source", () => {
        const staticEnvRead = /process\s*\.\s*env\s*\.\s*([A-Za-z_$][\w$]*)/gu;
        const offenders: string[] = [];

        for (const { file, content } of readProductionSource()) {
            for (const [, key] of content.matchAll(staticEnvRead)) {
                if (!ALLOWED_STATIC_ENV_KEYS.has(key)) {
                    offenders.push(`${file}: ${key}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it("never hands the bare ambient environment to a secret resolver", () => {
        const offenders = readProductionSource()
            .filter(({ content }) => /\benv\s*:\s*process\s*\.\s*env\b/u.test(content))
            .map(({ file }) => file);

        expect(offenders).toEqual([]);
    });

    it("keeps SecretInput env resolution delegated to the host read-only resolver", () => {
        const source = readFileSync(resolve(repoRoot, "src/platform/secret-input.ts"), "utf8");

        expect(source).toContain("resolveReadOnlyEnvSecretRef");
        expect(source).not.toMatch(/process\s*\.\s*env/u);
    });
});
