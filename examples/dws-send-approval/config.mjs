import { isAbsolute } from "node:path";

export const PLUGIN_ID = "dws-send-approval";
// A separate host lane prevents approval waits from consuming main's slots.
// Unconfigured host lanes default to one slot; the listener also admits serially.
export const LISTENER_LANE = PLUGIN_ID;
export const SESSION_MARKER = ":dws-listener:";
const TOKEN = /^[a-zA-Z0-9_-]{1,128}$/;
const EVENT_KEYS = Object.freeze({
  "all-direct": "user_im_message_receive_o2o_all",
  "all-group": "user_im_message_receive_group_all",
  "at-me": "user_im_message_receive_at",
  sender: "user_im_message_receive_user",
  group: "user_im_message_receive_group",
});
export const COMBINED_LISTENER_KIND = "all-direct-and-at-me";

export function listenerEventKeys(config) {
  return config.listener.kind === COMBINED_LISTENER_KIND
    ? [EVENT_KEYS["all-direct"], EVENT_KEYS["at-me"]]
    : [EVENT_KEYS[config.listener.kind]];
}

export function isListenerReady(line, config) {
  const keys = listenerEventKeys(config);
  const match = /^\[event\] ready (event_key|event_count)=([^\s]+)(?:\s|$)/.exec(line);
  if (!match) {
    return false;
  }
  return match[1] === "event_count"
    ? match[2] === String(keys.length)
    : keys.length === 1 && match[2] === keys[0];
}

export function readConfig(raw = {}) {
  const config = {
    agentId: "main",
    accountId: "default",
    mode: "approval",
    timeoutMs: 120_000,
    ...raw,
  };
  const assistant = {
    enabled: true,
    draftTtlMinutes: 1440,
    cardTtlMinutes: 30,
    cardTemplateId: "",
    ...raw.assistant,
  };
  if (
    typeof assistant.enabled !== "boolean" ||
    typeof assistant.cardTemplateId !== "string" ||
    (assistant.cardTemplateId && !/^[a-zA-Z0-9_.-]{1,128}$/.test(assistant.cardTemplateId)) ||
    !Number.isInteger(assistant.cardTtlMinutes) ||
    assistant.cardTtlMinutes < 1 ||
    assistant.cardTtlMinutes > 1440 ||
    !Number.isInteger(assistant.draftTtlMinutes) ||
    assistant.draftTtlMinutes < 10 ||
    assistant.draftTtlMinutes > 10080
  ) {
    throw new Error("assistant config is invalid");
  }
  config.assistant = Object.freeze(assistant);
  for (const key of ["agentId", "accountId", "ownerUserId"]) {
    if (!TOKEN.test(config[key] ?? "")) {
      throw new Error(`dws-send-approval: invalid ${key}`);
    }
  }
  // One profile only; DWS recommends corpId:userId for an exact account identity.
  if (
    typeof config.profile !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}(?::[a-zA-Z0-9_-]{1,128})?$/.test(config.profile)
  ) {
    throw new Error("profile must be one profile name or exact corpId:userId selector");
  }
  if (config.agentId !== config.agentId.toLowerCase()) {
    throw new Error("agentId must be lowercase");
  }
  if (!["approval", "block"].includes(config.mode)) {
    throw new Error("mode must be approval or block");
  }
  if (
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 10_000 ||
    config.timeoutMs > 600_000
  ) {
    throw new Error("timeoutMs must be 10000..600000");
  }
  if (
    typeof config.dwsPath !== "string" ||
    !isAbsolute(config.dwsPath) ||
    /\p{Cc}/u.test(config.dwsPath)
  ) {
    throw new Error("dwsPath must be an absolute executable path");
  }
  const listener = config.listener ?? {};
  if (
    listener.kind !== undefined &&
    ![...Object.keys(EVENT_KEYS), COMBINED_LISTENER_KIND].includes(listener.kind)
  ) {
    throw new Error(
      "listener.kind must be all-direct, all-group, at-me, sender, group or all-direct-and-at-me",
    );
  }
  if (listener.enabled !== undefined && typeof listener.enabled !== "boolean") {
    throw new Error("listener.enabled must be boolean");
  }
  const targeted = ["sender", "group"].includes(listener.kind);
  if (
    targeted &&
    (typeof listener.target !== "string" || !listener.target || /[\s\p{Cc}]/u.test(listener.target))
  ) {
    throw new Error("listener.target must be a stable DWS open user ID or chat ID");
  }
  if (!targeted && listener.target !== undefined) {
    throw new Error("this listener.kind cannot have a target");
  }
  const ignored = listener.ignoreSenderOpenIds ?? [];
  if (
    !Array.isArray(ignored) ||
    ignored.some((id) => typeof id !== "string" || !id || /[\s\p{Cc}]/u.test(id))
  ) {
    throw new Error("listener.ignoreSenderOpenIds must contain stable open IDs");
  }
  if (["all-direct", COMBINED_LISTENER_KIND].includes(listener.kind) && ignored.length === 0) {
    throw new Error(
      "all-direct requires ignoreSenderOpenIds including the approval bot, to avoid notification loops",
    );
  }
  return Object.freeze({
    ...config,
    listener: Object.freeze({
      enabled: false,
      ...listener,
      ignoreSenderOpenIds: Object.freeze([...ignored]),
    }),
  });
}

