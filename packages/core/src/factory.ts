import { CONTRACT_VERSION, actorIdentitySchema } from "@uzina/contracts";
import {
  factoryCommandReceiptSchema,
  factoryEventSchema,
  factoryNodeSchema,
  factoryProjectSchema,
  factoryQueueJobSchema,
  factoryThreadSchema,
  factoryWorkspaceSchema,
  type FactoryActor,
  type FactoryCommandReceipt,
  type FactoryQueueJob,
  type ManagedRuntimeDispatch,
} from "@uzina/contracts/factory";
import {
  EXECUTION_CONTRACT_VERSION,
  executionHeartbeatRequestSchema,
  executionHeartbeatResponseSchema,
  executionJobReportSchema,
  executionJobSchema,
  executionReceiptSchema,
  executionRegisterRequestSchema,
  executionRegisterResponseSchema,
  executionReportResponseSchema,
  type ExecutionHeartbeatRequest,
  type ExecutionJob,
  type ExecutionJobReport,
  type ExecutionReceipt,
  type ExecutionRegisterRequest,
  type ExecutionWorkspaceReport,
} from "@uzina/contracts/execution";
import type { FactoryDatabase } from "./database";
import { initializeFactoryDatabase } from "./database";

export class FactoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "FactoryError";
  }
}

export interface FactorySession {
  readonly credentialId: string;
  readonly actor: FactoryActor;
}

export interface BootstrapResult {
  credentialId: string;
  name: string;
  credential: string;
  actor: FactoryActor;
}

export type DispatchIntent = FactoryQueueJob;
export type RuntimeDispatchAdapter = ManagedRuntimeDispatch;

type ActorRow = { owner_id: string };
type CredentialRow = {
  credential_id: string;
  actor_json: string;
  revoked_at: string | null;
};
type ProjectRow = { project_id: string; name: string; created_at: string };
type NodeRow = {
  node_id: string;
  name: string;
  availability: string;
  last_seen_at: string | null;
};
type WorkspaceRow = { workspace_id: string; node_id: string; name: string };
type ThreadRow = {
  thread_id: string;
  project_id: string;
  title: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  created_at: string;
};
type IntentRow = {
  job_id: string;
  request_id: string;
  actor_json: string;
  project_id: string;
  thread_id: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  payload_json: string;
  payload_hash: string;
  status: FactoryCommandReceipt["dispatchStatus"];
  outcome: string | null;
  created_at: string;
  updated_at: string;
};
type ReceiptRow = {
  request_id: string;
  actor_json: string;
  thread_id: string;
  payload_hash: string;
  job_id: string;
  accepted_at: string;
};
type StoredCredential = BootstrapResult & { tokenHash: string };
type ExecutionNodeStateRow = {
  node_id: string;
  daemon_version: string;
  capabilities_json: string;
  registered_at: string;
  last_seen_at: string;
};
type ExecutionWorkspaceRow = {
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  state: "active" | "fenced";
};
type ExecutionJobRow = {
  job_id: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  operation: ExecutionJob["operation"];
  payload_json: string;
  payload_sha256: string;
  status: "queued" | "claimed" | "completed" | "failed" | "uncertain";
  accepted_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  report_json: string | null;
  report_sha256: string | null;
  error_code: string | null;
};
type EventRow = {
  cursor: number;
  type: string;
  actor_json: string;
  project_id: string | null;
  thread_id: string | null;
  request_id: string | null;
  payload_json: string;
  created_at: string;
};

const NODE_HEARTBEAT_TTL_MS = 90_000;
const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function token(kind: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `uz_${kind}_${encoded}`;
}

function parseActor(serialized: string): FactoryActor {
  return actorIdentitySchema.parse(JSON.parse(serialized));
}

function authError(): FactoryError {
  return new FactoryError(
    401,
    "unauthorized",
    "A valid, active credential is required",
  );
}

function forbidden(): FactoryError {
  return new FactoryError(
    403,
    "forbidden",
    "This credential kind cannot perform that operation",
  );
}

function notFound(resource: string): FactoryError {
  return new FactoryError(404, "not_found", `${resource} was not found`);
}

function conflict(code: string, message: string): FactoryError {
  return new FactoryError(409, code, message);
}

