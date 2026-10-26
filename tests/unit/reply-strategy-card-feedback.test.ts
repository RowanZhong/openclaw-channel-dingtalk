import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCardReplyStrategy } from "../../src/reply-strategy-card";
import { completeFeedbackCard } from "../../src/command/feedback-store";
import { commitAICardBlocks } from "../../src/card-service";
import { AICardStatus } from "../../src/types";

vi.mock("../../src/command/feedback-store", () => ({ completeFeedbackCard: vi.fn() }));
vi.mock("../../src/card-service", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/card-service")>(),
  commitAICardBlocks: vi.fn(), updateAICardStatusLine: vi.fn(), updateAICardBlockList: vi.fn(),
  streamAICardContent: vi.fn(), clearAICardStreamingContent: vi.fn(),
}));
function setup(enabled = true, feedbackTranscript?: import("../../src/card/feedback-transcript").FeedbackTranscriptTracker) {
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const strategy = createCardReplyStrategy({
    config: { clientId: "app", clientSecret: "secret", feedbackEnabled: enabled, cardStreamingMode: "off" },
    feedbackTranscript,
    to: "owner", senderId: "owner", accountId: "default", sessionAgentId: "main", storePath: "/tmp/feedback-test.json",
    sessionWebhook: "https://example.invalid", isDirect: true, deliverMedia: vi.fn(), log,
    card: { cardInstanceId: "card-1", outTrackId: "card-1", accessToken: "token", conversationId: "owner",
      createdAt: Date.now(), lastUpdated: Date.now(), state: AICardStatus.INPUTING },
  });
  return { strategy, log };
}
const final = (text: string, isError = false) => ({ kind: "final" as const, text, isError, mediaUrls: [] });
describe("reply feedback completion boundary", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(completeFeedbackCard).mockReset().mockResolvedValue(); vi.mocked(commitAICardBlocks).mockReset().mockResolvedValue(); });
  afterEach(() => { vi.useRealTimers(); });
  it("marks only a successfully delivered answer as eligible", async () => {
    const { strategy } = setup(); await strategy.deliver(final("answer")); await strategy.finalize();
    expect(completeFeedbackCard).toHaveBeenCalledWith({ storePath: "/tmp/feedback-test.json", accountId: "default" }, "card-1", "answer", undefined, undefined);
  });
  it("persists the exact transcript reference in the existing completion write", async () => {
    const link = { status: "linked" as const, source: "runtime-events" as const, sessionId: "s1", userMessageId: "u1", assistantMessageId: "a1" };
    const tracker = { bindRun: vi.fn(), resolve: vi.fn().mockReturnValue(link), dispose: vi.fn() };
    const { strategy } = setup(true, tracker);
    await strategy.deliver(final("answer")); await strategy.finalize();
    expect(tracker.resolve).toHaveBeenCalledWith("answer", { includeLocalFile: true });
    expect(completeFeedbackCard).toHaveBeenCalledTimes(1);
    expect(completeFeedbackCard).toHaveBeenCalledWith(expect.anything(), "card-1", "answer", undefined, link);
  });
  it("does not count model login failure messages as answers", async () => {
    const { strategy } = setup(); await strategy.deliver(final("Model login failed", true)); await strategy.finalize();
    expect(commitAICardBlocks).toHaveBeenCalled(); expect(completeFeedbackCard).not.toHaveBeenCalled();
  });
  it("preserves eligibility when a late warning is ignored after a valid answer", async () => {
    const { strategy } = setup(); await strategy.deliver(final("answer")); await strategy.deliver(final("late warning", true)); await strategy.finalize();
    expect(completeFeedbackCard).toHaveBeenCalledWith(expect.anything(), "card-1", "answer", undefined, undefined);
  });
  it("does not count aborted turns", async () => {
    const { strategy } = setup(); await strategy.abort(new Error("failed")); expect(completeFeedbackCard).not.toHaveBeenCalled();
  });
  it("does not count failed platform card delivery", async () => {
    vi.mocked(commitAICardBlocks).mockRejectedValue(new Error("platform failure"));
    const { strategy } = setup(); await strategy.deliver(final("answer")); await strategy.finalize(); expect(completeFeedbackCard).not.toHaveBeenCalled();
  });
  it("does not turn feedback I/O failure into a failed user answer", async () => {
    vi.mocked(completeFeedbackCard).mockRejectedValue(new Error("disk full"));
    const { strategy, log } = setup(); await strategy.deliver(final("answer")); await expect(strategy.finalize()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("feedback will fail closed"));
  });
  it("does no feedback work when disabled", async () => {
    const { strategy } = setup(false); await strategy.deliver(final("answer")); await strategy.finalize(); expect(completeFeedbackCard).not.toHaveBeenCalled();
  });
});
