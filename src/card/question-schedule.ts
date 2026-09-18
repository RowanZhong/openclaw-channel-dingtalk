import { createHash, randomUUID } from "node:crypto";
import { readChannelAllowFromStoreSync } from "openclaw/plugin-sdk/channel-pairing";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { z } from "zod";
import { sendMessage } from "../messaging/send-service";
import {
  isSenderAllowed,
  normalizeAllowFrom,
  resolveGroupAccess,
} from "../platform/access-control";
import { getConfig } from "../platform/config";
import { executeDingTalkQuestion, hasActiveDingTalkCollection } from "./ask-user-question";
import {
  getDingTalkQuestionToolContext,
  resolveDingTalkQuestionToolContext,
  type DingTalkQuestionContext,
} from "./ask-user-question-context";
import { parseQuestionTarget } from "./ask-user-question-target";
import {
  buildFormCronJob,
  scheduleToolSchema,
  SCHEDULE_TOOL_NAME,
  validateScheduledForm,
} from "./question-schedule-contract";
import { formatScheduledFormResult } from "./question-schedule-result";
import {
  cronScheduleSchema,
  QuestionScheduleStore,
  type ScheduledForm,
  type ScheduledFormOrigin,
} from "./question-schedule-store";

const PROCESS_ID = randomUUID();
const jobIdSchema = z.string().uuid();
const argsValidator = z.fromJSONSchema(JSON.parse(JSON.stringify(scheduleToolSchema)));
function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
function ownerMatches(template: ScheduledForm, context: DingTalkQuestionContext): boolean {
  return (
    template.origin.accountId === context.accountId &&
    template.origin.agentId === context.resolvedRoute?.agentId &&
    template.origin.senderId === (context.data.senderStaffId || context.data.senderId) &&
    template.origin.conversationId === context.data.conversationId &&
    template.origin.conversationType === context.data.conversationType
  );
}
function captureOrigin(context: DingTalkQuestionContext): ScheduledFormOrigin {
  const senderId = context.data.senderStaffId || context.data.senderId;
  if (
    !senderId ||
    !context.resolvedRoute ||
    !context.questionScopeKey ||
    !context.storePath ||
    !["1", "2"].includes(context.data.conversationType)
  ) {
    throw new Error("Scheduling requires a persistent, trusted DingTalk sender and conversation");
  }
  return {
    accountId: context.accountId,
    agentId: context.resolvedRoute.agentId,
    clientId: context.dingtalkConfig.clientId,
    senderId,
    senderNick: context.data.senderNick,
    conversationId: context.data.conversationId,
    conversationType: context.data.conversationType as "1" | "2",
    conversationTitle: context.data.conversationTitle,
    questionScopeKey: context.questionScopeKey,
    route: { ...context.resolvedRoute },
  };
}
function prepareTemplate(
  api: OpenClawPluginApi,
  tool: OpenClawPluginToolContext,
  context: DingTalkQuestionContext,
  args: Record<string, unknown>,
  store: QuestionScheduleStore,
) {
  const name = z.string().trim().min(1).max(120).parse(args.name);
  const form = validateScheduledForm(args.form);
  const schedule = cronScheduleSchema.parse(args.schedule);
  if (schedule.kind === "at" && Date.parse(schedule.at) <= Date.now()) {
    throw new Error("Scheduled time must be in the future");
  }
  if (schedule.kind === "cron") {
    new Intl.DateTimeFormat("en", { timeZone: schedule.tz }).format();
  }
  const names = z
    .record(z.string(), z.string().trim().min(1).max(120))
    .parse(args.respondentNames ?? {});
  const target = parseQuestionTarget(form.target)!;
  if (Object.keys(names).some((id) => !target.respondentUserIds.includes(id))) {
    throw new Error("Display names must belong to the confirmed respondent list");
  }
  const origin = captureOrigin(context);
  const id =
    "fs_" +
    createHash("sha256")
      .update(
        JSON.stringify({ origin, messageId: context.data.msgId, name, form, schedule, names }),
      )
      .digest("hex")
      .slice(0, 32);
  const proposed: ScheduledForm = {
    id,
    name,
    form,
    schedule,
    respondentNames: names,
    origin,
    createdAt: Date.now(),
    enabled: false,
  };
  // Fail at setup as well as execution, before the host creates an unusable cron job.
  resolveRunConfig(api, tool, proposed);
  const template = store.update(id, (existing) => existing ?? proposed);
  if (template.jobId) {
    return result({
      status: "bound",
      scheduleId: id,
      jobId: template.jobId,
      enabled: template.enabled,
    });
  }
  return result({
    status: "prepared",
    scheduleId: id,
    cronJob: buildFormCronJob(template),
    message:
      "No job enabled and no card sent. Create this disabled job with the native cron tool, bind its returned id here, then enable it with cron. Do not claim scheduling succeeded before all steps succeed.",
  });
}

