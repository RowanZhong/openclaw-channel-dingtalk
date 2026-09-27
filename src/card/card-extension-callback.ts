import type { Logger } from "../platform/types";
import { resolveCardExtensionHandler } from "./card-extension-registry";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function embedded(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return record(value);
}

const CALLBACK_DEDUP_TTL_MS = 5 * 60_000;
const MAX_CALLBACK_RECORDS = 1024;

/** Keep one dispatcher per account lifecycle, including Stream client replacements. */
export function createCardExtensionCallbackDispatcher() {
  // Infinity denotes in-flight: never expire/evict an operation still executing.
  // Store only IDs, not forms or business data. No timer or persistent queue.
  const deliveries = new Map<string | symbol, number>();

  /** Run before builtin analysis: builtin-looking actions belong only to this card's owner. */
  return async function dispatchCardExtensionCallback(params: {
    accountId: string;
    payload: unknown;
    callbackId?: string;
    acknowledge?: () => void;
    log?: Logger;
  }): Promise<boolean> {
    const root = record(params.payload);
    const outTrackId = root?.outTrackId;
    if (typeof outTrackId !== "string" || !outTrackId.startsWith("ocx1.")) {
      return false;
    }
    // ACK reception before invoking any consumer code, even its synchronous part.
    // A business result is reported by the consumer, not by the Stream ACK.
    params.acknowledge?.();
    // This reserved prefix is consumed even after a consumer is uninstalled.
    // Inner/form fields must never supply identity, account or routing identifiers.
    const match =
      /^ocx1\.([a-zA-Z0-9_-]{1,64})\.([a-z][a-z0-9-]{0,31})\.([a-zA-Z0-9_-]{1,64})$/.exec(
        outTrackId,
      );
    const userId = root?.userId;
    if (
      !match ||
      outTrackId.length > 128 ||
      match[1] !== params.accountId ||
      typeof userId !== "string" ||
      !/^[a-zA-Z0-9._@-]{1,128}$/.test(userId)
    ) {
      params.log?.warn?.(
        "[DingTalk][CardExtension] Ignored callback with invalid outer identity or route",
      );
      return true;
    }
    const [, accountId, namespace, cardId] = match;
    let deliveryKey: string | symbol | undefined;
    try {
      const handler = resolveCardExtensionHandler(accountId, namespace);
      if (!handler) {
        params.log?.debug?.(
          `[DingTalk][CardExtension] No handler account=${accountId} namespace=${namespace}`,
        );
        return true;
      }
      const content = embedded(root?.content) ?? embedded(root?.value) ?? root;
      const privateData = embedded(content?.cardPrivateData);
      const actionIds = privateData?.actionIds;
      if (
        !Array.isArray(actionIds) ||
        actionIds.length === 0 ||
        actionIds.length > 32 ||
        actionIds.some((id) => typeof id !== "string" || !id || id.length > 128)
      ) {
        params.log?.warn?.("[DingTalk][CardExtension] Ignored callback with invalid action IDs");
        return true;
      }
      const formInput = record(record(privateData?.params)?.form) ?? {};
      const form = Object.fromEntries(
        Object.entries(formInput).map(([key, value]) => {
          const wrapper = record(value);
          return [key, wrapper && Object.hasOwn(wrapper, "value") ? wrapper.value : value];
        }),
      );
      const key =
        typeof params.callbackId === "string" && params.callbackId.length > 0
          ? JSON.stringify([accountId, params.callbackId])
          : Symbol(); // Missing IDs cannot deduplicate distinct clicks.
      const now = Date.now();
      const seen = deliveries.get(key);
      if (seen !== undefined && seen > now) {
        return true;
      }
      deliveries.delete(key);
      if (deliveries.size >= MAX_CALLBACK_RECORDS) {
        for (const [id, expiresAt] of deliveries) {
          if (expiresAt <= now) {
            deliveries.delete(id);
          }
        }
        if (deliveries.size >= MAX_CALLBACK_RECORDS) {
          const completed = [...deliveries].find(([, expiry]) => expiry !== Infinity);
          if (completed) {
            deliveries.delete(completed[0]);
          }
        }
        if (deliveries.size >= MAX_CALLBACK_RECORDS) {
          params.log?.warn?.(
            "[DingTalk][CardExtension] Callback capacity reached; ignored new action",
          );
          return true;
        }
      }
      deliveryKey = key;
      deliveries.set(key, Infinity);
      await handler({
        accountId,
        namespace,
        cardId,
        outTrackId,
        userId,
        callbackId: params.callbackId,
        actionIds: [...actionIds],
        form,
      });
      params.log?.debug?.(
        `[DingTalk][CardExtension] Handled callback account=${accountId} namespace=${namespace} card=${cardId}`,
      );
    } catch {
      // An extension can throw submitted text or credentials. Keep errors metadata-only,
      // and never fall through to another handler. Gateway owns the Stream ACK.
      params.log?.error?.(
        `[DingTalk][CardExtension] Callback failed account=${accountId} namespace=${namespace} card=${cardId}`,
      );
    } finally {
      if (deliveryKey !== undefined) {
        // Also retain failed deliveries: a throw can follow an external side effect.
        deliveries.delete(deliveryKey);
        if (typeof deliveryKey === "string") {
          deliveries.set(deliveryKey, Date.now() + CALLBACK_DEDUP_TTL_MS);
        }
      }
    }
    return true;
  };
}
