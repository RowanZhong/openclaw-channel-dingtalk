import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(root + "/package.json");
const { createMarkdownRenderer } = await import(pathToFileURL(require.resolve("vitepress")));
const { buildView } = await import(
  pathToFileURL(root + "/examples/dws-send-approval/assistant-views.mjs")
);
const { initialPreferences } = await import(
  pathToFileURL(root + "/examples/dws-send-approval/preferences.mjs")
);
const { initialSettings } = await import(
  pathToFileURL(root + "/examples/dws-send-approval/assistant-settings.mjs")
);
const prefs = initialPreferences({ listener: { enabled: true, kind: "all-direct-and-at-me" } }),
  settings = initialSettings();
const rows = [
  {
    id: 23,
    version: 2,
    status: "pending",
    event: {
      sender_open_dingtalk_id: "OPEN_USER_B",
      conversation_id: "cid_DIRECT_B",
      content: "周五下午能帮我看一下设计稿吗？",
    },
    reply: { direct: true },
    text: "可以先把设计稿发来，我确认时间后回复你。",
  },
  {
    id: 24,
    version: 1,
    status: "pending",
    event: {
      sender_open_dingtalk_id: "OPEN_USER_C",
      conversation_id: "cid_GROUP_G1",
      content: "@我 请确认今天的接口联调安排。",
    },
    reply: { direct: false },
    text: "我先核对安排，确认后在群里回复。",
  },
];
const directory = [
  { kind: "user", id: "OPEN_USER_B", userId: "10001", name: "陈晓", detail: "产品组" },
  { kind: "user", id: "OPEN_USER_C", userId: "10002", name: "李明", detail: "研发组" },
  { kind: "group", id: "cid_GROUP_G1", name: "项目协作群" },
];
const store = { list: () => rows, draft: () => rows[0] };
const views = {};
const exampleWizard = { scope: "dm", targets: [], targetInput: "", answer: "正在开会，稍后回复你。", keywords: "", hours: "1", cooldown: "30" };
for (const name of [
  "home",
  "listen",
  "listen-dm",
  "listen-at",
  "listen-sender",
  "reply",
  "reply-target",
  "reply-edit",
  "auto-manage",
  "auto-content",
  "auto-limits",
  "auto-frequency",
  "auto-review",
  "notice-delivery",
  "notice-frequency",
  "notice-quiet",
  "notice-priority",
  "automation",
  "auto-new",
  "notifications",
  "draft",
  "edit",
  "regenerate",
  "pause",
  "inbox",
  "history",
  "pauses",
  "directory",
])
  views[name] = buildView(
    name,
    { prefs, settings, store, directory: structuredClone(directory), listener: { state: "ready" } },
    { id: 23, targetKind: name === "reply-target" ? "user" : "default", wizard: exampleWizard },
  );
const previewState = { prefs, settings, store, directory: structuredClone(directory), listener: { state: "ready" } };
for (const kind of ["user", "group"]) {
  const targets = directory.filter((row) => row.kind === kind).slice(0, 1);
  views[`reply-target-${kind}`] = buildView("reply-target", previewState, { targetKind: kind, targets });
  views[`reply-edit-${kind}`] = buildView("reply-edit", previewState, { targetKind: kind, targets });
}
views["search-results"] = buildView("search-results", previewState, { results: directory.slice(0, 1) });
const theme = await readFile(new URL("docs-theme.css", import.meta.url), "utf8");
const renderer = await createMarkdownRenderer(root, { lineNumbers: false });
// Standalone files cannot depend on the VitePress client or its theme assets.
renderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0] || "text";
  const caption = ({ text: "文本示例", bash: "命令示例", json: "JSON 配置" })[language] || "代码示例";
  return `<figure class="code-block"><figcaption>${caption}</figcaption><pre tabindex="0" aria-label="${caption}"><code>${renderer.utils.escapeHtml(token.content)}</code></pre></figure>\n`;
};
renderer.renderer.rules.table_open = () => '<div class="table-scroll" role="region" aria-label="可横向滚动的表格" tabindex="0"><table>\n';
renderer.renderer.rules.table_close = () => '</table></div>\n';
const client = await readFile(new URL("docs-preview.js", import.meta.url), "utf8");
for (const doc of [
  {
    source: "docs/contributor/dws-reply-assistant-deployment",
    title: "技术方案与安装配置",
    subtitle: "面向开发人员与平台管理员：架构、部署、身份绑定、模板发布、验证与运维。",
    audience: "开发与运维",
    demo: false,
  },
  {
    source: "docs/user/dws-reply-assistant-manual",
    title: "员工使用手册",
    subtitle: "从自己的钉钉机器人私聊开始，自主选择监听范围、确认回复与设置自动答复。",
    audience: "员工使用",
    demo: true,
  },
]) {
  let body = renderer.render(await readFile(root + "/" + doc.source + ".md", "utf8"));
  body = body.replace(/<h1\b[\s\S]*?<\/h1>/, "");
  let number = 0;
  const toc = [];
  const previewMarker = "<!--interactive-preview-->";
  body = body.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/g, (_all, attrs, inner) => {
    number++;
    const title = inner.replace(/<a[\s\S]*?<\/a>/g, "").replace(/<[^>]+>/g, "");
    toc.push(`<a href="#sec-${number}">${title}</a>`);
    return `${number > 1 ? "</section>" : ""}${number === 2 ? previewMarker : ""}<section class="doc-section" id="sec-${number}"><h2${attrs}>${inner}</h2>`;
  });
  body += "</section>";
  let html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>钉钉代回复助手 · ${doc.title}</title><style>
