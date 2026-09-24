import { buildConfigView } from "./assistant-config-views.mjs";
import { targetInput } from "./assistant-directory.mjs";
import { PENDING } from "./assistant-store.mjs";

const button = (label, op, extra = {}) => ({ label, op, ...extra });
const field = (name, label, type = "TEXT", extra = {}) => ({
  name,
  label,
  type,
  required: false,
  ...extra,
});
const select = (name, label, values, value) =>
  field(name, label, "CHECKBOX_GROUP", {
    defaultValue: value,
    options: values.map(([value, text]) => ({ value, text })),
  });
const text = (name, label, value = "") => field(name, label, "TEXT_AREA", { defaultValue: value });
const labels = {
  generating: "正在拟稿",
  pending: "待确认",
  inbox: "仅整理",
  stale: "有新消息，需刷新",
  "draft-error": "拟稿未完成",
  sending: "发送中",
  sent: "已发送",
  unknown: "发送结果待核实",
  ignored: "已忽略",
  expired: "已过期",
  superseded: "已有更新草稿",
  suppressed: "频率限制，本次未发",
};
export function draftLabel(d, directory = []) {
  const name = (kind, id, fallback) => {
    const display = directory.find((x) => x.kind === kind && x.id === id)?.name || fallback;
    return display
      ? `${String(display).replace(/\p{C}/gu, " ").slice(0, 60)} (${id.slice(-8)})`
      : id;
  };
  const sender = name("user", d.event.sender_open_dingtalk_id, d.event.sender);
  return d.reply.direct
    ? `${sender} · 私聊`
    : `${name("group", d.event.conversation_id)} · ${sender}`;
}
export function buildView(name, state, args = {}) {
  const { prefs, settings, store, directory, listener } = state;
  const input = (kind, ids) => targetInput(kind, ids, directory);
  const view = {
    title: "代回复助手",
    description: "",
    fields: [],
    buttons: [],
    refs: [],
    name,
    args,
  };
  const home = button("返回首页", "home");
  if (name === "home") {
    const count = store.list([...PENDING, "unknown"]).length;
    view.description = `监听：${prefs.enabled ? "已开启" : "已关闭"}（${{ off: "已关闭", ready: "就绪", starting: "连接中", failed: "故障", unavailable: "初始化中" }[listener.state] || "待检查"}）\n私聊：${{ off: "关闭", all: "全部", users: "指定人员" }[prefs.rules.dm.mode]}；群@我：${{ off: "关闭", all: "所有群", groups: "指定群" }[prefs.rules.at.mode]}；额外发送者：${prefs.rules.sender.ids.length}人\n待处理：${count}条；有效自动答复：${settings.autoRules.filter((r) => r.expires > Date.now()).length}条\n发送使用你的身份；未授权内容由你确认。`;
    view.buttons = [
      button("查看待回复", "inbox"),
      button("监听范围", "listen"),
      button("回复方式", "reply"),
      button("自动答复与提醒", "automation"),
      button("处理记录", "history"),
      button(prefs.enabled ? "暂停全部" : "开启监听", "toggle"),
    ];
  } else if (name === "listen") {
    const describe = (key, kind) => {
      const rule = prefs.rules[key];
      if (rule.mode === "off") return "未监听";
      if (rule.mode === "all") return key === "dm" ? "全部私聊" : "所有群 @本人";
      return rule.ids
        .map((id) => {
          const row = directory.find((x) => x.kind === kind && x.id === id);
          return `· ${row?.name && row.name !== id ? String(row.name).replace(/\p{C}/gu, " ") : "名称待核实"}（${id.slice(-8)}）`;
        })
        .join("\n");
    };
    view.title = "监听范围";
    view.description = [
      `当前：${prefs.enabled ? "监听已开启，保存后立即生效" : "监听已关闭，保存后仍关闭"}`,
      `① 私聊\n${describe("dm", "user")}`,
      `② 群内 @本人\n${describe("at", "group")}`,
      `③ 额外发送者（高级）\n${describe("sender", "user")}`,
      "任一范围命中即处理，同一条消息只处理一次。",
    ].join("\n\n");
    view.buttons = [
      button("设置私聊", "listen-dm"),
      button("设置群 @本人", "listen-at"),
      button("设置额外发送者", "listen-sender"),
      button("校验人员或群", "directory"),
      home,
    ];
  } else if (["listen-dm", "listen-at", "listen-sender"].includes(name)) {
    const key = name.slice(7);
    const rule = prefs.rules[key];
    const group = key === "at";
    view.title = { dm: "私聊范围", at: "群内 @本人", sender: "额外发送者 · 高级" }[key];
    view.description = [
      key === "sender"
        ? "包含指定人员的私聊和群内发言，即使没有 @你。只需要私聊 + 群 @ 时，请保持关闭。"
        : group
          ? "只处理群里 @你的消息，不处理群内其他发言。"
          : "选择全部私聊，或仅指定人员。",
      group
        ? "指定群填完整群名；多个用逗号或换行分隔。"
        : "指定人员填钉钉 UserId；多个用逗号或换行分隔。",
      "每组最多20项。只保存本组，其他范围保持不变。",
    ].join("\n\n");
    view.fields = [
      select(
        key,
        "选择范围",
        [
          ["off", "关闭"],
          ...(key === "sender" ? [] : [["all", group ? "所有群 @本人" : "全部私聊"]]),
          [group ? "groups" : "users", group ? "指定群" : "指定人员"],
        ],
        rule.mode,
      ),
      text(
        `${key}Ids`,
        group ? "群名称（仅选“指定群”时填写）" : "UserId（仅选“指定人员”时填写）",
        input(group ? "group" : "user", rule.ids),
      ),
    ];
    view.buttons = [
      button("校验并保存本组", "save-listen", { section: key }),
      button("取消，返回范围", "listen"),
    ];
  } else if (name === "directory") {
    view.title = "校验人员或群";
    view.description =
      "人员填写钉钉 UserId（不一定等于企业自定义工号），群填写完整群名。逗号或换行分隔。仅校验，不改变监听。";
    view.fields = [
      select(
        "kind",
        "对象类型",
        [
          ["user", "人员 UserId"],
          ["group", "群名称"],
        ],
        "user",
      ),
      text("query", "UserId 或完整群名"),
    ];
    view.buttons = [button("校验", "search-directory"), button("监听范围", "listen"), home];
  } else if (name === "search-results") {
    view.title = "校验结果";
    view.description =
      args.results.map((x) => `${x.name} · ${x.userId || x.id}`).join("\n") +
      "\n校验成功，未改变监听范围。";
    view.buttons = [button("监听范围", "listen"), button("继续校验", "directory"), home];
  } else if (buildConfigView(name, state, args, view, input)) {
    // Configuration pages are kept short and grouped by one user decision.
  } else if (name === "pauses") {
    const all = Object.entries(settings.pauses).filter(([, until]) => until > Date.now());
    const page = Math.max(
      0,
      Math.min(Number(args.page) || 0, Math.max(0, Math.ceil(all.length / 5) - 1)),
    );
    view.title = "暂停的会话";
    view.description = `共${all.length}个 · 第${page + 1}页。恢复不自动重发旧消息。`;
    view.fields = [
      field("conversations", "会话", "MULTI_CHECKBOX_GROUP", {
        options: all.slice(page * 5, page * 5 + 5).map(([value]) => ({
          value,
          text: directory.find((x) => x.id === value)?.name || value,
        })),
      }),
    ];
    view.buttons = [
      ...(view.fields[0].options.length ? [button("恢复所选", "resume")] : []),
      ...(page ? [button("上一页", "pauses", { page: page - 1 })] : []),
      ...((page + 1) * 5 < all.length ? [button("下一页", "pauses", { page: page + 1 })] : []),
      home,
    ];
  } else if (name === "draft" || name === "edit" || name === "regenerate" || name === "pause") {
    const d = store.draft(args.id);
    if (!d) {
      throw new Error("这条记录不存在或已清理。");
    }
    view.title = `#${d.id}-${d.version} · ${draftLabel(d, directory)}`;
    view.description = `${labels[d.status] || d.status}\n原消息：${d.event.content.slice(0, 3000)}\n\n将以你的身份回复：\n${d.text || "尚未生成"}${d.error ? `\n${d.error}` : ""}`;
    view.refs = [{ id: d.id, version: d.version }];
    if (name === "edit") {
      view.description = `接收对象不变。修改后点击发送即发送输入框中的完整正文。\n原消息：${d.event.content.slice(0, 160)}`;
      view.fields = [text("body", "修改后直接发送的完整正文", d.text)];
      view.buttons = [
        button("发送修改后的内容", "edit-send"),
        button("返回草稿", "draft", { id: d.id }),
      ];
    } else if (name === "regenerate") {
      view.description = "只重新生成草稿，确认后再发送。";
      view.fields = [
        select(
          "style",
          "调整方向",
          [
            ["", "按原要求"],
            ["更简短", "更简短"],
            ["更正式", "更正式"],
          ],
          "",
        ),
        text("hint", "补充写作要求"),
        text("material", "本人补充资料（仅用于本条，不加入自动答复）"),
      ];
      view.buttons = [button("重新拟稿", "generate"), button("返回草稿", "draft", { id: d.id })];
    } else if (name === "pause") {
      view.description = "暂停这个会话，现有待处理草稿将忽略。到期恢复监听，不自动重发旧消息。";
      view.fields = [
        select(
          "hours",
          "暂停多久",
          [
            ["1", "1小时"],
            ["8", "8小时"],
            ["24", "一天"],
            ["87600", "直到手动恢复"],
          ],
          "8",
        ),
      ];
      view.buttons = [
        button("我来处理并暂停", "pause-conversation"),
        button("返回草稿", "draft", { id: d.id }),
      ];
    } else if (PENDING.has(d.status)) {
      view.buttons = [
        ...(d.status === "pending"
          ? [button("发送", "send"), button("修改", "edit", { id: d.id })]
          : []),
        button("重新拟稿", "regenerate", { id: d.id }),
        button("忽略", "ignore"),
        button("我来处理", "pause", { id: d.id }),
        home,
      ];
    } else {
      view.buttons = [button("查看待回复", "inbox"), home];
    }
  } else if (name === "inbox" || name === "history") {
    const history = name === "history",
      page = Math.max(0, Number(args.page) || 0),
      all = store.list(history ? null : [...PENDING, "unknown"]);
    const rows = all.slice(page * 3, page * 3 + 3);
    view.title = history ? "处理记录" : "待我处理";
    view.description =
      `共${all.length}条 · 第${page + 1}页\n\n` +
      rows
        .map(
          (d) =>
            `#${d.id} ${draftLabel(d, directory)} · ${labels[d.status]}\n原消息：${d.event.content.slice(0, 160)}\n拟回复：${d.text || "尚未生成"}`,
        )
        .join("\n\n");
    view.refs = rows.map((d) => ({ id: d.id, version: d.version }));
    view.fields = [
      field("selected", "选择本页记录", "MULTI_CHECKBOX_GROUP", {
        options: rows.map((d) => ({
          value: String(d.id),
          text: `#${d.id} ${draftLabel(d, directory)}`,
        })),
      }),
    ];
    view.buttons = [
      ...(rows.length ? [button("查看所选第一条", "open-selected")] : []),
      ...(!history && rows.length
        ? [button("发送所选", "send-selected"), button("忽略所选", "ignore-selected")]
        : []),
      ...(page > 0 ? [button("上一页", name, { page: page - 1 })] : []),
      ...(all.length > (page + 1) * 3 ? [button("下一页", name, { page: page + 1 })] : []),
      home,
    ];
  } else {
    throw new Error("不支持的页面。");
  }
  view.fields = view.fields.filter((f) => !f.options || f.options.length > 0);
  return view;
}
