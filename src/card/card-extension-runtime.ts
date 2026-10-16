import { getChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { DingTalkCardSendOptions, DingTalkCardUpdateOptions } from "./card-extension-types.js";

// Version the narrow transport contract, not the host's registry implementation.
export const CARD_EXTENSION_CAPABILITY = "dingtalk.card-extensions.transport.v1";
export type CardExtensionChannelRuntime = NonNullable<
  Parameters<typeof getChannelRuntimeContext>[0]["channelRuntime"]
>;

export interface CardExtensionTransport {
  isConnected(): boolean;
  send(options: DingTalkCardSendOptions & { outTrackId: string }): Promise<void>;
  update(options: DingTalkCardUpdateOptions & { outTrackId: string }): Promise<void>;
}

/** Resolve at call time so account restarts never leave consumers holding old transports. */
export function getCardExtensionTransport(
  channelRuntime: CardExtensionChannelRuntime,
  accountId: string,
): CardExtensionTransport | undefined {
  const context = getChannelRuntimeContext({
    channelRuntime,
    channelId: "dingtalk",
    accountId,
    capability: CARD_EXTENSION_CAPABILITY,
  });
  if (!context || typeof context !== "object") {
    return undefined;
  }
  const candidate = context as Partial<CardExtensionTransport>;
  return typeof candidate.isConnected === "function" &&
    typeof candidate.send === "function" &&
    typeof candidate.update === "function"
    ? (candidate as CardExtensionTransport)
    : undefined;
}

/** Host interactive namespaces are channel-scoped; add the account explicitly. */
export function cardExtensionNamespace(accountId: string, namespace: string): string {
  return `ocx1.${accountId}.${namespace}`;
}
