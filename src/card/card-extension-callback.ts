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

/** Run before builtin analysis: even builtin-looking action IDs belong only to this card's owner. */
export async function dispatchCardExtensionCallback(params: {
  accountId: string;
  payload: unknown;
  callbackId?: string;
  log?: Logger;
}): Promise<boolean> {
  const root = record(params.payload);
  const outTrackId = root?.outTrackId;
  if (typeof outTrackId !== "string" || !outTrackId.startsWith("ocx1.")) {
    return false;
  }
  // This reserved prefix is consumed even after a consumer is uninstalled.
  // Inner/form fields must never supply identity, account or routing identifiers.
  const match = /^ocx1\.([a-zA-Z0-9_-]{1,64})\.([a-z][a-z0-9-]{0,31})\.([a-zA-Z0-9_-]{1,64})$/.exec(
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
  }
  return true;
}