:root{--ink:#1d3043;--muted:#5b6b7c;--blue:#176bdd;--line:#dce6ef;--paper:#fff;--wash:#f3f7fc}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:32px}body{margin:0;background:var(--wash);color:var(--ink);font:16px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}header{background:#102e50;color:#fff;padding:62px max(28px,calc((100vw - 1250px)/2)) 52px}.eyebrow{letter-spacing:2px;color:#a9d2ff;font-size:13px;font-weight:600}h1{font-size:40px;line-height:1.3;margin:18px 0}header p{max-width:840px;color:#d2e1f0}.badges{display:flex;gap:10px;flex-wrap:wrap}.badges span{border:1px solid #4c6b8d;padding:3px 12px;border-radius:30px;font-size:13px}.layout{max-width:1310px;margin:auto;display:grid;grid-template-columns:250px minmax(0,1fr);gap:42px;padding:40px 30px}aside{position:sticky;top:22px;align-self:start;font-size:14px}aside strong{display:block;margin-bottom:14px}aside a{display:block;color:#475c73;padding:6px 0}main{min-width:0}article{background:#fff;padding:35px 42px;border:1px solid var(--line);border-radius:18px}h2{font-size:25px;line-height:1.45;padding-top:22px;margin:16px 0 22px;border-top:1px solid var(--line)}h3{font-size:19px;margin-top:30px}p{margin:15px 0}li{margin:9px 0}strong{color:#11385b}code{font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#edf3fa;border-radius:4px;padding:2px 5px;overflow-wrap:anywhere}pre{overflow:auto;padding:20px;border:1px solid var(--line);border-radius:12px;background:#f4f7fb!important}pre code{background:none;padding:0;white-space:pre;font-size:12px}pre span{color:inherit!important}table{display:block;overflow-x:auto;width:100%;border-collapse:collapse;margin:20px 0;font-size:14px}th,td{padding:12px 15px;border:1px solid var(--line);vertical-align:top;text-align:left;min-width:135px}th{background:#eef4fa;color:#153f68}td{background:#fff}td:nth-child(2){min-width:240px}hr{border:0;border-top:1px solid var(--line)}.header-anchor{display:none}.demo{background:#fff;padding:26px 30px;border:1px solid var(--line);border-radius:18px;margin-bottom:28px}.demo h2{border:0;padding:0;font-size:23px;margin:0}.caption{font-size:13px;color:var(--muted)}.tabs{display:flex;gap:7px;flex-wrap:wrap;margin:20px 0}.demo button{font:inherit;cursor:pointer;border:1px solid #c4d5e7;background:#fff;color:#23578a;border-radius:7px;padding:8px 13px;font-size:13px}.demo button:hover{background:#edf5ff}.demo button.active,.demo button.primary{background:var(--blue);color:#fff;border-color:var(--blue)}.phone{max-width:550px;margin:20px auto;background:#f3f6fa;padding:20px;border-radius:16px;border:1px solid var(--line)}.botline{font-size:12px;color:#62768b;margin-bottom:10px}.card{background:#fff;border:1px solid #d5e3f1;border-radius:10px;overflow:hidden}.cardtitle{padding:14px 18px;background:#e9f3ff;font-weight:650}.cardbody{padding:18px}.description{white-space:pre-wrap;font-size:14px;overflow-wrap:anywhere;line-height:1.8}.demo label{font-size:13px;display:block;margin-top:14px;font-weight:600}.demo input,.demo textarea,.demo select{display:block;width:100%;max-width:100%;font:inherit;font-size:14px;line-height:1.6;padding:9px;border:1px solid #c7d5e6;border-radius:6px;background:white;color:#263c50;margin-top:5px}.demo textarea{height:88px}select[multiple]{height:88px}.choices{display:flex;flex-direction:column;gap:4px;margin-top:6px}.choice{display:flex;gap:8px;align-items:center;margin:0;font-weight:400}.choice input{width:auto;margin:0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}#notice{font-size:13px;color:#176044;background:#eff9f3;padding:9px;border-radius:6px;display:none;margin-bottom:10px}.footer{font-size:13px;color:#5b6b7c;text-align:center;padding:22px}#sec-9~p{overflow-wrap:anywhere}@media(max-width:900px){.layout{display:block;padding:22px 14px}aside{position:static;margin-bottom:22px;display:flex;flex-wrap:wrap;gap:4px 16px}aside strong{width:100%;margin:0}aside a{font-size:12px}article{padding:22px 20px}header{padding:36px 24px}h1{font-size:29px}.demo{padding:20px 16px}.phone{padding:10px}h2{font-size:22px}}@media print{aside,.demo{display:none}header{background:white;color:#111;padding:0}header p{color:#333}.layout{display:block;padding:0}article{border:0;padding:0}pre,table{break-inside:avoid}a{color:#111}}
${theme}</style></head><body data-guide="${doc.demo ? "user" : "developer"}"><header><div class="edition">FIELD GUIDE / 2026.09 · v0.5.2</div><div class="eyebrow">DINGTALK · PERSONAL REPLY ASSISTANT</div><h1>钉钉个人代回复助手<br>${doc.title}</h1><p>${doc.subtitle}</p><div class="badges"><span>助手 0.5.2</span><span>OpenClaw 2026.7.1-2 / 2026.8.1</span><span>默认关闭监听</span><span>${doc.audience}</span></div><div class="journey">${(doc.demo ? [["01 · 自主选择","从监听范围开始"],["02 · 看清再发","完整正文由你确认"],["03 · 少些打断","固定答复与汇总提醒"]] : [["01 · 理清边界","架构与可信身份"],["02 · 统一部署","配置模板与员工隔离"],["03 · 可复核交付","测试、性能与运维"]]).map(([title,text])=>`<div><b>${title}</b><small>${text}</small></div>`).join("")}</div></header><div class="layout"><aside><strong>CONTENTS · 阅读导航</strong><a href="#preview">交互预览</a>${toc.join("")}</aside><main><nav class="doc-switch"><a href="${doc.demo ? "../contributor/dws-reply-assistant-deployment.html" : "../user/dws-reply-assistant-manual.html"}">${doc.demo ? "开发与运维指南 ↗" : "员工使用手册 ↗"}</a><a href="#sec-1">从第一节开始 ↓</a></nav><div class="demo" id="preview"><h2>员工会看到什么</h2><p class="caption">离线页面示意，字段来自实际代码，使用预设示例数据。输入不会保存或真实校验，点击不会发送消息；实际设置请在钉钉中完成。</p><div class="tabs" id="tabs"></div><div class="phone"><div class="botline">我的工作助手 · 仅本人操作</div><div id="notice" role="status"></div><div class="card"><div class="cardtitle" id="cardtitle"></div><div class="cardbody"><div class="description" id="description"></div><div id="fields"></div><div class="actions" id="actions"></div><div class="card-expiry">卡片有效期至 09/24 15:30</div></div></div></div></div><article>${body}</article></main></div><div class="footer">本地可离线阅读 · 不依赖 CDN · 不收集数据 · 2026-09-24</div><script>const views=${JSON.stringify(views).replaceAll("<", "\\u003c")};${client}</script></body></html>`;
  if (!doc.demo) {
    html = html.replace(previewMarker, "")
      .replace(/<div class="demo" id="preview">[\s\S]*?<article>/, "<article>")
      .replace('<a href="#preview">交互预览</a>', "")
      .replace(/<script>[\s\S]*?<\/script>/, "");
  }
  if (doc.demo) {
    const preview = html.match(/<div class="demo" id="preview">[\s\S]*?<article>/)?.[0];
    if (!preview) throw new Error("Missing manual preview");
    html = html.replace(preview, "<article>").replace(previewMarker, preview.slice(0, -"<article>".length));
    html = html.replace('<a href="#preview">交互预览</a>', "").replace(toc[0], toc[0] + '<a href="#preview">交互预览</a>');
  }
  await writeFile(root + "/" + doc.source + ".html", html);
  process.stdout.write(
    JSON.stringify({ document: doc.source, bytes: Buffer.byteLength(html), headings: toc.length }) +
      "\n",
  );
}
await writeFile(
  root + "/docs/user/dws-send-approval-guide.html",
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>钉钉代回复助手 · 文档入口</title><style>body{max-width:800px;margin:10vh auto;padding:24px;font:18px/1.8 system-ui;color:#1d3043;background:#f3f7fc}a{display:block;padding:24px;margin:24px 0;background:white;border-radius:16px;color:#176bdd;text-decoration:none}small{display:block;color:#567}</style><h1>钉钉个人代回复助手</h1><p>请选择适合你的文档。两份文档独立阅读，均可离线打开。</p><a href="../contributor/dws-reply-assistant-deployment.html">开发人员：技术方案与安装配置<small>架构、部署、模板、权限、验证与运维</small></a><a href="dws-reply-assistant-manual.html">员工：使用手册<small>监听范围、回复确认、自动答复与常见问题</small></a></html>`,
);