function encode<T>(value: T): string {
  return JSON.stringify(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class FactoryService {
  readonly #bootstrapSecret: string | undefined;

  constructor(database: FactoryDatabase, bootstrapSecret?: string) {
    this.database = database;
    this.#bootstrapSecret = bootstrapSecret;
    initializeFactoryDatabase(database);
    this.#markInterruptedDispatchesUncertain();
  }

  readonly database: FactoryDatabase;

  async bootstrap(secret: string, name: string): Promise<BootstrapResult> {
    if (
      !this.#bootstrapSecret ||
      !(await this.#sameSecret(secret, this.#bootstrapSecret))
    ) {
      throw authError();
    }
    const ownerId = "user:owner";
    const actor = actorIdentitySchema.parse({
      contractVersion: CONTRACT_VERSION,
      kind: "human",
      userId: ownerId,
    });
    const credential = token("human");
    const tokenHash = await sha256(credential);
    const credentialId = makeId("credential");
    const createdAt = now();

    this.database.transaction(() => {
      if (
        this.database.all(
          "SELECT singleton FROM factory_meta WHERE singleton = 1",
        ).length
      ) {
        throw conflict(
          "already_bootstrapped",
          "The private owner bootstrap has already been used",
        );
      }
      this.database.exec(
        "INSERT INTO factory_meta (singleton, owner_id, ownership_generation) VALUES (1, ?, 0)",
        [ownerId],
      );
      this.database.exec(
        "INSERT INTO credentials (credential_id, token_hash, actor_json, name, created_at) VALUES (?, ?, ?, ?, ?)",
        [credentialId, tokenHash, encode(actor), name, createdAt],
      );
      this.#event(
        "factory.bootstrapped",
        actor,
        null,
        null,
        null,
        { ownerId, name },
        createdAt,
      );
    });
    return { credentialId, name, credential, actor };
  }

  async authenticate(
    credential: string | null | undefined,
  ): Promise<FactorySession> {
    if (!credential) throw authError();
    const tokenHash = await sha256(credential);
    const rows = this.database.all<CredentialRow>(
      "SELECT credential_id, actor_json, revoked_at FROM credentials WHERE token_hash = ?",
      [tokenHash],
    );
    const row = rows[0];
    if (!row || row.revoked_at !== null) throw authError();
    return {
      credentialId: row.credential_id,
      actor: parseActor(row.actor_json),
    };
  }

  async provisionCredential(
    session: FactorySession,
    kind: "human" | "assistant",
    name: string,
  ): Promise<BootstrapResult> {
    const ownerId = this.#requireOwner(session);
    const actor = actorIdentitySchema.parse(
      kind === "human"
        ? { contractVersion: CONTRACT_VERSION, kind: "human", userId: ownerId }
        : {
            contractVersion: CONTRACT_VERSION,
            kind: "assistant",
            assistantId: makeId("assistant"),
            ownerId,
          },
    );
    return this.#insertCredential(session, actor, name);
  }

  async provisionNode(
    session: FactorySession,
    nodeId: string | undefined,
    name: string,
  ): Promise<{
    node: ReturnType<typeof factoryNodeSchema.parse>;
    credential: BootstrapResult;
  }> {
    this.#requireOwner(session);
    const id = nodeId ?? makeId("node");
    const createdAt = now();
    const actor = actorIdentitySchema.parse({
      contractVersion: CONTRACT_VERSION,
      kind: "node",
      nodeId: id,
    });
    const credential = await this.#newCredential(actor, name);
    this.database.transaction(() => {
      this.#requireOwner(session);
      if (
        this.database.all("SELECT node_id FROM nodes WHERE node_id = ?", [id])
          .length
      ) {
        throw conflict(
          "node_exists",
          "The node identifier is already registered",
        );
      }
      this.database.exec(
        "INSERT INTO nodes (node_id, name, availability, last_seen_at) VALUES (?, ?, 'offline', NULL)",
        [id, name],
      );
      this.#insertCredentialRows(credential, createdAt);
      this.#event(
        "node.provisioned",
        session.actor,
        null,
        null,
        null,
        { nodeId: id, name, credentialId: credential.credentialId },
        createdAt,
      );
    });
    return {
      node: this.#node({
        node_id: id,
        name,
        availability: "offline",
        last_seen_at: null,
      }),
      credential: {
        credentialId: credential.credentialId,
        name: credential.name,
        credential: credential.credential,
        actor: credential.actor,
      },
    };
  }

  listCredentials(session: FactorySession) {
    this.#requireOwner(session);
    return this.database
      .all<{
        credential_id: string;
        actor_json: string;
        name: string;
        revoked_at: string | null;
        created_at: string;
      }>(
        "SELECT credential_id, actor_json, name, revoked_at, created_at FROM credentials ORDER BY created_at, credential_id",
      )
      .map((row) => ({
        credentialId: row.credential_id,
        actor: parseActor(row.actor_json),
        name: row.name,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      }));
  }

  async revokeCredential(
    session: FactorySession,
    credentialId: string,
  ): Promise<void> {
    this.#requireOwner(session);
    const target = this.database.all<CredentialRow>(
      "SELECT credential_id, actor_json, revoked_at FROM credentials WHERE credential_id = ?",
      [credentialId],
    )[0];
    if (!target) throw notFound("Credential");
    if (target.revoked_at) return;
    const timestamp = now();
    const actor = session.actor;
    this.database.transaction(() => {
      this.#requireOwner(session);
      this.database.exec(
        "UPDATE credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
        [timestamp, credentialId],
      );
      this.#event(
        "credential.revoked",
        actor,
        null,
        null,
        null,
        { credentialId },
        timestamp,
      );
    });
  }

  createProject(
    session: FactorySession,
    projectId: string | undefined,
    name: string,
  ) {
    this.#requireOwner(session);
    const id = projectId ?? makeId("project");
    const createdAt = now();
    this.database.transaction(() => {
      if (
        this.database.all(
          "SELECT project_id FROM projects WHERE project_id = ?",
          [id],
        ).length
      ) {
        throw conflict(
          "project_exists",
          "The project identifier is already in use",
        );
      }
      this.database.exec(
        "INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)",
        [id, name, createdAt],
      );
      this.#event(
        "project.created",
        session.actor,
        id,
        null,
        null,
        { projectId: id, name },
        createdAt,
      );
    });
    return factoryProjectSchema.parse({
      contractVersion: CONTRACT_VERSION,
      projectId: id,
      name,
      createdAt,
    });
  }

  listProjects(session: FactorySession) {
    this.#requireHumanOrAssistant(session);
    return this.database
      .all<ProjectRow>(
        "SELECT project_id, name, created_at FROM projects ORDER BY created_at, project_id",
      )
      .map((row) =>
        factoryProjectSchema.parse({
          contractVersion: CONTRACT_VERSION,
          projectId: row.project_id,
          name: row.name,
          createdAt: row.created_at,
        }),
      );
  }

  listNodes(session: FactorySession) {
    this.#requireHumanOrAssistant(session);
    return this.database
      .all<NodeRow>(
        "SELECT node_id, name, availability, last_seen_at FROM nodes ORDER BY node_id",
      )
      .map((row) => this.#node(row));
  }

  createWorkspace(
    session: FactorySession,
    workspaceId: string | undefined,
    nodeId: string,
    name: string,
  ) {
    this.#requireOwner(session);
    const id = workspaceId ?? makeId("workspace");
    const node = this.database.all(
      "SELECT node_id FROM nodes WHERE node_id = ?",
      [nodeId],
    )[0];
    if (!node) throw notFound("Execution node");
    this.database.transaction(() => {
      if (
        this.database.all(
          "SELECT workspace_id FROM workspaces WHERE workspace_id = ?",
          [id],
        ).length
      ) {
        throw conflict(
          "workspace_exists",
          "The workspace identifier is already in use",
        );
      }
      this.database.exec(
        "INSERT INTO workspaces (workspace_id, node_id, name) VALUES (?, ?, ?)",
        [id, nodeId, name],
      );
      this.#event(
        "workspace.created",
        session.actor,
        null,
        null,
        null,
        { workspaceId: id, nodeId, name },
        now(),
      );
    });
    return factoryWorkspaceSchema.parse({
      contractVersion: CONTRACT_VERSION,
      workspaceId: id,
      nodeId,
      name,
    });
  }

  listWorkspaces(session: FactorySession) {
    this.#requireHumanOrAssistant(session);
    return this.database
      .all<WorkspaceRow>(
        "SELECT workspace_id, node_id, name FROM workspaces ORDER BY node_id, workspace_id",
      )
      .map((row) =>
        factoryWorkspaceSchema.parse({
          contractVersion: CONTRACT_VERSION,
          workspaceId: row.workspace_id,
          nodeId: row.node_id,
          name: row.name,
        }),
      );
  }

  createThread(
    session: FactorySession,
    input: {
      threadId?: string;
      projectId: string;
      title: string;
      target: { nodeId: string; workspaceId: string };
    },
  ) {
    this.#requireOwner(session);
    const project = this.database.all(
      "SELECT project_id FROM projects WHERE project_id = ?",
      [input.projectId],
    )[0];
    if (!project) throw notFound("Project");
    const node = this.database.all<NodeRow>(
      "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
      [input.target.nodeId],
    )[0];
    const workspace = this.database.all<WorkspaceRow>(
      "SELECT workspace_id, node_id, name FROM workspaces WHERE workspace_id = ?",
      [input.target.workspaceId],
    )[0];
    if (!node || !workspace) throw notFound("Execution placement");
    if (workspace.node_id !== input.target.nodeId)
      throw conflict(
        "placement_mismatch",
        "Workspace is not assigned to the selected node",
      );
    const threadId = input.threadId ?? makeId("thread");
    const createdAt = now();
    const generation = this.#ownershipGeneration();
    this.database.transaction(() => {
      if (
        this.database.all("SELECT thread_id FROM threads WHERE thread_id = ?", [
          threadId,
        ]).length
      ) {
        throw conflict(
          "thread_exists",
          "The thread identifier is already in use",
        );
      }
      this.database.exec(
        "INSERT INTO threads (thread_id, project_id, title, node_id, workspace_id, ownership_generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          threadId,
          input.projectId,
          input.title,
          input.target.nodeId,
          input.target.workspaceId,
          generation,
          createdAt,
        ],
      );
      this.#event(
        "thread.created",
        session.actor,
        input.projectId,
        threadId,
        null,
        { target: input.target, ownershipGeneration: generation },
        createdAt,
      );
    });
    return factoryThreadSchema.parse({
      contractVersion: CONTRACT_VERSION,
      threadId,
      projectId: input.projectId,
      title: input.title,
      target: input.target,
      ownershipGeneration: generation,
      createdAt,
    });
  }

  listThreads(session: FactorySession, projectId?: string) {
    this.#requireHumanOrAssistant(session);
    const rows = projectId
      ? this.database.all<ThreadRow>(
          "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, created_at FROM threads WHERE project_id = ? ORDER BY created_at, thread_id",
          [projectId],
        )
      : this.database.all<ThreadRow>(
          "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, created_at FROM threads ORDER BY created_at, thread_id",
        );
    return rows.map((row) => this.#thread(row));
  }

  async submitInput(
    session: FactorySession,
    threadId: string,
    requestId: string,
    text: string,
  ): Promise<FactoryCommandReceipt> {
    this.#requireHumanOrAssistant(session);
    const thread = this.database.all<ThreadRow>(
      "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, created_at FROM threads WHERE thread_id = ?",
      [threadId],
    )[0];
    if (!thread) throw notFound("Thread");
    const actorJson = encode(session.actor);
    const payload = { threadId, text };
    const payloadHash = await sha256(encode(payload));
    const existing = this.database.all<ReceiptRow>(
      "SELECT request_id, actor_json, thread_id, payload_hash, job_id, accepted_at FROM command_receipts WHERE request_id = ?",
      [requestId],
    )[0];
    if (existing) {
      if (
        existing.payload_hash !== payloadHash ||
        existing.thread_id !== threadId ||
        existing.actor_json !== actorJson
      ) {
        throw conflict(
          "request_id_conflict",
          "This request ID was already used for a different actor or payload",
        );
      }
      return this.#receiptByJob(existing.job_id);
    }

    const jobId = makeId("job");
    const acceptedAt = now();
    const generation = this.#ownershipGeneration();
    if (Number(thread.ownership_generation) !== generation) {
      throw conflict(
        "ownership_fenced",
        "This thread is not assigned to the current ownership generation",
      );
    }
    const queuePayload = {
      contractVersion: CONTRACT_VERSION,
      jobId,
      requestId,
      threadId,
      actor: session.actor,
      target: { nodeId: thread.node_id, workspaceId: thread.workspace_id },
      ownershipGeneration: generation,
      input: { kind: "managed-input" as const, text },
    };
    const queuePayloadJson = encode(queuePayload);
    let acceptedStatus: "queued" | "unavailable" = "unavailable";

    this.database.transaction(() => {
      this.#requireHumanOrAssistant(session);
      const raced = this.database.all<ReceiptRow>(
        "SELECT request_id, actor_json, thread_id, payload_hash, job_id, accepted_at FROM command_receipts WHERE request_id = ?",
        [requestId],
      )[0];
      if (raced) {
        if (
          raced.payload_hash !== payloadHash ||
          raced.thread_id !== threadId ||
          raced.actor_json !== actorJson
        ) {
          throw conflict(
            "request_id_conflict",
            "This request ID was already used for a different actor or payload",
          );
        }
        return;
      }
      const currentGeneration = this.#ownershipGeneration();
      const currentThread = this.database.all<ThreadRow>(
        "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, created_at FROM threads WHERE thread_id = ?",
        [threadId],
      )[0];
      if (
        currentGeneration !== generation ||
        !currentThread ||
        Number(currentThread.ownership_generation) !== currentGeneration ||
        currentThread.node_id !== thread.node_id ||
        currentThread.workspace_id !== thread.workspace_id
      ) {
        throw conflict(
          "ownership_fenced",
          "The thread placement changed before this request could be admitted",
        );
      }
      const currentNode = this.database.all<NodeRow>(
        "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
        [currentThread.node_id],
      )[0];
      acceptedStatus =
        currentNode && this.#isNodeOnline(currentNode)
          ? "queued"
          : "unavailable";
      this.database.exec(
        `INSERT INTO dispatch_intents (job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobId,
          requestId,
          actorJson,
          currentThread.project_id,
          threadId,
          currentThread.node_id,
          currentThread.workspace_id,
          generation,
          queuePayloadJson,
          payloadHash,
          acceptedStatus,
          acceptedStatus === "queued"
            ? null
            : "The explicitly assigned execution node is unavailable",
          acceptedAt,
          acceptedAt,
        ],
      );
      this.database.exec(
        "INSERT INTO command_receipts (request_id, actor_json, thread_id, payload_hash, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)",
        [requestId, actorJson, threadId, payloadHash, jobId, acceptedAt],
      );
      this.#event(
        "command.accepted",
        session.actor,
        currentThread.project_id,
        threadId,
        requestId,
        {
          jobId,
          target: {
            nodeId: currentThread.node_id,
            workspaceId: currentThread.workspace_id,
          },
          ownershipGeneration: generation,
        },
        acceptedAt,
      );
      if (acceptedStatus === "unavailable") {
        this.#event(
          "dispatch.unavailable",
          session.actor,
          currentThread.project_id,
          threadId,
          requestId,
          {
            jobId,
            nodeId: currentThread.node_id,
            workspaceId: currentThread.workspace_id,
          },
          acceptedAt,
        );
      }
    });
    return this.#receiptByRequest(requestId);
  }

  getReceipt(
    session: FactorySession,
    requestId: string,
  ): FactoryCommandReceipt {
    this.#requireHumanOrAssistant(session);
    const receipt = this.database.all<ReceiptRow>(
      "SELECT request_id, actor_json, thread_id, payload_hash, job_id, accepted_at FROM command_receipts WHERE request_id = ?",
      [requestId],
    )[0];
    if (!receipt) throw notFound("Command receipt");
    return this.#receiptByJob(receipt.job_id);
  }

  events(session: FactorySession, after: number, limit = 100) {
    this.#requireHumanOrAssistant(session);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new FactoryError(
        400,
        "invalid_cursor",
        "Event cursors must be nonnegative and limits must be 1–500",
      );
    }
    const rows = this.database.all<EventRow>(
      "SELECT cursor, type, actor_json, project_id, thread_id, request_id, payload_json, created_at FROM factory_events WHERE cursor > ? ORDER BY cursor LIMIT ?",
      [after, limit],
    );
    const parsed = rows.map((row) =>
      factoryEventSchema.parse({
        contractVersion: CONTRACT_VERSION,
        cursor: Number(row.cursor),
        type: row.type,
        actor: parseActor(row.actor_json),
        projectId: row.project_id,
        threadId: row.thread_id,
        requestId: row.request_id,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
      }),
    );
    return {
      contractVersion: CONTRACT_VERSION,
      events: parsed,
      nextCursor: parsed.at(-1)?.cursor ?? after,
    };
  }

  registerExecutionNode(
    session: FactorySession,
    request: ExecutionRegisterRequest,
  ) {
    const input = executionRegisterRequestSchema.parse(request);
    this.#requireNode(session, input.nodeId);
    const timestamp = now();
    this.#validateReportedWorkspaces(input.nodeId, input.workspaces);
    this.database.transaction(() => {
      this.#requireNode(session, input.nodeId);
      const node = this.database.all<NodeRow>(
        "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
        [input.nodeId],
      )[0];
      if (!node) throw notFound("Execution node");
      this.database.exec(
        `INSERT INTO execution_node_state(node_id, daemon_version, capabilities_json, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET daemon_version = excluded.daemon_version,
           capabilities_json = excluded.capabilities_json, last_seen_at = excluded.last_seen_at`,
        [
          input.nodeId,
          input.daemonVersion,
          encode(input.capabilities),
          timestamp,
          timestamp,
        ],
      );
      this.#storeReportedWorkspaces(input.nodeId, input.workspaces);
      this.database.exec(
        "UPDATE nodes SET availability = 'online', last_seen_at = ? WHERE node_id = ?",
        [timestamp, input.nodeId],
      );
      this.#event(
        "node.registered",
        session.actor,
        null,
        null,
        null,
        {
          nodeId: input.nodeId,
          daemonVersion: input.daemonVersion,
          workspaceCount: input.workspaces.length,
          capabilities: input.capabilities,
        },
        timestamp,
      );
    });
    return executionRegisterResponseSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      nodeId: input.nodeId,
      registered: true,
      controllerTime: timestamp,
    });
  }

  heartbeatExecutionNode(
    session: FactorySession,
    request: ExecutionHeartbeatRequest,
  ) {
    const input = executionHeartbeatRequestSchema.parse(request);
    this.#requireNode(session, input.nodeId);
    const registered = this.database.all<ExecutionNodeStateRow>(
      "SELECT node_id, daemon_version, capabilities_json, registered_at, last_seen_at FROM execution_node_state WHERE node_id = ?",
      [input.nodeId],
    )[0];
    if (!registered) {
      throw conflict(
        "node_not_registered",
        "Register before sending heartbeats",
      );
    }
    const timestamp = now();
    this.#validateReportedWorkspaces(input.nodeId, input.workspaces);
    this.database.transaction(() => {
      this.#requireNode(session, input.nodeId);
      this.#storeReportedWorkspaces(input.nodeId, input.workspaces);
      this.database.exec(
        "UPDATE execution_node_state SET capabilities_json = ?, last_seen_at = ? WHERE node_id = ?",
        [encode(input.capabilities), timestamp, input.nodeId],
      );
      this.database.exec(
        "UPDATE nodes SET availability = 'online', last_seen_at = ? WHERE node_id = ?",
        [timestamp, input.nodeId],
      );
      this.#event(
        "node.heartbeat",
        session.actor,
        null,
        null,
        null,
        { nodeId: input.nodeId, workspaceCount: input.workspaces.length },
        timestamp,
      );
    });
    return executionHeartbeatResponseSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      nodeId: input.nodeId,
      receivedAt: timestamp,
    });
  }

  claimExecutionJob(
    session: FactorySession,
    nodeId: string,
  ): ExecutionJob | null {
    this.#requireNode(session, nodeId);
    return this.database.transaction(() => {
      this.#requireNode(session, nodeId);
      const node = this.database.all<NodeRow>(
        "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
        [nodeId],
      )[0];
      const runtime = this.database.all<ExecutionNodeStateRow>(
        "SELECT node_id, daemon_version, capabilities_json, registered_at, last_seen_at FROM execution_node_state WHERE node_id = ?",
        [nodeId],
      )[0];
      if (!node || !runtime || !this.#isNodeOnline(node)) return null;

      const generation = this.#ownershipGeneration();
      const activeAssignment = this.database.all<ExecutionJobRow>(
        "SELECT * FROM execution_jobs WHERE node_id = ? AND status = 'claimed' ORDER BY claimed_at, job_id LIMIT 1",
        [nodeId],
      )[0];
      const job =
        activeAssignment ??
        this.database.all<ExecutionJobRow>(
          `SELECT jobs.* FROM execution_jobs AS jobs
           JOIN execution_node_workspaces AS workspaces
             ON workspaces.node_id = jobs.node_id AND workspaces.workspace_id = jobs.workspace_id
           WHERE jobs.node_id = ? AND jobs.status = 'queued'
             AND jobs.ownership_generation = ?
             AND workspaces.ownership_generation = jobs.ownership_generation
             AND workspaces.state = 'active'
           ORDER BY jobs.accepted_at, jobs.job_id LIMIT 1`,
          [nodeId, generation],
        )[0];
      if (!job) return null;
      if (
        job.ownership_generation !== generation ||
        !this.#hasActiveWorkspaceReport(
          nodeId,
          job.workspace_id,
          job.ownership_generation,
        )
      ) {
        if (job.status === "queued") {
          this.database.exec(
            "UPDATE execution_jobs SET status = 'failed', finished_at = ?, error_code = 'stale_ownership_generation' WHERE job_id = ? AND status = 'queued'",
            [now(), job.job_id],
          );
        }
        return null;
      }
      const claimNumber =
        this.database.all<{ claim_count: number }>(
          "SELECT COUNT(*) AS claim_count FROM execution_job_claims WHERE job_id = ?",
          [job.job_id],
        )[0]?.claim_count ?? 0;
      const timestamp = now();
      if (job.status === "queued") {
        this.database.exec(
          "UPDATE execution_jobs SET status = 'claimed', claimed_at = ? WHERE job_id = ? AND status = 'queued'",
          [timestamp, job.job_id],
        );
      }
      this.database.exec(
        "INSERT INTO execution_job_claims(job_id, claim_number, node_id, payload_sha256, claimed_at) VALUES (?, ?, ?, ?, ?)",
        [job.job_id, claimNumber + 1, nodeId, job.payload_sha256, timestamp],
      );
      return executionJobSchema.parse(JSON.parse(job.payload_json));
    });
  }

  async reportExecutionJob(
    session: FactorySession,
    nodeId: string,
    jobId: string,
    report: ExecutionJobReport,
  ) {
    const input = executionJobReportSchema.parse(report);
    this.#requireNode(session, nodeId);
    if (input.nodeId !== nodeId || input.jobId !== jobId) {
      throw conflict(
        "assignment_mismatch",
        "Report path and body identities differ",
      );
    }
    const job = this.#executionJob(jobId);
    if (!job) throw notFound("Assigned execution job");
    const payload = executionJobSchema.parse(JSON.parse(job.payload_json));
    if (
      job.node_id !== nodeId ||
      payload.target.nodeId !== input.target.nodeId ||
      job.workspace_id !== input.target.workspaceId ||
      job.ownership_generation !== input.ownershipGeneration ||
      job.payload_sha256 !== input.payloadSha256 ||
      (input.result !== undefined &&
        input.result.operation !== payload.operation)
    ) {
      throw conflict(
        "assignment_mismatch",
        "Report does not match the persisted job target, generation, or payload",
      );
    }
    const reportJson = encode(input);
    const reportHash = await sha256(stableJson(input));
    if (job.report_json !== null) {
      if (job.report_sha256 !== reportHash) {
        throw conflict(
          "report_conflict",
          "A different report is already committed",
        );
      }
      return this.#executionReportAcknowledgement(nodeId, jobId, input.status);
    }
    if (job.status !== "claimed") {
      throw conflict(
        "job_not_claimed",
        "The execution job has no persisted claim",
      );
    }
    this.database.transaction(() => {
      this.#requireNode(session, nodeId);
      const current = this.#executionJob(jobId);
      if (!current) throw notFound("Assigned execution job");
      if (current.report_json !== null) {
        if (current.report_sha256 !== reportHash) {
          throw conflict(
            "report_conflict",
            "A different report is already committed",
          );
        }
        return;
      }
      if (current.status !== "claimed") {
        throw conflict(
          "job_not_claimed",
          "The execution job has no persisted claim",
        );
      }
      this.database.exec(
        `UPDATE execution_jobs SET status = ?, finished_at = ?, report_json = ?,
          report_sha256 = ?, error_code = ? WHERE job_id = ? AND status = 'claimed'`,
        [
          input.status,
          input.finishedAt,
          reportJson,
          reportHash,
          input.errorCode ?? null,
          jobId,
        ],
      );
    });
    return this.#executionReportAcknowledgement(nodeId, jobId, input.status);
  }

  /** Trusted in-process admission seam for the managed remote-tool bridge; no HTTP injection route exists. */
  async enqueueRemoteExecution(input: unknown): Promise<ExecutionReceipt> {
    const job = executionJobSchema.parse(input);
    const payloadJson = encode(job);
    const payloadHash = await sha256(stableJson(job));
    const existing = this.#executionJob(job.jobId);
    if (existing) {
      if (existing.payload_sha256 !== payloadHash) {
        throw conflict(
          "job_id_payload_conflict",
          "Job ID is bound to another payload",
        );
      }
      return this.#executionReceipt(existing);
    }
    this.#assertRemoteExecutionAdmission(job);
    const timestamp = now();
    this.database.transaction(() => {
      const raced = this.#executionJob(job.jobId);
      if (raced) {
        if (raced.payload_sha256 !== payloadHash) {
          throw conflict(
            "job_id_payload_conflict",
            "Job ID is bound to another payload",
          );
        }
        return;
      }
      this.#assertRemoteExecutionAdmission(job);
      this.database.exec(
        `INSERT INTO execution_jobs(job_id, node_id, workspace_id, ownership_generation,
          operation, payload_json, payload_sha256, status, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        [
          job.jobId,
          job.nodeId,
          job.target.workspaceId,
          job.ownershipGeneration,
          job.operation,
          payloadJson,
          payloadHash,
          timestamp,
        ],
      );
    });
    const admitted = this.#executionJob(job.jobId);
    if (!admitted) throw new FactoryError(500, "execution_admission_lost");
    return this.#executionReceipt(admitted);
  }

  /** Read-only result lookup for the trusted in-process managed-tool adapter. */
  getRemoteExecutionReceipt(jobId: string): ExecutionReceipt | null {
    const row = this.#executionJob(jobId);
    return row ? this.#executionReceipt(row) : null;
  }

  /** Dispatches one durable intent through the injected managed-runtime boundary. */
  async dispatchNext(
    adapter: RuntimeDispatchAdapter,
  ): Promise<FactoryCommandReceipt | null> {
    const intent = this.database.transaction(() => {
      const queued = this.database.all<IntentRow>(
        "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE status = 'queued' ORDER BY created_at, job_id LIMIT 1",
      )[0];
      if (!queued) return null;
      const currentGeneration = this.#ownershipGeneration();
      const node = this.database.all<NodeRow>(
        "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
        [queued.node_id],
      )[0];
      if (
        queued.ownership_generation !== currentGeneration ||
        !node ||
        !this.#isNodeOnline(node)
      ) {
        const timestamp = now();
        const detail =
          queued.ownership_generation !== currentGeneration
            ? "The assignment is fenced by a newer ownership generation"
            : "The explicitly assigned execution node is unavailable";
        this.database.exec(
          "UPDATE dispatch_intents SET status = 'unavailable', outcome = ?, updated_at = ? WHERE job_id = ? AND status = 'queued'",
          [detail, timestamp, queued.job_id],
        );
        this.#event(
          "dispatch.unavailable",
          parseActor(queued.actor_json),
          queued.project_id,
          queued.thread_id,
          queued.request_id,
          { jobId: queued.job_id, reason: detail },
          timestamp,
        );
        return null;
      }
      const timestamp = now();
      this.database.exec(
        "UPDATE dispatch_intents SET status = 'running', updated_at = ? WHERE job_id = ? AND status = 'queued'",
        [timestamp, queued.job_id],
      );
      this.#event(
        "dispatch.started",
        parseActor(queued.actor_json),
        queued.project_id,
        queued.thread_id,
        queued.request_id,
        { jobId: queued.job_id },
        timestamp,
      );
      return queued;
    });
    if (!intent) return null;

    let outcome: Awaited<ReturnType<RuntimeDispatchAdapter["dispatch"]>>;
    try {
      outcome = await adapter.dispatch(
        factoryQueueJobSchema.parse(JSON.parse(intent.payload_json)),
      );
    } catch (error) {
      outcome = {
        status: "uncertain",
        detail:
          error instanceof Error
            ? error.message
            : "Runtime dispatch failed without a known outcome",
      };
    }
    const timestamp = now();
    const eventType =
      outcome.status === "dispatched"
        ? "dispatch.dispatched"
        : outcome.status === "failed"
          ? "dispatch.failed"
          : "dispatch.uncertain";
    this.database.transaction(() => {
      const current = this.database.all<IntentRow>(
        "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE job_id = ?",
        [intent.job_id],
      )[0];
      if (current.status !== "running") return;
      this.database.exec(
        "UPDATE dispatch_intents SET status = ?, outcome = ?, updated_at = ? WHERE job_id = ?",
        [outcome.status, outcome.detail ?? null, timestamp, intent.job_id],
      );
      this.#event(
        eventType,
        parseActor(intent.actor_json),
        intent.project_id,
        intent.thread_id,
        intent.request_id,
        { jobId: intent.job_id, detail: outcome.detail ?? null },
        timestamp,
      );
    });
    return this.#receiptByJob(intent.job_id);
  }

  #validateReportedWorkspaces(
    nodeId: string,
    reports: readonly ExecutionWorkspaceReport[],
  ): void {
    const reported = new Set<string>();
    const generation = this.#ownershipGeneration();
    for (const report of reports) {
      if (reported.has(report.workspaceId)) {
        throw new FactoryError(400, "duplicate_workspace_report");
      }
      reported.add(report.workspaceId);
      const workspace = this.database.all<WorkspaceRow>(
        "SELECT workspace_id, node_id, name FROM workspaces WHERE workspace_id = ?",
        [report.workspaceId],
      )[0];
      if (!workspace || workspace.node_id !== nodeId) {
        throw new FactoryError(
          403,
          "workspace_not_permitted",
          "The owner has not assigned this workspace to the authenticated node",
        );
      }
      if (report.ownershipGeneration !== generation) {
        throw conflict(
          "stale_ownership_generation",
          "Workspace report does not match the controller ownership generation",
        );
      }
    }
  }

  #storeReportedWorkspaces(
    nodeId: string,
    reports: readonly ExecutionWorkspaceReport[],
  ): void {
    this.database.exec(
      "DELETE FROM execution_node_workspaces WHERE node_id = ?",
      [nodeId],
    );
    for (const report of reports) {
      this.database.exec(
        "INSERT INTO execution_node_workspaces(node_id, workspace_id, ownership_generation, state) VALUES (?, ?, ?, ?)",
        [nodeId, report.workspaceId, report.ownershipGeneration, report.state],
      );
    }
  }

  #hasActiveWorkspaceReport(
    nodeId: string,
    workspaceId: string,
    generation: number,
  ): boolean {
    const row = this.database.all<ExecutionWorkspaceRow>(
      "SELECT node_id, workspace_id, ownership_generation, state FROM execution_node_workspaces WHERE node_id = ? AND workspace_id = ?",
      [nodeId, workspaceId],
    )[0];
    return Boolean(
      row && row.state === "active" && row.ownership_generation === generation,
    );
  }

  #assertRemoteExecutionAdmission(job: ExecutionJob): void {
    const generation = this.#ownershipGeneration();
    if (job.ownershipGeneration !== generation) {
      throw conflict(
        "stale_ownership_generation",
        "Remote execution admission does not match current ownership",
      );
    }
    const node = this.database.all<NodeRow>(
      "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
      [job.nodeId],
    )[0];
    if (!node || job.target.nodeId !== node.node_id) {
      throw new FactoryError(403, "target_node_mismatch");
    }
    if (!this.#isNodeOnline(node)) {
      throw new FactoryError(
        503,
        "node_offline",
        "The explicitly selected execution node is offline",
      );
    }
    const workspace = this.database.all<WorkspaceRow>(
      "SELECT workspace_id, node_id, name FROM workspaces WHERE workspace_id = ?",
      [job.target.workspaceId],
    )[0];
    if (!workspace || workspace.node_id !== job.nodeId) {
      throw new FactoryError(403, "workspace_not_permitted");
    }
    if (
      !this.#hasActiveWorkspaceReport(
        job.nodeId,
        job.target.workspaceId,
        job.ownershipGeneration,
      )
    ) {
      throw conflict(
        "workspace_unavailable",
        "The node has not reported this workspace active at the requested generation",
      );
    }
    const runtime = this.database.all<ExecutionNodeStateRow>(
      "SELECT node_id, daemon_version, capabilities_json, registered_at, last_seen_at FROM execution_node_state WHERE node_id = ?",
      [job.nodeId],
    )[0];
    if (!runtime) {
      throw conflict(
        "node_not_registered",
        "The node has not registered its executor",
      );
    }
    const capability =
      job.operation === "read-file"
        ? "fileRead"
        : job.operation === "write-file"
          ? "fileWrite"
          : "argvCommand";
    if (JSON.parse(runtime.capabilities_json)[capability] !== true) {
      throw conflict(
        "unsupported_capability",
        `Node does not support ${capability}`,
      );
    }
  }

  #executionJob(jobId: string): ExecutionJobRow | undefined {
    return this.database.all<ExecutionJobRow>(
      "SELECT * FROM execution_jobs WHERE job_id = ?",
      [jobId],
    )[0];
  }

  #executionReceipt(row: ExecutionJobRow): ExecutionReceipt {
    const report = row.report_json
      ? (JSON.parse(row.report_json) as ExecutionJobReport)
      : undefined;
    return executionReceiptSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      jobId: row.job_id,
      nodeId: row.node_id,
      target: { nodeId: row.node_id, workspaceId: row.workspace_id },
      ownershipGeneration: row.ownership_generation,
      operation: row.operation,
      payloadSha256: row.payload_sha256,
      status: row.status === "claimed" ? "running" : row.status,
      acceptedAt: row.accepted_at,
      ...(row.claimed_at ? { startedAt: row.claimed_at } : {}),
      ...(report ? { finishedAt: report.finishedAt } : {}),
      ...(report?.result ? { result: report.result } : {}),
      ...(report?.errorCode ? { errorCode: report.errorCode } : {}),
      ...(report?.reconciliationEvidence
        ? { reconciliationEvidence: report.reconciliationEvidence }
        : {}),
      ...(!report && row.error_code ? { errorCode: row.error_code } : {}),
      ...(!report && row.finished_at ? { finishedAt: row.finished_at } : {}),
    });
  }

  #executionReportAcknowledgement(
    nodeId: string,
    jobId: string,
    status: ExecutionJobReport["status"],
  ) {
    return executionReportResponseSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      nodeId,
      jobId,
      accepted: true,
      status,
    });
  }

  #requireOwner(session: FactorySession): string {
    this.#requireActiveCredential(session);
    if (session.actor.kind !== "human") throw forbidden();
    const owner = this.database.all<ActorRow>(
      "SELECT owner_id FROM factory_meta WHERE singleton = 1",
    )[0];
    if (!owner || session.actor.userId !== owner.owner_id) throw forbidden();
    return owner.owner_id;
  }

  #requireHumanOrAssistant(session: FactorySession): void {
    this.#requireActiveCredential(session);
    if (session.actor.kind === "node") throw forbidden();
    const owner = this.database.all<ActorRow>(
      "SELECT owner_id FROM factory_meta WHERE singleton = 1",
    )[0];
    if (
      !owner ||
      (session.actor.kind === "human" &&
        session.actor.userId !== owner.owner_id) ||
      (session.actor.kind === "assistant" &&
        session.actor.ownerId !== owner.owner_id)
    )
      throw forbidden();
  }

  #requireNode(session: FactorySession, nodeId: string): void {
    this.#requireActiveCredential(session);
    if (session.actor.kind !== "node" || session.actor.nodeId !== nodeId)
      throw forbidden();
  }

  #requireActiveCredential(session: FactorySession): void {
    const row = this.database.all<{
      actor_json: string;
      revoked_at: string | null;
    }>(
      "SELECT actor_json, revoked_at FROM credentials WHERE credential_id = ?",
      [session.credentialId],
    )[0];
    if (
      !row ||
      row.revoked_at !== null ||
      row.actor_json !== encode(session.actor)
    ) {
      throw authError();
    }
  }

  #ownershipGeneration(): number {
    const row = this.database.all<{ ownership_generation: number }>(
      "SELECT ownership_generation FROM factory_meta WHERE singleton = 1",
    )[0];
    if (!row)
      throw new FactoryError(
        503,
        "not_bootstrapped",
        "The private Factory has not been bootstrapped",
      );
    return Number(row.ownership_generation);
  }

  async #sameSecret(candidate: string, expected: string): Promise<boolean> {
    const [candidateHash, expectedHash] = await Promise.all([
      sha256(candidate),
      sha256(expected),
    ]);
    let difference = 0;
    for (let index = 0; index < candidateHash.length; index += 1) {
      difference |=
        candidateHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
    }
    return difference === 0;
  }

  async #newCredential(
    actor: FactoryActor,
    name: string,
  ): Promise<StoredCredential> {
    const credential = token(actor.kind);
    return {
      credentialId: makeId("credential"),
      credential,
      actor,
      tokenHash: await sha256(credential),
      name,
    };
  }

  async #insertCredential(
    session: FactorySession,
    actor: FactoryActor,
    name: string,
  ): Promise<BootstrapResult> {
    const result = await this.#newCredential(actor, name);
    const createdAt = now();
    this.database.transaction(() => {
      this.#requireOwner(session);
      this.#insertCredentialRows(result, createdAt);
      this.#event(
        "credential.provisioned",
        session.actor,
        null,
        null,
        null,
        { credentialId: result.credentialId, actor, name },
        createdAt,
      );
    });
    return {
      credentialId: result.credentialId,
      name: result.name,
      credential: result.credential,
      actor: result.actor,
    };
  }

  #insertCredentialRows(credential: StoredCredential, createdAt: string): void {
    // A token is random bearer material; only its one-way digest reaches persistent storage.
    this.database.exec(
      "INSERT INTO credentials (credential_id, token_hash, actor_json, name, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        credential.credentialId,
        credential.tokenHash,
        encode(credential.actor),
        credential.name,
        createdAt,
      ],
    );
  }

  #node(row: NodeRow) {
    return factoryNodeSchema.parse({
      contractVersion: CONTRACT_VERSION,
      nodeId: row.node_id,
      name: row.name,
      availability: this.#isNodeOnline(row) ? "online" : "offline",
      lastSeenAt: row.last_seen_at,
    });
  }

  #isNodeOnline(row: NodeRow): boolean {
    return (
      row.availability === "online" &&
      row.last_seen_at !== null &&
      Date.parse(row.last_seen_at) >= Date.now() - NODE_HEARTBEAT_TTL_MS
    );
  }

  #thread(row: ThreadRow) {
    return factoryThreadSchema.parse({
      contractVersion: CONTRACT_VERSION,
      threadId: row.thread_id,
      projectId: row.project_id,
      title: row.title,
      target: { nodeId: row.node_id, workspaceId: row.workspace_id },
      ownershipGeneration: Number(row.ownership_generation),
      createdAt: row.created_at,
    });
  }

  #receiptByRequest(requestId: string): FactoryCommandReceipt {
    const row = this.database.all<ReceiptRow>(
      "SELECT request_id, actor_json, thread_id, payload_hash, job_id, accepted_at FROM command_receipts WHERE request_id = ?",
      [requestId],
    )[0];
    if (!row) throw notFound("Command receipt");
    return this.#receiptByJob(row.job_id);
  }

  #receiptByJob(jobId: string): FactoryCommandReceipt {
    const row = this.database.all<IntentRow>(
      "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE job_id = ?",
      [jobId],
    )[0];
    if (!row) throw notFound("Command receipt");
    return factoryCommandReceiptSchema.parse({
      contractVersion: CONTRACT_VERSION,
      status: "accepted",
      requestId: row.request_id,
      jobId: row.job_id,
      threadId: row.thread_id,
      target: { nodeId: row.node_id, workspaceId: row.workspace_id },
      ownershipGeneration: Number(row.ownership_generation),
      dispatchStatus: row.status,
      acceptedAt: row.created_at,
      ...(row.outcome ? { outcome: row.outcome } : {}),
    });
  }

  #event(
    type: string,
    actor: FactoryActor,
    projectId: string | null,
    threadId: string | null,
    requestId: string | null,
    payload: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.database.exec(
      "INSERT INTO factory_events (type, actor_json, project_id, thread_id, request_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        type,
        encode(actor),
        projectId,
        threadId,
        requestId,
        encode(payload),
        createdAt,
      ],
    );
  }

  #markInterruptedDispatchesUncertain(): void {
    const rows = this.database.all<IntentRow>(
      "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE status = 'running'",
    );
    if (rows.length === 0) return;
    const timestamp = now();
    this.database.transaction(() => {
      for (const row of rows) {
        const detail =
          "Controller reopened while an external effect was in flight; it was not replayed";
        this.database.exec(
          "UPDATE dispatch_intents SET status = 'uncertain', outcome = ?, updated_at = ? WHERE job_id = ? AND status = 'running'",
          [detail, timestamp, row.job_id],
        );
        this.#event(
          "dispatch.uncertain",
          parseActor(row.actor_json),
          row.project_id,
          row.thread_id,
          row.request_id,
          { jobId: row.job_id, detail },
          timestamp,
        );
      }
    });
  }
}
