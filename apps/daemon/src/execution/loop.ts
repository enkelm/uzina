import { ControllerHttpError } from "./connector";
import type { ExecutionControllerConnector } from "./connector";
import type { ExecutionDaemon } from "./daemon";

export interface ExecutionLoopOptions {
  daemon: ExecutionDaemon;
  controller: ExecutionControllerConnector;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

const MAX_LOOP_INTERVAL_MS = 30_000;

function interval(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (
    !Number.isSafeInteger(result) ||
    result < 10 ||
    result > MAX_LOOP_INTERVAL_MS
  ) {
    throw new TypeError(
      `Loop intervals must be between 10 and ${MAX_LOOP_INTERVAL_MS}ms`,
    );
  }
  return result;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Node-owned poller: each HTTP operation and workspace effect is bounded independently of browser lifetime. */
export class ExecutionLoop {
  readonly #daemon: ExecutionDaemon;
  readonly #controller: ExecutionControllerConnector;
  readonly #pollIntervalMs: number;
  readonly #heartbeatIntervalMs: number;
  #running = false;

  constructor(options: ExecutionLoopOptions) {
    this.#daemon = options.daemon;
    this.#controller = options.controller;
    this.#pollIntervalMs = interval(options.pollIntervalMs, 1_000);
    this.#heartbeatIntervalMs = interval(options.heartbeatIntervalMs, 20_000);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) throw new Error("Execution loop is already running");
    this.#running = true;
    let registered = false;
    let nextHeartbeat = 0;
    try {
      while (!signal.aborted) {
        try {
          if (!registered) {
            await this.#controller.register(this.#daemon.registerRequest());
            registered = true;
            nextHeartbeat = Date.now();
          }
          if (Date.now() >= nextHeartbeat) {
            await this.#controller.heartbeat(this.#daemon.heartbeatRequest());
            nextHeartbeat = Date.now() + this.#heartbeatIntervalMs;
          }

          for (const report of this.#daemon.pendingReports()) {
            await this.#controller.report(report);
            this.#daemon.markReported(report.jobId, report.status);
          }

          if (!signal.aborted) {
            const job = await this.#controller.claim();
            if (job) {
              const receipt = await this.#daemon.executeJob(job);
              if (
                ["completed", "failed", "uncertain"].includes(receipt.status)
              ) {
                const report = this.#daemon.reportFor(job.jobId);
                await this.#controller.report(report);
                this.#daemon.markReported(job.jobId, report.status);
              }
            }
          }
        } catch (error) {
          if (
            error instanceof ControllerHttpError &&
            (error.status === 401 || error.status === 403)
          ) {
            throw new Error(
              "Controller rejected the configured node identity or credential",
            );
          }
          // Keep the durable receipt untouched; reconnect and reconcile it on a later bounded cycle.
        }
        await wait(this.#pollIntervalMs, signal);
      }
    } finally {
      this.#running = false;
    }
  }
}
