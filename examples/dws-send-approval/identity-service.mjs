import { createAssistant } from "./assistant.mjs";
import { sendExact } from "./assistant-dws.mjs";
import { createListenerService } from "./listener.mjs";
import { SourceStore } from "./source-store.mjs";
import { createPolicy } from "./policy.mjs";
import { runIdentityCli, IdentityError, cancelled } from "./identity-cli.mjs";
import {
  channelRobot,
  selectProfile,
  makeBinding,
  sameBinding,
  readIdentity,
  writeIdentity,
  validRobotCache,
  validOwnerCache,
  discoverOwner,
  discoverRobot,
} from "./identity-discovery.mjs";

const labels = {
  starting: "正在检测",
  ready: "已就绪",
  waiting_login: "等待 DWS 登录",
  account_mismatch: "账号绑定不匹配",
  failed: "检测失败",
  unavailable: "配置或程序不可用",
  stopped: "服务已停止",
};
const clean = (value) =>
  String(value ?? "")
    .replace(/[\p{C}`*_<>\[\]]/gu, " ")
    .slice(0, 512);

export function createIdentityService(api, config, dependencies = {}) {
  const runner = dependencies.runner ?? runIdentityCli;
  const now = dependencies.now ?? Date.now;
  let context,
    running,
    retiring,
    record,
    task,
    aborter,
    startupTimer,
    retryTimer,
    closed = true,
    retryCount = 0;
  let state = "stopped",
    detail = "",
    cached = false,
    forceQueued = false;
  const fallback = createPolicy(config, new SourceStore(config));
  const check = (signal = aborter?.signal) => {
    if (closed || signal?.aborted) throw cancelled();
  };
  const fail = (error) => {
    state = error instanceof IdentityError ? error.identityState : "failed";
    detail =
      error instanceof IdentityError
        ? error.message
        : "身份初始化失败，请检查状态目录权限及原有账号绑定。";
    // Expected dependency states must not poison Gateway health/readiness.
    context?.logger?.warn?.(`[DWSIdentity] state=${state}; ${detail}`);
  };
  const callWith =
    (signal) =>
    (args, timeoutMs = 10000) => {
      check(signal);
      return runner(config, args, { signal, timeoutMs });
    };
  const profile = async (signal = aborter.signal) => {
    const call = callWith(signal);
    const selected = selectProfile(
      await call(["profile", "list", "--format", "json"], 5000),
      config,
    );
    check(signal);
    return makeBinding(selected, config, channelRobot(config, context.config));
  };
  let botTask;
  const prepareBot = ({ verifyProfile = true, force = false } = {}) => {
    if (botTask) return botTask;
    const parent = aborter.signal;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(dependencies.budgetMs ?? 30000)]);
    const call = callWith(signal);
    botTask = (async () => {
      if (verifyProfile && !sameBinding(await profile(signal), record.binding)) {
        throw new IdentityError(
          "account_mismatch",
          "DWS 当前身份已变化，代回复已暂停，请核对后重新检测。",
        );
      }
      check(signal);
      if (!force && validRobotCache(record, now()) && validOwnerCache(record, now())) {
        cached = true;
        return;
      }
      const owner =
        !force && validOwnerCache(record, now())
          ? record.owner
          : await discoverOwner(record.binding, call, now);
      const robot =
        !force && validRobotCache(record, now())
          ? record.robot
          : await discoverRobot(record.binding, call, now);
      if (owner.openId === robot.openId)
        throw new IdentityError("failed", "本人与机器人的开放 ID 相同，未启用监听。");
      check(signal);
      const next = { ...record, owner, robot };
      await writeIdentity(context.stateDir, next, signal);
      check(signal);
      record = next;
      cached = false;
    })()
      .catch((error) => {
        if (signal.aborted && !parent.aborted)
          error = new IdentityError("failed", "机器人身份查询超时。", true);
        if (!closed && !parent.aborted) fail(error);
        throw error;
      })
      .finally(() => {
        botTask = undefined;
      });
    return botTask;
  };
  const dispose = async (value) => {
    if (!value) return;
    // Close the assistant immediately to prevent queued sends, then stop ingress.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => value.assistant?.stop()),
      Promise.resolve().then(() => value.service.stop()),
    ]);
    if (results.some((r) => r.status === "rejected")) {
      throw new IdentityError(
        "failed",
        "旧监听尚未正常停止，未创建替代运行时；请稍后重新检测或联系管理员。",
      );
    }
  };
  const buildRuntime = async (resolved) => {
    if (dependencies.buildRuntime)
      return dependencies.buildRuntime(resolved, context, { prepareBot, signal: aborter.signal });
    const store = new SourceStore(resolved);
    const assistant = resolved.assistant.enabled
      ? createAssistant(api, resolved, {
          send: async (draft) => {
            if (
              closed ||
              aborter?.signal.aborted ||
              state !== "ready" ||
              !record.robot ||
              !record.owner
            ) {
              throw Object.assign(
                new IdentityError("failed", "身份尚未就绪，请先 /dws identity refresh；未发送。"),
                { noSend: true },
              );
            }
            if (
              [record.owner.openId, record.robot.openId].includes(
                draft.event.sender_open_dingtalk_id,
              )
            ) {
              throw Object.assign(
                new IdentityError("failed", "不能对本人或审批机器人发出的消息代回复。"),
                { noSend: true },
              );
            }
            return sendExact(resolved, draft);
          },
        })
      : undefined;
    const service = createListenerService(api, resolved, store, {
      prepareStart: prepareBot,
      ...(assistant
        ? {
            processEvent: assistant.processEvent,
            has: assistant.has,
            checkStart: assistant.checkReady,
          }
        : {}),
    });
    assistant?.bind(service);
    const result = { assistant, service, policy: createPolicy(resolved, store) };
    try {
      await assistant?.start(context);
      check();
      await service.start({ ...context, serviceHealth: undefined });
      check();
      return result;
    } catch (error) {
      retiring = result;
      await dispose(result);
      retiring = undefined;
      throw error;
    }
  };
  const initialize = async (force) => {
    retiring = running ?? retiring;
    running = undefined;
    await botTask?.catch(() => {});
    await dispose(retiring);
    retiring = undefined;
    check();
    const binding = await profile();
    record = await readIdentity(context.stateDir, binding);
    check();
    await writeIdentity(context.stateDir, record, aborter.signal);
    cached = Boolean(record.robot);
    if (force) await prepareBot({ verifyProfile: false, force: true });
    check();
    // Stable profile per runtime; only the verified bot exclusion is filled lazily.
    const resolved = Object.freeze({
      ...config,
      profile: binding.profile,
      listener: Object.freeze({
        ...config.listener,
        get ignoreSenderOpenIds() {
          return [
            ...new Set([
              ...(record?.robot ? [record.robot.openId] : []),
              ...(record?.owner ? [record.owner.openId] : []),
              ...config.listener.ignoreSenderOpenIds,
            ]),
          ];
        },
      }),
    });
    const next = await buildRuntime(resolved);
    if (closed || aborter.signal.aborted) {
      retiring = next;
      await dispose(next);
      retiring = undefined;
      throw cancelled();
    }
    running = next;
    state = "ready";
    detail = "";
    retryCount = 0;
  };
  const refresh = (force = false, automatic = false) => {
    if (closed) return Promise.resolve();
    if (task) {
      forceQueued ||= force;
      return task;
    }
    clearTimeout(startupTimer);
    clearTimeout(retryTimer);
    state = "starting";
    detail = "";
    task = (async () => {
      do {
        force ||= forceQueued;
        forceQueued = false;
        aborter?.abort();
        aborter = new AbortController();
        const current = aborter;
        const deadline = setTimeout(() => current.abort(), dependencies.budgetMs ?? 30000);
        try {
          await initialize(force);
        } catch (error) {
          if (closed) return;
          if (error.identityState === "stopped")
            error = new IdentityError("failed", "身份初始化超时，请稍后重新检测。", true);
          fail(error);
          if (automatic && error.retryable && retryCount < 2 && !forceQueued) {
            const delay =
              dependencies.retryDelayMs ??
              Math.max(error.retryAfterMs || 0, [5000, 30000][retryCount]) +
                Math.floor(Math.random() * 1000);
            retryCount++;
            retryTimer = setTimeout(() => {
              void refresh(force, true);
            }, delay);
            retryTimer.unref?.();
          }
        } finally {
          clearTimeout(deadline);
        }
      } while (forceQueued && !closed);
    })().finally(() => {
      task = undefined;
    });
    return task;
  };
  const requireRuntime = () => {
    if (!running || state !== "ready")
      throw new Error(detail || "身份正在初始化，请稍后 /dws identity 查看状态。");
    return running;
  };
  return {
    id: "dws-send-approval-listener",
    start(ctx) {
      if (!closed) throw new Error("代回复服务已启动。");
      closed = false;
      context = ctx;
      state = "starting";
      detail = "";
      record = undefined;
      cached = false;
      retryCount = 0;
      forceQueued = false;
      // Do not return/await the discovery promise: both supported hosts await start().
      startupTimer = setTimeout(() => {
        void refresh(false, true);
      }, dependencies.startupDelayMs ?? 100);
      startupTimer.unref?.();
    },
    async stop() {
      closed = true;
      clearTimeout(startupTimer);
      clearTimeout(retryTimer);
      aborter?.abort();
      await task;
      await botTask?.catch(() => {});
      retiring = running ?? retiring;
      running = undefined;
      await dispose(retiring);
      retiring = undefined;
      state = "stopped";
    },
    refresh,
    ready: async () => {
      if (state !== "ready") await refresh();
      return requireRuntime();
    },
    requireRuntime,
    get policy() {
      return running && state === "ready" ? running.policy : fallback;
    },
    status: () => ({
      state,
      detail,
      binding: record?.binding,
      robot: record?.robot,
      owner: record?.owner,
      cached,
    }),
    text() {
      return [
        "### 代回复助手身份",
        "",
        `- 状态：${labels[state]}`,
        ...(detail ? [`- 说明：${detail}`] : []),
        `- 钉钉账号：${clean(config.accountId)}`,
        `- 实例主人：${clean(config.ownerUserId)}`,
        ...(record?.owner ? [`- 本人开放 ID：${clean(record.owner.openId)}`] : []),
        ...(record
          ? [
              `- profile：${clean(record.binding.profile)}`,
              `- 机器人应用：${clean(record.binding.channelClientId)}`,
            ]
          : []),
        ...(record?.robot
          ? [
              `- 机器人：${clean(record.robot.name)}`,
              `- 开放 ID：${clean(record.robot.openId)}`,
              `- 查询时间：${new Date(record.robot.checkedAt).toLocaleString("zh-CN", { hour12: false })}`,
              `- 本次来源：${cached ? (validRobotCache(record, now()) ? "身份缓存" : "历史缓存（已过期，启用监听前重查）") : "DWS 查询"}`,
            ]
          : ["- 机器人身份：启用监听时查询，或主动刷新"]),
        "",
        "发送 /dws identity refresh 重新检测。重新检测沿用个人监听开关，不会默认开启监听。",
      ].join("\n");
    },
  };
}
