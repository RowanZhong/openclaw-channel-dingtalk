import {
  cardExtensionKey,
  getCardExtensionRegistry,
  getCardExtensionStatus,
} from "./card-extension-registry.js";
import { DingTalkCardExtensionError } from "./card-extension-types.js";
import type {
  DingTalkCardExtension,
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

/** No network, Channel import, timers or service startup occurs during registration. */
export function registerDingTalkCardExtension(
  options: DingTalkCardExtensionOptions,
): DingTalkCardExtension {
  validateString(options?.accountId, /^[a-zA-Z0-9_-]{1,64}$/, "accountId");
  validateString(options?.namespace, /^[a-z][a-z0-9-]{0,31}$/, "namespace");
  if (typeof options.onAction !== "function") {
    throw new DingTalkCardExtensionError("invalid-argument", "onAction must be a function");
  }
  const registration = { ...options };
  const { accountId, namespace } = registration;
  const registry = getCardExtensionRegistry();
  const key = cardExtensionKey(accountId, namespace);
  if (registry.registrations.has(key)) {
    throw new DingTalkCardExtensionError(
      "namespace-conflict",
      "Card extension namespace already registered for this account",
    );
  }
  registry.registrations.set(key, registration);
  let disposed = false;
  const getStatus = () => (disposed ? ("disposed" as const) : getCardExtensionStatus(accountId));
  const getTransport = () => {
    const status = getStatus();
    if (status !== "ready") {
      throw new DingTalkCardExtensionError(status, `DingTalk card extension is ${status}`);
    }
    return registry.transports.get(accountId)!;
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
    getStatus,
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
      return { outTrackId };
    },
    async updateCard(input) {
      const outTrackId = trackId(input?.cardId);
      const variables = copyVariables(input.variables);
      await getTransport().update({ cardId: input.cardId, variables, outTrackId });
      return { outTrackId };
    },
    dispose() {
      disposed = true;
      if (registry.registrations.get(key) === registration) {
        registry.registrations.delete(key);
      }
    },
  };
}
