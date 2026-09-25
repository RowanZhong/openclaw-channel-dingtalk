import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createIdentityService } from "./identity-service.mjs";
import { registerControlCommands } from "./commands.mjs";
import { isOwnerPrivateCommand } from "./commands.mjs";
import { assertHostVersion, readConfig } from "./config.mjs";
import { createPolicy } from "./policy.mjs";
import { runtimeBinding } from "./runtime-binding.mjs";
import { SourceStore } from "./source-store.mjs";

export default definePluginEntry({
  id: "dws-send-approval",
  name: "DWS Reply Assistant",
  description: "Owner-controlled personal IM drafts, cards and exact-answer automation.",
  register(api) {
    if (process.platform === "win32") {
      throw new Error("DWS approval currently requires Linux/macOS POSIX exec");
    }
    assertHostVersion(api.runtime.version);
    const config = readConfig(api.pluginConfig, { discovery: true });
    const store = new SourceStore(config);
    if (
      !config.assistant.enabled &&
      (typeof api.runtime.subagent?.run !== "function" ||
        typeof api.runtime.subagent?.waitForRun !== "function")
    ) {
      throw new Error("OpenClaw plugin subagent runtime is required");
    }
    const binding = runtimeBinding(config);
    const policy = createPolicy(config, store);
    api.on("before_tool_call", (...args) => (binding.peek()?.policy ?? policy)(...args), {
      priority: 1000,
    });
    const identity = createIdentityService(api, config);
    registerControlCommands(api, config, {
      status: (...args) =>
        binding
          .require()
          .requireRuntime()
          .service.status(...args),
      presentationDirectory: (...args) =>
        binding
          .require()
          .requireRuntime()
          .assistant?.presentationDirectory(...args) ?? [],
      snapshot: (...args) =>
        binding
          .require()
          .requireRuntime()
          .service.snapshot(...args),
      update: async (...args) => (await binding.require().ready()).service.update(...args),
    });
    {
      for (const name of ["dws", ...(config.assistant.enabled ? ["ok", "no", "edit"] : [])]) {
        api.registerCommand({
          name,
          description: name === "dws" ? "打开钉钉代回复助手" : "处理指定的代回复草稿",
          channels: ["dingtalk"],
          acceptsArgs: true,
          requireAuth: true,
          async handler(ctx) {
            if (!isOwnerPrivateCommand(ctx, config)) {
              return { text: "仅允许本人在机器人私聊中操作。" };
            }
            const args = (ctx.args ?? "").trim();
            try {
              const active = binding.require();
              if (name === "dws" && ["identity", "identity refresh"].includes(args)) {
                if (args === "identity refresh") {
                  void active.refresh(true);
                  return {
                    text: "已开始后台身份检测，主会话可继续使用。稍后发送 /dws identity 查看结果。",
                  };
                }
                return { text: active.text() };
              }
              const assistant = (await active.ready()).assistant;
              if (!assistant)
                return { text: "助手卡片未启用。可使用 /dws identity 或 /dws identity refresh。" };
              if (name === "dws") {
                if (args === "list") {
                  return { text: assistant.textPreview() };
                }
                const match = /^show (\d+)$/.exec(args);
                if (match) {
                  return { text: assistant.textPreview(Number(match[1])) };
                }
                if (args) {
                  throw new Error(
                    "用法：/dws 打开卡片；/dws list 文字列表；/dws show <编号> 查看草稿；/dws identity 查看身份；/dws identity refresh 重新检测。",
                  );
                }
                try {
                  await assistant.show();
                } catch {
                  return { text: "卡片暂不可用。\n" + assistant.textPreview() };
                }
              } else {
                const match = /^(\d+)-(\d+)(?:\s+([\s\S]+))?$/.exec(args);
                if (!match || (name === "edit") !== Boolean(match[3])) {
                  throw new Error(
                    `用法：/${name} <编号-版本>${name === "edit" ? " <正文>" : ""}。先 /dws show <编号> 查看正文。`,
                  );
                }
                return {
                  text: await assistant.command(
                    name,
                    { id: Number(match[1]), version: Number(match[2]) },
                    match[3],
                  ),
                };
              }
              return { text: "已更新代回复卡片。" };
            } catch (error) {
              return { text: `操作未完成：${error.code ? "请检查服务状态。" : error.message}` };
            }
          },
        });
      }
    }
    api.registerService({
      id: identity.id,
      start(ctx) {
        binding.publish(identity);
        identity.start(ctx);
      },
      async stop() {
        binding.remove(identity);
        await identity.stop();
      },
    });
  },
});
