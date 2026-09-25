// Local scheduling/validation microbenchmark; no provider, DWS or network requests.
import { performance } from "node:perf_hooks";
import { createTopicQueue } from "../assistant-topic-model.mjs";
import { normalizeTopicDecision } from "../assistant-topic-rules.mjs";
const rules = Array.from({ length: 20 }, (_, i) => ({ id: `topic-${i}` }));
const decision = { outcome: "match", ruleIds: ["topic-19"], coversWholeMessage: true, reason: "matched" };
global.gc?.();
const before = process.memoryUsage(), cpuBefore = process.cpuUsage(), start = performance.now();
for (let i = 0; i < 50000; i++) normalizeTopicDecision(decision, rules);
const validationMs = performance.now() - start;
let active = 0, peakActive = 0, calls = 0;
const queue = createTopicQueue({ complete: async () => {
  calls++; active++; peakActive = Math.max(peakActive, active);
  await new Promise((r) => setTimeout(r, 2)); active--; return decision;
} });
const burstStart = performance.now();
const results = await Promise.all(Array.from({ length: 2000 }, () => queue.run("public test message", rules)));
const burstMs = performance.now() - burstStart, cpu = process.cpuUsage(cpuBefore), after = process.memoryUsage();
global.gc?.();
console.log(JSON.stringify({ kind: "local-microbenchmark-not-capacity-test", node: process.version, platform: process.platform, arch: process.arch,
  externalRequests: 0, validation: { iterations: 50000, rules: 20, elapsedMs: +validationMs.toFixed(2) },
  burst: { submitted: 2000, acceptedModelCalls: calls, busyFallback: results.filter((x) => x.reason === "busy").length,
    peakActive, elapsedMs: +burstMs.toFixed(2) },
  processMemory: { rssBeforeMiB: +(before.rss / 1048576).toFixed(2), rssAfterMiB: +(after.rss / 1048576).toFixed(2),
    heapBeforeMiB: +(before.heapUsed / 1048576).toFixed(2), heapAfterGCMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2) },
  cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(2),
  limits: "Synthetic model latency; excludes real provider/network, Gateway, DWS and DingTalk card cost; not a 15000-Pod validation." }, null, 2));
