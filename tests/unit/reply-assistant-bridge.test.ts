import { describe, it, expect, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  put: vi.fn(),
  token: vi.fn(async () => "token"),
  handle: vi.fn(async () => true),
}));
vi.mock("../../src/shared/http-client", () => ({ default: { post: mocks.post, put: mocks.put } }));
vi.mock("../../src/platform/auth", () => ({ getAccessToken: mocks.token }));
vi.mock("../../src/platform/config", () => ({
  getConfig: () => ({ clientId: "BOT", clientSecret: "secret" }),
}));
import {
  parseAssistantCallback,
  handleReplyAssistantCard,
  registerReplyAssistantBridge,
} from "../../src/card/reply-assistant-bridge";
const key = Symbol.for("openclaw.dingtalk.reply-assistant.v1");
const action = "dws-assistant:12345678-1234-1234-1234-123456789abc:0";
const payload = () => ({
  userId: "A",
  outTrackId: "dws-assistant-12345678-1234-1234-1234-123456789abc",
  content: JSON.stringify({
    cardPrivateData: {
      actionIds: [action],
      params: { form: { body: { value: "literal" }, selected: { value: ["1", "2"] } } },
    },
  }),
});
beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any)[key] = {
    version: 1,
    assistants: new Map([["default", { handle: mocks.handle }]]),
  };
  mocks.post.mockResolvedValue({ data: { result: { deliverResults: [{ success: true }] } } });
});
describe("reply assistant trusted card bridge", () => {
  it("normalizes form values but keeps envelope identity and account", () => {
    expect(parseAssistantCallback(payload(), "default")).toEqual({
      accountId: "default",
      userId: "A",
      outTrackId: payload().outTrackId,
      actionId: action,
      values: { body: "literal", selected: ["1", "2"] },
    });
  });
  it("never accepts identity or card id from editable nested fields", () => {
    const p = payload();
    expect(
      parseAssistantCallback(
        { ...p, userId: undefined, value: JSON.stringify({ userId: "A" }) },
        "default",
      ),
    ).toBeUndefined();
    expect(
      parseAssistantCallback(
        { ...p, outTrackId: undefined, value: JSON.stringify({ outTrackId: p.outTrackId }) },
        "default",
      ),
    ).toBeUndefined();
  });
  it("isolates callback namespaces and accounts", async () => {
    expect(await handleReplyAssistantCard(payload(), "other")).toBe(true);
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(await handleReplyAssistantCard({ ...payload(), content: "{}" }, "default")).toBe(false);
  });
  it("forwards the authenticated payload without dispatching an agent turn", async () => {
    expect(await handleReplyAssistantCard(payload(), "default")).toBe(true);
    expect(mocks.handle).toHaveBeenCalledTimes(1);
  });
  it("uses private owner delivery, no forwarding and existing bot token retrieval", async () => {
    registerReplyAssistantBridge({ config: {}, logger: {} } as any);
    await (globalThis as any)[key].channel.sendCard({
      accountId: "default",
      ownerUserId: "A",
      templateId: "template",
      outTrackId: payload().outTrackId,
      data: { title: "助手", form: { fields: [] } },
    });
    expect(mocks.token).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][1]).toMatchObject({
      callbackType: "STREAM",
      userIdType: 1,
      openSpaceId: "dtv1.card//IM_ROBOT.A",
      imRobotOpenSpaceModel: { supportForward: false },
    });
    expect(mocks.post.mock.calls[0][2].timeout).toBe(15000);
  });
  it("propagates failed delivery and rejects arbitrary card identifiers", async () => {
    registerReplyAssistantBridge({ config: {}, logger: {} } as any);
    const req = {
      accountId: "default",
      ownerUserId: "A",
      templateId: "template",
      outTrackId: payload().outTrackId,
      data: {},
    };
    mocks.post.mockResolvedValue({ data: { result: { deliverResults: [{ success: false }] } } });
    await expect((globalThis as any)[key].channel.sendCard(req)).rejects.toThrow();
    await expect(
      (globalThis as any)[key].channel.updateCard({ ...req, outTrackId: "other-card" }),
    ).rejects.toThrow();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
