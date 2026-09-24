import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationQueue } from "../assistant-notifications.mjs";

function setup(extra = {}) {
  let time = 1000000,
    id = 0;
  const timers = new Map(),
    deliveries = [],
    failures = [];
  const policy = { mode: "immediate", minutes: 15, quiet: false };
  const q = createNotificationQueue({
    now: () => time,
    policy: () => policy,
    setTimer: (fn, delay) => {
      timers.set(++id, { fn, at: time + delay });
      return id;
    },
    clearTimer: (key) => timers.delete(key),
    deliver: async (x) => {
      deliveries.push(x);
      return true;
    },
    failed: () => failures.push(true),
    ...extra,
  });
  return {
    q,
    policy,
    timers,
    deliveries,
    failures,
    async advance(ms) {
      time += ms;
      await q.flush();
    },
    due: () => [...timers.values()][0]?.at - time,
  };
}
test("immediate notifications coalesce for two seconds using one timer", async () => {
  const f = setup();
  f.q.mark({ attention: true });
  f.q.mark({ attention: true });
  assert.equal(f.timers.size, 1);
  assert.equal(f.due(), 2000);
  await f.advance(1999);
  assert.equal(f.deliveries.length, 0);
  await f.advance(1);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.timers.size, 0);
});
test("a second burst inside ten seconds has a guaranteed trailing delivery, not a fifteen-minute delay", async () => {
  const f = setup();
  f.q.mark({ attention: true });
  await f.advance(2000);
  f.q.mark({ attention: true });
  assert.equal(f.due(), 10000);
  await f.advance(9999);
  assert.equal(f.deliveries.length, 1);
  await f.advance(1);
  assert.equal(f.deliveries.length, 2);
});
test("new arrivals while delivery awaits are not lost when the earlier delivery completes", async () => {
  let release,
    count = 0;
  const f = setup({
    deliver: async () => {
      count++;
      if (count === 1)
        await new Promise((r) => {
          release = r;
        });
    },
  });
  f.q.mark({ attention: true });
  const pending = f.advance(2000);
  f.q.mark({ attention: true });
  release();
  await pending;
  await f.advance(10000);
  assert.equal(count, 2);
});
test("failed card delivery retains the pending burst and retries with backoff", async () => {
  let count = 0;
  const f = setup({
    deliver: async () => {
      if (++count === 1) throw Error("offline");
    },
  });
  f.q.mark({ attention: true });
  await f.advance(2000);
  assert.equal(f.failures.length, 1);
  assert.equal(f.due(), 30000);
  await f.advance(30000);
  assert.equal(count, 2);
  assert.equal(f.timers.size, 0);
});
test("manual mode suppresses pushes and choosing immediate later releases retained work", async () => {
  const f = setup();
  f.policy.mode = "manual";
  f.q.mark({ attention: true });
  await f.advance(60000);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.timers.size, 0);
  f.policy.mode = "immediate";
  f.q.kick();
  await f.advance(0);
  assert.equal(f.deliveries.length, 1);
});
test("quiet hours suppress priority notifications and preserve them until quiet hours end", async () => {
  const f = setup();
  f.policy.quiet = true;
  f.q.mark({ attention: true, priority: true });
  await f.advance(60000);
  assert.equal(f.deliveries.length, 0);
  f.policy.quiet = false;
  f.q.kick();
  await f.advance(0);
  assert.equal(f.deliveries.length, 1);
});
test("digest keeps its chosen interval; a priority draft can bypass that interval", async () => {
  const f = setup();
  f.policy.mode = "digest";
  f.q.mark({ attention: true });
  assert.equal(f.due(), 900000);
  await f.advance(30000);
  assert.equal(f.deliveries.length, 0);
  f.q.mark({ attention: true, priority: true });
  await f.advance(0);
  assert.equal(f.deliveries.length, 1);
});
test("successful automatic replies do not create immediate approval notifications", async () => {
  const f = setup();
  f.q.mark();
  await f.advance(900000);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.timers.size, 0);
  f.policy.mode = "digest";
  f.q.kick();
  await f.advance(0);
  assert.deepEqual(f.deliveries, [{ includeHistory: true }]);
});
test("stopping cancels pending delivery and future marks", async () => {
  const f = setup();
  f.q.mark({ attention: true });
  f.q.stop();
  f.q.mark({ attention: true });
  await f.advance(5000);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.timers.size, 0);
});
