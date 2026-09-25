import { fixture } from "./assistant-fixture.mjs";
import { initialTopics } from "../assistant-topic-rules.mjs";
export const rule = (extra = {}) => ({ id: "pdf", enabled: true, scope: "all", targets: [], name: "导出PDF",
  description: "询问在线文档导出PDF的操作方法", examples: "怎么转PDF？在哪里下载PDF版？", exclusions: "导出失败、权限不足、要求代执行",
  action: "auto", text: "请打开文档菜单，选择导出PDF；具体入口以公司文档指引为准。", expires: Date.now() + 3600000, cooldownMinutes: 30, ...extra });
export const match = (id = "pdf") => ({ outcome: "match", ruleIds: [id], coversWholeMessage: true, reason: "matched" });
export const none = () => ({ outcome: "none", ruleIds: [], coversWholeMessage: false, reason: "none" });
export const review = (reason = "ambiguous") => ({ outcome: "review", ruleIds: [], coversWholeMessage: false, reason });
export async function topicFixture(t, overrides = {}, options = {}) {
  const classified = [];
  const f = await fixture(t, { classify: async (...args) => { classified.push(args); return match(); }, ...overrides });
  function setTopics(fn) {
    const s = f.assistant.store.get("settings"); fn(s.topics); s.topics.revision++; s.revision++;
    f.assistant.store.set("settings", s);
  }
  setTopics((topics) => Object.assign(topics, initialTopics(), { enabled: true, rules: [rule()], ...options }));
  return { ...f, classified, setTopics };
}
