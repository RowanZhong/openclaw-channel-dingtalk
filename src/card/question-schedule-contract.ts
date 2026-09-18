import { z } from "zod";
import { AskUserQuestionSchema } from "./ask-user-question-schema";
import { parseQuestionTarget } from "./ask-user-question-target";
import { cronScheduleSchema, type ScheduledForm } from "./question-schedule-store";

export const SCHEDULE_TOOL_NAME = "dingtalk_form_schedule";
const formProperties = AskUserQuestionSchema.properties;
export const scheduledFormSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "target", "timeoutMinutes"],
  properties: {
    title: formProperties.title,
    description: formProperties.description,
    fields: formProperties.fields,
    target: formProperties.target,
    timeoutMinutes: formProperties.timeoutMinutes,
  },
} as const;
const formValidator = z.fromJSONSchema(JSON.parse(JSON.stringify(scheduledFormSchema)));
export function validateScheduledForm(value: unknown): Record<string, unknown> {
  if ((JSON.stringify(value)?.length ?? 0) > 64_000) {
    throw new Error("Form template is too large");
  }
  const form = formValidator.parse(value) as Record<string, unknown>;
  parseQuestionTarget(form.target);
  if (
    (typeof form.title === "string" && form.title.length > 200) ||
    (typeof form.description === "string" && form.description.length > 2000)
  ) {
    throw new Error("Scheduled title/description exceeds 200/2000 characters");
  }
  const fields = form.fields as Array<Record<string, unknown>>;
  if (
    fields.some((field) => typeof field.name !== "string" || !field.name.trim()) ||
    new Set(fields.map((field) => field.name)).size !== fields.length
  ) {
    throw new Error("Form field names must be non-empty and unique");
  }
  for (const field of fields) {
    if (String(field.label).length > 200 || String(field.name).length > 128) {
      throw new Error("Scheduled field labels/keys are too long");
    }
    if (
      ["SELECT", "MULTI_SELECT", "CHECKBOX_GROUP", "MULTI_CHECKBOX_GROUP"].includes(
        String(field.type),
      ) &&
      (!Array.isArray(field.options) || !field.options.length)
    ) {
      throw new Error("Choice fields require options");
    }
  }
  return form;
}

export const scheduleToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["prepare", "bind", "list", "disable", "run"] },
    scheduleId: { type: "string" },
    jobId: {
      type: "string",
      description: "Real id returned by the native cron tool; never invent.",
    },
    name: { type: "string", description: "Human-readable collection task name." },
    form: scheduledFormSchema,
    schedule: z.toJSONSchema(cronScheduleSchema),
    respondentNames: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "Verified staffId to display name map; display only, never used for authorization.",
    },
    sequence: {
      type: "integer",
      minimum: 1,
      description: "Cron script only: durable trigger.state.sequence + 1.",
    },
  },
} as const;

export function buildFormCronJob(template: ScheduledForm) {
  const script = [
    "const sequence = (trigger.state?.sequence ?? 0) + 1;",
    `const [runForm] = await catalog.search(${JSON.stringify(SCHEDULE_TOOL_NAME)}, { limit: 1 });`,
    'if (!runForm) throw new Error("Scheduled form tool unavailable");',
    `const result = await runForm({ action: "run", scheduleId: ${JSON.stringify(template.id)}, sequence });`,
    'if (result.status === "failed") throw new Error(result.error || "Scheduled form failed");',
    "json({ state: { sequence } });",
  ].join("\n");
  return {
    name: template.name,
    agentId: template.origin.agentId,
    enabled: false,
    schedule: template.schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "script",
      script,
      toolsAllow: [SCHEDULE_TOOL_NAME],
      timeoutSeconds: 60,
      toolBudget: 1,
    },
    delivery: { mode: "none" },
    failureAlert: {
      after: 1,
      cooldownMs: 1_800_000,
      channel: "dingtalk",
      accountId: template.origin.accountId,
      to:
        template.origin.conversationType === "1"
          ? "user:" + template.origin.senderId
          : "group:" + template.origin.conversationId,
    },
    ...(template.schedule.kind === "at" ? { deleteAfterRun: true } : {}),
  };
}
