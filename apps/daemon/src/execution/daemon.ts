import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import {
  captureWorkspaceCheckpoint,
  FileBlobTransport,
  restoreWorkspaceCheckpoint,
  validateWorkspaceCheckpoint,
  verifyRestoredWorkspaceCheckpoint,
  type WorkspaceCheckpointManifest,
} from "@uzina/checkpoints";
import {
  portableWorkspaceBlobReferences,
  PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
} from "@uzina/checkpoints/portable";
import {
  workspaceSnapshotClaimSchema,
  workspaceSnapshotReportSchema,
  workspaceRelocationClaimSchema,
  workspaceRelocationReportSchema,
  type WorkspaceSnapshotClaim,
  type WorkspaceSnapshotReport,
  type WorkspaceRelocationClaim,
  type WorkspaceRelocationReport,
} from "@uzina/contracts/factory";
import { Database } from "bun:sqlite";
import {
  EXECUTION_CONTRACT_VERSION,
  MAX_EXECUTION_COMMAND_OUTPUT_BYTES,
  MAX_EXECUTION_COMMAND_TIMEOUT_MS,
  MAX_EXECUTION_FILE_BYTES,
  executionCapabilitiesSchema,
  executionCaptureControlSchema,
  executionCaptureControlReportSchema,
  executionHeartbeatRequestSchema,
  executionJobReportSchema,
  executionJobSchema,
  executionReceiptSchema,
  executionRegisterRequestSchema,
  executionNodeIdSchema,
  executionWorkspaceIdSchema,
  executionWorkspaceReportSchema,
  type ExecutionCapabilities,
  type ExecutionCaptureControl,
  type ExecutionCaptureControlReport,
  type ExecutionHeartbeatRequest,
  type ExecutionJob,
  type ExecutionJobReport,
  type ExecutionReceipt,
  type ExecutionRegisterRequest,
  type ExecutionResult,
  type ExecutionWorkspaceReport,
} from "../../../../packages/contracts/src/execution";
import { ControllerHttpError, ControllerProtocolError } from "./connector";
import { ExecutionError } from "./errors";
import { executionPayloadSha256 } from "./payload";
import { RexProcessManager } from "./rex";

export interface WorkspaceMapping {
  workspaceId: string;
  directory: string;
  /** Used only to seed a workspace on first registration; SQLite wins on reopen. */
  ownershipGeneration?: number;
}

export interface ExecutionDaemonOptions {
  databasePath: string;
  nodeId: string;
  nodeCredential: string;
  workspaces: readonly WorkspaceMapping[];
  daemonVersion?: string;
  rexExecutable?: string;
  snapshotCacheDirectory?: string;
}

interface WorkspaceRow {
  workspace_id: string;
  directory: string;
  ownership_generation: number;
  active: number;
}

interface CaptureControlRow {
  control_id: string;
  capture_id: string;
  request_id: string;
  payload_sha256: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  status: "source-capture-fenced" | "blocked";
  accepted_at: string;
  report_json: string;
  report_sha256: string;
  reported_at: string | null;
  error_code: string | null;
}

interface WorkspaceRelocationReceiptRow {
  relocation_id: string;
  request_id: string;
  checkpoint_request_id: string;
  capture_request_id: string;
  capture_id: string;
  workspace_snapshot_request_id: string;
  snapshot_id: string;
  source_node_id: string;
  source_workspace_id: string;
  destination_node_id: string;
  destination_workspace_id: string;
  ownership_generation: number;
  manifest_reference: string;
  binding_json: string;
  binding_sha256: string;
  workspace_root: string | null;
  cache_directory: string | null;
  status: "preparing" | "prepared-inactive" | "blocked" | "uncertain";
  stage: "downloading" | "restore-started" | "terminal";
  receipt_json: string | null;
  receipt_sha256: string | null;
  previous_receipt_json: string | null;
  previous_receipt_sha256: string | null;
  report_json: string | null;
  report_sha256: string | null;
  reported_at: string | null;
  accepted_at: string;
  updated_at: string;
  error_code: string | null;
}

type WorkspaceRelocationBlobFetcher = (
  relocationId: string,
  reference: string,
) => Promise<{ body: ReadableStream<Uint8Array>; size: number }>;

interface WorkspaceSnapshotReceiptRow {
  snapshot_id: string;
  request_id: string;
  capture_request_id: string;
  capture_id: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  status: "producing" | "captured" | "available" | "blocked" | "uncertain";
  manifest_reference: string | null;
  report_json: string | null;
  report_sha256: string | null;
  reported_at: string | null;
}

interface JobRow {
  job_id: string;
  payload_sha256: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  operation: ExecutionJob["operation"];
  status: ExecutionReceipt["status"];
  accepted_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  error_code: string | null;
  reconciliation_evidence: string | null;
}

const CAPABILITIES: ExecutionCapabilities = executionCapabilitiesSchema.parse({
  fileRead: true,
  fileWrite: true,
  argvCommand: true,
  rexProcessCreate: true,
  rexProcessInspect: true,
  rexProcessStop: true,
});

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function hasSymlink(component: string): boolean {
  try {
    return lstatSync(component).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const FILESYSTEM_EXECUTION_CODES: Readonly<Record<string, string>> = {
  EACCES: "workspace_path_access_denied",
  EISDIR: "workspace_path_is_directory",
  ELOOP: "workspace_symlink_rejected",
  ENAMETOOLONG: "workspace_path_too_long",
  ENOENT: "workspace_path_not_found",
  ENOTDIR: "workspace_path_not_directory",
  EPERM: "workspace_path_access_denied",
};

function filesystemErrorAsExecutionFailure(
  error: unknown,
): ExecutionError | undefined {
  if (error instanceof ExecutionError) return error;
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  const executionCode = code ? FILESYSTEM_EXECUTION_CODES[code] : undefined;
  return executionCode ? new ExecutionError(executionCode) : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof ExecutionError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)) {
      return code.toLowerCase();
    }
  }
  return "execution_failed";
}

const COMMAND_TERMINATION_WAIT_MS = 1_000;

function isNoSuchProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

async function waitForCommandExit(
  child: ReturnType<typeof Bun.spawn>,
): Promise<number | undefined> {
  return Promise.race([
    child.exited,
    Bun.sleep(COMMAND_TERMINATION_WAIT_MS).then(() => undefined),
  ]);
}

async function waitForCommandGroupExit(
  processGroupId: number,
): Promise<boolean> {
  const deadline = Date.now() + COMMAND_TERMINATION_WAIT_MS;
  while (true) {
    try {
      globalThis.process.kill(-processGroupId, 0);
    } catch (error) {
      return isNoSuchProcess(error);
    }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(10);
  }
}

async function cancelCommandOutputReaders(
  readers: ReadableStreamDefaultReader<Uint8Array>[],
): Promise<void> {
  await Promise.all(
    readers.map(async (reader) => {
      try {
        await reader.cancel();
      } catch {
        // Output streams may already have closed.
      }
    }),
  );
}

async function terminateCommandProcessTree(
  child: ReturnType<typeof Bun.spawn>,
  readers: ReadableStreamDefaultReader<Uint8Array>[],
): Promise<number | undefined> {
  if (globalThis.process.platform === "win32") {
    try {
      child.kill(9);
    } catch {
      // The process may already have exited.
    }
    const exitCode = await waitForCommandExit(child);
    await cancelCommandOutputReaders(readers);
    return exitCode;
  }

  let groupSignalAccepted = false;
  try {
    globalThis.process.kill(-child.pid, "SIGKILL");
    groupSignalAccepted = true;
  } catch (error) {
    // ESRCH proves the group is already gone; other failures do not.
    groupSignalAccepted = isNoSuchProcess(error);
  }
  if (!groupSignalAccepted) {
    try {
      child.kill(9);
    } catch {
      // The process may already have exited.
    }
  }

  const exitCode = await waitForCommandExit(child);
  const processGroupExitObserved =
    groupSignalAccepted && (await waitForCommandGroupExit(child.pid));
  const terminationObserved =
    groupSignalAccepted && exitCode !== undefined && processGroupExitObserved;
  if (!terminationObserved) await cancelCommandOutputReaders(readers);
  return exitCode;
}

export class ExecutionDaemon {
  readonly #db: Database;
  readonly #nodeId: string;
  readonly #daemonVersion: string;
  readonly #snapshotCacheDirectory: string;
  readonly #databasePath: string | undefined;
  readonly #workspaces = new Map<string, string>();
  readonly #workspaceRelocationsInFlight = new Set<string>();
  readonly rex: RexProcessManager;
  #closed = false;

