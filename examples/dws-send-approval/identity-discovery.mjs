import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { IdentityError, cancelled } from "./identity-cli.mjs";

export const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;
const token = (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(s);
const openId = (s) =>
  typeof s === "string" && s.length > 0 && s.length <= 512 && !/[\s\p{C}]/u.test(s);
const validName = (s) =>
  typeof s === "string" && Boolean(s.trim()) && s.length <= 300 && !/\p{C}/u.test(s);
const bad = (message) => {
  throw new IdentityError("failed", message);
};
function success(data) {
  if (!data || data.success !== true || data.error || data.errorCode)
    bad("DWS 身份查询业务结果无效。");
  return data;
}
export function channelRobot(config, host) {
  const channel = host.channels?.dingtalk;
  const account =
    channel?.accounts?.[config.accountId] ?? (config.accountId === "default" ? channel : undefined);
  const rawClientId = account?.clientId ?? channel?.clientId;
  const clientId = typeof rawClientId === "string" ? rawClientId.trim() : "";
  if (!account || channel?.enabled === false || account.enabled === false || !token(clientId)) {
    throw new IdentityError("unavailable", "对应钉钉 accountId 未配置有效的机器人 clientId。");
  }
  return clientId;
}
export function selectProfile(data, config) {
  success(data);
  if (!Array.isArray(data.profiles)) bad("DWS profile 列表结构无效。");
  if (!data.currentProfile || !data.profiles.length) {
    throw new IdentityError("waiting_login", "尚未登录 DWS，请登录后发送 /dws identity refresh。");
  }
  const matches = data.profiles.filter(
    (p) =>
      p.isCurrent === true &&
      [p.profile, `${p.corpId}:${p.userId}`, p.corpId].includes(data.currentProfile),
  );
  if (matches.length !== 1) bad("DWS 当前账号无法唯一确定，请明确选择本人账号。");
  const p = matches[0];
  if (!token(p.corpId) || !token(p.userId) || !token(p.clientId))
    bad("DWS 当前账号缺少有效的组织、用户或授权应用 ID。");
  if (p.userId !== config.ownerUserId)
    throw new IdentityError("account_mismatch", "DWS 当前登录账号与实例主人不一致，代回复已暂停。");
  if (["revoked", "unavailable"].includes(p.status))
    throw new IdentityError("waiting_login", "DWS 登录不可用，请重新授权后检测。");
  // Expired access tokens may still have a valid refresh token; DWS owns refresh.
  const profile = `${p.corpId}:${p.userId}`;
  if (config.profile && ![profile, p.profile, p.corpId].includes(config.profile)) {
    throw new IdentityError("account_mismatch", "旧 profile 配置与当前账号不一致，请先迁移配置。");
  }
  return { profile, corpId: p.corpId, userId: p.userId, dwsClientId: p.clientId };
}
export function makeBinding(profile, config, robotCode) {
  return {
    ...profile,
    ownerUserId: config.ownerUserId,
    accountId: config.accountId,
    channelClientId: robotCode,
    dwsConfigDir: resolve(process.env.DWS_CONFIG_DIR || join(homedir(), ".dws")),
  };
}
export const sameBinding = (a, b) =>
  a &&
  b &&
  Object.keys(b).every((k) => a[k] === b[k]) &&
  Object.keys(a).length === Object.keys(b).length;
export async function readIdentity(stateDir, binding) {
  try {
    const file = await readFile(join(stateDir, "dws-send-approval", "identity.json"), "utf8");
    if (file.length > 65536) bad("身份缓存异常，请管理员检查；未覆盖原数据。");
    const saved = JSON.parse(file);
    if (saved.version !== 1 || !saved.binding) bad("身份缓存版本或格式无效。");
    if (!sameBinding(saved.binding, binding))
      throw new IdentityError(
        "account_mismatch",
        "员工、DWS 授权应用或社区机器人绑定已变化，请管理员核对数据后迁移；原数据保留。",
      );
    if (
      saved.robot &&
      (!validName(saved.robot.name) ||
        !openId(saved.robot.openId) ||
        !Number.isFinite(saved.robot.checkedAt))
    )
      bad("机器人身份缓存无效。");
    if (saved.owner && (!openId(saved.owner.openId) || !Number.isFinite(saved.owner.checkedAt)))
      bad("本人开放 ID 缓存无效。");
    return saved;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, binding };
    if (error instanceof IdentityError) throw error;
    throw new IdentityError("failed", "身份缓存无法读取，请检查文件与权限；原数据保留。");
  }
}
export async function writeIdentity(stateDir, record, signal) {
  if (signal?.aborted) throw cancelled();
  const dir = join(stateDir, "dws-send-approval");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.identity-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (signal?.aborted) throw cancelled();
    await rename(temporary, join(dir, "identity.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
export const validRobotCache = (record, now = Date.now()) =>
  Boolean(
    record?.robot &&
    record.robot.checkedAt <= now &&
    now - record.robot.checkedAt < IDENTITY_TTL_MS,
  );

export const validOwnerCache = (record, now = Date.now()) =>
  Boolean(
    record?.owner &&
    record.owner.checkedAt <= now &&
    now - record.owner.checkedAt < IDENTITY_TTL_MS,
  );

export async function discoverOwner(binding, call, now = Date.now) {
  const data = success(
    await call([
      "--profile",
      binding.profile,
      "contact",
      "user",
      "search",
      "--query",
      binding.ownerUserId,
      "--format",
      "json",
    ]),
  );
  if (!Array.isArray(data.result)) bad("本人开放 ID 查询格式无效。");
  const matches = data.result.filter((row) => row.userId === binding.ownerUserId);
  if (matches.some((row) => !openId(row.openDingTalkId))) bad("本人开放 ID 无效。");
  const ids = new Set(matches.map((row) => row.openDingTalkId));
  if (ids.size !== 1) bad("本人 UserId 未唯一匹配到开放 ID，未启用监听。");
  return { openId: [...ids][0], checkedAt: now() };
}

export async function discoverRobot(binding, call, now = Date.now) {
  let name;
  for (let page = 1; page <= 5; page++) {
    const data = success(
      await call([
        "--profile",
        binding.profile,
        "chat",
        "bot",
        "search",
        "--page",
        String(page),
        "--size",
        "50",
        "--format",
        "json",
      ]),
    );
    if (!Array.isArray(data.robotList)) bad("机器人列表格式无效。");
    const matches = data.robotList.filter((r) => r.robotCode === binding.channelClientId);
    if (matches.length > 1) bad("机器人 robotCode 返回重复项，未选择任何结果。");
    if (matches.length === 1) {
      name = matches[0].robotName;
      break;
    }
    if (!data.robotList.length) break;
  }
  if (!validName(name))
    bad("未找到与社区 clientId 对应的本人机器人，请检查 DWS 账号与机器人配置。");
  let cursor,
    complete = false;
  const ids = new Set(),
    cursors = new Set();
  for (let page = 0; page < 5; page++) {
    const data = success(
      await call([
        "--profile",
        binding.profile,
        "chat",
        "bot",
        "find",
        "--query",
        name,
        "--limit",
        "20",
        ...(cursor ? ["--cursor", cursor] : []),
        "--format",
        "json",
      ]),
    );
    const result = data.result;
    if (!Array.isArray(result?.bots) || typeof result.hasMore !== "boolean")
      bad("机器人开放 ID 查询格式无效。");
    for (const bot of result.bots) {
      if (bot.name === name) {
        if (!openId(bot.botOpenDingTalkId)) bad("机器人开放 ID 无效。");
        ids.add(bot.botOpenDingTalkId);
      }
    }
    if (!result.hasMore) {
      complete = true;
      break;
    }
    if (!openId(result.nextCursor) || cursors.has(result.nextCursor))
      bad("机器人查询分页游标无效或重复。");
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  if (!complete) bad("机器人查询超过分页上限，未确认身份。");
  if (ids.size !== 1) bad("机器人名称未唯一匹配到开放 ID，未启用监听。");
  return { name, openId: [...ids][0], checkedAt: now() };
}
