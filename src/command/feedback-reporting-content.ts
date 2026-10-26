import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { readSmallJson } from "./feedback-reporting-io";
import type { ReportContent, ReportJob } from "./feedback-reporting-protocol";
import { collectSqliteFeedbackContent } from "./feedback-sqlite-content";
import type { FeedbackRecord } from "./feedback-store";
import { resolveFeedbackTranscriptMessages } from "./feedback-transcript-content";

export type FeedbackContentJob = Pick<
  ReportJob,
  "record" | "transcriptStorePath" | "metadataOnly"
> & { config: Pick<ReportJob["config"], "maxTranscriptBytes" | "maxContentBytes"> };

/** Only called inside the reporting worker. Never materializes a whole transcript. */
export async function collectReportContent(job: FeedbackContentJob): Promise<ReportContent> {
  const link = job.record.transcript;
  if (link?.status !== "linked") {
    return {
      mode: "replace",
      status: "missing",
      reason: "reference_not_recorded",
      answerHash: job.record.answerHash,
    };
  }
  if (job.metadataOnly) {
    return {
      mode: "replace",
      status: "pending",
      reason: "resource_budget",
      answerHash: job.record.answerHash,
    };
  }
  try {
    if (link.localFile && path.isAbsolute(link.localFile)) {
      const root = await realpath(path.dirname(job.transcriptStorePath));
      const candidate = await realpath(link.localFile).catch(() => undefined);
      if (candidate) {
        const relative = path.relative(root, candidate);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          return await collectLegacyTranscript(job, candidate);
        }
      }
    }
    let sqlite = /\.(?:sqlite|db)$/i.test(job.transcriptStorePath);
    if (!sqlite) {
      const handle = await open(job.transcriptStorePath, "r").catch(() => undefined);
      if (handle) {
        try {
          const header = Buffer.alloc(16);
          await handle.read(header, 0, 16, 0);
          sqlite = header.toString() === "SQLite format 3\0";
        } finally {
          await handle.close();
        }
      }
    }
    if (sqlite) {
      return await collectSqliteFeedbackContent(job);
    }
    // Public read-only legacy helpers. Never fall back to full-transcript hydration.
    const sdk = await import("openclaw/plugin-sdk/session-store-runtime");
    if (
      typeof sdk.resolveSessionFilePath !== "function" ||
      typeof sdk.resolveSessionStoreEntry !== "function"
    ) {
      return { mode: "replace", status: "pending", reason: "bounded_reader_unavailable" };
    }
    const store = await readSmallJson<Record<string, { sessionId?: string; sessionFile?: string }>>(
      job.transcriptStorePath,
      1024 * 1024,
    );
    if (!store) {
      return { mode: "replace", status: "pending", reason: "store_unavailable" };
    }
    const entry = sdk.resolveSessionStoreEntry({
      store: store as Parameters<typeof sdk.resolveSessionStoreEntry>[0]["store"],
      sessionKey: job.record.sessionKey,
    }).existing;
    let file: string;
    if (entry?.sessionId === link.sessionId) {
      file = sdk.resolveSessionFilePath(link.sessionId, entry, {
        agentId: job.record.agentId,
        sessionsDir: path.dirname(job.transcriptStorePath),
      });
    } else if (job.record.sessionKey === `agent:${job.record.agentId}:main`) {
      // The exact saved ID still identifies the old non-threaded main transcript
      // after a reset. Ask the public path helper; never select the current ID.
      file = sdk.resolveSessionTranscriptPathInDir(
        link.sessionId,
        path.dirname(job.transcriptStorePath),
      );
    } else {
      return { mode: "replace", status: "pending", reason: "session_target_unavailable" };
    }
    return await collectLegacyTranscript(job, file);
  } catch (error) {
    return {
      mode: "replace",
      status: "pending",
      reason:
        (error as Error).message === "metadata_size_limit" ? "resource_budget" : "read_failed",
    };
  }
}

export async function collectLegacyTranscript(
  job: FeedbackContentJob,
  file: string,
): Promise<ReportContent> {
  const link = job.record.transcript;
  if (link?.status !== "linked") {
    return { mode: "replace", status: "missing", reason: "reference_not_recorded" };
  }
  let handle;
  try {
    handle = await open(file, "r");
  } catch (e) {
    return {
      mode: "replace",
      status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "pending",
      reason:
        (e as NodeJS.ErrnoException).code === "ENOENT" ? "transcript_not_found" : "read_failed",
    };
  }
  try {
    const initialStat = await handle.stat();
    if (initialStat.size > job.config.maxTranscriptBytes) {
      return { mode: "replace", status: "pending", reason: "resource_budget" };
    }
    const selected: unknown[] = [];
    let pending = Buffer.alloc(0);
    let total = 0;
    let header = false;
    let malformed = false;
    const consume = (line: Buffer) => {
      if (!line.length) {
        return;
      }
      try {
        const event = JSON.parse(line.toString("utf8"));
        if (event.type === "session") {
          header = true;
          selected.push(event);
        } else if (event.id === link.userMessageId || event.id === link.assistantMessageId) {
          selected.push(event);
        }
      } catch {
        malformed = true;
      }
    };
    for await (const chunk of handle.createReadStream({
      highWaterMark: 64 * 1024,
      autoClose: false,
    })) {
      total += chunk.length;
      if (total > job.config.maxTranscriptBytes) {
        return { mode: "replace", status: "pending", reason: "resource_budget" };
      }
      pending = Buffer.concat([pending, chunk]);
      let index;
      while ((index = pending.indexOf(10)) >= 0) {
        if (index > 1024 * 1024) {
          return { mode: "replace", status: "pending", reason: "resource_budget" };
        }
        consume(pending.subarray(0, index));
        pending = pending.subarray(index + 1);
      }
      if (pending.length > 1024 * 1024) {
        return { mode: "replace", status: "pending", reason: "resource_budget" };
      }
      if (selected.length > 4) {
        return { mode: "replace", status: "unverified", reason: "invalid_transcript" };
      }
    }
    consume(pending);
    const finalStat = await handle.stat();
    if (initialStat.size !== finalStat.size || initialStat.mtimeMs !== finalStat.mtimeMs) {
      return { mode: "replace", status: "pending", reason: "transcript_changed" };
    }
    if (malformed || !header) {
      return { mode: "replace", status: "unverified", reason: "invalid_transcript" };
    }
    const result = resolveFeedbackTranscriptMessages(job.record as FeedbackRecord, selected);
    if (!result) {
      const ids = new Set(selected.map((e) => (e as { id?: string }).id));
      return {
        mode: "replace",
        status:
          ids.has(link.userMessageId) && ids.has(link.assistantMessageId)
            ? "unverified"
            : "missing",
        reason:
          ids.has(link.userMessageId) && ids.has(link.assistantMessageId)
            ? "content_verification_failed"
            : "message_not_found",
      };
    }
    if (Buffer.byteLength(JSON.stringify(result)) > job.config.maxContentBytes) {
      return { mode: "replace", status: "pending", reason: "content_budget" };
    }
    return {
      mode: "replace",
      status: "available",
      question: result.question,
      answer: result.answer,
      answerHash: job.record.answerHash,
    };
  } finally {
    await handle.close();
  }
}
