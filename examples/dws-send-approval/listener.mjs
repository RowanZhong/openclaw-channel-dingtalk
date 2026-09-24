import { spawn } from "node:child_process";
import { assertApprovalRouting } from "./config.mjs";
import { buildRunRequest, createLineReader, readMessageEvent } from "./ingress.mjs";
import { PreferenceStore, validatePreferences } from "./preferences.mjs";
import { matchesRules, replySnapshot, subscriptionPlan } from "./rules.mjs";

export function createListenerService(api, config, store, dependencies = {}) {
  const spawnChild = dependencies.spawn ?? spawn;
  const preferences = new PreferenceStore(config);
  const queue = new Map();
  let context,
    children = [],
    generation = 0,
    accepting = false,
    closed = true;
  let active = false,
    admissionBlocked = false,
    failure = "",
    planKey = "",
    control = Promise.resolve();
  const allReady = () => accepting && children.length > 0 && children.every((item) => item.ready);
  const fail = (reason) => {
    accepting = false;
    generation++;
    queue.clear();
    failure = reason;
    for (const item of children) {
      clearTimeout(item.timer);
      item.ready = false;
      item.child.stdin?.end();
      item.child.kill("SIGTERM");
    }
    context?.logger.error(`[DWSApproval] ${reason}; listener stopped; no automatic restart`);
    context?.serviceHealth?.reportFailure(new Error(reason));
  };
  const drain = async () => {
    if (!allReady() || active || admissionBlocked || closed) {
      return;
    }
    active = true;
    try {
      while (allReady() && !closed && queue.size) {
        const [key, event] = queue.entries().next().value;
        queue.delete(key);
        const current = preferences.snapshot();
        if (!current.enabled || !matchesRules(event, current)) {
          continue;
        }
        const reply = replySnapshot(event, current);
        if (reply.mode === "off") {
          continue;
        }
        if (dependencies.processEvent) {
          await dependencies.processEvent(event, current, reply);
          continue;
        }
        const record = await store.claim(event, reply);
        // An off/scope change while persistence awaited must not admit stale work.
        const latest = preferences.snapshot();
        if (
          !record ||
          closed ||
          !accepting ||
          !latest.enabled ||
          latest.revision !== current.revision
        ) {
          continue;
        }
        const result = await api.runtime.subagent.run(
          buildRunRequest(event, { ...record, reply }, config),
        );
        if (!result?.runId || (result.sessionKey && result.sessionKey !== record.sessionKey)) {
          admissionBlocked = true;
          fail("Gateway returned an unexpected listener run identity");
          break;
        }
        const deadline = Date.now() + 600_000;
        let terminal = false;
        // Off stops ingress, not the already admitted run. Keep this single-flight
        // lock even across off/on and subscription replacement while approval waits.
        while (!closed && Date.now() < deadline) {
          const state = await api.runtime.subagent.waitForRun({
            runId: result.runId,
            timeoutMs: 30_000,
          });
          if (state.status === "ok" || state.status === "error") {
            terminal = true;
            break;
          }
          if (state.status !== "timeout") {
            throw new Error("unexpected run status");
          }
        }
        if (!closed && !terminal) {
          admissionBlocked = true;
          fail(
            "Listener task did not finish within ten minutes; restart required after checking active task",
          );
        }
      }
    } catch {
      admissionBlocked = true;
      fail("Listener task admission, persistence or wait failed");
    } finally {
      active = false;
      if (allReady() && queue.size && !admissionBlocked && !closed) {
        void drain();
      }
    }
  };
  const stopChildren = async () => {
    accepting = false;
    generation++;
    const previous = children;
    await Promise.all(
      previous.map(async ({ child, timer }) => {
        clearTimeout(timer);
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        const done = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            child.off("exit", finish);
            resolve(false);
          }, 5000);
          const finish = () => {
            clearTimeout(timeout);
            resolve(true);
          };
          child.once("exit", finish);
        });
        child.stdin?.end();
        child.kill("SIGTERM");
        if (!(await done)) {
          throw new Error("DWS did not stop gracefully; no replacement started");
        }
      }),
    );
    children = [];
    planKey = "";
  };
  const startPlans = (plans) => {
    const token = ++generation;
    accepting = true;
    failure = "";
    for (const plan of plans) {
      if (!accepting) {
        break;
      }
      let child;
      try {
        child = spawnChild(config.dwsPath, plan.args, {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        fail("Cannot start DWS executable");
        break;
      }
      const item = { child, ready: false, timer: undefined };
      children.push(item);
      const valid = () => accepting && token === generation && !closed;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on(
        "data",
        createLineReader(
          (line) => {
            if (!valid()) {
              return;
            }
            let event;
            try {
              event = readMessageEvent(line, config, plan);
            } catch {
              fail("Invalid DWS flattened event");
              return;
            }
            if (
              !event ||
              !matchesRules(event, preferences.snapshot()) ||
              store.has(event) ||
              dependencies.has?.(event)
            ) {
              return;
            }
            const key = store.messageKeyFor(event);
            const previous = queue.get(key);
            if (previous) {
              previous.observedTypes = [
                ...new Set([...(previous.observedTypes ?? [previous.type]), event.type]),
              ];
              return;
            }
            if (queue.size >= 100) {
              fail("Listener queue reached its limit");
              return;
            }
            queue.set(key, event);
            void drain();
          },
          () => {
            if (valid()) {
              fail("DWS event line exceeded its size limit");
            }
          },
        ),
      );
      child.stderr.on(
        "data",
        createLineReader(
          (line) => {
            if (!valid() || item.ready) {
              return;
            }
            const match = /^\[event\] ready (event_key|event_count)=([^\s]+)(?:\s|$)/.exec(line);
            if (
              !match ||
              !(match[1] === "event_count"
                ? match[2] === String(plan.keys.length)
                : plan.keys.length === 1 && match[2] === plan.keys[0])
            ) {
              return;
            }
            item.ready = true;
            clearTimeout(item.timer);
            if (allReady() && children.length === plans.length) {
              context.serviceHealth?.clearFailure();
              context.logger.info("[DWSApproval] listener ready");
              void drain();
            }
          },
          () => {
            if (valid()) {
              fail("DWS diagnostic line exceeded its size limit");
            }
          },
        ),
      );
      child.on("error", () => {
        if (valid()) {
          fail("DWS process failed to start");
        }
      });
      child.stdin.on("error", () => {
        if (valid()) {
          fail("DWS stdin closed unexpectedly");
        }
      });
      child.on("exit", () => {
        if (valid()) {
          fail("DWS process exited");
        }
      });
      item.timer = setTimeout(() => {
        if (valid()) {
          fail("DWS ready marker timed out");
        }
      }, 60_000);
      item.timer.unref?.();
    }
  };
  const checkStart = (value) => {
    if (!subscriptionPlan(value, config).length) {
      throw new Error("尚未选择监听范围，请先配置 dm、at 或 sender。");
    }
    if (
      (value.rules.dm.mode !== "off" || value.rules.sender.mode !== "off") &&
      !config.listener.ignoreSenderOpenIds.length
    ) {
      throw new Error("平台尚未配置审批机器人开放 ID，不能开启私聊或指定发送者监听。");
    }
    if (config.listener.ignoreSenderOpenIds.some((id) => value.rules.sender.ids.includes(id))) {
      throw new Error("不能监听审批机器人自身，请移除该发送者。");
    }
    if (admissionBlocked) {
      throw new Error("上次任务状态不明确，请管理员检查后重启服务；禁止重复派发。");
    }
    if (dependencies.checkStart) {
      dependencies.checkStart();
    } else {
      assertApprovalRouting(context.config, config);
    }
  };
  const reconcile = async (value) => {
    if (!value.enabled) {
      queue.clear();
      await stopChildren();
      failure = "";
      return;
    }
    checkStart(value);
    for (const [key, event] of queue) {
      if (!matchesRules(event, value)) {
        queue.delete(key);
      }
    }
    const plans = subscriptionPlan(value, config),
      key = JSON.stringify(plans);
    if (accepting && key === planKey) {
      void drain();
      return;
    }
    await stopChildren();
    planKey = key;
    startPlans(plans);
  };
  const serialize = (operation) => {
    const result = control.then(operation);
    control = result.catch(() => {});
    return result;
  };
  return {
    id: "dws-send-approval-listener",
    snapshot: () => preferences.snapshot(),
    status() {
      return {
        preferences: preferences.snapshot(),
        state: closed
          ? "unavailable"
          : failure
            ? "failed"
            : allReady()
              ? "ready"
              : accepting
                ? "starting"
                : "off",
        failure,
        queued: queue.size,
        active,
        consumers: children.length,
      };
    },
    update(mutator) {
      return serialize(async () => {
        if (closed) {
          throw new Error("监听服务尚未就绪。");
        }
        const next = preferences.snapshot();
        mutator(next);
        next.revision++;
        // Validate before saving, so an invalid enabled scope cannot replace a working configuration.
        const checked = validatePreferences(next);
        if (checked.enabled) {
          checkStart(checked);
        }
        const saved = await preferences.save(checked);
        try {
          await reconcile(saved);
        } catch {
          fail("Cannot apply listener preferences; inspect service status before retry");
        }
        return this.status();
      });
    },
    async start(ctx) {
      if (!closed) {
        throw new Error("DWS listener already started");
      }
      context = ctx;
      await store.load(ctx.stateDir);
      await preferences.load(ctx.stateDir);
      closed = false;
      try {
        await reconcile(preferences.snapshot());
      } catch {
        fail("Listener startup validation failed; use status and check configuration");
      }
    },
    stop() {
      return serialize(async () => {
        closed = true;
        queue.clear();
        await stopChildren();
      });
    },
  };
}
