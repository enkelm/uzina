import type { Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { factoryQueueJobSchema } from "@uzina/contracts/factory";
import {
  type Cursor,
  type DocumentRecord,
  type Page,
} from "@earendil-works/pi-durable";
import type { ManagedWorkCheckpoint } from "@uzina/pi-runtime/checkpoint";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createWorkerManagedRuntimeOptions } from "../../../packages/pi-runtime/src/worker-provider";
import { FactoryObject, ManagedWorkRpcObject } from "../src/durable-objects";
import type { FactoryRpc } from "../src/factory-object";
import type {
  ManagedWorkFactoryBridge,
  ManagedWorkState,
} from "../src/work-object";
import worker from "../src/worker";

let modelCalls = 0;
let alarmCalls = 0;
let runtimeOptionsHeld = false;
let runtimeOptionsEntered = false;
let unusableProviderConfiguration = false;
let modelResponseHeld = false;
let completeHeldModelResponse: (() => void) | undefined;

const model = {
  id: "capture-test-model",
  name: "Capture test model",
  provider: "uzina-capture-test",
  api: "uzina-capture-test-api",
  baseUrl: "https://capture-test.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 4096,
  maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const models = {
  getModel(provider: string, id: string) {
    return provider === model.provider && id === model.id ? model : undefined;
  },
  async getAuth() {
    return undefined;
  },
  stream(
    _model: unknown,
    _context: unknown,
    options?: { signal?: AbortSignal },
  ) {
    return response(options?.signal);
  },
  streamSimple(
    _model: unknown,
    _context: unknown,
    options?: { signal?: AbortSignal },
  ) {
    return response(options?.signal);
  },
} as unknown as Models;

function response(signal?: AbortSignal) {
  modelCalls += 1;
  const stream = createAssistantMessageEventStream();
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    signal?.removeEventListener("abort", complete);
    if (completeHeldModelResponse === complete)
      completeHeldModelResponse = undefined;
    stream.end({
      role: "assistant",
      content: [{ type: "text", text: "The captured Pi root is settled." }],
      api: "uzina-capture-test-api",
      provider: "uzina-capture-test",
      model: "capture-test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: signal?.aborted ? "aborted" : "stop",
      timestamp: Date.now(),
    });
  };
  signal?.addEventListener("abort", complete, { once: true });
  if (modelResponseHeld && !signal?.aborted)
    completeHeldModelResponse = complete;
  else queueMicrotask(complete);
  return stream;
}

type TestFactoryState = ConstructorParameters<typeof FactoryObject>[0];
type TestFactoryEnvironment = ConstructorParameters<typeof FactoryObject>[1];

type TestManagedWorkEnvironment = {
  FACTORY: {
    idFromName(name: string): unknown;
    get(id: unknown): FactoryRpc & ManagedWorkFactoryBridge;
  };
};

type PublicStorageObservation = Pick<
  ManagedWorkCheckpoint,
  "conversations" | "entries" | "tasks" | "submissions" | "documents"
> & { sessionDocuments: DocumentRecord[] };

type TestManagedWorkRpc = {
  releaseModelResponseForTest(): void;
  close(): Promise<void>;
  status(): ReturnType<ManagedWorkRpcObject["status"]>;
  observations(): {
    modelCalls: number;
    alarmCalls: number;
  };
  refusalsForTest(): Promise<Record<string, string>>;
  exportRefusalForTest(request: {
    captureId: string;
    captureRequestId: string;
  }): Promise<string>;
  scheduleAlarmForTest(at: number): Promise<void>;
  pendingAlarmForTest(): Promise<number | null>;
  exportManagedWorkCheckpoint(request: {
    captureId: string;
    captureRequestId: string;
  }): ReturnType<ManagedWorkRpcObject["exportManagedWorkCheckpoint"]>;
  publicStorageObservation(): Promise<PublicStorageObservation>;
};

async function scanPages<T>(
  read: (limit: number, cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
): Promise<T[]> {
  const records: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await read(128, cursor);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return records;
}

export class CaptureTestFactory extends FactoryObject {
  readonly #storage: TestFactoryState["storage"];

  constructor(
    state: TestFactoryState,
    private readonly environment: TestFactoryEnvironment,
  ) {
    super(state, environment);
    this.#storage = state.storage;
  }

  async exportManagedWorkCheckpointForTest(
    threadId: string,
    request: { captureId: string; captureRequestId: string },
  ) {
    const id = this.environment.MANAGED_WORK.idFromName(threadId);
    return this.environment.MANAGED_WORK.get(id).exportManagedWorkCheckpoint(
      request,
    );
  }

  changeThreadGenerationForTest(threadId: string, generation: number): void {
    this.#storage.sql.exec(
      "UPDATE threads SET ownership_generation = ? WHERE thread_id = ?",
      generation,
      threadId,
    );
  }
}

export class CaptureTestManagedWork extends ManagedWorkRpcObject {
  readonly #storage: ManagedWorkState["storage"];
  readonly #threadId: string;

