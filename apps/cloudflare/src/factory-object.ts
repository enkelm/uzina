import { FactoryService } from "@uzina/core";
import { createFactoryHttpHandler } from "@uzina/core/http";
import type { FactoryDatabase, SqlRow, SqlValue } from "@uzina/core/database";
import type { FactoryQueueJob } from "@uzina/contracts/factory";
import type { ManagedInputSettlement } from "./work-object";

export const FACTORY_DURABLE_OBJECT_NAME = "uzina-single-factory";

interface DurableSqlCursor<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends Iterable<T> {
  toArray(): T[];
}

interface DurableSqlStorage {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...values: SqlValue[]
  ): DurableSqlCursor<T>;
}

interface DurableObjectSqliteStorage {
  sql: DurableSqlStorage;
  transactionSync<T>(operation: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface FactoryDurableObjectState {
  storage: DurableObjectSqliteStorage;
  waitUntil(promise: Promise<unknown>): void;
}

export type ManagedWorkNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    acceptManagedInput(input: FactoryQueueJob): Promise<ManagedInputSettlement>;
    context(): Promise<unknown>;
    status(): Promise<unknown>;
  };
};

export interface FactoryRpc {
  getActiveManagedInput(threadId: string): FactoryQueueJob | undefined;
  enqueueManagedRemoteExecution(
    threadId: string,
    taskId: string,
    callId: string,
    operation: Parameters<FactoryService["enqueueManagedRemoteExecution"]>[3],
  ): Promise<import("@uzina/contracts/execution").ExecutionReceipt>;
  getRemoteExecutionReceipt(
    jobId: string,
  ): import("@uzina/contracts/execution").ExecutionReceipt | null;
  markManagedEffectUncertain(jobId: string, detail: string): void;
  fetch(request: Request): Promise<Response>;
}

export interface FactoryDurableObjectEnvironment {
  UZINA_BOOTSTRAP_SECRET?: string;
  UZINA_MODEL_PROVIDER?: string;
  UZINA_MODEL_ID?: string;
  UZINA_MODEL_API_KEY?: string;
  FACTORY: {
    idFromName(name: string): unknown;
    get(id: unknown): FactoryRpc;
  };
  MANAGED_WORK: ManagedWorkNamespace;
}

class DurableObjectFactoryDatabase implements FactoryDatabase {
  constructor(private readonly storage: DurableObjectSqliteStorage) {}

  exec(query: string, values: readonly SqlValue[] = []): void {
    this.storage.sql.exec(query, ...values);
  }

  all<T extends SqlRow = SqlRow>(
    query: string,
    values: readonly SqlValue[] = [],
  ): T[] {
    return this.storage.sql.exec<T>(query, ...values).toArray();
  }

  transaction<T>(operation: () => T): T {
    return this.storage.transactionSync(operation);
  }
}

/** Core-facing controller logic; the exported Worker Durable Object wrapper adds RPC support. */
export class FactoryController {
  readonly #factory: FactoryService;
  readonly #handle: (request: Request) => Promise<Response>;
  #draining: Promise<void> | undefined;

  constructor(
    private readonly state: FactoryDurableObjectState,
    private readonly environment: FactoryDurableObjectEnvironment,
  ) {
    this.#factory = new FactoryService(
      new DurableObjectFactoryDatabase(state.storage),
      environment.UZINA_BOOTSTRAP_SECRET,
    );
    this.#handle = createFactoryHttpHandler(this.#factory, {
      context: async (threadId) => this.#managedWork(threadId).context(),
      status: async (threadId) => this.#managedWork(threadId).status(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const inputRoute =
      request.method === "POST" &&
      /^\/v1\/threads\/[^/]+\/inputs$/.test(new URL(request.url).pathname);
    if (inputRoute) await this.#armQueueAlarm();
    const response = await this.#handle(request);
    if (inputRoute && response.status === 202) {
      const receipt = (await response.clone().json()) as {
        dispatchStatus?: string;
      };
      if (receipt.dispatchStatus === "queued") {
        this.state.waitUntil(this.#dispatchQueued());
      }
    }
    return response;
  }

  /** Trusted Durable Object RPC used only by the sibling managed-work binding. */
  getActiveManagedInput(threadId: string) {
    return this.#factory.getActiveManagedInput(threadId);
  }

  enqueueManagedRemoteExecution(
    threadId: string,
    taskId: string,
    callId: string,
    operation: Parameters<FactoryService["enqueueManagedRemoteExecution"]>[3],
  ) {
    return this.#factory.enqueueManagedRemoteExecution(
      threadId,
      taskId,
      callId,
      operation,
    );
  }

  getRemoteExecutionReceipt(jobId: string) {
    return this.#factory.getRemoteExecutionReceipt(jobId);
  }

  markManagedEffectUncertain(jobId: string, detail: string) {
    return this.#factory.markManagedEffectUncertain(jobId, detail);
  }

  async alarm(): Promise<void> {
    await this.#armQueueAlarm();
    await this.#dispatchQueued();
  }

  async #dispatchQueued(): Promise<void> {
    if (this.#draining) return this.#draining;
    const drain = async () => {
      while (
        await this.#factory.dispatchNext({
          dispatch: async (input) => {
            const result = await this.#managedWork(
              input.threadId,
            ).acceptManagedInput(input);
            return result;
          },
        })
      ) {
        // The next managed input is admitted only after this durable submission settles.
      }
    };
    this.#draining = drain()
      .catch(() => {})
      .finally(async () => {
        this.#draining = undefined;
        await this.state.storage.deleteAlarm();
      });
    return this.#draining;
  }

  async #armQueueAlarm(): Promise<void> {
    const alarm = Date.now() + 60_000;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > alarm) {
      await this.state.storage.setAlarm(alarm);
    }
  }

  #managedWork(threadId: string) {
    const id = this.environment.MANAGED_WORK.idFromName(threadId);
    return this.environment.MANAGED_WORK.get(id);
  }
}
