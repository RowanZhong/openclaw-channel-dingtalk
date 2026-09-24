import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SESSION_MARKER } from "./config.mjs";
import { replyRule, stableId } from "./preferences.mjs";

function validReplySnapshot(reply) {
  if (
    !reply ||
    !stableId(reply.conversationId) ||
    !stableId(reply.senderOpenId) ||
    typeof reply.direct !== "boolean" ||
    !["user", "group", "default"].includes(reply.scope) ||
    !Number.isSafeInteger(reply.revision) ||
    reply.revision < 0
  ) {
    throw new Error("invalid reply snapshot");
  }
  if (reply.mode !== "ai" || reply.text !== "") {
    replyRule(reply.mode, reply.text);
  }
  return structuredClone(reply);
}

export class SourceStore {
  constructor(config, { capacity = 10_000 } = {}) {
    this.config = config;
    this.capacity = capacity;
    this.records = new Map();
    this.messageKeys = new Set();
    this.ready = false;
  }

  keyFor(event) {
    const hash = createHash("sha256")
      .update(JSON.stringify([this.config.profile, event.event_id]))
      .digest("hex");
    return `agent:${this.config.agentId}${SESSION_MARKER}${hash}`;
  }

  messageKeyFor(event) {
    // Subscription event IDs can differ for the same business message.
    return createHash("sha256")
      .update(JSON.stringify([this.config.profile, event.conversation_id, event.message_id]))
      .digest("hex");
  }

  has(event) {
    return this.records.has(this.keyFor(event)) || this.messageKeys.has(this.messageKeyFor(event));
  }

  async load(stateDir) {
    this.ready = false;
    this.records.clear();
    this.messageKeys.clear();
    this.path = join(stateDir, "dws-send-approval", "sources.json");
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8"));
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.records) ||
        saved.records.length > this.capacity
      ) {
        throw new Error("invalid source registry");
      }
      for (const record of saved.records) {
        if (record.reply !== undefined) {
          validReplySnapshot(record.reply);
        }
        if (
          typeof record.sessionKey !== "string" ||
          !/^agent:[a-z0-9_-]+:dws-listener:[a-f0-9]{64}$/.test(record.sessionKey) ||
          typeof record.profile !== "string" ||
          !Number.isFinite(record.createdAt) ||
          (record.messageKey !== undefined &&
            (typeof record.messageKey !== "string" || !/^[a-f0-9]{64}$/.test(record.messageKey)))
        ) {
          throw new Error("invalid source record");
        }
        this.records.set(record.sessionKey, record);
        if (record.messageKey) {
          this.messageKeys.add(record.messageKey);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Do not expose a malformed registry's raw contents in host error logs.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Cannot load DWS source registry; listener remains stopped");
      }
    }
    this.ready = true;
  }

  async claim(event, reply) {
    if (!this.ready) {
      throw new Error("source registry not ready");
    }
    const sessionKey = this.keyFor(event);
    if (this.has(event)) {
      return null;
    }
    if (this.records.size >= this.capacity) {
      throw new Error(
        "source registry full; archive completed listener sessions before clearing records",
      );
    }
    const messageKey = this.messageKeyFor(event);
    const record = {
      sessionKey,
      profile: this.config.profile,
      createdAt: Date.now(),
      messageKey,
      // AI instructions go to this run's prompt, not every source-registry record.
      ...(reply
        ? { reply: validReplySnapshot({ ...reply, text: reply.mode === "ai" ? "" : reply.text }) }
        : {}),
    };
    this.records.set(sessionKey, record);
    this.messageKeys.add(messageKey);
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, records: [...this.records.values()] }),
        { mode: 0o600 },
      );
      await rename(temporary, this.path);
    } catch {
      this.ready = false;
      throw new Error("Cannot persist DWS source; event was not dispatched");
    }
    return record;
  }

  classify(ctx = {}) {
    const key = ctx.sessionKey;
    if (typeof key !== "string" || !key) {
      return "unknown";
    }
    if (!key.includes(SESSION_MARKER)) {
      return "ordinary";
    }
    const record = this.records.get(key);
    if (
      !this.ready ||
      !record ||
      record.profile !== this.config.profile ||
      ctx.agentId !== this.config.agentId
    ) {
      return "unknown";
    }
    return "listener";
  }
}
