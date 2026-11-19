import { Database } from "bun:sqlite";
import { stripVTControlCharacters } from "node:util";
import {
  EXECUTION_CONTRACT_VERSION,
  executionRexInspectionSchema,
  executionRexLaunchRequestSchema,
  executionRexProcessReceiptSchema,
  type ExecutionRexInspection,
  type ExecutionRexProcessReceipt,
} from "../../../../packages/contracts/src/execution";
import { ExecutionError } from "./errors";
import { executionPayloadSha256 } from "./payload";

interface RexProcessRow {
  process_id: string;
  payload_sha256: string;
  node_id: string;
  workspace_id: string;
  ownership_generation: number;
  status: ExecutionRexProcessReceipt["status"];
  launched_at: string;
  updated_at: string;
  session_id: string | null;
  block_id: string | null;
  exit_code: number | null;
  error_code: string | null;
  reconciliation_evidence: string | null;
}

interface RexManagerOptions {
  database: Database;
  nodeId: string;
  executable: string;
  /** Explicit local tool hosts pin the endpoint instead of following ambient selection. */
  server?: string;
  resolveWorkspace(workspaceId: string): string;
  assertWorkspaceActive(workspaceId: string, generation: number): void;
  assertWorkspaceAdmission?(workspaceId: string): void;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof RexCliError) return error.code;
  return "rex_operation_failed";
}

class RexCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RexCliError";
  }
}

export class RexProcessManager {
  readonly #db: Database;
  readonly #nodeId: string;
  readonly #executable: string;
  readonly #server: string | undefined;
  readonly #resolveWorkspace: RexManagerOptions["resolveWorkspace"];
  readonly #assertWorkspaceActive: RexManagerOptions["assertWorkspaceActive"];
  readonly #assertWorkspaceAdmission:
    | RexManagerOptions["assertWorkspaceAdmission"]
    | undefined;

  constructor(options: RexManagerOptions) {
    this.#db = options.database;
    this.#nodeId = options.nodeId;
    this.#executable = options.executable;
    this.#server = options.server;
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#assertWorkspaceActive = options.assertWorkspaceActive;
    this.#assertWorkspaceAdmission = options.assertWorkspaceAdmission;
    this.#db.exec(`
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
    this.#db
      .query(
        "UPDATE execution_rex_processes SET status = 'uncertain', updated_at = ?, error_code = 'interrupted_during_lifecycle' WHERE status IN ('starting', 'stopping')",
      )
      .run(new Date().toISOString());
  }

  getReceipt(processId: string): ExecutionRexProcessReceipt {
    const row = this.#row(processId);
    if (!row) throw new ExecutionError("rex_process_not_found");
    return this.#receipt(row);
  }

  async connection(): Promise<{ endpoint: string; instanceId: string }> {
    const response = await this.#runJson(["whoami", "--json"]);
    if (
      typeof response.endpoint !== "string" ||
      typeof response.instance_id !== "string" ||
      !response.instance_id
    ) {
      throw new RexCliError("invalid_rex_identity");
    }
    return { endpoint: response.endpoint, instanceId: response.instance_id };
  }

