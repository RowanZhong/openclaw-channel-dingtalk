const button = (label, op, extra = {}) => ({ label, op, ...extra });
const text = (name, label, defaultValue = "", type = "TEXT_AREA") => ({
  name,
  label,
  type,
  required: false,
  defaultValue,
});
const select = (name, label, options, defaultValue) => ({
  name,
  label,
  type: "CHECKBOX_GROUP",
  required: false,
  defaultValue,
  options: options.map(([value, text]) => ({ value, text })),
});
const modes = [
  ["ai", "AI起草，我确认"],
  ["fixed", "固定正文，我确认"],
  ["inbox", "只整理消息"],
  ["off", "不处理"],
];
const scopeName = (scope) =>
  ({
    default: "默认规则",
    dm: "全部已监听私聊",
    all: "全部已监听消息",
    user: "指定人员",
    group: "指定群",
  })[scope];
const back = (label, op, extra) => button(`返回${label}`, op, extra);
export function buildConfigView(name, state, args, view, input) {
  const { prefs, settings, directory } = state;
  const targetLabel = (kind, ids) =>
    ids.map((id) => directory.find((x) => x.kind === kind && x.id === id)?.name || id).join("、");
  if (name === "reply") {
    view.title = "回复方式";
    view.description = `默认：${modes.find(([value]) => value === prefs.reply.default.mode)?.[1]}\n人员专属规则：${prefs.reply.users.length}项\n群专属规则：${prefs.reply.groups.length}项\n\n优先级：不处理 > 人员 > 群 > 默认。\n这里只设置处理方式，自动发送需单独授权。`;
    view.buttons = [
      button("修改默认规则", "reply-edit", { targetKind: "default" }),
      button("设置指定人员", "reply-target", { targetKind: "user" }),
      button("设置指定群", "reply-target", { targetKind: "group" }),
      back("首页", "home"),
    ];
  } else if (name === "reply-target") {
    const kind = args.targetKind === "group" ? "group" : "user";
    const saved = prefs.reply[kind === "group" ? "groups" : "users"];
    view.title = `回复方式 · ${scopeName(kind)}`;
    view.description = `填写${kind === "group" ? "完整群名" : "钉钉 UserId"}，多个用逗号或换行分隔。\n下一步先校验对象，再编辑规则。多人/多群将应用同一规则。\n\n已配置：${
      saved.length
        ? targetLabel(
            kind,
            saved.map((x) => x.id),
          )
        : "暂无"
    }`;
    view.fields = [
      text(
        "targetInput",
        kind === "group" ? "群名称" : "人员 UserId",
        input(
          kind,
          (args.targets || []).map((x) => x.id),
        ),
      ),
    ];
    view.buttons = [
      button("校验对象，下一步", "load-reply", { targetKind: kind }),
      back("回复方式", "reply"),
    ];
  } else if (name === "reply-edit") {
    const kind = args.targetKind || "default",
      targets = args.targets || [];
    const rule =
      kind === "default"
        ? prefs.reply.default
        : targets.length === 1
          ? prefs.reply[kind === "user" ? "users" : "groups"].find(
              (x) => x.id === targets[0].id,
            ) || { mode: "ai", text: "" }
          : { mode: "ai", text: "" };
    view.title = `编辑回复 · ${scopeName(kind)}`;
    view.description = `对象：${kind === "default" ? "默认规则" : targets.map((x) => `${x.name}（${x.userId || x.id.slice(-8)}）`).join("、")}`;
    view.fields = [
      select("mode", "处理方式", modes, rule.mode),
      text("requirements", "AI 写作要求 / 固定回复正文", rule.text),
    ];
    view.buttons = [
      button("保存回复规则", "save-reply"),
      button(kind === "default" ? "恢复默认要求" : "删除专属规则", "reset-reply"),
      back("回复方式", "reply"),
    ];
  } else if (name === "automation") {
    const count = settings.autoRules.filter((r) => r.expires > Date.now()).length;
    view.title = "自动答复与提醒";
    view.description = `有效自动答复：${count}条\n提醒：${{ digest: "定时汇总", immediate: "即时提醒", manual: "仅主动查看" }[settings.notifications.mode]}\n\n自动答复只发送你授权的固定正文。\n关闭提醒不会停止自动发送。`;
    view.buttons = [
      button("新增自动答复", "auto-new"),
      button("查看 / 撤销授权", "auto-manage"),
      button("提醒设置", "notifications"),
      button("暂停的会话", "pauses"),
      back("首页", "home"),
    ];
  } else if (name === "auto-manage") {
    const page = Math.max(
        0,
        Math.min(Number(args.page) || 0, Math.max(0, Math.ceil(settings.autoRules.length / 5) - 1)),
      ),
      rows = settings.autoRules.slice(page * 5, page * 5 + 5);
    const label = (r) =>
      `${scopeName(r.scope)}${r.target ? " · " + targetLabel(r.scope, [r.target]) : ""}`;
    view.title = "自动答复授权";
    view.description =
      `共${settings.autoRules.length}条 · 第${page + 1}页\n\n` +
      (rows
        .map(
          (r, i) =>
            `${i + 1}. ${label(r)}\n${r.expires > Date.now() ? "有效至" : "已到期"} ${new Date(r.expires).toLocaleString("zh-CN", { timeZone: settings.notifications.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}\n正文：${r.text}`,
        )
        .join("\n\n") || "尚未授权自动答复。");
    view.fields = rows.length
      ? [
          {
            name: "rules",
            label: "勾选本页要撤销的授权",
            type: "MULTI_CHECKBOX_GROUP",
            options: rows.map((r, i) => ({ value: r.id, text: `${i + 1}. ${label(r)}` })),
          },
        ]
      : [];
    view.buttons = [
      ...(rows.length ? [button("撤销所选授权", "revoke-auto")] : []),
      ...(page ? [button("上一页", "auto-manage", { page: page - 1 })] : []),
      ...((page + 1) * 5 < settings.autoRules.length
        ? [button("下一页", "auto-manage", { page: page + 1 })]
        : []),
      back("自动答复", "automation"),
    ];
  } else if (
    ["auto-new", "auto-content", "auto-limits", "auto-frequency", "auto-review"].includes(name)
  ) {
    const draft = args.wizard || {};
    const previous = (destination) => button("上一步", "auto-back", { destination });
    const cancel = button("取消，不授权", "automation");
    if (name === "auto-new") {
      view.title = "自动答复 · 1/5 选择范围";
      view.description =
        "只对已经监听的消息生效。\n指定对象填 UserId / 完整群名，多个用逗号或换行分隔。";
      view.fields = [
        select(
          "scope",
          "适用范围",
          [
            ["dm", "全部私聊"],
            ["all", "全部已监听消息"],
            ["user", "指定人员"],
            ["group", "指定群"],
          ],
          draft.scope || "dm",
        ),
        text("targetInput", "指定对象（选择全部时留空）", draft.targetInput || ""),
      ];
      view.buttons = [button("校验范围，下一步", "auto-next"), cancel];
    } else if (name === "auto-content") {
      view.title = "自动答复 · 2/5 正文";
      view.description = `范围：${scopeName(draft.scope)}\n只逐字发送以下正文，不让 AI 补充。\n关键词任一命中即回复；留空则匹配范围内全部消息。`;
      view.fields = [
        text("answer", "完整回复正文（最多160字符）", draft.answer || ""),
        text("keywords", "关键词（可留空，逗号或换行分隔）", draft.keywords || ""),
      ];
      view.buttons = [button("下一步：授权期限", "auto-next"), previous("auto-new"), cancel];
    } else if (name === "auto-limits") {
      view.title = "自动答复 · 3/5 授权期限";
      view.description = "最终确认后开始计时，到期停止自动答复。";
      view.fields = [
        select(
          "hours",
          "有效期",
          [
            ["1", "1小时"],
            ["8", "8小时"],
            ["24", "24小时"],
            ["168", "7天"],
          ],
          draft.hours || "8",
        ),
      ];
      view.buttons = [button("下一步：发送频率", "auto-next"), previous("auto-content"), cancel];
    } else if (name === "auto-frequency") {
      view.title = "自动答复 · 4/5 发送频率";
      view.description = "避免连续打扰同一会话。每实例每小时最多自动发送30条。";
      view.fields = [
        select(
          "cooldown",
          "同一会话最小间隔",
          [
            ["5", "5分钟"],
            ["30", "30分钟"],
            ["60", "1小时"],
            ["1440", "一天"],
          ],
          draft.cooldown || "30",
        ),
      ];
      view.buttons = [button("下一步：确认授权", "auto-next"), previous("auto-limits"), cancel];
    } else {
      view.title = "自动答复 · 5/5 确认授权";
      view.description = [
        `范围：${scopeName(draft.scope)}`,
        draft.targets?.length
          ? `对象：${draft.targets.map((x) => `${x.name}（${x.userId || x.id}）`).join("、")}`
          : "",
        `完整正文：\n${draft.answer || ""}`,
        `关键词：${draft.keywords || "不限制"}`,
        `有效期：${draft.hours}小时；同一会话间隔：${draft.cooldown}分钟`,
        "确认后将以你的身份自动发送以上固定正文。",
      ]
        .filter(Boolean)
        .join("\n\n");
      view.buttons = [button("确认授权自动发送", "save-auto"), previous("auto-frequency"), cancel];
    }
  } else if (name === "notifications") {
    const n = settings.notifications;
    view.title = "提醒设置";
    view.description = `提醒方式：${{ digest: "定时汇总", immediate: "即时提醒", manual: "仅主动查看" }[n.mode]}\n汇总间隔：${n.minutes}分钟\n免打扰：${n.quietStart === n.quietEnd ? "关闭" : `${n.quietStart}–${n.quietEnd}`}\n时区：${n.timezone}\n重点联系人：${n.priorityUsers.length}人\n\n提醒设置不影响已授权的自动发送。`;
    view.buttons = [
      button("提醒方式", "notice-delivery"),
      button("汇总间隔", "notice-frequency"),
      button("免打扰时段", "notice-quiet"),
      button("重点联系人", "notice-priority"),
      back("自动答复与提醒", "automation"),
    ];
  } else if (
    ["notice-delivery", "notice-frequency", "notice-quiet", "notice-priority"].includes(name)
  ) {
    const n = settings.notifications;
    view.title = {
      "notice-delivery": "提醒方式",
      "notice-frequency": "汇总间隔",
      "notice-quiet": "免打扰时段",
      "notice-priority": "重点联系人",
    }[name];
    if (name === "notice-delivery") {
      view.description =
        "仅主动查看：不主动提醒。\n定时汇总：按选定间隔提醒；即时提醒仍会合并短时间内来信。";
      view.fields = [
        select(
          "mode",
          "提醒方式",
          [
            ["digest", "定时汇总"],
            ["immediate", "即时提醒"],
            ["manual", "仅主动查看"],
          ],
          n.mode,
        ),
      ];
    } else if (name === "notice-frequency") {
      view.description = "仅选择“定时汇总”时生效。";
      view.fields = [
        select(
          "minutes",
          "汇总间隔（仅定时汇总生效）",
          [
            ["5", "5分钟"],
            ["15", "15分钟"],
            ["30", "30分钟"],
            ["60", "1小时"],
          ],
          String(n.minutes),
        ),
      ];
    } else if (name === "notice-quiet") {
      view.description =
        "免打扰期间不主动提醒，仍可主动查看。\n时间使用24小时制 HH:MM；起止相同表示关闭。";
      view.fields = [
        text("quietStart", "开始时间", n.quietStart, "TEXT"),
        text("quietEnd", "结束时间", n.quietEnd, "TEXT"),
        text("timezone", "时区", n.timezone, "TEXT"),
      ];
    } else {
      view.description =
        "在非免打扰时段即时提醒。\n填写 UserId；多个用逗号或换行分隔。留空并保存可清空。";
      view.fields = [text("priorityUsers", "重点联系人 UserId", input("user", n.priorityUsers))];
    }
    view.buttons = [
      button("保存本项", "save-notifications", { section: name }),
      back("提醒设置", "notifications"),
    ];
  } else return false;
  return true;
}
