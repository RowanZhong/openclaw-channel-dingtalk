import { registerPluginInteractiveHandler } from "openclaw/plugin-sdk/plugin-runtime";
import { cardExtensionNamespace, getCardExtensionTransport } from "./card-extension-runtime.js";
import { DingTalkCardExtensionError } from "./card-extension-types.js";
import type {
  DingTalkCardExtension,
  DingTalkCardExtensionApi,
  DingTalkCardAction,
  DingTalkCardExtensionOptions,
  DingTalkCardVariables,
} from "./card-extension-types.js";

export { DingTalkCardExtensionError } from "./card-extension-types.js";
export type * from "./card-extension-types.js";

/** Validate before crossing the transport boundary, including callers using plain JavaScript. */
function validateString(value: unknown, pattern: RegExp, field: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new DingTalkCardExtensionError("invalid-argument", `Invalid ${field}`);
  }
}

function copyVariables(value: DingTalkCardVariables): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DingTalkCardExtensionError("invalid-argument", "variables must be a string map");
  }
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.length > 256 ||
    entries.some(([key, item]) => !key || key.length > 128 || typeof item !== "string")
  ) {
    throw new DingTalkCardExtensionError("invalid-argument", "Invalid card variables");
  }
  const copy = Object.fromEntries(entries);
  if (JSON.stringify(copy).length > 256 * 1024) {
    throw new DingTalkCardExtensionError(
      "invalid-argument",
      "Card variables exceed 256 KiB character limit",
    );
  }
  return copy;
}

/** Call synchronously from plugin register(): the host owns registration and reload cleanup. */
export function registerDingTalkCardExtension(
  api: DingTalkCardExtensionApi,
  options: DingTalkCardExtensionOptions,
): DingTalkCardExtension {
  validateString(options?.accountId, /^[a-zA-Z0-9_-]{1,64}$/, "accountId");
  validateString(options?.namespace, /^[a-z][a-z0-9-]{0,31}$/, "namespace");
  if (typeof options.onAction !== "function") {
    throw new DingTalkCardExtensionError("invalid-argument", "onAction must be a function");
  }
  if (!api?.id || !api.runtime?.channel?.runtimeContexts) {
    throw new DingTalkCardExtensionError("unavailable", "OpenClaw channel runtime is required");
  }
  const { accountId, namespace, onAction } = options;
  const channelRuntime = api.runtime.channel;
  const registration = registerPluginInteractiveHandler(
    api.id,
    {
      channel: "dingtalk",
      namespace: cardExtensionNamespace(accountId, namespace),
      async handler(value: unknown) {
        if (!value || typeof value !== "object") {
          return;
        }
        const action = value as DingTalkCardAction & { accountId?: string; namespace?: string };
        if (action.accountId !== accountId || action.namespace !== namespace) {
          return;
        }
        // Only the Channel constructs this envelope. Do not expose its routing fields.
        await onAction({
          cardId: action.cardId,
          userId: action.userId,
          actionIds: action.actionIds,
          form: action.form,
          ...(action.callbackId ? { callbackId: action.callbackId } : {}),
        });
      },
    },
    { pluginName: api.name, pluginRoot: api.rootDir },
  );
  if (!registration.ok) {
    throw new DingTalkCardExtensionError(
      "namespace-conflict",
      "Card extension namespace already registered for this account",
    );
  }
  const getTransport = () => {
    const transport = getCardExtensionTransport(channelRuntime, accountId);
    if (!transport) {
      throw new DingTalkCardExtensionError("unavailable", "DingTalk card transport is unavailable");
    }
    if (!transport.isConnected()) {
      throw new DingTalkCardExtensionError("not-connected", "DingTalk account disconnected");
    }
    return transport;
  };
  const trackId = (cardId: string) => {
    validateString(cardId, /^[a-zA-Z0-9_-]{1,64}$/, "cardId");
    const value = `ocx1.${accountId}.${namespace}.${cardId}`;
    if (value.length > 128) {
      throw new DingTalkCardExtensionError(
        "invalid-argument",
        "Composed outTrackId exceeds 128 characters",
      );
    }
    return value;
  };
  return {
    isReady: () => getCardExtensionTransport(channelRuntime, accountId)?.isConnected() === true,
    async sendCard(input) {
      const outTrackId = trackId(input?.cardId);
      validateString(input.templateId, /^[a-zA-Z0-9._-]{1,128}$/, "templateId");
      validateString(input.userId, /^[a-zA-Z0-9._@-]{1,128}$/, "userId");
      const variables = copyVariables(input.variables);
      await getTransport().send({
        cardId: input.cardId,
        templateId: input.templateId,
        userId: input.userId,
        variables,
        outTrackId,
      });
    },
    async updateCard(input) {
      const outTrackId = trackId(input?.cardId);
      const variables = copyVariables(input.variables);
      await getTransport().update({ cardId: input.cardId, variables, outTrackId });
    },
  };
}
