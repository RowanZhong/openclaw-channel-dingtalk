import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../config.mjs";
import { SourceStore } from "../source-store.mjs";
export const config = readConfig({
  ownerUserId: "owner",
  profile: "work",
  dwsPath: "/opt/bin/dws",
  listener: {
    enabled: true,
    kind: "sender",
    target: "open-b",
    ignoreSenderOpenIds: ["approval-bot"],
  },
});
export const host = {
  commands: { text: true, allowFrom: { dingtalk: ["owner"] } },
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "dingtalk", to: "user:owner", accountId: "default" }],
    },
  },
};
export const event = {
  type: "user_im_message_receive_user",
  event_id: "event-1",
  message_id: "message-1",
  conversation_id: "conversation-1",
  sender_open_dingtalk_id: "open-b",
  content: "hello",
  timestamp: 1234,
};
export async function setup(t, overrides = {}) {
  const folder = await mkdtemp(join(tmpdir(), "dws-guard-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settings = readConfig({ ...config, ...overrides });
  const store = new SourceStore(settings);
  await store.load(folder);
  const record = await store.claim(event);
  return {
    folder,
    config: settings,
    store,
    record,
    ctx: { sessionKey: record.sessionKey, agentId: settings.agentId },
  };
}
