import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { FactoryQueueJob } from "@uzina/contracts/factory";
import type {
  ExecutionOperation,
  ExecutionReceipt,
} from "@uzina/contracts/execution";
import {
  ManagedPiWork,
  createManagedRemoteToolExecutor,
  type ManagedPiWorkOptions,
} from "@uzina/pi-runtime/work";

type DurableObjectSqliteStorage = Parameters<
  typeof openDurableObjectSqliteStorage
>[0];

type AlarmStorage = DurableObjectSqliteStorage & {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export interface ManagedWorkState {
  id: { name?: string };
  storage: AlarmStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  abort(reason?: string): void;
}

/** Supplied by the later Worker composition; no model or tool credential is embedded here. */
export type ManagedWorkRuntimeOptions = Omit<
  ManagedPiWorkOptions,
  "storage" | "onWake" | "beforeWork"
>;

export type ManagedWorkFactoryBridge = {
  getActiveManagedInput(
    threadId: string,
  ): FactoryQueueJob | undefined | Promise<FactoryQueueJob | undefined>;
  enqueueManagedRemoteExecution(
    threadId: string,
    taskId: string,
    callId: string,
    operation: ExecutionOperation,
  ): Promise<ExecutionReceipt>;
  getRemoteExecutionReceipt(
    jobId: string,
  ): ExecutionReceipt | null | Promise<ExecutionReceipt | null>;
  markManagedEffectUncertain(
    jobId: string,
    detail: string,
  ): void | Promise<void>;
};

export type ManagedWorkEnvironment = {
  runtimeOptions():
    ManagedWorkRuntimeOptions | Promise<ManagedWorkRuntimeOptions>;
  factory(): ManagedWorkFactoryBridge;
};

export type ManagedInputSettlement = {
  status: "completed" | "failed" | "uncertain";
  detail: string;
};

/** Cloudflare Durable Object adapter for one Pi Durable managed-work storage unit. */
export class ManagedWork {
  private work: ManagedPiWork | undefined;
  private opening: Promise<ManagedPiWork> | undefined;
  private readonly ready: Promise<void>;
  private closed = false;
  private alarmChain: Promise<void> = Promise.resolve();
  private operationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: ManagedWorkState,
    private readonly env: ManagedWorkEnvironment,
  ) {
    this.ready = state.blockConcurrencyWhile(async () => {
      await this.armFallbackBeforeRecovery();
      await this.openWork();
      await this.work?.resume();
    });
  }

  async create(): Promise<number> {
    return this.run(async (work) => work.create());
  }

  async submit(requestId: string, content: string) {
    return this.run(async (work) => work.submit(requestId, content));
  }

  async acceptManagedInput(
    input: FactoryQueueJob,
  ): Promise<ManagedInputSettlement> {
    if (input.threadId !== this.threadId) {
      throw new Error(
        "Managed input thread does not match its Durable Object identity",
      );
    }
    const persisted = await this.env
      .factory()
      .getActiveManagedInput(this.threadId);
    if (
      !persisted ||
      persisted.jobId !== input.jobId ||
      persisted.requestId !== input.requestId ||
      persisted.threadId !== input.threadId ||
      persisted.actor.kind !== input.actor.kind ||
      JSON.stringify(persisted.actor) !== JSON.stringify(input.actor) ||
      persisted.target.nodeId !== input.target.nodeId ||
      persisted.target.workspaceId !== input.target.workspaceId ||
      persisted.ownershipGeneration !== input.ownershipGeneration ||
      persisted.input.text !== input.input.text
    ) {
      throw new Error(
        "Managed input does not match accepted persisted Factory work",
      );
    }
    return this.run(async (work) => {
      await work.create();
      const accepted = await work.submit(input.requestId, input.input.text);
      if (accepted.status.status === "unanswered") {
        return {
          status: "failed",
          detail: `Managed Pi submission ended unanswered: ${accepted.status.reason}`,
        };
      }
      try {
        const settled = await work.waitForSubmission(input.requestId);
        return settled.status === "done"
          ? {
              status: "completed",
              detail: `Pi submission ${settled.id} settled with assistant entry ${settled.answer}`,
            }
          : {
              status: "failed",
              detail: `Managed Pi submission ended unanswered: ${settled.reason}`,
            };
      } catch (error) {
        return {
          status: "uncertain",
          detail:
            error instanceof Error
              ? `Managed Pi completion is uncertain: ${error.message}`
              : "Managed Pi completion is uncertain",
        };
      }
    });
  }

  async context() {
    return this.run(async (work) => work.context());
  }

  async status() {
    try {
      return await this.run(async (work) => work.status());
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Managed Pi work has not been created"
      ) {
        return { status: "not-created" };
      }
      throw error;
    }
  }

  async resume(): Promise<void> {
    await this.run(async (work) => work.resume());
  }

  async close(): Promise<void> {
    await this.ready;
    return this.enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      await this.queueAlarm(async () => this.state.storage.deleteAlarm());
      const work = this.work;
      this.work = undefined;
      this.opening = undefined;
      await work?.close(BACKGROUND_CONTEXT);
    });
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (this.closed) return;
    await this.run(async (work) => {
      await this.arm({ ...workWake(work), active: true });
      await work.resume();
    });
  }

  private run<T>(operation: (work: ManagedPiWork) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.ready;
      if (this.closed)
        throw new Error("Managed Pi work Durable Object is closed");
      const work = this.work ?? (await this.openWork());
      return operation(work);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private get threadId(): string {
    const threadId = this.state.id.name;
    if (!threadId)
      throw new Error("Managed Pi work requires a named thread Durable Object");
    return threadId;
  }

  private async openWork(): Promise<ManagedPiWork> {
    if (this.work) return this.work;
    if (this.opening) return this.opening;
    const storage = await openDurableObjectSqliteStorage(this.state.storage);
    const bridge = this.env.factory();
    const opening = Promise.resolve(this.env.runtimeOptions()).then((options) =>
      ManagedPiWork.open(
        {
          ...options,
          storage,
          toolExecutor: createManagedRemoteToolExecutor(this.threadId, {
            enqueue: (threadId, identity, operation) =>
              bridge.enqueueManagedRemoteExecution(
                threadId,
                identity.taskId,
                identity.callId,
                operation,
              ),
            receipt: (jobId) => bridge.getRemoteExecutionReceipt(jobId),
            markUncertain: (jobId, detail) =>
              bridge.markManagedEffectUncertain(jobId, detail),
          }),
          onWake: (wake) => {
            void this.arm(wake).catch(() =>
              this.state.abort("Could not arm managed-work recovery alarm"),
            );
          },
          beforeWork: (wake) => this.arm(wake),
        },
        BACKGROUND_CONTEXT,
      ),
    );
    this.opening = opening;
    try {
      this.work = await opening;
      return this.work;
    } catch (error) {
      this.opening = undefined;
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
      throw error;
    }
  }

  private async armFallbackBeforeRecovery(): Promise<void> {
    const fallback = Date.now() + 60_000;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > fallback) {
      await this.state.storage.setAlarm(fallback);
    }
  }

  private arm(wake: { active: boolean; at?: number }): Promise<void> {
    return this.queueAlarm(async () => {
      if (this.closed) return;
      const heartbeat = wake.active ? Date.now() + 60_000 : undefined;
      const at =
        heartbeat === undefined || wake.at === undefined
          ? (heartbeat ?? wake.at)
          : Math.min(heartbeat, wake.at);
      if (at === undefined) await this.state.storage.deleteAlarm();
      else await this.state.storage.setAlarm(at);
    });
  }

  private queueAlarm(operation: () => Promise<void>): Promise<void> {
    const result = this.alarmChain.then(operation);
    this.alarmChain = result.catch(() => {});
    return result;
  }
}

function workWake(work: ManagedPiWork): { active: boolean; at?: number } {
  return work.wake();
}

export type { Context };