function resolveRunConfig(
  api: OpenClawPluginApi,
  tool: OpenClawPluginToolContext,
  template: ScheduledForm,
) {
  const cfg = tool.getRuntimeConfig?.() ?? tool.runtimeConfig ?? api.config;
  const config = getConfig(cfg, template.origin.accountId);
  const channel = cfg.channels?.dingtalk as
    | { enabled?: boolean; accounts?: Record<string, unknown> }
    | undefined;
  if (
    !channel ||
    (template.origin.accountId !== "default" && !channel.accounts?.[template.origin.accountId]) ||
    channel.enabled === false ||
    config.enabled === false ||
    config.clientId !== template.origin.clientId ||
    !config.clientSecret
  ) {
    throw new Error(
      "The original DingTalk bot is unavailable or changed; reconfigure this scheduled collection",
    );
  }
  const origin = template.origin;
  const pairedOwners =
    origin.conversationType === "1" && config.dmPolicy === "pairing"
      ? readChannelAllowFromStoreSync("dingtalk", undefined, origin.accountId)
      : [];
  if (
    origin.conversationType === "1" &&
    (config.dmPolicy === "allowlist" || config.dmPolicy === "pairing") &&
    !isSenderAllowed({
      allow: normalizeAllowFrom([...(config.allowFrom ?? []), ...pairedOwners]),
      senderId: origin.senderId,
    })
  ) {
    throw new Error("The schedule owner is no longer authorized by the bot's DM policy");
  }
  const target = parseQuestionTarget(template.form.target)!;
  const groups = new Set<string>();
  if (origin.conversationType === "2") {
    groups.add(origin.conversationId);
  }
  if (target.type === "group") {
    groups.add(target.id);
  }
  for (const groupId of groups) {
    if (
      !resolveGroupAccess({
        groupId,
        senderId: origin.senderId,
        groupPolicy: config.groupPolicy || "open",
        groups: config.groups,
        groupAllowFrom: config.groupAllowFrom,
        allowFrom: config.allowFrom,
      }).allowed
    ) {
      throw new Error("The scheduled group or owner is no longer allowed by bot policy");
    }
  }
  return { cfg, config };
}