  constructor(options: ExecutionDaemonOptions) {
    if (!executionNodeIdSchema.safeParse(options.nodeId).success) {
      throw new TypeError("nodeId must be a stable execution identifier");
    }
    if (!options.nodeCredential) {
      throw new TypeError("nodeCredential is required");
    }
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(options.databasePath)), { recursive: true });
    }
    this.#nodeId = options.nodeId;
    this.#daemonVersion = options.daemonVersion ?? "0.0.0";
    this.#snapshotCacheDirectory = resolve(
      options.snapshotCacheDirectory ??
        (options.databasePath === ":memory:"
          ? join(tmpdir(), `uzina-snapshot-cache-${randomUUID()}`)
          : `${resolve(options.databasePath)}.snapshot-cache`),
    );
    this.#db = new Database(options.databasePath);
    this.#databasePath =
      options.databasePath === ":memory:"
        ? undefined
        : resolve(options.databasePath);
    try {
      this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS execution_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_workspaces (
        workspace_id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
        active INTEGER NOT NULL CHECK (active IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS execution_jobs (
        job_id TEXT PRIMARY KEY,
        payload_sha256 TEXT NOT NULL,
        node_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        ownership_generation INTEGER NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        result_json TEXT,
        error_code TEXT,
        reconciliation_evidence TEXT,
        reported_at TEXT
      );
      CREATE INDEX IF NOT EXISTS execution_jobs_workspace_status
        ON execution_jobs(workspace_id, status);
      CREATE TABLE IF NOT EXISTS execution_workspace_captures (
        workspace_id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        control_id TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_capture_controls (
        control_id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        payload_sha256 TEXT NOT NULL,
        node_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        ownership_generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('source-capture-fenced', 'blocked')),
        accepted_at TEXT NOT NULL,
        report_json TEXT NOT NULL,
        report_sha256 TEXT NOT NULL,
        reported_at TEXT,
        error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_workspace_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        capture_request_id TEXT NOT NULL UNIQUE,
        capture_id TEXT NOT NULL UNIQUE,
        node_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        ownership_generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('producing', 'captured', 'available', 'blocked', 'uncertain')),
        manifest_reference TEXT,
        report_json TEXT,
        report_sha256 TEXT,
        accepted_at TEXT NOT NULL,
        reported_at TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_workspace_relocations (
        relocation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        checkpoint_request_id TEXT NOT NULL,
        capture_request_id TEXT NOT NULL,
        capture_id TEXT NOT NULL,
        workspace_snapshot_request_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL UNIQUE,
        source_node_id TEXT NOT NULL,
        source_workspace_id TEXT NOT NULL,
        destination_node_id TEXT NOT NULL,
        destination_workspace_id TEXT NOT NULL UNIQUE,
        ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
        manifest_reference TEXT NOT NULL CHECK (length(manifest_reference) = 64 AND manifest_reference NOT GLOB '*[^a-f0-9]*'),
        binding_json TEXT NOT NULL,
        binding_sha256 TEXT NOT NULL CHECK (length(binding_sha256) = 64 AND binding_sha256 NOT GLOB '*[^a-f0-9]*'),
        workspace_root TEXT,
        cache_directory TEXT,
        status TEXT NOT NULL CHECK (status IN ('preparing', 'prepared-inactive', 'blocked', 'uncertain')),
        stage TEXT NOT NULL CHECK (stage IN ('downloading', 'restore-started', 'terminal')),
        receipt_json TEXT,
        receipt_sha256 TEXT,
        previous_receipt_json TEXT,
        previous_receipt_sha256 TEXT,
        report_json TEXT,
        report_sha256 TEXT,
        reported_at TEXT,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_code TEXT,
        CHECK (
          (status = 'preparing' AND report_json IS NULL AND report_sha256 IS NULL AND receipt_json IS NULL AND receipt_sha256 IS NULL AND error_code IS NULL)
          OR (status = 'prepared-inactive' AND stage = 'terminal' AND report_json IS NOT NULL AND report_sha256 IS NOT NULL AND receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL AND error_code IS NULL)
          OR (status IN ('blocked', 'uncertain') AND stage = 'terminal' AND report_json IS NOT NULL AND report_sha256 IS NOT NULL AND receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL AND error_code IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS execution_workspace_relocations_pending
        ON execution_workspace_relocations(status, reported_at, accepted_at);
      CREATE TABLE IF NOT EXISTS execution_rex_processes (
        process_id TEXT PRIMARY KEY,
        payload_sha256 TEXT NOT NULL,
        node_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        ownership_generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        launched_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_id TEXT,
        block_id TEXT,
        exit_code INTEGER,
        error_code TEXT,
        reconciliation_evidence TEXT
      );
      CREATE INDEX IF NOT EXISTS execution_rex_workspace_status
        ON execution_rex_processes(workspace_id, status);
    `);
      const captureColumns = this.#db
        .query<{ name: string }, []>(
          "PRAGMA table_info(execution_workspace_captures)",
        )
        .all();
      if (!captureColumns.some((column) => column.name === "control_id")) {
        this.#db.exec(
          "ALTER TABLE execution_workspace_captures ADD COLUMN control_id TEXT",
        );
      }
      const jobColumns = this.#db
        .query<{ name: string }, []>("PRAGMA table_info(execution_jobs)")
        .all();
      if (!jobColumns.some((column) => column.name === "reported_at")) {
        this.#db.exec("ALTER TABLE execution_jobs ADD COLUMN reported_at TEXT");
      }

      this.#bindMetadata("node_id", options.nodeId);
      this.#bindMetadata(
        "node_credential_sha256",
        sha256(options.nodeCredential),
      );

      for (const mapping of options.workspaces) {
        if (
          !executionWorkspaceIdSchema.safeParse(mapping.workspaceId).success
        ) {
          throw new ExecutionError("invalid_workspace_id");
        }
        if (this.#workspaces.has(mapping.workspaceId)) {
          throw new ExecutionError("duplicate_workspace_mapping");
        }
        const root = realpathSync(resolve(mapping.directory));
        if (!statSync(root).isDirectory()) {
          throw new ExecutionError("workspace_not_directory");
        }
        const existing = this.#db
          .query<WorkspaceRow, [string]>(
            "SELECT workspace_id, directory, ownership_generation, active FROM execution_workspaces WHERE workspace_id = ?",
          )
          .get(mapping.workspaceId);
        if (existing && existing.directory !== root) {
          throw new ExecutionError("workspace_mapping_conflict");
        }
        if (!existing) {
          const generation = mapping.ownershipGeneration ?? 0;
          if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new ExecutionError("invalid_ownership_generation");
          }
          this.#db
            .query(
              "INSERT INTO execution_workspaces(workspace_id, directory, ownership_generation, active) VALUES (?, ?, ?, 1)",
            )
            .run(mapping.workspaceId, root, generation);
        }
        this.#workspaces.set(mapping.workspaceId, root);
      }

      this.#db
        .query(
          "UPDATE execution_jobs SET status = 'uncertain', finished_at = ?, error_code = 'interrupted_after_start' WHERE status = 'running'",
        )
        .run(new Date().toISOString());
      this.#db
        .query(
          "UPDATE execution_rex_processes SET status = 'uncertain', updated_at = ?, error_code = 'interrupted_during_lifecycle' WHERE status IN ('starting', 'stopping')",
        )
        .run(new Date().toISOString());

      this.rex = new RexProcessManager({
        database: this.#db,
        nodeId: this.#nodeId,
        executable: options.rexExecutable ?? "rex",
        resolveWorkspace: (workspaceId) => this.#workspaceRoot(workspaceId),
        assertWorkspaceActive: (workspaceId, generation) =>
          this.#assertWorkspaceActive(workspaceId, generation),
        assertWorkspaceAdmission: (workspaceId) =>
          this.#assertWorkspaceAdmission(workspaceId),
      });
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  get nodeId(): string {
    return this.#nodeId;
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  registerRequest(): ExecutionRegisterRequest {
    this.#assertOpen();
    return executionRegisterRequestSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      nodeId: this.#nodeId,
      daemonVersion: this.#daemonVersion,
      workspaces: this.#workspaceReports(),
      capabilities: CAPABILITIES,
    });
  }

  heartbeatRequest(
    sentAt = new Date().toISOString(),
  ): ExecutionHeartbeatRequest {
    this.#assertOpen();
    return executionHeartbeatRequestSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      nodeId: this.#nodeId,
      sentAt,
      workspaces: this.#workspaceReports(),
      capabilities: CAPABILITIES,
    });
  }

  async executeJob(input: unknown): Promise<ExecutionReceipt> {
    this.#assertOpen();
    if (
      input &&
      typeof input === "object" &&
      "operation" in input &&
      !["read-file", "write-file", "argv-command"].includes(
        String((input as { operation: unknown }).operation),
      )
    ) {
      throw new ExecutionError("unsupported_operation");
    }
    const parsed = executionJobSchema.safeParse(input);
    if (!parsed.success) throw new ExecutionError("invalid_job");
    const job = parsed.data;
    this.#assertJobIdentity(job);

    const payloadSha256 = executionPayloadSha256(job);
    const current = this.#transaction(() => {
      const existing = this.#jobRow(job.jobId);
      if (existing) {
        if (existing.payload_sha256 !== payloadSha256) {
          throw new ExecutionError("job_id_payload_conflict");
        }
        return this.#receipt(existing);
      }
      const workspace = this.#workspaceRow(job.target.workspaceId);
      this.#assertActiveRow(workspace, job.ownershipGeneration);
      this.#assertWorkspaceAdmission(job.target.workspaceId);
      const acceptedAt = new Date().toISOString();
      try {
        this.#preflightJob(job);
      } catch (error) {
        const failure = filesystemErrorAsExecutionFailure(error);
        if (!failure) throw error;
        const finishedAt = new Date().toISOString();
        this.#db
          .query(
            `INSERT INTO execution_jobs(
              job_id, payload_sha256, node_id, workspace_id, ownership_generation,
              operation, status, accepted_at, finished_at, error_code
            ) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`,
          )
          .run(
            job.jobId,
            payloadSha256,
            this.#nodeId,
            job.target.workspaceId,
            job.ownershipGeneration,
            job.operation,
            acceptedAt,
            finishedAt,
            failure.code,
          );
        return this.#receipt(this.#jobRow(job.jobId)!);
      }
      this.#db
        .query(
          `INSERT INTO execution_jobs(
            job_id, payload_sha256, node_id, workspace_id, ownership_generation,
            operation, status, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          job.jobId,
          payloadSha256,
          this.#nodeId,
          job.target.workspaceId,
          job.ownershipGeneration,
          job.operation,
          acceptedAt,
        );
      return this.#receipt(this.#jobRow(job.jobId)!);
    });

    if (current.status !== "queued") return current;
    const started = this.#transaction(() => {
      const row = this.#jobRow(job.jobId)!;
      if (row.payload_sha256 !== payloadSha256) {
        throw new ExecutionError("job_id_payload_conflict");
      }
      if (row.status !== "queued") return this.#receipt(row);
      this.#assertActiveRow(
        this.#workspaceRow(job.target.workspaceId),
        job.ownershipGeneration,
      );
      this.#assertWorkspaceAdmission(job.target.workspaceId);
      this.#db
        .query(
          "UPDATE execution_jobs SET status = 'running', started_at = ? WHERE job_id = ? AND status = 'queued'",
        )
        .run(new Date().toISOString(), job.jobId);
      return this.#receipt(this.#jobRow(job.jobId)!);
    });
    if (started.status !== "running") return started;

    try {
      const result = await this.#perform(job);
      if (
        job.operation === "argv-command" &&
        result.operation === "argv-command" &&
        result.timedOut
      ) {
        return this.#finishJob(
          job.jobId,
          "uncertain",
          result,
          "command_timed_out",
        );
      }
      const status =
        job.operation === "argv-command" &&
        result.operation === "argv-command" &&
        result.exitCode !== 0
          ? "failed"
          : "completed";
      return this.#finishJob(
        job.jobId,
        status,
        result,
        status === "failed" ? "command_failed" : undefined,
      );
    } catch (error) {
      const failure = filesystemErrorAsExecutionFailure(error);
      if (!(error instanceof UncertainEffectError) && !failure) throw error;
      const status =
        error instanceof UncertainEffectError ? "uncertain" : "failed";
      return this.#finishJob(
        job.jobId,
        status,
        undefined,
        errorCode(failure ?? error),
      );
    }
  }

  getReceipt(jobId: string): ExecutionReceipt | undefined {
    this.#assertOpen();
    const row = this.#jobRow(jobId);
    return row ? this.#receipt(row) : undefined;
  }

  reportFor(jobId: string): ExecutionJobReport {
    const receipt = this.getReceipt(jobId);
    if (
      !receipt ||
      !["completed", "failed", "uncertain"].includes(receipt.status)
    ) {
      throw new ExecutionError("job_not_reportable");
    }
    return executionJobReportSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      jobId: receipt.jobId,
      nodeId: receipt.nodeId,
      target: receipt.target,
      ownershipGeneration: receipt.ownershipGeneration,
      status: receipt.status,
      payloadSha256: receipt.payloadSha256,
      finishedAt: receipt.finishedAt,
      result: receipt.result,
      errorCode: receipt.errorCode,
      reconciliationEvidence: receipt.reconciliationEvidence,
    });
  }

  pendingReports(limit = 100): ExecutionJobReport[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ExecutionError("invalid_report_limit");
    }
    const rows = this.#db
      .query<{ job_id: string }, [number]>(
        "SELECT job_id FROM execution_jobs WHERE status IN ('completed', 'failed', 'uncertain') AND reported_at IS NULL ORDER BY finished_at, job_id LIMIT ?",
      )
      .all(limit);
    return rows.map((row) => this.reportFor(row.job_id));
  }

  markReported(jobId: string, status: ExecutionJobReport["status"]): void {
    this.#assertOpen();
    this.#transaction(() => {
      const row = this.#jobRow(jobId);
      if (!row || row.status !== status) {
        throw new ExecutionError("report_acknowledgement_mismatch");
      }
      this.#db
        .query(
          "UPDATE execution_jobs SET reported_at = COALESCE(reported_at, ?) WHERE job_id = ?",
        )
        .run(new Date().toISOString(), jobId);
    });
  }

  reconcileUncertainJob(
    jobId: string,
    outcome: "confirmed-completed" | "confirmed-not-applied",
    evidence: string,
  ): ExecutionReceipt {
    this.#assertOpen();
    const trimmed = evidence.trim();
    if (!trimmed || trimmed.length > 2048) {
      throw new ExecutionError("reconciliation_evidence_required");
    }
    return this.#transaction(() => {
      const row = this.#jobRow(jobId);
      if (!row) throw new ExecutionError("job_not_found");
      if (row.status !== "uncertain")
        throw new ExecutionError("job_not_uncertain");
      this.#db
        .query(
          `UPDATE execution_jobs SET status = ?, finished_at = ?, error_code = 'operator_reconciled',
            reconciliation_evidence = ? WHERE job_id = ? AND status = 'uncertain'`,
        )
        .run(
          outcome === "confirmed-completed" ? "completed" : "failed",
          new Date().toISOString(),
          trimmed,
          jobId,
        );
      return this.#receipt(this.#jobRow(jobId)!);
    });
  }

  workspaceDirectory(workspaceId: string): string {
    this.#assertOpen();
    return this.#workspaceRoot(workspaceId);
  }

  /** Local snapshot-capture fence; unlike remote control fences it is releasable by its host. */
  beginWorkspaceCapture(workspaceId: string, captureId: string): void {
    this.#assertOpen();
    if (!captureId.trim() || captureId.length > 256) {
      throw new ExecutionError("invalid_workspace_capture_id");
    }
    this.#transaction(() => {
      this.#assertWorkspaceCapturePreflight(workspaceId);
      this.#db
        .query(
          "INSERT INTO execution_workspace_captures(workspace_id, capture_id, started_at, control_id) VALUES (?, ?, ?, NULL)",
        )
        .run(workspaceId, captureId, new Date().toISOString());
    });
  }

  /**
   * Applies the idempotent remote CONTROL operation. Its node receipt and local
   * admission fence commit atomically; blocked receipts never claim quiescence.
   */
  executeCaptureControl(input: unknown): ExecutionCaptureControlReport {
    this.#assertOpen();
    const parsed = executionCaptureControlSchema.safeParse(input);
    if (!parsed.success) throw new ExecutionError("invalid_capture_control");
    const control = parsed.data;
    this.#assertCaptureControlIdentity(control);
    const { payloadSha256, ...payload } = control;
    if (executionPayloadSha256(payload) !== payloadSha256) {
      throw new ExecutionError("capture_control_payload_mismatch");
    }

    return this.#transaction(() => {
      const existing = this.#captureControlRow(control.controlId);
      if (existing) {
        if (
          existing.payload_sha256 !== payloadSha256 ||
          existing.capture_id !== control.captureId ||
          existing.request_id !== control.requestId ||
          existing.node_id !== control.nodeId ||
          existing.workspace_id !== control.target.workspaceId ||
          existing.ownership_generation !== control.ownershipGeneration
        ) {
          throw new ExecutionError("capture_control_id_conflict");
        }
        if (existing.status === "source-capture-fenced") {
          const fence = this.#db
            .query<{ capture_id: string; control_id: string | null }, [string]>(
              "SELECT capture_id, control_id FROM execution_workspace_captures WHERE workspace_id = ?",
            )
            .get(control.target.workspaceId);
          if (
            !fence ||
            fence.capture_id !== control.captureId ||
            fence.control_id !== control.controlId
          ) {
            throw new ExecutionError("capture_control_fence_missing");
          }
        }
        return executionCaptureControlReportSchema.parse(
          JSON.parse(existing.report_json),
        );
      }
      const collision = this.#db
        .query<{ control_id: string }, [string, string]>(
          "SELECT control_id FROM execution_capture_controls WHERE capture_id = ? OR request_id = ? LIMIT 1",
        )
        .get(control.captureId, control.requestId);
      if (collision) throw new ExecutionError("capture_control_id_conflict");

      let refusal: ExecutionError | undefined;
      try {
        this.#assertWorkspaceCapturePreflight(control.target.workspaceId);
      } catch (error) {
        if (
          error instanceof ExecutionError &&
          [
            "workspace_has_unsettled_effects",
            "workspace_has_running_rex_processes",
            "workspace_mappings_overlap",
            "workspace_mapping_unavailable",
            "workspace_capture_active",
            "workspace_fenced",
          ].includes(error.code)
        ) {
          refusal = error;
        } else {
          throw error;
        }
      }

      const acceptedAt = new Date().toISOString();
      let report: ExecutionCaptureControlReport;
      if (refusal) {
        report = executionCaptureControlReportSchema.parse({
          contractVersion: EXECUTION_CONTRACT_VERSION,
          controlId: control.controlId,
          captureId: control.captureId,
          requestId: control.requestId,
          nodeId: this.#nodeId,
          target: control.target,
          ownershipGeneration: control.ownershipGeneration,
          payloadSha256,
          status: "blocked",
          reportedAt: acceptedAt,
          errorCode: refusal.code,
        });
      } else {
        this.#db
          .query(
            "INSERT INTO execution_workspace_captures(workspace_id, capture_id, started_at, control_id) VALUES (?, ?, ?, ?)",
          )
          .run(
            control.target.workspaceId,
            control.captureId,
            acceptedAt,
            control.controlId,
          );
        const proofBinding = {
          controlId: control.controlId,
          captureId: control.captureId,
          requestId: control.requestId,
          nodeId: this.#nodeId,
          target: control.target,
          ownershipGeneration: control.ownershipGeneration,
          fencedAt: acceptedAt,
        };
        report = executionCaptureControlReportSchema.parse({
          contractVersion: EXECUTION_CONTRACT_VERSION,
          controlId: control.controlId,
          captureId: control.captureId,
          requestId: control.requestId,
          nodeId: this.#nodeId,
          target: control.target,
          ownershipGeneration: control.ownershipGeneration,
          payloadSha256,
          status: "source-capture-fenced",
          reportedAt: acceptedAt,
          sourceFence: {
            ...proofBinding,
            receiptSha256: executionPayloadSha256(proofBinding),
          },
        });
      }
      const reportJson = JSON.stringify(report);
      this.#db
        .query(
          `INSERT INTO execution_capture_controls(
            control_id, capture_id, request_id, payload_sha256, node_id,
            workspace_id, ownership_generation, status, accepted_at, report_json,
            report_sha256, error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          control.controlId,
          control.captureId,
          control.requestId,
          payloadSha256,
          this.#nodeId,
          control.target.workspaceId,
          control.ownershipGeneration,
          report.status,
          acceptedAt,
          reportJson,
          executionPayloadSha256(report),
          report.errorCode ?? null,
        );
      return report;
    });
  }

  pendingCaptureControlReports(): ExecutionCaptureControlReport[] {
    this.#assertOpen();
    return this.#db
      .query<{ report_json: string }, []>(
        "SELECT report_json FROM execution_capture_controls WHERE reported_at IS NULL ORDER BY accepted_at, control_id",
      )
      .all()
      .map((row) =>
        executionCaptureControlReportSchema.parse(JSON.parse(row.report_json)),
      );
  }

  markCaptureControlReported(
    controlId: string,
    report: ExecutionCaptureControlReport,
  ): void {
    this.#assertOpen();
    const row = this.#captureControlRow(controlId);
    if (!row) throw new ExecutionError("capture_control_receipt_not_found");
    if (row.report_sha256 !== executionPayloadSha256(report)) {
      throw new ExecutionError("capture_control_report_ack_mismatch");
    }
    this.#db
      .query(
        "UPDATE execution_capture_controls SET reported_at = ? WHERE control_id = ? AND reported_at IS NULL",
      )
      .run(new Date().toISOString(), controlId);
  }

  pendingWorkspaceSnapshotReports(): WorkspaceSnapshotReport[] {
    this.#assertOpen();
    return this.#db
      .query<{ report_json: string }, []>(
        "SELECT report_json FROM execution_workspace_snapshots WHERE report_json IS NOT NULL AND reported_at IS NULL ORDER BY accepted_at, snapshot_id",
      )
      .all()
      .map((row) =>
        workspaceSnapshotReportSchema.parse(JSON.parse(row.report_json)),
      );
  }

  markWorkspaceSnapshotReported(
    snapshotId: string,
    report: WorkspaceSnapshotReport,
  ): void {
    this.#assertOpen();
    const row = this.#workspaceSnapshotRow(snapshotId);
    if (!row || row.report_sha256 !== executionPayloadSha256(report)) {
      throw new ExecutionError("workspace_snapshot_report_ack_mismatch");
    }
    this.#db
      .query(
        "UPDATE execution_workspace_snapshots SET reported_at = ?, status = CASE WHEN status IN ('blocked', 'uncertain') THEN status ELSE 'available' END WHERE snapshot_id = ? AND reported_at IS NULL",
      )
      .run(new Date().toISOString(), snapshotId);
  }

  pendingWorkspaceRelocationReports(): WorkspaceRelocationReport[] {
    this.#assertOpen();
    return this.#db
      .query<{ report_json: string }, []>(
        "SELECT report_json FROM execution_workspace_relocations WHERE report_json IS NOT NULL AND reported_at IS NULL ORDER BY accepted_at, relocation_id",
      )
      .all()
      .map((row) =>
        workspaceRelocationReportSchema.parse(JSON.parse(row.report_json)),
      );
  }

  markWorkspaceRelocationReported(
    relocationId: string,
    report: WorkspaceRelocationReport,
  ): void {
    this.#assertOpen();
    const row = this.#workspaceRelocationRow(relocationId);
    if (!row || row.report_sha256 !== executionPayloadSha256(report)) {
      throw new ExecutionError("workspace_relocation_report_ack_mismatch");
    }
    this.#db
      .query(
        "UPDATE execution_workspace_relocations SET reported_at = ? WHERE relocation_id = ? AND reported_at IS NULL",
      )
      .run(new Date().toISOString(), relocationId);
  }

  /** Reconciles local receipts before the daemon can accept new controller work. */
  async reconcileWorkspaceRelocations(): Promise<void> {
    this.#assertOpen();
    const rows = this.#db
      .query<WorkspaceRelocationReceiptRow, []>(
        "SELECT * FROM execution_workspace_relocations WHERE status IN ('preparing', 'prepared-inactive') ORDER BY accepted_at, relocation_id",
      )
      .all();
    for (const row of rows) {
      if (this.#workspaceRelocationsInFlight.has(row.relocation_id)) continue;
      this.#workspaceRelocationsInFlight.add(row.relocation_id);
      try {
        const claim = workspaceRelocationClaimSchema.parse(
          JSON.parse(row.binding_json),
        );
        this.#assertWorkspaceRelocationIdentity(claim, row);
        if (row.status === "preparing" && row.stage === "downloading") {
          if (!this.#relocationWorkspaceIsEmpty(row)) {
            this.#storeWorkspaceRelocationReport(
              claim,
              "uncertain",
              "workspace_relocation_destination_changed",
            );
          }
          continue;
        }
        try {
          this.#assertWorkspaceRelocationReady(row, false);
          const manifest = this.#loadWorkspaceRelocationManifest(row);
          const transport = new FileBlobTransport(row.cache_directory!);
          const validation = await validateWorkspaceCheckpoint(
            manifest,
            transport,
          );
          if (!validation.valid) {
            throw new ExecutionError("workspace_relocation_checkpoint_invalid");
          }
          await verifyRestoredWorkspaceCheckpoint(
            manifest,
            transport,
            row.workspace_root!,
          );
          this.#assertWorkspaceRelocationReady(row, false);
          if (row.status === "preparing") {
            this.#storeWorkspaceRelocationReport(claim, "prepared-inactive");
          }
        } catch {
          this.#storeWorkspaceRelocationReport(
            claim,
            "uncertain",
            "workspace_relocation_restore_unverified",
          );
        }
      } finally {
        this.#workspaceRelocationsInFlight.delete(row.relocation_id);
      }
    }
  }

  async executeWorkspaceRelocation(
    input: unknown,
    fetchBlob: WorkspaceRelocationBlobFetcher,
  ): Promise<WorkspaceRelocationReport> {
    this.#assertOpen();
    const claim = workspaceRelocationClaimSchema.parse(input);
    if (
      claim.destination.nodeId !== this.#nodeId ||
      claim.source.nodeId === claim.destination.nodeId ||
      claim.source.workspaceId === claim.destination.workspaceId
    ) {
      throw new ExecutionError("workspace_relocation_node_mismatch");
    }
    if (this.#workspaceRelocationsInFlight.has(claim.relocationId)) {
      throw new ExecutionError("workspace_relocation_already_running");
    }
    this.#workspaceRelocationsInFlight.add(claim.relocationId);
    try {
      let row = this.#workspaceRelocationRow(claim.relocationId);
      if (row) {
        this.#assertWorkspaceRelocationIdentity(claim, row);
        if (row.report_json && row.status !== "prepared-inactive") {
          return workspaceRelocationReportSchema.parse(
            JSON.parse(row.report_json),
          );
        }
        if (row.status === "prepared-inactive") {
          try {
            this.#assertWorkspaceRelocationReady(row, false);
            const manifest = this.#loadWorkspaceRelocationManifest(row);
            const transport = new FileBlobTransport(row.cache_directory!);
            const validation = await validateWorkspaceCheckpoint(
              manifest,
              transport,
            );
            if (!validation.valid) {
              throw new ExecutionError(
                "workspace_relocation_checkpoint_invalid",
              );
            }
            await verifyRestoredWorkspaceCheckpoint(
              manifest,
              transport,
              row.workspace_root!,
            );
            this.#assertWorkspaceRelocationReady(row, false);
            return workspaceRelocationReportSchema.parse(
              JSON.parse(row.report_json!),
            );
          } catch {
            return this.#storeWorkspaceRelocationReport(
              claim,
              "uncertain",
              "workspace_relocation_restore_unverified",
            );
          }
        }
        if (row.stage === "restore-started") {
          return this.#reconcileStartedWorkspaceRelocation(claim, row);
        }
      } else {
        row = this.#reserveWorkspaceRelocation(claim);
        if (row.report_json) {
          return workspaceRelocationReportSchema.parse(
            JSON.parse(row.report_json),
          );
        }
      }

      try {
        return await this.#prepareWorkspaceRelocation(claim, row, fetchBlob);
      } catch (error) {
        if (error instanceof ControllerHttpError) {
          if ([404, 409, 422].includes(error.status)) {
            return this.#storeWorkspaceRelocationReport(
              claim,
              "uncertain",
              "workspace_relocation_source_unavailable",
            );
          }
          throw error;
        }
        if (error instanceof ControllerProtocolError) {
          return this.#storeWorkspaceRelocationReport(
            claim,
            row.stage === "restore-started" ? "uncertain" : "blocked",
            "workspace_relocation_blob_invalid",
          );
        }
        if (error instanceof ExecutionError) {
          return this.#storeWorkspaceRelocationReport(
            claim,
            row.stage === "restore-started" ? "uncertain" : "blocked",
            error.code,
          );
        }
        throw error;
      }
    } finally {
      this.#workspaceRelocationsInFlight.delete(claim.relocationId);
    }
  }

  /** Produces once under the held CONTROL fence, then retries only immutable cached uploads. */
  async executeWorkspaceSnapshot(
    input: unknown,
    uploadBlob: (
      captureId: string,
      reference: string,
      stream: ReadableStream<Uint8Array>,
      contentLength: number,
    ) => Promise<void>,
  ): Promise<WorkspaceSnapshotReport> {
    this.#assertOpen();
    const snapshot = workspaceSnapshotClaimSchema.parse(input);
    const previous = this.#workspaceSnapshotRow(snapshot.snapshotId);
    if (previous) {
      this.#assertWorkspaceSnapshotIdentity(snapshot, previous);
      if (previous.report_json) {
        return workspaceSnapshotReportSchema.parse(
          JSON.parse(previous.report_json),
        );
      }
      if (previous.status === "producing") {
        return this.#storeWorkspaceSnapshotReport(
          snapshot,
          "uncertain",
          "snapshot_production_interrupted",
        );
      }
      if (previous.status === "blocked" || previous.status === "uncertain") {
        return this.#storeWorkspaceSnapshotReport(
          snapshot,
          previous.status,
          previous.status === "blocked"
            ? "snapshot_production_blocked"
            : "snapshot_cache_uncertain",
        );
      }
    } else {
      this.#assertWorkspaceSnapshotFence(snapshot);
      this.#transaction(() => {
        this.#db
          .query(
            `INSERT INTO execution_workspace_snapshots(
              snapshot_id, request_id, capture_request_id, capture_id, node_id,
              workspace_id, ownership_generation, status, accepted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'producing', ?)`,
          )
          .run(
            snapshot.snapshotId,
            snapshot.requestId,
            snapshot.captureRequestId,
            snapshot.captureId,
            snapshot.nodeId,
            snapshot.target.workspaceId,
            snapshot.ownershipGeneration,
            new Date().toISOString(),
          );
      });
    }

    let manifestReference: string;
    let manifest: WorkspaceCheckpointManifest;
    const cacheDirectory = join(
      this.#snapshotCacheDirectory,
      sha256(snapshot.captureId),
    );
    const cache = new FileBlobTransport(cacheDirectory);
    const captured = this.#workspaceSnapshotRow(snapshot.snapshotId);
    try {
      this.#assertWorkspaceSnapshotFence(snapshot);
      await this.#assertSnapshotCacheOutsideWorkspaces(cacheDirectory);
      if (captured?.status === "captured") {
        if (!captured.manifest_reference) throw new Error("missing_manifest");
        manifestReference = captured.manifest_reference;
        const manifestBytes = await cache.getBlob(manifestReference);
        manifest = JSON.parse(
          new TextDecoder().decode(manifestBytes),
        ) as WorkspaceCheckpointManifest;
        this.#assertSnapshotManifestReferences(manifest, manifestReference);
      } else {
        const result = await captureWorkspaceCheckpoint({
          workspacePath: this.#workspaceRoot(snapshot.target.workspaceId),
          transport: cache,
        });
        manifestReference = result.manifestReference;
        manifest = result.manifest;
        this.#assertSnapshotManifestReferences(manifest, manifestReference);
        this.#transaction(() => {
          this.#db
            .query(
              "UPDATE execution_workspace_snapshots SET status = 'captured', manifest_reference = ? WHERE snapshot_id = ? AND status = 'producing'",
            )
            .run(manifestReference, snapshot.snapshotId);
        });
      }
    } catch {
      const row = this.#workspaceSnapshotRow(snapshot.snapshotId);
      if (row?.status === "producing") {
        return this.#storeWorkspaceSnapshotReport(
          snapshot,
          "blocked",
          "workspace_checkpoint_capture_failed",
        );
      }
      return this.#storeWorkspaceSnapshotReport(
        snapshot,
        "uncertain",
        "snapshot_cache_missing_or_corrupt",
      );
    }

    const references = this.#snapshotBlobReferences(
      manifest,
      manifestReference,
    );
    for (const reference of references) {
      this.#assertWorkspaceSnapshotFence(snapshot);
      const path = join(cacheDirectory, reference);
      let size: number;
      try {
        size = statSync(path).size;
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > 512 * 1024 * 1024
        ) {
          throw new Error("invalid_cache_size");
        }
        const hasher = createHash("sha256");
        let actualSize = 0;
        for await (const part of createReadStream(path)) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
          actualSize += bytes.byteLength;
          hasher.update(bytes);
        }
        if (actualSize !== size || hasher.digest("hex") !== reference) {
          throw new Error("cache_hash_mismatch");
        }
      } catch {
        return this.#storeWorkspaceSnapshotReport(
          snapshot,
          "uncertain",
          "snapshot_cache_missing_or_corrupt",
        );
      }
      const stream = Readable.toWeb(
        createReadStream(path),
      ) as unknown as ReadableStream<Uint8Array>;
      await uploadBlob(snapshot.captureId, reference, stream, size);
    }
    return this.#storeWorkspaceSnapshotReport(
      snapshot,
      "workspace-checkpoint-available",
      undefined,
      manifestReference,
    );
  }

  /** Ordinary local capture cleanup cannot clear a fence owned by remote CONTROL. */
  endWorkspaceCapture(captureId: string): void {
    this.#assertOpen();
    const existing = this.#db
      .query<{ control_id: string | null }, [string]>(
        "SELECT control_id FROM execution_workspace_captures WHERE capture_id = ?",
      )
      .get(captureId);
    if (existing?.control_id) {
      throw new ExecutionError("capture_control_fence_held");
    }
    this.#db
      .query("DELETE FROM execution_workspace_captures WHERE capture_id = ?")
      .run(captureId);
  }

  fenceWorkspace(
    workspaceId: string,
    expectedGeneration: number,
    nextGeneration: number,
  ): ExecutionWorkspaceReport {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#assertWorkspaceAdmission(workspaceId);
      const workspace = this.#workspaceRow(workspaceId);
      if (!workspace) throw new ExecutionError("workspace_not_found");
      if (
        workspace.ownership_generation !== expectedGeneration ||
        !workspace.active
      ) {
        throw new ExecutionError("stale_ownership_generation");
      }
      if (
        !Number.isSafeInteger(nextGeneration) ||
        nextGeneration <= expectedGeneration
      ) {
        throw new ExecutionError("generation_must_advance");
      }
      const jobs = this.#db
        .query<{ status: string }, [string]>(
          "SELECT status FROM execution_jobs WHERE workspace_id = ? AND status IN ('running', 'uncertain') LIMIT 1",
        )
        .get(workspaceId);
      if (jobs) throw new ExecutionError("workspace_has_uncertain_effects");
      if (this.rex?.hasBlockingProcesses(workspaceId)) {
        throw new ExecutionError("workspace_has_running_rex_processes");
      }
      this.#db
        .query(
          `UPDATE execution_jobs SET status = 'failed', finished_at = ?, error_code = 'ownership_fenced'
            WHERE workspace_id = ? AND status = 'queued'`,
        )
        .run(new Date().toISOString(), workspaceId);
      this.#db
        .query(
          "UPDATE execution_workspaces SET ownership_generation = ?, active = 0 WHERE workspace_id = ?",
        )
        .run(nextGeneration, workspaceId);
      return executionWorkspaceReportSchema.parse({
        workspaceId,
        ownershipGeneration: nextGeneration,
        state: "fenced",
      });
    });
  }

  activateWorkspace(
    workspaceId: string,
    generation: number,
  ): ExecutionWorkspaceReport {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#assertWorkspaceAdmission(workspaceId);
      const workspace = this.#workspaceRow(workspaceId);
      if (!workspace) throw new ExecutionError("workspace_not_found");
      if (workspace.ownership_generation !== generation) {
        throw new ExecutionError("stale_ownership_generation");
      }
      if (workspace.active)
        throw new ExecutionError("workspace_already_active");
      const job = this.#db
        .query<{ status: string }, [string]>(
          "SELECT status FROM execution_jobs WHERE workspace_id = ? AND status IN ('running', 'uncertain') LIMIT 1",
        )
        .get(workspaceId);
      if (job || this.rex.hasBlockingProcesses(workspaceId)) {
        throw new ExecutionError("workspace_has_uncertain_effects");
      }
      this.#db
        .query(
          "UPDATE execution_workspaces SET active = 1 WHERE workspace_id = ?",
        )
        .run(workspaceId);
      return executionWorkspaceReportSchema.parse({
        workspaceId,
        ownershipGeneration: generation,
        state: "active",
      });
    });
  }

  #assertJobIdentity(job: ExecutionJob): void {
    if (job.nodeId !== this.#nodeId || job.target.nodeId !== this.#nodeId) {
      throw new ExecutionError("target_node_mismatch");
    }
    if (!this.#workspaces.has(job.target.workspaceId)) {
      throw new ExecutionError("workspace_not_configured");
    }
  }

  #preflightJob(job: ExecutionJob): void {
    if (job.operation === "read-file") {
      this.#resolveWorkspacePath(job.target.workspaceId, job.path, false);
    } else if (job.operation === "write-file") {
      this.#decodeContent(job.contentBase64);
      this.#resolveWorkspacePath(job.target.workspaceId, job.path, true);
    } else if (job.operation === "argv-command") {
      if (
        job.timeoutMs > MAX_EXECUTION_COMMAND_TIMEOUT_MS ||
        job.maxOutputBytes > MAX_EXECUTION_COMMAND_OUTPUT_BYTES
      ) {
        throw new ExecutionError("command_limit_exceeded");
      }
      this.#resolveCommandCwd(job.target.workspaceId, job.cwd);
    } else {
      throw new ExecutionError("unsupported_operation");
    }
  }

  async #perform(job: ExecutionJob): Promise<ExecutionResult> {
    switch (job.operation) {
      case "read-file": {
        const file = this.#resolveWorkspacePath(
          job.target.workspaceId,
          job.path,
          false,
        );
        const fd = openSync(
          file,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          const chunk = Buffer.alloc(Math.min(64 * 1024, job.maxBytes + 1));
          while (bytes <= job.maxBytes) {
            const length = readSync(
              fd,
              chunk,
              0,
              Math.min(chunk.length, job.maxBytes + 1 - bytes),
              null,
            );
            if (length === 0) break;
            bytes += length;
            chunks.push(Buffer.from(chunk.subarray(0, length)));
          }
          if (bytes > job.maxBytes)
            throw new ExecutionError("file_size_limit_exceeded");
          const content = Buffer.concat(chunks);
          return {
            operation: job.operation,
            contentBase64: content.toString("base64"),
            bytes: content.byteLength,
            sha256: sha256(content),
          };
        } finally {
          closeSync(fd);
        }
      }
      case "write-file": {
        const file = this.#resolveWorkspacePath(
          job.target.workspaceId,
          job.path,
          true,
        );
        const content = this.#decodeContent(job.contentBase64);
        const temp = `${file}.uzina-${randomUUID()}.tmp`;
        let fd: number | undefined;
        let renamed = false;
        try {
          fd = openSync(
            temp,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          );
          let offset = 0;
          while (offset < content.byteLength) {
            offset += writeSync(
              fd,
              content,
              offset,
              content.byteLength - offset,
            );
          }
          fsyncSync(fd);
          closeSync(fd);
          fd = undefined;
          this.#resolveWorkspacePath(job.target.workspaceId, job.path, true);
          renameSync(temp, file);
          renamed = true;
          const directoryFd = openSync(dirname(file), constants.O_RDONLY);
          try {
            fsyncSync(directoryFd);
          } finally {
            closeSync(directoryFd);
          }
          return {
            operation: job.operation,
            bytes: content.byteLength,
            sha256: sha256(content),
          };
        } catch (error) {
          if (renamed) throw new UncertainEffectError("write_result_uncertain");
          throw error;
        } finally {
          if (fd !== undefined) closeSync(fd);
          if (!renamed) rmSync(temp, { force: true });
        }
      }
      case "argv-command":
        return this.#runCommand(job);
    }
  }

  async #runCommand(
    job: Extract<ExecutionJob, { operation: "argv-command" }>,
  ): Promise<ExecutionResult> {
    const cwd = this.#resolveCommandCwd(job.target.workspaceId, job.cwd);
    let process: ReturnType<typeof Bun.spawn>;
    try {
      process = Bun.spawn({
        cmd: job.argv,
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: globalThis.process.platform !== "win32",
      });
    } catch {
      throw new ExecutionError("command_start_failed");
    }

    let captured = 0;
    let outputTruncated = false;
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const collect = async (
      stream: ReadableStream<Uint8Array>,
      chunks: Buffer[],
    ): Promise<Buffer> => {
      const reader = stream.getReader();
      readers.push(reader);
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          const remaining = job.maxOutputBytes - captured;
          const accepted = part.value.subarray(0, Math.max(0, remaining));
          if (accepted.byteLength) {
            chunks.push(Buffer.from(accepted));
            captured += accepted.byteLength;
          }
          if (accepted.byteLength < part.value.byteLength)
            outputTruncated = true;
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    };

    let cleanupPromise: Promise<number | undefined> | undefined;
    const cleanup = () => {
      cleanupPromise ??= terminateCommandProcessTree(process, readers).catch(
        async () => {
          await cancelCommandOutputReaders(readers);
          return undefined;
        },
      );
      return cleanupPromise;
    };

    const stdoutStream = process.stdout;
    const stderrStream = process.stderr;
    if (
      !(stdoutStream instanceof ReadableStream) ||
      !(stderrStream instanceof ReadableStream)
    ) {
      await cleanup();
      throw new UncertainEffectError("command_output_unavailable");
    }
    let timedOut = false;
    let resolveTimedOut!: (exitCode: number | undefined) => void;
    const timeoutCleanup = new Promise<number | undefined>((resolve) => {
      resolveTimedOut = resolve;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      void cleanup().then(resolveTimedOut, () => resolveTimedOut(undefined));
    }, job.timeoutMs);
    try {
      const completed = Promise.all([
        collect(stdoutStream, stdoutChunks),
        collect(stderrStream, stderrChunks),
        process.exited,
      ]).then(([stdout, stderr, exitCode]) => ({
        kind: "completed" as const,
        stdout,
        stderr,
        exitCode,
      }));
      const outcome = await Promise.race([
        completed,
        timeoutCleanup.then((exitCode) => ({
          kind: "timed-out" as const,
          exitCode,
        })),
      ]);
      if (outcome.kind === "timed-out") {
        return {
          operation: job.operation,
          exitCode: outcome.exitCode ?? null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          outputTruncated,
          timedOut: true,
        } satisfies ExecutionResult;
      }
      if (timedOut) await cleanup();
      return {
        operation: job.operation,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout.toString("utf8"),
        stderr: outcome.stderr.toString("utf8"),
        outputTruncated,
        timedOut,
      } satisfies ExecutionResult;
    } catch {
      await cleanup();
      throw new UncertainEffectError("command_output_failed_after_start");
    } finally {
      clearTimeout(timeout);
    }
  }

  #decodeContent(encoded: string): Buffer {
    const content = Buffer.from(encoded, "base64");
    if (
      content.byteLength > MAX_EXECUTION_FILE_BYTES ||
      content.toString("base64") !== encoded
    ) {
      throw new ExecutionError("invalid_file_content");
    }
    return content;
  }

  #resolveWorkspacePath(
    workspaceId: string,
    requested: string,
    allowNewFile: boolean,
  ): string {
    const root = this.#workspaceRoot(workspaceId);
    if (
      isAbsolute(requested) ||
      requested.includes("\\") ||
      requested.includes("\0")
    ) {
      throw new ExecutionError("unsafe_workspace_path");
    }
    const parts = requested.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new ExecutionError("unsafe_workspace_path");
    }
    const candidate = resolve(root, ...parts);
    if (!within(root, candidate))
      throw new ExecutionError("unsafe_workspace_path");

    let cursor = root;
    for (let i = 0; i < parts.length; i += 1) {
      cursor = resolve(cursor, parts[i]!);
      if (hasSymlink(cursor))
        throw new ExecutionError("workspace_symlink_rejected");
      if (!existsSync(cursor)) {
        if (!allowNewFile || i !== parts.length - 1) {
          throw new ExecutionError("workspace_path_not_found");
        }
        const parent = realpathSync(dirname(cursor));
        if (!within(root, parent))
          throw new ExecutionError("unsafe_workspace_path");
        return candidate;
      }
    }
    const canonical = realpathSync(candidate);
    if (!within(root, canonical))
      throw new ExecutionError("unsafe_workspace_path");
    if (allowNewFile && statSync(canonical).isDirectory()) {
      throw new ExecutionError("workspace_path_is_directory");
    }
    if (!allowNewFile && !statSync(canonical).isFile()) {
      throw new ExecutionError("workspace_path_not_file");
    }
    return canonical;
  }

  #resolveCommandCwd(workspaceId: string, requested?: string): string {
    const root = this.#workspaceRoot(workspaceId);
    if (requested === undefined || requested === ".") return root;
    if (
      isAbsolute(requested) ||
      requested.includes("\\") ||
      requested.includes("\0")
    ) {
      throw new ExecutionError("unsafe_workspace_path");
    }
    const parts = requested.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new ExecutionError("unsafe_workspace_path");
    }
    let cursor = root;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      if (hasSymlink(cursor)) {
        throw new ExecutionError("workspace_symlink_rejected");
      }
      if (!existsSync(cursor)) {
        throw new ExecutionError("workspace_path_not_found");
      }
    }
    const canonical = realpathSync(cursor);
    if (!within(root, canonical)) {
      throw new ExecutionError("unsafe_workspace_path");
    }
    if (!statSync(canonical).isDirectory()) {
      throw new ExecutionError("workspace_path_not_directory");
    }
    return canonical;
  }

  #assertCaptureControlIdentity(control: ExecutionCaptureControl): void {
    if (
      control.nodeId !== this.#nodeId ||
      control.target.nodeId !== this.#nodeId
    ) {
      throw new ExecutionError("target_node_mismatch");
    }
    const workspace = this.#workspaceRow(control.target.workspaceId);
    if (!workspace) throw new ExecutionError("workspace_not_found");
    if (workspace.ownership_generation !== control.ownershipGeneration) {
      throw new ExecutionError("stale_ownership_generation");
    }
  }

  #assertWorkspaceCapturePreflight(
    workspaceId: string,
    expectedControlId?: string,
  ): void {
    const workspace = this.#workspaceRow(workspaceId);
    if (!workspace) throw new ExecutionError("workspace_not_found");
    this.#assertActiveRow(workspace, workspace.ownership_generation);
    const physicalRoots = this.#db
      .query<Pick<WorkspaceRow, "workspace_id" | "directory">, []>(
        "SELECT workspace_id, directory FROM execution_workspaces",
      )
      .all()
      .map((mapping) => {
        try {
          return {
            workspaceId: mapping.workspace_id,
            root: realpathSync(resolve(mapping.directory)),
          };
        } catch {
          throw new ExecutionError("workspace_mapping_unavailable");
        }
      });
    const selectedRoot = physicalRoots.find(
      (mapping) => mapping.workspaceId === workspaceId,
    );
    if (!selectedRoot) throw new ExecutionError("workspace_not_found");
    if (
      physicalRoots.some(
        (mapping) =>
          mapping.workspaceId !== workspaceId &&
          (within(selectedRoot.root, mapping.root) ||
            within(mapping.root, selectedRoot.root)),
      )
    ) {
      throw new ExecutionError("workspace_mappings_overlap");
    }
    if (
      this.#db
        .query<{ status: string }, [string]>(
          "SELECT status FROM execution_jobs WHERE workspace_id = ? AND status IN ('queued', 'running', 'uncertain') LIMIT 1",
        )
        .get(workspaceId)
    ) {
      throw new ExecutionError("workspace_has_unsettled_effects");
    }
    if (this.rex.hasBlockingProcesses(workspaceId)) {
      throw new ExecutionError("workspace_has_running_rex_processes");
    }
    if (expectedControlId) {
      const fence = this.#db
        .query<{ capture_id: string; control_id: string | null }, [string]>(
          "SELECT capture_id, control_id FROM execution_workspace_captures WHERE workspace_id = ?",
        )
        .get(workspaceId);
      if (!fence || fence.control_id !== expectedControlId) {
        throw new ExecutionError("capture_control_fence_missing");
      }
    } else {
      this.#assertWorkspaceAdmission(workspaceId);
    }
  }

  #assertWorkspaceSnapshotFence(snapshot: WorkspaceSnapshotClaim): void {
    const control = this.#captureControlRowByRequest(snapshot.captureRequestId);
    const fence = this.#db
      .query<{ capture_id: string; control_id: string | null }, [string]>(
        "SELECT capture_id, control_id FROM execution_workspace_captures WHERE workspace_id = ?",
      )
      .get(snapshot.target.workspaceId);
    const workspace = this.#workspaceRow(snapshot.target.workspaceId);
    if (
      !control ||
      control.status !== "source-capture-fenced" ||
      control.capture_id !== snapshot.captureId ||
      !fence ||
      control.control_id !== fence.control_id ||
      fence.capture_id !== snapshot.captureId ||
      !fence.control_id ||
      workspace?.ownership_generation !== snapshot.ownershipGeneration
    ) {
      throw new ExecutionError("capture_control_fence_missing");
    }
    this.#assertActiveRow(workspace, snapshot.ownershipGeneration);
    this.#assertWorkspaceCapturePreflight(
      snapshot.target.workspaceId,
      fence.control_id,
    );
  }

  #assertWorkspaceSnapshotIdentity(
    snapshot: WorkspaceSnapshotClaim,
    row: WorkspaceSnapshotReceiptRow,
  ): void {
    if (
      row.request_id !== snapshot.requestId ||
      row.capture_request_id !== snapshot.captureRequestId ||
      row.capture_id !== snapshot.captureId ||
      row.node_id !== snapshot.nodeId ||
      row.workspace_id !== snapshot.target.workspaceId ||
      row.ownership_generation !== snapshot.ownershipGeneration
    ) {
      throw new ExecutionError("workspace_snapshot_id_conflict");
    }
  }

  #storeWorkspaceSnapshotReport(
    snapshot: WorkspaceSnapshotClaim,
    status: WorkspaceSnapshotReport["status"],
    errorCode?: string,
    manifestReference?: string,
  ): WorkspaceSnapshotReport {
    const existing = this.#workspaceSnapshotRow(snapshot.snapshotId);
    if (existing?.report_json) {
      return workspaceSnapshotReportSchema.parse(
        JSON.parse(existing.report_json),
      );
    }
    const report = workspaceSnapshotReportSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      snapshotId: snapshot.snapshotId,
      requestId: snapshot.requestId,
      captureRequestId: snapshot.captureRequestId,
      captureId: snapshot.captureId,
      nodeId: this.#nodeId,
      target: snapshot.target,
      ownershipGeneration: snapshot.ownershipGeneration,
      status,
      reportedAt: new Date().toISOString(),
      ...(manifestReference ? { manifestReference } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
    const reportJson = JSON.stringify(report);
    this.#transaction(() => {
      const row = this.#workspaceSnapshotRow(snapshot.snapshotId);
      if (!row)
        throw new ExecutionError("workspace_snapshot_receipt_not_found");
      this.#assertWorkspaceSnapshotIdentity(snapshot, row);
      this.#db
        .query(
          "UPDATE execution_workspace_snapshots SET status = ?, manifest_reference = COALESCE(?, manifest_reference), report_json = ?, report_sha256 = ? WHERE snapshot_id = ? AND report_json IS NULL",
        )
        .run(
          status === "workspace-checkpoint-available" ? "captured" : status,
          manifestReference ?? null,
          reportJson,
          executionPayloadSha256(report),
          snapshot.snapshotId,
        );
    });
    return report;
  }

  #reserveWorkspaceRelocation(
    claim: WorkspaceRelocationClaim,
  ): WorkspaceRelocationReceiptRow {
    const acceptedAt = new Date().toISOString();
    const workspaceRoot =
      this.#workspaces.get(claim.destination.workspaceId) ?? null;
    const cacheDirectory = workspaceRoot
      ? this.#workspaceRelocationCacheDirectory(claim.relocationId)
      : null;
    let refusal: string | undefined;
    if (
      claim.destination.nodeId !== this.#nodeId ||
      claim.source.nodeId === claim.destination.nodeId ||
      claim.source.workspaceId === claim.destination.workspaceId
    ) {
      throw new ExecutionError("workspace_relocation_node_mismatch");
    }
    if (!workspaceRoot) {
      refusal = "workspace_not_configured";
    } else {
      refusal = this.#workspaceRelocationPreflightError(
        claim,
        workspaceRoot,
        cacheDirectory!,
      );
    }
    this.#transaction(() => {
      const existing = this.#workspaceRelocationRow(claim.relocationId);
      if (existing) {
        this.#assertWorkspaceRelocationIdentity(claim, existing);
        return;
      }
      const bindingJson = JSON.stringify(claim);
      this.#db
        .query(
          `INSERT INTO execution_workspace_relocations(
            relocation_id, request_id, checkpoint_request_id, capture_request_id,
            capture_id, workspace_snapshot_request_id, snapshot_id, source_node_id,
            source_workspace_id, destination_node_id, destination_workspace_id,
            ownership_generation, manifest_reference, binding_json, binding_sha256,
            workspace_root, cache_directory, status, stage, accepted_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 'downloading', ?, ?)`,
        )
        .run(
          claim.relocationId,
          claim.requestId,
          claim.checkpointRequestId,
          claim.captureRequestId,
          claim.captureId,
          claim.workspaceSnapshotRequestId,
          claim.snapshotId,
          claim.source.nodeId,
          claim.source.workspaceId,
          claim.destination.nodeId,
          claim.destination.workspaceId,
          claim.ownershipGeneration,
          claim.manifestReference,
          bindingJson,
          executionPayloadSha256(claim),
          workspaceRoot,
          cacheDirectory,
          acceptedAt,
          acceptedAt,
        );
      this.#db
        .query(
          "UPDATE execution_workspaces SET active = 0 WHERE workspace_id = ?",
        )
        .run(claim.destination.workspaceId);
    });
    let row = this.#workspaceRelocationRow(claim.relocationId);
    if (!row) throw new ExecutionError("workspace_relocation_receipt_missing");
    if (refusal) {
      this.#storeWorkspaceRelocationReport(claim, "blocked", refusal);
      row = this.#workspaceRelocationRow(claim.relocationId);
      if (!row)
        throw new ExecutionError("workspace_relocation_receipt_missing");
    }
    return row;
  }

  #workspaceRelocationPreflightError(
    claim: WorkspaceRelocationClaim,
    workspaceRoot: string,
    cacheDirectory: string,
  ): string | undefined {
    try {
      const workspace = this.#workspaceRow(claim.destination.workspaceId);
      if (!workspace) return "workspace_not_configured";
      if (
        workspace.directory !== workspaceRoot ||
        realpathSync(workspace.directory) !== workspaceRoot ||
        lstatSync(workspaceRoot).isSymbolicLink() ||
        !lstatSync(workspaceRoot).isDirectory()
      ) {
        return "workspace_relocation_destination_path_invalid";
      }
      if (workspace.ownership_generation !== claim.ownershipGeneration) {
        return "stale_ownership_generation";
      }
      if (!workspace.active) return "workspace_fenced";
      if (readdirSync(workspaceRoot).length !== 0) {
        return "workspace_relocation_destination_not_empty";
      }
      const roots = this.#db
        .query<{ workspace_id: string; directory: string }, []>(
          "SELECT workspace_id, directory FROM execution_workspaces",
        )
        .all();
      for (const other of roots) {
        if (other.workspace_id === claim.destination.workspaceId) continue;
        const root = realpathSync(other.directory);
        if (within(root, workspaceRoot) || within(workspaceRoot, root)) {
          return "workspace_relocation_destination_overlap";
        }
      }
      if (
        this.#databasePath &&
        within(workspaceRoot, realpathSync(this.#databasePath))
      ) {
        return "workspace_relocation_database_overlap";
      }
      let cacheAncestor = resolve(this.#snapshotCacheDirectory);
      while (!existsSync(cacheAncestor)) cacheAncestor = dirname(cacheAncestor);
      const projectedCache = resolve(
        realpathSync(cacheAncestor),
        relative(cacheAncestor, resolve(cacheDirectory)),
      );
      if (
        within(workspaceRoot, projectedCache) ||
        within(projectedCache, workspaceRoot)
      ) {
        return "workspace_relocation_cache_overlap";
      }
      if (
        this.#databasePath &&
        within(projectedCache, realpathSync(this.#databasePath))
      ) {
        return "workspace_relocation_database_overlap";
      }
      if (
        this.#db
          .query<{ workspace_id: string }, [string]>(
            "SELECT workspace_id FROM execution_workspace_captures WHERE workspace_id = ?",
          )
          .get(claim.destination.workspaceId)
      ) {
        return "workspace_capture_active";
      }
      if (
        this.#db
          .query<{ job_id: string }, [string]>(
            "SELECT job_id FROM execution_jobs WHERE workspace_id = ? AND status NOT IN ('completed', 'failed') LIMIT 1",
          )
          .get(claim.destination.workspaceId)
      ) {
        return "workspace_relocation_destination_busy";
      }
      if (this.rex.hasBlockingProcesses(claim.destination.workspaceId)) {
        return "workspace_relocation_destination_busy";
      }
      return undefined;
    } catch {
      return "workspace_relocation_destination_path_invalid";
    }
  }

  async #prepareWorkspaceRelocation(
    claim: WorkspaceRelocationClaim,
    row: WorkspaceRelocationReceiptRow,
    fetchBlob: WorkspaceRelocationBlobFetcher,
  ): Promise<WorkspaceRelocationReport> {
    this.#assertWorkspaceRelocationIdentity(claim, row);
    if (
      row.status !== "preparing" ||
      row.stage !== "downloading" ||
      !row.workspace_root ||
      !row.cache_directory
    ) {
      throw new ExecutionError("workspace_relocation_not_preparing");
    }
    this.#assertWorkspaceRelocationReady(row, true);
    await this.#assertSnapshotCacheOutsideWorkspaces(row.cache_directory);
    this.#assertWorkspaceRelocationCacheDirectory(row);
    this.#assertWorkspaceRelocationCacheOutsideDatabase(row.cache_directory);
    const manifestPath = join(row.cache_directory, claim.manifestReference);
    if (existsSync(manifestPath)) {
      this.#assertRelocationCacheBlob(
        row.cache_directory,
        claim.manifestReference,
        undefined,
        PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
      );
    } else {
      this.#assertWorkspaceRelocationReady(row, true);
      const response = await fetchBlob(
        claim.relocationId,
        claim.manifestReference,
      );
      await this.#writeWorkspaceRelocationBlob(
        row.cache_directory,
        claim.manifestReference,
        response.body,
        response.size,
        PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
      );
    }
    const manifestBytes = readFileSync(manifestPath);
    let manifest: WorkspaceCheckpointManifest;
    try {
      manifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
      ) as WorkspaceCheckpointManifest;
    } catch {
      throw new ExecutionError("invalid_workspace_checkpoint_manifest");
    }
    let references: ReturnType<typeof portableWorkspaceBlobReferences>;
    try {
      references = portableWorkspaceBlobReferences(
        manifest,
        claim.manifestReference,
        manifestBytes.byteLength,
      );
    } catch {
      throw new ExecutionError("invalid_workspace_checkpoint_manifest");
    }
    const cacheTotal = references.reduce((total, reference) => {
      if (reference.size > PORTABLE_WORKSPACE_TOTAL_MAX_BYTES) {
        throw new ExecutionError("workspace_checkpoint_blob_limit");
      }
      return total + reference.size;
    }, 0);
    if (
      references.length > 200_002 ||
      cacheTotal >
        PORTABLE_WORKSPACE_TOTAL_MAX_BYTES +
          PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES
    ) {
      throw new ExecutionError("workspace_checkpoint_bounds_exceeded");
    }
    for (const reference of references) {
      if (reference.reference === claim.manifestReference) continue;
      const path = join(row.cache_directory, reference.reference);
      if (existsSync(path)) {
        this.#assertRelocationCacheBlobMetadata(
          row.cache_directory,
          reference.reference,
          reference.size,
          PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
        );
        continue;
      }
      const response = await fetchBlob(claim.relocationId, reference.reference);
      await this.#writeWorkspaceRelocationBlob(
        row.cache_directory,
        reference.reference,
        response.body,
        reference.size,
        PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
      );
    }
    const transport = new FileBlobTransport(row.cache_directory);
    const validation = await validateWorkspaceCheckpoint(manifest, transport);
    if (!validation.valid) {
      throw new ExecutionError("workspace_relocation_checkpoint_invalid");
    }
    this.#assertWorkspaceRelocationReady(row, true);
    this.#transaction(() => {
      const current = this.#workspaceRelocationRow(claim.relocationId);
      if (!current) {
        throw new ExecutionError("workspace_relocation_receipt_missing");
      }
      this.#assertWorkspaceRelocationIdentity(claim, current);
      this.#assertWorkspaceRelocationReady(current, true);
      this.#db
        .query(
          "UPDATE execution_workspace_relocations SET stage = 'restore-started', updated_at = ? WHERE relocation_id = ? AND status = 'preparing' AND stage = 'downloading'",
        )
        .run(new Date().toISOString(), claim.relocationId);
    });
    try {
      await restoreWorkspaceCheckpoint({
        manifest,
        transport,
        destinationPath: row.workspace_root,
      });
      await verifyRestoredWorkspaceCheckpoint(
        manifest,
        transport,
        row.workspace_root,
      );
      this.#assertWorkspaceRelocationReady(
        this.#workspaceRelocationRow(claim.relocationId)!,
        false,
      );
      return this.#storeWorkspaceRelocationReport(claim, "prepared-inactive");
    } catch {
      return this.#storeWorkspaceRelocationReport(
        claim,
        "uncertain",
        "workspace_relocation_restore_unverified",
      );
    }
  }

  async #reconcileStartedWorkspaceRelocation(
    claim: WorkspaceRelocationClaim,
    row: WorkspaceRelocationReceiptRow,
  ): Promise<WorkspaceRelocationReport> {
    try {
      const manifest = this.#loadWorkspaceRelocationManifest(row);
      const transport = new FileBlobTransport(row.cache_directory!);
      const validation = await validateWorkspaceCheckpoint(manifest, transport);
      if (!validation.valid) {
        throw new ExecutionError("workspace_relocation_checkpoint_invalid");
      }
      await verifyRestoredWorkspaceCheckpoint(
        manifest,
        transport,
        row.workspace_root!,
      );
      this.#assertWorkspaceRelocationReady(row, false);
      return this.#storeWorkspaceRelocationReport(claim, "prepared-inactive");
    } catch {
      return this.#storeWorkspaceRelocationReport(
        claim,
        "uncertain",
        "workspace_relocation_restore_unverified",
      );
    }
  }

  #loadWorkspaceRelocationManifest(
    row: WorkspaceRelocationReceiptRow,
  ): WorkspaceCheckpointManifest {
    if (!row.cache_directory || !row.manifest_reference) {
      throw new ExecutionError("workspace_relocation_cache_missing");
    }
    this.#assertWorkspaceRelocationCacheDirectory(row);
    const path = join(row.cache_directory, row.manifest_reference);
    this.#assertRelocationCacheBlob(
      row.cache_directory,
      row.manifest_reference,
      undefined,
      PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
    );
    let bytes: Buffer;
    let manifest: WorkspaceCheckpointManifest;
    try {
      bytes = readFileSync(path);
      manifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as WorkspaceCheckpointManifest;
    } catch {
      throw new ExecutionError("invalid_workspace_checkpoint_manifest");
    }
    let references: ReturnType<typeof portableWorkspaceBlobReferences>;
    try {
      references = portableWorkspaceBlobReferences(
        manifest,
        row.manifest_reference,
        bytes.byteLength,
      );
    } catch {
      throw new ExecutionError("invalid_workspace_checkpoint_manifest");
    }
    for (const reference of references) {
      this.#assertRelocationCacheBlobMetadata(
        row.cache_directory,
        reference.reference,
        reference.size,
        reference.reference === row.manifest_reference
          ? PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES
          : PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
      );
    }
    return manifest;
  }

  #assertRelocationCacheBlob(
    cacheDirectory: string,
    reference: string,
    expectedSize: number | undefined,
    maximumSize: number,
  ): void {
    this.#assertRelocationCacheBlobMetadata(
      cacheDirectory,
      reference,
      expectedSize,
      maximumSize,
    );
    const path = join(cacheDirectory, reference);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const info = fstatSync(descriptor);
      if (
        !info.isFile() ||
        info.size > maximumSize ||
        (expectedSize !== undefined && info.size !== expectedSize) ||
        (info.mode & 0o077) !== 0
      ) {
        throw new ExecutionError("workspace_relocation_cache_file_invalid");
      }
      const hasher = createHash("sha256");
      const chunk = Buffer.alloc(64 * 1024);
      const size = info.size;
      let offset = 0;
      while (offset < size) {
        const length = readSync(
          descriptor,
          chunk,
          0,
          Math.min(chunk.byteLength, size - offset),
          offset,
        );
        if (length === 0) {
          throw new ExecutionError("workspace_relocation_cache_truncated");
        }
        hasher.update(chunk.subarray(0, length));
        offset += length;
      }
      if (hasher.digest("hex") !== reference) {
        throw new ExecutionError("workspace_relocation_cache_hash_mismatch");
      }
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError("workspace_relocation_cache_unavailable");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  #assertRelocationCacheBlobMetadata(
    cacheDirectory: string,
    reference: string,
    expectedSize: number | undefined,
    maximumSize: number,
  ): void {
    const path = join(cacheDirectory, reference);
    try {
      const info = lstatSync(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0
      ) {
        throw new ExecutionError("workspace_relocation_cache_file_invalid");
      }
      if (
        info.size > maximumSize ||
        (expectedSize !== undefined && info.size !== expectedSize)
      ) {
        throw new ExecutionError("workspace_relocation_cache_size_mismatch");
      }
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError("workspace_relocation_cache_unavailable");
    }
  }

  async #writeWorkspaceRelocationBlob(
    cacheDirectory: string,
    reference: string,
    body: ReadableStream<Uint8Array>,
    expectedSize: number,
    maximumSize: number,
  ): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(reference) ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > maximumSize
    ) {
      throw new ExecutionError("workspace_relocation_blob_metadata_invalid");
    }
    const destination = join(cacheDirectory, reference);
    if (existsSync(destination)) {
      this.#assertRelocationCacheBlob(
        cacheDirectory,
        reference,
        expectedSize,
        maximumSize,
      );
      return;
    }
    const temporary = join(
      cacheDirectory,
      `.${reference}.${randomUUID()}.part`,
    );
    let descriptor: number | undefined;
    const reader = body.getReader();
    let bytes = 0;
    const hasher = createHash("sha256");
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      while (true) {
        // A rejected network stream leaves the durable claim at the download stage.
        // The connector wraps stream failures as retryable transport errors.
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) {
          throw new ExecutionError("workspace_relocation_blob_invalid");
        }
        bytes += part.value.byteLength;
        if (bytes > maximumSize || bytes > expectedSize) {
          void reader.cancel().catch(() => {});
          throw new ExecutionError("workspace_relocation_blob_size_mismatch");
        }
        hasher.update(part.value);
        let offset = 0;
        while (offset < part.value.byteLength) {
          offset += writeSync(
            descriptor,
            part.value,
            offset,
            part.value.byteLength - offset,
          );
        }
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      if (bytes !== expectedSize || hasher.digest("hex") !== reference) {
        throw new ExecutionError("workspace_relocation_blob_integrity_failed");
      }
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.#assertRelocationCacheBlob(
          cacheDirectory,
          reference,
          expectedSize,
          maximumSize,
        );
      }
      unlinkSync(temporary);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
      if (error instanceof ExecutionError) throw error;
      if (error instanceof Error && error.name === "ControllerTransportError") {
        throw error;
      }
      throw new ExecutionError("workspace_relocation_cache_write_failed");
    } finally {
      reader.releaseLock();
    }
  }

  #workspaceRelocationCacheDirectory(relocationId: string): string {
    return join(
      this.#snapshotCacheDirectory,
      "workspace-relocations",
      sha256(relocationId),
    );
  }

  #assertWorkspaceRelocationCacheDirectory(
    row: WorkspaceRelocationReceiptRow,
  ): void {
    if (!row.cache_directory) {
      throw new ExecutionError("workspace_relocation_cache_missing");
    }
    try {
      const root = resolve(this.#snapshotCacheDirectory);
      const namespace = dirname(row.cache_directory);
      const leaf = resolve(row.cache_directory);
      if (
        leaf !== this.#workspaceRelocationCacheDirectory(row.relocation_id) ||
        !within(root, leaf) ||
        leaf === root
      ) {
        throw new ExecutionError("workspace_relocation_cache_path_invalid");
      }
      const rootInfo = lstatSync(root);
      const namespaceInfo = lstatSync(namespace);
      const leafInfo = lstatSync(leaf);
      if (
        !rootInfo.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        !namespaceInfo.isDirectory() ||
        namespaceInfo.isSymbolicLink() ||
        !leafInfo.isDirectory() ||
        leafInfo.isSymbolicLink() ||
        [rootInfo, namespaceInfo, leafInfo].some(
          (info) => (info.mode & 0o077) !== 0,
        ) ||
        !within(realpathSync(root), realpathSync(leaf))
      ) {
        throw new ExecutionError(
          "workspace_relocation_cache_permissions_unsafe",
        );
      }
      this.#assertWorkspaceRelocationCacheOutsideDatabase(leaf);
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError("workspace_relocation_cache_unavailable");
    }
  }

  #assertWorkspaceRelocationCacheOutsideDatabase(cacheDirectory: string): void {
    if (!this.#databasePath) return;
    const databasePath = realpathSync(this.#databasePath);
    let cacheAncestor = resolve(cacheDirectory);
    while (!existsSync(cacheAncestor)) cacheAncestor = dirname(cacheAncestor);
    const projectedCache = resolve(
      realpathSync(cacheAncestor),
      relative(cacheAncestor, resolve(cacheDirectory)),
    );
    if (within(projectedCache, databasePath)) {
      throw new ExecutionError("workspace_relocation_database_overlap");
    }
  }

  #assertWorkspaceRelocationReady(
    row: WorkspaceRelocationReceiptRow,
    requireEmpty: boolean,
  ): void {
    if (!row.workspace_root || !row.cache_directory) {
      throw new ExecutionError("workspace_relocation_destination_unconfigured");
    }
    if (
      this.#workspaces.get(row.destination_workspace_id) !== row.workspace_root
    ) {
      throw new ExecutionError("workspace_relocation_destination_changed");
    }
    if (
      resolve(row.cache_directory) !==
      this.#workspaceRelocationCacheDirectory(row.relocation_id)
    ) {
      throw new ExecutionError("workspace_relocation_cache_path_invalid");
    }
    const workspace = this.#workspaceRow(row.destination_workspace_id);
    if (
      !workspace ||
      workspace.directory !== row.workspace_root ||
      workspace.ownership_generation !== row.ownership_generation ||
      workspace.active !== 0
    ) {
      throw new ExecutionError("workspace_relocation_destination_fence_lost");
    }
    let info;
    try {
      info = lstatSync(row.workspace_root);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        realpathSync(row.workspace_root) !== row.workspace_root
      ) {
        throw new ExecutionError(
          "workspace_relocation_destination_path_invalid",
        );
      }
      if (requireEmpty && readdirSync(row.workspace_root).length !== 0) {
        throw new ExecutionError("workspace_relocation_destination_changed");
      }
      const roots = this.#db
        .query<{ workspace_id: string; directory: string }, []>(
          "SELECT workspace_id, directory FROM execution_workspaces",
        )
        .all();
      for (const other of roots) {
        if (other.workspace_id === row.destination_workspace_id) continue;
        const root = realpathSync(other.directory);
        if (
          within(root, row.workspace_root) ||
          within(row.workspace_root, root)
        ) {
          throw new ExecutionError("workspace_relocation_destination_overlap");
        }
      }
      let cacheAncestor = resolve(this.#snapshotCacheDirectory);
      while (!existsSync(cacheAncestor)) cacheAncestor = dirname(cacheAncestor);
      const projectedCache = resolve(
        realpathSync(cacheAncestor),
        relative(cacheAncestor, resolve(row.cache_directory)),
      );
      if (
        within(row.workspace_root, projectedCache) ||
        within(projectedCache, row.workspace_root)
      ) {
        throw new ExecutionError("workspace_relocation_cache_overlap");
      }
      if (
        this.#databasePath &&
        within(row.workspace_root, realpathSync(this.#databasePath))
      ) {
        throw new ExecutionError("workspace_relocation_database_overlap");
      }
      if (
        this.#db
          .query<{ workspace_id: string }, [string]>(
            "SELECT workspace_id FROM execution_workspace_captures WHERE workspace_id = ?",
          )
          .get(row.destination_workspace_id)
      ) {
        throw new ExecutionError("workspace_capture_active");
      }
      if (
        this.#db
          .query<{ job_id: string }, [string]>(
            "SELECT job_id FROM execution_jobs WHERE workspace_id = ? AND status NOT IN ('completed', 'failed') LIMIT 1",
          )
          .get(row.destination_workspace_id)
      ) {
        throw new ExecutionError("workspace_relocation_destination_busy");
      }
      if (this.rex.hasBlockingProcesses(row.destination_workspace_id)) {
        throw new ExecutionError("workspace_relocation_destination_busy");
      }
      this.#assertWorkspaceRelocationCacheOutsideDatabase(row.cache_directory);
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError("workspace_relocation_destination_path_invalid");
    }
  }

  #relocationWorkspaceIsEmpty(row: WorkspaceRelocationReceiptRow): boolean {
    try {
      this.#assertWorkspaceRelocationReady(row, true);
      return true;
    } catch {
      return false;
    }
  }

  #storeWorkspaceRelocationReport(
    claim: WorkspaceRelocationClaim,
    status: WorkspaceRelocationReport["status"],
    code?: string,
  ): WorkspaceRelocationReport {
    return this.#transaction(() => {
      const row = this.#workspaceRelocationRow(claim.relocationId);
      if (!row) {
        throw new ExecutionError("workspace_relocation_receipt_not_found");
      }
      this.#assertWorkspaceRelocationIdentity(claim, row);
      if (row.report_json && row.status !== "prepared-inactive") {
        return workspaceRelocationReportSchema.parse(
          JSON.parse(row.report_json),
        );
      }
      if (row.report_json && status !== "uncertain") {
        return workspaceRelocationReportSchema.parse(
          JSON.parse(row.report_json),
        );
      }
      const now = new Date().toISOString();
      const receipt = {
        relocationId: claim.relocationId,
        requestId: claim.requestId,
        bindingSha256: row.binding_sha256,
        destinationNodeId: claim.destination.nodeId,
        destinationWorkspaceId: claim.destination.workspaceId,
        workspaceRoot: row.workspace_root,
        cacheDirectory: row.cache_directory,
        manifestReference: claim.manifestReference,
        status,
        reportedAt: now,
        ...(row.receipt_sha256
          ? { previousReceiptSha256: row.receipt_sha256 }
          : {}),
        ...(code ? { errorCode: code } : {}),
      };
      const receiptJson = JSON.stringify(receipt);
      const receiptSha256 = executionPayloadSha256(receipt);
      const report = workspaceRelocationReportSchema.parse({
        ...claim,
        status,
        receiptSha256,
        reportedAt: now,
        ...(status === "uncertain" && row.status === "prepared-inactive"
          ? { previousReceiptSha256: row.receipt_sha256! }
          : {}),
        ...(code ? { errorCode: code } : {}),
      });
      const reportJson = JSON.stringify(report);
      this.#db
        .query(
          `UPDATE execution_workspace_relocations SET
            status = ?, stage = 'terminal', receipt_json = ?, receipt_sha256 = ?,
            previous_receipt_json = CASE WHEN ? = 'uncertain' AND status = 'prepared-inactive' THEN receipt_json ELSE previous_receipt_json END,
            previous_receipt_sha256 = CASE WHEN ? = 'uncertain' AND status = 'prepared-inactive' THEN receipt_sha256 ELSE previous_receipt_sha256 END,
            report_json = ?, report_sha256 = ?, reported_at = NULL, updated_at = ?, error_code = ?
          WHERE relocation_id = ?`,
        )
        .run(
          status,
          receiptJson,
          receiptSha256,
          status,
          status,
          reportJson,
          executionPayloadSha256(report),
          now,
          code ?? null,
          claim.relocationId,
        );
      return report;
    });
  }

  #assertWorkspaceRelocationIdentity(
    claim: WorkspaceRelocationClaim,
    row: WorkspaceRelocationReceiptRow,
  ): void {
    if (
      row.binding_sha256 !== executionPayloadSha256(claim) ||
      row.relocation_id !== claim.relocationId ||
      row.request_id !== claim.requestId ||
      row.snapshot_id !== claim.snapshotId ||
      row.destination_node_id !== claim.destination.nodeId ||
      row.destination_workspace_id !== claim.destination.workspaceId ||
      row.manifest_reference !== claim.manifestReference
    ) {
      throw new ExecutionError("workspace_relocation_identity_conflict");
    }
  }

  #workspaceRelocationRow(
    relocationId: string,
  ): WorkspaceRelocationReceiptRow | undefined {
    return (
      this.#db
        .query<WorkspaceRelocationReceiptRow, [string]>(
          "SELECT * FROM execution_workspace_relocations WHERE relocation_id = ?",
        )
        .get(relocationId) ?? undefined
    );
  }

  async #assertSnapshotCacheOutsideWorkspaces(
    captureCacheDirectory: string,
  ): Promise<void> {
    const roots = this.#db
      .query<{ directory: string }, []>(
        "SELECT directory FROM execution_workspaces",
      )
      .all()
      .map((row) => realpathSync(resolve(row.directory)));
    const candidate = resolve(this.#snapshotCacheDirectory);
    let existingAncestor = candidate;
    while (!existsSync(existingAncestor))
      existingAncestor = dirname(existingAncestor);
    const physicalAncestor = realpathSync(existingAncestor);
    const projected = resolve(
      physicalAncestor,
      relative(existingAncestor, candidate),
    );
    if (
      roots.some((root) => within(root, projected) || within(projected, root))
    ) {
      throw new ExecutionError("snapshot_cache_workspace_overlap");
    }
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    const cacheStat = lstatSync(candidate);
    if (
      !cacheStat.isDirectory() ||
      cacheStat.isSymbolicLink() ||
      (cacheStat.mode & 0o077) !== 0
    ) {
      throw new ExecutionError("snapshot_cache_permissions_unsafe");
    }
    const cacheRoot = realpathSync(candidate);
    if (
      roots.some((root) => within(root, cacheRoot) || within(cacheRoot, root))
    ) {
      throw new ExecutionError("snapshot_cache_workspace_overlap");
    }
    const captureCache = resolve(captureCacheDirectory);
    if (captureCache === candidate || !within(candidate, captureCache)) {
      throw new ExecutionError("snapshot_cache_namespace_invalid");
    }
    mkdirSync(captureCache, { recursive: true, mode: 0o700 });
    const captureStat = lstatSync(captureCache);
    const canonicalCaptureCache = realpathSync(captureCache);
    if (
      !captureStat.isDirectory() ||
      captureStat.isSymbolicLink() ||
      (captureStat.mode & 0o077) !== 0 ||
      !within(cacheRoot, canonicalCaptureCache)
    ) {
      throw new ExecutionError("snapshot_cache_namespace_invalid");
    }
  }

  #assertSnapshotManifestReferences(
    manifest: WorkspaceCheckpointManifest,
    manifestReference: string,
  ): void {
    if (
      manifest.format !== "uzina-workspace-checkpoint" ||
      manifest.version !== 1 ||
      !Array.isArray(manifest.workspace?.entries) ||
      manifest.workspace.entries.length > 100_000 ||
      !Array.isArray(manifest.workspace?.omissions) ||
      manifest.workspace.omissions.length > 10_000
    ) {
      throw new ExecutionError("invalid_workspace_checkpoint_manifest");
    }
    const references = this.#snapshotBlobReferences(
      manifest,
      manifestReference,
    );
    if (references.length > 200_002) {
      throw new ExecutionError("workspace_checkpoint_reference_limit");
    }
  }

  #snapshotBlobReferences(
    manifest: WorkspaceCheckpointManifest,
    manifestReference: string,
  ): string[] {
    const references = new Map<string, number>();
    const add = (reference: string, size: number) => {
      if (
        !/^[a-f0-9]{64}$/.test(reference) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 512 * 1024 * 1024
      ) {
        throw new ExecutionError("invalid_workspace_checkpoint_reference");
      }
      const previous = references.get(reference);
      if (previous !== undefined && previous !== size) {
        throw new ExecutionError("workspace_checkpoint_reference_conflict");
      }
      references.set(reference, size);
    };
    add(manifest.git.bundle.reference, manifest.git.bundle.size);
    add(manifest.git.stagedPatch.reference, manifest.git.stagedPatch.size);
    let aggregate = manifest.git.bundle.size + manifest.git.stagedPatch.size;
    for (const entry of manifest.workspace.entries) {
      if (entry.size > 64 * 1024 * 1024) {
        throw new ExecutionError("workspace_checkpoint_file_limit");
      }
      add(entry.sha256, entry.size);
      aggregate += entry.size;
    }
    if (manifest.runtimeArtifact) {
      add(
        manifest.runtimeArtifact.artifact.reference,
        manifest.runtimeArtifact.artifact.size,
      );
      aggregate += manifest.runtimeArtifact.artifact.size;
    }
    for (const attachment of manifest.attachments) {
      add(attachment.blob.reference, attachment.blob.size);
      aggregate += attachment.blob.size;
    }
    if (
      aggregate > 512 * 1024 * 1024 ||
      manifest.workspace.entries.length > 100_000 ||
      manifest.workspace.omissions.length > 10_000
    ) {
      throw new ExecutionError("workspace_checkpoint_bounds_exceeded");
    }
    add(manifestReference, 0);
    return [...references.keys()].sort();
  }

  #workspaceSnapshotRow(
    snapshotId: string,
  ): WorkspaceSnapshotReceiptRow | undefined {
    return (
      this.#db
        .query<WorkspaceSnapshotReceiptRow, [string]>(
          "SELECT * FROM execution_workspace_snapshots WHERE snapshot_id = ?",
        )
        .get(snapshotId) ?? undefined
    );
  }

  #captureControlRowByRequest(
    requestId: string,
  ): (CaptureControlRow & { control_id: string }) | undefined {
    return (
      this.#db
        .query<CaptureControlRow & { control_id: string }, [string]>(
          "SELECT * FROM execution_capture_controls WHERE request_id = ?",
        )
        .get(requestId) ?? undefined
    );
  }

  #captureControlRow(controlId: string): CaptureControlRow | undefined {
    return (
      this.#db
        .query<CaptureControlRow, [string]>(
          "SELECT * FROM execution_capture_controls WHERE control_id = ?",
        )
        .get(controlId) ?? undefined
    );
  }

  #workspaceRoot(workspaceId: string): string {
    const root = this.#workspaces.get(workspaceId);
    if (!root) throw new ExecutionError("workspace_not_configured");
    return root;
  }

  #workspaceRow(workspaceId: string): WorkspaceRow | undefined {
    return (
      this.#db
        .query<WorkspaceRow, [string]>(
          "SELECT workspace_id, directory, ownership_generation, active FROM execution_workspaces WHERE workspace_id = ?",
        )
        .get(workspaceId) ?? undefined
    );
  }

  #assertWorkspaceAdmission(workspaceId: string): void {
    if (
      this.#db
        .query<{ capture_id: string }, [string]>(
          "SELECT capture_id FROM execution_workspace_captures WHERE workspace_id = ?",
        )
        .get(workspaceId)
    ) {
      throw new ExecutionError("workspace_capture_active");
    }
    if (
      this.#db
        .query<{ relocation_id: string }, [string]>(
          "SELECT relocation_id FROM execution_workspace_relocations WHERE destination_workspace_id = ? LIMIT 1",
        )
        .get(workspaceId)
    ) {
      throw new ExecutionError("workspace_relocation_reserved");
    }
    const workspace = this.#workspaceRow(workspaceId);
    if (!workspace) return;
    const workspaceRoots = new Set([
      resolve(workspace.directory),
      ...(this.#workspaces.has(workspaceId)
        ? [this.#workspaces.get(workspaceId)!]
        : []),
    ]);
    try {
      workspaceRoots.add(realpathSync(workspace.directory));
    } catch {
      // A missing ordinary workspace is rejected later by its filesystem effect.
    }
    const reservedRoots = this.#db
      .query<{ workspace_root: string }, []>(
        "SELECT workspace_root FROM execution_workspace_relocations WHERE workspace_root IS NOT NULL",
      )
      .all();
    for (const reservation of reservedRoots) {
      const roots = new Set([resolve(reservation.workspace_root)]);
      try {
        roots.add(realpathSync(reservation.workspace_root));
      } catch (error) {
        const errorCode =
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        if (errorCode !== "ENOENT") {
          throw new ExecutionError("workspace_relocation_destination_changed");
        }
        // Keep the durable path in the comparison if it was removed.
      }
      for (const workspaceRoot of workspaceRoots) {
        for (const reservedRoot of roots) {
          if (
            within(workspaceRoot, reservedRoot) ||
            within(reservedRoot, workspaceRoot)
          ) {
            throw new ExecutionError("workspace_relocation_reserved");
          }
        }
      }
    }
  }

  #assertWorkspaceActive(workspaceId: string, generation: number): void {
    this.#assertActiveRow(this.#workspaceRow(workspaceId), generation);
  }

  #assertActiveRow(
    row: WorkspaceRow | undefined,
    generation: number,
  ): asserts row is WorkspaceRow {
    if (!row) throw new ExecutionError("workspace_not_found");
    if (row.ownership_generation !== generation) {
      throw new ExecutionError("stale_ownership_generation");
    }
    if (!row.active) throw new ExecutionError("workspace_fenced");
  }

  #workspaceReports(): ExecutionWorkspaceReport[] {
    return [...this.#workspaces.keys()].map((workspaceId) => {
      const row = this.#workspaceRow(workspaceId)!;
      return executionWorkspaceReportSchema.parse({
        workspaceId,
        ownershipGeneration: row.ownership_generation,
        state: row.active ? "active" : "fenced",
      });
    });
  }

  #jobRow(jobId: string): JobRow | undefined {
    return (
      this.#db
        .query<JobRow, [string]>(
          "SELECT * FROM execution_jobs WHERE job_id = ?",
        )
        .get(jobId) ?? undefined
    );
  }

  #receipt(row: JobRow): ExecutionReceipt {
    return executionReceiptSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      jobId: row.job_id,
      nodeId: row.node_id,
      target: { nodeId: row.node_id, workspaceId: row.workspace_id },
      ownershipGeneration: row.ownership_generation,
      operation: row.operation,
      payloadSha256: row.payload_sha256,
      status: row.status,
      acceptedAt: row.accepted_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      errorCode: row.error_code ?? undefined,
      reconciliationEvidence: row.reconciliation_evidence ?? undefined,
    });
  }

  #finishJob(
    jobId: string,
    status: "completed" | "failed" | "uncertain",
    result?: ExecutionResult,
    code?: string,
  ): ExecutionReceipt {
    return this.#transaction(() => {
      this.#db
        .query(
          `UPDATE execution_jobs SET status = ?, finished_at = ?, result_json = ?, error_code = ?
            WHERE job_id = ? AND status = 'running'`,
        )
        .run(
          status,
          new Date().toISOString(),
          result ? JSON.stringify(result) : null,
          code ?? null,
          jobId,
        );
      const row = this.#jobRow(jobId);
      if (!row) throw new ExecutionError("job_receipt_missing");
      return this.#receipt(row);
    });
  }

  #bindMetadata(key: string, value: string): void {
    const existing = this.#db
      .query<{ value: string }, [string]>(
        "SELECT value FROM execution_metadata WHERE key = ?",
      )
      .get(key);
    if (existing && existing.value !== value) {
      throw new ExecutionError(
        key === "node_id"
          ? "node_identity_conflict"
          : "node_credential_conflict",
      );
    }
    if (!existing) {
      this.#db
        .query("INSERT INTO execution_metadata(key, value) VALUES (?, ?)")
        .run(key, value);
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new ExecutionError("daemon_closed");
  }
}

class UncertainEffectError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "UncertainEffectError";
    Object.assign(this, { code });
  }
}
