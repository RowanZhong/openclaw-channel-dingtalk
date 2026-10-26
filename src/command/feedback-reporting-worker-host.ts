import { Worker } from "node:worker_threads";
import type { ReportWorkerJob, ReportResult } from "./feedback-reporting-protocol";

export class FeedbackWorkerDeferred extends Error {
  constructor() {
    super("feedback_worker_deferred");
  }
}
/** One short-lived worker, with normal budget transitions and explicit cancellation. */
export class FeedbackReportWorkerHost {
  private worker?: Worker;
  private requestedMemory?: number;
  private idle?: NodeJS.Timeout;
  private terminating?: Promise<void>;
  private epoch = 0;
  private active = false;
  started = 0;
  constructor(
    private readonly options: {
      url?: URL;
      timeoutMs?: number;
      allowed: () => boolean;
    },
  ) {}
  get resident() {
    return Boolean(this.worker);
  }
  get running() {
    return this.active;
  }
  async stop(): Promise<void> {
    this.epoch++;
    await this.terminate();
  }
  private async terminate(): Promise<void> {
    if (this.idle) {
      clearTimeout(this.idle);
    }
    this.idle = undefined;
    const previous = this.terminating;
    const worker = this.worker;
    if (!worker) {
      if (previous) {
        await previous;
      }
      return;
    }
    this.worker = undefined;
    this.requestedMemory = undefined;
    const pending = Promise.all([previous, worker.terminate()]).then(() => {});
    this.terminating = pending;
    try {
      await pending;
    } finally {
      if (this.terminating === pending) {
        this.terminating = undefined;
      }
    }
  }
  async run(job: ReportWorkerJob): Promise<ReportResult> {
    const epoch = this.epoch;
    if (this.idle) {
      clearTimeout(this.idle);
    }
    if (this.terminating) {
      await this.terminating;
    }
    if (this.worker && this.requestedMemory !== job.config.workerMemoryMb) {
      await this.terminate();
    }
    // Foreground work or stop may arrive during termination. It must win the race.
    if (epoch !== this.epoch || !this.options.allowed()) {
      throw new FeedbackWorkerDeferred();
    }
    if (!this.worker) {
      const worker = new Worker(
        this.options.url ?? new URL("./feedback-reporting-worker.js", import.meta.url),
        {
          workerData: { kind: "dingtalk-feedback-report" },
          execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: job.config.workerMemoryMb,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        },
      );
      this.worker = worker;
      this.requestedMemory = job.config.workerMemoryMb;
      this.started++;
      worker.on("error", () => {});
      worker.once("exit", () => {
        if (this.worker === worker) {
          this.worker = undefined;
          this.requestedMemory = undefined;
        }
      });
    }
    const worker = this.worker;
    if ((worker.resourceLimits?.maxOldGenerationSizeMb ?? Infinity) > job.config.workerMemoryMb) {
      await this.terminate();
      throw new Error("worker_heap_budget_overridden");
    }
    this.active = true;
    try {
      return await new Promise<ReportResult>((resolve, reject) => {
        const deadline = setTimeout(() => {
          finish();
          reject(new Error("worker_budget"));
        }, this.options.timeoutMs ?? 20_000);
        const finish = () => {
          clearTimeout(deadline);
          worker.off("message", message);
          worker.off("error", error);
          worker.off("exit", exit);
        };
        const message = (result: ReportResult) => {
          finish();
          resolve(result);
        };
        const error = (failure: Error) => {
          finish();
          reject(failure);
        };
        const exit = () => {
          finish();
          reject(new Error("worker_stopped"));
        };
        worker.once("message", message);
        worker.once("error", error);
        worker.once("exit", exit);
        worker.postMessage({ kind: "job", job });
      });
    } catch (error) {
      await this.terminate();
      if (epoch !== this.epoch || !this.options.allowed()) {
        throw new FeedbackWorkerDeferred();
      }
      throw error;
    } finally {
      this.active = false;
      if (!this.options.allowed()) {
        await this.terminate();
      } else if (this.worker === worker) {
        this.idle = setTimeout(() => {
          if (this.worker === worker && !this.active) {
            void this.terminate();
          }
        }, 5000);
        this.idle.unref();
      }
    }
  }
}
