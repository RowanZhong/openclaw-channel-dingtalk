// One pending timeout per instance. Revisions preserve arrivals during card delivery.
export function createNotificationQueue({
  policy,
  deliver,
  failed = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let next = 0,
    acknowledged = 0,
    lastSent = 0,
    firstAt,
    urgent = 0,
    actionable = 0,
    retryAt = 0,
    timer,
    busy = false,
    stopped = false;
  const clear = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  function deadline() {
    if (stopped || next === acknowledged) return;
    const p = policy();
    if (p.quiet || p.mode === "manual") return;
    const immediate =
      urgent > acknowledged || (p.mode === "immediate" && actionable > acknowledged);
    if (!immediate && p.mode !== "digest") return;
    return Math.max(
      retryAt,
      immediate
        ? Math.max(firstAt + 2000, lastSent ? lastSent + 10000 : 0)
        : (lastSent || firstAt) + p.minutes * 60000,
    );
  }
  function kick() {
    clear();
    if (busy) return;
    const due = deadline();
    if (due === undefined) return;
    timer = setTimer(
      () => {
        timer = undefined;
        void flush();
      },
      Math.max(0, due - now()),
    );
    timer?.unref?.();
  }
  async function flush() {
    if (busy || stopped) return;
    const due = deadline();
    if (due === undefined) {
      clear();
      return;
    }
    if (due > now()) {
      kick();
      return;
    }
    clear();
    const captured = next;
    busy = true;
    try {
      const sent = await deliver({ includeHistory: policy().mode === "digest" });
      acknowledged = captured;
      if (sent !== false) lastSent = now();
      retryAt = 0;
      if (next === captured) firstAt = undefined;
    } catch {
      retryAt = now() + 30000;
      failed();
    } finally {
      busy = false;
      kick();
    }
  }
  return {
    start() {
      clear();
      stopped = false;
      next = acknowledged = lastSent = urgent = actionable = retryAt = 0;
      firstAt = undefined;
    },
    mark({ attention = false, priority = false } = {}) {
      if (stopped) return;
      if (firstAt === undefined) firstAt = now();
      next++;
      if (attention) actionable = next;
      if (priority) urgent = next;
      kick();
    },
    kick,
    flush,
    stop() {
      stopped = true;
      clear();
    },
  };
}
