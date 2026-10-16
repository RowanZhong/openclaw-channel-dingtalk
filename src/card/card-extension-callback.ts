import { dispatchPluginInteractiveHandler } from "openclaw/plugin-sdk/plugin-runtime";
import type { Logger } from "../platform/types";
import { cardExtensionNamespace } from "./card-extension-runtime";

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

/** Consume reserved cards even when no handler exists; never fall through to builtin actions. */
export async function dispatchCardExtensionCallback(params: {
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
  // Receipt ACK must precede consumer execution, including duplicates/unmatched routes.
  // The host's onMatched hook does not run for those cases.
  params.acknowledge?.();
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
  const callbackId =
    typeof params.callbackId === "string" && params.callbackId.trim()
      ? params.callbackId
      : undefined;
  try {
    const result = await dispatchPluginInteractiveHandler({
      channel: "dingtalk",
      data: `${cardExtensionNamespace(accountId, namespace)}:${cardId}`,
      // Host dedupe keys are global: distinguish transport, account and event.
      dedupeId: callbackId
        ? JSON.stringify(["dingtalk", "card-extension", accountId, callbackId])
        : undefined,
      invoke: ({ registration }) =>
        registration.handler({
          accountId,
          namespace,
          cardId,
          userId,
          actionIds: [...actionIds],
          form,
          callbackId,
        }),
    });
    params.log?.debug?.(
      `[DingTalk][CardExtension] Callback account=${accountId} namespace=${namespace} card=${cardId} matched=${result.matched} duplicate=${result.duplicate}`,
    );
  } catch {
    // The host releases failed claims before this catch. Business idempotency and
    // recovery belong to the consumer; neither auto-retry nor Agent fallback occurs here.
    // Never log errors which may contain submitted text or credentials.
    params.log?.error?.(
      `[DingTalk][CardExtension] Callback failed account=${accountId} namespace=${namespace} card=${cardId}`,
    );
  }
  return true;
}
