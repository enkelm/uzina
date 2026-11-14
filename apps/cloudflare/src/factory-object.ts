import { FactoryError, FactoryService } from "@uzina/core";
import { createFactoryHttpHandler } from "@uzina/core/http";
import type { FactoryDatabase, SqlRow, SqlValue } from "@uzina/core/database";
import type { FactoryQueueJob } from "@uzina/contracts/factory";
import type { ManagedInputSettlement } from "./work-object";
import {
  R2WorkspaceSnapshotStorage,
  type R2WorkspaceBucket,
} from "./snapshot-storage";

export const FACTORY_DURABLE_OBJECT_NAME = "uzina-single-factory";
export const PRIVATE_ASSISTANT_DURABLE_OBJECT_NAME =
  "uzina-owner-private-assistant";

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
  factoryHttp(request: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
  authorizePrivateAssistant(credential: string): Promise<{
    authorized: boolean;
    status: number;
    code: string;
  }>;
}

export interface PrivateAssistantRpc {
  status(): Promise<unknown>;
  context(): Promise<unknown>;
  receipt(inputId: string): Promise<unknown>;
  submit(inputId: string, text: string): Promise<unknown>;
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
  /** Operator-configured R2 bucket; absence disables remote snapshot publication. */
  CHECKPOINTS?: R2WorkspaceBucket;
}

const MAX_FACTORY_HTTP_RESPONSE_BYTES = 256 * 1024;

async function readBoundedFactoryHttpResponseBody(
  response: Response,
): Promise<string | undefined> {
  const body = response.body;
  if (!body) return "";

  const bytes = new Uint8Array(MAX_FACTORY_HTTP_RESPONSE_BYTES);
  const reader = body.getReader();
  let length = 0;
  let completed = false;
  let cancellationStarted = false;
  const cancel = (reason?: unknown): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    try {
      void reader.cancel(reason).catch(() => {});
    } catch {
      // Preserve the original read or size result when the body refuses cancellation.
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        completed = true;
        break;
      }
      if (chunk.value.byteLength > MAX_FACTORY_HTTP_RESPONSE_BYTES - length) {
        cancel();
        return undefined;
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return new TextDecoder("utf-8").decode(bytes.subarray(0, length));
  } catch (error) {
    if (!completed) cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
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
    const snapshotStorage = environment.CHECKPOINTS
      ? new R2WorkspaceSnapshotStorage(environment.CHECKPOINTS)
      : undefined;
    this.#handle = createFactoryHttpHandler(
      this.#factory,
      {
        context: async (threadId) => this.#managedWork(threadId).context(),
        status: async (threadId) => this.#managedWork(threadId).status(),
      },
      undefined,
      snapshotStorage,
    );
  }

  async factoryHttp(input: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  }) {
    const url = new URL(input.url);
    const requestBytes =
      input.body === undefined
        ? 0
        : new TextEncoder().encode(input.body).byteLength;
    if (
      url.origin !== "https://uzina-factory.internal" ||
      !url.pathname.startsWith("/v1/") ||
      requestBytes > 640 * 1024
    ) {
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: '{"error":"invalid_request"}',
      };
    }
    const response = await this.fetch(
      new Request(url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }),
      }),
    );
    const responseBody = await readBoundedFactoryHttpResponseBody(response);
    if (responseBody === undefined) {
      return {
        status: 502,
        headers: { "content-type": "application/json" },
        body: '{"error":"response_too_large"}',
      };
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    };
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

  /** Core-authenticated owner gate used by the Worker before private-runtime RPC. */
  async authorizePrivateAssistant(credential: string) {
    try {
      const session = await this.#factory.authenticate(credential);
      this.#factory.requirePrivateAssistantOwner(session);
      return { authorized: true, status: 200, code: "authorized" };
    } catch (error) {
      return error instanceof FactoryError
        ? { authorized: false, status: error.status, code: error.code }
        : { authorized: false, status: 500, code: "internal_error" };
    }
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
