import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/platform/types";

/**
 * Regression guard for PR #612 review item P1-3: a rejecting reply-strategy
 * cleanup must not skip `releaseSessionLock()`, otherwise every later message
 * on the same session waits forever behind a lock nobody releases.
 */
const shared = vi.hoisted(() => ({
  getRuntimeMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  createAICardMock: vi.fn(),
  sendMessageMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  updateAICardBlockListMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  createReplyStrategyMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
}));

vi.mock("../../src/platform/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("../../src/messaging/message-utils", () => ({
  extractMessageContent: shared.extractMessageContentMock,
}));

vi.mock("../../src/messaging/attachment-text-extractor", () => ({
  extractAttachmentText: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/messaging/quoted-file-service", () => ({
  downloadGroupFile: vi.fn().mockResolvedValue(null),
  getUnionIdByStaffId: vi.fn().mockResolvedValue("union_1"),
  resolveQuotedFile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/messaging/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMedia: vi.fn(),
  uploadMedia: vi.fn(),
}));

vi.mock("../../src/card/card-service", () => ({
  createAICard: shared.createAICardMock,
  commitAICardBlocks: vi.fn(),
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  streamAICard: vi.fn(),
  updateAICardBlockList: shared.updateAICardBlockListMock,
  streamAICardContent: vi.fn(),
  clearAICardStreamingContent: vi.fn(),
}));

vi.mock("../../src/gateway/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
}));

vi.mock("../../src/messaging/media-utils", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/messaging/media-utils")>("../../src/messaging/media-utils");
  return {
    ...actual,
    prepareMediaInput: vi.fn(),
    resolveOutboundMediaType: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: vi.fn().mockReturnValue(false),
  isBtwRequestText: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/messaging/message-context-store", async () => {
  const actual = await vi.importActual<typeof import("../../src/messaging/message-context-store")>(
    "../../src/messaging/message-context-store",
  );
  return {
    ...actual,
    upsertInboundMessageContext: vi.fn(actual.upsertInboundMessageContext),
    resolveByMsgId: vi.fn(actual.resolveByMsgId),
    resolveByAlias: vi.fn(actual.resolveByAlias),
    resolveByCreatedAtWindow: vi.fn(actual.resolveByCreatedAtWindow),
    clearMessageContextCacheForTest: vi.fn(actual.clearMessageContextCacheForTest),
  };
});

vi.mock("../../src/messaging/reply-strategy", () => ({
  createReplyStrategy: shared.createReplyStrategyMock,
}));

import { handleDingTalkMessage, resetProactivePermissionHintStateForTest } from "../../src/gateway/inbound-handler";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi
          .fn()
          .mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/.openclaw/media/inbound/test-file.png",
          contentType: "image/png",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/store.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "s1" }),
        dispatchReplyWithBufferedBlockDispatcher: vi
          .fn()
          .mockImplementation(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "完成" }, { kind: "final" });
            return { queuedFinal: false };
          }),
      },
    },
  };
}

function buildStrategy(dispose: () => Promise<void>) {
  return {
    getReplyOptions: vi.fn().mockReturnValue({ disableBlockStreaming: true }),
    deliver: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose,
    getFinalText: vi.fn().mockReturnValue(undefined),
  };
}

async function runInbound(): Promise<void> {
  await handleDingTalkMessage({
    cfg: {},
    accountId: "main",
    sessionWebhook: "https://session.webhook",
    log: undefined,
    dingtalkConfig: {
      dmPolicy: "open",
      messageType: "card",
      ackReaction: "",
    } as unknown as DingTalkConfig,
    data: {
      msgId: "m_strategy_cleanup",
      msgtype: "text",
      text: { content: "执行任务" },
      conversationType: "1",
      conversationId: "cid_ok",
      senderId: "user_1",
      chatbotUserId: "bot_1",
      sessionWebhook: "https://session.webhook",
      createAt: Date.now(),
    },
  } as unknown as { data: unknown });
}

describe("inbound-handler reply strategy cleanup", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    clearCardRunRegistryForTest();
    resetProactivePermissionHintStateForTest();

    shared.getRuntimeMock.mockReset().mockReturnValue(buildRuntime());
    shared.extractMessageContentMock.mockReset().mockReturnValue({ text: "hello", messageType: "text" });
    shared.createAICardMock.mockReset().mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
    shared.sendMessageMock.mockReset().mockResolvedValue({ ok: true });
    shared.sendBySessionMock.mockReset().mockResolvedValue({ ok: true });
    shared.isCardInTerminalStateMock.mockReset().mockReturnValue(false);
    shared.updateAICardBlockListMock.mockReset().mockResolvedValue(undefined);
    shared.acquireSessionLockMock.mockReset();
    shared.createReplyStrategyMock.mockReset();
  });

  it("releases the session lock when reply-strategy cleanup rejects", async () => {
    const releaseLock = vi.fn();
    shared.acquireSessionLockMock.mockResolvedValueOnce(releaseLock);
    shared.createReplyStrategyMock.mockReturnValueOnce(
      buildStrategy(vi.fn().mockRejectedValue(new Error("dispose boom"))),
    );

    await expect(runInbound()).resolves.toBeUndefined();

    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("releases the session lock when the strategy itself is never finalized", async () => {
    const releaseLock = vi.fn();
    const dispose = vi.fn().mockResolvedValue(undefined);
    shared.acquireSessionLockMock.mockResolvedValueOnce(releaseLock);
    shared.createReplyStrategyMock.mockReturnValueOnce(buildStrategy(dispose));

    await runInbound();

    expect(dispose).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
