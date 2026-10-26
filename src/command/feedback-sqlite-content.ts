import type { FeedbackContentJob } from "./feedback-reporting-content";
import type { ReportContent } from "./feedback-reporting-protocol";
import type { FeedbackRecord } from "./feedback-store";
import { resolveFeedbackTranscriptMessages } from "./feedback-transcript-content";

type RawPage =
  | {
      kind: "page";
      cursor: string;
      events: { event: unknown; seq: number }[];
      hasMore: boolean;
      requiredBytes?: number;
      serializedBytes: number;
    }
  | { kind: "reset" }
  | { kind: "missing" };
export type FeedbackRawDeltaReader = (target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  cursor?: string;
  maxBytes: number;
  maxEvents: number;
}) => Promise<RawPage>;
/** Optional public SDK adapter. Never substitutes full-transcript hydration. */
export async function collectSqliteFeedbackContent(
  job: FeedbackContentJob,
  supplied?: FeedbackRawDeltaReader,
): Promise<ReportContent> {
  const pending = (reason: string): ReportContent => ({
    mode: "replace",
    status: "pending",
    reason,
  });
  const link = job.record.transcript;
  if (link?.status !== "linked") {
    return { mode: "replace", status: "missing", reason: "reference_not_recorded" };
  }
  try {
    const sdk = supplied
      ? undefined
      : await import("openclaw/plugin-sdk/session-transcript-runtime");
    const read =
      supplied ??
      (sdk as unknown as { readSessionTranscriptRawDelta?: FeedbackRawDeltaReader })
        .readSessionTranscriptRawDelta;
    if (typeof read !== "function") {
      return pending("bounded_reader_unavailable");
    }
    const selected: unknown[] = [];
    let cursor: string | undefined;
    let total = 0;
    let count = 0;
    let pageBytes = Math.min(256 * 1024, job.config.maxTranscriptBytes);
    let completed = false;
    for (let page = 0; page < 256; page++) {
      if (total >= job.config.maxTranscriptBytes || count >= 16384) {
        return pending("resource_budget");
      }
      const maxBytes = Math.min(pageBytes, job.config.maxTranscriptBytes - total);
      const result = await read({
        agentId: job.record.agentId,
        sessionId: link.sessionId,
        sessionKey: job.record.sessionKey,
        storePath: job.transcriptStorePath,
        cursor,
        maxBytes,
        maxEvents: Math.min(256, 16384 - count),
      });
      if (result.kind === "missing") {
        return { mode: "replace", status: "missing", reason: "transcript_not_found" };
      }
      if (result.kind === "reset") {
        return pending("transcript_changed");
      }
      if (
        !Array.isArray(result.events) ||
        !Number.isSafeInteger(result.serializedBytes) ||
        result.serializedBytes < 0 ||
        result.serializedBytes > maxBytes ||
        result.events.length > 256
      ) {
        return pending("resource_budget");
      }
      const actualBytes = Buffer.byteLength(JSON.stringify(result.events));
      // Row/sequence wrappers add small overhead to the SDK's JSONL byte measure.
      if (actualBytes > maxBytes + result.events.length * 128 + 1024) {
        return pending("resource_budget");
      }
      total += result.serializedBytes;
      count += result.events.length;
      for (const row of result.events) {
        const event = row.event as { type?: string; id?: string } | undefined;
        if (
          event?.type === "session" ||
          event?.id === link.userMessageId ||
          event?.id === link.assistantMessageId
        ) {
          selected.push(event);
        }
        if (selected.length > 4) {
          return { mode: "replace", status: "unverified", reason: "invalid_transcript" };
        }
      }
      if (!result.hasMore) {
        completed = true;
        break;
      }
      if (result.requiredBytes && result.requiredBytes > maxBytes) {
        if (
          result.requiredBytes > 1024 * 1024 ||
          result.requiredBytes > job.config.maxTranscriptBytes - total
        ) {
          return pending("resource_budget");
        }
        pageBytes = result.requiredBytes;
      } else if (!result.events.length || result.cursor === cursor) {
        return pending("bounded_reader_unavailable");
      }
      cursor = result.cursor;
    }
    if (!completed) {
      return pending("resource_budget");
    }
    const result = resolveFeedbackTranscriptMessages(job.record as FeedbackRecord, selected);
    if (!result) {
      const ids = new Set(selected.map((row) => (row as { id?: string }).id));
      const present = ids.has(link.userMessageId) && ids.has(link.assistantMessageId);
      return {
        mode: "replace",
        status: present ? "unverified" : "missing",
        reason: present ? "content_verification_failed" : "message_not_found",
      };
    }
    if (Buffer.byteLength(JSON.stringify(result)) > job.config.maxContentBytes) {
      return pending("content_budget");
    }
    return { mode: "replace", status: "available", ...result, answerHash: job.record.answerHash };
  } catch {
    return pending("read_failed");
  }
}