async function runTemplate(
  api: OpenClawPluginApi,
  tool: OpenClawPluginToolContext,
  args: Record<string, unknown>,
  store: QuestionScheduleStore,
  inbound?: DingTalkQuestionContext,
) {
  const id = z.string().parse(args.scheduleId);
  const sequence = z.number().int().positive().safe().parse(args.sequence);
  let template = store.get(id);
  if (!template || !template.enabled || !template.jobId) {
    throw new Error("Scheduled template is disabled, missing or unbound");
  }
  const origin = template.origin;
  // This exact session is constructed by OpenClaw's isolated headless cron runtime.
  // Never derive the agent, job or owner from model-provided arguments.
  const expectedSession = `agent:${origin.agentId}:cron:${template.jobId}:trigger`;
  if (
    inbound ||
    tool.agentId !== origin.agentId ||
    tool.sessionKey !== expectedSession ||
    tool.requesterSenderId
  ) {
    throw new Error("Scheduled form execution requires its bound isolated cron task and agent");
  }
  const { cfg, config } = resolveRunConfig(api, tool, template);
  validateScheduledForm(template.form);
  const previous = template.lastRun;
  if (sequence === template.lastSequence) {
    if (["sending", "uncertain"].includes(template.lastOutcome?.status ?? "")) {
      throw new Error(
        "Previous delivery is still running or uncertain; inspect before replacing the task. The form will not be resent.",
      );
    }
    return result({
      status: "duplicate",
      questionId: template.lastOutcome?.questionId,
      outcome: template.lastOutcome?.status,
    });
  }
  if (sequence !== (template.lastSequence ?? 0) + 1) {
    throw new Error("Cron sequence mismatch; do not reset or reuse this task's state");
  }
  if (previous?.state === "uncertain" || previous?.state === "sending") {
    throw new Error("Previous card delivery is uncertain; inspect before replacing the task");
  }
  if (
    previous?.state === "pending" &&
    previous.processId === PROCESS_ID &&
    hasActiveDingTalkCollection(previous.questionId)
  ) {
    // Keep the active run intact while recording the consumed cron occurrence.
    store.update(id, (current) => ({
      ...current!,
      lastSequence: sequence,
      lastOutcome: { status: "skipped", questionId: previous.questionId },
    }));
    return result({
      status: "skipped",
      reason: "Previous collection is still pending",
      questionId: previous.questionId,
    });
  }
  const startedAt = Date.now();
  template = store.update(id, (current) => ({
    ...current!,
    lastSequence: sequence,
    lastOutcome: { status: "sending" },
    lastRun: {
      sequence,
      state: "sending",
      startedAt,
      deadline: startedAt + Number(template!.form.timeoutMinutes) * 60_000,
      processId: PROCESS_ID,
    },
  }));
  const storePath = api.runtime.channel.session.resolveStorePath(cfg.session?.store, {
    // Card callbacks and account startup recovery use the account store, not the routed agent store.
    agentId: origin.accountId,
  });
  const context: DingTalkQuestionContext = {
    cfg,
    accountId: origin.accountId,
    dingtalkConfig: config,
    log: api.logger,
    storePath,
    questionScopeKey: origin.questionScopeKey,
    resolvedRoute: origin.route,
    sessionWebhook: "",
    data: {
      msgId: `${id}:${sequence}`,
      msgtype: "text",
      text: { content: "" },
      createAt: startedAt,
      conversationId: origin.conversationId,
      conversationType: origin.conversationType,
      conversationTitle: origin.conversationTitle,
      senderId: origin.senderId,
      senderStaffId: origin.senderId,
      senderNick: origin.senderNick,
      chatbotUserId: "",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    },
    onCollectionResult: async (collection) => {
      store.update(id, (current) =>
        current?.lastRun?.sequence === sequence
          ? {
              ...current,
              lastRun: {
                ...current.lastRun,
                state: "completed",
                resultStatus: collection.status,
                deliveryError: true,
              },
            }
          : current!,
      );
      const destination =
        origin.conversationType === "1"
          ? `user:${origin.senderId}`
          : `group:${origin.conversationId}`;
      // Authorization or bot credentials may have changed while people were filling in the card.
      const { config: currentConfig } = resolveRunConfig(api, tool, template);
      for (const text of formatScheduledFormResult(collection, template.respondentNames)) {
        const sent = await sendMessage(currentConfig, destination, text, {
          accountId: origin.accountId,
          storePath,
          log: api.logger,
          forceMarkdown: true,
          title: "定时表单收集结果",
        });
        if (!sent.ok) {
          throw new Error(sent.error || "Scheduled result delivery failed");
        }
      }
      store.update(id, (current) =>
        current?.lastRun?.sequence === sequence
          ? { ...current, lastRun: { ...current.lastRun, deliveryError: false } }
          : current!,
      );
    },
  };
  try {
    const sent = await executeDingTalkQuestion(context, template.form);
    const details = sent.details as { status: string; questionId?: string; outTrackId?: string };
    if (details.status !== "pending") {
      throw new Error(
        "Card delivery did not complete. Inspect the task and client before retrying.",
      );
    }
    store.update(id, (current) => ({
      ...current!,
      lastOutcome: { status: "pending", questionId: details.questionId },
      lastRun: {
        ...current!.lastRun!,
        state: current!.lastRun!.state === "completed" ? "completed" : "pending",
        questionId: details.questionId,
        outTrackId: details.outTrackId,
      },
    }));
    return sent;
  } catch (error) {
    store.update(id, (current) => ({
      ...current!,
      lastOutcome: { status: "uncertain" },
      lastRun: { ...current!.lastRun!, state: "uncertain" },
    }));
    throw error;
  }
}