export function assertHostVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?(?:\+.*)?$/.exec(version ?? "");
  if (!match) {
    throw new Error("Cannot verify OpenClaw version; listener remains stopped");
  }
  const actual = match.slice(1, 4).map(Number);
  const minimum = [2026, 7, 1];
  for (let i = 0; i < 3; i++) {
    if (actual[i] > minimum[i]) {
      return;
    }
    if (actual[i] < minimum[i]) {
      throw new Error("OpenClaw >=2026.7.1-2 is required");
    }
  }
  if (match[4] && Number(match[4]) < 2) {
    throw new Error("OpenClaw >=2026.7.1-2 is required");
  }
}

export function assertApprovalRouting(host, config) {
  if (config.mode === "block") {
    return;
  }
  const allowed = host.commands?.allowFrom?.dingtalk;
  const normalize = (id) => (typeof id === "string" ? id.replace(/^(dingtalk|dd|ding):/i, "") : "");
  if (
    !Array.isArray(allowed) ||
    allowed.length !== 1 ||
    normalize(allowed[0]) !== config.ownerUserId
  ) {
    throw new Error("commands.allowFrom.dingtalk must contain only ownerUserId");
  }
  if (host.commands?.text === false) {
    throw new Error("commands.text must not be false");
  }
  const routing = host.approvals?.plugin;
  const target = routing?.targets?.[0];
  if (
    routing?.enabled !== true ||
    routing.mode !== "targets" ||
    routing.targets?.length !== 1 ||
    target.channel !== "dingtalk" ||
    target.to !== `user:${config.ownerUserId}` ||
    (target.accountId ?? "default") !== config.accountId
  ) {
    throw new Error("approvals.plugin must use targets mode with exactly the owner's DingTalk DM");
  }
  if (routing.agentFilter?.length && !routing.agentFilter.includes(config.agentId)) {
    throw new Error("approvals.plugin.agentFilter excludes the listener agent");
  }
  // The hook scopes requests itself. A separate forwarding filter can strand approvals.
  if (routing.sessionFilter?.length) {
    throw new Error("Remove approvals.plugin.sessionFilter; this plugin scopes requests");
  }
}

export function listenerArgs(config) {
  if (config.listener.kind === COMBINED_LISTENER_KIND) {
    return [
      "--profile",
      config.profile,
      "event",
      "consume",
      ...listenerEventKeys(config),
      "--flatten",
      "--format",
      "ndjson",
    ];
  }
  const args = [
    "--profile",
    config.profile,
    "event",
    "+listen-im",
    "--kind",
    config.listener.kind,
    "--events",
    "message",
  ];
  if (config.listener.kind === "sender") {
    args.push("--open-dingtalk-id", config.listener.target);
  }
  if (config.listener.kind === "group") {
    args.push("--chat-id", config.listener.target);
  }
  return args;
}
