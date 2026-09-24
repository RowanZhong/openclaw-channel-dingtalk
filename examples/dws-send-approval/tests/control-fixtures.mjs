import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { registerControlCommands } from "../commands.mjs";
import { readConfig } from "../config.mjs";
import { createListenerService } from "../listener.mjs";
import { SourceStore } from "../source-store.mjs";
import { host } from "./fixtures.mjs";
export const owner = {
  channel: "dingtalk",
  accountId: "default",
  senderId: "owner",
  from: "owner",
  to: "owner",
  sessionKey: "agent:main:main",
  agentId: "main",
  isAuthorizedSender: true,
};
export const settings = readConfig({
  ownerUserId: "owner",
  profile: "work",
  dwsPath: "/opt/bin/dws",
  listener: { ignoreSenderOpenIds: ["approval-bot"] },
});
export async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(predicate(), "condition did not settle");
}
export async function controls(t, runtime = {}, config = settings, folder) {
  folder ??= await mkdtemp(join(tmpdir(), "dws-controls-"));
  const sources = new SourceStore(config),
    children = [],
    runs = [],
    commands = new Map(),
    logs = [];
  const api = {
    registerCommand: (command) => commands.set(command.name, command),
    runtime: {
      subagent: {
        run: async (request) => {
          runs.push(request);
          return { runId: `r${runs.length}`, sessionKey: request.sessionKey };
        },
        waitForRun: async () => ({ status: "ok" }),
        ...runtime,
      },
    },
  };
  const service = createListenerService(api, config, sources, {
    spawn(file, args, options) {
      assert.equal(options.shell, false);
      const child = Object.assign(new EventEmitter(), {
        file,
        args,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
      });
      child.kill = (signal) => {
        child.signalCode = signal;
        child.emit("exit");
        return true;
      };
      child.ready = () => {
        const keys = args.filter((arg) => arg.startsWith("user_im_"));
        child.stderr.write(`[event] ready event_count=${keys.length}\n`);
      };
      child.emitMessage = (event) => child.stdout.write(JSON.stringify(event) + "\n");
      children.push(child);
      return child;
    },
  });
  registerControlCommands(api, config, service);
  await service.start({
    config: host,
    stateDir: folder,
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
  });
  t.after(async () => {
    await service.stop();
    await rm(folder, { recursive: true, force: true });
  });
  const command = async (name, args, ctx = owner) =>
    (await commands.get(name).handler({ ...ctx, args })).text;
  return {
    service,
    sources,
    children,
    runs,
    config,
    folder,
    commands,
    logs,
    command,
    listen: (args, ctx) => command("dws-listen", args, ctx),
    reply: (args, ctx) => command("dws-reply", args, ctx),
  };
}
