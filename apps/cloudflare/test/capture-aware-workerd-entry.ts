import type { Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { factoryQueueJobSchema } from "@uzina/contracts/factory";
import {
  type Cursor,
  type DocumentRecord,
  type Page,
} from "@earendil-works/pi-durable";
import type { ManagedWorkCheckpoint } from "@uzina/pi-runtime/checkpoint";
import type { FactoryProvenanceEvidence } from "@uzina/contracts/factory";
import type { ExecutionOperation } from "@uzina/contracts/execution";
import {
  verifyManagedWorkCheckpointClosure,
  type ManagedWorkCheckpointClosureVerification,
} from "@uzina/core/managed-work-checkpoint-verification";
import { R2ManagedWorkCheckpointStorage } from "../src/managed-work-checkpoint-storage";
import {
  MANAGED_WORK_RUNTIME_REQUIREMENTS,
  type ManagedWorkCheckpointArtifactReference,
} from "@uzina/checkpoints/managed-work-composition";
import { MANAGED_REMOTE_TOOL_REQUIREMENTS } from "@uzina/pi-runtime/tools";
import { R2WorkspaceSnapshotStorage } from "../src/snapshot-storage";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createWorkerManagedRuntimeOptions } from "../../../packages/pi-runtime/src/worker-provider";
import { FactoryObject, ManagedWorkRpcObject } from "../src/durable-objects";
import type { FactoryRpc } from "../src/factory-object";
import { MANAGED_WORK_SOURCE_RUNTIME_PROFILE_STORAGE_KEY } from "../src/work-object";
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
let configuredModelId = "capture-test-model";
let modelResponseHeld = false;
let failNextManagedReadToolCall = false;
let completeHeldModelResponse: (() => void) | undefined;
let loseNextCheckpointExportResponse = false;
let checkpointExportAttempts = 0;
let lostCheckpointExportResponses = 0;
let checkpointPublicationHoldRequested = false;
let checkpointPublicationEntered = false;
let releaseCheckpointPublication: (() => void) | undefined;
let checkpointPublicationSummary:
  ManagedWorkCheckpointClosureVerification | undefined;
let checkpointPublicationSummaryFrozen = false;
let privateArtifactReadHoldRequestId: string | undefined;
let privateArtifactReadHoldMode: "first-read" | "second-read" | undefined;
let privateArtifactReadEntered = false;
let releasePrivateArtifactRead: (() => void) | undefined;
let checkpointExportForbiddenThreadId: string | undefined;
let publicationBindingApplied = false;
let privateReadBindingApplied = false;
let exportGuardBindingApplied = false;

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

const reconfiguredModel = { ...model, id: "capture-test-model-reconfigured" };