export function registerDingTalkFormScheduleTool(api: OpenClawPluginApi): void {
  if (typeof api.registerTool !== "function") {
    return;
  }
  api.registerTool(
    (tool) => {
      const captured = getDingTalkQuestionToolContext(tool);
      return {
        name: SCHEDULE_TOOL_NAME,
        label: "Schedule DingTalk Form",
        description:
          "Manage confirmed DingTalk form templates for OpenClaw native cron. prepare/bind/list/disable require the owner's current DingTalk conversation. prepare returns a disabled native cron job: create it via cron, bind the real jobId, then enable via cron. No design cards during cron runs. run is exclusively for the generated isolated cron script; never call it from chat. Fixed respondents, 1–1440 minutes, ends when all respond. Template survives restart; active forms do not. Disabling a template stops future sends but does not cancel an already-sent form; use dingtalk_ask_user_question list/cancel for that.",
        parameters: scheduleToolSchema as unknown as AnyAgentTool["parameters"],
        async execute(_callId, input) {
          try {
            const args = argsValidator.parse(input) as Record<string, unknown>;
            const store = new QuestionScheduleStore(api.runtime.state.resolveStateDir());
            const context = resolveDingTalkQuestionToolContext(tool, captured);
            if (args.action === "run") {
              return await runTemplate(api, tool, args, store, context);
            }
            if (!context || context.isCollectionResult) {
              throw new Error(
                "Schedule management requires the owner's active DingTalk conversation",
              );
            }
            if (args.action === "prepare") {
              return prepareTemplate(api, tool, context, args, store);
            }
            if (args.action === "list") {
              return result({
                status: "ok",
                schedules: store
                  .list()
                  .filter((item) => ownerMatches(item, context))
                  .map((item) => ({
                    scheduleId: item.id,
                    name: item.name,
                    jobId: item.jobId,
                    templateEnabled: item.enabled,
                    schedule: item.schedule,
                    lastRun:
                      item.lastRun?.state === "pending" &&
                      (item.lastRun.processId !== PROCESS_ID ||
                        !hasActiveDingTalkCollection(item.lastRun.questionId))
                        ? { ...item.lastRun, state: "restart_terminated" }
                        : item.lastRun,
                  })),
              });
            }
            const id = z.string().parse(args.scheduleId);
            const template = store.get(id);
            if (!template || !ownerMatches(template, context)) {
              throw new Error("No template owned by you in this conversation and agent");
            }
            if (args.action === "bind") {
              const jobId = jobIdSchema.parse(args.jobId);
              if (template.jobId && template.jobId !== jobId) {
                throw new Error("A template cannot be rebound to a different cron job");
              }
              if (store.list().some((item) => item.id !== id && item.jobId === jobId)) {
                throw new Error("Cron job already bound to another template");
              }
              store.update(id, (current) => ({ ...current!, jobId, enabled: true }));
              return result({
                status: "bound",
                scheduleId: id,
                jobId,
                message:
                  "Template bound. Enable the disabled job using native cron to finish scheduling.",
              });
            }
            store.update(id, (current) => ({ ...current!, enabled: false }));
            return result({
              status: "disabled",
              scheduleId: id,
              jobId: template.jobId,
              message:
                "Future form sends disabled. Also disable/remove its native cron job. Already-sent forms remain active.",
            });
          } catch (error) {
            return result({
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };
    },
    { name: SCHEDULE_TOOL_NAME },
  );
}
