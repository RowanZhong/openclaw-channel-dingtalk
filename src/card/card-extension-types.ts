import type { CardExtensionChannelRuntime } from "./card-extension-runtime.js";

/** Variables must already be encoded as DingTalk cardParamMap strings. */
export type DingTalkCardVariables = Readonly<Record<string, string>>;

export type DingTalkCardExtensionErrorCode =
  | "unavailable"
  | "not-connected"
  | "invalid-argument"
  | "namespace-conflict"
  | "request-failed";

/** Inspect code, not instanceof: consumers may bundle a separate copy of this entry. */
export class DingTalkCardExtensionError extends Error {
  constructor(
    public readonly code: DingTalkCardExtensionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DingTalkCardExtensionError";
  }
}

export interface DingTalkCardAction {
  cardId: string;
  /** DingTalk Stream's outer userId (enterprise staffId). Authorization remains the consumer's job. */
  userId: string;
  /** Stream envelope ID, when available; not an exactly-once guarantee. */
  callbackId?: string;
  /** Untrusted template/form data. */
  actionIds: readonly string[];
  form: Readonly<Record<string, unknown>>;
}

/** Pass the real API from synchronous plugin register(), never construct a second runtime. */
export interface DingTalkCardExtensionApi {
  id: string;
  name?: string;
  rootDir?: string;
  runtime: { channel: CardExtensionChannelRuntime };
}

export interface DingTalkCardExtensionOptions {
  accountId: string;
  namespace: string;
  onAction: (action: DingTalkCardAction) => void | Promise<void>;
}

export interface DingTalkCardSendOptions {
  /** Stable business ID; reuse this ID when reconciling an uncertain create result. */
  cardId: string;
  templateId: string;
  userId: string;
  variables: DingTalkCardVariables;
}

export interface DingTalkCardUpdateOptions {
  cardId: string;
  variables: DingTalkCardVariables;
}

export interface DingTalkCardExtension {
  /** Advisory only: every send/update rechecks the current transport. */
  isReady(): boolean;
  sendCard(options: DingTalkCardSendOptions): Promise<void>;
  updateCard(options: DingTalkCardUpdateOptions): Promise<void>;
}
