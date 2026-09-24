import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistant } from "../assistant.mjs";
import { readConfig } from "../config.mjs";
import { initialPreferences } from "../preferences.mjs";
import { replySnapshot } from "../rules.mjs";
export async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dws-assistant-test-"));
  const config = readConfig({
    ownerUserId: "A",
    profile: "corp:A",
    dwsPath: "/nonexistent/dws",
    listener: { ignoreSenderOpenIds: ["BOT"] },
    assistant: { cardTemplateId: "template.schema" },
  });
  let prefs = initialPreferences(config);
  prefs.enabled = true;
  prefs.rules.dm.mode = "all";
  prefs.rules.at.mode = "all";
  const cards = [],
    sends = [],
    models = [];
  const api = {
    logger: { warn() {} },
    runtime: {
      llm: {
        complete() {
          throw new Error("unexpected live model");
        },
      },
    },
  };
  const assistant = createAssistant(api, config, {
    transport: {
      sendCard: async (x) => {
        cards.push(x);
      },
      updateCard: async (x) => {
        cards.push(x);
      },
    },
    send: async (d) => {
      sends.push(d);
    },
    draft: async (...args) => {
      models.push(args);
      return "我先确认，再答复你。";
    },
    resolve: async (kind, raw) =>
      [
        ...new Set(
          raw
            .split(/[,，\r\n]+/)
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ].map((x) => ({
        kind,
        id: x.replace(/^open:|^id:/, ""),
        userId: kind === "user" ? x : undefined,
        name: kind === "user" ? "张三" : x,
      })),
    ...overrides,
  });
  assistant.bind({
    snapshot: () => structuredClone(prefs),
    status: () => ({ state: "ready" }),
    update: async (fn) => {
      fn(prefs);
      prefs.revision++;
    },
  });
  await assistant.start({ stateDir: dir });
  t.after(async () => {
    await assistant.stop();
    await rm(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const event = (extra = {}) => ({
    type: "user_im_message_receive_o2o_all",
    event_id: `e${++seq}`,
    message_id: `m${seq}`,
    conversation_id: `chat${seq}`,
    sender_open_dingtalk_id: "B",
    content: "你好",
    timestamp: Date.now(),
    ...extra,
  });
  const incoming = async (e) => {
    await assistant.processEvent(e, prefs, replySnapshot(e, prefs));
    await assistant.idle();
    return assistant.store.find(
      (await import("../assistant-store.mjs")).messageKey(e, config.profile),
    );
  };
  const act = async (card, op, values = {}, identity = {}) => {
    const index = card.actions.findIndex((x) => x.op === op);
    if (index < 0) throw new Error(`Missing ${op}`);
    await assistant.handle({
      actionId: `dws-assistant:${card.id}:${index}`,
      outTrackId: card.outTrackId,
      userId: "A",
      accountId: "default",
      values: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [(card.fieldPrefix || "") + key, value]),
      ),
      ...identity,
    });
    await assistant.idle();
  };
  return {
    assistant,
    config,
    cards,
    sends,
    models,
    event,
    incoming,
    act,
    async auto(card, values) {
      await act(card, "auto-next", { scope: values.scope, targetInput: values.targetInput || "" });
      await act(this.lastCard(), "auto-next", {
        answer: values.answer,
        keywords: values.keywords || "",
      });
      await act(this.lastCard(), "auto-next", { hours: values.hours });
      if (this.lastCard().name !== "auto-frequency") return;
      await act(this.lastCard(), "auto-next", { cooldown: values.cooldown });
      if (this.lastCard().name === "auto-review") await act(this.lastCard(), "save-auto");
    },
    dir,
    admit: (e) => assistant.processEvent(e, prefs, replySnapshot(e, prefs)),
    get prefs() {
      return prefs;
    },
    lastCard() {
      const out = cards.findLast((x) => x.data.card_status === "pending");
      const action = out.data.action1;
      return assistant.store.getCard(action.split(":")[1]);
    },
  };
}
