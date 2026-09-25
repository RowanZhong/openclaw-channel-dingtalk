import { randomUUID } from "node:crypto";
import { targetInput } from "./assistant-directory.mjs";
import { topicText, validateTopicRule } from "./assistant-topic-rules.mjs";

export function topicWizardRule(w, now) {
  return validateTopicRule({ id: w.id, enabled: true, scope: w.scope,
    targets: (w.targetRows ?? []).map((r) => r.id), name: w.name,
    description: w.description, examples: w.examples || "", exclusions: w.exclusions || "",
    action: w.action, text: w.text || "", expires: w.action === "auto" ? now + Number(w.hours || "8") * 3600000 : 0,
    cooldownMinutes: Number(w.cooldown || "30") });
}
export function createTopicControls({ settings, directory, saveSettings, assertLive, targets, cacheTargets, show, classify, now }) {
  const save = (fn) => saveSettings((s) => { fn(s.topics); s.topics.revision++; });
  return async function topicOperation(card, action, v) {
    if (!action.op.startsWith("topic-")) return false;
    const replace = card.outTrackId, w = { ...card.args.wizard };
    assertLive(card);
    if (action.op === "topic-save-mode") {
      if (card.name !== "topic-mode") throw new Error("请重新打开主题策略。");
      if (v.enabled === "on" && !settings().topics.rules.some((r) => r.enabled))
        throw new Error("请先新增或启用一条主题规则。");
      save((t) => { t.enabled = v.enabled === "on"; t.mode = v.mode; });
      return show("topics", {}, replace, "主题策略已保存，监听总开关未改变。");
    }
    if (["topic-open", "topic-disable", "topic-delete"].includes(action.op)) {
      if (card.name !== "topic-manage") throw new Error("请重新打开主题列表。");
      const ids = Array.isArray(v.rules) ? v.rules : [v.rules];
      if (!ids.length || ids.some((id) => !card.fields[0].options.some((r) => r.value === id)))
        throw new Error("请先选择本页规则。");
      if (action.op === "topic-open") return show("topic-detail", { id: ids[0] }, replace);
      save((t) => { t.rules = action.op === "topic-delete" ? t.rules.filter((r) => !ids.includes(r.id)) :
        t.rules.map((r) => ids.includes(r.id) ? { ...r, enabled: false } : r); });
      return show("topic-manage", {}, replace, action.op === "topic-delete" ? "所选规则已删除。" : "所选规则已停用。");
    }
    if (["topic-edit", "topic-test-saved"].includes(action.op)) {
      if (card.name !== "topic-detail") throw new Error("请先查看规则详情。");
      const r = settings().topics.rules.find((r) => r.id === action.id);
      if (!r) throw new Error("主题已删除。");
      const wizard = { ...r, targetRows: r.targets.map((id) => directory().find((x) => x.kind === r.scope && x.id === id) || { kind: r.scope, id, name: id }),
        targetInput: targetInput(r.scope, r.targets, directory()), cooldown: String(r.cooldownMinutes), hours: "8", editing: true,
        readOnly: action.op === "topic-test-saved" };
      return show(wizard.readOnly ? "topic-trial" : "topic-new", { wizard }, replace);
    }
    if (action.op === "topic-back") {
      const previous = { "topic-definition": "topic-new", "topic-action": "topic-definition", "topic-trial": "topic-action",
        "topic-limits": "topic-trial", "topic-review": "topic-limits" };
      if (previous[card.name] !== action.destination || w.readOnly) throw new Error("页面顺序无效。");
      // Keep unfinished text when navigating back; validate it on the next forward step.
      const retained = { "topic-definition": ["name", "description", "examples", "exclusions"],
        "topic-action": ["action", "text"], "topic-trial": ["sample"], "topic-limits": ["hours", "cooldown"] };
      for (const key of retained[card.name] ?? []) {
        if (v[key] === undefined) continue;
        if (["topic-definition", "topic-action"].includes(card.name) && v[key] !== w[key]) {
          delete w.trial; delete w.testedMatch;
        }
        w[key] = v[key];
      }
      return show(action.destination, { wizard: w }, replace);
    }
    if (action.op === "topic-test") {
      if (card.name !== "topic-trial") throw new Error("请打开模拟试判页。");
      const sample = topicText(v.sample, 8000), r = topicWizardRule(w, now());
      const trial = await classify(sample, [r], () => {
        try { assertLive(card); return true; } catch { return false; }
      });
      assertLive(card);
      return show("topic-trial", { wizard: { ...w, sample, trial,
        testedMatch: w.testedMatch || trial.outcome === "match" } }, replace);
    }
    if (action.op === "topic-next") {
      if (w.readOnly) throw new Error("试判页不保存规则。");
      let destination;
      if (card.name === "topic-new") {
        w.id ||= randomUUID();
        w.scope = v.scope;
        w.targetInput = v.targetInput;
        w.targetRows = ["user", "group"].includes(v.scope)
          ? await targets(card, v.scope, v.targetInput, (w.targetRows ?? []).map((r) => r.id)) : [];
        if (["user", "group"].includes(v.scope) && !w.targetRows.length) throw new Error("请填写指定对象。");
        cacheTargets(w.targetRows);
        destination = "topic-definition";
      } else if (card.name === "topic-definition") {
        w.name = topicText(v.name, 60); w.description = topicText(v.description, 600);
        w.examples = topicText(v.examples, 600, true); w.exclusions = topicText(v.exclusions, 400, true);
        destination = "topic-action";
      } else if (card.name === "topic-action") {
        w.action = v.action; w.text = v.action === "inbox" ? "" : topicText(v.text, 160);
        destination = "topic-trial";
      } else if (card.name === "topic-trial") {
        if (w.action === "auto" && !w.testedMatch) throw new Error("请先试判一条明确匹配的消息，再授权自动答复。");
        destination = "topic-limits";
      } else if (card.name === "topic-limits") {
        w.hours = w.action === "auto" ? v.hours : "0";
        w.cooldown = w.action === "auto" ? v.cooldown : "30";
        topicWizardRule(w, now());
        destination = "topic-review";
      } else throw new Error("请按顺序填写主题规则。");
      if (["topic-new", "topic-definition", "topic-action"].includes(card.name)) {
        delete w.trial; delete w.testedMatch;
      }
      assertLive(card);
      return show(destination, { wizard: w }, replace);
    }
    if (action.op === "topic-save") {
      if (card.name !== "topic-review" || w.readOnly ||
          (w.action === "auto" && (!w.testedMatch || !["1", "8", "24", "168"].includes(w.hours))))
        throw new Error("请先查看完整主题授权摘要。");
      const rule = topicWizardRule(w, now());
      save((t) => {
        if (w.editing && !t.rules.some((r) => r.id === w.id)) throw new Error("原主题已删除，请重新新增。");
        t.rules = t.rules.filter((r) => r.id !== rule.id);
        t.rules.push(rule); t.enabled = true;
      });
      return show("topics", {}, replace, "主题已保存并启用识别，监听总开关未改变。");
    }
    throw new Error("不支持的主题操作。");
  };
}
