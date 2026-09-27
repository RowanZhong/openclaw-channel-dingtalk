import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getAccessToken } from "../platform/auth";
import {
  listDingTalkAccountIds,
  resolveDingTalkAccount,
  resolveRobotCode,
} from "../platform/config";
import type { DingTalkConfig, Logger } from "../platform/types";
import httpClient from "../shared/http-client";
import { getProxyBypassOption } from "../shared/utils";
import { getCardExtensionRegistry } from "./card-extension-registry";
import type { CardExtensionTransport } from "./card-extension-registry";
import { DingTalkCardExtensionError } from "./card-extension-types";

/** Registration is local-only. Disabled/unknown accounts must not inherit default credentials. */
export function configureCardExtensions(cfg: OpenClawConfig): void {
  getCardExtensionRegistry().accountStatus = (accountId) => {
    if (!listDingTalkAccountIds(cfg).includes(accountId)) {
      return "account-unconfigured";
    }
    const account = resolveDingTalkAccount(cfg, accountId);
    if (
      (cfg.channels?.dingtalk as { enabled?: boolean } | undefined)?.enabled === false ||
      account.enabled === false
    ) {
      return "account-disabled";
    }
    return account.configured ? "configured" : "account-unconfigured";
  };
}

export function createCardExtensionTransport(params: {
  config: DingTalkConfig;
  log?: Logger;
  isConnected: () => boolean;
}): CardExtensionTransport {
  const { config, log, isConnected } = params;
  const request = async (method: "post" | "put", body: Record<string, unknown>) => {
    try {
      const token = await getAccessToken(config, log);
      // Account may have stopped while a token was being refreshed.
      if (!isConnected()) {
        throw new DingTalkCardExtensionError("not-connected", "DingTalk account disconnected");
      }
      const response = await httpClient[method](
        `https://api.dingtalk.com/v1.0/card/instances${method === "post" ? "/createAndDeliver" : ""}`,
        body,
        {
          headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
          timeout: 15_000,
          ...getProxyBypassOption(config),
        },
      );
      const data = response.data as
        | { success?: boolean; result?: { deliverResults?: Array<{ success?: boolean }> } }
        | undefined;
      if (
        response.status < 200 ||
        response.status >= 300 ||
        data?.success === false ||
        data?.result?.deliverResults?.some((item) => item.success === false)
      ) {
        throw new DingTalkCardExtensionError(
          "request-failed",
          "DingTalk card request or delivery failed",
        );
      }
    } catch (error) {
      if (error instanceof DingTalkCardExtensionError) {
        throw error;
      }
      // Axios errors can retain token headers, variables and server-echoed input.
      // Do not expose their cause/body to consumers or log them here.
      const status = httpClient.isAxiosError(error) ? error.response?.status : undefined;
      throw new DingTalkCardExtensionError(
        "request-failed",
        `DingTalk card request failed${typeof status === "number" ? ` (HTTP ${status})` : ""}`,
      );
    }
  };
  return {
    isConnected,
    async send({ outTrackId, templateId, userId, variables }) {
      await request("post", {
        outTrackId,
        cardTemplateId: templateId,
        cardData: { cardParamMap: variables },
        callbackType: "STREAM",
        userIdType: 1,
        openSpaceId: `dtv1.card//IM_ROBOT.${userId}`,
        imRobotOpenSpaceModel: { supportForward: false },
        imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: resolveRobotCode(config) },
      });
    },
    async update({ outTrackId, variables }) {
      await request("put", {
        outTrackId,
        cardData: { cardParamMap: variables },
        cardUpdateOptions: { updateCardDataByKey: true },
      });
    },
  };
}
