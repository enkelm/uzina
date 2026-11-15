import {
  CONTRACT_VERSION,
  actorIdentitySchema,
  capabilitySetSchema,
} from "@uzina/contracts";
import {
  factoryCommandReceiptSchema,
  factoryProvenanceCommandSchema,
  factoryProvenanceExecutionEffectSchema,
  FACTORY_PROVENANCE_EXECUTION_ERROR_CODES,
  accessGrantSchema,
  createThreadRequestSchema,
  discussionEntrySchema,
  discussionPostRequestSchema,
  factoryEventSchema,
  factoryInvitationSchema,
  factoryNodeSchema,
  factoryParticipantSchema,
  factoryProjectSchema,
  factoryQueueJobSchema,
  captureControlAdmissionRequestSchema,
  captureControlStatusSchema,
  workspaceSnapshotRequestSchema,
  workspaceSnapshotStatusSchema,
  managedWorkCheckpointRequestSchema,
  managedWorkCheckpointStatusSchema,
  factoryProvenanceEvidenceSchema,
  type FactoryCommandReceipt,
  type FactoryProvenanceCommand,
  type FactoryProvenanceEvidence,
  type FactoryProvenanceExecutionEffect,
  type ManagedWorkCheckpointStage,
  workspaceSnapshotClaimRequestSchema,
  workspaceSnapshotClaimSchema,
  workspaceSnapshotReportSchema,
  workspaceSnapshotReportResponseSchema,
  workspaceRelocationRequestSchema,
  workspaceRelocationStatusSchema,
  workspaceRelocationClaimRequestSchema,
  workspaceRelocationClaimSchema,
  workspaceRelocationReportSchema,
  workspaceRelocationReportResponseSchema,
  type WorkspaceRelocationClaim,
  type WorkspaceRelocationReport,
  type WorkspaceRelocationStatus,
  type WorkspaceSnapshotClaim,
  factoryThreadSchema,
  factoryWorkspaceSchema,
  invitationCreateRequestSchema,
  invitationRedeemRequestSchema,
  participantAccessRequestSchema,
  provisionCredentialRequestSchema,
  assistantCredentialGrantsRequestSchema,
  assistantCredentialGrantSchema,
  type AssistantCredentialGrant,
  type AccessGrant,
  type FactoryActor,
  type FactoryInvitation,
  type FactoryParticipant,
  type ParticipantRole,
  type FactoryQueueJob,
  type ManagedRuntimeDispatch,
} from "@uzina/contracts/factory";
import {
  EXECUTION_CONTRACT_VERSION,
  executionCaptureControlClaimRequestSchema,
  executionCaptureControlReportResponseSchema,
  executionCaptureControlReportSchema,
  executionCaptureControlSchema,
  executionHeartbeatRequestSchema,
  executionHeartbeatResponseSchema,
  executionJobReportSchema,
  executionJobSchema,
  executionReceiptSchema,
  executionRegisterRequestSchema,
  executionRegisterResponseSchema,
  executionReportResponseSchema,
  type ExecutionCaptureControl,
  type ExecutionCaptureControlReport,
  type ExecutionHeartbeatRequest,
  type ExecutionJob,
  type ExecutionJobReport,
  type ExecutionReceipt,
  type ExecutionOperation,
  type ExecutionRegisterRequest,
  type ExecutionWorkspaceReport,
} from "@uzina/contracts/execution";
import { MANAGED_WORK_RUNTIME_REQUIREMENTS } from "@uzina/checkpoints/managed-work-composition";
import type { FactoryDatabase } from "./database";
import { initializeFactoryDatabase } from "./database";
import { FactoryAccessPolicy, type StoredAccessPrincipal } from "./access";
import { isVerifiedManagedWorkCheckpointClosure } from "./managed-work-checkpoint-verification";

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
  assistantGrants?: AssistantCredentialGrant[];
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
  owner_private: number;
  created_at: string;
};
type UserRow = {
  user_id: string;
  display_name: string;
  role: "owner" | ParticipantRole;
  revoked_at: string | null;
  access_generation: number;
  created_at: string;
};
type InvitationRow = {
  invitation_id: string;
  code_hash: string;
  role: ParticipantRole;
  grants_json: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  revoked_at: string | null;
  created_at: string;
};
type DiscussionRow = {
  discussion_id: string;
  thread_id: string;
  actor_json: string;
  text: string;
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
export type ManagedWorkCheckpointArtifactRole =
  "runtime" | "evidence" | "attachment" | "inner-manifest" | "outer-manifest";
export type ManagedWorkCheckpointArtifactReference = {
  role: ManagedWorkCheckpointArtifactRole;
  reference: string;
  size: number;
};
type ManagedWorkCheckpointArtifactRow = {
  request_id: string;
  role: ManagedWorkCheckpointArtifactRole;
  reference: string;
  size_bytes: number;
  verified_at: string;
};
type ManagedWorkCheckpointRow = {
  request_id: string;
  capture_request_id: string;
  workspace_snapshot_request_id: string;
  capture_id: string;
  actor_json: string;
  project_id: string;
  thread_id: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  status: "assembling" | "available" | "blocked" | "uncertain";
  stage: ManagedWorkCheckpointStage;
  accepted_at: string;
  updated_at: string;
  manifest_reference: string | null;
  runtime_requirements_json: string | null;
};
type ManagedWorkCheckpointBindingRow = Pick<
  ManagedWorkCheckpointRow,
  | "request_id"
  | "capture_request_id"
  | "workspace_snapshot_request_id"
  | "capture_id"
  | "actor_json"
  | "project_id"
  | "thread_id"
  | "node_id"
  | "workspace_id"
  | "ownership_generation"
>;
type WorkspaceRelocationRow = {
  request_id: string;
  relocation_id: string;
  checkpoint_request_id: string;
  capture_request_id: string;
  capture_id: string;
  workspace_snapshot_request_id: string;
  snapshot_id: string;
  actor_json: string;
  project_id: string;
  thread_id: string;
  source_node_id: string;
  source_workspace_id: string;
  destination_node_id: string;
  destination_workspace_id: string;
  ownership_generation: number;
  manifest_reference: string;
  status: WorkspaceRelocationStatus["status"];
  accepted_at: string;
  updated_at: string;
  claimed_at: string | null;
  report_json: string | null;
  report_sha256: string | null;
  receipt_sha256: string | null;
  previous_report_json: string | null;
  previous_report_sha256: string | null;
  previous_receipt_sha256: string | null;
  error_code: string | null;
};
type WorkspaceSnapshotRow = {
  request_id: string;
  capture_request_id: string;
  snapshot_id: string;
  capture_id: string;
  actor_json: string;
  project_id: string;
  thread_id: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  status:
    | "queued"
    | "claimed"
    | "workspace-checkpoint-available"
    | "blocked"
    | "uncertain";
  accepted_at: string;
  updated_at: string;
  claimed_at: string | null;
  manifest_reference: string | null;
  report_json: string | null;
  report_sha256: string | null;
  error_code: string | null;
};
type CaptureControlRow = {
  request_id: string;
  control_id: string;
  capture_id: string;
  actor_json: string;
  project_id: string;
  thread_id: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  payload_json: string;
  payload_sha256: string;
  status: "queued" | "claimed" | "source-capture-fenced" | "blocked";
  accepted_at: string;
  updated_at: string;
  claimed_at: string | null;
  report_json: string | null;
  report_sha256: string | null;
  error_code: string | null;
  claim_count: number;
};
type ExecutionJobRow = {
  job_id: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  operation: ExecutionJob["operation"];
  payload_json: string;
  payload_sha256: string;
  request_id: string | null;
  pi_task_id: string | null;
  pi_call_id: string | null;
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

export type ManagedRemoteOperation = ExecutionOperation;

export type ManagedExecutionEvidence = {
  requestId: string;
  taskId: string;
  callId: string;
};

type ManagedWorkSourceFence = NonNullable<
  ExecutionCaptureControlReport["sourceFence"]
>;

type ImmutableManagedWorkSourceFence = Readonly<
  Omit<ManagedWorkSourceFence, "target"> & {
    target: Readonly<ManagedWorkSourceFence["target"]>;
  }
>;

export type ManagedWorkCaptureBinding = Readonly<{
  captureId: string;
  captureRequestId: string;
  controlId: string;
  threadId: string;
  projectId: string;
  target: Readonly<{ nodeId: string; workspaceId: string }>;
  ownershipGeneration: number;
  sourceFence: ImmutableManagedWorkSourceFence;
  reportSha256: string;
}>;

export type ManagedWorkCaptureState =
  | Readonly<{ state: "unlocked" }>
  | Readonly<{ state: "held"; captureId?: string }>
  | Readonly<{
      state: "source-capture-fenced";
      binding: ManagedWorkCaptureBinding;
    }>;

export type ManagedWorkRuntimeAdmission =
  | Readonly<{
      state: "permitted";
      permitId: string;
      ownershipGeneration: number;
    }>
  | Readonly<{ state: "held"; captureId?: string }>;

const NODE_HEARTBEAT_TTL_MS = 90_000;
const CHECKPOINT_SHA256 = /^[a-f0-9]{64}$/;
const CHECKPOINT_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_RUNTIME_REQUIREMENTS_MAX = 16;

function normalizeManagedWorkRuntimeRequirements(
  value: unknown,
): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length <= MANAGED_WORK_RUNTIME_REQUIREMENTS.length ||
    value.length > CHECKPOINT_RUNTIME_REQUIREMENTS_MAX ||
    value.some(
      (requirement) =>
        typeof requirement !== "string" ||
        !requirement.trim() ||
        requirement.length > 256 ||
        /[\r\n]/.test(requirement),
    ) ||
    new Set(value).size !== value.length ||
    MANAGED_WORK_RUNTIME_REQUIREMENTS.some(
      (requirement, index) => value[index] !== requirement,
    )
  ) {
    return undefined;
  }
  return [...value];
}

