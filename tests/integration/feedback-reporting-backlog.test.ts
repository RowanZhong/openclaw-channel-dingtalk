import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportPaths } from "../../src/command/feedback-reporting-io";
import { createReportEnvelope } from "../../src/command/feedback-reporting-protocol";
import { FeedbackReportingService } from "../../src/command/feedback-reporting-service";
import {
  applyFeedback,
  completeFeedbackCard,
  feedbackRecordPath,
  registerFeedbackCard,
} from "../../src/command/feedback-store";
import { reportingFixture } from "../unit/fixtures/feedback-reporting";
const dirs: string[] = [];
const servers: Server[] = [];
const services: FeedbackReportingService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function until(check: () => boolean, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
describe("real worker under durable pending backlog", () => {
  it.each([128, 1025])(
    "reports fresh feedback with %i acknowledged-pending predecessors",
    async (count) => {
      const bodies: any[] = [];
      const server = createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          const b = JSON.parse(data);
          bodies.push(b);
          res.end(
            JSON.stringify({
              schemaVersion: 1,
              recordId: b.recordId,
              acceptedRevision: b.revision,
              status: "applied",
            }),
          );
        });
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const f = await reportingFixture(`http://127.0.0.1:${(server.address() as any).port}/report`);
      dirs.push(f.dir);
      if (f.job.record.transcript?.status === "linked")
        f.job.record.transcript.localFile = f.sessionFile;
      await mkdir(path.dirname(feedbackRecordPath(f.job.scope, "seed")), { recursive: true });
      for (let i = 0; i < count; i++) {
        const record = { ...f.job.record, outTrackId: `pending-${i}`, history: [], seen: [] };
        const job = { ...f.job, record };
        const paths = reportPaths(job.scope, record.outTrackId, f.config.destinationKey);
        const receipt = {
          sourceRevision: 1,
          wireRevision: 1,
          terminal: false,
          nextAttemptAt: Date.now() + 300000 + i,
          expiresAt: record.expiresAt,
          attempts: 0,
          maintenanceVersion: 2,
        };
        const state = {
          ...receipt,
          delivered: true,
          destinationKey: f.config.destinationKey,
          envelope: createReportEnvelope(job, 1, {
            mode: "replace",
            status: "pending",
            reason: "resource_budget",
          }),
        };
        await Promise.all([
          writeFile(feedbackRecordPath(f.job.scope, record.outTrackId), JSON.stringify(record)),
          writeFile(paths.receipt, JSON.stringify(receipt)),
          writeFile(paths.state, JSON.stringify(state)),
        ]);
      }
      const raw = {
        enabled: true,
        endpoint: f.config.endpoint,
        tenantId: f.config.tenantId,
        instanceId: f.config.instanceId,
        token: "test-only-token",
        idleMs: 1000,
      };
      const api: any = {
        config: {
          channels: {
            dingtalk: {
              clientId: "test",
              clientSecret: "test",
              feedbackEnabled: true,
              feedbackReporting: raw,
            },
          },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        runtime: {
          channel: {
            session: {
              resolveStorePath: (_s: any, p: any) =>
                p.agentId === "default" ? f.job.scope.storePath : f.job.transcriptStorePath,
            },
          },
        },
      };
      const service: any = new FeedbackReportingService(api, {
        startupDelayMs: 0,
        tickMs: 10,
        scanPauseMs: 0,
        workerUrl: pathToFileURL(path.resolve("dist/feedback-reporting-worker.js")),
      });
      services.push(service);
      service.start();
      await until(
        () => service.status().waiting === Math.min(count, 1024) && !service.status().scanning,
      );
      expect(service.status().queued).toBe(0);
      expect(bodies).toHaveLength(0);
      const scan = vi.spyOn(service, "scan");
      if (count === 128) {
        service.setForeground("prepare-due-backlog", true);
        for (const pending of service.retries.values()) pending.due = Date.now();
        while (service.retries.size) service.promoteRetry();
        expect(service.status().queued).toBe(128);
      }
      await registerFeedbackCard(f.job.scope, {
        outTrackId: "fresh",
        ownerUserId: "alice",
        agentId: "main",
        sessionKey: "agent:main:main",
        conversationId: "cid",
      });
      await completeFeedbackCard(
        f.job.scope,
        "fresh",
        "Answer",
        undefined,
        f.job.record.transcript,
      );
      await applyFeedback(
        f.job.scope,
        {
          outTrackId: "fresh",
          userId: "alice",
          eventId: "fresh-event",
          eventAt: Date.now(),
          vote: "like",
        },
        Date.now(),
        f.config,
      );
      if (count === 128) service.setForeground("prepare-due-backlog", false);
      await until(() => bodies.some((b) => b.cardId === "fresh"));
      expect(bodies.find((b) => b.cardId === "fresh").content).toMatchObject({
        status: "available",
        answer: "Answer",
      });
      expect(service.status().waiting).toBeLessThanOrEqual(1024);
      expect(bodies[0].cardId).toBe("fresh");
      await until(() => service.status().delivered >= 1);
      if (count === 128) return;
      const pending = service.retries.values().next().value;
      pending.due = Date.now();
      service.wake();
      await until(() => bodies.some((b) => b.cardId === pending.cardId));
      expect(scan).not.toHaveBeenCalled();
      expect(bodies.find((b) => b.cardId === pending.cardId).revision).toBe(2);
    },
    30000,
  );
});
