import { FactoryError, FactoryService } from "@uzina/core";
import type { ManagedWorkCheckpointArtifactReference } from "@uzina/core";
import { createFactoryHttpHandler } from "@uzina/core/http";
import {
  verifyManagedWorkCheckpointClosure,
  type ManagedWorkCheckpointPrivateStorage,
} from "@uzina/core/managed-work-checkpoint-verification";
import type { WorkspaceCheckpointManifest } from "@uzina/checkpoints";
import {
  composeManagedWorkBundleFromWorkspace,
  MANAGED_WORK_RUNTIME_REQUIREMENTS,
  prepareManagedWorkBundleComposition,
} from "@uzina/checkpoints/managed-work-composition";
import { MANAGED_REMOTE_TOOL_REQUIREMENTS } from "@uzina/pi-runtime/tools";
import { canonicalManagedWorkJson } from "@uzina/checkpoints/managed-work-composition";
import {
  PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  Sha256Stream,
  portableWorkspaceBlobReferences,
} from "@uzina/checkpoints/portable";
import { prepareManagedWorkCheckpointArtifact } from "@uzina/pi-runtime/checkpoint";
import type { FactoryDatabase, SqlRow, SqlValue } from "@uzina/core/database";
import type {
  FactoryQueueJob,
  ManagedWorkCheckpointStage,
} from "@uzina/contracts/factory";
import type {
  ManagedInputSettlement,
  ManagedWorkCheckpointExport,
  ManagedWorkCheckpointExportRequest,
} from "./work-object";
import { R2ManagedWorkCheckpointStorage } from "./managed-work-checkpoint-storage";
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
    exportManagedWorkCheckpoint(
      request: ManagedWorkCheckpointExportRequest,
    ): Promise<ManagedWorkCheckpointExport>;
  };
};

export interface FactoryRpc {
  getManagedWorkCaptureState(
    threadId: string,
  ): ReturnType<FactoryController["getManagedWorkCaptureState"]>;
  acquireManagedWorkRuntimePermit(
    threadId: string,
  ): ReturnType<FactoryController["acquireManagedWorkRuntimePermit"]>;
  releaseManagedWorkRuntimePermit(
    threadId: string,
    permitId: string,
  ): ReturnType<FactoryController["releaseManagedWorkRuntimePermit"]>;
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
  publishManagedWorkCheckpoint(
    requestId: string,
    manifestReference: string,
    verification: Parameters<FactoryService["publishManagedWorkCheckpoint"]>[2],
  ): ReturnType<FactoryService["publishManagedWorkCheckpoint"]>;
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
    credentialId?: string;
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
  /** Encrypted Worker secret for pi-coop-style owner sign-in links; no bootstrap request needed. */
  UZINA_OWNER_TOKEN?: string;
  UZINA_MODEL_PROVIDER?: string;
  UZINA_MODEL_ID?: string;
  UZINA_MODEL_API_KEY?: string;
  UZINA_PROVIDER_CREDENTIALS?: string;
  FACTORY: {
    idFromName(name: string): unknown;
    get(id: unknown): FactoryRpc;
  };
  MANAGED_WORK: ManagedWorkNamespace;
  /** Operator-configured R2 bucket; absence disables remote snapshot publication. */
  CHECKPOINTS?: R2WorkspaceBucket;
}

const MAX_FACTORY_HTTP_RESPONSE_BYTES = 256 * 1024;

