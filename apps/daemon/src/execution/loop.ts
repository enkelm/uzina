import { ControllerHttpError, isRetryableControllerFailure } from "./connector";
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
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function isCredentialRejection(error: unknown): boolean {
  return (
    error instanceof ControllerHttpError &&
    (error.status === 401 || error.status === 403)
  );
}

/** Node-owned poller: heartbeat and each workspace effect remain independently bounded. */
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
    const shutdown = new AbortController();
    const requestShutdown = () => shutdown.abort();
    signal.addEventListener("abort", requestShutdown, { once: true });
    if (signal.aborted) shutdown.abort();

    let registered = false;
    let credentialRejected = false;
    let heartbeatFailure: { error: unknown } | undefined;
    let heartbeatTask: Promise<void> | undefined;
    const rejectCredential = () => {
      credentialRejected = true;
      shutdown.abort();
    };

    try {
      while (!registered && !shutdown.signal.aborted) {
        try {
          await this.#controller.register(this.#daemon.registerRequest());
          if (shutdown.signal.aborted) break;
          await this.#controller.heartbeat(this.#daemon.heartbeatRequest());
          registered = true;
        } catch (error) {
          if (isCredentialRejection(error)) {
            rejectCredential();
            break;
          }
          if (!isRetryableControllerFailure(error)) throw error;
          await wait(this.#pollIntervalMs, shutdown.signal);
        }
      }

      if (registered && !shutdown.signal.aborted) {
        heartbeatTask = this.#runHeartbeats(shutdown.signal).catch((error) => {
          if (isCredentialRejection(error)) rejectCredential();
          else {
            heartbeatFailure = { error };
            shutdown.abort();
          }
        });
      }

      while (!shutdown.signal.aborted) {
        try {
          for (const report of this.#daemon.pendingReports()) {
            if (shutdown.signal.aborted) break;
            await this.#controller.report(report);
            this.#daemon.markReported(report.jobId, report.status);
          }

          for (const report of this.#daemon.pendingCaptureControlReports()) {
            if (shutdown.signal.aborted) break;
            await this.#controller.reportCaptureControl(report);
            this.#daemon.markCaptureControlReported(report.controlId, report);
          }

          if (shutdown.signal.aborted) break;
          const captureControl = await this.#controller.claimCaptureControl();
          if (shutdown.signal.aborted) break;
          if (captureControl) {
            const report = this.#daemon.executeCaptureControl(captureControl);
            if (!credentialRejected) {
              await this.#controller.reportCaptureControl(report);
              this.#daemon.markCaptureControlReported(report.controlId, report);
            }
          } else {
            const job = await this.#controller.claim();
            if (shutdown.signal.aborted) break;
            if (job) {
              const receipt = await this.#daemon.executeJob(job);
              if (
                !credentialRejected &&
                ["completed", "failed", "uncertain"].includes(receipt.status)
              ) {
                const report = this.#daemon.reportFor(job.jobId);
                await this.#controller.report(report);
                this.#daemon.markReported(job.jobId, report.status);
              }
            }
          }
        } catch (error) {
          if (isCredentialRejection(error)) {
            rejectCredential();
            break;
          }
          if (!isRetryableControllerFailure(error)) throw error;
          // Preserve durable receipts while retrying transient controller failures.
        }
        await wait(this.#pollIntervalMs, shutdown.signal);
      }
    } finally {
      shutdown.abort();
      signal.removeEventListener("abort", requestShutdown);
      if (heartbeatTask) await heartbeatTask;
      this.#running = false;
    }

    if (credentialRejected) {
      throw new Error(
        "Controller rejected the configured node identity or credential",
      );
    }
    if (heartbeatFailure) throw heartbeatFailure.error;
  }

  async #runHeartbeats(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await wait(this.#heartbeatIntervalMs, signal);
      if (signal.aborted) return;
      try {
        await this.#controller.heartbeat(this.#daemon.heartbeatRequest());
      } catch (error) {
        if (isCredentialRejection(error)) throw error;
        if (!isRetryableControllerFailure(error)) throw error;
      }
    }
  }
}
