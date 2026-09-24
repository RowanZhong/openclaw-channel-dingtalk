import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAccessToken } from "../auth";
import { getConfig } from "../config";
import axios from "axios";
import { getProxyBypassOption } from "../utils";

const KEY = Symbol.for("openclaw.dingtalk.reply-assistant.v1");
type RecordValue = Record<string, unknown>;
interface CardRequest {
  accountId: string;
  ownerUserId: string;
  templateId: string;
  outTrackId: string;
  data: RecordValue;
}
interface CallbackInput {
  accountId: string;
  userId: string;
  outTrackId: string;
  actionId: string;
  values: RecordValue;
}
interface Bridge {
  version: 1;
  assistants: Map<string, { handle: (input: CallbackInput) => Promise<boolean> }>;
  channel?: {
    sendCard: (request: CardRequest) => Promise<void>;
    updateCard: (request: CardRequest) => Promise<void>;
  };
}
function registry(): Bridge {
  const root = globalThis as unknown as Record<symbol, Bridge>;
  return (root[KEY] ??= { version: 1, assistants: new Map() });
}
function object(value: unknown): RecordValue | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
export function parseAssistantCallback(
  payload: unknown,
  accountId: string,
): CallbackInput | undefined {
  const record = object(payload);
  if (!record) {
    return undefined;
  }
  const nested = object(record.content) ?? object(record.value);
  const privateData = object(nested?.cardPrivateData) ?? object(record.cardPrivateData);
  const actionIds = privateData?.actionIds;
  const actionId = Array.isArray(actionIds) && actionIds.length === 1 ? actionIds[0] : undefined;
  // Identity and card binding must come from the authenticated Stream envelope,
  // never from form values or attacker-editable private params.
  if (
    typeof actionId !== "string" ||
    !/^dws-assistant:[a-f0-9-]{36}:[0-5]$/.test(actionId) ||
    typeof record.userId !== "string" ||
    !record.userId ||
    typeof record.outTrackId !== "string" ||
    !record.outTrackId.startsWith("dws-assistant-")
  ) {
    return undefined;
  }
  const form = object(object(privateData?.params)?.form) ?? {};
  const values: RecordValue = {};
  for (const [key, value] of Object.entries(form)) {
    const wrapped = object(value);
    values[key] = wrapped && Object.hasOwn(wrapped, "value") ? wrapped.value : value;
  }
  return { accountId, userId: record.userId, outTrackId: record.outTrackId, actionId, values };
}
export async function handleReplyAssistantCard(
  payload: unknown,
  accountId: string,
): Promise<boolean> {
  const parsed = parseAssistantCallback(payload, accountId);
  if (!parsed) {
    return false;
  }
  // Consume namespaced callbacks even when the companion plugin is unavailable.
  const handler = registry().assistants.get(accountId);
  if (handler) {
    await handler.handle(parsed);
  }
  return true;
}
export function registerReplyAssistantBridge(api: OpenClawPluginApi): void {
  async function deliver(request: CardRequest, update: boolean): Promise<void> {
    if (
      !/^dws-assistant-[a-f0-9-]{36}$/.test(request.outTrackId) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(request.ownerUserId) ||
      !request.templateId
    ) {
      throw new Error("Invalid assistant card request");
    }
    const config = getConfig(api.config, request.accountId);
    const token = await getAccessToken(config, api.logger);
    const cardParamMap = Object.fromEntries(
      Object.entries(request.data).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
    const options = {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      timeout: 15000,
      ...getProxyBypassOption(config),
    };
    const body = { outTrackId: request.outTrackId, cardData: { cardParamMap } };
    if (update) {
      await axios.put(
        "https://api.dingtalk.com/v1.0/card/instances",
        { ...body, cardUpdateOptions: { updateCardDataByKey: true } },
        options,
      );
    } else {
      const response = await axios.post(
        "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",
        {
          ...body,
          cardTemplateId: request.templateId,
          callbackType: "STREAM",
          userIdType: 1,
          openSpaceId: `dtv1.card//IM_ROBOT.${request.ownerUserId}`,
          imRobotOpenSpaceModel: { supportForward: false },
          imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: config.clientId },
        },
        options,
      );
      const failures = response.data?.result?.deliverResults;
      if (
        Array.isArray(failures) &&
        failures.some((r: { success?: boolean }) => r.success === false)
      ) {
        throw new Error("Assistant card delivery failed");
      }
    }
  }
  registry().channel = {
    sendCard: (request) => deliver(request, false),
    updateCard: (request) => deliver(request, true),
  };
}
