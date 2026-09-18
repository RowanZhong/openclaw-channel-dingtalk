import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/channel", () => ({ dingtalkPlugin: {} }));
vi.mock("../../src/platform/runtime", () => ({ setDingTalkRuntime: vi.fn() }));

describe("form tool discovery contract", () => {
  let entry: (typeof import("../../index"))["default"];
  beforeAll(async () => {
    // Load the SDK graph once; cold coverage instrumentation can exceed the per-test limit.
    entry = (await import("../../index")).default;
  }, 30_000);

  it.each(["tool-discovery", "discovery", "full"])("exposes declared callable form tools in %s mode", async (registrationMode) => {
    const names: string[] = [];
    entry.register({
      registrationMode,
      config: {}, runtime: {}, pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: (factory: any) => {
        const tool = factory({ agentId: "main", sessionKey: "agent:main:cron:test:trigger" });
        expect(tool.execute).toBeTypeOf("function");
        names.push(tool.name);
      },
      registerChannel: vi.fn(), registerGatewayMethod: vi.fn(), on: vi.fn(),
    } as unknown as OpenClawPluginApi);
    const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"));
    // Native cron filters by manifest before loading factories. A registered-only tool is invisible.
    expect(names.sort()).toEqual([...manifest.contracts.tools].sort());
    expect(names).toContain("dingtalk_form_schedule");
  });
});
