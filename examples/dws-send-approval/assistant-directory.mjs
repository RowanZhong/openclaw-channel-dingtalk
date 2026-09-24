import { runDws } from "./assistant-dws.mjs";
import { stableId } from "./preferences.mjs";

export function splitTargets(raw, max = 20) {
  if (
    typeof raw !== "string" ||
    raw.length > 6000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(raw)
  ) {
    throw new Error("输入无效；请用逗号或换行分隔。");
  }
  const parts = [
    ...new Set(
      raw
        .split(/[,，\r\n]+/u)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (parts.length > max || parts.some((x) => x.length > 300))
    throw new Error(`最多填写${max}项。`);
  return parts;
}
function dataOf(result) {
  const d = result?.data ?? result;
  if (!d || d.success === false || d.error || d.errorCode || result?.ok === false) {
    throw new Error("目录查询失败，请检查 DWS 授权；未保存设置。");
  }
  return d;
}
export function targetInput(kind, ids, directory) {
  return ids
    .map((id) => {
      const row = directory.find((x) => x.kind === kind && x.id === id);
      return kind === "user"
        ? row?.userId || `open:${id}`
        : row?.name
          ? `${row.name}#${id}`
          : `id:${id}`;
    })
    .join("\n");
}
// Inputs are explicitly entered by the owner. Never guess an ID or select the
// first fuzzy match. Group searches must finish pagination before uniqueness.
export async function resolveTargets(
  config,
  kind,
  raw,
  { runner = runDws, existing = [], directory = [] } = {},
) {
  if (!["user", "group"].includes(kind)) throw new Error("对象类型无效。");
  const parts = splitTargets(raw),
    rows = [];
  for (const part of parts) {
    const legacy = (kind === "user" ? /^open:(.+)$/ : /^id:(.+)$/).exec(part);
    if (legacy) {
      if (!existing.includes(legacy[1]))
        throw new Error("旧开放ID只能保留已保存的对象；新增人员请填写 UserId，新增群请填写群名。");
      rows.push(
        directory.find((x) => x.kind === kind && x.id === legacy[1]) || {
          kind,
          id: legacy[1],
          name: legacy[1],
        },
      );
      continue;
    }
    if (kind === "user") {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(part))
        throw new Error("请填写钉钉 UserId，不是姓名或开放ID。");
      const d = dataOf(
        await runner(config, ["contact", "user", "search", "--query", part, "--format", "json"]),
      );
      if (!Array.isArray(d.result)) throw new Error("人员查询返回结构无效；未保存。");
      const matches = d.result.filter((x) => x.userId === part && stableId(x.openDingTalkId));
      const unique = [...new Map(matches.map((x) => [x.openDingTalkId, x])).values()];
      if (unique.length !== 1)
        throw new Error(`UserId ${part} 未能唯一匹配；请核对组织、UserId 和可见范围。`);
      const x = unique[0];
      rows.push({
        kind,
        id: x.openDingTalkId,
        userId: part,
        name: String(x.name || x.nick || part).slice(0, 100),
      });
    } else {
      const pos = part.lastIndexOf("#"),
        name = pos > 0 ? part.slice(0, pos).trim() : part;
      const exactId = pos > 0 ? part.slice(pos + 1) : undefined;
      if (!name || name.length > 100 || (exactId && !stableId(exactId)))
        throw new Error("群名无效；重名时用 完整群名#会话ID。");
      let cursor = "0",
        complete = false;
      const found = new Map(),
        cursors = new Set();
      for (let page = 0; page < 5; page++) {
        const d = dataOf(
          await runner(config, [
            "chat",
            "search",
            "--query",
            name,
            "--limit",
            "100",
            "--cursor",
            cursor,
            "--format",
            "json",
          ]),
        );
        const result = d.result;
        if (!Array.isArray(result?.groups) || typeof result.hasMore !== "boolean")
          throw new Error("群查询返回结构无效；未保存。");
        for (const x of result.groups) {
          if (String(x.title || x.name || "").trim() === name && stableId(x.openConversationId))
            found.set(x.openConversationId, x);
        }
        if (!result.hasMore) {
          complete = true;
          break;
        }
        if (
          typeof result.nextCursor !== "string" ||
          !result.nextCursor ||
          cursors.has(result.nextCursor)
        )
          break;
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      if (!complete)
        throw new Error(`群“${name}”查询未完整，未保存；请缩小名称范围或检查 DWS 返回。`);
      const matches = [...found.values()].filter(
        (x) => !exactId || x.openConversationId === exactId,
      );
      if (matches.length !== 1) {
        const choices = [...found.keys()]
          .slice(0, 5)
          .map((id) => `${name}#${id}`)
          .join("\n");
        throw new Error(
          matches.length
            ? `群名重名，未保存。请复制正确项：\n${choices}`
            : `没有唯一匹配群“${name}”，未保存。请填写完整群名并核对可见范围。`,
        );
      }
      rows.push({ kind, id: matches[0].openConversationId, name, lookupAt: Date.now() });
    }
  }
  return [...new Map(rows.map((x) => [x.id, x])).values()];
}
// Kept as a read-only exact-validation entry for tooling.
export const searchDirectory = (config, kind, query, runner) =>
  resolveTargets(config, kind, query, { runner });

// Display-only lookup for ID-based slash commands. Names never authorize a target.
// Four workers and a shared five-second budget bound cold status requests.
export async function resolveGroupLabels(
  config,
  ids,
  directory,
  { runner = runDws, now = Date.now() } = {},
) {
  const queue = [...new Set(ids)].slice(0, 20).filter((id) => {
    const row = directory.find((x) => x.kind === "group" && x.id === id);
    return (
      stableId(id) &&
      (!row || now - (row.lookupAt || 0) >= (row.name && row.name !== id ? 3600000 : 60000))
    );
  });
  const rows = [],
    deadline = Date.now() + 5000;
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && Date.now() < deadline) {
        const id = queue.shift();
        const previous = directory.find((x) => x.kind === "group" && x.id === id);
        let row = { ...previous, kind: "group", id, lookupAt: now };
        try {
          const d = dataOf(
            await runner(config, ["chat", "conversation-info", "--group", id, "--format", "json"], {
              timeoutMs: Math.max(1, Math.min(2000, deadline - Date.now())),
            }),
          );
          const info = d.result?.conversationInfo;
          if (
            info?.openConversationId === id &&
            info.singleChat === false &&
            typeof info.title === "string" &&
            info.title.trim()
          )
            row = { ...row, name: info.title.trim().slice(0, 100) };
        } catch {
          /* Preserve the stable ID; a display lookup never fails a saved setting. */
        }
        rows.push(row);
      }
    }),
  );
  return rows;
}