function parsePersistedManagedWorkRuntimeRequirements(
  value: string | null,
): string[] | undefined {
  if (value === null) return undefined;
  try {
    return normalizeManagedWorkRuntimeRequirements(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function validManagedWorkCheckpointTransition(
  from: ManagedWorkCheckpointStage,
  to: ManagedWorkCheckpointStage,
): boolean {
  return (
    (from === "admitted" && to === "runtime-export-started") ||
    (from === "runtime-export-recorded" && to === "evidence-write-started") ||
    (from === "evidence-recorded" && to === "bundle-compose-started") ||
    (from === "bundle-composed" && to === "closure-verification-started")
  );
}

function validManagedWorkCheckpointArtifactTransition(
  from: ManagedWorkCheckpointStage,
  to: ManagedWorkCheckpointStage,
  artifacts: readonly ManagedWorkCheckpointArtifactReference[],
  runtimeRequirements?: readonly string[],
): boolean {
  if (from === "runtime-export-started" && to === "runtime-export-recorded") {
    return (
      artifacts.length === 1 &&
      artifacts[0]?.role === "runtime" &&
      normalizeManagedWorkRuntimeRequirements(runtimeRequirements) !== undefined
    );
  }
  if (runtimeRequirements !== undefined) return false;
  if (from === "evidence-write-started" && to === "evidence-recorded") {
    return artifacts.length === 1 && artifacts[0]?.role === "evidence";
  }
  return (
    from === "bundle-compose-started" &&
    to === "bundle-composed" &&
    artifacts.length === 2 &&
    artifacts.some((artifact) => artifact.role === "inner-manifest") &&
    artifacts.some((artifact) => artifact.role === "outer-manifest")
  );
}

function validateCheckpointArtifact(
  artifact: ManagedWorkCheckpointArtifactReference,
): void {
  const manifest =
    artifact.role === "inner-manifest" || artifact.role === "outer-manifest";
  if (
    !CHECKPOINT_SHA256.test(artifact.reference) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0 ||
    artifact.size >
      (manifest ? CHECKPOINT_MANIFEST_MAX_BYTES : CHECKPOINT_ARTIFACT_MAX_BYTES)
  ) {
    throw new FactoryError(400, "invalid_checkpoint_artifact_reference");
  }
}

// Participant cursors occupy a generation-specific range independent of hidden global events.
const EVENT_CURSOR_RADIX = 1_000_000_000;
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

function conflict(code: string, message = code): FactoryError {
  return new FactoryError(409, code, message);
}

function checkpointConflict(code: string): FactoryError {
  return new FactoryError(409, code);
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
        "INSERT INTO factory_users (user_id, display_name, role, created_at) VALUES (?, ?, 'owner', ?)",
        [ownerId, name, createdAt],
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
    const actor = parseActor(row.actor_json);
    if (actor.kind === "human") {
      const user = this.database.all<{ revoked_at: string | null }>(
        "SELECT revoked_at FROM factory_users WHERE user_id = ?",
        [actor.userId],
      )[0];
      if (!user || user.revoked_at !== null) throw authError();
    }
    return {
      credentialId: row.credential_id,
      actor,
    };
  }

  async provisionCredential(
    session: FactorySession,
    kind: "human" | "assistant",
    name: string,
    assistantGrants?: AssistantCredentialGrant[],
  ): Promise<BootstrapResult> {
    const input = provisionCredentialRequestSchema.parse({
      kind,
      name,
      ...(assistantGrants === undefined ? {} : { assistantGrants }),
    });
    kind = input.kind;
    name = input.name;
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
    const grants =
      kind === "assistant"
        ? (input.assistantGrants ?? [{ type: "factory" as const }])
        : undefined;
    if (grants) this.#validateAssistantGrantTargets(grants);
    return this.#insertCredential(session, actor, name, grants);
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
      .map((row) => {
        const actor = parseActor(row.actor_json);
        return {
          credentialId: row.credential_id,
          actor,
          name: row.name,
          revokedAt: row.revoked_at,
          createdAt: row.created_at,
          ...(actor.kind === "assistant"
            ? { assistantGrants: this.#assistantGrants(row.credential_id) }
            : {}),
        };
      });
  }

  setAssistantCredentialGrants(
    session: FactorySession,
    credentialId: string,
    grants: AssistantCredentialGrant[],
  ) {
    this.#requireOwner(session);
    grants = assistantCredentialGrantsRequestSchema.parse({ grants }).grants;
    this.#validateAssistantGrantTargets(grants);
    const target = this.database.all<{
      actor_json: string;
      revoked_at: string | null;
    }>(
      "SELECT actor_json, revoked_at FROM credentials WHERE credential_id = ?",
      [credentialId],
    )[0];
    if (!target || target.revoked_at !== null) throw notFound("Credential");
    if (parseActor(target.actor_json).kind !== "assistant") {
      throw new FactoryError(
        400,
        "not_assistant_credential",
        "Grant authority can be changed only for assistant credentials",
      );
    }
    const timestamp = now();
    this.database.transaction(() => {
      this.#requireOwner(session);
      const current = this.database.all<{
        actor_json: string;
        revoked_at: string | null;
      }>(
        "SELECT actor_json, revoked_at FROM credentials WHERE credential_id = ?",
        [credentialId],
      )[0];
      if (!current || current.revoked_at !== null) throw notFound("Credential");
      if (parseActor(current.actor_json).kind !== "assistant") {
        throw new FactoryError(400, "not_assistant_credential");
      }
      this.#replaceAssistantGrants(credentialId, grants, timestamp);
      this.database.exec(
        "UPDATE credentials SET access_generation = access_generation + 1 WHERE credential_id = ?",
        [credentialId],
      );
      this.#event(
        "credential.grants_changed",
        session.actor,
        null,
        null,
        null,
        { credentialId, grants },
        timestamp,
      );
    });
    return { credentialId, assistantGrants: grants };
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

  async createInvitation(
    session: FactorySession,
    input: {
      role: ParticipantRole;
      grants: AccessGrant[];
      expiresAt: string;
    },
  ) {
    input = invitationCreateRequestSchema.parse(input);
    this.#requireOwner(session);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new FactoryError(400, "invalid_invitation_expiry");
    }
    this.#validateGrantTargets(input.grants);
    const code = token("invite");
    const codeHash = await sha256(code);
    const invitationId = makeId("invitation");
    const createdAt = now();
    this.database.transaction(() => {
      this.#requireOwner(session);
      this.#validateGrantTargets(input.grants);
      this.database.exec(
        "INSERT INTO invitations (invitation_id, code_hash, role, grants_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          invitationId,
          codeHash,
          input.role,
          encode(input.grants),
          input.expiresAt,
          createdAt,
        ],
      );
      this.#event(
        "invitation.created",
        session.actor,
        null,
        null,
        null,
        {
          invitationId,
          role: input.role,
          grants: input.grants,
          expiresAt: input.expiresAt,
        },
        createdAt,
      );
    });
    return {
      invitation: factoryInvitationSchema.parse({
        invitationId,
        role: input.role,
        grants: input.grants,
        expiresAt: input.expiresAt,
        redeemedAt: null,
        redeemedBy: null,
        revokedAt: null,
        createdAt,
      }),
      code,
    };
  }

  listInvitations(session: FactorySession): FactoryInvitation[] {
    this.#requireOwner(session);
    return this.database
      .all<InvitationRow>(
        "SELECT invitation_id, code_hash, role, grants_json, expires_at, redeemed_at, redeemed_by, revoked_at, created_at FROM invitations ORDER BY created_at, invitation_id",
      )
      .map((row) => this.#invitation(row));
  }

  revokeInvitation(session: FactorySession, invitationId: string): void {
    this.#requireOwner(session);
    const timestamp = now();
    this.database.transaction(() => {
      this.#requireOwner(session);
      const row = this.database.all<InvitationRow>(
        "SELECT invitation_id, code_hash, role, grants_json, expires_at, redeemed_at, redeemed_by, revoked_at, created_at FROM invitations WHERE invitation_id = ?",
        [invitationId],
      )[0];
      if (!row) throw notFound("Invitation");
      if (row.redeemed_at) {
        throw conflict(
          "invitation_redeemed",
          "A redeemed invitation cannot be revoked",
        );
      }
      if (row.revoked_at) return;
      this.database.exec(
        "UPDATE invitations SET revoked_at = ? WHERE invitation_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL",
        [timestamp, invitationId],
      );
      this.#event(
        "invitation.revoked",
        session.actor,
        null,
        null,
        null,
        { invitationId },
        timestamp,
      );
    });
  }

  async redeemInvitation(code: string, displayName: string) {
    const input = invitationRedeemRequestSchema.parse({ code, displayName });
    code = input.code;
    displayName = input.displayName;
    const codeHash = await sha256(code);
    const userId = makeId("user");
    const actor = actorIdentitySchema.parse({
      contractVersion: CONTRACT_VERSION,
      kind: "human",
      userId,
    });
    const credential = await this.#newCredential(actor, displayName);
    const timestamp = now();
    let participant!: FactoryParticipant;
    this.database.transaction(() => {
      const invitation = this.database.all<InvitationRow>(
        "SELECT invitation_id, code_hash, role, grants_json, expires_at, redeemed_at, redeemed_by, revoked_at, created_at FROM invitations WHERE code_hash = ?",
        [codeHash],
      )[0];
      if (!invitation || invitation.revoked_at || invitation.redeemed_at) {
        throw notFound("Invitation code");
      }
      if (Date.parse(invitation.expires_at) <= Date.parse(timestamp)) {
        throw conflict("invitation_expired", "The invitation code has expired");
      }
      const grants = accessGrantSchema
        .array()
        .parse(JSON.parse(invitation.grants_json));
      this.#validateGrantTargets(grants);
      this.database.exec(
        "INSERT INTO factory_users (user_id, display_name, role, created_at) VALUES (?, ?, ?, ?)",
        [userId, displayName, invitation.role, timestamp],
      );
      this.#replaceGrants(userId, grants, timestamp);
      this.#insertCredentialRows(credential, timestamp);
      this.database.exec(
        "UPDATE invitations SET redeemed_at = ?, redeemed_by = ? WHERE invitation_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL",
        [timestamp, userId, invitation.invitation_id],
      );
      const redeemed = this.database.all<{ redeemed_at: string | null }>(
        "SELECT redeemed_at FROM invitations WHERE invitation_id = ?",
        [invitation.invitation_id],
      )[0];
      if (redeemed?.redeemed_at !== timestamp) {
        throw conflict(
          "invitation_unavailable",
          "The invitation code is no longer available",
        );
      }
      participant = this.#participant({
        user_id: userId,
        display_name: displayName,
        role: invitation.role,
        revoked_at: null,
        access_generation: 0,
        created_at: timestamp,
      });
      this.#event(
        "invitation.redeemed",
        actor,
        null,
        null,
        null,
        { invitationId: invitation.invitation_id, userId },
        timestamp,
      );
    });
    return {
      participant,
      credentialId: credential.credentialId,
      credentialName: credential.name,
      credential: credential.credential,
      actor,
    };
  }

  /** Rejects every non-owner actor before exposing owner-private assistant state. */
  requirePrivateAssistantOwner(session: FactorySession): string {
    return this.#requireOwner(session);
  }

  currentParticipant(session: FactorySession): FactoryParticipant | null {
    this.#policy(session);
    if (session.actor.kind !== "human") return null;
    const row = this.database.all<UserRow>(
      "SELECT user_id, display_name, role, revoked_at, created_at FROM factory_users WHERE user_id = ?",
      [session.actor.userId],
    )[0];
    return row ? this.#participant(row) : null;
  }

  listParticipants(session: FactorySession): FactoryParticipant[] {
    this.#requireOwner(session);
    return this.database
      .all<UserRow>(
        "SELECT user_id, display_name, role, revoked_at, created_at FROM factory_users ORDER BY created_at, user_id",
      )
      .map((row) => this.#participant(row));
  }

  setParticipantAccess(
    session: FactorySession,
    userId: string,
    role: ParticipantRole,
    grants: AccessGrant[],
  ): FactoryParticipant {
    const input = participantAccessRequestSchema.parse({ role, grants });
    role = input.role;
    grants = input.grants;
    const ownerId = this.#requireOwner(session);
    if (userId === ownerId) {
      throw new FactoryError(400, "owner_access_immutable");
    }
    const timestamp = now();
    this.database.transaction(() => {
      this.#requireOwner(session);
      const target = this.database.all<UserRow>(
        "SELECT user_id, display_name, role, revoked_at, created_at FROM factory_users WHERE user_id = ?",
        [userId],
      )[0];
      if (!target || target.revoked_at) throw notFound("Participant");
      this.#validateGrantTargets(grants);
      this.database.exec(
        "UPDATE factory_users SET role = ?, access_generation = access_generation + 1 WHERE user_id = ? AND revoked_at IS NULL",
        [role, userId],
      );
      this.#replaceGrants(userId, grants, timestamp);
      this.#event(
        "participant.access_changed",
        session.actor,
        null,
        null,
        null,
        { userId, role, grants },
        timestamp,
      );
    });
    const updated = this.database.all<UserRow>(
      "SELECT user_id, display_name, role, revoked_at, created_at FROM factory_users WHERE user_id = ?",
      [userId],
    )[0];
    if (!updated) throw notFound("Participant");
    return this.#participant(updated);
  }

  revokeParticipant(session: FactorySession, userId: string): void {
    const ownerId = this.#requireOwner(session);
    if (userId === ownerId)
      throw new FactoryError(400, "owner_access_immutable");
    const timestamp = now();
    this.database.transaction(() => {
      this.#requireOwner(session);
      const target = this.database.all<UserRow>(
        "SELECT user_id, display_name, role, revoked_at, created_at FROM factory_users WHERE user_id = ?",
        [userId],
      )[0];
      if (!target) throw notFound("Participant");
      if (target.revoked_at) return;
      this.database.exec(
        "UPDATE factory_users SET revoked_at = ?, access_generation = access_generation + 1 WHERE user_id = ? AND revoked_at IS NULL",
        [timestamp, userId],
      );
      const credentials = this.database.all<{
        credential_id: string;
        actor_json: string;
      }>(
        "SELECT credential_id, actor_json FROM credentials WHERE revoked_at IS NULL",
      );
      for (const row of credentials) {
        const actor = parseActor(row.actor_json);
        if (actor.kind === "human" && actor.userId === userId) {
          this.database.exec(
            "UPDATE credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
            [timestamp, row.credential_id],
          );
        }
      }
      this.#event(
        "participant.revoked",
        session.actor,
        null,
        null,
        null,
        { userId },
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

  listProjects(session: FactorySession, limit = 100) {
    const policy = this.#policy(session);
    this.#validateQueryLimit(limit);
    let rows: ProjectRow[];
    if (policy.isOwner || policy.principal.factoryWide) {
      rows = this.database.all<ProjectRow>(
        "SELECT project_id, name, created_at FROM projects ORDER BY created_at, project_id LIMIT ?",
        [limit],
      );
    } else {
      const projectIds = policy.principal.grants
        .filter((grant) => grant.type === "project")
        .map((grant) => grant.resourceId);
      const threadIds = policy.principal.grants
        .filter((grant) => grant.type === "thread")
        .map((grant) => grant.resourceId);
      if (projectIds.length === 0 && threadIds.length === 0) return [];
      const visibleProject = [
        ...(projectIds.length
          ? [`p.project_id IN (${projectIds.map(() => "?").join(",")})`]
          : []),
        ...(threadIds.length
          ? [
              `EXISTS (SELECT 1 FROM threads t WHERE t.project_id = p.project_id AND t.owner_private = 0 AND t.thread_id IN (${threadIds.map(() => "?").join(",")}))`,
            ]
          : []),
      ].join(" OR ");
      rows = this.database.all<ProjectRow>(
        `SELECT p.project_id, p.name, p.created_at FROM projects p WHERE (${visibleProject}) ORDER BY p.created_at, p.project_id LIMIT ?`,
        [...projectIds, ...threadIds, limit],
      );
    }
    return rows.map((row) =>
      factoryProjectSchema.parse({
        contractVersion: CONTRACT_VERSION,
        projectId: row.project_id,
        name: row.name,
        createdAt: row.created_at,
      }),
    );
  }

  listNodes(session: FactorySession, limit = 100) {
    const policy = this.#policy(session);
    this.#requireOwnerOrAssistant(session);
    this.#validateQueryLimit(limit);
    const rows =
      policy.isOwner || policy.principal.factoryWide
        ? this.database.all<NodeRow>(
            "SELECT node_id, name, availability, last_seen_at FROM nodes ORDER BY node_id LIMIT ?",
            [limit],
          )
        : this.database.all<NodeRow>(
            `SELECT DISTINCT n.node_id, n.name, n.availability, n.last_seen_at FROM nodes n JOIN threads t ON t.node_id = n.node_id WHERE t.owner_private = 0 AND ${this.#threadGrantPredicate(policy, "t")} ORDER BY n.node_id LIMIT ?`,
            [...this.#threadGrantParameters(policy), limit],
          );
    return rows.map((row) => this.#node(row));
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

  listWorkspaces(session: FactorySession, limit = 100) {
    const policy = this.#policy(session);
    this.#requireOwnerOrAssistant(session);
    this.#validateQueryLimit(limit);
    const rows =
      policy.isOwner || policy.principal.factoryWide
        ? this.database.all<WorkspaceRow>(
            "SELECT workspace_id, node_id, name FROM workspaces ORDER BY node_id, workspace_id LIMIT ?",
            [limit],
          )
        : this.database.all<WorkspaceRow>(
            `SELECT DISTINCT w.workspace_id, w.node_id, w.name FROM workspaces w JOIN threads t ON t.workspace_id = w.workspace_id WHERE t.owner_private = 0 AND ${this.#threadGrantPredicate(policy, "t")} ORDER BY w.node_id, w.workspace_id LIMIT ?`,
            [...this.#threadGrantParameters(policy), limit],
          );
    return rows.map((row) =>
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
      ownerPrivate?: boolean;
    },
  ) {
    input = createThreadRequestSchema.parse(input);
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
      this.#assertWorkspaceNotCapturing(input.target.workspaceId);
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
        "INSERT INTO threads (thread_id, project_id, title, node_id, workspace_id, ownership_generation, owner_private, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          threadId,
          input.projectId,
          input.title,
          input.target.nodeId,
          input.target.workspaceId,
          generation,
          input.ownerPrivate ? 1 : 0,
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
      ownerPrivate: input.ownerPrivate ?? false,
      ownershipGeneration: generation,
      createdAt,
    });
  }

  listThreads(session: FactorySession, projectId?: string, limit = 100) {
    const policy = this.#policy(session);
    this.#validateQueryLimit(limit);
    const projectFilter = projectId ? " AND t.project_id = ?" : "";
    const projectParameters = projectId ? [projectId] : [];
    const rows =
      policy.isOwner || policy.principal.factoryWide
        ? this.database.all<ThreadRow>(
            `SELECT t.thread_id, t.project_id, t.title, t.node_id, t.workspace_id, t.ownership_generation, t.owner_private, t.created_at FROM threads t WHERE 1 = 1${projectFilter} ORDER BY t.created_at, t.thread_id LIMIT ?`,
            [...projectParameters, limit],
          )
        : this.database.all<ThreadRow>(
            `SELECT t.thread_id, t.project_id, t.title, t.node_id, t.workspace_id, t.ownership_generation, t.owner_private, t.created_at FROM threads t WHERE t.owner_private = 0 AND (${this.#threadGrantPredicate(policy, "t")})${projectFilter} ORDER BY t.created_at, t.thread_id LIMIT ?`,
            [
              ...this.#threadGrantParameters(policy),
              ...projectParameters,
              limit,
            ],
          );
    return rows.map((row) => this.#thread(row));
  }

  listDiscussion(session: FactorySession, threadId: string) {
    this.#requireReadableThread(session, threadId);
    return this.database
      .all<DiscussionRow>(
        "SELECT discussion_id, thread_id, actor_json, text, created_at FROM thread_discussion WHERE thread_id = ? ORDER BY created_at, discussion_id",
        [threadId],
      )
      .map((row) => {
        const actor = parseActor(row.actor_json);
        return discussionEntrySchema.parse({
          discussionId: row.discussion_id,
          threadId: row.thread_id,
          actor,
          displayName: this.#actorDisplayName(actor),
          text: row.text,
          createdAt: row.created_at,
        });
      });
  }

  postDiscussion(session: FactorySession, threadId: string, text: string) {
    text = discussionPostRequestSchema.parse({ text }).text;
    const thread = this.#requireReadableThread(session, threadId);
    const policy = this.#policy(session);
    if (
      !policy.canPostDiscussion(
        thread.project_id,
        thread.thread_id,
        thread.owner_private === 1,
      )
    ) {
      throw forbidden();
    }
    const discussionId = makeId("discussion");
    const createdAt = now();
    this.database.transaction(() => {
      const current = this.#requireReadableThread(session, threadId);
      const currentPolicy = this.#policy(session);
      if (
        !currentPolicy.canPostDiscussion(
          current.project_id,
          current.thread_id,
          current.owner_private === 1,
        )
      ) {
        throw forbidden();
      }
      this.database.exec(
        "INSERT INTO thread_discussion (discussion_id, thread_id, actor_json, text, created_at) VALUES (?, ?, ?, ?, ?)",
        [discussionId, threadId, encode(session.actor), text, createdAt],
      );
      this.#event(
        "discussion.posted",
        session.actor,
        current.project_id,
        threadId,
        null,
        { discussionId },
        createdAt,
      );
    });
    return discussionEntrySchema.parse({
      discussionId,
      threadId,
      actor: session.actor,
      displayName: this.#actorDisplayName(session.actor),
      text,
      createdAt,
    });
  }

  async submitInput(
    session: FactorySession,
    threadId: string,
    requestId: string,
    text: string,
  ): Promise<FactoryCommandReceipt> {
    const thread = this.#requireSteerThread(session, threadId);
    const actorJson = encode(session.actor);
    const payload = { threadId, text };
    const payloadHash = await sha256(encode(payload));
    const existing = this.database.all<ReceiptRow>(
      "SELECT request_id, actor_json, thread_id, payload_hash, job_id, accepted_at FROM command_receipts WHERE request_id = ?",
      [requestId],
    )[0];
    if (existing) {
      this.#requireSteerThread(session, threadId);
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
      this.#requireSteerThread(session, threadId);
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
        "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, owner_private, created_at FROM threads WHERE thread_id = ?",
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
      this.#assertWorkspaceNotCapturing(currentThread.workspace_id);
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
    this.#policy(session);
    const receipt = this.database.all<ReceiptRow>(
      "SELECT request_id, actor_json, thread_id, payload_hash, job_id, accepted_at FROM command_receipts WHERE request_id = ?",
      [requestId],
    )[0];
    if (!receipt) throw notFound("Command receipt");
    this.#requireReadableThread(session, receipt.thread_id);
    return this.#receiptByJob(receipt.job_id);
  }

  listThreadReceipts(
    session: FactorySession,
    threadId: string,
    limit = 100,
  ): FactoryCommandReceipt[] {
    this.#requireReadableThread(session, threadId);
    this.#validateQueryLimit(limit);
    const rows = this.database.all<{ job_id: string }>(
      "SELECT job_id FROM command_receipts WHERE thread_id = ? ORDER BY accepted_at, request_id LIMIT ?",
      [threadId, limit],
    );
    return rows.map((row) => this.#receiptByJob(row.job_id));
  }

  getLifecycleCapabilities(session: FactorySession, threadId: string) {
    const thread = this.#requireReadableThread(session, threadId);
    const canSteer = this.#policy(session).canSteer(
      thread.project_id,
      thread.thread_id,
      thread.owner_private === 1,
    );
    return capabilitySetSchema.parse({
      contractVersion: CONTRACT_VERSION,
      capabilities: [
        { operation: "reattach", supported: false },
        { operation: "native-resume", supported: false },
        { operation: "managed-checkpoint-recovery", supported: false },
        { operation: "steer", supported: canSteer },
        { operation: "stop", supported: false },
      ],
    });
  }

  /** Authorized runtime query target; placement always comes from the stored thread. */
  getAuthorizedThread(session: FactorySession, threadId: string) {
    const row = this.#requireReadableThread(session, threadId);
    return this.#thread(row);
  }

  /** Durably fences selected managed work and its exclusive workspace for local capture. */
  beginManagedWorkCapture(session: FactorySession, threadId: string) {
    const ownerId = this.#requireOwner(session);
    return this.database.transaction(() => {
      const row = this.#captureThread(threadId);
      this.#assertManagedCaptureAdmission(threadId, row);
      const captureId = makeId("capture");
      this.database.exec(
        "INSERT INTO managed_work_captures(capture_id, thread_id, workspace_id, owner_id, started_at) VALUES (?, ?, ?, ?, ?)",
        [captureId, threadId, row.workspace_id, ownerId, now()],
      );
      return { captureId, thread: this.#thread(row) };
    });
  }

  /**
   * Accepts an owner-authenticated, stable capture-control request and durably
   * blocks Core admission before any node can claim the control.
   */
  async requestCaptureControl(
    session: FactorySession,
    threadId: string,
    request: unknown,
  ) {
    const ownerId = this.#requireOwner(session);
    const input = captureControlAdmissionRequestSchema.parse(request);
    const thread = this.#captureThread(threadId);
    const binding = {
      requestId: input.requestId,
      actor: session.actor,
      threadId,
      projectId: thread.project_id,
      nodeId: thread.node_id,
      workspaceId: thread.workspace_id,
      ownershipGeneration: thread.ownership_generation,
    };
    const requestHash = await sha256(stableJson(binding));
    const controlId = makeId("capture-control");
    const captureId = makeId("capture");
    const controlBinding = {
      contractVersion: EXECUTION_CONTRACT_VERSION,
      controlId,
      captureId,
      requestId: input.requestId,
      nodeId: thread.node_id,
      target: { nodeId: thread.node_id, workspaceId: thread.workspace_id },
      ownershipGeneration: thread.ownership_generation,
    };
    const control = executionCaptureControlSchema.parse({
      ...controlBinding,
      payloadSha256: await sha256(stableJson(controlBinding)),
    });

    const row = this.database.transaction(() => {
      this.#requireOwner(session);
      const existing = this.#captureControlByRequest(input.requestId);
      if (existing) {
        if (
          existing.payload_sha256 !== requestHash ||
          existing.actor_json !== encode(session.actor) ||
          existing.thread_id !== threadId
        ) {
          throw conflict(
            "capture_control_request_conflict",
            "The stable capture request ID is already bound to another actor, thread, or target",
          );
        }
        return existing;
      }
      const currentThread = this.#captureThread(threadId);
      if (
        currentThread.project_id !== thread.project_id ||
        currentThread.node_id !== thread.node_id ||
        currentThread.workspace_id !== thread.workspace_id ||
        currentThread.ownership_generation !== thread.ownership_generation
      ) {
        throw conflict(
          "capture_control_target_changed",
          "The selected thread target changed before capture control was committed",
        );
      }
      this.#assertManagedCaptureAdmission(threadId, currentThread);
      const acceptedAt = now();
      this.database.exec(
        "INSERT INTO managed_work_captures(capture_id, thread_id, workspace_id, owner_id, started_at) VALUES (?, ?, ?, ?, ?)",
        [captureId, threadId, currentThread.workspace_id, ownerId, acceptedAt],
      );
      this.database.exec(
        `INSERT INTO capture_control_requests(
          request_id, control_id, capture_id, actor_json, project_id, thread_id,
          node_id, workspace_id, ownership_generation, payload_json, payload_sha256,
          status, accepted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        [
          input.requestId,
          control.controlId,
          control.captureId,
          encode(session.actor),
          currentThread.project_id,
          threadId,
          currentThread.node_id,
          currentThread.workspace_id,
          currentThread.ownership_generation,
          encode(control),
          requestHash,
          acceptedAt,
          acceptedAt,
        ],
      );
      return this.#captureControlByRequest(input.requestId)!;
    });
    return this.#captureControlStatus(row);
  }

  /** Accept one snapshot only after the same capture control is durably source-fenced. */
  requestWorkspaceSnapshot(session: FactorySession, request: unknown) {
    this.#requireOwner(session);
    const input = workspaceSnapshotRequestSchema.parse(request);
    const result = this.database.transaction(() => {
      this.#requireOwner(session);
      const existing = this.#workspaceSnapshotByRequest(input.requestId);
      if (existing) {
        if (
          existing.capture_request_id !== input.captureRequestId ||
          existing.actor_json !== encode(session.actor)
        ) {
          throw conflict(
            "workspace_snapshot_request_conflict",
            "The stable snapshot request ID is already bound to another capture or actor",
          );
        }
        return existing;
      }
      const capture = this.#captureControlByRequest(input.captureRequestId);
      if (!capture || capture.actor_json !== encode(session.actor)) {
        throw notFound("Source-fenced capture control");
      }
      const snapshotForCapture = this.database.all<WorkspaceSnapshotRow>(
        "SELECT * FROM workspace_snapshot_requests WHERE capture_request_id = ? OR capture_id = ?",
        [input.captureRequestId, capture.capture_id],
      )[0];
      if (snapshotForCapture) {
        throw conflict(
          "workspace_snapshot_capture_already_bound",
          "A source-fenced capture may be bound to only one durable snapshot request",
        );
      }
      if (capture.status !== "source-capture-fenced" || !capture.report_json) {
        throw conflict(
          "workspace_snapshot_source_unavailable",
          "A snapshot requires confirmed source-capture-fenced evidence",
        );
      }
      const thread = this.#captureThread(capture.thread_id);
      const lock = this.database.all<{ capture_id: string }>(
        "SELECT capture_id FROM managed_work_captures WHERE capture_id = ? AND thread_id = ? AND workspace_id = ?",
        [capture.capture_id, capture.thread_id, capture.workspace_id],
      )[0];
      if (
        !lock ||
        thread.node_id !== capture.node_id ||
        thread.workspace_id !== capture.workspace_id ||
        thread.ownership_generation !== capture.ownership_generation
      ) {
        throw conflict(
          "workspace_snapshot_fence_missing",
          "The original source fence or immutable target is no longer valid",
        );
      }
      const control = executionCaptureControlSchema.parse(
        JSON.parse(capture.payload_json),
      );
      const snapshotId = makeId("workspace-snapshot");
      const acceptedAt = now();
      this.database.exec(
        `INSERT INTO workspace_snapshot_requests(
          request_id, capture_request_id, snapshot_id, capture_id, actor_json,
          project_id, thread_id, node_id, workspace_id, ownership_generation,
          status, accepted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        [
          input.requestId,
          input.captureRequestId,
          snapshotId,
          control.captureId,
          encode(session.actor),
          capture.project_id,
          capture.thread_id,
          capture.node_id,
          capture.workspace_id,
          capture.ownership_generation,
          acceptedAt,
          acceptedAt,
        ],
      );
      return this.#workspaceSnapshotByRequest(input.requestId)!;
    });
    return this.#workspaceSnapshotStatus(result);
  }

  getWorkspaceSnapshotStatus(session: FactorySession, requestId: string) {
    this.#requireOwner(session);
    const row = this.#workspaceSnapshotByRequest(requestId);
    if (!row) throw notFound("Workspace snapshot request");
    if (row.actor_json !== encode(session.actor)) throw forbidden();
    return this.#workspaceSnapshotStatus(row);
  }

  /**
   * Admit one coherent-checkpoint assembly against an existing held capture and
   * verified workspace snapshot. Admission records intent only; it starts no export.
   */
  async requestManagedWorkCheckpoint(
    session: FactorySession,
    threadId: string,
    request: unknown,
  ) {
    this.#requireOwner(session);
    const input = managedWorkCheckpointRequestSchema.parse(request);
    const state = await this.getManagedWorkCaptureState(threadId);
    const result = this.database.transaction(() => {
      this.#requireOwner(session);
      const existing = this.#managedWorkCheckpointByRequest(input.requestId);
      if (existing) {
        if (
          existing.actor_json !== encode(session.actor) ||
          existing.thread_id !== threadId ||
          existing.capture_request_id !== input.captureRequestId ||
          existing.workspace_snapshot_request_id !==
            input.workspaceSnapshotRequestId
        ) {
          throw conflict(
            "managed_work_checkpoint_request_conflict",
            "The stable checkpoint request ID is already bound to another actor, thread, capture, or snapshot",
          );
        }
        this.#assertManagedWorkCheckpointAuthority(session, existing, state);
        return existing;
      }

      const capture = this.#captureControlByRequest(input.captureRequestId);
      if (!capture || capture.actor_json !== encode(session.actor)) {
        throw notFound("Owner-held source capture and workspace snapshot");
      }
      const captureBinding: ManagedWorkCheckpointBindingRow = {
        request_id: input.requestId,
        capture_request_id: input.captureRequestId,
        workspace_snapshot_request_id: input.workspaceSnapshotRequestId,
        capture_id: capture.capture_id,
        actor_json: encode(session.actor),
        project_id: capture.project_id,
        thread_id: threadId,
        node_id: capture.node_id,
        workspace_id: capture.workspace_id,
        ownership_generation: capture.ownership_generation,
      };
      if (capture.thread_id !== threadId) {
        throw conflict(
          "managed_work_checkpoint_binding_mismatch",
          "The requested capture is not bound to this thread",
        );
      }
      this.#assertManagedWorkCheckpointCaptureState(state, captureBinding);
      const snapshot = this.#workspaceSnapshotByRequest(
        input.workspaceSnapshotRequestId,
      );
      if (!snapshot || snapshot.actor_json !== encode(session.actor)) {
        throw conflict(
          "managed_work_checkpoint_prerequisite_unavailable",
          "The bound workspace snapshot is not available to this owner",
        );
      }
      if (
        snapshot.thread_id !== threadId ||
        snapshot.capture_request_id !== input.captureRequestId ||
        snapshot.capture_id !== capture.capture_id
      ) {
        throw conflict(
          "managed_work_checkpoint_binding_mismatch",
          "The requested capture and workspace snapshot are not bound to this thread",
        );
      }
      const alreadyBound = this.database.all<{ request_id: string }>(
        "SELECT request_id FROM managed_work_checkpoint_requests WHERE capture_id = ? OR capture_request_id = ? OR workspace_snapshot_request_id = ?",
        [
          capture.capture_id,
          input.captureRequestId,
          input.workspaceSnapshotRequestId,
        ],
      )[0];
      if (alreadyBound) {
        throw conflict(
          "managed_work_checkpoint_capture_already_bound",
          "A source capture may be bound to only one coherent-checkpoint request",
        );
      }
      const binding = {
        request_id: input.requestId,
        capture_request_id: input.captureRequestId,
        workspace_snapshot_request_id: input.workspaceSnapshotRequestId,
        capture_id: capture.capture_id,
        actor_json: encode(session.actor),
        project_id: capture.project_id,
        thread_id: threadId,
        node_id: capture.node_id,
        workspace_id: capture.workspace_id,
        ownership_generation: capture.ownership_generation,
      };
      this.#assertManagedWorkCheckpointPrerequisites(
        session,
        binding,
        capture,
        snapshot,
      );
      this.#assertManagedWorkCheckpointCaptureState(state, binding);
      const acceptedAt = now();
      this.database.exec(
        `INSERT INTO managed_work_checkpoint_requests(
          request_id, capture_request_id, workspace_snapshot_request_id,
          capture_id, actor_json, project_id, thread_id, node_id, workspace_id,
          ownership_generation, status, stage, accepted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assembling', 'admitted', ?, ?)`,
        [
          input.requestId,
          input.captureRequestId,
          input.workspaceSnapshotRequestId,
          capture.capture_id,
          encode(session.actor),
          capture.project_id,
          threadId,
          capture.node_id,
          capture.workspace_id,
          capture.ownership_generation,
          acceptedAt,
          acceptedAt,
        ],
      );
      return this.#managedWorkCheckpointByRequest(input.requestId)!;
    });
    return this.#managedWorkCheckpointStatus(result);
  }

  /** Owner-only read revalidates the original held source authority on every query. */
  async getManagedWorkCheckpointStatus(
    session: FactorySession,
    requestId: string,
  ) {
    this.#requireOwner(session);
    const row = this.#managedWorkCheckpointByRequest(requestId);
    if (!row) throw notFound("Managed-work checkpoint request");
    if (row.actor_json !== encode(session.actor)) throw forbidden();
    const state = await this.getManagedWorkCaptureState(row.thread_id);
    const current = this.database.transaction(() => {
      this.#requireOwner(session);
      const persisted = this.#managedWorkCheckpointByRequest(requestId);
      if (!persisted) throw notFound("Managed-work checkpoint request");
      if (persisted.actor_json !== encode(session.actor)) throw forbidden();
      this.#assertManagedWorkCheckpointAuthority(session, persisted, state);
      return persisted;
    });
    return this.#managedWorkCheckpointStatus(current);
  }

  /** Admit one owner-bound destination reservation against an available coherent checkpoint. */
  async requestWorkspaceRelocation(
    session: FactorySession,
    threadId: string,
    request: unknown,
  ): Promise<WorkspaceRelocationStatus> {
    this.#requireOwner(session);
    const input = workspaceRelocationRequestSchema.parse(request);
    const initialRequest = this.#workspaceRelocationByRequest(input.requestId);
    if (
      initialRequest &&
      (initialRequest.actor_json !== encode(session.actor) ||
        initialRequest.thread_id !== threadId ||
        initialRequest.checkpoint_request_id !== input.checkpointRequestId ||
        initialRequest.destination_node_id !== input.destination.nodeId ||
        initialRequest.destination_workspace_id !==
          input.destination.workspaceId)
    ) {
      throw conflict(
        "workspace_relocation_request_conflict",
        "The stable relocation request ID is already bound to another checkpoint or destination",
      );
    }
    const initialCheckpoint = this.#managedWorkCheckpointByRequest(
      initialRequest?.checkpoint_request_id ?? input.checkpointRequestId,
    );
    if (
      !initialCheckpoint ||
      initialCheckpoint.actor_json !== encode(session.actor)
    ) {
      throw notFound("Owner's available coherent checkpoint");
    }
    const state = await this.getManagedWorkCaptureState(
      initialCheckpoint.thread_id,
    );
    const result = this.database.transaction(() => {
      this.#requireOwner(session);
      const existing = this.#workspaceRelocationByRequest(input.requestId);
      if (existing) {
        if (
          existing.actor_json !== encode(session.actor) ||
          existing.thread_id !== threadId ||
          existing.checkpoint_request_id !== input.checkpointRequestId ||
          existing.destination_node_id !== input.destination.nodeId ||
          existing.destination_workspace_id !== input.destination.workspaceId
        ) {
          throw conflict(
            "workspace_relocation_request_conflict",
            "The stable relocation request ID is already bound to another checkpoint or destination",
          );
        }
        this.#assertWorkspaceRelocationAuthority(session, existing, state);
        return existing;
      }

      const checkpoint = this.#managedWorkCheckpointByRequest(
        input.checkpointRequestId,
      );
      if (
        !checkpoint ||
        checkpoint.actor_json !== encode(session.actor) ||
        checkpoint.thread_id !== threadId
      ) {
        throw conflict(
          "workspace_relocation_checkpoint_mismatch",
          "The checkpoint is not bound to this owner and thread",
        );
      }
      if (
        checkpoint.status !== "available" ||
        checkpoint.stage !== "available" ||
        !checkpoint.manifest_reference
      ) {
        throw conflict(
          "workspace_relocation_checkpoint_unavailable",
          "Relocation requires an available published coherent checkpoint",
        );
      }
      this.#assertManagedWorkCheckpointAuthority(session, checkpoint, state);
      const alreadyBound = this.database.all<{ request_id: string }>(
        `SELECT request_id FROM workspace_relocations
         WHERE checkpoint_request_id = ? OR capture_request_id = ?
           OR capture_id = ? OR workspace_snapshot_request_id = ? LIMIT 1`,
        [
          checkpoint.request_id,
          checkpoint.capture_request_id,
          checkpoint.capture_id,
          checkpoint.workspace_snapshot_request_id,
        ],
      )[0];
      if (alreadyBound) {
        throw conflict(
          "workspace_relocation_checkpoint_already_bound",
          "A coherent checkpoint and its source snapshot may be prepared for only one destination",
        );
      }
      const snapshot = this.#workspaceSnapshotByRequest(
        checkpoint.workspace_snapshot_request_id,
      );
      if (!snapshot || snapshot.status !== "workspace-checkpoint-available") {
        throw conflict("workspace_relocation_snapshot_unavailable");
      }
      this.#assertWorkspaceRelocationDestination({
        sourceNodeId: checkpoint.node_id,
        sourceWorkspaceId: checkpoint.workspace_id,
        destinationNodeId: input.destination.nodeId,
        destinationWorkspaceId: input.destination.workspaceId,
      });
      const acceptedAt = now();
      this.database.exec(
        `INSERT INTO workspace_relocations(
          request_id, relocation_id, checkpoint_request_id, capture_request_id,
          capture_id, workspace_snapshot_request_id, snapshot_id, actor_json,
          project_id, thread_id, source_node_id, source_workspace_id,
          destination_node_id, destination_workspace_id, ownership_generation,
          manifest_reference, status, accepted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        [
          input.requestId,
          makeId("workspace-relocation"),
          checkpoint.request_id,
          checkpoint.capture_request_id,
          checkpoint.capture_id,
          checkpoint.workspace_snapshot_request_id,
          snapshot.snapshot_id,
          checkpoint.actor_json,
          checkpoint.project_id,
          checkpoint.thread_id,
          checkpoint.node_id,
          checkpoint.workspace_id,
          input.destination.nodeId,
          input.destination.workspaceId,
          checkpoint.ownership_generation,
          snapshot.manifest_reference,
          acceptedAt,
          acceptedAt,
        ],
      );
      const created = this.#workspaceRelocationByRequest(input.requestId);
      if (!created) throw new Error("Workspace relocation insert was lost");
      return created;
    });
    return this.#workspaceRelocationStatus(result);
  }

  /** Owner status lookup rechecks the same source fence and immutable checkpoint binding. */
  async getWorkspaceRelocationStatus(
    session: FactorySession,
    requestId: string,
  ): Promise<WorkspaceRelocationStatus> {
    this.#requireOwner(session);
    const initial = this.#workspaceRelocationByRequest(requestId);
    if (!initial) throw notFound("Workspace relocation request");
    if (initial.actor_json !== encode(session.actor)) throw forbidden();
    const state = await this.getManagedWorkCaptureState(initial.thread_id);
    const current = this.database.transaction(() => {
      this.#requireOwner(session);
      const row = this.#workspaceRelocationByRequest(requestId);
      if (!row) throw notFound("Workspace relocation request");
      if (row.actor_json !== encode(session.actor)) throw forbidden();
      this.#assertWorkspaceRelocationAuthority(session, row, state);
      return row;
    });
    return this.#workspaceRelocationStatus(current);
  }

  /** Trusted FactoryController read; authority is checked before and after bounded projections. */
  async getManagedWorkCheckpointAssembly(requestId: string) {
    const initial = this.#managedWorkCheckpointByRequest(requestId);
    if (!initial) throw notFound("Managed-work checkpoint request");
    const session = this.#managedWorkCheckpointOwnerSession(initial);
    const state = await this.getManagedWorkCaptureState(initial.thread_id);
    const source = this.database.transaction(() => {
      const row = this.#managedWorkCheckpointByRequest(requestId);
      if (!row) throw notFound("Managed-work checkpoint request");
      if (row.actor_json !== encode(session.actor)) throw forbidden();
      this.#assertManagedWorkCheckpointAuthority(session, row, state);
      const capture = this.#captureControlByRequest(row.capture_request_id);
      const snapshot = this.#workspaceSnapshotByRequest(
        row.workspace_snapshot_request_id,
      );
      if (
        !capture?.report_json ||
        !capture.report_sha256 ||
        !snapshot?.report_json ||
        !snapshot.manifest_reference ||
        !snapshot.report_sha256
      ) {
        throw checkpointConflict(
          "managed_work_checkpoint_prerequisite_unavailable",
        );
      }
      return { row, capture, snapshot };
    });
    const { row, capture, snapshot } = source;
    const runtimeRequirements = parsePersistedManagedWorkRuntimeRequirements(
      row.runtime_requirements_json,
    );
    if (
      row.stage !== "admitted" &&
      row.stage !== "runtime-export-started" &&
      !runtimeRequirements
    ) {
      throw checkpointConflict(
        "managed_work_checkpoint_prerequisite_unavailable",
      );
    }
    const captureReport = executionCaptureControlReportSchema.parse(
      JSON.parse(capture.report_json!),
    );
    const snapshotReport = workspaceSnapshotReportSchema.parse(
      JSON.parse(snapshot.report_json!),
    );
    if (
      captureReport.status !== "source-capture-fenced" ||
      captureReport.requestId !== row.capture_request_id ||
      captureReport.captureId !== row.capture_id ||
      captureReport.nodeId !== row.node_id ||
      captureReport.target.workspaceId !== row.workspace_id ||
      captureReport.ownershipGeneration !== row.ownership_generation ||
      !captureReport.sourceFence ||
      snapshotReport.status !== "workspace-checkpoint-available" ||
      snapshotReport.requestId !== row.workspace_snapshot_request_id ||
      snapshotReport.captureRequestId !== row.capture_request_id ||
      snapshotReport.captureId !== row.capture_id ||
      snapshotReport.nodeId !== row.node_id ||
      snapshotReport.target.workspaceId !== row.workspace_id ||
      snapshotReport.ownershipGeneration !== row.ownership_generation ||
      snapshotReport.manifestReference !== snapshot.manifest_reference
    ) {
      throw checkpointConflict(
        "managed_work_checkpoint_prerequisite_unavailable",
      );
    }
    const projected = this.#boundedManagedWorkCheckpointCommands(
      row.thread_id,
      row,
    );
    const evidenceHeader = {
      contractVersion: CONTRACT_VERSION,
      format: "uzina-factory-managed-work-provenance" as const,
      version: 1 as const,
      checkpointRequestId: row.request_id,
      threadId: row.thread_id,
      projectId: row.project_id,
      capture: {
        requestId: row.capture_request_id,
        captureId: row.capture_id,
        controlId: captureReport.controlId,
        target: { nodeId: row.node_id, workspaceId: row.workspace_id },
        ownershipGeneration: row.ownership_generation,
        reportSha256: capture.report_sha256!,
        sourceFence: captureReport.sourceFence,
      },
      workspaceSnapshot: {
        requestId: row.workspace_snapshot_request_id,
        snapshotId: snapshot.snapshot_id,
        captureId: row.capture_id,
        status: snapshot.status,
        manifestReference: snapshot.manifest_reference!,
        reportSha256: snapshot.report_sha256!,
      },
    };
    const evidenceShell = {
      ...evidenceHeader,
      commands: [] as FactoryProvenanceCommand[],
    };
    const encoder = new TextEncoder();
    const shellBytes = encoder.encode(JSON.stringify(evidenceShell)).byteLength;
    const projectedEvidenceBytes = shellBytes - 2 + projected.serializedBytes;
    if (projectedEvidenceBytes > 32 * 1024 * 1024) {
      throw checkpointConflict("managed_work_checkpoint_evidence_limit");
    }
    const evidence: FactoryProvenanceEvidence =
      factoryProvenanceEvidenceSchema.parse({
        ...evidenceHeader,
        commands: projected.commands,
      });
    const evidenceBytes = encoder.encode(JSON.stringify(evidence));
    if (
      evidenceBytes.byteLength > 32 * 1024 * 1024 ||
      evidenceBytes.byteLength !== projectedEvidenceBytes
    ) {
      throw checkpointConflict("managed_work_checkpoint_evidence_limit");
    }
    return this.database.transaction(() => {
      const current = this.#managedWorkCheckpointByRequest(requestId);
      if (!current) throw notFound("Managed-work checkpoint request");
      if (current.actor_json !== encode(session.actor)) throw forbidden();
      this.#assertManagedWorkCheckpointAuthority(session, current, state);
      const currentCapture = this.#captureControlByRequest(
        current.capture_request_id,
      );
      const currentSnapshot = this.#workspaceSnapshotByRequest(
        current.workspace_snapshot_request_id,
      );
      if (
        current.capture_id !== row.capture_id ||
        currentCapture?.report_sha256 !== capture.report_sha256 ||
        currentSnapshot?.manifest_reference !== snapshot.manifest_reference ||
        currentSnapshot?.report_sha256 !== snapshot.report_sha256
      ) {
        throw checkpointConflict(
          "managed_work_checkpoint_prerequisite_unavailable",
        );
      }
      const workspaceReferences = this.database.all<{
        reference: string;
        size_bytes: number;
      }>(
        "SELECT reference, size_bytes FROM workspace_snapshot_blobs WHERE capture_id = ? ORDER BY reference",
        [current.capture_id],
      );
      const artifacts = this.database.all<ManagedWorkCheckpointArtifactRow>(
        "SELECT * FROM managed_work_checkpoint_artifacts WHERE request_id = ? ORDER BY role, reference",
        [requestId],
      );
      return {
        request: this.#managedWorkCheckpointStatus(current),
        ...(runtimeRequirements ? { runtimeRequirements } : {}),
        sourceWorkspaceManifestReference: currentSnapshot!.manifest_reference!,
        authoritativeWorkspaceReferences: workspaceReferences.map((blob) => ({
          reference: blob.reference,
          size: blob.size_bytes,
        })),
        evidence,
        evidenceBytes,
        privateArtifacts: artifacts.map((artifact) => ({
          role: artifact.role,
          reference: artifact.reference,
          size: artifact.size_bytes,
        })),
      };
    });
  }

  /** Internal assembly recovery scans only a bounded batch of persisted receipts. */
  listManagedWorkCheckpointAssemblies(limit = 32): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      throw new FactoryError(400, "invalid_checkpoint_batch_limit");
    }
    return this.database
      .all<{ request_id: string }>(
        "SELECT request_id FROM managed_work_checkpoint_requests WHERE status = 'assembling' ORDER BY accepted_at, request_id LIMIT ?",
        [limit],
      )
      .map((row) => row.request_id);
  }

  /** Starts one persisted effect phase after rechecking the live source authority. */
  async beginManagedWorkCheckpointStage(
    requestId: string,
    expectedStage: ManagedWorkCheckpointStage,
    nextStage: ManagedWorkCheckpointStage,
  ): Promise<void> {
    if (!validManagedWorkCheckpointTransition(expectedStage, nextStage)) {
      throw new FactoryError(400, "invalid_checkpoint_stage_transition");
    }
    const row = this.#managedWorkCheckpointByRequest(requestId);
    if (!row) throw notFound("Managed-work checkpoint request");
    const session = this.#managedWorkCheckpointOwnerSession(row);
    const state = await this.getManagedWorkCaptureState(row.thread_id);
    this.database.transaction(() => {
      const current = this.#managedWorkCheckpointByRequest(requestId);
      if (!current) throw notFound("Managed-work checkpoint request");
      this.#assertManagedWorkCheckpointAuthority(session, current, state);
      if (current.status !== "assembling" || current.stage !== expectedStage) {
        throw conflict("managed_work_checkpoint_stage_conflict");
      }
      this.database.exec(
        "UPDATE managed_work_checkpoint_requests SET stage = ?, updated_at = ? WHERE request_id = ? AND status = 'assembling' AND stage = ?",
        [nextStage, now(), requestId, expectedStage],
      );
    });
  }

  /** Records verified immutable output refs atomically with their completed stage. */
  async recordManagedWorkCheckpointArtifacts(
    requestId: string,
    expectedStage: ManagedWorkCheckpointStage,
    nextStage: ManagedWorkCheckpointStage,
    artifacts: readonly ManagedWorkCheckpointArtifactReference[],
    runtimeRequirements?: readonly string[],
  ): Promise<void> {
    const normalizedRuntimeRequirements =
      normalizeManagedWorkRuntimeRequirements(runtimeRequirements);
    if (
      !validManagedWorkCheckpointArtifactTransition(
        expectedStage,
        nextStage,
        artifacts,
        runtimeRequirements,
      )
    ) {
      throw new FactoryError(400, "invalid_checkpoint_artifact_transition");
    }
    const row = this.#managedWorkCheckpointByRequest(requestId);
    if (!row) throw notFound("Managed-work checkpoint request");
    const session = this.#managedWorkCheckpointOwnerSession(row);
    const state = await this.getManagedWorkCaptureState(row.thread_id);
    this.database.transaction(() => {
      const current = this.#managedWorkCheckpointByRequest(requestId);
      if (!current) throw notFound("Managed-work checkpoint request");
      this.#assertManagedWorkCheckpointAuthority(session, current, state);
      if (current.status !== "assembling" || current.stage !== expectedStage) {
        throw conflict("managed_work_checkpoint_stage_conflict");
      }
      const timestamp = now();
      if (
        nextStage === "runtime-export-recorded" &&
        current.runtime_requirements_json !== null
      ) {
        throw conflict("managed_work_checkpoint_runtime_requirements_conflict");
      }
      for (const artifact of artifacts) {
        validateCheckpointArtifact(artifact);
        const prior = this.database.all<ManagedWorkCheckpointArtifactRow>(
          "SELECT * FROM managed_work_checkpoint_artifacts WHERE request_id = ? AND role = ? AND reference = ?",
          [requestId, artifact.role, artifact.reference],
        )[0];
        if (prior && prior.size_bytes !== artifact.size) {
          throw conflict("managed_work_checkpoint_artifact_conflict");
        }
        if (!prior) {
          this.database.exec(
            "INSERT INTO managed_work_checkpoint_artifacts(request_id, role, reference, size_bytes, verified_at) VALUES (?, ?, ?, ?, ?)",
            [
              requestId,
              artifact.role,
              artifact.reference,
              artifact.size,
              timestamp,
            ],
          );
        }
      }
      if (nextStage === "runtime-export-recorded") {
        if (!normalizedRuntimeRequirements) {
          throw new FactoryError(
            400,
            "invalid_checkpoint_runtime_requirements",
          );
        }
        this.database.exec(
          "UPDATE managed_work_checkpoint_requests SET stage = ?, runtime_requirements_json = ?, updated_at = ? WHERE request_id = ? AND status = 'assembling' AND stage = ?",
          [
            nextStage,
            JSON.stringify(normalizedRuntimeRequirements),
            timestamp,
            requestId,
            expectedStage,
          ],
        );
      } else {
        this.database.exec(
          "UPDATE managed_work_checkpoint_requests SET stage = ?, updated_at = ? WHERE request_id = ? AND status = 'assembling' AND stage = ?",
          [nextStage, timestamp, requestId, expectedStage],
        );
      }
    });
  }

  /** Terminally refuses an assembly without ever exposing a manifest reference. */
  markManagedWorkCheckpointOutcome(
    requestId: string,
    outcome: "blocked" | "uncertain",
  ): void {
    this.database.transaction(() => {
      const row = this.#managedWorkCheckpointByRequest(requestId);
      if (!row) throw notFound("Managed-work checkpoint request");
      if (row.status === "available") return;
      if (row.status !== "assembling") return;
      this.database.exec(
        "UPDATE managed_work_checkpoint_requests SET status = ?, manifest_reference = NULL, updated_at = ? WHERE request_id = ? AND status = 'assembling'",
        [outcome, now(), requestId],
      );
    });
  }

  /** Only the trusted controller may publish a closure verified against these persisted rows. */
  async publishManagedWorkCheckpoint(
    requestId: string,
    manifestReference: string,
    verification: unknown,
  ) {
    const row = this.#managedWorkCheckpointByRequest(requestId);
    if (!row) throw notFound("Managed-work checkpoint request");
    const session = this.#managedWorkCheckpointOwnerSession(row);
    const state = await this.getManagedWorkCaptureState(row.thread_id);
    return this.database.transaction(() => {
      const current = this.#managedWorkCheckpointByRequest(requestId);
      if (!current) throw notFound("Managed-work checkpoint request");
      this.#assertManagedWorkCheckpointAuthority(session, current, state);
      if (current.status === "available") {
        if (current.manifest_reference !== manifestReference) {
          throw conflict("managed_work_checkpoint_publication_conflict");
        }
        return this.#managedWorkCheckpointStatus(current);
      }
      if (
        current.status !== "assembling" ||
        current.stage !== "closure-verification-started" ||
        !/^[a-f0-9]{64}$/.test(manifestReference)
      ) {
        throw conflict("managed_work_checkpoint_verification_mismatch");
      }
      const snapshot = this.#workspaceSnapshotByRequest(
        current.workspace_snapshot_request_id,
      );
      if (!snapshot?.manifest_reference) {
        throw conflict("managed_work_checkpoint_verification_mismatch");
      }
      const workspaceTotals = this.database.all<{
        count: number;
        total_size: number | null;
      }>(
        "SELECT COUNT(*) AS count, SUM(size_bytes) AS total_size FROM workspace_snapshot_blobs WHERE capture_id = ?",
        [current.capture_id],
      )[0];
      const workspaceReferences = this.database.all<{
        reference: string;
        size_bytes: number;
      }>(
        "SELECT reference, size_bytes FROM workspace_snapshot_blobs WHERE capture_id = ? ORDER BY reference",
        [current.capture_id],
      );
      const privateRows = this.database.all<ManagedWorkCheckpointArtifactRow>(
        "SELECT * FROM managed_work_checkpoint_artifacts WHERE request_id = ? ORDER BY role, reference",
        [requestId],
      );
      const runtimeRequirements = parsePersistedManagedWorkRuntimeRequirements(
        current.runtime_requirements_json,
      );
      if (!runtimeRequirements) {
        throw conflict("managed_work_checkpoint_verification_mismatch");
      }
      const privateObjects = new Map<string, number>();
      for (const artifact of privateRows) {
        const existing = privateObjects.get(artifact.reference);
        if (existing !== undefined && existing !== artifact.size_bytes) {
          throw conflict("managed_work_checkpoint_artifact_conflict");
        }
        privateObjects.set(artifact.reference, artifact.size_bytes);
      }
      if (
        !isVerifiedManagedWorkCheckpointClosure(verification, {
          checkpointRequestId: current.request_id,
          captureId: current.capture_id,
          sourceWorkspaceManifestReference: snapshot.manifest_reference,
          manifestReference,
          authoritativeWorkspaceReferences: workspaceReferences.map((blob) => ({
            reference: blob.reference,
            size: blob.size_bytes,
          })),
          expectedRuntimeRequirements: runtimeRequirements,
          privateArtifacts: privateRows.map((artifact) => ({
            role: artifact.role,
            reference: artifact.reference,
            size: artifact.size_bytes,
          })),
        })
      ) {
        throw conflict("managed_work_checkpoint_verification_mismatch");
      }
      const workspaceCount = Number(workspaceTotals?.count ?? 0);
      const workspaceBytes = Number(workspaceTotals?.total_size ?? 0);
      const privateBytes = [...privateObjects.values()].reduce(
        (sum, size) => sum + size,
        0,
      );
      const totalBytes = workspaceBytes + privateBytes;
      if (
        !workspaceTotals ||
        !Number.isSafeInteger(workspaceCount) ||
        !Number.isSafeInteger(workspaceBytes) ||
        !Number.isSafeInteger(privateBytes) ||
        workspaceCount !== verification.workspaceObjectCount ||
        privateObjects.size !== verification.privateObjectCount ||
        totalBytes !== verification.totalBytes ||
        totalBytes > 512 * 1024 * 1024 ||
        !privateRows.some(
          (artifact) =>
            artifact.role === "outer-manifest" &&
            artifact.reference === manifestReference,
        )
      ) {
        throw conflict("managed_work_checkpoint_verification_mismatch");
      }
      const timestamp = now();
      this.database.exec(
        "UPDATE managed_work_checkpoint_requests SET status = 'available', stage = 'available', manifest_reference = ?, updated_at = ? WHERE request_id = ? AND status = 'assembling' AND stage = 'closure-verification-started'",
        [manifestReference, timestamp, requestId],
      );
      const published = this.#managedWorkCheckpointByRequest(requestId);
      if (!published) throw notFound("Managed-work checkpoint request");
      return this.#managedWorkCheckpointStatus(published);
    });
  }

  /** Owner-only allowlist for one final binary response. */
  async getAuthorizedManagedWorkCheckpointBlob(
    session: FactorySession,
    requestId: string,
    reference: string,
  ) {
    this.#requireOwner(session);
    const row = this.#managedWorkCheckpointByRequest(requestId);
    if (!row) throw notFound("Managed-work checkpoint request");
    if (row.actor_json !== encode(session.actor)) throw forbidden();
    const state = await this.getManagedWorkCaptureState(row.thread_id);
    return this.database.transaction(() => {
      this.#requireOwner(session);
      const current = this.#managedWorkCheckpointByRequest(requestId);
      if (!current) throw notFound("Managed-work checkpoint request");
      if (current.actor_json !== encode(session.actor)) throw forbidden();
      this.#assertManagedWorkCheckpointAuthority(session, current, state);
      if (current.status !== "available" || !current.manifest_reference) {
        throw notFound("Available managed-work checkpoint blob");
      }
      const privateArtifact =
        this.database.all<ManagedWorkCheckpointArtifactRow>(
          "SELECT * FROM managed_work_checkpoint_artifacts WHERE request_id = ? AND reference = ? LIMIT 1",
          [requestId, reference],
        )[0];
      if (privateArtifact) {
        return {
          scope: "private" as const,
          requestId,
          captureId: current.capture_id,
          reference,
          size: privateArtifact.size_bytes,
        };
      }
      const workspaceBlob = this.database.all<{
        reference: string;
        size_bytes: number;
      }>(
        "SELECT reference, size_bytes FROM workspace_snapshot_blobs WHERE capture_id = ? AND reference = ?",
        [current.capture_id, reference],
      )[0];
      if (!workspaceBlob) throw notFound("Managed-work checkpoint blob");
      return {
        scope: "workspace" as const,
        requestId,
        captureId: current.capture_id,
        reference,
        size: workspaceBlob.size_bytes,
      };
    });
  }

  claimWorkspaceSnapshot(
    session: FactorySession,
    request: unknown,
  ): WorkspaceSnapshotClaim | null {
    const input = workspaceSnapshotClaimRequestSchema.parse(request);
    this.#requireNode(session, input.nodeId);
    return this.database.transaction(() => {
      this.#requireNode(session, input.nodeId);
      const node = this.database.all<NodeRow>(
        "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
        [input.nodeId],
      )[0];
      if (!node || !this.#isNodeOnline(node)) return null;
      const row = this.database.all<WorkspaceSnapshotRow>(
        `SELECT * FROM workspace_snapshot_requests WHERE node_id = ?
         AND status IN ('queued', 'claimed') ORDER BY accepted_at, snapshot_id LIMIT 1`,
        [input.nodeId],
      )[0];
      if (!row) return null;
      if (!this.#isWorkspaceSnapshotFenceValid(row)) return null;
      if (row.status === "queued") {
        this.database.exec(
          "UPDATE workspace_snapshot_requests SET status = 'claimed', claimed_at = ?, updated_at = ? WHERE snapshot_id = ? AND status = 'queued'",
          [now(), now(), row.snapshot_id],
        );
      }
      return workspaceSnapshotClaimSchema.parse({
        contractVersion: EXECUTION_CONTRACT_VERSION,
        snapshotId: row.snapshot_id,
        requestId: row.request_id,
        captureRequestId: row.capture_request_id,
        captureId: row.capture_id,
        nodeId: row.node_id,
        target: { nodeId: row.node_id, workspaceId: row.workspace_id },
        ownershipGeneration: row.ownership_generation,
      });
    });
  }

  async reportWorkspaceSnapshot(
    session: FactorySession,
    nodeId: string,
    snapshotId: string,
    report: unknown,
    verifiedBlobs: readonly { reference: string; size: number }[] = [],
  ) {
    const input = workspaceSnapshotReportSchema.parse(report);
    this.#requireNode(session, nodeId);
    const row = this.#workspaceSnapshotById(snapshotId);
    if (!row) throw notFound("Assigned workspace snapshot");
    if (
      input.nodeId !== nodeId ||
      row.node_id !== nodeId ||
      row.snapshot_id !== snapshotId ||
      row.request_id !== input.requestId ||
      row.capture_request_id !== input.captureRequestId ||
      row.capture_id !== input.captureId ||
      row.workspace_id !== input.target.workspaceId ||
      row.node_id !== input.target.nodeId ||
      row.ownership_generation !== input.ownershipGeneration
    ) {
      throw conflict(
        "workspace_snapshot_assignment_mismatch",
        "Snapshot report does not match its persisted assignment",
      );
    }
    const reportHash = await sha256(stableJson(input));
    this.database.transaction(() => {
      this.#requireNode(session, nodeId);
      const current = this.#workspaceSnapshotById(snapshotId);
      if (!current) throw notFound("Assigned workspace snapshot");
      if (current.report_json !== null) {
        if (current.report_sha256 !== reportHash) {
          throw conflict(
            "workspace_snapshot_report_conflict",
            "A different workspace snapshot report is already committed",
          );
        }
        return;
      }
      if (current.status !== "claimed") {
        throw conflict(
          "workspace_snapshot_not_claimed",
          "Snapshot report has no persisted claim",
        );
      }
      if (!this.#isWorkspaceSnapshotFenceValid(current)) {
        throw conflict(
          "workspace_snapshot_source_fence_lost",
          "The original source capture fence is no longer valid",
        );
      }
      if (input.status === "workspace-checkpoint-available") {
        const references = new Map(
          verifiedBlobs.map(({ reference, size }) => [reference, size]),
        );
        if (
          references.size !== verifiedBlobs.length ||
          !input.manifestReference ||
          !references.has(input.manifestReference) ||
          references.size === 0 ||
          references.size > 100_003 ||
          [...references.values()].some(
            (size) =>
              !Number.isSafeInteger(size) ||
              size < 0 ||
              size > 512 * 1024 * 1024,
          ) ||
          [...references.values()].reduce((sum, size) => sum + size, 0) >
            512 * 1024 * 1024
        ) {
          throw conflict(
            "workspace_snapshot_integrity_unverified",
            "Available snapshots require bounded verified manifest references",
          );
        }
        for (const [reference, size] of references) {
          if (!/^[a-f0-9]{64}$/.test(reference)) {
            throw conflict(
              "workspace_snapshot_integrity_unverified",
              "Snapshot blob references must be lowercase SHA-256 digests",
            );
          }
          this.database.exec(
            "INSERT INTO workspace_snapshot_blobs(capture_id, reference, size_bytes) VALUES (?, ?, ?)",
            [current.capture_id, reference, size],
          );
        }
      } else if (verifiedBlobs.length > 0) {
        throw conflict(
          "workspace_snapshot_unavailable_with_blobs",
          "A blocked snapshot cannot publish blob references",
        );
      }
      this.database.exec(
        `UPDATE workspace_snapshot_requests SET status = ?, updated_at = ?, manifest_reference = ?,
          report_json = ?, report_sha256 = ?, error_code = ? WHERE snapshot_id = ? AND status = 'claimed'`,
        [
          input.status,
          input.reportedAt,
          input.manifestReference ?? null,
          encode(input),
          reportHash,
          input.errorCode ?? null,
          snapshotId,
        ],
      );
    });
    return workspaceSnapshotReportResponseSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      nodeId,
      snapshotId,
      captureId: input.captureId,
      accepted: true,
      status: input.status,
    });
  }

  authorizeWorkspaceSnapshotUpload(
    session: FactorySession,
    nodeId: string,
    captureId: string,
  ): boolean {
    this.#requireNode(session, nodeId);
    const row = this.#workspaceSnapshotByCapture(captureId);
    return Boolean(
      row &&
      row.node_id === nodeId &&
      row.status === "claimed" &&
      this.#isWorkspaceSnapshotFenceValid(row),
    );
  }

  getAuthorizedWorkspaceSnapshotBlobReferences(
    session: FactorySession,
    captureId: string,
  ): string[] {
    this.#requireOwner(session);
    const row = this.#workspaceSnapshotByCapture(captureId);
    if (
      !row ||
      row.actor_json !== encode(session.actor) ||
      row.status !== "workspace-checkpoint-available"
    ) {
      throw notFound("Workspace checkpoint");
    }
    return this.database
      .all<{ reference: string }>(
        "SELECT reference FROM workspace_snapshot_blobs WHERE capture_id = ? ORDER BY reference",
        [captureId],
      )
      .map((item) => item.reference);
  }

  /** Destination-node claims are fixed to their provisioned workspace and never reassigned. */
  async claimWorkspaceRelocation(
    session: FactorySession,
    request: unknown,
  ): Promise<WorkspaceRelocationClaim | null> {
    const input = workspaceRelocationClaimRequestSchema.parse(request);
    this.#requireNode(session, input.nodeId);
    const node = this.database.all<NodeRow>(
      "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
      [input.nodeId],
    )[0];
    if (!node || !this.#isNodeOnline(node)) return null;
    const initial = this.database.all<WorkspaceRelocationRow>(
      `SELECT * FROM workspace_relocations WHERE destination_node_id = ?
       AND status IN ('claimed', 'queued')
       ORDER BY CASE status WHEN 'claimed' THEN 0 ELSE 1 END, accepted_at, relocation_id LIMIT 1`,
      [input.nodeId],
    )[0];
    if (!initial) return null;
    const ownerSession = this.#workspaceRelocationOwnerSession(initial);
    const state = await this.getManagedWorkCaptureState(initial.thread_id);
    return this.database.transaction(() => {
      this.#requireNode(session, input.nodeId);
      const currentNode = this.database.all<NodeRow>(
        "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
        [input.nodeId],
      )[0];
      if (!currentNode || !this.#isNodeOnline(currentNode)) return null;
      const current = this.#workspaceRelocationById(initial.relocation_id);
      if (
        !current ||
        current.destination_node_id !== input.nodeId ||
        !["queued", "claimed"].includes(current.status)
      ) {
        return null;
      }
      this.#assertWorkspaceRelocationAuthority(ownerSession, current, state);
      if (current.status === "queued") {
        this.database.exec(
          "UPDATE workspace_relocations SET status = 'claimed', claimed_at = ?, updated_at = ? WHERE relocation_id = ? AND status = 'queued'",
          [now(), now(), current.relocation_id],
        );
      }
      const claimed = this.#workspaceRelocationById(current.relocation_id);
      if (!claimed || claimed.status !== "claimed") return null;
      return workspaceRelocationClaimSchema.parse(
        this.#workspaceRelocationAssignment(claimed),
      );
    });
  }

  /** Persist the destination node's exact local receipt binding once; retries are idempotent. */
  async reportWorkspaceRelocation(
    session: FactorySession,
    nodeId: string,
    relocationId: string,
    report: unknown,
  ) {
    const input = workspaceRelocationReportSchema.parse(report);
    this.#requireNode(session, nodeId);
    const initial = this.#workspaceRelocationById(relocationId);
    if (!initial) throw notFound("Assigned workspace relocation");
    this.#assertWorkspaceRelocationReportBinding(
      initial,
      nodeId,
      relocationId,
      input,
    );
    const ownerSession = this.#workspaceRelocationOwnerSession(initial);
    const reportHash = await sha256(stableJson(input));
    const state = await this.getManagedWorkCaptureState(initial.thread_id);
    this.database.transaction(() => {
      this.#requireNode(session, nodeId);
      const current = this.#workspaceRelocationById(relocationId);
      if (!current) throw notFound("Assigned workspace relocation");
      this.#assertWorkspaceRelocationReportBinding(
        current,
        nodeId,
        relocationId,
        input,
      );
      this.#assertWorkspaceRelocationAuthority(ownerSession, current, state);
      if (current.report_json !== null) {
        if (current.report_sha256 === reportHash) return;
        if (
          current.status !== "prepared-inactive" ||
          input.status !== "uncertain" ||
          input.previousReceiptSha256 !== current.receipt_sha256
        ) {
          throw conflict(
            "workspace_relocation_report_conflict",
            "A different destination preparation report is already committed",
          );
        }
        this.database.exec(
          `UPDATE workspace_relocations SET status = 'uncertain', updated_at = ?,
            previous_report_json = report_json,
            previous_report_sha256 = report_sha256,
            previous_receipt_sha256 = receipt_sha256,
            report_json = ?, report_sha256 = ?, receipt_sha256 = ?, error_code = ?
           WHERE relocation_id = ? AND status = 'prepared-inactive' AND receipt_sha256 = ?`,
          [
            input.reportedAt,
            encode(input),
            reportHash,
            input.receiptSha256,
            input.errorCode ?? null,
            relocationId,
            input.previousReceiptSha256,
          ],
        );
        return;
      }
      if (current.status !== "claimed") {
        throw conflict(
          "workspace_relocation_not_claimed",
          "A relocation report requires the persisted destination claim",
        );
      }
      this.database.exec(
        `UPDATE workspace_relocations SET status = ?, updated_at = ?, report_json = ?,
          report_sha256 = ?, receipt_sha256 = ?, previous_receipt_sha256 = ?, error_code = ?
         WHERE relocation_id = ? AND status = 'claimed' AND report_json IS NULL`,
        [
          input.status,
          input.reportedAt,
          encode(input),
          reportHash,
          input.receiptSha256,
          input.previousReceiptSha256 ?? null,
          input.errorCode ?? null,
          relocationId,
        ],
      );
    });
    return workspaceRelocationReportResponseSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      nodeId,
      relocationId,
      accepted: true,
      status: input.status,
    });
  }

  /** Narrow destination-only stream authorization for an exact verified source snapshot blob. */
  async getAuthorizedWorkspaceRelocationBlob(
    session: FactorySession,
    nodeId: string,
    relocationId: string,
    reference: string,
  ) {
    this.#requireNode(session, nodeId);
    if (!/^[a-f0-9]{64}$/.test(reference)) {
      throw notFound("Workspace relocation blob");
    }
    const initial = this.#workspaceRelocationById(relocationId);
    if (
      !initial ||
      initial.destination_node_id !== nodeId ||
      initial.status !== "claimed"
    ) {
      throw notFound("Claimed workspace relocation blob");
    }
    const ownerSession = this.#workspaceRelocationOwnerSession(initial);
    const state = await this.getManagedWorkCaptureState(initial.thread_id);
    return this.database.transaction(() => {
      this.#requireNode(session, nodeId);
      const current = this.#workspaceRelocationById(relocationId);
      if (
        !current ||
        current.destination_node_id !== nodeId ||
        current.status !== "claimed"
      ) {
        throw notFound("Claimed workspace relocation blob");
      }
      this.#assertWorkspaceRelocationAuthority(ownerSession, current, state);
      const blob = this.database.all<{
        reference: string;
        size_bytes: number;
      }>(
        "SELECT reference, size_bytes FROM workspace_snapshot_blobs WHERE capture_id = ? AND reference = ?",
        [current.capture_id, reference],
      )[0];
      if (!blob) throw notFound("Workspace relocation blob");
      return {
        relocationId,
        captureId: current.capture_id,
        reference: blob.reference,
        size: blob.size_bytes,
      };
    });
  }

  /** Owner-only durable status lookup; a fenced result never means a checkpoint exists. */
  getCaptureControlStatus(session: FactorySession, requestId: string) {
    this.#requireOwner(session);
    const row = this.#captureControlByRequest(requestId);
    if (!row) throw notFound("Capture control request");
    if (row.actor_json !== encode(session.actor)) throw forbidden();
    return this.#captureControlStatus(row);
  }

  /** Authenticated node claim for capture controls; it never exposes effect jobs. */
  claimCaptureControl(
    session: FactorySession,
    request: unknown,
  ): ExecutionCaptureControl | null {
    const input = executionCaptureControlClaimRequestSchema.parse(request);
    this.#requireNode(session, input.nodeId);
    return this.database.transaction(() => {
      this.#requireNode(session, input.nodeId);
      const node = this.database.all<NodeRow>(
        "SELECT node_id, name, availability, last_seen_at FROM nodes WHERE node_id = ?",
        [input.nodeId],
      )[0];
      const runtime = this.database.all<ExecutionNodeStateRow>(
        "SELECT node_id, daemon_version, capabilities_json, registered_at, last_seen_at FROM execution_node_state WHERE node_id = ?",
        [input.nodeId],
      )[0];
      if (!node || !runtime || !this.#isNodeOnline(node)) return null;
      const inFlight = this.database.all<CaptureControlRow>(
        "SELECT * FROM capture_control_requests WHERE node_id = ? AND status = 'claimed' ORDER BY claimed_at, control_id LIMIT 1",
        [input.nodeId],
      )[0];
      const job =
        inFlight ??
        this.database.all<CaptureControlRow>(
          `SELECT * FROM capture_control_requests WHERE node_id = ? AND status = 'queued'
           ORDER BY accepted_at, control_id LIMIT 1`,
          [input.nodeId],
        )[0];
      if (!job) return null;
      const currentGeneration = this.#ownershipGeneration();
      if (
        job.ownership_generation !== currentGeneration ||
        !this.#hasActiveWorkspaceReport(
          job.node_id,
          job.workspace_id,
          job.ownership_generation,
        )
      ) {
        return null;
      }
      if (job.status === "queued") {
        this.database.exec(
          "UPDATE capture_control_requests SET status = 'claimed', claimed_at = ?, updated_at = ?, claim_count = claim_count + 1 WHERE control_id = ? AND status = 'queued'",
          [now(), now(), job.control_id],
        );
      } else {
        this.database.exec(
          "UPDATE capture_control_requests SET claim_count = claim_count + 1, updated_at = ? WHERE control_id = ? AND status = 'claimed'",
          [now(), job.control_id],
        );
      }
      return executionCaptureControlSchema.parse(JSON.parse(job.payload_json));
    });
  }

  /** Commits only a correlated node's durable-fence proof or explicit refusal. */
  async reportCaptureControl(
    session: FactorySession,
    nodeId: string,
    controlId: string,
    report: unknown,
  ) {
    const input = executionCaptureControlReportSchema.parse(report);
    this.#requireNode(session, nodeId);
    const row = this.#captureControlById(controlId);
    if (!row) throw notFound("Assigned capture control");
    const control = executionCaptureControlSchema.parse(
      JSON.parse(row.payload_json),
    );
    if (
      nodeId !== input.nodeId ||
      controlId !== input.controlId ||
      row.node_id !== nodeId ||
      row.request_id !== input.requestId ||
      row.capture_id !== input.captureId ||
      row.workspace_id !== input.target.workspaceId ||
      row.node_id !== input.target.nodeId ||
      row.ownership_generation !== input.ownershipGeneration ||
      control.payloadSha256 !== input.payloadSha256
    ) {
      throw conflict(
        "capture_control_assignment_mismatch",
        "Capture-control report does not match its persisted assignment",
      );
    }
    if (input.status === "source-capture-fenced") {
      const proof = input.sourceFence!;
      const proofBinding = {
        controlId: proof.controlId,
        captureId: proof.captureId,
        requestId: proof.requestId,
        nodeId: proof.nodeId,
        target: proof.target,
        ownershipGeneration: proof.ownershipGeneration,
        fencedAt: proof.fencedAt,
      };
      if (
        proof.controlId !== control.controlId ||
        proof.captureId !== control.captureId ||
        proof.requestId !== control.requestId ||
        proof.nodeId !== control.nodeId ||
        proof.target.workspaceId !== control.target.workspaceId ||
        proof.target.nodeId !== control.target.nodeId ||
        proof.ownershipGeneration !== control.ownershipGeneration ||
        proof.receiptSha256 !== (await sha256(stableJson(proofBinding)))
      ) {
        throw conflict(
          "capture_control_fence_proof_mismatch",
          "Source fence proof does not match the assigned durable control",
        );
      }
    }
    const reportHash = await sha256(stableJson(input));
    const reportJson = encode(input);
    this.database.transaction(() => {
      this.#requireNode(session, nodeId);
      const current = this.#captureControlById(controlId);
      if (!current) throw notFound("Assigned capture control");
      if (current.report_json !== null) {
        if (current.report_sha256 !== reportHash) {
          throw conflict(
            "capture_control_report_conflict",
            "A different capture-control report is already committed",
          );
        }
        return;
      }
      if (current.status !== "claimed") {
        throw conflict(
          "capture_control_not_claimed",
          "Capture control has no persisted node claim",
        );
      }
      this.database.exec(
        `UPDATE capture_control_requests SET status = ?, updated_at = ?, report_json = ?,
          report_sha256 = ?, error_code = ? WHERE control_id = ? AND status = 'claimed'`,
        [
          input.status,
          input.reportedAt,
          reportJson,
          reportHash,
          input.errorCode ?? null,
          controlId,
        ],
      );
    });
    return executionCaptureControlReportResponseSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      nodeId,
      controlId,
      captureId: input.captureId,
      accepted: true,
      status: input.status,
    });
  }

  /** Owner recovery view for capture locks that survived a host restart. */
  listManagedWorkCaptures(session: FactorySession) {
    this.#requireOwner(session);
    return this.database.all<{
      capture_id: string;
      thread_id: string;
      workspace_id: string;
      started_at: string;
    }>(
      "SELECT capture_id, thread_id, workspace_id, started_at FROM managed_work_captures ORDER BY started_at, capture_id",
    );
  }

  /** Release only the owner-authorized capture lock identified by its stable ID. */
  endManagedWorkCapture(session: FactorySession, captureId: string): void {
    const ownerId = this.#requireOwner(session);
    this.database.transaction(() => {
      const row = this.database.all<{ owner_id: string }>(
        "SELECT owner_id FROM managed_work_captures WHERE capture_id = ?",
        [captureId],
      )[0];
      if (!row) return;
      if (row.owner_id !== ownerId) throw forbidden();
      if (
        this.database.all(
          "SELECT control_id FROM capture_control_requests WHERE capture_id = ?",
          [captureId],
        ).length
      ) {
        throw conflict(
          "capture_control_fence_held",
          "Remote capture-control fences remain held for reconciliation",
        );
      }
      this.database.exec(
        "DELETE FROM managed_work_captures WHERE capture_id = ?",
        [captureId],
      );
    });
  }

  /**
   * Atomically admit one named runtime lifecycle while no source-capture lock exists.
   * An active permit is returned unchanged after retries or Core/DO restart; it has no timeout.
   */
  async acquireManagedWorkRuntimePermit(
    threadId: string,
  ): Promise<ManagedWorkRuntimeAdmission> {
    return this.database.transaction(() => {
      const thread = this.#captureThread(threadId);
      const captures = this.database.all<{ capture_id: string }>(
        "SELECT capture_id FROM managed_work_captures WHERE thread_id = ?",
        [threadId],
      );
      if (captures.length === 1) {
        return { state: "held", captureId: captures[0]!.capture_id };
      }
      if (captures.length > 1) return { state: "held" };

      const existing = this.database.all<{
        permit_id: string;
        ownership_generation: number;
        released_at: string | null;
      }>(
        "SELECT permit_id, ownership_generation, released_at FROM managed_work_runtime_permits WHERE thread_id = ?",
        [threadId],
      )[0];
      if (existing?.released_at === null) {
        if (existing.ownership_generation !== thread.ownership_generation) {
          return { state: "held" };
        }
        return {
          state: "permitted",
          permitId: existing.permit_id,
          ownershipGeneration: existing.ownership_generation,
        };
      }

      const permitId = makeId("managed-runtime-permit");
      this.database.exec(
        `INSERT INTO managed_work_runtime_permits(
          thread_id, permit_id, ownership_generation, acquired_at, released_at
        ) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(thread_id) DO UPDATE SET
          permit_id = excluded.permit_id,
          ownership_generation = excluded.ownership_generation,
          acquired_at = excluded.acquired_at,
          released_at = NULL`,
        [threadId, permitId, thread.ownership_generation, now()],
      );
      return {
        state: "permitted",
        permitId,
        ownershipGeneration: thread.ownership_generation,
      };
    });
  }

  /** Release only this exact runtime token after ManagedWork has closed its Harness. */
  releaseManagedWorkRuntimePermit(threadId: string, permitId: string): void {
    this.database.transaction(() => {
      this.#captureThread(threadId);
      this.database.exec(
        `UPDATE managed_work_runtime_permits SET released_at = ?
         WHERE thread_id = ? AND permit_id = ? AND released_at IS NULL`,
        [now(), threadId, permitId],
      );
    });
  }

  /** Trusted managed-work RPC state; any persisted lock remains blocking after restart. */
  async getManagedWorkCaptureState(
    threadId: string,
  ): Promise<ManagedWorkCaptureState> {
    const locks = this.database.all<{
      capture_id: string;
      workspace_id: string;
      owner_id: string;
    }>(
      "SELECT capture_id, workspace_id, owner_id FROM managed_work_captures WHERE thread_id = ?",
      [threadId],
    );
    if (locks.length === 0) return { state: "unlocked" };
    if (locks.length !== 1) return { state: "held" };
    const lock = locks[0]!;
    const activeRuntime = this.database.all<{ permit_id: string }>(
      "SELECT permit_id FROM managed_work_runtime_permits WHERE thread_id = ? AND released_at IS NULL LIMIT 1",
      [threadId],
    );
    if (activeRuntime.length) {
      return { state: "held", captureId: lock.capture_id };
    }
    const controls = this.database.all<CaptureControlRow>(
      "SELECT * FROM capture_control_requests WHERE capture_id = ?",
      [lock.capture_id],
    );
    if (controls.length !== 1) {
      return { state: "held", captureId: lock.capture_id };
    }
    const controlRow = controls[0]!;
    if (
      controlRow.status !== "source-capture-fenced" ||
      !controlRow.report_json ||
      !controlRow.report_sha256
    ) {
      return { state: "held", captureId: lock.capture_id };
    }

    const control = executionCaptureControlSchema.parse(
      JSON.parse(controlRow.payload_json),
    );
    const report = executionCaptureControlReportSchema.parse(
      JSON.parse(controlRow.report_json),
    );
    const controlBinding = {
      contractVersion: EXECUTION_CONTRACT_VERSION,
      controlId: controlRow.control_id,
      captureId: controlRow.capture_id,
      requestId: controlRow.request_id,
      nodeId: controlRow.node_id,
      target: {
        nodeId: controlRow.node_id,
        workspaceId: controlRow.workspace_id,
      },
      ownershipGeneration: controlRow.ownership_generation,
    };
    const sourceFence = report.sourceFence;
    if (!sourceFence) return { state: "held", captureId: lock.capture_id };
    const sourceFenceBinding = {
      controlId: sourceFence.controlId,
      captureId: sourceFence.captureId,
      requestId: sourceFence.requestId,
      nodeId: sourceFence.nodeId,
      target: sourceFence.target,
      ownershipGeneration: sourceFence.ownershipGeneration,
      fencedAt: sourceFence.fencedAt,
    };
    const [controlPayloadSha256, persistedReportSha256, sourceFenceSha256] =
      await Promise.all([
        sha256(stableJson(controlBinding)),
        sha256(stableJson(report)),
        sha256(stableJson(sourceFenceBinding)),
      ]);
    if (
      controlRow.thread_id !== threadId ||
      controlRow.capture_id !== lock.capture_id ||
      controlRow.workspace_id !== lock.workspace_id ||
      controlRow.actor_json !==
        encode({
          contractVersion: CONTRACT_VERSION,
          kind: "human",
          userId: lock.owner_id,
        }) ||
      control.controlId !== controlRow.control_id ||
      control.captureId !== controlRow.capture_id ||
      control.requestId !== controlRow.request_id ||
      control.nodeId !== controlRow.node_id ||
      control.target.nodeId !== controlRow.node_id ||
      control.target.workspaceId !== controlRow.workspace_id ||
      control.ownershipGeneration !== controlRow.ownership_generation ||
      control.payloadSha256 !== controlPayloadSha256 ||
      report.controlId !== control.controlId ||
      report.captureId !== control.captureId ||
      report.requestId !== control.requestId ||
      report.nodeId !== control.nodeId ||
      report.target.nodeId !== control.target.nodeId ||
      report.target.workspaceId !== control.target.workspaceId ||
      report.ownershipGeneration !== control.ownershipGeneration ||
      report.payloadSha256 !== control.payloadSha256 ||
      report.status !== "source-capture-fenced" ||
      sourceFence.controlId !== control.controlId ||
      sourceFence.captureId !== control.captureId ||
      sourceFence.requestId !== control.requestId ||
      sourceFence.nodeId !== control.nodeId ||
      sourceFence.target.nodeId !== control.target.nodeId ||
      sourceFence.target.workspaceId !== control.target.workspaceId ||
      sourceFence.ownershipGeneration !== control.ownershipGeneration ||
      sourceFence.receiptSha256 !== sourceFenceSha256 ||
      controlRow.report_sha256 !== persistedReportSha256
    ) {
      return { state: "held", captureId: lock.capture_id };
    }

    const thread = this.database.all<ThreadRow>(
      "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, owner_private, created_at FROM threads WHERE thread_id = ?",
      [threadId],
    )[0];
    const sharedWorkspace = this.database.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM threads WHERE workspace_id = ?",
      [lock.workspace_id],
    )[0]?.count;
    const unsettledInput = this.database.all<{ status: string }>(
      "SELECT status FROM dispatch_intents WHERE thread_id = ? AND status IN ('queued', 'unavailable', 'running', 'dispatched', 'uncertain') LIMIT 1",
      [threadId],
    )[0];
    const unsettledEffect = this.database.all<{ status: string }>(
      "SELECT status FROM execution_jobs WHERE workspace_id = ? AND status IN ('queued', 'claimed', 'uncertain') LIMIT 1",
      [lock.workspace_id],
    )[0];
    if (
      !thread ||
      thread.project_id !== controlRow.project_id ||
      thread.node_id !== controlRow.node_id ||
      thread.workspace_id !== controlRow.workspace_id ||
      thread.ownership_generation !== controlRow.ownership_generation ||
      this.#ownershipGeneration() !== controlRow.ownership_generation ||
      sharedWorkspace !== 1 ||
      unsettledInput ||
      unsettledEffect
    ) {
      return { state: "held", captureId: lock.capture_id };
    }

    const immutableSourceFence = Object.freeze({
      ...sourceFence,
      target: Object.freeze({ ...sourceFence.target }),
    });
    const binding: ManagedWorkCaptureBinding = Object.freeze({
      captureId: controlRow.capture_id,
      captureRequestId: controlRow.request_id,
      controlId: controlRow.control_id,
      threadId,
      projectId: controlRow.project_id,
      target: Object.freeze({
        nodeId: controlRow.node_id,
        workspaceId: controlRow.workspace_id,
      }),
      ownershipGeneration: controlRow.ownership_generation,
      sourceFence: immutableSourceFence,
      reportSha256: controlRow.report_sha256,
    });
    return Object.freeze({ state: "source-capture-fenced", binding });
  }

  /** Recovery/status seam: a persisted lock remains blocking after host restart. */
  isManagedWorkCapturing(threadId: string): boolean {
    return (
      this.database.all(
        "SELECT capture_id FROM managed_work_captures WHERE thread_id = ?",
        [threadId],
      ).length > 0
    );
  }

  /** Read-only command/effect receipt evidence for a validated active capture. */
  getManagedWorkCaptureProvenance(
    session: FactorySession,
    threadId: string,
    captureId: string,
  ) {
    this.#requireOwner(session);
    const capture = this.database.all<{
      capture_id: string;
      workspace_id: string;
    }>(
      "SELECT capture_id, workspace_id FROM managed_work_captures WHERE thread_id = ?",
      [threadId],
    )[0];
    if (!capture || capture.capture_id !== captureId) {
      throw conflict(
        "capture_lock_missing",
        "Managed-work provenance can be read only under its active capture lock",
      );
    }
    const rows = this.database.all<ReceiptRow>(
      "SELECT request_id, actor_json, thread_id, payload_hash, job_id, accepted_at FROM command_receipts WHERE thread_id = ? ORDER BY accepted_at, request_id",
      [threadId],
    );
    return {
      threadId,
      workspaceId: capture.workspace_id,
      commands: rows.map((row) => this.#receiptByJob(row.job_id)),
    };
  }

  /** In-process only: returns the persisted active input, never a body-selected placement. */
  getActiveManagedInput(threadId: string): FactoryQueueJob | undefined {
    const row = this.database.all<IntentRow>(
      "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE thread_id = ? AND status = 'running' ORDER BY created_at, job_id LIMIT 1",
      [threadId],
    )[0];
    return row
      ? factoryQueueJobSchema.parse(JSON.parse(row.payload_json))
      : undefined;
  }

  /** Called only by the managed-runtime host after reading Pi's durable submission receipt. */
  settleManagedInput(
    requestId: string,
    status: "completed" | "failed" | "uncertain",
    detail: string,
  ): FactoryCommandReceipt {
    if (!detail.trim() || detail.length > 4_000) {
      throw new FactoryError(400, "invalid_settlement_detail");
    }
    const row = this.database.all<IntentRow>(
      "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE request_id = ?",
      [requestId],
    )[0];
    if (!row) throw notFound("Managed input receipt");
    const eventType = `dispatch.${status}` as const;
    const timestamp = now();
    this.database.transaction(() => {
      const current = this.database.all<IntentRow>(
        "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE request_id = ?",
        [requestId],
      )[0];
      if (!current) throw notFound("Managed input receipt");
      if (current.status !== "running" && current.status !== "dispatched") {
        return;
      }
      this.database.exec(
        "UPDATE dispatch_intents SET status = ?, outcome = ?, updated_at = ? WHERE request_id = ?",
        [status, detail, timestamp, requestId],
      );
      this.#event(
        eventType,
        parseActor(current.actor_json),
        current.project_id,
        current.thread_id,
        requestId,
        {
          jobId: current.job_id,
          nodeId: current.node_id,
          workspaceId: current.workspace_id,
          ownershipGeneration: current.ownership_generation,
          detail,
        },
        timestamp,
      );
    });
    return this.#receiptByRequest(requestId);
  }

  events(session: FactorySession, after: number, limit = 100) {
    const policy = this.#policy(session);
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
    let offset = 0;
    let cursorBase = 0;
    if (!policy.isOwner) {
      const generation = policy.principal.accessGeneration;
      cursorBase = (generation + 1) * EVENT_CURSOR_RADIX;
      if (!Number.isSafeInteger(cursorBase + EVENT_CURSOR_RADIX)) {
        throw new FactoryError(503, "event_cursor_exhausted");
      }
      if (
        after > 0 &&
        Math.floor(after / EVENT_CURSOR_RADIX) === generation + 1
      ) {
        offset = after - cursorBase;
      }
    }
    const fullyVisible =
      policy.isOwner || policy.principal.factoryWide === true;
    let query: string;
    let parameters: (string | number)[];
    if (policy.isOwner) {
      query =
        "SELECT cursor, type, actor_json, project_id, thread_id, request_id, payload_json, created_at FROM factory_events WHERE cursor > ? ORDER BY cursor LIMIT ?";
      parameters = [after, limit];
    } else if (fullyVisible) {
      query =
        "SELECT cursor, type, actor_json, project_id, thread_id, request_id, payload_json, created_at FROM factory_events ORDER BY cursor LIMIT ? OFFSET ?";
      parameters = [limit, offset];
    } else if (session.actor.kind === "assistant") {
      query = `SELECT e.cursor, e.type, e.actor_json, e.project_id, e.thread_id, e.request_id, e.payload_json, e.created_at
         FROM factory_events e
         WHERE (
           (e.thread_id IS NULL AND e.project_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM assistant_credential_grants g WHERE g.credential_id = ? AND g.resource_type = 'project' AND g.resource_id = e.project_id
           )) OR EXISTS (
             SELECT 1 FROM threads t
             WHERE t.thread_id = e.thread_id AND t.owner_private = 0 AND EXISTS (
               SELECT 1 FROM assistant_credential_grants g WHERE g.credential_id = ? AND (
                 (g.resource_type = 'thread' AND g.resource_id = e.thread_id) OR
                 (g.resource_type = 'project' AND g.resource_id = t.project_id)
               )
             )
           )
         ) ORDER BY e.cursor LIMIT ? OFFSET ?`;
      parameters = [session.credentialId, session.credentialId, limit, offset];
    } else {
      query = `SELECT e.cursor, e.type, e.actor_json, e.project_id, e.thread_id, e.request_id, e.payload_json, e.created_at
         FROM factory_events e
         WHERE (
           (e.thread_id IS NULL AND e.project_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM access_grants g WHERE g.user_id = ? AND g.resource_type = 'project' AND g.resource_id = e.project_id
           )) OR EXISTS (
             SELECT 1 FROM threads t
             WHERE t.thread_id = e.thread_id AND t.owner_private = 0 AND EXISTS (
               SELECT 1 FROM access_grants g WHERE g.user_id = ? AND (
                 (g.resource_type = 'thread' AND g.resource_id = e.thread_id) OR
                 (g.resource_type = 'project' AND g.resource_id = t.project_id)
               )
             )
           )
         ) ORDER BY e.cursor LIMIT ? OFFSET ?`;
      parameters = [
        policy.principal.userId!,
        policy.principal.userId!,
        limit,
        offset,
      ];
    }
    const rows = this.database.all<EventRow>(query, parameters);
    const parsed = rows.map((row, index) =>
      factoryEventSchema.parse({
        contractVersion: CONTRACT_VERSION,
        cursor: policy.isOwner
          ? Number(row.cursor)
          : cursorBase + offset + index + 1,
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
      nextCursor:
        parsed.at(-1)?.cursor ?? (policy.isOwner ? after : cursorBase + offset),
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
      if (activeAssignment?.request_id) {
        const intent = this.database.all<IntentRow>(
          "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE request_id = ?",
          [activeAssignment.request_id],
        )[0];
        if (
          !intent ||
          !this.#storedActorCanSteer(
            parseActor(intent.actor_json),
            intent.thread_id,
          )
        ) {
          const timestamp = now();
          this.database.exec(
            "UPDATE execution_jobs SET status = 'uncertain', finished_at = ?, error_code = 'access_revoked_after_claim' WHERE job_id = ? AND status = 'claimed' AND report_json IS NULL",
            [timestamp, activeAssignment.job_id],
          );
          this.#event(
            "execution.uncertain",
            intent ? parseActor(intent.actor_json) : session.actor,
            intent?.project_id ?? null,
            intent?.thread_id ?? null,
            activeAssignment.request_id,
            {
              jobId: activeAssignment.job_id,
              nodeId,
              errorCode: "access_revoked_after_claim",
            },
            timestamp,
          );
          return null;
        }
      }
      if (
        activeAssignment &&
        this.#isWorkspaceCapturing(activeAssignment.workspace_id)
      ) {
        return null;
      }
      const job =
        activeAssignment ??
        this.database.all<ExecutionJobRow>(
          `SELECT jobs.* FROM execution_jobs AS jobs
           JOIN execution_node_workspaces AS workspaces
             ON workspaces.node_id = jobs.node_id AND workspaces.workspace_id = jobs.workspace_id
           WHERE jobs.node_id = ? AND jobs.status = 'queued'
             AND jobs.ownership_generation = ?
             AND NOT EXISTS (
               SELECT 1 FROM managed_work_captures AS captures
               WHERE captures.workspace_id = jobs.workspace_id
             )
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
      if (job.status === "queued" && job.request_id) {
        const intent = this.database.all<IntentRow>(
          "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE request_id = ?",
          [job.request_id],
        )[0];
        if (
          !intent ||
          !this.#storedActorCanSteer(
            parseActor(intent.actor_json),
            intent.thread_id,
          )
        ) {
          const timestamp = now();
          this.database.exec(
            "UPDATE execution_jobs SET status = 'failed', finished_at = ?, error_code = 'access_revoked' WHERE job_id = ? AND status = 'queued'",
            [timestamp, job.job_id],
          );
          this.#event(
            "execution.failed",
            intent ? parseActor(intent.actor_json) : session.actor,
            intent?.project_id ?? null,
            intent?.thread_id ?? null,
            job.request_id,
            { jobId: job.job_id, nodeId, errorCode: "access_revoked" },
            timestamp,
          );
          return null;
        }
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
    if (
      job.status !== "claimed" &&
      !(job.status === "uncertain" && job.report_json === null)
    ) {
      throw conflict(
        "job_not_claimed",
        "The execution job has no persisted claim or reconcilable uncertain assignment",
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
      if (
        current.status !== "claimed" &&
        !(current.status === "uncertain" && current.report_json === null)
      ) {
        throw conflict(
          "job_not_claimed",
          "The execution job has no persisted claim or reconcilable uncertain assignment",
        );
      }
      this.database.exec(
        `UPDATE execution_jobs SET status = ?, finished_at = ?, report_json = ?,
          report_sha256 = ?, error_code = ? WHERE job_id = ? AND status IN ('claimed', 'uncertain')`,
        [
          input.status,
          input.finishedAt,
          reportJson,
          reportHash,
          input.errorCode ?? null,
          jobId,
        ],
      );
      if (current.request_id) {
        const accepted = this.database.all<IntentRow>(
          "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE request_id = ?",
          [current.request_id],
        )[0];
        this.#event(
          `execution.${input.status}`,
          session.actor,
          accepted?.project_id ?? null,
          accepted?.thread_id ?? null,
          current.request_id,
          {
            jobId,
            nodeId,
            target: input.target,
            ownershipGeneration: input.ownershipGeneration,
            piTaskId: current.pi_task_id,
            piCallId: current.pi_call_id,
            errorCode: input.errorCode ?? null,
            reconciliationEvidence: input.reconciliationEvidence ?? null,
          },
          input.finishedAt,
        );
      }
    });
    if (input.status === "uncertain" && job.request_id) {
      this.settleManagedInput(
        job.request_id,
        "uncertain",
        `Remote effect ${jobId} is uncertain${input.errorCode ? ` (${input.errorCode})` : ""}`,
      );
    }
    return this.#executionReportAcknowledgement(nodeId, jobId, input.status);
  }

  /** Trusted bridge: placement and generation are read from the accepted, persisted input. */
  async enqueueManagedRemoteExecution(
    threadId: string,
    taskId: string,
    callId: string,
    operation: ManagedRemoteOperation,
  ): Promise<ExecutionReceipt> {
    if (
      !taskId.trim() ||
      taskId.length > 256 ||
      !callId.trim() ||
      callId.length > 256
    ) {
      throw new FactoryError(400, "invalid_pi_execution_evidence");
    }
    const prior = this.database.all<ExecutionJobRow>(
      `SELECT jobs.* FROM execution_jobs AS jobs
       JOIN dispatch_intents AS intents ON intents.request_id = jobs.request_id
       WHERE intents.thread_id = ? AND jobs.pi_task_id = ? AND jobs.pi_call_id = ?
       LIMIT 1`,
      [threadId, taskId, callId],
    )[0];
    if (prior) {
      const persisted = executionJobSchema.parse(
        JSON.parse(prior.payload_json),
      );
      const candidate = executionJobSchema.parse({
        ...persisted,
        ...operation,
      });
      if (stableJson(candidate) !== stableJson(persisted)) {
        throw conflict(
          "pi_execution_payload_conflict",
          "Pi replay changed arguments for a previously admitted remote effect",
        );
      }
      return this.#executionReceipt(prior);
    }
    const input = this.getActiveManagedInput(threadId);
    if (!input) {
      throw conflict(
        "managed_input_not_running",
        "Remote tools require an active persisted Factory input",
      );
    }
    const jobId = `job:pi-${await sha256(
      `${threadId}\u0000${input.requestId}\u0000${input.threadId}\u0000${taskId}\u0000${callId}`,
    )}`;
    const job = executionJobSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      jobId,
      nodeId: input.target.nodeId,
      target: input.target,
      ownershipGeneration: input.ownershipGeneration,
      ...operation,
    });
    return this.enqueueRemoteExecution(job, {
      requestId: input.requestId,
      taskId,
      callId,
    });
  }

  /** Trusted in-process admission seam; no HTTP job-injection route exists. */
  async enqueueRemoteExecution(
    input: unknown,
    evidence?: ManagedExecutionEvidence,
  ): Promise<ExecutionReceipt> {
    const job = executionJobSchema.parse(input);
    if (
      evidence &&
      (!evidence.requestId.trim() ||
        !evidence.taskId.trim() ||
        !evidence.callId.trim())
    ) {
      throw new FactoryError(400, "invalid_pi_execution_evidence");
    }
    const payloadJson = encode(job);
    const payloadHash = await sha256(stableJson(job));
    const existing = this.#executionJob(job.jobId);
    if (existing) {
      if (
        existing.payload_sha256 !== payloadHash ||
        (evidence &&
          (existing.request_id !== evidence.requestId ||
            existing.pi_task_id !== evidence.taskId ||
            existing.pi_call_id !== evidence.callId))
      ) {
        throw conflict(
          "job_id_payload_conflict",
          "Job ID is bound to another payload or Pi execution evidence",
        );
      }
      return this.#executionReceipt(existing);
    }
    this.#assertRemoteExecutionAdmission(job);
    const timestamp = now();
    this.database.transaction(() => {
      const raced = this.#executionJob(job.jobId);
      if (raced) {
        if (
          raced.payload_sha256 !== payloadHash ||
          (evidence &&
            (raced.request_id !== evidence.requestId ||
              raced.pi_task_id !== evidence.taskId ||
              raced.pi_call_id !== evidence.callId))
        ) {
          throw conflict(
            "job_id_payload_conflict",
            "Job ID is bound to another payload or Pi execution evidence",
          );
        }
        return;
      }
      this.#assertRemoteExecutionAdmission(job);
      this.database.exec(
        `INSERT INTO execution_jobs(job_id, node_id, workspace_id, ownership_generation,
          operation, payload_json, payload_sha256, request_id, pi_task_id, pi_call_id,
          status, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        [
          job.jobId,
          job.nodeId,
          job.target.workspaceId,
          job.ownershipGeneration,
          job.operation,
          payloadJson,
          payloadHash,
          evidence?.requestId ?? null,
          evidence?.taskId ?? null,
          evidence?.callId ?? null,
          timestamp,
        ],
      );
      if (evidence) {
        const accepted = this.database.all<IntentRow>(
          "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE request_id = ?",
          [evidence.requestId],
        )[0];
        if (!accepted || accepted.status !== "running") {
          throw conflict(
            "managed_input_not_running",
            "The Pi tool evidence is no longer attached to active work",
          );
        }
        if (
          !this.#storedActorCanSteer(
            parseActor(accepted.actor_json),
            accepted.thread_id,
          )
        ) {
          throw forbidden();
        }
        this.#event(
          "execution.accepted",
          parseActor(accepted.actor_json),
          accepted.project_id,
          accepted.thread_id,
          evidence.requestId,
          {
            jobId: job.jobId,
            target: job.target,
            ownershipGeneration: job.ownershipGeneration,
            operation: job.operation,
            piTaskId: evidence.taskId,
            piCallId: evidence.callId,
          },
          timestamp,
        );
      }
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

  /** Fences expired effects from new claims while allowing one late report to reconcile an assigned job. */
  markManagedEffectUncertain(jobId: string, detail: string): void {
    if (!detail.trim() || detail.length > 4_000) {
      throw new FactoryError(400, "invalid_settlement_detail");
    }
    const row = this.#executionJob(jobId);
    if (!row || !row.request_id) throw notFound("Managed execution effect");
    this.database.transaction(() => {
      const current = this.#executionJob(jobId);
      if (!current || !current.request_id)
        throw notFound("Managed execution effect");
      if (current.status !== "queued" && current.status !== "claimed") return;
      const timestamp = now();
      const status = current.status === "queued" ? "failed" : "uncertain";
      const errorCode =
        current.status === "queued"
          ? "managed_effect_abandoned_before_claim"
          : "managed_tool_wait_expired";
      this.database.exec(
        "UPDATE execution_jobs SET status = ?, finished_at = ?, error_code = ? WHERE job_id = ? AND status = ?",
        [status, timestamp, errorCode, jobId, current.status],
      );
      const accepted = this.database.all<IntentRow>(
        "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE request_id = ?",
        [current.request_id],
      )[0];
      if (accepted) {
        this.#event(
          `execution.${status}`,
          parseActor(accepted.actor_json),
          accepted.project_id,
          accepted.thread_id,
          current.request_id,
          {
            jobId,
            nodeId: current.node_id,
            target: {
              nodeId: current.node_id,
              workspaceId: current.workspace_id,
            },
            ownershipGeneration: current.ownership_generation,
            piTaskId: current.pi_task_id,
            piCallId: current.pi_call_id,
            errorCode,
            detail,
          },
          timestamp,
        );
      }
    });
    this.settleManagedInput(row.request_id, "uncertain", detail);
  }

  /** Requeues unavailable accepted inputs only after their explicitly assigned node is live. */
  requeueAvailableManagedInputs(): number {
    if (
      this.database.all(
        "SELECT singleton FROM factory_meta WHERE singleton = 1",
      ).length === 0
    ) {
      return 0;
    }
    return this.database.transaction(() => {
      const generation = this.#ownershipGeneration();
      const rows = this.database.all<
        IntentRow & {
          node_name: string;
          node_availability: string;
          node_last_seen_at: string | null;
        }
      >(
        `SELECT intents.job_id, intents.request_id, intents.actor_json, intents.project_id,
           intents.thread_id, intents.node_id, intents.workspace_id,
           intents.ownership_generation, intents.payload_json, intents.payload_hash,
           intents.status, intents.outcome, intents.created_at, intents.updated_at,
           nodes.name AS node_name, nodes.availability AS node_availability,
           nodes.last_seen_at AS node_last_seen_at
         FROM dispatch_intents AS intents
         JOIN nodes ON nodes.node_id = intents.node_id
         WHERE intents.status = 'unavailable' AND intents.ownership_generation = ?
           AND NOT EXISTS (
             SELECT 1 FROM managed_work_captures AS captures
             WHERE captures.thread_id = intents.thread_id
           )`,
        [generation],
      );
      let requeued = 0;
      for (const row of rows) {
        if (
          !this.#isNodeOnline({
            node_id: row.node_id,
            name: row.node_name,
            availability: row.node_availability,
            last_seen_at: row.node_last_seen_at,
          })
        ) {
          continue;
        }
        this.database.exec(
          "UPDATE dispatch_intents SET status = 'queued', outcome = NULL, updated_at = ? WHERE job_id = ? AND status = 'unavailable'",
          [now(), row.job_id],
        );
        requeued += 1;
      }
      return requeued;
    });
  }

  /** Records terminal evidence if the standalone managed-input drain itself fails. */
  failManagedDispatchDrain(detail: string): void {
    if (!detail.trim() || detail.length > 4_000) {
      throw new FactoryError(400, "invalid_settlement_detail");
    }
    const timestamp = now();
    this.database.transaction(() => {
      const rows = this.database.all<IntentRow>(
        "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE status IN ('queued', 'running')",
      );
      for (const row of rows) {
        const status = row.status === "running" ? "uncertain" : "failed";
        this.database.exec(
          "UPDATE dispatch_intents SET status = ?, outcome = ?, updated_at = ? WHERE job_id = ? AND status = ?",
          [status, detail, timestamp, row.job_id, row.status],
        );
        this.#event(
          `dispatch.${status}`,
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

  /** Dispatches one durable intent through the injected managed-runtime boundary. */
  async dispatchNext(
    adapter: RuntimeDispatchAdapter,
  ): Promise<FactoryCommandReceipt | null> {
    const intent = this.database.transaction(() => {
      if (
        this.database.all(
          "SELECT job_id FROM dispatch_intents WHERE status = 'running' LIMIT 1",
        ).length
      ) {
        return null;
      }
      const queued = this.database.all<IntentRow>(
        "SELECT job_id, request_id, actor_json, project_id, thread_id, node_id, workspace_id, ownership_generation, payload_json, payload_hash, status, outcome, created_at, updated_at FROM dispatch_intents WHERE status = 'queued' AND NOT EXISTS (SELECT 1 FROM managed_work_captures AS captures WHERE captures.thread_id = dispatch_intents.thread_id) ORDER BY created_at, job_id LIMIT 1",
      )[0];
      if (!queued) return null;
      if (
        !this.#storedActorCanSteer(
          parseActor(queued.actor_json),
          queued.thread_id,
        )
      ) {
        const timestamp = now();
        const detail =
          "The actor no longer has permission to steer this thread";
        this.database.exec(
          "UPDATE dispatch_intents SET status = 'failed', outcome = ?, updated_at = ? WHERE job_id = ? AND status = 'queued'",
          [detail, timestamp, queued.job_id],
        );
        this.#event(
          "dispatch.failed",
          parseActor(queued.actor_json),
          queued.project_id,
          queued.thread_id,
          queued.request_id,
          { jobId: queued.job_id, detail },
          timestamp,
        );
        queued.status = "failed";
        queued.outcome = detail;
        return queued;
      }
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
    if (intent.status === "failed") return this.#receiptByJob(intent.job_id);

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
        : outcome.status === "completed"
          ? "dispatch.completed"
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
    this.#assertWorkspaceNotCapturing(job.target.workspaceId);
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

  #captureThread(threadId: string): ThreadRow {
    const row = this.database.all<ThreadRow>(
      "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, owner_private, created_at FROM threads WHERE thread_id = ?",
      [threadId],
    )[0];
    if (!row) throw notFound("Thread");
    return row;
  }

  #assertManagedCaptureAdmission(threadId: string, row: ThreadRow): void {
    this.#assertWorkspaceNotReservedForRelocation(row.workspace_id);
    const shared = this.database.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM threads WHERE workspace_id = ?",
      [row.workspace_id],
    )[0]?.count;
    if (shared !== 1) {
      throw conflict(
        "capture_workspace_shared",
        "Managed-work capture requires an exclusive workspace; this workspace is assigned to multiple threads",
      );
    }
    const activeRuntime = this.database.all<{ permit_id: string }>(
      "SELECT permit_id FROM managed_work_runtime_permits WHERE thread_id = ? AND released_at IS NULL LIMIT 1",
      [threadId],
    );
    if (activeRuntime.length) {
      throw conflict(
        "managed_work_runtime_active",
        "Managed-work capture cannot begin while runtime lifecycle permission is active",
      );
    }
    const activeInputs = this.database.all<{ status: string }>(
      "SELECT status FROM dispatch_intents WHERE thread_id = ? AND status IN ('queued', 'unavailable', 'running', 'dispatched', 'uncertain') LIMIT 1",
      [threadId],
    );
    if (activeInputs.length) {
      throw conflict(
        "capture_work_not_quiescent",
        `Managed work has an unsettled ${activeInputs[0]!.status} input receipt; reconcile or settle it before capture`,
      );
    }
    const activeEffects = this.database.all<{ status: string }>(
      "SELECT status FROM execution_jobs WHERE workspace_id = ? AND status IN ('queued', 'claimed', 'uncertain') LIMIT 1",
      [row.workspace_id],
    );
    if (activeEffects.length) {
      throw conflict(
        "capture_workspace_not_quiescent",
        `Workspace has a ${activeEffects[0]!.status} execution effect; reconcile or settle it before capture`,
      );
    }
    const existing = this.database.all<{ capture_id: string }>(
      "SELECT capture_id FROM managed_work_captures WHERE thread_id = ? OR workspace_id = ?",
      [threadId, row.workspace_id],
    )[0];
    if (existing) {
      throw conflict(
        "capture_already_active",
        "A managed-work capture is already active for this work or workspace",
      );
    }
  }

  #workspaceRelocationOwnerSession(
    row: WorkspaceRelocationRow,
  ): FactorySession {
    const checkpoint = this.#managedWorkCheckpointByRequest(
      row.checkpoint_request_id,
    );
    if (!checkpoint || checkpoint.actor_json !== row.actor_json) {
      throw conflict("workspace_relocation_checkpoint_unavailable");
    }
    return this.#managedWorkCheckpointOwnerSession(checkpoint);
  }

  #assertWorkspaceRelocationAuthority(
    session: FactorySession,
    row: WorkspaceRelocationRow,
    state: ManagedWorkCaptureState,
  ): void {
    this.#requireOwner(session);
    const checkpoint = this.#managedWorkCheckpointByRequest(
      row.checkpoint_request_id,
    );
    const snapshot = this.#workspaceSnapshotByRequest(
      row.workspace_snapshot_request_id,
    );
    if (
      session.actor.kind !== "human" ||
      row.actor_json !== encode(session.actor) ||
      !checkpoint ||
      checkpoint.actor_json !== row.actor_json ||
      checkpoint.request_id !== row.checkpoint_request_id ||
      checkpoint.capture_request_id !== row.capture_request_id ||
      checkpoint.workspace_snapshot_request_id !==
        row.workspace_snapshot_request_id ||
      checkpoint.capture_id !== row.capture_id ||
      checkpoint.project_id !== row.project_id ||
      checkpoint.thread_id !== row.thread_id ||
      checkpoint.node_id !== row.source_node_id ||
      checkpoint.workspace_id !== row.source_workspace_id ||
      checkpoint.ownership_generation !== row.ownership_generation ||
      checkpoint.status !== "available" ||
      checkpoint.stage !== "available" ||
      !checkpoint.manifest_reference ||
      !snapshot ||
      snapshot.request_id !== row.workspace_snapshot_request_id ||
      snapshot.snapshot_id !== row.snapshot_id ||
      snapshot.capture_request_id !== row.capture_request_id ||
      snapshot.capture_id !== row.capture_id ||
      snapshot.actor_json !== row.actor_json ||
      snapshot.project_id !== row.project_id ||
      snapshot.thread_id !== row.thread_id ||
      snapshot.node_id !== row.source_node_id ||
      snapshot.workspace_id !== row.source_workspace_id ||
      snapshot.ownership_generation !== row.ownership_generation ||
      snapshot.status !== "workspace-checkpoint-available" ||
      snapshot.manifest_reference !== row.manifest_reference
    ) {
      throw conflict(
        "workspace_relocation_checkpoint_unavailable",
        "The exact published coherent checkpoint and verified source snapshot are required",
      );
    }
    this.#assertManagedWorkCheckpointAuthority(session, checkpoint, state);
    this.#assertWorkspaceRelocationDestination(
      {
        sourceNodeId: row.source_node_id,
        sourceWorkspaceId: row.source_workspace_id,
        destinationNodeId: row.destination_node_id,
        destinationWorkspaceId: row.destination_workspace_id,
      },
      row.relocation_id,
    );
  }

  #assertWorkspaceRelocationDestination(
    binding: {
      sourceNodeId: string;
      sourceWorkspaceId: string;
      destinationNodeId: string;
      destinationWorkspaceId: string;
    },
    existingRelocationId?: string,
  ): void {
    if (
      binding.destinationNodeId === binding.sourceNodeId ||
      binding.destinationWorkspaceId === binding.sourceWorkspaceId
    ) {
      throw conflict(
        "workspace_relocation_destination_not_distinct",
        "Destination node and workspace must differ from the held source",
      );
    }
    const destination = this.database.all<WorkspaceRow>(
      "SELECT workspace_id, node_id, name FROM workspaces WHERE workspace_id = ?",
      [binding.destinationWorkspaceId],
    )[0];
    const node = this.database.all<{ node_id: string }>(
      "SELECT node_id FROM nodes WHERE node_id = ?",
      [binding.destinationNodeId],
    )[0];
    if (
      !node ||
      !destination ||
      destination.node_id !== binding.destinationNodeId
    ) {
      throw conflict(
        "workspace_relocation_destination_not_provisioned",
        "Destination must be an owner-provisioned node and its assigned workspace",
      );
    }
    const capture = this.database.all<{ capture_id: string }>(
      "SELECT capture_id FROM managed_work_captures WHERE workspace_id = ? LIMIT 1",
      [binding.destinationWorkspaceId],
    )[0];
    if (capture) {
      throw conflict(
        "workspace_relocation_destination_busy",
        "Destination workspace already has an active capture reservation",
      );
    }
    const runtime = this.database.all<{ permit_id: string }>(
      `SELECT p.permit_id FROM managed_work_runtime_permits p
       JOIN threads t ON t.thread_id = p.thread_id
       WHERE t.workspace_id = ? AND p.released_at IS NULL LIMIT 1`,
      [binding.destinationWorkspaceId],
    )[0];
    const input = this.database.all<{ status: string }>(
      `SELECT d.status FROM dispatch_intents d JOIN threads t ON t.thread_id = d.thread_id
       WHERE t.workspace_id = ? AND d.status IN ('queued', 'unavailable', 'running', 'dispatched', 'uncertain') LIMIT 1`,
      [binding.destinationWorkspaceId],
    )[0];
    const effect = this.database.all<{ status: string }>(
      "SELECT status FROM execution_jobs WHERE workspace_id = ? AND status IN ('queued', 'claimed', 'uncertain') LIMIT 1",
      [binding.destinationWorkspaceId],
    )[0];
    if (runtime || input || effect) {
      throw conflict(
        "workspace_relocation_destination_busy",
        "Destination workspace has active runtime, input, or effect work",
      );
    }
    const assigned = this.database.all<{ thread_id: string }>(
      "SELECT thread_id FROM threads WHERE workspace_id = ? LIMIT 1",
      [binding.destinationWorkspaceId],
    )[0];
    if (assigned) {
      throw conflict(
        "workspace_relocation_destination_busy",
        "Destination workspace is already assigned to a thread",
      );
    }
    const reservation = existingRelocationId
      ? this.database.all<{ relocation_id: string }>(
          "SELECT relocation_id FROM workspace_relocations WHERE destination_node_id = ? AND destination_workspace_id = ? AND relocation_id <> ? LIMIT 1",
          [
            binding.destinationNodeId,
            binding.destinationWorkspaceId,
            existingRelocationId,
          ],
        )[0]
      : this.database.all<{ relocation_id: string }>(
          "SELECT relocation_id FROM workspace_relocations WHERE destination_node_id = ? AND destination_workspace_id = ? LIMIT 1",
          [binding.destinationNodeId, binding.destinationWorkspaceId],
        )[0];
    if (reservation) {
      throw conflict(
        "workspace_relocation_destination_reserved",
        "Destination workspace is reserved by another relocation",
      );
    }
  }

  #managedWorkCheckpointOwnerSession(
    row: ManagedWorkCheckpointRow,
  ): FactorySession {
    const actor = parseActor(row.actor_json);
    if (actor.kind !== "human") {
      throw new FactoryError(
        403,
        "forbidden",
        "Managed-work checkpoint assembly requires its owner actor",
      );
    }
    const credential = this.database.all<{ credential_id: string }>(
      "SELECT credential_id FROM credentials WHERE actor_json = ? AND revoked_at IS NULL ORDER BY created_at LIMIT 1",
      [row.actor_json],
    )[0];
    if (!credential) throw forbidden();
    return { credentialId: credential.credential_id, actor };
  }

  #boundedManagedWorkCheckpointCommands(
    threadId: string,
    binding: ManagedWorkCheckpointBindingRow,
  ): { commands: FactoryProvenanceCommand[]; serializedBytes: number } {
    const maxRecords = 100_000;
    const maxEvidenceBytes = 32 * 1024 * 1024;
    const totals = this.database.all<{
      command_receipt_count: number;
      command_count: number;
      command_bytes: number | null;
      command_unsettled: number;
      command_binding_mismatches: number;
      effect_count: number;
      effect_bytes: number | null;
      effect_unsettled: number;
      effect_unsupported_error_codes: number;
      effect_completed_with_error_code: number;
      effect_separators: number | null;
    }>(
      `WITH command_projection AS (
         SELECT cr.request_id, cr.job_id, cr.thread_id, cr.payload_hash,
           cr.accepted_at, di.project_id, di.node_id, di.workspace_id,
           di.ownership_generation, di.payload_hash AS dispatch_payload_hash,
           di.status AS dispatch_status, di.updated_at AS settled_at,
           json_object(
             'contractVersion', ${CONTRACT_VERSION},
             'requestId', cr.request_id,
             'jobId', cr.job_id,
             'threadId', cr.thread_id,
             'target', json_object('nodeId', di.node_id, 'workspaceId', di.workspace_id),
             'ownershipGeneration', di.ownership_generation,
             'payloadSha256', cr.payload_hash,
             'dispatchStatus', di.status,
             'acceptedAt', cr.accepted_at,
             'settledAt', di.updated_at,
             'executionEffects', json('[]')
           ) AS projected_json
         FROM command_receipts cr
         JOIN dispatch_intents di ON di.request_id = cr.request_id
         WHERE cr.thread_id = ?
       ), effect_projection AS (
         SELECT ej.request_id, ej.job_id, ej.node_id, ej.workspace_id,
           ej.ownership_generation, ej.operation, ej.payload_sha256, ej.status,
           ej.accepted_at, ej.finished_at, ej.error_code,
           json_object(
             'contractVersion', ${CONTRACT_VERSION},
             'jobId', ej.job_id,
             'nodeId', ej.node_id,
             'target', json_object('nodeId', ej.node_id, 'workspaceId', ej.workspace_id),
             'ownershipGeneration', ej.ownership_generation,
             'operation', ej.operation,
             'payloadSha256', ej.payload_sha256,
             'status', ej.status,
             'acceptedAt', ej.accepted_at,
             'finishedAt', ej.finished_at,
             'errorCode', ej.error_code
           ) AS projected_json
         FROM execution_jobs ej
         JOIN command_receipts cr ON cr.request_id = ej.request_id
         WHERE cr.thread_id = ?
       ), effect_groups AS (
         SELECT request_id, COUNT(*) AS effect_count
         FROM effect_projection GROUP BY request_id
       )
       SELECT
         (SELECT COUNT(*) FROM command_receipts WHERE thread_id = ?)
           AS command_receipt_count,
         (SELECT COUNT(*) FROM command_projection) AS command_count,
         (SELECT COALESCE(SUM(length(CAST(projected_json AS BLOB))), 0)
          FROM command_projection) AS command_bytes,
         (SELECT COALESCE(SUM(CASE WHEN dispatch_status NOT IN ('completed', 'failed')
              THEN 1 ELSE 0 END), 0) FROM command_projection) AS command_unsettled,
         (SELECT COALESCE(SUM(CASE WHEN payload_hash <> dispatch_payload_hash
              OR project_id <> ? OR thread_id <> ? OR node_id <> ? OR workspace_id <> ?
              OR ownership_generation <> ? THEN 1 ELSE 0 END), 0)
          FROM command_projection) AS command_binding_mismatches,
         (SELECT COUNT(*) FROM effect_projection) AS effect_count,
         (SELECT COALESCE(SUM(length(CAST(projected_json AS BLOB))), 0)
          FROM effect_projection) AS effect_bytes,
         (SELECT COALESCE(SUM(CASE WHEN status NOT IN ('completed', 'failed')
              OR finished_at IS NULL THEN 1 ELSE 0 END), 0)
          FROM effect_projection) AS effect_unsettled,
         (SELECT COALESCE(SUM(CASE WHEN error_code IS NOT NULL
              AND error_code NOT IN (${FACTORY_PROVENANCE_EXECUTION_ERROR_CODES.map(() => "?").join(", ")})
              THEN 1 ELSE 0 END), 0)
          FROM effect_projection) AS effect_unsupported_error_codes,
         (SELECT COALESCE(SUM(CASE WHEN status = 'completed'
              AND error_code IS NOT NULL THEN 1 ELSE 0 END), 0)
          FROM effect_projection) AS effect_completed_with_error_code,
         (SELECT COALESCE(SUM(CASE WHEN effect_count > 1
              THEN effect_count - 1 ELSE 0 END), 0) FROM effect_groups)
           AS effect_separators`,
      [
        threadId,
        threadId,
        threadId,
        binding.project_id,
        binding.thread_id,
        binding.node_id,
        binding.workspace_id,
        binding.ownership_generation,
        ...FACTORY_PROVENANCE_EXECUTION_ERROR_CODES,
      ],
    )[0];
    const commandCount = Number(totals?.command_count ?? -1);
    const effectCount = Number(totals?.effect_count ?? -1);
    const projectedBytes =
      Number(totals?.command_bytes ?? Number.NaN) +
      Number(totals?.effect_bytes ?? Number.NaN) +
      Number(totals?.effect_separators ?? Number.NaN) +
      Math.max(0, commandCount - 1) +
      16_384;
    if (
      !totals ||
      !Number.isSafeInteger(commandCount) ||
      !Number.isSafeInteger(effectCount) ||
      Number(totals.command_receipt_count) !== commandCount ||
      commandCount > maxRecords ||
      effectCount > maxRecords ||
      totals.command_unsettled !== 0 ||
      totals.command_binding_mismatches !== 0 ||
      totals.effect_unsettled !== 0 ||
      !Number.isSafeInteger(projectedBytes) ||
      projectedBytes > maxEvidenceBytes
    ) {
      throw checkpointConflict("managed_work_checkpoint_evidence_limit");
    }
    if (
      totals.effect_unsupported_error_codes !== 0 ||
      totals.effect_completed_with_error_code !== 0
    ) {
      throw checkpointConflict(
        "managed_work_checkpoint_unsupported_effect_error_code",
      );
    }

    const commandRows = this.database.all<{
      request_id: string;
      job_id: string;
      thread_id: string;
      project_id: string;
      node_id: string;
      workspace_id: string;
      ownership_generation: number;
      payload_hash: string;
      dispatch_payload_hash: string;
      dispatch_status: string;
      accepted_at: string;
      settled_at: string;
    }>(
      `SELECT cr.request_id, cr.job_id, cr.thread_id, di.project_id, di.node_id,
         di.workspace_id, di.ownership_generation, cr.payload_hash,
         di.payload_hash AS dispatch_payload_hash, di.status AS dispatch_status,
         cr.accepted_at, di.updated_at AS settled_at
       FROM command_receipts cr
       JOIN dispatch_intents di ON di.request_id = cr.request_id
       WHERE cr.thread_id = ? ORDER BY cr.accepted_at, cr.request_id LIMIT ?`,
      [threadId, maxRecords + 1],
    );
    const effectRows = this.database.all<{
      request_id: string | null;
      job_id: string;
      node_id: string;
      workspace_id: string;
      ownership_generation: number;
      operation: string;
      payload_sha256: string;
      status: string;
      accepted_at: string;
      finished_at: string | null;
      error_code: string | null;
    }>(
      `SELECT ej.request_id, ej.job_id, ej.node_id, ej.workspace_id,
         ej.ownership_generation, ej.operation, ej.payload_sha256, ej.status,
         ej.accepted_at, ej.finished_at, ej.error_code
       FROM execution_jobs ej
       JOIN command_receipts cr ON cr.request_id = ej.request_id
       WHERE cr.thread_id = ? ORDER BY ej.accepted_at, ej.job_id LIMIT ?`,
      [threadId, maxRecords + 1],
    );
    if (
      commandRows.length !== commandCount ||
      effectRows.length !== effectCount
    ) {
      throw checkpointConflict("managed_work_checkpoint_evidence_limit");
    }

    const effectsByRequest = new Map<
      string,
      FactoryProvenanceExecutionEffect[]
    >();
    for (const row of effectRows) {
      if (
        !row.request_id ||
        (row.status !== "completed" && row.status !== "failed") ||
        !row.finished_at ||
        row.node_id !== binding.node_id ||
        row.workspace_id !== binding.workspace_id ||
        row.ownership_generation !== binding.ownership_generation
      ) {
        throw checkpointConflict("managed_work_checkpoint_unsettled_effect");
      }
      const effect = factoryProvenanceExecutionEffectSchema.parse({
        contractVersion: CONTRACT_VERSION,
        jobId: row.job_id,
        nodeId: row.node_id,
        target: { nodeId: row.node_id, workspaceId: row.workspace_id },
        ownershipGeneration: row.ownership_generation,
        operation: row.operation,
        payloadSha256: row.payload_sha256,
        status: row.status,
        acceptedAt: row.accepted_at,
        finishedAt: row.finished_at,
        errorCode: row.error_code,
      });
      const list = effectsByRequest.get(row.request_id) ?? [];
      list.push(effect);
      effectsByRequest.set(row.request_id, list);
    }

    const commands: FactoryProvenanceCommand[] = [];
    const encoder = new TextEncoder();
    let serializedBytes = 2;
    for (const row of commandRows) {
      if (
        row.thread_id !== binding.thread_id ||
        row.project_id !== binding.project_id ||
        row.node_id !== binding.node_id ||
        row.workspace_id !== binding.workspace_id ||
        row.ownership_generation !== binding.ownership_generation ||
        row.payload_hash !== row.dispatch_payload_hash ||
        (row.dispatch_status !== "completed" &&
          row.dispatch_status !== "failed")
      ) {
        throw checkpointConflict("managed_work_checkpoint_unsettled_command");
      }
      const command = factoryProvenanceCommandSchema.parse({
        contractVersion: CONTRACT_VERSION,
        requestId: row.request_id,
        jobId: row.job_id,
        threadId: row.thread_id,
        target: { nodeId: row.node_id, workspaceId: row.workspace_id },
        ownershipGeneration: row.ownership_generation,
        payloadSha256: row.payload_hash,
        dispatchStatus: row.dispatch_status,
        acceptedAt: row.accepted_at,
        settledAt: row.settled_at,
        executionEffects: effectsByRequest.get(row.request_id) ?? [],
      });
      const commandBytes = encoder.encode(JSON.stringify(command)).byteLength;
      serializedBytes += commandBytes + (commands.length === 0 ? 0 : 1);
      if (serializedBytes + 16_384 > maxEvidenceBytes) {
        throw checkpointConflict("managed_work_checkpoint_evidence_limit");
      }
      commands.push(command);
    }
    return { commands, serializedBytes };
  }

  #managedWorkCheckpointByRequest(
    requestId: string,
  ): ManagedWorkCheckpointRow | undefined {
    return this.database.all<ManagedWorkCheckpointRow>(
      "SELECT * FROM managed_work_checkpoint_requests WHERE request_id = ?",
      [requestId],
    )[0];
  }

  #workspaceRelocationByRequest(
    requestId: string,
  ): WorkspaceRelocationRow | undefined {
    return this.database.all<WorkspaceRelocationRow>(
      "SELECT * FROM workspace_relocations WHERE request_id = ?",
      [requestId],
    )[0];
  }

  #workspaceRelocationById(
    relocationId: string,
  ): WorkspaceRelocationRow | undefined {
    return this.database.all<WorkspaceRelocationRow>(
      "SELECT * FROM workspace_relocations WHERE relocation_id = ?",
      [relocationId],
    )[0];
  }

  #workspaceRelocationAssignment(
    row: WorkspaceRelocationRow,
  ): WorkspaceRelocationClaim {
    return workspaceRelocationClaimSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      relocationId: row.relocation_id,
      requestId: row.request_id,
      checkpointRequestId: row.checkpoint_request_id,
      captureRequestId: row.capture_request_id,
      captureId: row.capture_id,
      workspaceSnapshotRequestId: row.workspace_snapshot_request_id,
      snapshotId: row.snapshot_id,
      threadId: row.thread_id,
      source: {
        nodeId: row.source_node_id,
        workspaceId: row.source_workspace_id,
      },
      destination: {
        nodeId: row.destination_node_id,
        workspaceId: row.destination_workspace_id,
      },
      ownershipGeneration: row.ownership_generation,
      manifestReference: row.manifest_reference,
    });
  }

  #workspaceRelocationStatus(row: WorkspaceRelocationRow) {
    return workspaceRelocationStatusSchema.parse({
      ...this.#workspaceRelocationAssignment(row),
      contractVersion: CONTRACT_VERSION,
      status: row.status,
      acceptedAt: row.accepted_at,
      updatedAt: row.updated_at,
      ...(row.receipt_sha256 ? { receiptSha256: row.receipt_sha256 } : {}),
      ...(row.previous_receipt_sha256
        ? { previousReceiptSha256: row.previous_receipt_sha256 }
        : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    });
  }

  #assertWorkspaceRelocationReportBinding(
    row: WorkspaceRelocationRow,
    nodeId: string,
    relocationId: string,
    report: WorkspaceRelocationReport,
  ): void {
    if (
      row.relocation_id !== relocationId ||
      row.destination_node_id !== nodeId ||
      report.relocationId !== row.relocation_id ||
      report.requestId !== row.request_id ||
      report.checkpointRequestId !== row.checkpoint_request_id ||
      report.captureRequestId !== row.capture_request_id ||
      report.captureId !== row.capture_id ||
      report.workspaceSnapshotRequestId !== row.workspace_snapshot_request_id ||
      report.snapshotId !== row.snapshot_id ||
      report.threadId !== row.thread_id ||
      report.source.nodeId !== row.source_node_id ||
      report.source.workspaceId !== row.source_workspace_id ||
      report.destination.nodeId !== row.destination_node_id ||
      report.destination.workspaceId !== row.destination_workspace_id ||
      report.ownershipGeneration !== row.ownership_generation ||
      report.manifestReference !== row.manifest_reference
    ) {
      throw conflict(
        "workspace_relocation_assignment_mismatch",
        "Destination report does not match its immutable relocation assignment",
      );
    }
  }

  #managedWorkCheckpointStatus(row: ManagedWorkCheckpointRow) {
    return managedWorkCheckpointStatusSchema.parse({
      contractVersion: CONTRACT_VERSION,
      requestId: row.request_id,
      captureRequestId: row.capture_request_id,
      workspaceSnapshotRequestId: row.workspace_snapshot_request_id,
      captureId: row.capture_id,
      threadId: row.thread_id,
      target: { nodeId: row.node_id, workspaceId: row.workspace_id },
      ownershipGeneration: row.ownership_generation,
      status: row.status,
      stage: row.stage,
      acceptedAt: row.accepted_at,
      updatedAt: row.updated_at,
      ...(row.status === "available" && row.manifest_reference
        ? { manifestReference: row.manifest_reference }
        : {}),
    });
  }

  #assertManagedWorkCheckpointAuthority(
    session: FactorySession,
    receipt: ManagedWorkCheckpointBindingRow,
    state: ManagedWorkCaptureState,
  ): void {
    this.#assertManagedWorkCheckpointPrerequisites(
      session,
      receipt,
      this.#captureControlByRequest(receipt.capture_request_id),
      this.#workspaceSnapshotByRequest(receipt.workspace_snapshot_request_id),
    );
    this.#assertManagedWorkCheckpointCaptureState(state, receipt);
  }

  #assertManagedWorkCheckpointPrerequisites(
    session: FactorySession,
    binding: ManagedWorkCheckpointBindingRow,
    capture: CaptureControlRow | undefined,
    snapshot: WorkspaceSnapshotRow | undefined,
  ): void {
    const ownerId = this.#requireOwner(session);
    if (
      session.actor.kind !== "human" ||
      binding.actor_json !== encode(session.actor) ||
      !capture ||
      !snapshot
    ) {
      throw notFound("Owner-held source capture and workspace snapshot");
    }
    const lock = this.database.all<{
      capture_id: string;
      thread_id: string;
      workspace_id: string;
      owner_id: string;
    }>(
      "SELECT capture_id, thread_id, workspace_id, owner_id FROM managed_work_captures WHERE capture_id = ?",
      [binding.capture_id],
    )[0];
    const thread = this.#captureThread(binding.thread_id);
    if (
      capture.request_id !== binding.capture_request_id ||
      capture.capture_id !== binding.capture_id ||
      capture.actor_json !== binding.actor_json ||
      capture.project_id !== binding.project_id ||
      capture.thread_id !== binding.thread_id ||
      capture.node_id !== binding.node_id ||
      capture.workspace_id !== binding.workspace_id ||
      capture.ownership_generation !== binding.ownership_generation ||
      capture.status !== "source-capture-fenced" ||
      !capture.report_json ||
      snapshot.request_id !== binding.workspace_snapshot_request_id ||
      snapshot.capture_request_id !== binding.capture_request_id ||
      snapshot.capture_id !== binding.capture_id ||
      snapshot.actor_json !== binding.actor_json ||
      snapshot.project_id !== binding.project_id ||
      snapshot.thread_id !== binding.thread_id ||
      snapshot.node_id !== binding.node_id ||
      snapshot.workspace_id !== binding.workspace_id ||
      snapshot.ownership_generation !== binding.ownership_generation ||
      snapshot.status !== "workspace-checkpoint-available" ||
      !snapshot.manifest_reference ||
      !this.#hasVerifiedWorkspaceSnapshotReport(snapshot) ||
      !lock ||
      lock.thread_id !== binding.thread_id ||
      lock.workspace_id !== binding.workspace_id ||
      lock.owner_id !== ownerId ||
      thread.project_id !== binding.project_id ||
      thread.node_id !== binding.node_id ||
      thread.workspace_id !== binding.workspace_id ||
      thread.ownership_generation !== binding.ownership_generation ||
      this.#ownershipGeneration() !== binding.ownership_generation ||
      !this.#isWorkspaceSnapshotFenceValid(snapshot) ||
      !this.#hasVerifiedWorkspaceSnapshotReferences(snapshot)
    ) {
      throw conflict(
        "managed_work_checkpoint_prerequisite_unavailable",
        "The exact held source capture and verified workspace snapshot are required",
      );
    }
  }

  #assertManagedWorkCheckpointCaptureState(
    state: ManagedWorkCaptureState,
    binding: ManagedWorkCheckpointBindingRow,
  ): void {
    if (
      state.state !== "source-capture-fenced" ||
      state.binding.captureId !== binding.capture_id ||
      state.binding.captureRequestId !== binding.capture_request_id ||
      state.binding.threadId !== binding.thread_id ||
      state.binding.projectId !== binding.project_id ||
      state.binding.target.nodeId !== binding.node_id ||
      state.binding.target.workspaceId !== binding.workspace_id ||
      state.binding.ownershipGeneration !== binding.ownership_generation
    ) {
      throw conflict(
        "managed_work_checkpoint_source_unavailable",
        "The original source capture is not currently confirmed fenced for this binding",
      );
    }
  }

  #hasVerifiedWorkspaceSnapshotReport(row: WorkspaceSnapshotRow): boolean {
    if (!row.report_json || !row.report_sha256) return false;
    try {
      const report = workspaceSnapshotReportSchema.parse(
        JSON.parse(row.report_json),
      );
      return (
        /^[a-f0-9]{64}$/.test(row.report_sha256) &&
        report.status === "workspace-checkpoint-available" &&
        report.snapshotId === row.snapshot_id &&
        report.requestId === row.request_id &&
        report.captureRequestId === row.capture_request_id &&
        report.captureId === row.capture_id &&
        report.nodeId === row.node_id &&
        report.target.nodeId === row.node_id &&
        report.target.workspaceId === row.workspace_id &&
        report.ownershipGeneration === row.ownership_generation &&
        report.manifestReference === row.manifest_reference
      );
    } catch {
      return false;
    }
  }

  #hasVerifiedWorkspaceSnapshotReferences(row: WorkspaceSnapshotRow): boolean {
    if (
      !row.manifest_reference ||
      !/^[a-f0-9]{64}$/.test(row.manifest_reference)
    ) {
      return false;
    }
    const totals = this.database.all<{
      count: number;
      total_size: number | null;
      manifest_count: number;
      invalid_count: number;
    }>(
      `SELECT COUNT(*) AS count, SUM(size_bytes) AS total_size,
        SUM(CASE WHEN reference = ? THEN 1 ELSE 0 END) AS manifest_count,
        SUM(CASE WHEN length(reference) <> 64 OR reference GLOB '*[^a-f0-9]*'
          OR size_bytes < 0 OR size_bytes > 536870912 THEN 1 ELSE 0 END) AS invalid_count
       FROM workspace_snapshot_blobs WHERE capture_id = ?`,
      [row.manifest_reference, row.capture_id],
    )[0];
    return Boolean(
      totals &&
      Number.isSafeInteger(totals.count) &&
      totals.count > 0 &&
      totals.count <= 100_003 &&
      totals.manifest_count === 1 &&
      totals.invalid_count === 0 &&
      totals.total_size !== null &&
      Number.isSafeInteger(totals.total_size) &&
      totals.total_size <= 512 * 1024 * 1024,
    );
  }

  #workspaceSnapshotByRequest(
    requestId: string,
  ): WorkspaceSnapshotRow | undefined {
    return this.database.all<WorkspaceSnapshotRow>(
      "SELECT * FROM workspace_snapshot_requests WHERE request_id = ?",
      [requestId],
    )[0];
  }

  #workspaceSnapshotById(snapshotId: string): WorkspaceSnapshotRow | undefined {
    return this.database.all<WorkspaceSnapshotRow>(
      "SELECT * FROM workspace_snapshot_requests WHERE snapshot_id = ?",
      [snapshotId],
    )[0];
  }

  #workspaceSnapshotByCapture(
    captureId: string,
  ): WorkspaceSnapshotRow | undefined {
    return this.database.all<WorkspaceSnapshotRow>(
      "SELECT * FROM workspace_snapshot_requests WHERE capture_id = ?",
      [captureId],
    )[0];
  }

  #isWorkspaceSnapshotFenceValid(row: WorkspaceSnapshotRow): boolean {
    const control = this.#captureControlByRequest(row.capture_request_id);
    const lock = this.database.all<{ capture_id: string }>(
      "SELECT capture_id FROM managed_work_captures WHERE capture_id = ? AND thread_id = ? AND workspace_id = ?",
      [row.capture_id, row.thread_id, row.workspace_id],
    )[0];
    const thread = this.#captureThread(row.thread_id);
    return Boolean(
      control &&
      control.status === "source-capture-fenced" &&
      control.capture_id === row.capture_id &&
      control.node_id === row.node_id &&
      control.thread_id === row.thread_id &&
      control.workspace_id === row.workspace_id &&
      control.ownership_generation === row.ownership_generation &&
      lock &&
      thread.node_id === row.node_id &&
      thread.workspace_id === row.workspace_id &&
      thread.ownership_generation === row.ownership_generation &&
      this.#ownershipGeneration() === row.ownership_generation &&
      this.#hasActiveWorkspaceReport(
        row.node_id,
        row.workspace_id,
        row.ownership_generation,
      ),
    );
  }

  #workspaceSnapshotStatus(row: WorkspaceSnapshotRow) {
    return workspaceSnapshotStatusSchema.parse({
      contractVersion: CONTRACT_VERSION,
      requestId: row.request_id,
      snapshotId: row.snapshot_id,
      captureRequestId: row.capture_request_id,
      captureId: row.capture_id,
      threadId: row.thread_id,
      target: { nodeId: row.node_id, workspaceId: row.workspace_id },
      ownershipGeneration: row.ownership_generation,
      status: row.status,
      acceptedAt: row.accepted_at,
      updatedAt: row.updated_at,
      ...(row.manifest_reference
        ? { manifestReference: row.manifest_reference }
        : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    });
  }

  #captureControlByRequest(requestId: string): CaptureControlRow | undefined {
    return this.database.all<CaptureControlRow>(
      "SELECT * FROM capture_control_requests WHERE request_id = ?",
      [requestId],
    )[0];
  }

  #captureControlById(controlId: string): CaptureControlRow | undefined {
    return this.database.all<CaptureControlRow>(
      "SELECT * FROM capture_control_requests WHERE control_id = ?",
      [controlId],
    )[0];
  }

  #captureControlStatus(row: CaptureControlRow) {
    const report = row.report_json
      ? executionCaptureControlReportSchema.parse(JSON.parse(row.report_json))
      : undefined;
    return captureControlStatusSchema.parse({
      contractVersion: CONTRACT_VERSION,
      requestId: row.request_id,
      controlId: row.control_id,
      captureId: row.capture_id,
      threadId: row.thread_id,
      target: { nodeId: row.node_id, workspaceId: row.workspace_id },
      ownershipGeneration: row.ownership_generation,
      status: row.status,
      acceptedAt: row.accepted_at,
      updatedAt: row.updated_at,
      ...(report?.sourceFence ? { sourceFence: report.sourceFence } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    });
  }

  #isWorkspaceCapturing(workspaceId: string): boolean {
    return (
      this.database.all(
        "SELECT capture_id FROM managed_work_captures WHERE workspace_id = ?",
        [workspaceId],
      ).length > 0
    );
  }

  #assertWorkspaceNotCapturing(workspaceId: string): void {
    if (this.#isWorkspaceCapturing(workspaceId)) {
      throw conflict(
        "managed_work_capture_active",
        "Input or execution admission is blocked while this managed workspace is being captured",
      );
    }
    this.#assertWorkspaceNotReservedForRelocation(workspaceId);
  }

  #assertWorkspaceNotReservedForRelocation(workspaceId: string): void {
    const reservation = this.database.all<{ relocation_id: string }>(
      "SELECT relocation_id FROM workspace_relocations WHERE destination_workspace_id = ? LIMIT 1",
      [workspaceId],
    )[0];
    if (reservation) {
      throw conflict(
        "workspace_relocation_reserved",
        "Workspace admission is blocked while an inactive relocation reservation exists",
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
    const policy = this.#policy(session);
    if (!policy.canAdminister) throw forbidden();
    return this.database.all<ActorRow>(
      "SELECT owner_id FROM factory_meta WHERE singleton = 1",
    )[0]!.owner_id;
  }

  #requireOwnerOrAssistant(session: FactorySession): void {
    const policy = this.#policy(session);
    if (!policy.isOwner && session.actor.kind !== "assistant")
      throw forbidden();
  }

  #policy(session: FactorySession): FactoryAccessPolicy {
    this.#requireActiveCredential(session);
    if (session.actor.kind === "node") throw forbidden();
    const owner = this.database.all<ActorRow>(
      "SELECT owner_id FROM factory_meta WHERE singleton = 1",
    )[0];
    if (!owner) throw new FactoryError(503, "not_bootstrapped");
    const principal: StoredAccessPrincipal =
      session.actor.kind === "human"
        ? (() => {
            const user = this.database.all<UserRow>(
              "SELECT user_id, display_name, role, revoked_at, access_generation, created_at FROM factory_users WHERE user_id = ?",
              [session.actor.userId],
            )[0];
            if (!user || user.revoked_at !== null) throw authError();
            const grants = this.database.all<{
              resource_type: string;
              resource_id: string;
            }>(
              "SELECT resource_type, resource_id FROM access_grants WHERE user_id = ? ORDER BY resource_type, resource_id",
              [user.user_id],
            );
            return {
              actor: session.actor,
              userId: user.user_id,
              role: user.role,
              accessGeneration: Number(user.access_generation),
              grants: grants.map((grant) =>
                accessGrantSchema.parse({
                  type: grant.resource_type,
                  resourceId: grant.resource_id,
                }),
              ),
              active: true,
            };
          })()
        : (() => {
            if (session.actor.kind !== "assistant") throw forbidden();
            if (session.actor.ownerId !== owner.owner_id) throw authError();
            const credential = this.database.all<{
              access_generation: number;
            }>(
              "SELECT access_generation FROM credentials WHERE credential_id = ?",
              [session.credentialId],
            )[0];
            if (!credential) throw authError();
            const rows = this.database.all<{
              resource_type: string;
              resource_id: string;
            }>(
              "SELECT resource_type, resource_id FROM assistant_credential_grants WHERE credential_id = ? ORDER BY resource_type, resource_id",
              [session.credentialId],
            );
            const factoryWide = rows.some(
              (grant) => grant.resource_type === "factory",
            );
            return {
              actor: session.actor,
              userId: null,
              assistantCredentialId: session.credentialId,
              role: null,
              grants: rows
                .filter((grant) => grant.resource_type !== "factory")
                .map((grant) =>
                  accessGrantSchema.parse({
                    type: grant.resource_type,
                    resourceId: grant.resource_id,
                  }),
                ),
              factoryWide,
              accessGeneration: Number(credential.access_generation),
              active: true,
            };
          })();
    return new FactoryAccessPolicy(owner.owner_id, principal);
  }

  #requireReadableThread(session: FactorySession, threadId: string): ThreadRow {
    const row = this.database.all<ThreadRow>(
      "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, owner_private, created_at FROM threads WHERE thread_id = ?",
      [threadId],
    )[0];
    if (!row) throw notFound("Thread");
    const policy = this.#policy(session);
    if (
      !policy.canReadThread(
        row.project_id,
        row.thread_id,
        row.owner_private === 1,
      )
    ) {
      throw notFound("Thread");
    }
    return row;
  }

  #requireSteerThread(session: FactorySession, threadId: string): ThreadRow {
    const row = this.#requireReadableThread(session, threadId);
    const policy = this.#policy(session);
    if (
      !policy.canSteer(row.project_id, row.thread_id, row.owner_private === 1)
    ) {
      throw forbidden();
    }
    return row;
  }

  // Accepted managed inputs can outlive their grant; recheck before dispatching later effects.
  #storedActorCanSteer(actor: FactoryActor, threadId: string): boolean {
    if (actor.kind === "node") return false;
    const owner = this.database.all<ActorRow>(
      "SELECT owner_id FROM factory_meta WHERE singleton = 1",
    )[0];
    if (!owner) return false;
    const activeCredential = this.database.all<{
      credential_id: string;
      access_generation: number;
    }>(
      "SELECT credential_id, access_generation FROM credentials WHERE actor_json = ? AND revoked_at IS NULL LIMIT 1",
      [encode(actor)],
    )[0];
    if (!activeCredential) return false;
    const thread = this.database.all<ThreadRow>(
      "SELECT thread_id, project_id, title, node_id, workspace_id, ownership_generation, owner_private, created_at FROM threads WHERE thread_id = ?",
      [threadId],
    )[0];
    if (!thread) return false;
    let principal: StoredAccessPrincipal;
    if (actor.kind === "human") {
      const user = this.database.all<UserRow>(
        "SELECT user_id, display_name, role, revoked_at, access_generation, created_at FROM factory_users WHERE user_id = ?",
        [actor.userId],
      )[0];
      if (!user || user.revoked_at !== null) return false;
      const grants = this.database.all<{
        resource_type: string;
        resource_id: string;
      }>(
        "SELECT resource_type, resource_id FROM access_grants WHERE user_id = ?",
        [user.user_id],
      );
      principal = {
        actor,
        userId: user.user_id,
        role: user.role,
        accessGeneration: Number(user.access_generation),
        grants: grants.map((grant) =>
          accessGrantSchema.parse({
            type: grant.resource_type,
            resourceId: grant.resource_id,
          }),
        ),
        active: true,
      };
    } else {
      if (actor.ownerId !== owner.owner_id) return false;
      const rows = this.database.all<{
        resource_type: string;
        resource_id: string;
      }>(
        "SELECT resource_type, resource_id FROM assistant_credential_grants WHERE credential_id = ?",
        [activeCredential.credential_id],
      );
      principal = {
        actor,
        userId: null,
        assistantCredentialId: activeCredential.credential_id,
        role: null,
        accessGeneration: Number(activeCredential.access_generation),
        grants: rows
          .filter((grant) => grant.resource_type !== "factory")
          .map((grant) =>
            accessGrantSchema.parse({
              type: grant.resource_type,
              resourceId: grant.resource_id,
            }),
          ),
        factoryWide: rows.some((grant) => grant.resource_type === "factory"),
        active: true,
      };
    }
    return new FactoryAccessPolicy(owner.owner_id, principal).canSteer(
      thread.project_id,
      thread.thread_id,
      thread.owner_private === 1,
    );
  }

  #validateQueryLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new FactoryError(
        400,
        "invalid_limit",
        "Query limits must be between 1 and 100",
      );
    }
  }

  #threadGrantPredicate(policy: FactoryAccessPolicy, alias: string): string {
    const projectIds = policy.principal.grants.filter(
      (grant) => grant.type === "project",
    );
    const threadIds = policy.principal.grants.filter(
      (grant) => grant.type === "thread",
    );
    const clauses = [
      ...(projectIds.length
        ? [`${alias}.project_id IN (${projectIds.map(() => "?").join(",")})`]
        : []),
      ...(threadIds.length
        ? [`${alias}.thread_id IN (${threadIds.map(() => "?").join(",")})`]
        : []),
    ];
    return clauses.length ? `(${clauses.join(" OR ")})` : "0 = 1";
  }

  #threadGrantParameters(policy: FactoryAccessPolicy): string[] {
    return [
      ...policy.principal.grants
        .filter((grant) => grant.type === "project")
        .map((grant) => grant.resourceId),
      ...policy.principal.grants
        .filter((grant) => grant.type === "thread")
        .map((grant) => grant.resourceId),
    ];
  }

  #validateAssistantGrantTargets(
    grants: readonly AssistantCredentialGrant[],
  ): void {
    const narrowed = grants.filter(
      (grant): grant is AccessGrant => grant.type !== "factory",
    );
    this.#validateGrantTargets(narrowed);
  }

  #assistantGrants(credentialId: string): AssistantCredentialGrant[] {
    return this.database
      .all<{ resource_type: string; resource_id: string }>(
        "SELECT resource_type, resource_id FROM assistant_credential_grants WHERE credential_id = ? ORDER BY resource_type, resource_id",
        [credentialId],
      )
      .map((grant) =>
        assistantCredentialGrantSchema.parse(
          grant.resource_type === "factory"
            ? { type: "factory" }
            : { type: grant.resource_type, resourceId: grant.resource_id },
        ),
      );
  }

  #replaceAssistantGrants(
    credentialId: string,
    grants: readonly AssistantCredentialGrant[],
    createdAt: string,
  ): void {
    this.database.exec(
      "DELETE FROM assistant_credential_grants WHERE credential_id = ?",
      [credentialId],
    );
    for (const grant of grants) {
      this.database.exec(
        "INSERT INTO assistant_credential_grants (credential_id, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?)",
        [
          credentialId,
          grant.type,
          grant.type === "factory" ? "factory" : grant.resourceId,
          createdAt,
        ],
      );
    }
  }

  #validateGrantTargets(grants: readonly AccessGrant[]): void {
    for (const grant of grants) {
      if (grant.type === "project") {
        if (
          !this.database.all(
            "SELECT project_id FROM projects WHERE project_id = ?",
            [grant.resourceId],
          ).length
        ) {
          throw notFound("Project grant target");
        }
      } else {
        const thread = this.database.all<{
          thread_id: string;
          owner_private: number;
        }>("SELECT thread_id, owner_private FROM threads WHERE thread_id = ?", [
          grant.resourceId,
        ])[0];
        if (!thread) throw notFound("Thread grant target");
        if (thread.owner_private === 1) {
          throw new FactoryError(
            400,
            "unsupported_grant",
            "Owner-private threads cannot be granted",
          );
        }
      }
    }
  }

  #replaceGrants(
    userId: string,
    grants: readonly AccessGrant[],
    createdAt: string,
  ): void {
    this.database.exec("DELETE FROM access_grants WHERE user_id = ?", [userId]);
    for (const grant of grants) {
      this.database.exec(
        "INSERT INTO access_grants (user_id, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?)",
        [userId, grant.type, grant.resourceId, createdAt],
      );
    }
  }

  #actorDisplayName(actor: FactoryActor): string {
    if (actor.kind === "human") {
      return (
        this.database.all<{ display_name: string }>(
          "SELECT display_name FROM factory_users WHERE user_id = ?",
          [actor.userId],
        )[0]?.display_name ?? actor.userId
      );
    }
    if (actor.kind === "assistant") {
      return (
        this.database.all<{ name: string }>(
          "SELECT name FROM credentials WHERE actor_json = ? ORDER BY created_at, credential_id LIMIT 1",
          [encode(actor)],
        )[0]?.name ?? actor.assistantId
      );
    }
    return (
      this.database.all<{ name: string }>(
        "SELECT name FROM nodes WHERE node_id = ?",
        [actor.nodeId],
      )[0]?.name ?? actor.nodeId
    );
  }

  #participant(row: UserRow): FactoryParticipant {
    const grants = this.database.all<{
      resource_type: string;
      resource_id: string;
    }>(
      "SELECT resource_type, resource_id FROM access_grants WHERE user_id = ? ORDER BY resource_type, resource_id",
      [row.user_id],
    );
    return factoryParticipantSchema.parse({
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      revokedAt: row.revoked_at,
      grants: grants.map((grant) => ({
        type: grant.resource_type,
        resourceId: grant.resource_id,
      })),
      createdAt: row.created_at,
    });
  }

  #invitation(row: InvitationRow): FactoryInvitation {
    return factoryInvitationSchema.parse({
      invitationId: row.invitation_id,
      role: row.role,
      grants: JSON.parse(row.grants_json),
      expiresAt: row.expires_at,
      redeemedAt: row.redeemed_at,
      redeemedBy: row.redeemed_by,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    });
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
    if (session.actor.kind === "human") {
      const user = this.database.all<{ revoked_at: string | null }>(
        "SELECT revoked_at FROM factory_users WHERE user_id = ?",
        [session.actor.userId],
      )[0];
      if (!user || user.revoked_at !== null) throw authError();
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
    assistantGrants?: AssistantCredentialGrant[],
  ): Promise<BootstrapResult> {
    const result = await this.#newCredential(actor, name);
    const createdAt = now();
    this.database.transaction(() => {
      this.#requireOwner(session);
      this.#insertCredentialRows(result, createdAt);
      if (assistantGrants) {
        this.#replaceAssistantGrants(
          result.credentialId,
          assistantGrants,
          createdAt,
        );
      }
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
      ...(assistantGrants ? { assistantGrants } : {}),
    };
  }

  #insertCredentialRows(credential: StoredCredential, createdAt: string): void {
    // A token is random bearer material; only its one-way digest reaches persistent storage.
    this.database.exec(
      "INSERT INTO credentials (credential_id, token_hash, actor_json, name, assistant_scope_initialized, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        credential.credentialId,
        credential.tokenHash,
        encode(credential.actor),
        credential.name,
        credential.actor.kind === "assistant" ? 1 : 0,
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
      ownerPrivate: row.owner_private === 1,
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
    const executionEffects = this.database
      .all<ExecutionJobRow>(
        "SELECT * FROM execution_jobs WHERE request_id = ? ORDER BY accepted_at, job_id",
        [row.request_id],
      )
      .map((effect) => this.#executionReceipt(effect));
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
      ...(executionEffects.length ? { executionEffects } : {}),
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
          "Controller reopened while managed work was in flight; it was not replayed";
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
        this.#fenceInterruptedManagedEffects(row, timestamp);
      }
    });
  }

  #fenceInterruptedManagedEffects(row: IntentRow, timestamp: string): void {
    const jobs = this.database.all<ExecutionJobRow>(
      "SELECT * FROM execution_jobs WHERE request_id = ? AND status IN ('queued', 'claimed') AND report_json IS NULL",
      [row.request_id],
    );
    for (const job of jobs) {
      const status = job.status === "queued" ? "failed" : "uncertain";
      const errorCode =
        job.status === "queued"
          ? "managed_input_interrupted_before_claim"
          : "managed_input_interrupted_after_claim";
      this.database.exec(
        "UPDATE execution_jobs SET status = ?, finished_at = ?, error_code = ? WHERE job_id = ? AND status = ? AND report_json IS NULL",
        [status, timestamp, errorCode, job.job_id, job.status],
      );
      this.#event(
        `execution.${status}`,
        parseActor(row.actor_json),
        row.project_id,
        row.thread_id,
        row.request_id,
        {
          jobId: job.job_id,
          nodeId: job.node_id,
          target: { nodeId: job.node_id, workspaceId: job.workspace_id },
          ownershipGeneration: job.ownership_generation,
          piTaskId: job.pi_task_id,
          piCallId: job.pi_call_id,
          errorCode,
        },
        timestamp,
      );
    }
  }
}
