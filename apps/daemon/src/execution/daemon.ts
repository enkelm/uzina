import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import {
  EXECUTION_CONTRACT_VERSION,
  MAX_EXECUTION_COMMAND_OUTPUT_BYTES,
  MAX_EXECUTION_COMMAND_TIMEOUT_MS,
  MAX_EXECUTION_FILE_BYTES,
  executionCapabilitiesSchema,
  executionHeartbeatRequestSchema,
  executionJobReportSchema,
  executionJobSchema,
  executionReceiptSchema,
  executionRegisterRequestSchema,
  executionNodeIdSchema,
  executionWorkspaceIdSchema,
  executionWorkspaceReportSchema,
  type ExecutionCapabilities,
  type ExecutionHeartbeatRequest,
  type ExecutionJob,
  type ExecutionJobReport,
  type ExecutionReceipt,
  type ExecutionRegisterRequest,
  type ExecutionResult,
  type ExecutionWorkspaceReport,
} from "../../../../packages/contracts/src/execution";
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
}

interface WorkspaceRow {
  workspace_id: string;
  directory: string;
  ownership_generation: number;
  active: number;
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
  readonly #workspaces = new Map<string, string>();
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
    this.#db = new Database(options.databasePath);
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
      this.#preflightJob(job);
      const acceptedAt = new Date().toISOString();
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
      const code = errorCode(error);
      const status =
        error instanceof UncertainEffectError ? "uncertain" : "failed";
      return this.#finishJob(job.jobId, status, undefined, code);
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

  fenceWorkspace(
    workspaceId: string,
    expectedGeneration: number,
    nextGeneration: number,
  ): ExecutionWorkspaceReport {
    this.#assertOpen();
    return this.#transaction(() => {
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
    const cwd = this.#workspaceRoot(job.target.workspaceId);
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
