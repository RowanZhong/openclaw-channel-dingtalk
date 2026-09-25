import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../config.mjs";

export const cfg = readConfig(
  { ownerUserId: "owner", dwsPath: "/opt/dws", assistant: { cardTemplateId: "template" } },
  { discovery: true },
);
export const host = { channels: { dingtalk: { clientId: "robot-code" } } };
export const profiles = () => ({
  success: true,
  currentProfile: "corp:owner",
  profiles: [
    {
      profile: "corp:owner",
      corpId: "corp",
      userId: "owner",
      clientId: "oauth-code",
      isCurrent: true,
      status: "active",
    },
  ],
});
export const search = () => ({
  success: true,
  robotList: [{ robotCode: "robot-code", robotName: "小钉" }],
});
export const find = () => ({
  success: true,
  result: {
    bots: [{ name: "小钉", botOpenDingTalkId: "open-bot" }],
    hasMore: false,
    nextCursor: "irrelevant",
  },
});
export const answer = (args) =>
  args[0] === "profile"
    ? profiles()
    : args.includes("contact")
      ? { success: true, result: [{ userId: "owner", openDingTalkId: "open-owner" }] }
      : args.includes("search")
        ? search()
        : find();
export async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), "dws-identity-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export const context = (dir) => ({
  stateDir: dir,
  config: host,
  logger: { info() {}, warn() {}, error() {} },
  serviceHealth: {
    reportFailure() {
      throw Error("identity must not fail Gateway health");
    },
  },
});
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export async function until(check) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("test condition timed out");
}
