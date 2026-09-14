/**
 * Covers the ClawHub beta audit gate (`scripts/clawhub-beta-gate.mjs`).
 *
 * The gate is the only thing standing between a ClawScan verdict and a public
 * release, so its failure modes matter more than its happy path: every unknown,
 * missing, or unfinished trust input must fail closed, and `suspicious` must only
 * pass when the operator explicitly opted in.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const gateScript = resolve(repoRoot, "scripts/clawhub-beta-gate.mjs");
const workflowPath = resolve(repoRoot, ".github/workflows/clawhub-publish.yml");

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function createWorkDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "clawhub-beta-gate-"));
    tempDirs.push(dir);
    return dir;
}

function buildVerdict(trust: Record<string, unknown> | null): Record<string, unknown> {
    return {
        overview: "ClawScan found no material security concerns.",
        securityAuditUrl: "https://clawhub.ai/soimy/plugins/dingtalk/security-audit?version=1.2.3",
        package: { name: "@soimy/dingtalk", displayName: "DingTalk", family: "code-plugin" },
        release: { releaseId: "release-1", version: "1.2.3" },
        trust:
            trust === null
                ? null
                : {
                      scanStatus: "clean",
                      moderationState: null,
                      blockedFromDownload: false,
                      reasons: [],
                      pending: false,
                      stale: false,
                      ...trust,
                  },
    };
}

function runGate(options: {
    verdict?: unknown;
    raw?: string;
    env?: Record<string, string>;
    withFile?: boolean;
}): { status: number; stdout: string; stderr: string; result: Record<string, unknown> | null } {
    const dir = createWorkDir();
    const withFile = options.withFile ?? true;

    if (withFile) {
        const raw = options.raw ?? JSON.stringify(options.verdict ?? buildVerdict({}));
        writeFileSync(join(dir, "verdict.json"), raw, "utf8");
    }

    const exec = spawnSync(process.execPath, [gateScript, "verdict.json"], {
        cwd: dir,
        encoding: "utf8",
        env: {
            ...process.env,
            PACKAGE_NAME: "@soimy/dingtalk",
            BETA_VERSION: "1.2.3-beta.7.1",
            AUDIT_MODE: "release-gate",
            ALLOW_SUSPICIOUS: "",
            GITHUB_STEP_SUMMARY: "",
            ...options.env,
        },
    });

    const resultPath = join(dir, "gate-result.json");
    return {
        status: exec.status ?? -1,
        stdout: exec.stdout,
        stderr: exec.stderr,
        result: existsSync(resultPath)
            ? (JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>)
            : null,
    };
}

describe("clawhub beta gate policy", () => {
    it("passes a clean verdict", () => {
        const run = runGate({ verdict: buildVerdict({}) });

        expect(run.status).toBe(0);
        expect(run.result?.decision).toBe("pass");
        expect(run.result?.hardFailures).toEqual([]);
    });

    it("blocks suspicious by default and names the override", () => {
        const run = runGate({ verdict: buildVerdict({ scanStatus: "suspicious", reasons: ["scan:suspicious"] }) });

        expect(run.status).toBe(1);
        expect(run.result?.decision).toBe("fail");
        expect(String((run.result?.hardFailures as string[])[0])).toContain("ALLOW_SUSPICIOUS");
    });

    it("passes suspicious only with the explicit override", () => {
        const run = runGate({
            verdict: buildVerdict({ scanStatus: "suspicious", reasons: ["scan:suspicious"] }),
            env: { ALLOW_SUSPICIOUS: "1" },
        });

        expect(run.status).toBe(0);
        expect(run.result?.decision).toBe("pass-with-override");
        expect(run.result?.warnings).toHaveLength(1);
    });

    it.each([
        ["malicious scan status", { scanStatus: "malicious" }],
        ["not-run scan status", { scanStatus: "not-run" }],
        ["pending scan status", { scanStatus: "pending" }],
        ["download block", { blockedFromDownload: true }],
        ["unfinished trust inputs", { pending: true }],
        ["stale trust summary", { stale: true }],
        ["quarantined release", { moderationState: "quarantined" }],
        ["revoked release", { moderationState: "revoked" }],
        ["unknown scan status", { scanStatus: "something-new" }],
    ])("fails closed on %s", (_label, trust) => {
        const run = runGate({ verdict: buildVerdict(trust) });

        expect(run.status).toBe(1);
        expect(run.result?.decision).toBe("fail");
        expect((run.result?.hardFailures as string[]).length).toBeGreaterThan(0);
    });

    it("fails closed when the response has no trust object", () => {
        const run = runGate({ verdict: buildVerdict(null) });

        expect(run.status).toBe(1);
        expect(String((run.result?.hardFailures as string[])[0])).toContain("trust");
    });

    it("fails closed on malformed JSON", () => {
        const run = runGate({ raw: "{ not json" });

        expect(run.status).toBe(1);
        expect(String((run.result?.hardFailures as string[])[0])).toContain("JSON");
    });

    it("fails closed when the verdict file is missing", () => {
        const run = runGate({ withFile: false });

        expect(run.status).toBe(1);
        expect(run.result?.ok).toBe(false);
    });

    it("records the trust evidence for the CI artifact", () => {
        const run = runGate({
            verdict: buildVerdict({ scanStatus: "suspicious", reasons: ["scan:suspicious"] }),
            env: { ALLOW_SUSPICIOUS: "1", AUDIT_MODE: "manual" },
        });

        expect(run.result).toMatchObject({
            ok: true,
            packageName: "@soimy/dingtalk",
            betaVersion: "1.2.3-beta.7.1",
            auditMode: "manual",
            allowSuspicious: true,
            scanStatus: "suspicious",
            reasons: ["scan:suspicious"],
            securityAuditUrl: "https://clawhub.ai/soimy/plugins/dingtalk/security-audit?version=1.2.3",
        });
    });

    it("prints the ClawScan overview for the operator", () => {
        const run = runGate({ verdict: buildVerdict({}) });

        expect(run.stdout).toContain("ClawScan found no material security concerns.");
    });
});

describe("clawhub publish workflow wiring", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    it("gates the release job on the audit job", () => {
        expect(workflow).toContain("needs: audit");
        expect(workflow).toContain("if: ${{ inputs.audit_only != true }}");
    });

    it("publishes the audit build on a dedicated tag and waits for the verdict", () => {
        expect(workflow).toContain("--tags audit");
        expect(workflow).toContain("--wait");
        expect(workflow).toContain("--wait-timeout 2400");
    });

    it("keeps a CLI version that supports --wait and restorable withdrawal", () => {
        expect(workflow).not.toContain("clawhub@0.23.1");
        expect(workflow).toContain("clawhub@0.23.3");
        expect(workflow).toContain("clawhub package delete");
    });

    it("withdraws the audit build only for release publishes", () => {
        expect(workflow).toContain(
            "if: ${{ always() && steps.release.outputs.beta_version != '' && steps.release.outputs.audit_only != 'true' }}",
        );
    });

    it("uses the public version-exact security endpoint as the gate input", () => {
        expect(workflow).toContain("/versions/${AUDIT_VERSION}/security");
        expect(workflow).toContain("scripts/clawhub-beta-gate.mjs verdict.json");
    });
});