function sourceRuntimeRequirementsForExport(
  exported: ManagedWorkCheckpointExport,
  request: {
    captureId: string;
    captureRequestId: string;
    threadId: string;
    target: { nodeId: string; workspaceId: string };
    ownershipGeneration: number;
  },
): string[] {
  const profile = exported.sourceRuntimeProfile;
  if (
    !profile ||
    Object.keys(profile).length !== 9 ||
    profile.version !== 1 ||
    profile.threadId !== request.threadId ||
    profile.captureId !== request.captureId ||
    profile.captureRequestId !== request.captureRequestId ||
    profile.target.nodeId !== request.target.nodeId ||
    profile.target.workspaceId !== request.target.workspaceId ||
    profile.ownershipGeneration !== request.ownershipGeneration ||
    profile.checkpointSha256 !== exported.checkpointSha256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(profile.model.provider) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(profile.model.modelId) ||
    Object.keys(profile.model).length !== 2 ||
    Object.keys(profile.target).length !== 2
  ) {
    throw new Error(
      "Managed-work source runtime profile is missing or unbound",
    );
  }
  const sourceRequirements = [
    `model:${profile.model.provider}/${profile.model.modelId}`,
    ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
  ];
  if (
    profile.requirements.length !== sourceRequirements.length ||
    profile.requirements.some(
      (requirement, index) => requirement !== sourceRequirements[index],
    )
  ) {
    throw new Error("Managed-work source runtime requirements are invalid");
  }
  const requirements = [
    ...MANAGED_WORK_RUNTIME_REQUIREMENTS,
    ...sourceRequirements,
  ];
  if (
    requirements.length > 16 ||
    requirements.some(
      (requirement) =>
        !requirement.trim() ||
        requirement.length > 256 ||
        /[\r\n]/.test(requirement),
    ) ||
    new Set(requirements).size !== requirements.length
  ) {
    throw new Error("Managed-work source runtime requirements are invalid");
  }
  return requirements;
}

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
  readonly #ready: Promise<unknown>;
  readonly #handle: (request: Request) => Promise<Response>;
  readonly #snapshotStorage: R2WorkspaceSnapshotStorage | undefined;
  readonly #exportCheckpoint: (request: {
    captureId: string;
    captureRequestId: string;
    threadId: string;
  }) => Promise<ManagedWorkCheckpointExport>;
  readonly #publishManagedWorkCheckpoint: FactoryRpc["publishManagedWorkCheckpoint"];
  #draining: Promise<void> | undefined;

  constructor(
    private readonly state: FactoryDurableObjectState,
    private readonly environment: FactoryDurableObjectEnvironment,
    publishManagedWorkCheckpoint?: FactoryRpc["publishManagedWorkCheckpoint"],
  ) {
    this.#factory = new FactoryService(
      new DurableObjectFactoryDatabase(state.storage),
      environment.UZINA_BOOTSTRAP_SECRET,
    );
    this.#ready = environment.UZINA_OWNER_TOKEN
      ? this.#factory
          .createOwnerSignIn("Factory owner", environment.UZINA_OWNER_TOKEN)
          .catch((error: unknown) => {
            // Core revocation wins over the deployment secret, including after eviction.
            if (error instanceof FactoryError && error.status === 401) return;
            throw error;
          })
      : Promise.resolve();
    this.#publishManagedWorkCheckpoint =
      publishManagedWorkCheckpoint ??
      ((requestId, manifestReference, verification) =>
        this.#factory.publishManagedWorkCheckpoint(
          requestId,
          manifestReference,
          verification,
        ));
    this.#snapshotStorage = environment.CHECKPOINTS
      ? new R2WorkspaceSnapshotStorage(environment.CHECKPOINTS)
      : undefined;
    this.#exportCheckpoint = ({ captureId, captureRequestId, threadId }) =>
      this.#managedWork(threadId).exportManagedWorkCheckpoint({
        captureId,
        captureRequestId,
      });
    this.#handle = createFactoryHttpHandler(
      this.#factory,
      {
        context: async (threadId) => this.#managedWork(threadId).context(),
        status: async (threadId) => this.#managedWork(threadId).status(),
        exportCheckpoint: this.#exportCheckpoint,
      },
      undefined,
      this.#snapshotStorage,
      environment.CHECKPOINTS
        ? (requestId) => this.#privateCheckpointStorage(requestId)
        : undefined,
    );
  }

  publishManagedWorkCheckpoint(
    requestId: string,
    manifestReference: string,
    verification: Parameters<FactoryService["publishManagedWorkCheckpoint"]>[2],
  ) {
    return this.#factory.publishManagedWorkCheckpoint(
      requestId,
      manifestReference,
      verification,
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
    await this.#ready;
    const pathname = new URL(request.url).pathname;
    const inputRoute =
      request.method === "POST" &&
      /^\/v1\/threads\/[^/]+\/inputs$/.test(pathname);
    const checkpointRoute =
      request.method === "POST" &&
      /^\/v1\/threads\/[^/]+\/managed-work-checkpoints$/.test(pathname);
    if (inputRoute) await this.#armQueueAlarm();
    if (checkpointRoute && this.environment.CHECKPOINTS) {
      await this.#armCheckpointRecoveryAlarm();
    }
    const response = await this.#handle(request);
    if (checkpointRoute && response.status === 202) {
      await this.#armCheckpointRecoveryAlarm();
      this.state.waitUntil(this.#dispatchQueued());
    }
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
    await this.#ready;
    try {
      const session = await this.#factory.authenticate(credential);
      this.#factory.requirePrivateAssistantOwner(session);
      return {
        authorized: true,
        status: 200,
        code: "authorized",
        credentialId: session.credentialId,
      };
    } catch (error) {
      return error instanceof FactoryError
        ? { authorized: false, status: error.status, code: error.code }
        : { authorized: false, status: 500, code: "internal_error" };
    }
  }

  /** Trusted Durable Object RPC used only by the sibling managed-work binding. */
  getManagedWorkCaptureState(threadId: string) {
    return this.#factory.getManagedWorkCaptureState(threadId);
  }

  acquireManagedWorkRuntimePermit(threadId: string) {
    return this.#factory.acquireManagedWorkRuntimePermit(threadId);
  }

  releaseManagedWorkRuntimePermit(threadId: string, permitId: string) {
    return this.#factory.releaseManagedWorkRuntimePermit(threadId, permitId);
  }

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
    await this.#ready;
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
      await this.#drainManagedWorkCheckpointAssemblies();
    };
    this.#draining = drain()
      .catch(() => {})
      .finally(async () => {
        this.#draining = undefined;
        if (this.#factory.listManagedWorkCheckpointAssemblies(1).length > 0) {
          await this.#armCheckpointRecoveryAlarm();
        } else {
          await this.state.storage.deleteAlarm();
        }
      });
    return this.#draining;
  }

  async #drainManagedWorkCheckpointAssemblies(): Promise<void> {
    while (true) {
      const requestIds = this.#factory.listManagedWorkCheckpointAssemblies(32);
      if (requestIds.length === 0) return;
      for (const requestId of requestIds) {
        await this.#assembleManagedWorkCheckpoint(requestId);
      }
    }
  }

  async #assembleManagedWorkCheckpoint(requestId: string): Promise<void> {
    let stage: ManagedWorkCheckpointStage = "admitted";
    try {
      const assembly =
        await this.#factory.getManagedWorkCheckpointAssembly(requestId);
      if (assembly.request.status !== "assembling") return;
      stage = assembly.request.stage;
      let runtimeRequirements = assembly.runtimeRequirements;
      const storage = this.#privateCheckpointStorage(requestId);
      const privateArtifacts: ManagedWorkCheckpointArtifactReference[] = [
        ...assembly.privateArtifacts,
      ];
      if (
        stage === "runtime-export-started" ||
        stage === "evidence-write-started" ||
        stage === "bundle-compose-started"
      ) {
        this.#factory.markManagedWorkCheckpointOutcome(requestId, "uncertain");
        return;
      }

      if (stage === "admitted") {
        await this.#factory.beginManagedWorkCheckpointStage(
          requestId,
          "admitted",
          "runtime-export-started",
        );
        stage = "runtime-export-started";
        const exported = await this.#exportCheckpoint({
          captureId: assembly.request.captureId,
          captureRequestId: assembly.request.captureRequestId,
          threadId: assembly.request.threadId,
        });
        if (
          exported.captureId !== assembly.request.captureId ||
          exported.captureRequestId !== assembly.request.captureRequestId ||
          exported.threadId !== assembly.request.threadId ||
          exported.target.nodeId !== assembly.request.target.nodeId ||
          exported.target.workspaceId !== assembly.request.target.workspaceId ||
          exported.ownershipGeneration !==
            assembly.request.ownershipGeneration ||
          !Number.isSafeInteger(exported.sizeBytes) ||
          exported.sizeBytes !== exported.bytes.byteLength ||
          exported.bytes.byteLength > 32 * 1024 * 1024
        ) {
          throw new Error(
            "Managed-work export does not match its admitted capture",
          );
        }
        const managedWork = parseJsonBytes(exported.bytes);
        const validated = await prepareManagedWorkCheckpointArtifact(
          managedWork,
          32 * 1024 * 1024,
        );
        if (
          validated.checkpoint.sha256 !== exported.checkpointSha256 ||
          validated.checkpoint.rootConversationId !==
            exported.rootConversationId ||
          validated.checkpoint.profile !== exported.profile ||
          !equalBytes(validated.bytes, exported.bytes)
        ) {
          throw new Error(
            "Managed-work export checksum or profile metadata mismatch",
          );
        }
        const sourceRequirements = sourceRuntimeRequirementsForExport(
          exported,
          assembly.request,
        );
        const prepared = await prepareManagedWorkBundleComposition({
          managedWork: validated.checkpoint,
          compatibilityRequirements: sourceRequirements,
          attachments: [
            {
              name: "factory-provenance.json",
              mediaType: "application/json",
              bytes: assembly.evidenceBytes,
            },
          ],
        });
        const artifact = await this.#persistCheckpointArtifact(
          storage,
          "runtime",
          prepared.runtimeBytes,
        );
        await this.#factory.recordManagedWorkCheckpointArtifacts(
          requestId,
          "runtime-export-started",
          "runtime-export-recorded",
          [artifact],
          prepared.requirements,
        );
        runtimeRequirements = [...prepared.requirements];
        privateArtifacts.push(artifact);
        stage = "runtime-export-recorded";
      }

      if (stage === "runtime-export-recorded") {
        await this.#factory.beginManagedWorkCheckpointStage(
          requestId,
          "runtime-export-recorded",
          "evidence-write-started",
        );
        stage = "evidence-write-started";
        const artifact = await this.#persistCheckpointArtifact(
          storage,
          "evidence",
          assembly.evidenceBytes,
        );
        await this.#factory.recordManagedWorkCheckpointArtifacts(
          requestId,
          "evidence-write-started",
          "evidence-recorded",
          [artifact],
        );
        privateArtifacts.push(artifact);
        stage = "evidence-recorded";
      }

      if (stage === "evidence-recorded") {
        const runtimeArtifact = requireCheckpointArtifact(
          privateArtifacts,
          "runtime",
        );
        const evidenceArtifact = requireCheckpointArtifact(
          privateArtifacts,
          "evidence",
        );
        const [runtimeBytes, evidenceBytes] = await Promise.all([
          this.#readCheckpointArtifact(storage, runtimeArtifact),
          this.#readCheckpointArtifact(storage, evidenceArtifact),
        ]);
        if (!equalBytes(evidenceBytes, assembly.evidenceBytes)) {
          throw new Error(
            "Stored provenance evidence no longer matches Core receipts",
          );
        }
        if (!runtimeRequirements) {
          throw new Error("Persisted source runtime requirements are missing");
        }
        const prepared = await prepareManagedWorkBundleComposition({
          managedWork: parseJsonBytes(runtimeBytes),
          compatibilityRequirements: runtimeRequirements,
          attachments: [
            {
              name: "factory-provenance.json",
              mediaType: "application/json",
              bytes: evidenceBytes,
            },
          ],
        });
        if (
          prepared.runtimeReference !== runtimeArtifact.reference ||
          !equalBytes(prepared.runtimeBytes, runtimeBytes)
        ) {
          throw new Error(
            "Stored runtime artifact failed v1 preparation checks",
          );
        }
        const source = await this.#readWorkspaceManifest(assembly);
        await this.#factory.beginManagedWorkCheckpointStage(
          requestId,
          "evidence-recorded",
          "bundle-compose-started",
        );
        stage = "bundle-compose-started";
        const composed = await composeManagedWorkBundleFromWorkspace({
          prepared,
          workspaceManifest: source.manifest,
          workspaceManifestReference: assembly.sourceWorkspaceManifestReference,
          workspaceManifestBytes: source.bytes,
          transport: storage,
        });
        const outerBytes = new TextEncoder().encode(
          canonicalManagedWorkJson(composed.manifest),
        );
        const innerBytes = new TextEncoder().encode(
          JSON.stringify(composed.manifest.workspace),
        );
        const innerArtifact = await this.#persistCheckpointArtifact(
          storage,
          "inner-manifest",
          innerBytes,
        );
        const outerArtifact = await this.#persistCheckpointArtifact(
          storage,
          "outer-manifest",
          outerBytes,
        );
        if (
          innerArtifact.reference !==
            composed.manifest.workspaceManifestReference ||
          outerArtifact.reference !== composed.manifestReference
        ) {
          throw new Error(
            "Composed manifest references do not match stored bytes",
          );
        }
        await this.#factory.recordManagedWorkCheckpointArtifacts(
          requestId,
          "bundle-compose-started",
          "bundle-composed",
          [innerArtifact, outerArtifact],
        );
        privateArtifacts.push(innerArtifact, outerArtifact);
        stage = "bundle-composed";
      }

      if (
        stage === "bundle-composed" ||
        stage === "closure-verification-started"
      ) {
        const outer = requireCheckpointArtifact(
          privateArtifacts,
          "outer-manifest",
        );
        if (stage === "bundle-composed") {
          await this.#factory.beginManagedWorkCheckpointStage(
            requestId,
            "bundle-composed",
            "closure-verification-started",
          );
          stage = "closure-verification-started";
        }
        if (!runtimeRequirements) {
          throw new Error("Persisted source runtime requirements are missing");
        }
        const verification = await verifyManagedWorkCheckpointClosure({
          checkpointRequestId: requestId,
          captureId: assembly.request.captureId,
          sourceWorkspaceManifestReference:
            assembly.sourceWorkspaceManifestReference,
          authoritativeWorkspaceReferences:
            assembly.authoritativeWorkspaceReferences,
          authorizedCommandPlacements: assembly.authorizedCommandPlacements,
          manifestReference: outer.reference,
          expectedRuntimeRequirements: runtimeRequirements,
          expectedEvidence: assembly.evidence,
          privateArtifacts,
          workspaceStorage: this.#snapshotStorage!,
          privateStorage: storage,
        });
        await this.#publishManagedWorkCheckpoint(
          requestId,
          outer.reference,
          verification,
        );
      }
    } catch {
      const uncertain =
        stage === "runtime-export-started" ||
        stage === "evidence-write-started" ||
        stage === "bundle-compose-started";
      this.#factory.markManagedWorkCheckpointOutcome(
        requestId,
        uncertain ? "uncertain" : "blocked",
      );
    }
  }

  async #persistCheckpointArtifact(
    storage: ManagedWorkCheckpointPrivateStorage,
    role: ManagedWorkCheckpointArtifactReference["role"],
    bytes: Uint8Array,
  ): Promise<ManagedWorkCheckpointArtifactReference> {
    const reference = await storage.putBlob(bytes);
    const artifact = { role, reference, size: bytes.byteLength };
    const persisted = await this.#readCheckpointArtifact(storage, artifact);
    if (!equalBytes(persisted, bytes)) {
      throw new Error(
        "Private checkpoint write failed read-after-write verification",
      );
    }
    return artifact;
  }

  async #readCheckpointArtifact(
    storage: ManagedWorkCheckpointPrivateStorage,
    artifact: ManagedWorkCheckpointArtifactReference,
  ): Promise<Uint8Array> {
    const bytes = await storage.getBlob(artifact.reference);
    if (bytes.byteLength !== artifact.size) {
      throw new Error("Private checkpoint artifact size changed");
    }
    return bytes;
  }

  async #readWorkspaceManifest(
    assembly: Awaited<
      ReturnType<FactoryService["getManagedWorkCheckpointAssembly"]>
    >,
  ): Promise<{ manifest: WorkspaceCheckpointManifest; bytes: Uint8Array }> {
    if (!this.#snapshotStorage) {
      throw new Error("Workspace snapshot storage is unavailable");
    }
    const stored = await this.#snapshotStorage.getBlob(
      assembly.request.captureId,
      assembly.sourceWorkspaceManifestReference,
    );
    if (!stored || stored.size > PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES) {
      await stored?.body.cancel().catch(() => {});
      throw new Error("Authoritative workspace manifest is unavailable");
    }
    const bytes = await readBoundedStream(
      stored.body,
      PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
    );
    if (
      bytes.byteLength !== stored.size ||
      sha256Bytes(bytes) !== assembly.sourceWorkspaceManifestReference
    ) {
      throw new Error(
        "Authoritative workspace manifest failed integrity verification",
      );
    }
    const value = parseJsonBytes(bytes);
    const references = portableWorkspaceBlobReferences(
      value,
      assembly.sourceWorkspaceManifestReference,
      bytes.byteLength,
    );
    if (
      !sameReferences(references, assembly.authoritativeWorkspaceReferences)
    ) {
      throw new Error(
        "Workspace manifest does not match Core's source references",
      );
    }
    return { manifest: value as WorkspaceCheckpointManifest, bytes };
  }

  #privateCheckpointStorage(requestId: string): R2ManagedWorkCheckpointStorage {
    if (!this.environment.CHECKPOINTS) {
      throw new FactoryError(
        503,
        "managed_work_checkpoint_storage_unavailable",
      );
    }
    return new R2ManagedWorkCheckpointStorage(
      this.environment.CHECKPOINTS,
      requestId,
    );
  }

  async #armCheckpointRecoveryAlarm(): Promise<void> {
    const alarm = Date.now() + 1_000;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > alarm) {
      await this.state.storage.setAlarm(alarm);
    }
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

function requireCheckpointArtifact(
  artifacts: readonly ManagedWorkCheckpointArtifactReference[],
  role: ManagedWorkCheckpointArtifactReference["role"],
): ManagedWorkCheckpointArtifactReference {
  const matches = artifacts.filter((artifact) => artifact.role === role);
  if (matches.length !== 1) {
    throw new Error(`Expected one persisted ${role} artifact`);
  }
  return matches[0]!;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Checkpoint JSON artifact is malformed");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes)
        throw new Error("Checkpoint manifest exceeds its byte limit");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sha256Bytes(bytes: Uint8Array): string {
  const hash = new Sha256Stream();
  hash.update(bytes);
  return hash.digest();
}

function sameReferences(
  left: readonly { reference: string; size: number }[],
  right: readonly { reference: string; size: number }[],
): boolean {
  if (left.length !== right.length) return false;
  const sort = (values: readonly { reference: string; size: number }[]) =>
    [...values].sort((a, b) => a.reference.localeCompare(b.reference));
  const a = sort(left);
  const b = sort(right);
  return a.every(
    (item, index) =>
      item.reference === b[index]?.reference && item.size === b[index]?.size,
  );
}