const models = {
  getModel(provider: string, id: string) {
    if (provider !== model.provider) return undefined;
    return id === model.id
      ? model
      : id === reconfiguredModel.id
        ? reconfiguredModel
        : undefined;
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
  const emitManagedReadFailure = failNextManagedReadToolCall;
  if (emitManagedReadFailure) failNextManagedReadToolCall = false;
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    signal?.removeEventListener("abort", complete);
    if (completeHeldModelResponse === complete)
      completeHeldModelResponse = undefined;
    stream.end({
      role: "assistant",
      content: emitManagedReadFailure
        ? [
            {
              type: "toolCall",
              id: "call:checkpoint-provenance-failure",
              name: "remote_read_file",
              arguments: {
                path: "missing-provenance-input.txt",
                maxBytes: 1024,
              },
            },
          ]
        : [{ type: "text", text: "The captured Pi root is settled." }],
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
      stopReason: signal?.aborted
        ? "aborted"
        : emitManagedReadFailure
          ? "toolUse"
          : "stop",
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
type TestFactoryEnvironment = ConstructorParameters<typeof FactoryObject>[1] & {
  UZINA_TEST_HOLD_CHECKPOINT_PUBLICATION?: string;
  UZINA_TEST_HOLD_PRIVATE_READ_REQUEST_ID?: string;
  UZINA_TEST_HOLD_PRIVATE_READ_MODE?: "first-read" | "second-read";
  UZINA_TEST_FORBID_CHECKPOINT_EXPORT_THREAD_ID?: string;
};

function checkpointBucketWithPrivateReadGate(
  bucket: NonNullable<TestFactoryEnvironment["CHECKPOINTS"]>,
): NonNullable<TestFactoryEnvironment["CHECKPOINTS"]> {
  const reads = new Map<string, number>();
  return {
    put: (key, value, options) => bucket.put(key, value, options),
    async get(key) {
      const requestId = privateArtifactReadHoldRequestId;
      const mode = privateArtifactReadHoldMode;
      if (requestId && mode) {
        const prefix = await namespacedPrefix(
          "managed-work-checkpoints",
          requestId,
        );
        if (
          privateArtifactReadHoldRequestId === requestId &&
          key.startsWith(prefix)
        ) {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          const shouldHold = mode === "first-read" ? count === 1 : count === 2;
          if (shouldHold) {
            privateArtifactReadHoldRequestId = undefined;
            privateArtifactReadHoldMode = undefined;
            privateArtifactReadEntered = true;
            try {
              await new Promise<void>((resolve) => {
                releasePrivateArtifactRead = resolve;
              });
            } finally {
              privateArtifactReadEntered = false;
              releasePrivateArtifactRead = undefined;
            }
          }
        }
      }
      return bucket.get(key);
    },
    delete: (key) => bucket.delete(key),
    list: (options) => bucket.list(options),
  };
}

type TestManagedWorkEnvironment = {
  FACTORY: {
    idFromName(name: string): unknown;
    get(id: unknown): FactoryRpc & ManagedWorkFactoryBridge;
  };
  UZINA_TEST_FORBID_CHECKPOINT_EXPORT_THREAD_ID?: string;
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
  clearSourceRuntimeProfileForTest(): Promise<boolean>;
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
    super(state, {
      ...environment,
      CHECKPOINTS: environment.CHECKPOINTS
        ? checkpointBucketWithPrivateReadGate(environment.CHECKPOINTS)
        : undefined,
    });
    if (!publicationBindingApplied) {
      if (environment.UZINA_TEST_HOLD_CHECKPOINT_PUBLICATION === "true") {
        checkpointPublicationHoldRequested = true;
      }
      publicationBindingApplied = true;
    }
    if (!privateReadBindingApplied) {
      if (environment.UZINA_TEST_HOLD_PRIVATE_READ_REQUEST_ID) {
        privateArtifactReadHoldRequestId =
          environment.UZINA_TEST_HOLD_PRIVATE_READ_REQUEST_ID;
        privateArtifactReadHoldMode =
          environment.UZINA_TEST_HOLD_PRIVATE_READ_MODE;
      }
      privateReadBindingApplied = true;
    }
    if (!exportGuardBindingApplied) {
      checkpointExportForbiddenThreadId =
        environment.UZINA_TEST_FORBID_CHECKPOINT_EXPORT_THREAD_ID || undefined;
      exportGuardBindingApplied = true;
    }
    this.#storage = state.storage;
  }

  checkpointAssemblyJournalForTest(requestId: string) {
    const request = this.#storage.sql
      .exec<{
        status: string;
        stage: string;
        runtime_requirements_json: string | null;
      }>(
        "SELECT status, stage, runtime_requirements_json FROM managed_work_checkpoint_requests WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];
    if (!request) return null;
    const artifacts = this.#storage.sql
      .exec<{
        role: string;
        reference: string;
        size_bytes: number;
      }>(
        "SELECT role, reference, size_bytes FROM managed_work_checkpoint_artifacts WHERE request_id = ? ORDER BY role, reference",
        requestId,
      )
      .toArray();
    return {
      status: request.status,
      stage: request.stage,
      runtimeRequirements: request.runtime_requirements_json
        ? (JSON.parse(request.runtime_requirements_json) as string[])
        : null,
      artifacts: artifacts.map((artifact) => ({
        role: artifact.role,
        reference: artifact.reference,
        size: artifact.size_bytes,
      })),
    };
  }

  override async publishManagedWorkCheckpoint(
    requestId: string,
    manifestReference: string,
    verification: Parameters<FactoryObject["publishManagedWorkCheckpoint"]>[2],
  ) {
    if (checkpointPublicationHoldRequested) {
      checkpointPublicationHoldRequested = false;
      checkpointPublicationSummaryFrozen = Object.isFrozen(verification);
      checkpointPublicationSummary = JSON.parse(
        JSON.stringify(verification),
      ) as ManagedWorkCheckpointClosureVerification;
      checkpointPublicationEntered = true;
      try {
        await new Promise<void>((resolve) => {
          releaseCheckpointPublication = resolve;
        });
      } finally {
        checkpointPublicationEntered = false;
        releaseCheckpointPublication = undefined;
      }
    }
    return super.publishManagedWorkCheckpoint(
      requestId,
      manifestReference,
      verification,
    );
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
    if (
      !exportGuardBindingApplied &&
      environment.UZINA_TEST_FORBID_CHECKPOINT_EXPORT_THREAD_ID
    ) {
      checkpointExportForbiddenThreadId =
        environment.UZINA_TEST_FORBID_CHECKPOINT_EXPORT_THREAD_ID;
      exportGuardBindingApplied = true;
    }
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
              modelId: configuredModelId,
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

  override async exportManagedWorkCheckpoint(request: {
    captureId: string;
    captureRequestId: string;
  }) {
    checkpointExportAttempts += 1;
    if (checkpointExportForbiddenThreadId === this.#threadId) {
      throw new Error(
        "Managed-work export unexpectedly repeated after its runtime artifact was recorded",
      );
    }
    const result = await super.exportManagedWorkCheckpoint(request);
    if (loseNextCheckpointExportResponse) {
      loseNextCheckpointExportResponse = false;
      lostCheckpointExportResponses += 1;
      throw new Error("Test lost the completed checkpoint export response");
    }
    return result;
  }

  scheduleAlarmForTest(at: number): Promise<void> {
    return this.#storage.setAlarm(at);
  }

  clearSourceRuntimeProfileForTest(): Promise<boolean> {
    return this.#storage.delete(
      MANAGED_WORK_SOURCE_RUNTIME_PROFILE_STORAGE_KEY,
    );
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
async function namespacedPrefix(
  namespace: "workspace-snapshots" | "managed-work-checkpoints",
  identifier: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identifier),
  );
  const reference = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${namespace}/${reference}/`;
}

export default {
  async fetch(request: Request, environment: TestFactoryEnvironment) {
    const url = new URL(request.url);
    const checkpointBucket = environment.CHECKPOINTS;
    if (!checkpointBucket) {
      return new Response("Checkpoint test bucket is unavailable", {
        status: 503,
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/private-checkpoint-read"
    ) {
      const input = (await request.json()) as {
        action: "hold" | "state" | "release";
        requestId?: string;
        mode?: "first-read" | "second-read";
      };
      if (input.action === "hold") {
        if (!input.requestId || !input.mode) {
          return Response.json(
            { error: "invalid_test_input" },
            { status: 400 },
          );
        }
        privateArtifactReadHoldRequestId = input.requestId;
        privateArtifactReadHoldMode = input.mode;
        privateArtifactReadEntered = false;
      } else if (input.action === "release") {
        releasePrivateArtifactRead?.();
      }
      return Response.json({ entered: privateArtifactReadEntered });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/managed-checkpoint-journal"
    ) {
      const input = (await request.json()) as { requestId: string };
      const factory = environment.FACTORY.get(
        environment.FACTORY.idFromName("uzina-single-factory"),
      ) as FactoryRpc & {
        checkpointAssemblyJournalForTest(requestId: string): unknown;
      };
      return Response.json(
        await factory.checkpointAssemblyJournalForTest(input.requestId),
      );
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/managed-checkpoint-publication"
    ) {
      const input = (await request.json()) as {
        action: "hold" | "state" | "release" | "attempt";
        requestId?: string;
        manifestReference?: string;
        verification?: ManagedWorkCheckpointClosureVerification;
      };
      if (input.action === "hold") {
        checkpointPublicationHoldRequested = true;
        checkpointPublicationSummary = undefined;
        checkpointPublicationSummaryFrozen = false;
        return Response.json({ held: true });
      }
      if (input.action === "state") {
        return Response.json({
          entered: checkpointPublicationEntered,
          verificationFrozen: checkpointPublicationSummaryFrozen,
          verification: checkpointPublicationSummary,
        });
      }
      if (input.action === "release") {
        releaseCheckpointPublication?.();
        return Response.json({ released: true });
      }
      if (!input.requestId || !input.manifestReference || !input.verification) {
        return Response.json({ error: "invalid_test_input" }, { status: 400 });
      }
      const factory = environment.FACTORY.get(
        environment.FACTORY.idFromName("uzina-single-factory"),
      );
      try {
        return Response.json(
          await factory.publishManagedWorkCheckpoint(
            input.requestId,
            input.manifestReference,
            input.verification,
          ),
        );
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error ? error.message : "publication_refused",
          },
          { status: 409 },
        );
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/checkpoint-export-response"
    ) {
      const input = (await request.json()) as {
        action: "lose-next" | "stats" | "allow";
      };
      if (input.action === "lose-next") loseNextCheckpointExportResponse = true;
      if (input.action === "allow")
        checkpointExportForbiddenThreadId = undefined;
      return Response.json({
        attempts: checkpointExportAttempts,
        lostResponses: lostCheckpointExportResponses,
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/verify-checkpoint"
    ) {
      const input = (await request.json()) as {
        requestId: string;
        captureId: string;
        sourceWorkspaceManifestReference: string;
        authoritativeWorkspaceReferences: Array<{
          reference: string;
          size: number;
        }>;
        manifestReference: string;
        expectedEvidence: FactoryProvenanceEvidence;
        privateArtifacts: ManagedWorkCheckpointArtifactReference[];
      };
      try {
        const result = await verifyManagedWorkCheckpointClosure({
          checkpointRequestId: input.requestId,
          captureId: input.captureId,
          sourceWorkspaceManifestReference:
            input.sourceWorkspaceManifestReference,
          authoritativeWorkspaceReferences:
            input.authoritativeWorkspaceReferences,
          manifestReference: input.manifestReference,
          expectedRuntimeRequirements: [
            ...MANAGED_WORK_RUNTIME_REQUIREMENTS,
            "model:uzina-capture-test/capture-test-model",
            ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
          ],
          expectedEvidence: input.expectedEvidence,
          privateArtifacts: input.privateArtifacts,
          workspaceStorage: new R2WorkspaceSnapshotStorage(checkpointBucket),
          privateStorage: new R2ManagedWorkCheckpointStorage(
            checkpointBucket,
            input.requestId,
          ),
        });
        return Response.json(result);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "closure invalid" },
          { status: 422 },
        );
      }
    }
    const privateOrphan = url.pathname.match(
      /^\/__test\/checkpoint-storage\/([^/]+)\/orphan$/,
    );
    if (request.method === "POST" && privateOrphan) {
      const input = (await request.json()) as { bytes: number[] };
      const storage = new R2ManagedWorkCheckpointStorage(
        checkpointBucket,
        decodeURIComponent(privateOrphan[1]!),
      );
      return Response.json({
        reference: await storage.putBlob(new Uint8Array(input.bytes)),
      });
    }
    const privateMutation = url.pathname.match(
      /^\/__test\/checkpoint-storage\/([^/]+)\/([a-f0-9]{64})\/(delete|replace)$/,
    );
    if (request.method === "POST" && privateMutation) {
      const prefix = await namespacedPrefix(
        "managed-work-checkpoints",
        decodeURIComponent(privateMutation[1]!),
      );
      const key = `${prefix}${privateMutation[2]}`;
      if (privateMutation[3] === "delete") {
        await checkpointBucket.delete(key);
      } else if (request.body) {
        await checkpointBucket.put(key, request.body);
      }
      return new Response(null, { status: 204 });
    }
    const workspaceMutation = url.pathname.match(
      /^\/__test\/workspace-storage\/([^/]+)\/([a-f0-9]{64})\/(delete|replace)$/,
    );
    if (request.method === "POST" && workspaceMutation) {
      const prefix = await namespacedPrefix(
        "workspace-snapshots",
        decodeURIComponent(workspaceMutation[1]!),
      );
      const key = `${prefix}${workspaceMutation[2]}`;
      if (workspaceMutation[3] === "delete") {
        await checkpointBucket.delete(key);
      } else if (request.body) {
        await checkpointBucket.put(key, request.body);
      }
      return new Response(null, { status: 204 });
    }
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
      url.pathname === "/__test/managed-effect"
    ) {
      const input = (await request.json()) as {
        threadId: string;
        taskId: string;
        callId: string;
        operation: ExecutionOperation;
      };
      const factory = environment.FACTORY.get(
        environment.FACTORY.idFromName("uzina-single-factory"),
      );
      const receipt = await factory.enqueueManagedRemoteExecution(
        input.threadId,
        input.taskId,
        input.callId,
        input.operation,
      );
      return Response.json({ jobId: receipt.jobId, status: receipt.status });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__test/model-response"
    ) {
      const input = (await request.json()) as {
        action: "hold" | "release" | "arm-read-failure";
        threadId: string;
      };
      if (input.action === "arm-read-failure") {
        failNextManagedReadToolCall = true;
        return Response.json({ armed: true });
      }
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
        mode: "deterministic" | "reconfigured" | "unusable";
      };
      unusableProviderConfiguration = input.mode === "unusable";
      configuredModelId =
        input.mode === "reconfigured" ? reconfiguredModel.id : model.id;
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
          | { kind: "clear-source-runtime-profile" }
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
        case "clear-source-runtime-profile":
          return Response.json(await work.clearSourceRuntimeProfileForTest());
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