  async capture(
    processId: string,
    options: { tailLines: number; maxBytes: number },
  ): Promise<{ kind: "terminal_snapshot"; text: string; truncated: boolean }> {
    if (
      !Number.isInteger(options.tailLines) ||
      options.tailLines < 1 ||
      options.tailLines > 500 ||
      !Number.isInteger(options.maxBytes) ||
      options.maxBytes < 256 ||
      options.maxBytes > 65_536
    ) {
      throw new ExecutionError("invalid_rex_output_limit");
    }
    const row = this.#row(processId);
    if (!row) throw new ExecutionError("rex_process_not_found");
    if (!row.session_id || !row.block_id) {
      throw new ExecutionError("rex_process_identity_uncertain");
    }
    this.#assertWorkspaceActive(row.workspace_id, row.ownership_generation);
    const result = await this.#run(
      [
        "capture",
        "--session",
        row.session_id,
        "--block",
        row.block_id,
        "--trim",
        "--unwrap",
      ],
      true,
      options.maxBytes,
    );
    if (result.exitCode !== 0) throw new RexCliError("rex_cli_failed");
    const text = stripVTControlCharacters(result.stdout)
      // Terminal controls must not be replayed by MCP clients.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/\n$/, "");
    const lines = text.split("\n");
    return {
      kind: "terminal_snapshot",
      text: lines.slice(-options.tailLines).join("\n"),
      truncated: result.truncated || lines.length > options.tailLines,
    };
  }

  async launch(input: unknown): Promise<ExecutionRexProcessReceipt> {
    const parsed = executionRexLaunchRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new ExecutionError("invalid_rex_process_request");
    const request = parsed.data;
    if (
      request.nodeId !== this.#nodeId ||
      request.target.nodeId !== this.#nodeId
    ) {
      throw new ExecutionError("target_node_mismatch");
    }
    const directory = this.#resolveWorkspace(request.target.workspaceId);
    const payloadSha256 = executionPayloadSha256(request);

    const current = this.#transaction(() => {
      const existing = this.#row(request.processId);
      if (existing) {
        if (existing.payload_sha256 !== payloadSha256) {
          throw new ExecutionError("process_id_payload_conflict");
        }
        return { receipt: this.#receipt(existing), launch: false };
      }
      this.#assertWorkspaceActive(
        request.target.workspaceId,
        request.ownershipGeneration,
      );
      this.#assertWorkspaceAdmission?.(request.target.workspaceId);
      const now = new Date().toISOString();
      this.#db
        .query(
          `INSERT INTO execution_rex_processes(
            process_id, payload_sha256, node_id, workspace_id, ownership_generation,
            status, launched_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'starting', ?, ?)`,
        )
        .run(
          request.processId,
          payloadSha256,
          this.#nodeId,
          request.target.workspaceId,
          request.ownershipGeneration,
          now,
          now,
        );
      return {
        receipt: this.#receipt(this.#row(request.processId)!),
        launch: true,
      };
    });
    // Only the admission that inserted the intent may send it to Rex. A retry
    // observing 'starting' must not create a second external process.
    if (!current.launch) return current.receipt;

    try {
      const label = `uzina-${request.processId}`;
      const response = await this.#runJson([
        "new",
        label,
        "--cwd",
        directory,
        "--shell=none",
        "--keep-open",
        "--json",
        "--",
        ...request.argv,
      ]);
      const sessionId = response.session_id;
      const blockId = response.initial_windows[0]?.block_ids[0];
      if (!sessionId || !blockId)
        throw new RexCliError("invalid_rex_create_response");
      return this.#transaction(() => {
        const row = this.#row(request.processId);
        if (!row || row.status !== "starting") {
          throw new ExecutionError("rex_process_state_changed");
        }
        this.#db
          .query(
            `UPDATE execution_rex_processes SET status = 'running', session_id = ?, block_id = ?,
              updated_at = ?, error_code = NULL WHERE process_id = ? AND status = 'starting'`,
          )
          .run(sessionId, blockId, new Date().toISOString(), request.processId);
        return this.#receipt(this.#row(request.processId)!);
      });
    } catch (error) {
      return this.#update(request.processId, {
        status: "uncertain",
        errorCode: safeErrorCode(error),
      });
    }
  }

  async inspect(processId: string): Promise<ExecutionRexInspection> {
    const row = this.#row(processId);
    if (!row) throw new ExecutionError("rex_process_not_found");
    // Terminal evidence survives closing its presentation. Raw CLI changes do
    // not turn a completed job back into an observation of some later child.
    if (row.status === "exited") {
      return executionRexInspectionSchema.parse({
        contractVersion: EXECUTION_CONTRACT_VERSION,
        processId,
        status: "exited",
        exitCode: row.exit_code,
      });
    }
    if (!row.session_id || !row.block_id || row.status === "uncertain") {
      return executionRexInspectionSchema.parse({
        contractVersion: EXECUTION_CONTRACT_VERSION,
        processId,
        status: "uncertain",
      });
    }
    try {
      // Rex's structured process method is authoritative here; terminal text is never read.
      await this.#runJson(["session", "inspect", row.session_id, "--json"]);
      const process = await this.#runJson([
        "block",
        "call",
        "--session",
        row.session_id,
        "--block",
        row.block_id,
        "process",
      ]);
      // Newer Rex omits child after exit and returns a structured last_exit.
      // Running evidence wins over any retained exit from an earlier child.
      const lastExit = process.last_exit;
      const structuredExit =
        lastExit &&
        typeof lastExit === "object" &&
        !Array.isArray(lastExit) &&
        (typeof lastExit.exit_code === "number" || lastExit.exit_code === null);
      const running =
        typeof process.running === "boolean"
          ? process.running
          : process.child === null
            ? false
            : process.child &&
                typeof process.child === "object" &&
                !Array.isArray(process.child)
              ? true
              : process.child === undefined &&
                  (structuredExit || typeof lastExit === "number")
                ? false
                : undefined;
      if (typeof running !== "boolean") {
        throw new RexCliError("invalid_rex_process_state");
      }
      const exitCode = structuredExit
        ? lastExit.exit_code
        : typeof lastExit === "number" || lastExit === null
          ? lastExit
          : undefined;
      const status = running ? "running" : "exited";
      this.#update(processId, {
        status,
        exitCode,
        errorCode: undefined,
      });
      return executionRexInspectionSchema.parse({
        contractVersion: EXECUTION_CONTRACT_VERSION,
        processId,
        status,
        exitCode,
      });
    } catch (error) {
      this.#update(processId, {
        status: "uncertain",
        errorCode: safeErrorCode(error),
      });
      return executionRexInspectionSchema.parse({
        contractVersion: EXECUTION_CONTRACT_VERSION,
        processId,
        status: "uncertain",
      });
    }
  }

  async stop(processId: string): Promise<ExecutionRexInspection> {
    const row = this.#row(processId);
    if (!row) throw new ExecutionError("rex_process_not_found");
    if (!row.session_id || !row.block_id) {
      throw new ExecutionError("rex_process_identity_uncertain");
    }
    if (row.status === "exited") {
      return executionRexInspectionSchema.parse({
        contractVersion: EXECUTION_CONTRACT_VERSION,
        processId,
        status: "exited",
        exitCode: row.exit_code,
      });
    }
    this.#assertWorkspaceActive(row.workspace_id, row.ownership_generation);
    this.#update(processId, { status: "stopping", errorCode: undefined });
    try {
      // Rex's successful exact-session kill command is its lifecycle acknowledgement.
      await this.#runExit(["kill", row.session_id]);
      this.#update(processId, { status: "exited", exitCode: null });
      return executionRexInspectionSchema.parse({
        contractVersion: EXECUTION_CONTRACT_VERSION,
        processId,
        status: "exited",
        exitCode: null,
      });
    } catch {
      // A failed/uncertain cancellation is never recorded as stopped.
      const observed = await this.inspect(processId);
      if (observed.status === "running") {
        this.#update(processId, {
          status: "running",
          errorCode: "stop_not_confirmed",
        });
      }
      return observed;
    }
  }

  reconcileStopped(
    processId: string,
    evidence: string,
  ): ExecutionRexProcessReceipt {
    const trimmed = evidence.trim();
    if (!trimmed || trimmed.length > 2048) {
      throw new ExecutionError("reconciliation_evidence_required");
    }
    return this.#transaction(() => {
      const row = this.#row(processId);
      if (!row) throw new ExecutionError("rex_process_not_found");
      if (row.status !== "uncertain")
        throw new ExecutionError("rex_process_not_uncertain");
      this.#db
        .query(
          `UPDATE execution_rex_processes SET status = 'exited', updated_at = ?, error_code = 'operator_reconciled',
            reconciliation_evidence = ? WHERE process_id = ? AND status = 'uncertain'`,
        )
        .run(new Date().toISOString(), trimmed, processId);
      return this.#receipt(this.#row(processId)!);
    });
  }

  hasBlockingProcesses(workspaceId: string): boolean {
    return Boolean(
      this.#db
        .query<{ process_id: string }, [string]>(
          `SELECT process_id FROM execution_rex_processes WHERE workspace_id = ?
            AND status <> 'exited' LIMIT 1`,
        )
        .get(workspaceId),
    );
  }

  #row(processId: string): RexProcessRow | undefined {
    return (
      this.#db
        .query<RexProcessRow, [string]>(
          "SELECT * FROM execution_rex_processes WHERE process_id = ?",
        )
        .get(processId) ?? undefined
    );
  }

  #receipt(row: RexProcessRow): ExecutionRexProcessReceipt {
    return executionRexProcessReceiptSchema.parse({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      processId: row.process_id,
      nodeId: row.node_id,
      target: { nodeId: row.node_id, workspaceId: row.workspace_id },
      ownershipGeneration: row.ownership_generation,
      payloadSha256: row.payload_sha256,
      status: row.status,
      launchedAt: row.launched_at,
      updatedAt: row.updated_at,
      sessionId: row.session_id ?? undefined,
      blockId: row.block_id ?? undefined,
      exitCode: row.exit_code,
      errorCode: row.error_code ?? undefined,
      reconciliationEvidence: row.reconciliation_evidence ?? undefined,
    });
  }

  #update(
    processId: string,
    update: {
      status: ExecutionRexProcessReceipt["status"];
      exitCode?: number | null;
      errorCode?: string;
    },
  ): ExecutionRexProcessReceipt {
    return this.#transaction(() => {
      this.#db
        .query(
          `UPDATE execution_rex_processes SET status = ?, updated_at = ?,
            exit_code = ?, error_code = ? WHERE process_id = ?`,
        )
        .run(
          update.status,
          new Date().toISOString(),
          update.exitCode ?? null,
          update.errorCode ?? null,
          processId,
        );
      const row = this.#row(processId);
      if (!row) throw new ExecutionError("rex_process_not_found");
      return this.#receipt(row);
    });
  }

  async #runJson(args: string[]): Promise<Record<string, any>> {
    const { stdout, exitCode } = await this.#run(args, true);
    if (exitCode !== 0) throw new RexCliError("rex_cli_failed");
    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new RexCliError("rex_cli_invalid_json");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new RexCliError("rex_cli_invalid_response");
    }
    return data as Record<string, any>;
  }

  async #runExit(args: string[]): Promise<void> {
    const { exitCode } = await this.#run(args, false);
    if (exitCode !== 0) throw new RexCliError("rex_cli_failed");
  }

  async #run(
    args: string[],
    captureOutput: boolean,
    tailBytes?: number,
  ): Promise<{ stdout: string; exitCode: number; truncated: boolean }> {
    let process: ReturnType<typeof Bun.spawn>;
    try {
      process = Bun.spawn({
        cmd: [
          this.#executable,
          ...(this.#server
            ? ["--autostart=false", "--server", this.#server]
            : []),
          ...args,
        ],
        stdin: "ignore",
        stdout: captureOutput ? "pipe" : "ignore",
        stderr: "ignore",
      });
    } catch {
      throw new RexCliError("rex_cli_start_failed");
    }
    const stdoutStream = process.stdout;
    if (captureOutput && !(stdoutStream instanceof ReadableStream)) {
      process.kill(9);
      throw new RexCliError("rex_output_unavailable");
    }
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(9);
      } catch {
        // The awaited exit below determines whether the Rex CLI request ended.
      }
    }, 15_000);
    try {
      const [stdout, exitCode] = await Promise.all([
        captureOutput
          ? readLimited(
              stdoutStream as ReadableStream<Uint8Array>,
              tailBytes ?? 256 * 1024,
              tailBytes !== undefined,
            )
          : Promise.resolve({ text: "", truncated: false }),
        process.exited,
      ]);
      if (timedOut) throw new RexCliError("rex_cli_timeout");
      return { stdout: stdout.text, exitCode, truncated: stdout.truncated };
    } finally {
      clearTimeout(timeout);
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  tail = false,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (tail) {
        chunks.push(part.value);
        size += part.value.byteLength;
        while (size > limit) {
          exceeded = true;
          const first = chunks[0]!;
          const remove = Math.min(size - limit, first.byteLength);
          if (remove === first.byteLength) chunks.shift();
          else chunks[0] = first.subarray(remove);
          size -= remove;
        }
      } else if (size + part.value.byteLength > limit) {
        const allowed = Math.max(0, limit - size);
        if (allowed) chunks.push(part.value.subarray(0, allowed));
        size += allowed;
        exceeded = true;
      } else {
        chunks.push(part.value);
        size += part.value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (exceeded && !tail) throw new RexCliError("rex_cli_output_limit");
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let start = 0;
  if (tail && exceeded) {
    // Discard only a cut UTF-8 prefix, not genuine replacement characters.
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  }
  return { text: bytes.subarray(start).toString("utf8"), truncated: exceeded };
}
