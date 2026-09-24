export const EVENTS = Object.freeze({
  direct: "user_im_message_receive_o2o_all",
  privateUser: "user_im_message_receive_o2o",
  mention: "user_im_message_receive_at",
  sender: "user_im_message_receive_user",
});

// DWS accepts multiple keys only when they share target/filter constraints.
export function subscriptionPlan(preferences, config) {
  const { dm, at, sender } = preferences.rules;
  const plans = [],
    broad = [];
  if (dm.mode === "all") {
    broad.push(EVENTS.direct);
  }
  if (at.mode !== "off") {
    broad.push(EVENTS.mention);
  }
  const add = (keys, target) =>
    plans.push({
      keys,
      target,
      args: [
        "--profile",
        config.profile,
        "event",
        "consume",
        ...keys,
        ...(target ? ["--open-dingtalk-id", target] : []),
        "--flatten",
        "--format",
        "ndjson",
      ],
    });
  if (broad.length) {
    add(broad);
  }
  const ids = new Set([...dm.ids, ...sender.ids]);
  for (const id of ids) {
    const keys = [];
    if (dm.mode === "users" && dm.ids.includes(id)) {
      keys.push(EVENTS.privateUser);
    }
    if (sender.mode === "users" && sender.ids.includes(id)) {
      keys.push(EVENTS.sender);
    }
    add(keys, id);
  }
  return plans;
}
export function matchesRules(event, preferences) {
  const { dm, at, sender } = preferences.rules;
  const types = event.observedTypes ?? [event.type];
  const from = event.sender_open_dingtalk_id;
  return (
    (sender.mode === "users" && sender.ids.includes(from)) ||
    (types.some((type) => [EVENTS.direct, EVENTS.privateUser].includes(type)) &&
      (dm.mode === "all" || (dm.mode === "users" && dm.ids.includes(from)))) ||
    (types.includes(EVENTS.mention) &&
      (at.mode === "all" || (at.mode === "groups" && at.ids.includes(event.conversation_id))))
  );
}
export function resolveReply(event, preferences) {
  const user = preferences.reply.users.find((entry) => entry.id === event.sender_open_dingtalk_id);
  const group = preferences.reply.groups.find((entry) => entry.id === event.conversation_id);
  const candidates = [
    user && { ...user, scope: "user" },
    group && { ...group, scope: "group" },
    { ...preferences.reply.default, scope: "default" },
  ].filter(Boolean);
  const selected = candidates.find((entry) => entry.mode === "off") ?? candidates[0];
  return {
    mode: selected.mode,
    text: selected.text,
    scope: selected.scope,
    revision: preferences.revision,
  };
}
export function replySnapshot(event, preferences) {
  return {
    ...resolveReply(event, preferences),
    conversationId: event.conversation_id,
    senderOpenId: event.sender_open_dingtalk_id,
    direct: (event.observedTypes ?? [event.type]).some((type) =>
      [EVENTS.direct, EVENTS.privateUser].includes(type),
    ),
  };
}
