import { randomUUID } from "node:crypto";
import { bridge } from "./assistant-bridge.mjs";
import { cardFormFields } from "./assistant-card-protocol.mjs";
import { resolveTargets, splitTargets, resolveDisplayLabels } from "./assistant-directory.mjs";
import { sendExact } from "./assistant-dws.mjs";
import { draftReply, draftFailure } from "./assistant-model.mjs";
import { createNotificationQueue } from "./assistant-notifications.mjs";
import {
  initialSettings,
  validateSettings,
  safeText,
  autoAnswer,
  quietNow,
} from "./assistant-settings.mjs";
import { AssistantStore, PENDING, messageKey } from "./assistant-store.mjs";
import { buildView } from "./assistant-views.mjs";
import { replyRule } from "./preferences.mjs";
import { matchesRules, replySnapshot } from "./rules.mjs";
import { previewLiteral } from "./send-preview.mjs";

const NAV = new Set([
  "home",
  "listen",
  "listen-dm",
  "listen-at",
  "listen-sender",
  "directory",
  "reply",
  "reply-target",
  "reply-edit",
  "auto-manage",
  "notice-delivery",
  "notice-frequency",
  "notice-quiet",
  "notice-priority",
  "automation",
  "auto-new",
  "notifications",
  "pauses",
  "draft",
  "edit",
  "regenerate",
  "pause",
  "inbox",
  "history",
]);
const array = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
export function createAssistant(api, config, dependencies = {}) {
  const store = dependencies.store ?? new AssistantStore(config),
    now = dependencies.now ?? Date.now;
  const sender = dependencies.send ?? ((d) => sendExact(config, d));
  const complete = dependencies.draft ?? ((d, h, m, s) => draftReply(api, config, d, h, m, s));
  const resolve =
    dependencies.resolve ??
    ((kind, raw, existing) =>
      resolveTargets(config, kind, raw, { existing, directory: directory() }));
  let listener,
    closed = true,
    timer,
    signal,
    modelQueue = Promise.resolve(),
    sendQueue = Promise.resolve(),
    maintenanceBusy = false,
    directoryRefresh;
  const jobs = new Set();
  const settings = () => validateSettings(store.get("settings") ?? initialSettings());
  const directory = () => store.get("directory") ?? [];
  const transport = () => dependencies.transport ?? bridge().channel;
  const track = (promise) => {
    jobs.add(promise);
    promise.finally(() => jobs.delete(promise)).catch(() => {});
    return promise;
  };
  const attentionStates = ["pending", "inbox", "stale", "draft-error", "unknown"];
  const notifications = createNotificationQueue({
    now,
    ...dependencies.notificationTimers,
    policy: () => ({ ...settings().notifications, quiet: quietNow(settings(), now()) }),
    deliver: ({ includeHistory }) =>
      track(
        (async () => {
          if (closed) return false;
          const rows = store.list(attentionStates, 2);
          if (!rows.length && !includeHistory) return false;
          await show(
            rows.length === 1 ? "draft" : rows.length ? "inbox" : "history",
            rows.length === 1 ? { id: rows[0].id } : {},
            undefined,
            "",
            { lane: "notification" },
          );
          return true;
        })(),
      ),
    failed: () =>
      api.logger?.warn?.("[DWSAssistant] notification delivery failed; drafts retained"),
  });
  function notice(draft) {
    const attention = attentionStates.includes(draft?.status);
    notifications.mark({
      attention,
      priority:
        attention &&
        (draft.status === "unknown" ||
          settings().notifications.priorityUsers.includes(draft.event.sender_open_dingtalk_id)),
    });
  }
  const model = (...args) => {
    const result = modelQueue.then(() => {
      if (closed) {
        throw new Error("服务已停止。");
      }
      const latest = store.draft(args[0].id);
      if (latest?.version !== args[0].version || latest.status !== "generating") {
        throw new Error("草稿已失效。");
      }
      return complete(...args, signal.signal);
    });
    modelQueue = result.catch(() => {});
    return result;
  };
  const state = () => ({
    prefs: listener.snapshot(),
    settings: settings(),
    store,
    directory: directory(),
    listener: listener.status(),
  });
  function saveSettings(mutator) {
    const value = settings();
    value.autoRules = value.autoRules.filter((r) => r.expires > now());
    value.pauses = Object.fromEntries(
      Object.entries(value.pauses).filter(([, until]) => until > now()),
    );
    mutator(value);
    value.revision++;
    store.set("settings", validateSettings(value));
    notifications.kick();
  }
  function checkReady() {
    if (!config.assistant.cardTemplateId || !transport()?.sendCard) {
      throw new Error("请管理员先配置代回复卡片模板并加载配套钉钉插件。");
    }
    if (typeof api.runtime.llm?.complete !== "function" && !dependencies.draft) {
      throw new Error("宿主缺少无工具拟稿接口。");
    }
  }
  const liveCard = (card) => {
    const current = store.getCard(card.id);
    return current && !current.invalidated && current.expires > now() && current.protocol === 2;
  };
  function assertLive(card) {
    if (!liveCard(card)) throw new Error("卡片已过期或被新卡替代，请重新发送 /dws。");
    if (
      listener.snapshot().revision !== card.preferenceRevision ||
      settings().revision !== card.settingsRevision
    ) {
      throw new Error("设置已变化，请重新打开页面。");
    }
  }
  async function paintInactive(card) {
    await transport()?.updateCard({
      accountId: config.accountId,
      ownerUserId: config.ownerUserId,
      templateId: config.assistant.cardTemplateId,
      outTrackId: card.outTrackId,
      data: {
        title: "代回复助手 · 已失效",
        description: `${card.invalidated || "卡片已到期"}。\n请单独发送 /dws 打开新卡。`,
        card_status: "expired",
        card_expires_note: "卡片已失效",
        form: { fields: [] },
        ...Object.fromEntries(
          Array.from({ length: 6 }, (_, i) => [
            [`button${i + 1}`, ""],
            [`action${i + 1}`, ""],
          ]).flat(),
        ),
      },
    });
    const latest = store.getCard(card.id);
    if (latest?.invalidated) store.card({ ...latest, inactivePainted: true });
  }
  async function maintenance() {
    if (closed || maintenanceBusy) return;
    maintenanceBusy = true;
    try {
      for (const card of store.listCards()) {
        if (!card.invalidated && (card.protocol !== 2 || card.expires <= now())) {
          store.card({
            ...card,
            invalidated: card.protocol !== 2 ? "旧版卡片已停用" : "卡片已到期",
          });
        }
      }
      for (const card of store
        .listCards()
        .filter((c) => c.invalidated && !c.inactivePainted)
        .slice(0, 10)) {
        try {
          await paintInactive(card);
        } catch {
          /* Retry display updates; authority is already revoked. */
        }
      }
      store.prune(now());
    } finally {
      maintenanceBusy = false;
    }
  }
  async function targets(card, kind, raw, existing = []) {
    const rows = await resolve(kind, raw, existing);
    assertLive(card);
    if (rows.some((x) => x.kind !== kind || !x.id)) throw new Error("对象校验失败。");
    return rows;
  }
  function cacheTargets(rows) {
    const merged = new Map(directory().map((x) => [`${x.kind}:${x.id}`, x]));
    for (const row of rows) {
      const key = `${row.kind}:${row.id}`;
      merged.set(key, { ...merged.get(key), ...row });
    }
    store.set("directory", [...merged.values()].slice(-200));
  }
  async function refreshDirectory(extra = []) {
    // Serialize in-flight batches so a command and a notification share one lookup.
    while (directoryRefresh) await directoryRefresh;
    if (closed) return [];
    const prefs = listener.snapshot(),
      s = settings();
    const targets = [
      ...extra,
      ...prefs.rules.dm.ids.map((id) => ({ kind: "user", id })),
      ...prefs.rules.sender.ids.map((id) => ({ kind: "user", id })),
      ...prefs.rules.at.ids.map((id) => ({ kind: "group", id })),
      ...prefs.reply.users.map((x) => ({ kind: "user", id: x.id })),
      ...prefs.reply.groups.map((x) => ({ kind: "group", id: x.id })),
      ...s.notifications.priorityUsers.map((id) => ({ kind: "user", id })),
      ...s.autoRules
        .filter((x) => ["user", "group"].includes(x.scope))
        .map((x) => ({ kind: x.scope, id: x.target })),
    ];
    const task = (async () => {
      const rows = await resolveDisplayLabels(config, targets, directory(), {
        runner: dependencies.directoryRunner,
        now: now(),
      });
      if (!closed) cacheTargets(rows);
    })();
    directoryRefresh = task;
    try {
      await task;
    } finally {
      if (directoryRefresh === task) directoryRefresh = undefined;
    }
    return closed ? [] : directory();
  }
  async function show(name = "home", args = {}, replace, notice = "", options = {}) {
    if (closed) {
      throw new Error("代回复服务未就绪。");
    }
    checkReady();
    const displayDrafts = args.id
      ? [store.draft(args.id)].filter(Boolean)
      : ["inbox", "history"].includes(name)
        ? store.list(undefined, 20)
        : [];
    await refreshDirectory(
      displayDrafts.flatMap((d) => [
        { kind: "user", id: d.event.sender_open_dingtalk_id },
        ...(!d.reply.direct ? [{ kind: "group", id: d.event.conversation_id }] : []),
      ]),
    );
    if (closed) throw new Error("服务已停止。");
    const previous = replace ? store.cardForTrack(replace) : undefined;
    if (
      replace &&
      (!previous || previous.invalidated || previous.expires <= now() || previous.protocol !== 2)
    ) {
      throw new Error("卡片已失效，请重新发送 /dws。");
    }
    store.prune(now());
    const view = buildView(name, state(), args),
      id = randomUUID(),
      outTrackId = replace ?? `dws-assistant-${randomUUID()}`;
    const card = {
      id,
      outTrackId,
      owner: config.ownerUserId,
      accountId: config.accountId,
      protocol: 2,
      fieldPrefix: `f_${id.replaceAll("-", "")}_`,
      expires: previous?.expires ?? now() + config.assistant.cardTtlMinutes * 60000,
      preferenceRevision: listener.snapshot().revision,
      settingsRevision: settings().revision,
      name,
      args,
      lane: previous?.lane ?? options.lane ?? "workspace",
      refs: view.refs,
      fields: view.fields,
      actions: view.buttons,
    };
    if (args.draftValues) {
      for (const field of view.fields) {
        const value = args.draftValues[field.name];
        if (field.options) {
          const values = array(value);
          if (value !== undefined && values.every((v) => field.options.some((o) => o.value === v)))
            field.defaultValue = field.type === "MULTI_CHECKBOX_GROUP" ? values : values[0];
        } else if (typeof value === "string" && value.length <= 6000) field.defaultValue = value;
      }
    }
    if (!replace && card.lane === "workspace") {
      for (const older of store
        .listCards()
        .filter((c) => !c.invalidated && (c.lane ?? "workspace") === "workspace")) {
        store.card({ ...older, invalidated: "已打开新的操作卡，此操作卡停用" });
      }
    }
    store.card(card);
    const fields = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`button${i + 1}`, view.buttons[i]?.label ?? ""]),
    );
    const actions = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`action${i + 1}`, `dws-assistant:${id}:${i}`]),
    );
    const data = {
      ...fields,
      ...actions,
      title: view.title,
      description: [notice, view.description].filter(Boolean).join("\n\n"),
      card_expires_note: `卡片有效期至 ${new Date(card.expires).toLocaleString("zh-CN", { timeZone: settings().notifications.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`,
      form: {
        fields: cardFormFields(view.fields).map((field) => ({
          ...field,
          name: card.fieldPrefix + field.name,
        })),
      },
      card_status: "pending",
    };
    const request = {
      accountId: config.accountId,
      ownerUserId: config.ownerUserId,
      templateId: config.assistant.cardTemplateId,
      outTrackId,
      data,
    };
    if (replace) {
      await transport().updateCard(request);
    } else {
      await transport().sendCard(request);
    }
    if (!replace) track(maintenance());
    return card;
  }
  function currentDraft(ref, allowStale = false) {
    const d = store.draft(ref?.id);
    if (!d || d.version !== ref.version) {
      throw new Error("草稿已变化，请刷新后再操作。");
    }
    if (d.expires <= now()) {
      throw new Error("草稿已过期，请重新处理。");
    }
    if (!allowStale && d.status !== "pending") {
      throw new Error("本条尚不可发送，请查看最新状态。");
    }
    if (allowStale && !PENDING.has(d.status)) {
      throw new Error("本条已处理，不能重复操作。");
    }
    return d;
  }
  function authorizeDraft(d) {
    if (config.mode === "block") {
      throw new Error("平台已禁止发送。");
    }
    const prefs = listener.snapshot(),
      s = settings();
    if (
      !prefs.enabled ||
      !matchesRules(d.event, prefs) ||
      replySnapshot(d.event, prefs).mode === "off" ||
      s.pauses[d.event.conversation_id] > now()
    ) {
      throw new Error("监听已暂停或本条已不在处理范围内。");
    }
    if (prefs.revision !== d.preferenceRevision) {
      throw new Error("回复设置已变化，请重新拟稿后确认。");
    }
  }
  async function refreshCards(id) {
    for (const c of store.cardsForDraft(id)) {
      // An incoming message or another approval must not erase unsent form input.
      // The original draft version still rejects stale sends when the owner submits.
      if (c.invalidated || c.consumed || ["edit", "regenerate", "pause"].includes(c.name)) continue;
      try {
        await show(c.name, c.args, c.outTrackId);
      } catch {
        /* Durable state remains authoritative; stale callbacks are rejected. */
      }
    }
  }
  function deliver(...args) {
    const task = sendQueue.then(() => deliverNow(...args));
    sendQueue = task.catch(() => {});
    return task;
  }
  async function deliverNow(ref, edited, automaticRule) {
    let d = currentDraft(ref);
    authorizeDraft(d);
    if (edited !== undefined) {
      d = { ...d, text: safeText(edited) };
    }
    if (automaticRule) {
      const s = settings(),
        rule = autoAnswer(d.event, d.reply, s, now());
      if (!rule || rule.id !== automaticRule.id || rule.text !== d.text) {
        throw new Error("自动答复授权已变化。");
      }
      const window = store.get("auto-rate") ?? { since: now(), count: 0 };
      if (now() - window.since >= 3600000) {
        window.since = now();
        window.count = 0;
      }
      if (window.count >= 30) {
        store.put({ ...d, status: "pending", automatic: false, updated: now() });
        return;
      }
      const cooldownKey = `cooldown:${d.event.conversation_id}:${rule.id}`;
      if ((store.get(cooldownKey) ?? 0) + rule.cooldownMinutes * 60000 > now()) {
        store.put({ ...d, status: "suppressed", version: d.version + 1, updated: now() });
        return;
      }
      store.set(cooldownKey, now());
      store.set("auto-rate", { ...window, count: window.count + 1 });
    }
    // Persist the claim BEFORE the external effect. An ambiguous result stays unknown.
    d = store.put({
      ...d,
      text: safeText(d.text),
      status: "sending",
      version: d.version + 1,
      updated: now(),
      automatic: Boolean(automaticRule),
    });
    try {
      await sender(d);
      store.put({ ...d, status: "sent", updated: now() });
    } catch (error) {
      store.put({
        ...d,
        status: error?.noSend ? "pending" : "unknown",
        error: error?.noSend ? error.message : "发送结果待核实；不会自动重发。",
        updated: now(),
      });
    }
    if (!automaticRule) notice(store.draft(d.id));
    await refreshCards(d.id);
  }
  async function generate(ref, hint = "", material = "") {
    let d = currentDraft(ref, true);
    const prefs = listener.snapshot();
    d = store.put({
      ...d,
      reply: replySnapshot(d.event, prefs),
      preferenceRevision: prefs.revision,
      status: "generating",
      version: d.version + 1,
      updated: now(),
    });
    const version = d.version;
    try {
      const context = store.conversation(d.event.conversation_id, d.id, 5).map((row) => ({
        sender: row.event.sender_open_dingtalk_id,
        message: row.event.content.slice(0, 1600),
        ...(row.status === "sent" ? { reply: row.text } : {}),
      }));
      const body = await model({ ...d, context }, hint, material);
      const latest = store.draft(d.id);
      if (!closed && latest?.version === version && latest.status === "generating") {
        store.put({ ...latest, text: body, status: "pending", error: undefined, updated: now() });
      }
    } catch (error) {
      const failure = draftFailure(error);
      api.logger?.warn?.(`[DWSAssistant] draft failed id=${d.id} code=${failure.code}`);
      const latest = store.draft(d.id);
      if (!closed && latest?.version === version) {
        store.put({
          ...latest,
          status: "draft-error",
          error: failure.message,
          updated: now(),
        });
      }
    }
    await refreshCards(d.id);
  }
  async function processEvent(event, prefs, reply) {
    if (closed || settings().pauses[event.conversation_id] > now()) {
      return;
    }
    const d = store.create(event, prefs, reply, now());
    if (!d) {
      return;
    }
    for (const previous of store.list([...PENDING])) {
      if (previous.id !== d.id && previous.event.conversation_id === event.conversation_id) {
        store.put({
          ...previous,
          status: "superseded",
          version: previous.version + 1,
          updated: now(),
        });
        track(refreshCards(previous.id));
      }
    }
    const s = settings(),
      rule = autoAnswer(event, reply, s, now());
    // Admission persists immediately. Network/model work continues outside the
    // listener drain, so another conversation can enter while drafts await review.
    track(
      (async () => {
        if (rule) {
          const pending = store.put({ ...d, status: "pending", text: rule.text });
          await deliver({ id: d.id, version: pending.version }, undefined, rule);
        } else if (reply.mode === "inbox") {
          store.put({ ...d, status: "inbox" });
        } else if (reply.mode === "fixed") {
          store.put({ ...d, status: "pending", text: reply.text });
        } else {
          await generate({ id: d.id, version: d.version });
        }
        notice(store.draft(d.id));
      })().catch(() => {
        notice(store.draft(d.id));
        api.logger?.warn?.("[DWSAssistant] background operation stopped; inspect draft status");
      }),
    );
  }
  function selected(card, values) {
    const ids = array(values.selected);
    if (!ids.length || ids.length > 5) {
      throw new Error("请先选择本页记录。");
    }
    return ids.map((id) => {
      const ref = card.refs.find((r) => String(r.id) === id);
      if (!ref) {
        throw new Error("所选记录不属于当前页面。");
      }
      return ref;
    });
  }
  function validateFields(card, raw) {
    const values = {};
    for (const f of card.fields) {
      const v = raw[f.name] ?? f.defaultValue ?? "";
      if (f.options) {
        const vals = array(v);
        if (vals.some((x) => !f.options.some((o) => o.value === x))) {
          throw new Error("选项不属于当前页面。");
        }
        values[f.name] = ["MULTI_SELECT", "MULTI_CHECKBOX_GROUP"].includes(f.type)
          ? vals
          : (vals[0] ?? "");
      } else {
        if (typeof v !== "string" || v.length > 12000) {
          throw new Error("输入过长或无效。");
        }
        values[f.name] = v;
      }
    }
    return values;
  }
  async function operation(card, action, raw) {
    const replace = card.outTrackId;
    if (NAV.has(action.op)) {
      return show(action.op, action, replace);
    }
    const v = validateFields(card, raw);
    if (
      ![
        "send",
        "send-selected",
        "ignore",
        "ignore-selected",
        "edit-send",
        "generate",
        "open-selected",
      ].includes(action.op) &&
      (listener.snapshot().revision !== card.preferenceRevision ||
        settings().revision !== card.settingsRevision)
    ) {
      throw new Error("设置已变化，请重新打开页面。");
    }
    if (action.op === "toggle") {
      await listener.update((p) => {
        p.enabled = !p.enabled;
      });
    } else if (action.op === "save-listen") {
      const key = action.section;
      if (!["dm", "at", "sender"].includes(key) || card.name !== `listen-${key}`)
        throw new Error("页面已更新，请重新打开监听范围。");
      const mode = v[key];
      const rows = ["users", "groups"].includes(mode)
        ? await targets(
            card,
            key === "at" ? "group" : "user",
            v[`${key}Ids`],
            listener.snapshot().rules[key].ids,
          )
        : [];
      if (["users", "groups"].includes(mode) && !rows.length)
        throw new Error("指定人员/群不能为空。");
      assertLive(card);
      await listener.update((p) => {
        assertLive(card);
        p.rules[key] = { mode, ids: rows.map((x) => x.id) };
      });
      cacheTargets(rows);
      return show("listen", {}, replace, "已保存本组。监听开关未改变。");
    } else if (action.op === "search-directory") {
      const rows = await targets(card, v.kind, v.query);
      if (!rows.length) throw new Error("请填写需要校验的对象。");
      cacheTargets(rows);
      return show("search-results", { results: rows }, replace);
    } else if (action.op === "load-reply") {
      const kind = card.args.targetKind;
      if (card.name !== "reply-target" || !["user", "group"].includes(kind))
        throw new Error("请重新选择回复对象。");
      const rows = await targets(
        card,
        kind,
        v.targetInput,
        listener.snapshot().reply[kind === "user" ? "users" : "groups"].map((x) => x.id),
      );
      if (!rows.length) throw new Error("请填写人员 UserId 或完整群名。");
      cacheTargets(rows);
      return show("reply-edit", { targetKind: kind, targets: rows }, replace);
    } else if (["save-reply", "reset-reply"].includes(action.op)) {
      if (card.name !== "reply-edit") throw new Error("请重新打开回复设置。");
      const kind = card.args.targetKind || "default",
        rows = card.args.targets || [];
      if (kind !== "default" && !rows.length) throw new Error("请先校验对象。");
      assertLive(card);
      await listener.update((p) => {
        assertLive(card);
        const reset = action.op === "reset-reply";
        const rule = reset
          ? { mode: "ai", text: "简洁、礼貌，不编造事实或承诺。" }
          : replyRule(v.mode, ["off", "inbox"].includes(v.mode) ? "" : v.requirements);
        if (kind === "default") p.reply.default = rule;
        else {
          const key = kind === "user" ? "users" : "groups",
            ids = rows.map((x) => x.id);
          p.reply[key] = p.reply[key].filter((x) => !ids.includes(x.id));
          if (!reset) p.reply[key].push(...ids.map((id) => ({ id, ...rule })));
        }
      });
      return show("reply", {}, replace, "回复规则已保存。");
    } else if (action.op === "auto-back") {
      return show(action.destination, { wizard: { ...card.args.wizard, ...v } }, replace);
    } else if (action.op === "auto-next") {
      const draft = { ...card.args.wizard, ...v };
      if (card.name === "auto-new") {
        draft.targets = ["user", "group"].includes(v.scope)
          ? await targets(card, v.scope, v.targetInput)
          : [];
        if (["user", "group"].includes(v.scope) && !draft.targets.length)
          throw new Error("请填写指定对象。");
        cacheTargets(draft.targets);
        return show("auto-content", { wizard: draft }, replace);
      }
      if (card.name === "auto-content") {
        draft.answer = safeText(v.answer);
        splitTargets(v.keywords, 10);
        return show("auto-limits", { wizard: draft }, replace);
      }
      if (card.name === "auto-limits") return show("auto-frequency", { wizard: draft }, replace);
      if (card.name !== "auto-frequency") throw new Error("请按顺序检查授权内容。");
      return show("auto-review", { wizard: draft }, replace);
    } else if (action.op === "save-auto") {
      if (card.name !== "auto-review") throw new Error("请先查看完整授权摘要。");
      // Only the reviewed, server-stored wizard can authorize sending. Ignore form overrides.
      const draft = card.args.wizard;
      if (
        !draft ||
        !["1", "8", "24", "168"].includes(draft.hours) ||
        !["5", "30", "60", "1440"].includes(draft.cooldown)
      )
        throw new Error("授权摘要无效，请重新设置。");
      const rows = ["user", "group"].includes(draft.scope) ? draft.targets : [{ id: "" }];
      if (!rows?.length) throw new Error("请先校验指定对象。");
      assertLive(card);
      saveSettings((s) => {
        for (const row of rows)
          s.autoRules.push({
            id: randomUUID(),
            scope: draft.scope,
            target: row.id,
            text: safeText(draft.answer),
            keywords: splitTargets(draft.keywords, 10),
            expires: now() + Number(draft.hours) * 3600000,
            cooldownMinutes: Number(draft.cooldown),
          });
      });
      return show("automation", {}, replace, "已按上述范围、正文和期限授权。");
    } else if (action.op === "revoke-auto") {
      saveSettings((s) => {
        s.autoRules = s.autoRules.filter((r) => !array(v.rules).includes(r.id));
      });
      return show("auto-manage", {}, replace, "所选授权已撤销。");
    } else if (action.op === "save-notifications") {
      const section = action.section;
      if (section !== card.name) throw new Error("提醒页面已变化，请重新打开。");
      const rows =
        section === "notice-priority"
          ? await targets(card, "user", v.priorityUsers, settings().notifications.priorityUsers)
          : [];
      assertLive(card);
      saveSettings((s) => {
        if (section === "notice-delivery") Object.assign(s.notifications, { mode: v.mode });
        else if (section === "notice-frequency") s.notifications.minutes = Number(v.minutes);
        else if (section === "notice-quiet")
          Object.assign(s.notifications, {
            quietStart: v.quietStart,
            quietEnd: v.quietEnd,
            timezone: v.timezone,
          });
        else if (section === "notice-priority")
          s.notifications.priorityUsers = rows.map((x) => x.id);
        else throw new Error("提醒设置项无效。");
      });
      cacheTargets(rows);
      return show("notifications", {}, replace, "本项提醒设置已保存。");
    } else if (action.op === "resume") {
      saveSettings((s) => {
        for (const id of array(v.conversations)) {
          delete s.pauses[id];
        }
      });
    } else if (action.op === "pause-conversation") {
      const d = currentDraft(card.refs[0], true);
      saveSettings((s) => {
        s.pauses[d.event.conversation_id] = now() + Number(v.hours) * 3600000;
      });
      for (const row of store.list([...PENDING])) {
        if (row.event.conversation_id === d.event.conversation_id) {
          store.put({ ...row, status: "ignored", version: row.version + 1 });
          await refreshCards(row.id);
        }
      }
    } else if (action.op === "open-selected") {
      return show("draft", { id: selected(card, v)[0].id }, replace);
    } else if (action.op === "generate") {
      await generate(card.refs[0], `${v.style}\n${v.hint}`, v.material);
      return show("draft", { id: card.refs[0].id }, replace);
    } else if (action.op === "send" || action.op === "edit-send") {
      await deliver(card.refs[0], action.op === "edit-send" ? v.body : undefined);
      return show("draft", { id: card.refs[0].id }, replace);
    } else if (action.op === "send-selected") {
      const refs = selected(card, v);
      refs.forEach((r) => {
        authorizeDraft(currentDraft(r));
      });
      for (const ref of refs) {
        await deliver(ref);
      }
      return show("inbox", {}, replace);
    } else if (action.op === "ignore" || action.op === "ignore-selected") {
      const refs = action.op === "ignore" ? card.refs : selected(card, v);
      const rows = refs.map((r) => currentDraft(r, true));
      for (const d of rows) {
        store.put({ ...d, status: "ignored", version: d.version + 1, updated: now() });
        await refreshCards(d.id);
      }
      return show("inbox", {}, replace);
    } else {
      throw new Error("不支持的操作。");
    }
    return show("home", {}, replace, "设置已保存。");
  }
  async function handle(input) {
    if (closed) {
      return false;
    }
    const match = /^dws-assistant:([a-f0-9-]{36}):([0-5])$/.exec(input.actionId ?? "");
    if (!match) {
      return false;
    }
    const card = store.getCard(match[1]);
    if (
      !card ||
      card.owner !== input.userId ||
      card.accountId !== input.accountId ||
      card.outTrackId !== input.outTrackId ||
      card.invalidated ||
      card.protocol !== 2 ||
      card.expires <= now() ||
      card.consumed
    ) {
      if (
        card &&
        card.owner === input.userId &&
        card.accountId === input.accountId &&
        card.outTrackId === input.outTrackId &&
        !card.consumed
      ) {
        track(
          paintInactive({ ...card, invalidated: card.invalidated || "卡片已失效" }).catch(() => {}),
        );
      }
      return true;
    }
    const action = card.actions[Number(match[2])];
    if (!action) {
      return true;
    }
    store.card({ ...card, consumed: true });
    // Return to Stream immediately; the model and DWS network call do not hold its acknowledgement.
    const values = Object.fromEntries(
      card.fields.flatMap((field) => {
        const wireName = (card.fieldPrefix || "") + field.name;
        return Object.hasOwn(input.values ?? {}, wireName)
          ? [[field.name, input.values[wireName]]]
          : [];
      }),
    );
    track(
      operation(card, action, values).catch(async (error) => {
        api.logger?.warn?.("[DWSAssistant] card operation did not complete");
        try {
          await show(
            card.name,
            { ...card.args, draftValues: values },
            card.outTrackId,
            `操作未完成：${error.code ? "请检查服务状态。" : error.message}`,
          );
        } catch {
          /* Command fallback remains available. */
        }
      }),
    );
    return true;
  }
  return {
    store,
    bind(value) {
      listener = value;
    },
    checkReady,
    presentationDirectory: (ids) =>
      track(refreshDirectory(ids.map((id) => ({ kind: "group", id })))),
    maintenance,
    flushNotifications: () => notifications.flush(),
    show,
    handle,
    processEvent: (...args) => track(processEvent(...args)),
    has: (event) => !closed && Boolean(store.find(messageKey(event, config.profile))),
    async start(ctx) {
      await store.open(ctx.stateDir);
      closed = false;
      signal = new AbortController();
      if (!store.get("settings")) {
        store.set("settings", initialSettings());
      }
      settings();
      notifications.start();
      for (const draft of store.list(attentionStates)) notice(draft);
      bridge().assistants.set(config.accountId, { handle });
      track(maintenance());
      timer = setInterval(() => {
        track(maintenance());
        notifications.kick();
      }, 30000);
      timer.unref?.();
    },
    async stop() {
      closed = true;
      clearInterval(timer);
      notifications.stop();
      signal?.abort();
      bridge().assistants.delete(config.accountId);
      await Promise.allSettled([...jobs, modelQueue]);
      store.close();
    },
    async idle() {
      while (jobs.size) {
        await Promise.allSettled(jobs);
      }
    },
    textPreview(id) {
      if (closed) {
        throw new Error("服务尚未就绪。");
      }
      if (id !== undefined) {
        const d = store.draft(id);
        if (!d) {
          throw new Error("记录不存在。");
        }
        return `草稿 ${d.id}-${d.version} · ${d.status}\n接收会话：${previewLiteral(d.event.conversation_id)}\n发送者：${previewLiteral(d.event.sender_open_dingtalk_id)}\n原消息：${previewLiteral(d.event.content.slice(0, 3000))}\n完整回复：${previewLiteral(d.text)}\n发送 /ok ${d.id}-${d.version}；忽略 /no ${d.id}-${d.version}；修改 /edit ${d.id}-${d.version} 新正文`;
      }
      const rows = store.list([...PENDING, "unknown"], 10);
      return rows.length
        ? rows
            .map(
              (d) =>
                `#${d.id} · ${d.status} · ${previewLiteral(d.event.sender_open_dingtalk_id)}\n/dws show ${d.id}`,
            )
            .join("\n\n")
        : "暂无待处理消息。";
    },
    async command(action, ref, body) {
      if (!ref || !Number.isSafeInteger(ref.id) || !Number.isSafeInteger(ref.version)) {
        throw new Error("请用 /dws show <编号> 查看最新草稿，复制带版本的短命令。");
      }
      const d = currentDraft(ref, action === "no");
      if (action === "ok") {
        await deliver(ref);
      } else if (action === "edit") {
        await deliver(ref, body);
      } else if (action === "no") {
        store.put({ ...d, status: "ignored", version: d.version + 1, updated: now() });
        await refreshCards(d.id);
      } else {
        throw new Error("无效操作。");
      }
      return `#${d.id} 状态：${store.draft(d.id).status}。用 /dws show ${d.id} 查看。`;
    },
  };
}
