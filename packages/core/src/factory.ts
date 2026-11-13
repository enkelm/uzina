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

  registerNode(session: FactorySession, nodeId: string) {
    this.#requireNode(session, nodeId);
    return this.#touchNode(session.actor, nodeId, "node.registered");
  }

  heartbeatNode(session: FactorySession, nodeId: string) {
    this.#requireNode(session, nodeId);
    return this.#touchNode(session.actor, nodeId, "node.heartbeat");
  }

  claimNodeJob(
    session: FactorySession,
    nodeId: string,
  ): ReturnType<typeof factoryQueueJobSchema.parse> | null {
    this.#requireNode(session, nodeId);
    const node = this.database.all<NodeRow>(
      "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
      [nodeId],
    )[0];
    if (!node) throw notFound("Execution node");
    if (!this.#isNodeOnline(node)) return null;
    return this.database.transaction(() => {
      const intent = this.database.all<IntentRow>(
        "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE node_id = ? AND status = 'queued' ORDER BY created_at, job_id LIMIT 1",
        [nodeId],
      )[0];
      if (!intent) return null;
      const currentGeneration = this.#ownershipGeneration();
      if (intent.ownership_generation !== currentGeneration) {
        const timestamp = now();
        const detail =
          "The assignment is fenced by a newer ownership generation";
        this.database.exec(
          "UPDATE dispatch_intents SET status = 'unavailable', outcome = ?, updated_at = ? WHERE job_id = ? AND status = 'queued'",
          [detail, timestamp, intent.job_id],
        );
        this.#event(
          "dispatch.unavailable",
          session.actor,
          intent.project_id,
          intent.thread_id,
          intent.request_id,
          { jobId: intent.job_id, reason: "ownership_generation_mismatch" },
          timestamp,
        );
        return null;
      }
      const timestamp = now();
      this.database.exec(
        "UPDATE dispatch_intents SET status = 'running', updated_at = ? WHERE job_id = ? AND status = 'queued'",
        [timestamp, intent.job_id],
      );
      this.#event(
        "dispatch.started",
        session.actor,
        intent.project_id,
        intent.thread_id,
        intent.request_id,
        { jobId: intent.job_id },
        timestamp,
      );
      return factoryQueueJobSchema.parse(JSON.parse(intent.payload_json));
    });
  }

  reportNodeJob(
    session: FactorySession,
    nodeId: string,
    jobId: string,
    report: {
      workspaceId: string;
      ownershipGeneration: number;
      status: "completed" | "failed" | "uncertain";
      detail?: string;
    },
  ): FactoryCommandReceipt {
    this.#requireNode(session, nodeId);
    const intent = this.database.all<IntentRow>(
      "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE job_id = ?",
      [jobId],
    )[0];
    if (!intent) throw notFound("Assigned job");
    if (intent.node_id !== nodeId) throw forbidden();
    const assignment = factoryQueueJobSchema.parse(
      JSON.parse(intent.payload_json),
    );
    if (
      assignment.target.nodeId !== nodeId ||
      assignment.target.workspaceId !== intent.workspace_id ||
      assignment.ownershipGeneration !== intent.ownership_generation ||
      report.workspaceId !== intent.workspace_id ||
      report.ownershipGeneration !== intent.ownership_generation
    ) {
      throw conflict(
        "assignment_mismatch",
        "The report does not match the persisted node, workspace, or ownership generation",
      );
    }
    if (
      intent.status === report.status &&
      intent.outcome === (report.detail ?? null)
    ) {
      return this.#receiptByJob(jobId);
    }
    if (["completed", "failed"].includes(intent.status)) {
      if (
        intent.status !== report.status ||
        intent.outcome !== (report.detail ?? null)
      ) {
        throw conflict(
          "report_conflict",
          "A different terminal outcome is already committed for this job",
        );
      }
      return this.#receiptByJob(jobId);
    }
    if (!["running", "dispatched", "uncertain"].includes(intent.status)) {
      throw conflict(
        "job_not_claimed",
        "A job must be claimed or already uncertain before it can be reported",
      );
    }
    const timestamp = now();
    const eventType =
      report.status === "completed"
        ? "dispatch.completed"
        : report.status === "failed"
          ? "dispatch.failed"
          : "dispatch.uncertain";
    this.database.transaction(() => {
      this.database.exec(
        "UPDATE dispatch_intents SET status = ?, outcome = ?, updated_at = ? WHERE job_id = ?",
        [report.status, report.detail ?? null, timestamp, jobId],
      );
      this.#event(
        eventType,
        session.actor,
        intent.project_id,
        intent.thread_id,
        intent.request_id,
        { jobId, detail: report.detail ?? null },
        timestamp,
      );
    });
    return this.#receiptByJob(jobId);
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

  #touchNode(
    actor: FactoryActor,
    nodeId: string,
    eventType: "node.registered" | "node.heartbeat",
  ) {
    const timestamp = now();
    const node = this.database.all<NodeRow>(
      "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
      [nodeId],
    )[0];
    if (!node) throw notFound("Execution node");
    this.database.transaction(() => {
      this.database.exec(
        "UPDATE nodes SET availability = 'online', last_seen_at = ? WHERE node_id = ?",
        [timestamp, nodeId],
      );
      this.#event(eventType, actor, null, null, null, { nodeId }, timestamp);
    });
    return this.#node({
      ...node,
      availability: "online",
      last_seen_at: timestamp,
    });
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
