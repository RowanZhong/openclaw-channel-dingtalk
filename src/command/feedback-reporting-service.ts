import { opendir, unlink, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getConfig, listDingTalkAccountIds } from "../config";
import { resolveNamespacePath } from "../persistence-store";
import { resolveSecretInputString } from "../secret-input";
import { cancelFeedbackDetailReads } from "./feedback-detail-reader";
import {
  resolveFeedbackReporting,
  type ResolvedFeedbackReporting,
} from "./feedback-reporting-config";
import {
  onFeedbackReportPending,
  onFeedbackForegroundActivity,
  onFeedbackBackgroundStop,
} from "./feedback-reporting-events";
import { readSmallJson, reportPaths, writeReportJson } from "./feedback-reporting-io";
import {
  REPORT_MAINTENANCE_VERSION,
  type ReportJob,
  type ReportMaintenanceJob,
  type ReportWorkerJob,
  type ReportReceipt,
  type ReportResult,
} from "./feedback-reporting-protocol";
import { FeedbackReportWorkerHost, FeedbackWorkerDeferred } from "./feedback-reporting-worker-host";
import type { FeedbackRecord, FeedbackScope } from "./feedback-store";

type Account = { scope: FeedbackScope; config: ResolvedFeedbackReporting };
type Pending = {
  account: Account;
  cardId: string;
  due: number;
  failures: number;
  generation: number;
  fresh?: boolean;
  maintenance?: ReportMaintenanceJob["maintenance"];
};
const MAX_QUEUE = 128;
const MAX_RETRIES = 1024;
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
const queueKey = (account: Account, id: string) =>
  JSON.stringify([
    account.scope.storePath,
    account.scope.accountId,
    account.config.destinationKey,
    id,
  ]);

