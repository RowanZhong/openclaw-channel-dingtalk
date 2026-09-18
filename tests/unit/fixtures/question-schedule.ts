import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
const shared = vi.hoisted(() => ({ post: vi.fn(), update: vi.fn(), inbound: vi.fn(), send: vi.fn(), pairing: vi.fn() }));
vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({ readChannelAllowFromStoreSync: shared.pairing }));
vi.mock("../../../src/platform/auth", () => ({ getAccessToken: vi.fn(async () => "token") }));
vi.mock("../../../src/shared/http-client", () => ({ default: { post: shared.post } }));
vi.mock("../../../src/card/card-callback-service", () => ({ updateCardVariables: shared.update }));
vi.mock("../../../src/gateway/inbound-handler", () => ({ handleDingTalkMessage: shared.inbound }));
vi.mock("../../../src/messaging/send-service", () => ({ sendMessage: shared.send }));

import { registerDingTalkFormScheduleTool } from "../../../src/card/question-schedule";
import { clearPendingQuestionsForTest, executeDingTalkQuestion, handleDingTalkAskUserCardCallback } from "../../../src/card/ask-user-question";
import { withDingTalkQuestionContext, withDingTalkQuestionToolRun } from "../../../src/card/ask-user-question-context";
import { QuestionScheduleStore } from "../../../src/card/question-schedule-store";

export const mocks = shared;
export const form = { title: "项目进展", fields: [{ name: "progress", label: "进展", type: "TEXT" }], target: { type: "group", id: "cid_team", respondentUserIds: ["staff_A", "staff_B"] }, timeoutMinutes: 1 };
export function setupSchedule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-cron-"));
  const config = { clientId: "client", clientSecret: "secret", dmPolicy: "open", groupPolicy: "open" };
  const cfg = { channels: { dingtalk: config } };
  const context: any = {
    cfg, accountId: "default", dingtalkConfig: config, storePath: path.join(dir, "sessions.json"),
    questionScopeKey: "default:owner:staff_owner", sessionWebhook: "https://secret-webhook.test",
    resolvedRoute: { agentId: "main", sessionKey: "agent:main:main", mainSessionKey: "agent:main:main" },
    data: { msgId: "message1", msgtype: "text", text: { content: "create schedule" }, createAt: Date.now(),
      conversationType: "1", conversationId: "cid_origin", senderStaffId: "staff_owner", senderId: "staff_owner",
      senderNick: "发起人", chatbotUserId: "bot", sessionWebhook: "https://secret-webhook.test" },
  };
  let factory: any;
  const api: any = { config: cfg, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    registerTool: (fn: any) => { factory = fn; },
    runtime: { state: { resolveStateDir: () => dir }, channel: { session: { resolveStorePath: vi.fn((_store, { agentId }) => agentId === context.accountId ? context.storePath : path.join(dir, agentId, "sessions.json")) } } },
  };
  registerDingTalkFormScheduleTool(api);
  shared.post.mockReset().mockResolvedValue({ status: 200, data: { result: { deliverResults: [{ success: true }] } } });
  shared.update.mockReset().mockResolvedValue(undefined);
  shared.send.mockReset().mockResolvedValue({ ok: true });
  shared.inbound.mockReset().mockResolvedValue(undefined);
  shared.pairing.mockReset().mockReturnValue([]);
  const store = new QuestionScheduleStore(dir);
  const chat = (input: unknown, origin = context) => withDingTalkQuestionContext(origin, () => withDingTalkQuestionToolRun(origin, async () => (await factory({ agentId: origin.resolvedRoute.agentId, sessionKey: origin.resolvedRoute.sessionKey }).execute("chat", input)).details));
  const prepare = (overrides = {}) => chat({ action: "prepare", name: "每日进展", form, schedule: { kind: "every", everyMs: 60_000 }, respondentNames: { staff_A: "小林", staff_B: "小陈" }, ...overrides });
  const bind = async (overrides = {}) => {
    const prepared = await prepare(overrides);
    const jobId = randomUUID();
    const bound = await chat({ action: "bind", scheduleId: prepared.scheduleId, jobId });
    if (bound.status !== "bound") throw new Error(JSON.stringify(bound));
    return { ...prepared, jobId };
  };
  const run = async (bound: any, sequence = 1, overrides = {}) => (await factory({ agentId: "main", sessionKey: `agent:main:cron:${bound.jobId}:trigger`, ...overrides }).execute("cron", { action: "run", scheduleId: bound.scheduleId, sequence })).details;
  const submit = async (sent: any, user: string, params: unknown = { form: { progress: "已完成开发" } }) => {
    const handled = await handleDingTalkAskUserCardCallback({ payload: { outTrackId: sent.outTrackId, content: JSON.stringify({ cardPrivateData: { actionIds: [sent.questionId], params } }) }, cfg: cfg as any, accountId: "default", storePath: context.storePath, config: config as any, clickerUserId: user });
    await new Promise((resolve) => setImmediate(resolve));
    return handled;
  };
  return { dir, cfg, config, context, api, store, chat, prepare, bind, run, submit,
    manage: async (params: unknown) => (await executeDingTalkQuestion(context, params)).details as any,
    cleanup: () => { clearPendingQuestionsForTest(); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
