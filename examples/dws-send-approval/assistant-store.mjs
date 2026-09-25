import { createHash } from "node:crypto";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function messageKey(event, profile) {
  return createHash("sha256")
    .update(JSON.stringify([profile, event.conversation_id, event.message_id]))
    .digest("hex");
}
export const PENDING = new Set(["generating", "classifying", "pending", "inbox", "stale", "draft-error", "topic-review"]);
export const EDITABLE = new Set(["pending", "draft-error", "inbox", "topic-review"]);
export class AssistantStore {
  constructor(config) {
    this.config = config;
  }
  async open(stateDir) {
    const dir = join(stateDir, "dws-send-approval");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const path = join(dir, "assistant.sqlite");
    this.db = new DatabaseSync(path);
    await chmod(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, message_key TEXT UNIQUE NOT NULL,
        conversation TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS draft_conversation ON drafts(conversation,updated);
      CREATE INDEX IF NOT EXISTS draft_status ON drafts(status,updated);
      CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, body TEXT NOT NULL);`);
    const identity = {
      profile: this.config.profile,
      owner: this.config.ownerUserId,
      account: this.config.accountId,
    };
    const saved = this.get("identity");
    if (saved && JSON.stringify(saved) !== JSON.stringify(identity)) {
      this.close();
      throw new Error("代回复数据与当前账号不匹配，已停止。");
    }
    this.set("identity", identity);
    for (const row of this.list(["sending", "generating", "classifying"], 10000)) {
      this.put({
        ...row,
        status: row.status === "sending" ? "unknown" : row.status === "classifying" ? "topic-review" : "draft-error",
        version: row.version + 1,
        error:
          row.status === "sending"
            ? "服务重启，发送结果待核实；不会自动重发。"
            : row.status === "classifying" ? "主题识别被中断，未自动重试；可修改或重新拟稿。" : "拟稿被中断，可重新拟稿。",
      });
    }
    this.prune();
  }
  get(key) {
    const r = this.db.prepare("SELECT body FROM kv WHERE key=?").get(key);
    return r ? JSON.parse(r.body) : undefined;
  }
  set(key, value) {
    this.db
      .prepare("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body")
      .run(key, JSON.stringify(value));
  }
  find(key) {
    const r = this.db.prepare("SELECT body FROM drafts WHERE message_key=?").get(key);
    return r ? JSON.parse(r.body) : undefined;
  }
  draft(id) {
    const r = this.db.prepare("SELECT body FROM drafts WHERE id=?").get(Number(id));
    return r ? JSON.parse(r.body) : undefined;
  }
  list(statuses, limit = 2000) {
    const clause = statuses?.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    return this.db
      .prepare(`SELECT body FROM drafts ${clause} ORDER BY updated DESC,id DESC LIMIT ?`)
      .all(...(statuses ?? []), limit)
      .map((r) => JSON.parse(r.body));
  }
  conversation(id, before, limit = 5) {
    return this.db
      .prepare("SELECT body FROM drafts WHERE conversation=? AND id<? ORDER BY id DESC LIMIT ?")
      .all(id, before, limit)
      .map((r) => JSON.parse(r.body))
      .toReversed();
  }
  create(event, preferences, reply, now = Date.now()) {
    const key = messageKey(event, this.config.profile);
    if (this.find(key)) {
      return null;
    }
    const pending = this.list([...PENDING], 201);
    if (
      pending.length >= 200 &&
      !pending.some((d) => d.event.conversation_id === event.conversation_id)
    ) {
      throw new Error("待处理已达200条，请先处理或清理。");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const id = Number(
        this.db
          .prepare(
            "INSERT INTO drafts(message_key,conversation,status,version,updated,body) VALUES(?,?,?,?,?,?)",
          )
          .run(key, event.conversation_id, "generating", 1, now, "{}").lastInsertRowid,
      );
      const value = {
        id,
        key,
        event,
        reply,
        preferenceRevision: preferences.revision,
        status: "generating",
        version: 1,
        created: now,
        updated: now,
        expires: now + this.config.assistant.draftTtlMinutes * 60000,
        text: "",
      };
      this.put(value);
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  put(value) {
    this.db
      .prepare("UPDATE drafts SET status=?,version=?,updated=?,body=? WHERE id=?")
      .run(
        value.status,
        value.version,
        value.updated ?? Date.now(),
        JSON.stringify(value),
        value.id,
      );
    return structuredClone(value);
  }
  card(value) {
    this.db
      .prepare("DELETE FROM cards WHERE json_extract(body,'$.outTrackId')=? AND id<>?")
      .run(value.outTrackId, value.id);
    this.db
      .prepare(
        "INSERT INTO cards VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,body=excluded.body",
      )
      .run(value.id, value.expires, JSON.stringify(value));
    return value;
  }
  listCards() {
    return this.db
      .prepare("SELECT body FROM cards ORDER BY expires DESC")
      .all()
      .map((r) => JSON.parse(r.body));
  }
  cardForTrack(outTrackId) {
    return this.listCards().find((c) => c.outTrackId === outTrackId);
  }
  getCard(id) {
    const r = this.db.prepare("SELECT body FROM cards WHERE id=?").get(id);
    return r ? JSON.parse(r.body) : undefined;
  }
  cardsForDraft(id) {
    return this.db
      .prepare("SELECT body FROM cards WHERE expires>?")
      .all(Date.now())
      .map((r) => JSON.parse(r.body))
      .filter((c) => c.refs?.some((r) => r.id === id));
  }
  prune(now = Date.now()) {
    this.db
      .prepare("DELETE FROM kv WHERE key LIKE 'cooldown:%' AND CAST(body AS INTEGER)<?")
      .run(now - 86400000);
    this.db.prepare("DELETE FROM cards WHERE expires<?").run(now - 7 * 86400000);
    this.db
      .prepare(
        "DELETE FROM cards WHERE id NOT IN (SELECT id FROM cards ORDER BY expires DESC LIMIT 1000)",
      )
      .run();
    for (const draft of this.list([...PENDING])) {
      if (draft.expires <= now) {
        this.put({ ...draft, status: "expired", version: draft.version + 1 });
      }
    }
    // Keep recent fingerprints even for ignored messages; never evict pending or uncertain sends.
    this.db
      .prepare(
        "DELETE FROM drafts WHERE status IN ('sent','ignored','expired','superseded','suppressed','filtered') AND updated<?",
      )
      .run(now - 30 * 86400000);
  }
  close() {
    this.db?.close();
    this.db = null;
  }
}
