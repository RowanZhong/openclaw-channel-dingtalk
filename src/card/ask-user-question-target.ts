import {
  MAX_QUESTION_RESPONDENTS,
  MAX_QUESTION_TIMEOUT_MINUTES,
} from "./question-collection-limits";

/** Explicit audiences keep the existing current-user question path unchanged. */
export interface QuestionTarget {
  type: "user" | "group";
  id: string;
  respondentUserIds: string[];
}

export interface QuestionResponse {
  status: "submitted" | "cancelled" | "empty";
  answers: Array<{ question: string; answer: string }>;
}

export interface QuestionCollection {
  target: QuestionTarget;
  responses: Map<string, QuestionResponse>;
  // Serialize shared-card progress and terminal updates, including timeout/invalidation.
  cardUpdate?: Promise<void>;
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 256 ||
    /[\s:]/.test(value.trim()) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error(
      "target IDs must be raw non-empty DingTalk IDs without prefixes or whitespace (max 256 characters)",
    );
  }
  return value.trim();
}

export function parseQuestionTarget(value: unknown): QuestionTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("target must specify type and id");
  }
  const target = value as Record<string, unknown>;
  if (Object.keys(target).some((key) => !["type", "id", "respondentUserIds"].includes(key))) {
    throw new Error("Unknown target property");
  }
  const id = identifier(target.id);
  if (target.type === "user") {
    if (target.respondentUserIds !== undefined) {
      throw new Error("A user target can only be answered by that user; omit respondentUserIds");
    }
    return { type: "user", id, respondentUserIds: [id] };
  }
  if (target.type !== "group") {
    throw new Error("target.type must be user or group");
  }
  if (
    !Array.isArray(target.respondentUserIds) ||
    target.respondentUserIds.length < 1 ||
    target.respondentUserIds.length > MAX_QUESTION_RESPONDENTS
  ) {
    throw new Error(
      `A group target requires 1–${MAX_QUESTION_RESPONDENTS} explicit respondentUserIds`,
    );
  }
  const respondentUserIds = target.respondentUserIds.map(identifier);
  if (
    new Set(respondentUserIds.map((userId) => userId.toLowerCase())).size !==
    respondentUserIds.length
  ) {
    throw new Error("respondentUserIds must be unique");
  }
  return { type: "group", id, respondentUserIds };
}

export function resolveQuestionRespondent(
  collection: QuestionCollection,
  clickerUserId?: string,
): string | undefined {
  const clicker = clickerUserId?.trim().toLowerCase();
  return clicker
    ? collection.target.respondentUserIds.find((id) => id.toLowerCase() === clicker)
    : undefined;
}

export const questionTargetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "id"],
  description:
    "Optional explicit delivery target. Omit to ask only the current user in the current conversation. " +
    "Use only verified DingTalk IDs, never guess IDs from names. Answers return to the initiating conversation. " +
    `Group targets require an explicit respondentUserIds list of staffIds. Collect the first response per person and resume once all respond or timeoutMinutes elapses (1–${MAX_QUESTION_TIMEOUT_MINUTES} minutes, default 5). ` +
    "Targeted collections are independent: ordinary messages and new forms do not invalidate them. The initiator can list or cancel them; gateway restart terminates pending forms.",
  properties: {
    type: { type: "string", enum: ["user", "group"] },
    id: {
      type: "string",
      minLength: 1,
      description: "Raw staffId for user, raw conversationId for group (no prefixes).",
    },
    respondentUserIds: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTION_RESPONDENTS,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
      description:
        "Required for group: staffIds allowed to submit. Omit for user. No wildcard/public forms.",
    },
  },
};
