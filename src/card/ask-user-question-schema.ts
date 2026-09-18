import { questionTargetSchema } from "./ask-user-question-target";
import { MAX_QUESTION_TIMEOUT_MINUTES } from "./question-collection-limits";

export const AskUserQuestionSchema = {
  type: "object",
  additionalProperties: false,
  anyOf: [
    {
      properties: { action: { enum: ["create"] } },
      oneOf: [{ required: ["questions"] }, { required: ["fields"] }],
    },
    { properties: { action: { const: "list" } }, required: ["action"] },
    { properties: { action: { const: "cancel" } }, required: ["action", "questionId"] },
  ],

  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "cancel"],
      description:
        "Default create. List your pending targeted collections or cancel one by questionId from its initiating conversation.",
    },
    questionId: {
      type: "string",
      minLength: 1,
      description: "Required for cancel. Use an ID returned by create or list; never guess.",
    },
    timeoutMinutes: {
      type: "integer",
      minimum: 1,
      maximum: MAX_QUESTION_TIMEOUT_MINUTES,
      description: `Targeted collections only: 1–${MAX_QUESTION_TIMEOUT_MINUTES} minutes, default 5. Ends early when all respondents reply. Restart terminates pending forms.`,
    },
    target: questionTargetSchema,
    title: {
      type: "string",
      description: "Card title. Used with fields; omit to use the first field label.",
    },
    description: {
      type: "string",
      description: "Short description shown above the form. Used with fields.",
    },
    questions: {
      type: "array",
      description:
        "Lightweight blocking question DSL for simple confirmation, single-select, multi-select, or simple free-text prompts. Prefer exactly one question per card. " +
        "Do not use questions for complex forms, multiple structured fields, date/time inputs, numeric inputs, boolean switches, or mixed input collection; use top-level fields for those cases. " +
        "Do not use for explanations, status updates, capability introductions, or retrospective questions.",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "header", "options"],
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          header: { type: "string", description: "Short label for the question (max 12 chars)" },
          options: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label"],
              properties: {
                label: { type: "string", description: "Display text for this option" },
                value: {
                  type: "string",
                  description:
                    "Machine-readable value returned to the assistant; omit to use label",
                },
                description: {
                  type: "string",
                  description: "Explanation of what this option means",
                },
              },
            },
            description:
              "Available choices. Leave empty ([]) for free-text input — the user will see a text field instead. " +
              "Use two options for confirmation.",
          },
          multiSelect: {
            type: "boolean",
            description: "Whether multiple options can be selected (ignored when options is empty)",
          },
        },
      },
    },
    fields: {
      type: "array",
      description:
        "Advanced DingTalk form fields. Use top-level fields when collecting multiple inputs, " +
        "when the user asks to fill a form, or when you would otherwise list required parameters in markdown. " +
        "Use one fields card to collect all missing inputs for the current turn; do not split related fields into multiple cards. " +
        "Do not answer with a markdown checklist when these fields are needed. The plugin will send " +
        "these fields as the DingTalk card variable form, shaped as { fields }. Do not wrap fields inside form. " +
        "For simple confirmation, single-select, or multi-select questions, prefer questions. Do not mix fields with questions. " +
        "For choice fields (SELECT, MULTI_SELECT, CHECKBOX_GROUP, MULTI_CHECKBOX_GROUP), " +
        "provide options as { value, text }. Use TEXT for single-line text, TEXT_AREA for " +
        "multi-line text, NUMBER for numeric input, DATE/TIME/DATETIME for date or time inputs, " +
        "and CHECKBOX or SWITCH for boolean inputs.",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "label", "type"],
        properties: {
          name: { type: "string", description: "Unique form field key" },
          label: {
            type: "string",
            description:
              "Human-readable field label in the user's language, also used in result summaries. Prefer a meaningful label over an internal field name (for example, 测试代号 instead of code).",
          },
          type: {
            type: "string",
            enum: [
              "TEXT",
              "TEXT_ARRAY",
              "TEXT_AREA",
              "NUMBER",
              "SELECT",
              "MULTI_SELECT",
              "DATE",
              "TIME",
              "DATETIME",
              "CHECKBOX",
              "SWITCH",
              "CHECKBOX_GROUP",
              "MULTI_CHECKBOX_GROUP",
            ],
            description: "DingTalk form field type",
          },
          hidden: { type: "boolean" },
          required: { type: "boolean" },
          requiredMsg: { type: "string" },
          readOnly: { type: "boolean" },
          placeholder: { type: "string" },
          defaultValue: {},
          defautValue: {
            description:
              "Compatibility alias for DingTalk form protocol documentation typo; prefer defaultValue when possible.",
          },
          options: {
            type: "array",
            description:
              "Required for SELECT, MULTI_SELECT, CHECKBOX_GROUP, and MULTI_CHECKBOX_GROUP. Each option must be { value, text }.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["value", "text"],
              properties: {
                value: { type: "string" },
                text: { type: "string" },
              },
            },
          },
          minRows: { type: "number" },
          maxRows: { type: "number" },
          addText: { type: "string" },
        },
      },
    },
  },
} as const;