  constructor(
    state: ManagedWorkState,
    environment: TestManagedWorkEnvironment,
  ) {
    super(state, environment, {
      runtimeOptions: async () => {
        if (runtimeOptionsHeld) {
          runtimeOptionsEntered = true;
          try {
            while (runtimeOptionsHeld) {
              await new Promise<void>((resolve) => setTimeout(resolve, 1));
            }
          } finally {
            runtimeOptionsEntered = false;
          }
        }
        if (unusableProviderConfiguration) {
          return createWorkerManagedRuntimeOptions({
            UZINA_MODEL_PROVIDER: "openai",
            UZINA_MODEL_ID: "gpt-4o-mini",
            UZINA_MODEL_API_KEY: "",
          });
        }
        return {
          models,
          agent: {
            model: {
              provider: "uzina-capture-test",
              modelId: "capture-test-model",
            },
          },
        };
      },
      factory: () =>
        environment.FACTORY.get(
          environment.FACTORY.idFromName("uzina-single-factory"),
        ),
    });
    this.#storage = state.storage;
    this.#threadId = state.id.name ?? "";
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    alarmCalls += 1;
  }

  scheduleAlarmForTest(at: number): Promise<void> {
    return this.#storage.setAlarm(at);
  }

  pendingAlarmForTest(): Promise<number | null> {
    return this.#storage.getAlarm();
  }

  observations() {
    return { modelCalls, alarmCalls };
  }

  releaseModelResponseForTest(): void {
    modelResponseHeld = false;
    completeHeldModelResponse?.();
  }