export class FeedbackReportingService {
  private readonly queue = new Map<string, Pending>();
  private readonly retries = new Map<string, Pending>();
  private activeKey?: string;
  private readonly workerHost: FeedbackReportWorkerHost;
  private unsubscribeBackground?: () => void;
  private readonly activeRuns = new Set<string>();
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private timer?: NodeJS.Timeout;
  private timerAt = 0;
  private ticking = false;
  private stopped = true;
  private processing = false;
  private scanning = false;
  private needsScan = true;
  private scanAt = 0;
  private quietAfter = 0;
  private unsubscribe?: () => void;
  private unsubscribeAgent?: () => void;
  private unsubscribeActivity?: () => void;
  private readonly accounts: Account[];
  private readonly tokens = new Map<string, { value: string; until: number }>();
  private pressureAt = 0;
  private throttled = 0;
  private pressureInitialized = false;
  private counters = { delivered: 0, superseded: 0, deferred: 0, failures: 0, workersStarted: 0 };

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly options: {
      startupDelayMs?: number;
      tickMs?: number;
      scanPauseMs?: number;
      taskTimeoutMs?: number;
      workerUrl?: URL;
      now?: () => number;
    } = {},
  ) {
    this.workerHost = new FeedbackReportWorkerHost({
      url: options.workerUrl,
      timeoutMs: options.taskTimeoutMs,
      allowed: () => !this.busy(),
    });
    this.accounts = (
      listDingTalkAccountIds(api.config).length ? listDingTalkAccountIds(api.config) : ["default"]
    ).flatMap((accountId) => {
      try {
        const channel = getConfig(api.config, accountId);
        if (!channel.feedbackEnabled || channel.enabled === false) {
          return [];
        }
        const config = resolveFeedbackReporting(channel.feedbackReporting);
        return config
          ? [
              {
                config,
                scope: {
                  accountId,
                  storePath: api.runtime.channel.session.resolveStorePath(
                    api.config.session?.store,
                    { agentId: accountId },
                  ),
                },
              },
            ]
          : [];
      } catch {
        api.logger.warn(
          `[DingTalk][FeedbackReport] account=${accountId} reporting configuration unavailable; channel remains enabled`,
        );
        return [];
      }
    });
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  start(): void {
    if (!this.stopped || !this.accounts.length) {
      return;
    }
    this.stopped = false;
    this.scanAt = this.now() + (this.options.startupDelayMs ?? 30_000 + Math.random() * 60_000);
    this.quietAfter = this.now() + Math.max(...this.accounts.map((a) => a.config.idleMs));
    this.unsubscribe = onFeedbackReportPending((scope, cardId) => {
      const account = this.accounts.find(
        (a) => a.scope.accountId === scope.accountId && a.scope.storePath === scope.storePath,
      );
      if (account) {
        this.enqueue(account, cardId, this.now() + account.config.idleMs);
      }
    });
    this.unsubscribeBackground = onFeedbackBackgroundStop(() => this.workerHost.stop());
    this.unsubscribeActivity = onFeedbackForegroundActivity((id, active) =>
      this.setForeground(id, active),
    );
    this.unsubscribeAgent = this.api.runtime.events?.onAgentEvent?.((event) => {
      if (event.stream !== "lifecycle") {
        return;
      }
      if (event.data.phase === "start") {
        this.setForeground(event.runId, true);
      } else if (["end", "error", "aborted"].includes(String(event.data.phase))) {
        this.setForeground(event.runId, false);
      }
    });
    this.schedule();
  }
  /** Public for deterministic resource/foreground acceptance probes. No transcript data. */
  setForeground(runId: string, active: boolean): void {
    if (active && this.activeRuns.size < 1024) {
      this.activeRuns.add(runId);
    } else if (!active) {
      this.activeRuns.delete(runId);
    }
    this.quietAfter = this.now() + Math.max(...this.accounts.map((a) => a.config.idleMs), 1000);
    if (active) {
      void this.workerHost.stop();
    }
    if (active) {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = undefined;
      this.lag.disable();
    } else {
      this.wake();
    }
  }
  status() {
    return {
      ...this.counters,
      queued: this.queue.size,
      waiting: this.retries.size,
      workersStarted: this.workerHost.started,
      scanning: this.scanning,
      workerActive: this.workerHost.running,
      workerResident: this.workerHost.resident,
      foregroundRuns: this.activeRuns.size,
      timerScheduled: Boolean(this.timer),
    };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.unsubscribe?.();
    this.unsubscribeAgent?.();
    this.unsubscribeActivity?.();
    this.unsubscribeBackground?.();
    this.lag.disable();
    await this.workerHost.stop();
    this.tokens.clear();
    this.queue.clear();
    this.retries.clear();
  }
  private wake(): void {
    const tick = this.options.tickMs ?? 1000;
    if (this.timer && this.timerAt > this.now() + tick) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped || this.timer || this.ticking || this.activeRuns.size) {
      return;
    }
    if (!this.queue.size && !this.retries.size && !this.needsScan && !this.scanning) {
      this.lag.disable();
      return;
    }
    const tick = this.options.tickMs ?? 1000;
    let delay = tick;
    if (!this.processing) {
      const earliest = this.scanning
        ? this.now()
        : Math.min(
            this.needsScan ? this.scanAt : Infinity,
            ...[...this.queue.values()].map((p) => p.due),
            ...[...this.retries.values()].map((p) => p.due),
          );
      delay = Math.max(tick, Math.min(60000, Math.max(earliest, this.quietAfter) - this.now()));
    }
    if (delay > tick) {
      this.lag.disable();
    } else {
      this.lag.enable();
    }
    this.timerAt = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ticking = true;
      void this.tick()
        .catch(() =>
          this.api.logger.warn("[DingTalk][FeedbackReport] scheduler deferred after local failure"),
        )
        .finally(() => {
          this.ticking = false;
          this.schedule();
        });
    }, delay);
    this.timer.unref();
  }
  private busy(): boolean {
    return this.stopped || this.activeRuns.size > 0 || this.now() < this.quietAfter;
  }
  private requestRecovery(due: number): void {
    const at = Math.max(this.now() + 60_000, due);
    this.scanAt = this.needsScan ? Math.min(this.scanAt, at) : at;
    this.needsScan = true;
  }
  private waitForRetry(key: string, pending: Pending): void {
    this.queue.delete(key);
    if (!this.retries.has(key) && this.retries.size >= MAX_RETRIES) {
      let latest: [string, Pending] | undefined;
      for (const entry of this.retries) {
        if (!latest || entry[1].due > latest[1].due) {
          latest = entry;
        }
      }
      if (latest && pending.due < latest[1].due) {
        this.retries.delete(latest[0]);
        this.requestRecovery(latest[1].due);
      } else {
        this.requestRecovery(pending.due);
        return;
      }
    }
    this.retries.set(key, pending);
  }
  private enqueue(account: Account, cardId: string, due: number, hint = true): void {
    const key = queueKey(account, cardId);
    const old = this.queue.get(key) ?? this.retries.get(key);
    const pending = old ?? { account, cardId, due, failures: 0, generation: 0, fresh: hint };
    if (old) {
      if (hint) {
        pending.generation++;
        pending.fresh = true;
      }
      pending.due = Math.min(pending.due, due);
      if (this.queue.has(key)) {
        this.wake();
        return;
      }
    }
    // Fresh events can displace one non-running backlog entry; both stay durable.
    if (hint && this.queue.size >= MAX_QUEUE) {
      const displaced = [...this.queue.entries()].toReversed().find(([k]) => k !== this.activeKey);
      if (displaced) {
        this.waitForRetry(displaced[0], displaced[1]);
      }
    }
    if ((hint || pending.due <= this.now()) && this.queue.size < MAX_QUEUE) {
      this.retries.delete(key);
      this.queue.set(key, pending);
    } else {
      this.waitForRetry(key, pending);
    }
    this.wake();
  }
  private promoteRetry(): void {
    if (this.queue.size >= MAX_QUEUE) {
      return;
    }
    let earliest: [string, Pending] | undefined;
    for (const entry of this.retries) {
      if (entry[1].due <= this.now() && (!earliest || entry[1].due < earliest[1].due)) {
        earliest = entry;
      }
    }
    if (earliest) {
      this.retries.delete(earliest[0]);
      this.queue.set(earliest[0], earliest[1]);
    }
  }
  private defer(key: string, pending: Pending, due: number, generation: number): void {
    if (this.stopped) {
      return;
    }
    if (pending.generation !== generation) {
      pending.due = Math.min(pending.due, this.now() + pending.account.config.idleMs);
    } else {
      pending.due = due;
      pending.fresh = false;
      this.waitForRetry(key, pending);
    }
    this.wake();
  }
  private async persistDeferral(
    pending: Pending,
    record: FeedbackRecord,
    due: number,
  ): Promise<void> {
    const paths = reportPaths(
      pending.account.scope,
      pending.cardId,
      pending.account.config.destinationKey,
    );
    const old = await readSmallJson<ReportReceipt>(paths.receipt, 4096).catch(() => undefined);
    await writeReportJson(paths.receipt, {
      ...old,
      sourceRevision: record.reporting!.revision,
      wireRevision: old?.wireRevision ?? 0,
      terminal: false,
      nextAttemptAt: due,
      expiresAt: Math.max(record.expiresAt, record.reporting!.retainUntil),
      attempts: pending.failures,
      error: "local_worker_deferred",
    } satisfies ReportReceipt);
  }
  private enqueueMaintenance(account: Account, state: string, receipt: string): void {
    const id = `maintenance:${path.basename(state)}`;
    const key = queueKey(account, id);
    if (this.queue.has(key) || this.retries.has(key)) {
      return;
    }
    const pending: Pending = {
      account,
      cardId: id,
      due: this.now(),
      generation: 0,
      failures: 0,
      maintenance: { state, receipt, accountId: account.scope.accountId },
    };
    if (this.queue.size < MAX_QUEUE) {
      this.queue.set(key, pending);
    } else {
      this.waitForRetry(key, pending);
    }
    this.wake();
  }
  private async systemPressure(): Promise<boolean> {
    if (this.now() < this.pressureAt) {
      return false;
    }
    this.pressureAt = this.now() + 5000;
    if (process.platform !== "linux") {
      return process.memoryUsage().rss > 1024 * 1024 * 1024;
    }
    try {
      // Sequential tiny reads leave the shared libuv pool available to foreground I/O.
      const current = await readFile("/sys/fs/cgroup/memory.current", "utf8");
      const maximum = await readFile("/sys/fs/cgroup/memory.max", "utf8");
      const cpu = await readFile("/sys/fs/cgroup/cpu.stat", "utf8");
      const pressure = await readFile("/sys/fs/cgroup/cpu.pressure", "utf8").catch(() => "");
      const capped = maximum.trim() !== "max" && Number(current) > Number(maximum) * 0.8;
      const throttled = Number(/nr_throttled\s+(\d+)/.exec(cpu)?.[1] ?? 0);
      const changed = this.pressureInitialized && throttled > this.throttled;
      this.pressureInitialized = true;
      this.throttled = throttled;
      const waiting = Number(/some avg10=([0-9.]+)/.exec(pressure)?.[1] ?? 0) > 10;
      return capped || changed || waiting;
    } catch {
      return process.memoryUsage().rss > 1024 * 1024 * 1024;
    }
  }
  private accountStillEnabled(account: Account): boolean {
    try {
      const current = (this.api.runtime.config?.current?.() ?? this.api.config) as OpenClawConfig;
      const channel = getConfig(current, account.scope.accountId);
      const reporting = resolveFeedbackReporting(channel.feedbackReporting);
      return (
        channel.enabled !== false &&
        Boolean(channel.feedbackEnabled) &&
        reporting?.destinationKey === account.config.destinationKey
      );
    } catch {
      return false;
    }
  }
  private async tick(): Promise<void> {
    if (
      this.stopped ||
      this.activeRuns.size ||
      (!this.processing && this.now() < this.quietAfter)
    ) {
      this.lag.reset();
      return;
    }
    if (!this.accounts.some((account) => this.accountStillEnabled(account))) {
      await this.stop();
      return;
    }
    const stalled = this.lag.max / 1e6 > 50;
    this.lag.reset();
    const memoryHigh = await this.systemPressure();
    if (stalled || memoryHigh) {
      this.quietAfter = this.now() + 5000;
      void this.workerHost.stop();
    }
    if (this.busy()) {
      return;
    }
    if (this.needsScan && !this.scanning && this.now() >= this.scanAt) {
      this.needsScan = false;
      void this.scan().catch(() => {
        this.needsScan = true;
        this.scanAt = this.now() + 60_000;
        this.wake();
      });
    }
    if (this.processing) {
      return;
    }
    this.promoteRetry();
    const ready = [...this.queue.entries()];
    const candidate =
      ready.find(([, p]) => p.fresh && p.due <= this.now()) ??
      ready.find(([, p]) => p.due <= this.now());
    if (!candidate) {
      return;
    }
    this.processing = true;
    this.activeKey = candidate[0];
    const generation = candidate[1].generation;
    // Do not await the worker in the timer: pressure monitoring must continue
    // while it is reading or waiting for a receiver.
    void this.process(candidate[0], candidate[1])
      .catch(() => {
        this.defer(candidate[0], candidate[1], this.now() + 300_000, generation);
        this.api.logger.warn("[DingTalk][FeedbackReport] job deferred after local failure");
      })
      .finally(() => {
        this.processing = false;
        this.activeKey = undefined;
        this.wake();
      });
  }
  private async scan(): Promise<void> {
    this.scanning = true;
    try {
      for (const account of this.accounts) {
        const base = resolveNamespacePath("feedback.ratings", {
          storePath: account.scope.storePath,
          scope: { accountId: account.scope.accountId },
        });
        const directory = path.dirname(base);
        const prefix = `${path.basename(base, ".json")}.target-`;
        const reportPrefix = `${path.basename(resolveNamespacePath("feedback.report", { storePath: account.scope.storePath, scope: { accountId: account.scope.accountId } }), ".json")}.target-`;
        let dir;
        try {
          dir = await opendir(directory);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw e;
        }
        for await (const entry of dir) {
          if (this.stopped) {
            break;
          }
          while (!this.stopped && this.busy()) {
            await pause(250);
          }
          if (this.stopped) {
            break;
          }
          if (entry.name.startsWith(prefix) && entry.name.endsWith(".json")) {
            try {
              const record = await readSmallJson<FeedbackRecord>(path.join(directory, entry.name));
              if (
                record?.reporting?.destinationKey === account.config.destinationKey &&
                Math.max(record.expiresAt, record.reporting.retainUntil) > this.now()
              ) {
                const receipt = await readSmallJson<ReportReceipt>(
                  reportPaths(account.scope, record.outTrackId, account.config.destinationKey)
                    .receipt,
                  4096,
                );
                const changed = receipt?.sourceRevision !== record.reporting.revision;
                const maintenance = receipt?.maintenanceVersion !== REPORT_MAINTENANCE_VERSION;
                if (!receipt?.terminal || changed || maintenance) {
                  this.enqueue(
                    account,
                    record.outTrackId,
                    changed || receipt?.terminal
                      ? this.now()
                      : receipt?.nextAttemptAt || this.now(),
                    false,
                  );
                }
              }
            } catch {
              this.api.logger.warn(
                "[DingTalk][FeedbackReport] unreadable or oversized rating metadata skipped",
              );
            }
          } else if (
            entry.name.startsWith(reportPrefix) &&
            entry.name.endsWith(".json") &&
            !entry.name.endsWith(".receipt.json")
          ) {
            // The state write may have survived a crash before the receipt write.
            // Inspect the small receipt here; any body-bearing state stays in the worker.
            const state = path.join(directory, entry.name);
            const receiptPath = state.replace(/\.json$/, ".receipt.json");
            const receipt = await readSmallJson<ReportReceipt>(receiptPath, 4096).catch(
              () => undefined,
            );
            if (receipt?.maintenanceVersion !== REPORT_MAINTENANCE_VERSION) {
              this.enqueueMaintenance(account, state, receiptPath);
            }
          } else if (entry.name.startsWith("feedback.report.") && entry.name.endsWith(".tmp")) {
            const file = path.join(directory, entry.name);
            const info = await stat(file).catch(() => undefined);
            if (info && info.mtimeMs < this.now() - 86400000) {
              await unlink(file).catch(() => undefined);
            }
          } else if (entry.name.startsWith(reportPrefix) && entry.name.endsWith(".receipt.json")) {
            const file = path.join(directory, entry.name);
            const receipt = await readSmallJson<ReportReceipt>(file, 4096).catch(() => undefined);
            if (
              receipt?.terminal &&
              receipt.superseded &&
              receipt.maintenanceVersion !== REPORT_MAINTENANCE_VERSION &&
              receipt.expiresAt >= this.now()
            ) {
              this.enqueueMaintenance(account, file.replace(/\.receipt\.json$/, ".json"), file);
            }
            if (receipt && receipt.expiresAt < this.now()) {
              await unlink(file.replace(/\.receipt\.json$/, ".json")).catch(() => undefined);
              await unlink(file).catch(() => undefined);
            }
          }
          await pause(this.options.scanPauseMs ?? 100);
        }
      }
    } finally {
      this.scanning = false;
      if (!this.stopped) {
        this.api.logger.info(
          `[DingTalk][FeedbackReport] recovery ready=${this.queue.size} waiting=${this.retries.size} overflow=${this.needsScan}`,
        );
      }
      // No repeating whole-directory polling. New votes provide hints; overflow or
      // restart causes bounded recovery. A later restart also reclaims expired outboxes.
    }
  }
  private async process(key: string, pending: Pending): Promise<void> {
    const { account, cardId } = pending;
    const generation = pending.generation;
    if (!this.accountStillEnabled(account)) {
      this.queue.delete(key);
      return;
    }
    if (pending.maintenance) {
      if (this.busy()) {
        return;
      }
      try {
        const result = await this.runWorker({
          maintenance: pending.maintenance,
          config: { workerMemoryMb: account.config.workerMemoryMb },
        });
        if (result.kind === "maintenance_done") {
          this.queue.delete(key);
        } else {
          this.defer(key, pending, this.now() + 300_000, generation);
        }
      } catch (error) {
        this.defer(
          key,
          pending,
          this.now() + (error instanceof FeedbackWorkerDeferred ? account.config.idleMs : 300_000),
          generation,
        );
      }
      return;
    }
    const { feedbackRecordPath } = await import("./feedback-store");
    let record: FeedbackRecord | undefined;
    try {
      record = await readSmallJson<FeedbackRecord>(feedbackRecordPath(account.scope, cardId));
    } catch {
      this.defer(key, pending, this.now() + 300_000, generation);
      return;
    }
    if (
      !record?.reporting ||
      record.accountId !== account.scope.accountId ||
      record.outTrackId !== cardId ||
      record.reporting.destinationKey !== account.config.destinationKey ||
      Math.max(record.expiresAt, record.reporting.retainUntil) <= this.now()
    ) {
      this.queue.delete(key);
      return;
    }
    if (this.busy()) {
      return;
    }
    const tokenKey = `${account.scope.accountId}:${account.config.destinationKey}`;
    let token =
      this.tokens.get(tokenKey)?.until && this.tokens.get(tokenKey)!.until > this.now()
        ? this.tokens.get(tokenKey)!.value
        : undefined;
    if (!token) {
      token = await resolveSecretInputString(account.config.token, undefined, this.api.config);
      if (!token) {
        const due = this.now() + 300_000;
        await this.persistDeferral(pending, record, due);
        this.defer(key, pending, due, generation);
        this.api.logger.warn("[DingTalk][FeedbackReport] authentication configuration unavailable");
        return;
      }
      this.tokens.set(tokenKey, { value: token, until: this.now() + 600_000 });
    }
    if (this.busy()) {
      return;
    }
    const { history: _history, seen: _seen, ...projection } = record;
    const { token: _token, ...config } = account.config;
    const job: ReportJob = {
      scope: account.scope,
      record: projection,
      config,
      token,
      transcriptStorePath: this.api.runtime.channel.session.resolveStorePath(
        this.api.config.session?.store,
        { agentId: record.agentId },
      ),
      metadataOnly: pending.failures >= 2,
    };
    let result: ReportResult;
    try {
      result = await this.runWorker(job);
    } catch (error) {
      if (error instanceof FeedbackWorkerDeferred || this.busy()) {
        this.counters.deferred++;
        this.defer(key, pending, this.now() + config.idleMs, generation);
        return;
      }
      pending.failures++;
      this.counters.failures++;
      const due = this.now() + Math.min(300_000, 5000 * 2 ** Math.min(pending.failures, 6));
      await this.persistDeferral(pending, record, due);
      this.defer(key, pending, due, generation);
      this.api.logger.warn(
        "[DingTalk][FeedbackReport] bounded worker failed; durable record retained for retry",
      );
      return;
    }
    if (result.kind !== "done") {
      pending.failures++;
      const due = this.now() + 300_000;
      await this.persistDeferral(pending, record, due);
      this.defer(key, pending, due, generation);
      this.counters.failures++;
      return;
    }
    pending.failures = 0;
    const latest = await readSmallJson<FeedbackRecord>(feedbackRecordPath(account.scope, cardId));
    if (
      pending.generation !== generation ||
      latest?.reporting?.revision !== result.receipt.sourceRevision
    ) {
      pending.due = this.now() + config.idleMs;
      return;
    }
    if (result.receipt.terminal) {
      this.queue.delete(key);
      if (result.receipt.superseded) {
        this.counters.superseded++;
      } else {
        this.counters.delivered++;
      }
      this.api.logger.info(
        `[DingTalk][FeedbackReport] ${result.receipt.superseded ? "superseded" : "saved"} card=${cardId} revision=${result.receipt.wireRevision}`,
      );
    } else {
      this.defer(key, pending, result.receipt.nextAttemptAt || this.now() + 300_000, generation);
      if (result.receipt.error) {
        this.counters.failures++;
        this.tokens.delete(tokenKey);
      } else {
        this.counters.deferred++;
      }
      this.api.logger.info(
        `[DingTalk][FeedbackReport] pending card=${cardId} reason=${result.receipt.error ?? "content_deferred"}`,
      );
    }
  }
  private async runWorker(job: ReportWorkerJob): Promise<ReportResult> {
    return this.workerHost.run(job);
  }
}

export function registerFeedbackReporting(api: OpenClawPluginApi): void {
  if (typeof api.registerService !== "function") {
    return;
  }
  let service: FeedbackReportingService | undefined;
  api.registerService({
    id: "dingtalk-feedback-reporting",
    start: () => {
      service = new FeedbackReportingService(api);
      service.start();
    },
    stop: async () => {
      await cancelFeedbackDetailReads();
      await service?.stop();
      service = undefined;
    },
  });
}
