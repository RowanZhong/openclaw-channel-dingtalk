import { DingTalkCardExtensionError } from "./card-extension-types.js";
import type {
  DingTalkCardAction,
  DingTalkCardExtensionOptions,
  DingTalkCardExtensionStatus,
  DingTalkCardSendOptions,
  DingTalkCardUpdateOptions,
} from "./card-extension-types.js";

export interface CardExtensionTransport {
  isConnected(): boolean;
  send(options: DingTalkCardSendOptions & { outTrackId: string }): Promise<void>;
  update(options: DingTalkCardUpdateOptions & { outTrackId: string }): Promise<void>;
}

interface CardExtensionRegistry {
  version: 1;
  registrations: Map<string, DingTalkCardExtensionOptions>;
  transports: Map<string, CardExtensionTransport>;
  accountStatus?: (accountId: string) => "configured" | "account-unconfigured" | "account-disabled";
}

// Both the Channel bundle and independently bundled consumers must use the same
// registry. Keep this protocol versioned; never silently share incompatible state.
const REGISTRY_KEY = Symbol.for("openclaw.dingtalk.card-extensions");

export function getCardExtensionRegistry(): CardExtensionRegistry {
  const globals = globalThis as typeof globalThis & { [REGISTRY_KEY]?: CardExtensionRegistry };
  const existing = globals[REGISTRY_KEY];
  if (existing && existing.version !== 1) {
    throw new DingTalkCardExtensionError(
      "version-mismatch",
      "Incompatible DingTalk card extension API",
    );
  }
  return (globals[REGISTRY_KEY] ??= {
    version: 1,
    registrations: new Map(),
    transports: new Map(),
  });
}

export function cardExtensionKey(accountId: string, namespace: string): string {
  return `${accountId}.${namespace}`;
}

export function getCardExtensionStatus(accountId: string): DingTalkCardExtensionStatus {
  const registry = getCardExtensionRegistry();
  if (!registry.accountStatus) {
    return "unavailable";
  }
  const status = registry.accountStatus(accountId);
  if (status !== "configured") {
    return status;
  }
  return registry.transports.get(accountId)?.isConnected() ? "ready" : "not-connected";
}

export function bindCardExtensionTransport(
  accountId: string,
  transport: CardExtensionTransport,
): () => void {
  const registry = getCardExtensionRegistry();
  registry.transports.set(accountId, transport);
  return () => {
    if (registry.transports.get(accountId) === transport) {
      registry.transports.delete(accountId);
    }
  };
}

export function resolveCardExtensionHandler(
  accountId: string,
  namespace: string,
): ((action: DingTalkCardAction) => void | Promise<void>) | undefined {
  return getCardExtensionRegistry().registrations.get(cardExtensionKey(accountId, namespace))
    ?.onAction;
}