  async publicStorageObservation(): Promise<PublicStorageObservation> {
    const storage = await openDurableObjectSqliteStorage(this.#storage);
    try {
      const conversations = await scanPages((limit, cursor) =>
        storage.scanConversations({}, limit, cursor, BACKGROUND_CONTEXT),
      );
      const entries: ManagedWorkCheckpoint["entries"] = [];
      for (const conversation of conversations) {
        entries.push(
          ...(await scanPages((limit, cursor) =>
            storage.scanEntries(
              { conversationId: conversation.id, order: "ascending" },
              limit,
              cursor,
              BACKGROUND_CONTEXT,
            ),
          )),
        );
      }
      const tasks = await scanPages((limit, cursor) =>
        storage.scanTasks({}, limit, cursor, BACKGROUND_CONTEXT),
      );
      const submissions = await scanPages((limit, cursor) =>
        storage.scanSubmissions({}, limit, cursor, BACKGROUND_CONTEXT),
      );
      const sessionDocuments = await scanPages((limit, cursor) =>
        storage.scanDocuments(
          { scope: { kind: "session" }, at: "current" },
          limit,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      );
      const documentRecords: DocumentRecord[] = [...sessionDocuments];
      for (const conversation of conversations) {
        documentRecords.push(
          ...(await scanPages((limit, cursor) =>
            storage.scanDocuments(
              {
                scope: {
                  kind: "conversation",
                  conversationId: conversation.id,
                },
                at: "current",
              },
              limit,
              cursor,
              BACKGROUND_CONTEXT,
            ),
          )),
        );
      }
      for (const task of tasks) {
        documentRecords.push(
          ...(await scanPages((limit, cursor) =>
            storage.scanDocuments(
              { scope: { kind: "task", taskId: task.id }, at: "current" },
              limit,
              cursor,
              BACKGROUND_CONTEXT,
            ),
          )),
        );
      }
      const documents: ManagedWorkCheckpoint["documents"] = [];
      for (const record of documentRecords) {
        const stored = await storage.document(
          record.id,
          "current",
          BACKGROUND_CONTEXT,
        );
        if (!stored) {
          throw new Error(`Public storage document ${record.id} disappeared`);
        }
        documents.push({
          record: stored.record,
          version: stored.version,
          value: stored.value,
        });
      }
      entries.sort((left, right) => Number(left.id) - Number(right.id));
      documents.sort(
        (left, right) => Number(left.record.id) - Number(right.record.id),
      );
      return {
        conversations,
        entries,
        tasks,
        submissions,
        documents: documents.filter(
          (document) => document.record.scope.kind !== "session",
        ),
        sessionDocuments,
      };
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  }

  async refusalsForTest(): Promise<Record<string, string>> {
    return {
      create: await errorMessage(() => this.create()),
      acceptManagedInput: await errorMessage(() =>
        this.acceptManagedInput(
          factoryQueueJobSchema.parse({
            contractVersion: 1,
            jobId: "job:blocked-direct",
            requestId: "request:blocked-direct",
            threadId: this.#threadId,
            actor: {
              contractVersion: 1,
              kind: "human",
              userId: "user:capture-test",
            },
            target: {
              nodeId: "node:capture-test",
              workspaceId: "workspace:capture-test",
            },
            ownershipGeneration: 0,
            input: { kind: "managed-input", text: "not admitted" },
          }),
        ),
      ),
      submit: await errorMessage(() =>
        this.submit("request:blocked-direct", "not admitted"),
      ),
      context: await errorMessage(() => this.context()),
      status: await errorMessage(() => this.status()),
      resume: await errorMessage(() => this.resume()),
    };
  }

  exportRefusalForTest(request: {
    captureId: string;
    captureRequestId: string;
  }): Promise<string> {
    return errorMessage(() => this.exportManagedWorkCheckpoint(request));
  }
}

async function errorMessage(operation: () => unknown | Promise<unknown>) {
  try {
    await operation();
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Keep test-only DO RPC calls inside workerd; Miniflare's Node proxy leaks a stub warning.
export default {
  async fetch(request: Request, environment: TestFactoryEnvironment) {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/__test/managed-work-export"
    ) {
      const input = (await request.json()) as {
        threadId: string;
        captureId: string;
        captureRequestId: string;
      };
      const factory = environment.FACTORY.get(
        environment.FACTORY.idFromName("uzina-single-factory"),
      ) as FactoryRpc & {
        exportManagedWorkCheckpointForTest(
          threadId: string,
          request: { captureId: string; captureRequestId: string },
        ): ReturnType<CaptureTestFactory["exportManagedWorkCheckpointForTest"]>;
      };
      const checkpoint = await factory.exportManagedWorkCheckpointForTest(
        input.threadId,
        {
          captureId: input.captureId,
          captureRequestId: input.captureRequestId,
        },
      );
      return Response.json({
        ...checkpoint,
        bytes: Array.from(checkpoint.bytes),
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/model-response"
    ) {
      const input = (await request.json()) as {
        action: "hold" | "release";
        threadId: string;
      };
      if (input.action === "hold") modelResponseHeld = true;
      else {
        const work = environment.MANAGED_WORK.get(
          environment.MANAGED_WORK.idFromName(input.threadId),
        ) as unknown as TestManagedWorkRpc;
        await work.releaseModelResponseForTest();
      }
      return Response.json(null);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/provider-configuration"
    ) {
      const input = (await request.json()) as {
        mode: "deterministic" | "unusable";
      };
      unusableProviderConfiguration = input.mode === "unusable";
      return Response.json({ mode: input.mode });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/runtime-options-barrier"
    ) {
      const input = (await request.json()) as {
        action: "hold" | "release" | "entered";
      };
      if (input.action === "hold") {
        runtimeOptionsHeld = true;
        runtimeOptionsEntered = false;
      } else if (input.action === "release") {
        runtimeOptionsHeld = false;
      }
      return Response.json({ entered: runtimeOptionsEntered });
    }
    if (request.method === "POST" && url.pathname === "/__test/managed-work") {
      const input = (await request.json()) as {
        threadId: string;
        operation:
          | { kind: "observe" }
          | { kind: "status" }
          | { kind: "close" }
          | { kind: "public-storage-observation" }
          | { kind: "pending-alarm" }
          | {
              kind: "export" | "export-refusal";
              request: { captureId: string; captureRequestId: string };
            }
          | { kind: "refusals" }
          | { kind: "schedule-alarm"; at: number };
      };
      const work = environment.MANAGED_WORK.get(
        environment.MANAGED_WORK.idFromName(input.threadId),
      ) as unknown as TestManagedWorkRpc;
      switch (input.operation.kind) {
        case "observe":
          return Response.json(await work.observations());
        case "close":
          return Response.json(await errorMessage(() => work.close()));
        case "status": {
          const status = await work.status();
          return Response.json({
            conversationId:
              "conversationId" in status ? status.conversationId : null,
          });
        }
        case "public-storage-observation":
          return Response.json(await work.publicStorageObservation());
        case "pending-alarm":
          return Response.json(await work.pendingAlarmForTest());
        case "export": {
          const checkpoint = await work.exportManagedWorkCheckpoint(
            input.operation.request,
          );
          return Response.json({
            ...checkpoint,
            bytes: Array.from(checkpoint.bytes),
          });
        }
        case "export-refusal":
          return Response.json(
            await work.exportRefusalForTest(input.operation.request),
          );
        case "refusals":
          return Response.json(await work.refusalsForTest());
        case "schedule-alarm":
          await work.scheduleAlarmForTest(input.operation.at);
          return Response.json(null);
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/change-generation"
    ) {
      const input = (await request.json()) as {
        threadId: string;
        generation: number;
      };
      const factory = environment.FACTORY.get(
        environment.FACTORY.idFromName("uzina-single-factory"),
      ) as FactoryRpc & {
        changeThreadGenerationForTest(
          threadId: string,
          generation: number,
        ): void;
      };
      factory.changeThreadGenerationForTest(input.threadId, input.generation);
      return Response.json(null);
    }
    return worker.fetch(
      request,
      environment as unknown as Parameters<typeof worker.fetch>[1],
    );
  },
};
