import { readdir, stat, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { join } from "node:path";
// Local control-plane benchmark. All model, directory and DingTalk/DWS effects are inert.
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fixture } from "../tests/assistant-fixture.mjs";
const cleanup = [];
let sent = 0,
  models = 0,
  cards = 0;
const f = await fixture(
  { after: (fn) => cleanup.push(fn) },
  {
    send: async () => {
      sent++;
    },
    draft: async () => {
      models++;
      return "收到，我确认后答复。";
    },
    transport: {
      sendCard: async () => {
        cards++;
      },
      updateCard: async () => {
        cards++;
      },
    },
  },
);
const settings = f.assistant.store.get("settings");
settings.notifications.mode = "manual";
f.assistant.store.set("settings", settings);
const mib = (n) => Math.round((n / 1048576) * 100) / 100;
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
try {
  global.gc?.();
  const before = process.memoryUsage(),
    idleCPU = process.cpuUsage();
  const idleStart = performance.now();
  await new Promise((r) => setTimeout(r, 10000));
  const idleMs = performance.now() - idleStart,
    idleUsed = process.cpuUsage(idleCPU);
  const times = [],
    cpu = process.cpuUsage(),
    start = performance.now();
  let peak = before.rss;
  for (let i = 0; i < 1000; i++) {
    const started = performance.now(),
      d = await f.incoming(
        f.event({
          conversation_id: `conversation_${i % 50}`,
          content: "请确认明天的安排。这是一条合成测试消息。",
        }),
      );
    if (i % 5 === 0) {
      await f.assistant.command("ok", { id: d.id, version: d.version });
    }
    if (i % 25 === 0) {
      await f.assistant.show("inbox");
    }
    times.push(performance.now() - started);
    peak = Math.max(peak, process.memoryUsage().rss);
    await new Promise(setImmediate);
  }
  const durationMs = performance.now() - start,
    used = process.cpuUsage(cpu),
    after = process.memoryUsage();
  times.sort((a, b) => a - b);
  let bytes = 0;
  for (const name of await readdir(join(f.dir, "dws-send-approval"))) {
    bytes += (await stat(join(f.dir, "dws-send-approval", name))).size;
  }
  const result = {
    date: new Date().toISOString(),
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0].model,
    scope:
      "Single standalone assistant; mock model/DWS/card transport; no network, no full OpenClaw Gateway, no DWS consumer/bus processes; not a 15000-Pod capacity test",
    messages: 1000,
    conversations: 50,
    modelCalls: models,
    inertSends: sent,
    cardOperations: cards,
    pending: f.assistant.store.list(["pending"]).length,
    idle: {
      durationMs,
      cpuMs: (idleUsed.user + idleUsed.system) / 1000,
      corePercent: ((idleUsed.user + idleUsed.system) / 1000 / idleMs) * 100,
    },
    load: {
      durationMs,
      eventsPerSecond: 1000000 / durationMs,
      p50Ms: times[499],
      p95Ms: times[949],
      p99Ms: times[989],
      cpuMs: (used.user + used.system) / 1000,
      eventLoopP99Ms: loop.percentile(99) / 1e6,
    },
    memory: {
      baselineRssMiB: mib(before.rss),
      peakRssMiB: mib(peak),
      endRssMiB: mib(after.rss),
      heapUsedMiB: mib(after.heapUsed),
      databaseAndWalMiB: mib(bytes),
    },
  };
  result.idle.durationMs = idleMs;
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (process.argv[2]) {
    await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
  }
} finally {
  loop.disable();
  for (const fn of cleanup) {
    await fn();
  }
}
