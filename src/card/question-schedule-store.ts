import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { resolveNamespacePath, writeNamespaceJsonAtomic } from "../shared/persistence-store";
import type { DingTalkQuestionContext } from "./ask-user-question-context";

export const cronScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: z.string().datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("every"), everyMs: z.number().int().min(60_000) }).strict(),
  z
    .object({
      kind: z.literal("cron"),
      expr: z.string().trim().min(1).max(200),
      tz: z.string().min(1),
    })
    .strict(),
]);
export type FormCronSchedule = z.infer<typeof cronScheduleSchema>;
export type ScheduledFormOrigin = {
  accountId: string;
  agentId: string;
  clientId: string;
  senderId: string;
  senderNick?: string;
  conversationId: string;
  conversationType: "1" | "2";
  conversationTitle?: string;
  questionScopeKey: string;
  route: NonNullable<DingTalkQuestionContext["resolvedRoute"]>;
};
export type ScheduledFormRun = {
  sequence: number;
  state: "sending" | "pending" | "completed" | "skipped" | "uncertain" | "restart_terminated";
  startedAt: number;
  deadline: number;
  questionId?: string;
  outTrackId?: string;
  resultStatus?: string;
  deliveryError?: boolean;
  processId: string;
};
export type ScheduledForm = {
  id: string;
  createdAt: number;
  origin: ScheduledFormOrigin;
  name: string;
  form: Record<string, unknown>;
  respondentNames: Record<string, string>;
  schedule: FormCronSchedule;
  jobId?: string;
  enabled: boolean;
  lastSequence?: number;
  lastOutcome?: { status: "sending" | "pending" | "skipped" | "uncertain"; questionId?: string };
  lastRun?: ScheduledFormRun;
};
type ScheduleState = { version: 1; revision: string; templates: ScheduledForm[] };

/** One Gateway writer; updates are synchronous and fail closed on storage errors. */
export class QuestionScheduleStore {
  private readonly storePath: string;
  constructor(stateDir: string) {
    this.storePath = path.join(stateDir, "dingtalk-schedules.json");
  }
  private read(): ScheduleState {
    const file = resolveNamespacePath("forms.schedules", { storePath: this.storePath });
    if (!fs.existsSync(file)) {
      return { version: 1, revision: "", templates: [] };
    }
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as ScheduleState;
    if (data.version !== 1 || !Array.isArray(data.templates)) {
      throw new Error("Invalid scheduled form store");
    }
    return data;
  }
  list(): ScheduledForm[] {
    return this.read().templates;
  }
  get(id: string): ScheduledForm | undefined {
    return this.list().find((item) => item.id === id);
  }
  update(id: string, mutate: (current: ScheduledForm | undefined) => ScheduledForm): ScheduledForm {
    const state = this.read();
    const index = state.templates.findIndex((item) => item.id === id);
    const updated = mutate(index < 0 ? undefined : state.templates[index]);
    if (index < 0) {
      state.templates.push(updated);
    } else {
      state.templates[index] = updated;
    }
    state.revision = randomUUID();
    writeNamespaceJsonAtomic("forms.schedules", { storePath: this.storePath, data: state });
    // The shared primitive logs failures instead of throwing; never send if the reservation was lost.
    if (this.read().revision !== state.revision) {
      throw new Error("Cannot persist scheduled form state");
    }
    return updated;
  }
}
