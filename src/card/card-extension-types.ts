/** Variables must already be encoded as DingTalk cardParamMap strings. */
export type DingTalkCardVariables = Readonly<Record<string, string>>;

export type DingTalkCardExtensionStatus =
  | "ready"
  | "unavailable"
  | "account-unconfigured"
  | "account-disabled"
  | "not-connected"
  | "disposed";

export type DingTalkCardExtensionErrorCode =
  | Exclude<DingTalkCardExtensionStatus, "ready">
  | "version-mismatch"
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
  /** Supplied by the receiving Channel connection, never by form input. */
  accountId: string;
  namespace: string;
  cardId: string;
  outTrackId: string;
  /** DingTalk Stream's outer userId (enterprise staffId). Authorization remains the consumer's job. */
  userId: string;
  /** Stream envelope ID, when available; not an exactly-once guarantee. */
  callbackId?: string;
  /** Untrusted template/form data. */
  actionIds: readonly string[];
  form: Readonly<Record<string, unknown>>;
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
  getStatus(): DingTalkCardExtensionStatus;
  sendCard(options: DingTalkCardSendOptions): Promise<{ outTrackId: string }>;
  updateCard(options: DingTalkCardUpdateOptions): Promise<{ outTrackId: string }>;
  /** Stops future dispatch. Does not cancel an already executing callback or HTTP request. */
  dispose(): void;
}
