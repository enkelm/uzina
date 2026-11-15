import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorkspaceCheckpoint,
  type BlobTransport,
} from "@uzina/checkpoints";
import { portableWorkspaceBlobReferences } from "@uzina/checkpoints/portable";
import {
  executionCaptureControlSchema,
  executionJobSchema,
} from "@uzina/contracts/execution";
import {
  workspaceRelocationActivationCommandSchema,
  workspaceRelocationActivationPreflightSchema,
  workspaceRelocationClaimSchema,
} from "@uzina/contracts/factory";
import { ExecutionDaemon } from "../src/execution/daemon";
import { executionPayloadSha256 } from "../src/execution/payload";

const fixtures: Array<{ root: string; daemon?: ExecutionDaemon }> = [];

function fixture(options: { rexExecutable?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "uzina-execution-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const daemon = new ExecutionDaemon({
    databasePath: join(root, "node.sqlite"),
    nodeId: "node:test",
    nodeCredential: "node-secret-fixture",
    workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    rexExecutable: options.rexExecutable,
  });
  fixtures.push({ root, daemon });
  return { root, workspace, daemon };
}

function captureControl(
  overrides: {
    controlId?: string;
    captureId?: string;
    requestId?: string;
    ownershipGeneration?: number;
  } = {},
) {
  const binding = {
    contractVersion: 1 as const,
    controlId: "capture-control:test",
    captureId: "capture:test",
    requestId: "request:capture-control-test",
    nodeId: "node:test",
    target: { nodeId: "node:test", workspaceId: "workspace:test" },
    ownershipGeneration: 0,
    ...overrides,
  };
  return executionCaptureControlSchema.parse({
    ...binding,
    payloadSha256: executionPayloadSha256(binding),
  });
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

async function preparedWorkspaceRelocation(label: string) {
  const root = mkdtempSync(join(tmpdir(), `uzina-local-activation-${label}-`));
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source);
  mkdirSync(destination);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Activation fixture");
  git(source, "config", "user.email", "activation@example.invalid");
  writeFileSync(join(source, "tracked.txt"), "base\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "base");
  writeFileSync(join(source, "tracked.txt"), "staged\n");
  git(source, "add", "tracked.txt");
  writeFileSync(join(source, "tracked.txt"), "working\n");
  writeFileSync(join(source, "binary"), Buffer.from([0, 255, 19, 128]));
  chmodSync(join(source, "binary"), 0o755);

  const blobs = new Map<string, Uint8Array>();
  const transport: BlobTransport = {
    async putBlob(bytes) {
      const reference = createHash("sha256").update(bytes).digest("hex");
      blobs.set(reference, Uint8Array.from(bytes));
      return reference;
    },
    async getBlob(reference) {
      const bytes = blobs.get(reference);
      if (!bytes) throw new Error("activation fixture blob is missing");
      return Uint8Array.from(bytes);
    },
  };
  const captured = await captureWorkspaceCheckpoint({
    workspacePath: source,
    transport,
  });
  const claim = workspaceRelocationClaimSchema.parse({
    contractVersion: 1,
    relocationId: `relocation:${label}`,
    requestId: `request:${label}`,
    checkpointRequestId: `checkpoint:${label}`,
    captureRequestId: `capture-request:${label}`,
    captureId: `capture:${label}`,
    workspaceSnapshotRequestId: `snapshot-request:${label}`,
    snapshotId: `snapshot:${label}`,
    threadId: `thread:${label}`,
    source: { nodeId: "node:source", workspaceId: "workspace:source" },
    destination: {
      nodeId: "node:destination",
      workspaceId: "workspace:destination",
    },
    ownershipGeneration: 4,
    destinationOwnershipGeneration: 2,
    manifestReference: captured.manifestReference,
  });
  const daemon = new ExecutionDaemon({
    databasePath: join(root, "node.sqlite"),
    nodeId: "node:destination",
    nodeCredential: "destination-fixture-secret",
    workspaces: [
      {
        workspaceId: claim.destination.workspaceId,
        directory: destination,
        ownershipGeneration: claim.destinationOwnershipGeneration,
      },
    ],
  });
  fixtures.push({ root, daemon });
  const references = portableWorkspaceBlobReferences(
    captured.manifest,
    captured.manifestReference,
    captured.manifestBytes.byteLength,
  );
  const prepared = await daemon.executeWorkspaceRelocation(
    claim,
    async (_relocationId, reference) => {
      const bytes = blobs.get(reference);
      if (!bytes)
        throw new Error(`activation fixture blob not found: ${reference}`);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from(bytes));
          controller.close();
        },
      });
      const expected = references.find((item) => item.reference === reference);
      if (!expected || expected.size !== bytes.byteLength) {
        throw new Error("activation fixture blob metadata mismatch");
      }
      return { body: stream, size: expected.size };
    },
  );
  return { root, destination, daemon, claim, prepared };
}

function activationPreflight(
  claim: ReturnType<typeof workspaceRelocationClaimSchema.parse>,
  preparedReceiptSha256: string,
) {
  return workspaceRelocationActivationPreflightSchema.parse({
    contractVersion: 1,
    relocationId: claim.relocationId,
    requestId: claim.requestId,
    checkpointRequestId: claim.checkpointRequestId,
    captureRequestId: claim.captureRequestId,
    captureId: claim.captureId,
    workspaceSnapshotRequestId: claim.workspaceSnapshotRequestId,
    snapshotId: claim.snapshotId,
    threadId: claim.threadId,
    source: claim.source,
    destination: claim.destination,
    sourceOwnershipGeneration: claim.ownershipGeneration,
    destinationOwnershipGeneration:
      claim.destinationOwnershipGeneration ?? claim.ownershipGeneration,
    manifestReference: claim.manifestReference,
    sourceProofSha256: "a".repeat(64),
    preparedReceiptSha256,
  });
}

function activationCommand(
  preflight: ReturnType<
    typeof workspaceRelocationActivationPreflightSchema.parse
  >,
  readinessReceiptSha256: string,
  ownershipGeneration: number,
) {
  return workspaceRelocationActivationCommandSchema.parse({
    ...preflight,
    ownershipGeneration,
    readinessReceiptSha256,
    committedAt: new Date().toISOString(),
  });
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    contractVersion: 1,
    jobId: "job:one",
    nodeId: "node:test",
    target: { nodeId: "node:test", workspaceId: "workspace:test" },
    ownershipGeneration: 0,
    operation: "write-file",
    path: "artifact.txt",
    contentBase64: Buffer.from("sample bytes").toString("base64"),
    ...overrides,
  };
  if (result.operation === "argv-command") {
    delete result.path;
    delete result.contentBase64;
    delete result.maxBytes;
  } else if (result.operation === "read-file") {
    delete result.contentBase64;
    delete result.argv;
    delete result.timeoutMs;
    delete result.maxOutputBytes;
  } else {
    delete result.maxBytes;
    delete result.argv;
    delete result.timeoutMs;
    delete result.maxOutputBytes;
  }
  return result;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) {
    item.daemon?.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

describe("persistent execution daemon", () => {
  test("performs bounded file effects and deduplicates stable job identities", async () => {
    const { workspace, daemon } = fixture();
    const first = await daemon.executeJob(job());

    expect(first.status).toBe("completed");
    expect(first.result).toMatchObject({
      operation: "write-file",
      bytes: Buffer.byteLength("sample bytes"),
    });
    expect(readFileSync(join(workspace, "artifact.txt"), "utf8")).toBe(
      "sample bytes",
    );
    expect(await daemon.executeJob(job())).toEqual(first);

    await expect(
      daemon.executeJob(
        job({ contentBase64: Buffer.from("different").toString("base64") }),
      ),
    ).rejects.toThrow("job_id_payload_conflict");

    const read = await daemon.executeJob(
      job({
        jobId: "job:read",
        operation: "read-file",
        path: "artifact.txt",
        maxBytes: 64,
        contentBase64: undefined,
      }),
    );
    expect(read.status).toBe("completed");
    expect(read.result).toMatchObject({
      operation: "read-file",
      contentBase64: Buffer.from("sample bytes").toString("base64"),
      bytes: 12,
    });
  });

  test("activates only the authorized destination epoch and reopens without rechecking changed live work", async () => {
    const local = await preparedWorkspaceRelocation("different-epochs");
    expect(local.prepared).toMatchObject({ status: "prepared-inactive" });
    expect(local.prepared.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    local.daemon.markWorkspaceRelocationReported(
      local.claim.relocationId,
      local.prepared,
    );

    const preflight = activationPreflight(
      local.claim,
      local.prepared.receiptSha256,
    );
    const readiness =
      await local.daemon.prepareWorkspaceRelocationActivation(preflight);
    expect(readiness).toMatchObject({
      relocationId: local.claim.relocationId,
      sourceOwnershipGeneration: 4,
      destinationOwnershipGeneration: 2,
      preparedReceiptSha256: local.prepared.receiptSha256,
    });
    if (!readiness) throw new Error("Expected local readiness evidence");

    const command = activationCommand(
      preflight,
      readiness.readinessReceiptSha256,
      5,
    );
    const report = await local.daemon.activateWorkspaceRelocation(command);
    expect(report).toMatchObject({
      status: "activated",
      command: { ownershipGeneration: 5 },
    });
    expect(await local.daemon.activateWorkspaceRelocation(command)).toEqual(
      report,
    );
    expect(git(local.destination, "status", "--porcelain").trim()).toBe(
      "MM tracked.txt\n?? binary",
    );
    expect(readFileSync(join(local.destination, "tracked.txt"), "utf8")).toBe(
      "working\n",
    );

    const record = fixtures.find((item) => item.root === local.root);
    if (!record) throw new Error("Local activation fixture disappeared");
    local.daemon.close();
    let reopened = new ExecutionDaemon({
      databasePath: join(local.root, "node.sqlite"),
      nodeId: local.claim.destination.nodeId,
      nodeCredential: "destination-fixture-secret",
      workspaces: [
        {
          workspaceId: local.claim.destination.workspaceId,
          directory: local.destination,
          ownershipGeneration: 2,
        },
      ],
    });
    record.daemon = reopened;
    await reopened.reconcileWorkspaceRelocations();
    expect(reopened.pendingWorkspaceRelocationReports()).toEqual([]);
    expect(reopened.pendingWorkspaceRelocationActivationReports()).toEqual([
      report,
    ]);
    expect(reopened.registerRequest().workspaces as unknown).toEqual([
      {
        workspaceId: local.claim.destination.workspaceId,
        ownershipGeneration: 5,
        state: "active",
      },
    ]);
    await expect(
      reopened.executeJob(
        executionJobSchema.parse(
          job({
            jobId: "job:before-core-finalization",
            nodeId: local.claim.destination.nodeId,
            target: local.claim.destination,
            ownershipGeneration: 5,
          }),
        ),
      ),
    ).rejects.toThrow("workspace_relocation_reserved");
    reopened.markWorkspaceRelocationActivationReported(
      local.claim.relocationId,
      report,
    );
    const continuation = await reopened.executeJob(
      executionJobSchema.parse(
        job({
          jobId: "job:after-core-finalization",
          nodeId: local.claim.destination.nodeId,
          target: local.claim.destination,
          ownershipGeneration: 5,
          path: "after-activation.txt",
        }),
      ),
    );
    expect(continuation.status).toBe("completed");
    writeFileSync(
      join(local.destination, "tracked.txt"),
      "legitimate later work\n",
    );

    reopened.close();
    reopened = new ExecutionDaemon({
      databasePath: join(local.root, "node.sqlite"),
      nodeId: local.claim.destination.nodeId,
      nodeCredential: "destination-fixture-secret",
      workspaces: [
        {
          workspaceId: local.claim.destination.workspaceId,
          directory: local.destination,
          ownershipGeneration: 2,
        },
        {
          workspaceId: "workspace:post-move-alias",
          directory: local.destination,
        },
      ],
    });
    record.daemon = reopened;
    await reopened.reconcileWorkspaceRelocations();
    expect(reopened.pendingWorkspaceRelocationReports()).toEqual([]);
    expect(reopened.pendingWorkspaceRelocationActivationReports()).toEqual([]);
    expect(reopened.registerRequest().workspaces as unknown).toEqual([
      {
        workspaceId: local.claim.destination.workspaceId,
        ownershipGeneration: 5,
        state: "active",
      },
      {
        workspaceId: "workspace:post-move-alias",
        ownershipGeneration: 0,
        state: "active",
      },
    ]);
    await expect(
      reopened.executeJob(
        executionJobSchema.parse(
          job({
            jobId: "job:post-move-alias",
            nodeId: local.claim.destination.nodeId,
            target: {
              nodeId: local.claim.destination.nodeId,
              workspaceId: "workspace:post-move-alias",
            },
            ownershipGeneration: 0,
          }),
        ),
      ),
    ).rejects.toThrow("workspace_relocation_reserved");
    expect(readFileSync(join(local.destination, "tracked.txt"), "utf8")).toBe(
      "legitimate later work\n",
    );
    expect(
      (
        await reopened.executeJob(
          executionJobSchema.parse(
            job({
              jobId: "job:after-reopen",
              nodeId: local.claim.destination.nodeId,
              target: local.claim.destination,
              ownershipGeneration: 5,
              path: "after-reopen.txt",
            }),
          ),
        )
      ).status,
    ).toBe("completed");
  });

  test("parks a changed prepared tree as activation-uncertain without rewriting its preparation receipt", async () => {
    const local = await preparedWorkspaceRelocation("changed-after-readiness");
    local.daemon.markWorkspaceRelocationReported(
      local.claim.relocationId,
      local.prepared,
    );
    const preflight = activationPreflight(
      local.claim,
      local.prepared.receiptSha256,
    );
    const readiness =
      await local.daemon.prepareWorkspaceRelocationActivation(preflight);
    if (!readiness) throw new Error("Expected local readiness evidence");
    const command = activationCommand(
      preflight,
      readiness.readinessReceiptSha256,
      5,
    );
    const changed = "changed after Core authorization\n";
    writeFileSync(join(local.destination, "tracked.txt"), changed);

    const report = await local.daemon.activateWorkspaceRelocation(command);
    expect(report).toMatchObject({
      status: "uncertain",
      errorCode: "workspace_relocation_activation_unverified",
    });
    expect(readFileSync(join(local.destination, "tracked.txt"), "utf8")).toBe(
      changed,
    );
    expect(local.daemon.pendingWorkspaceRelocationReports()).toEqual([]);
    expect(local.daemon.pendingWorkspaceRelocationActivationReports()).toEqual([
      report,
    ]);
    expect(local.daemon.registerRequest().workspaces as unknown).toEqual([
      {
        workspaceId: local.claim.destination.workspaceId,
        ownershipGeneration: 2,
        state: "fenced",
      },
    ]);
    local.daemon.markWorkspaceRelocationActivationReported(
      local.claim.relocationId,
      report,
    );
    await expect(
      local.daemon.executeJob(
        executionJobSchema.parse(
          job({
            jobId: "job:uncertain-destination",
            nodeId: local.claim.destination.nodeId,
            target: local.claim.destination,
            ownershipGeneration: 2,
          }),
        ),
      ),
    ).rejects.toThrow("workspace_fenced");
  });

  test("keeps a source CONTROL fence effective through a post-capture workspace alias", async () => {
    const local = fixture();
    const report = local.daemon.executeCaptureControl(captureControl());
    expect(report.status).toBe("source-capture-fenced");
    local.daemon.close();
    const reopened = new ExecutionDaemon({
      databasePath: join(local.root, "node.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [
        { workspaceId: "workspace:test", directory: local.workspace },
        { workspaceId: "workspace:alias", directory: local.workspace },
      ],
    });
    const record = fixtures.find((item) => item.root === local.root);
    if (!record) throw new Error("Source alias fixture disappeared");
    record.daemon = reopened;
    await expect(
      reopened.executeJob(
        executionJobSchema.parse(
          job({
            jobId: "job:source-alias",
            target: {
              nodeId: "node:test",
              workspaceId: "workspace:alias",
            },
          }),
        ),
      ),
    ).rejects.toThrow("workspace_capture_active");
  });

  test("migrates pre-control local capture fences without changing their cleanup behavior", async () => {
    const root = mkdtempSync(join(tmpdir(), "uzina-legacy-capture-fence-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const databasePath = join(root, "node.sqlite");
    const legacyDatabase = new Database(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE execution_workspace_captures (
        workspace_id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL
      );
    `);
    legacyDatabase
      .query(
        "INSERT INTO execution_workspace_captures(workspace_id, capture_id, started_at) VALUES (?, ?, ?)",
      )
      .run("workspace:test", "capture:legacy-local", new Date().toISOString());
    legacyDatabase.close();

    const daemon = new ExecutionDaemon({
      databasePath,
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    });
    fixtures.push({ root, daemon });
    await expect(daemon.executeJob(job())).rejects.toThrow(
      "workspace_capture_active",
    );
    daemon.endWorkspaceCapture("capture:legacy-local");
    expect((await daemon.executeJob(job())).status).toBe("completed");
  });

  test("executes argv directly with bounded output and stops timed-out jobs", async () => {
    const { daemon } = fixture();
    const result = await daemon.executeJob(
      job({
        jobId: "job:command",
        operation: "argv-command",
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('123456'); process.stderr.write('abcdef')",
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 7,
        path: undefined,
        contentBase64: undefined,
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.result?.operation).toBe("argv-command");
    if (result.result?.operation === "argv-command") {
      expect(result.result.stdout.length + result.result.stderr.length).toBe(7);
      expect(result.result.outputTruncated).toBe(true);
    }

    const timedOut = await daemon.executeJob(
      job({
        jobId: "job:timeout",
        operation: "argv-command",
        argv: [process.execPath, "-e", "await Bun.sleep(1000)"],
        timeoutMs: 50,
        maxOutputBytes: 64,
      }),
    );
    expect(timedOut.status).toBe("uncertain");
    expect(timedOut.errorCode).toBe("command_timed_out");
    expect(timedOut.result).toMatchObject({
      operation: "argv-command",
      timedOut: true,
    });
  });

  test.skipIf(process.platform === "win32")(
    "kills a timed-out command's child process group before a descendant can mutate the workspace",
    async () => {
      const { workspace, daemon } = fixture();
      const marker = join(workspace, "late-child-marker.txt");
      const child = `await Bun.sleep(150); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late')`;
      const result = await daemon.executeJob(
        job({
          jobId: "job:timeout-descendant",
          operation: "argv-command",
          argv: [
            process.execPath,
            "-e",
            `Bun.spawn({ cmd: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(child)}], stdin: "ignore", stdout: "ignore", stderr: "ignore" }); await Bun.sleep(10000)`,
          ],
          timeoutMs: 50,
          maxOutputBytes: 64,
        }),
      );

      expect(result.status).toBe("uncertain");
      expect(result.errorCode).toBe("command_timed_out");
      await Bun.sleep(250);
      expect(() => readFileSync(marker, "utf8")).toThrow();
    },
  );

  test("bounds file effects and persists deterministic preflight failures", async () => {
    const { workspace, daemon } = fixture();
    writeFileSync(join(workspace, "large.bin"), Buffer.alloc(8, 65));
    const read = await daemon.executeJob(
      job({
        jobId: "job:read-limit",
        operation: "read-file",
        path: "large.bin",
        maxBytes: 4,
      }),
    );
    expect(read.status).toBe("failed");
    expect(read.errorCode).toBe("file_size_limit_exceeded");

    const oversized = Buffer.alloc(1_048_577).toString("base64");
    const rejectedWrite = await daemon.executeJob(
      job({ jobId: "job:write-limit", contentBase64: oversized }),
    );
    expect(rejectedWrite).toMatchObject({
      status: "failed",
      errorCode: "invalid_file_content",
    });
    expect(daemon.reportFor("job:write-limit")).toMatchObject({
      status: "failed",
      errorCode: "invalid_file_content",
    });
    expect(() =>
      readFileSync(join(workspace, "artifact.txt"), "utf8"),
    ).toThrow();
    expect(
      await daemon.executeJob(
        job({
          jobId: "job:write-limit",
          contentBase64: oversized,
        }),
      ),
    ).toEqual(rejectedWrite);
  });

  test("does not convert a failed receipt write into a terminal filesystem failure", async () => {
    const { root, daemon } = fixture();
    const database = new Database(join(root, "node.sqlite"));
    database.exec(`
      CREATE TRIGGER reject_failed_receipt
      BEFORE INSERT ON execution_jobs
      WHEN NEW.status = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'receipt write blocked');
      END;
    `);
    database.close();

    await expect(
      daemon.executeJob(
        job({
          jobId: "job:failed-receipt-write",
          operation: "read-file",
          path: "missing.txt",
          maxBytes: 64,
        }),
      ),
    ).rejects.toThrow("receipt write blocked");
    expect(daemon.getReceipt("job:failed-receipt-write")).toBeUndefined();
  });

  test("rejects wrong targets, generations, unsupported operations, and bounded-size violations", async () => {
    const { daemon } = fixture();

    await expect(
      daemon.executeJob(
        job({
          nodeId: "node:other",
          target: { nodeId: "node:other", workspaceId: "workspace:test" },
        }),
      ),
    ).rejects.toThrow("target_node_mismatch");
    expect(daemon.getReceipt("job:one")).toBeUndefined();
    await expect(
      daemon.executeJob(job({ ownershipGeneration: 3 })),
    ).rejects.toThrow("stale_ownership_generation");
    await expect(
      daemon.executeJob(
        job({
          jobId: "job:unconfigured-workspace",
          target: { nodeId: "node:test", workspaceId: "workspace:other" },
        }),
      ),
    ).rejects.toThrow("workspace_not_configured");
    await expect(
      daemon.executeJob(job({ operation: "shell" })),
    ).rejects.toThrow("unsupported_operation");
    await expect(
      daemon.executeJob(
        job({ operation: "read-file", path: "x", maxBytes: 1_048_577 }),
      ),
    ).rejects.toThrow("invalid_job");
  });

  test("rejects traversal and symlink escapes without reading or writing outside the workspace", async () => {
    const { root, workspace, daemon } = fixture();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside original");
    symlinkSync(outside, join(workspace, "outside-link.txt"));
    mkdirSync(join(root, "outside-dir"));
    writeFileSync(join(root, "outside-dir", "secret.txt"), "secret");
    symlinkSync(join(root, "outside-dir"), join(workspace, "outside-link-dir"));

    const traversal = await daemon.executeJob(
      job({ jobId: "job:traversal", path: "../outside.txt" }),
    );
    expect(traversal).toMatchObject({
      status: "failed",
      errorCode: "unsafe_workspace_path",
    });
    const linkWrite = await daemon.executeJob(
      job({ jobId: "job:link", path: "outside-link.txt" }),
    );
    expect(linkWrite).toMatchObject({
      status: "failed",
      errorCode: "workspace_symlink_rejected",
    });
    const linkRead = await daemon.executeJob(
      job({
        jobId: "job:link-dir",
        operation: "read-file",
        path: "outside-link-dir/secret.txt",
        maxBytes: 32,
        contentBase64: undefined,
      }),
    );
    expect(linkRead).toMatchObject({
      status: "failed",
      errorCode: "workspace_symlink_rejected",
    });
    expect(daemon.reportFor("job:traversal")).toMatchObject({
      status: "failed",
      errorCode: "unsafe_workspace_path",
    });
    expect(readFileSync(outside, "utf8")).toBe("outside original");
  });

  test("persists identity, workspace mappings, receipts, and fenced generations across reopen", async () => {
    const { root, workspace, daemon } = fixture();
    const done = await daemon.executeJob(job());
    const fence = daemon.fenceWorkspace("workspace:test", 0, 1);
    expect(fence).toMatchObject({ ownershipGeneration: 1, state: "fenced" });
    daemon.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;

    const reopened = new ExecutionDaemon({
      databasePath: join(root, "node.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    });
    fixtures.push({ root, daemon: reopened });
    expect(reopened.getReceipt("job:one")).toEqual(done);
    expect(await reopened.executeJob(job())).toEqual(done);
    expect(reopened.registerRequest().workspaces).toMatchObject([
      {
        workspaceId: "workspace:test",
        ownershipGeneration: 1,
        state: "fenced",
      },
    ]);
    await expect(
      reopened.executeJob(
        job({ jobId: "job:old-generation", ownershipGeneration: 0 }),
      ),
    ).rejects.toThrow("stale_ownership_generation");
    reopened.activateWorkspace("workspace:test", 1);
    expect(reopened.heartbeatRequest().workspaces[0]?.ownershipGeneration).toBe(
      1,
    );
  });

  test("rejects credential and workspace remapping changes on reopen", async () => {
    const { root, workspace, daemon } = fixture();
    daemon.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;
    const otherWorkspace = join(root, "other-workspace");
    mkdirSync(otherWorkspace);

    expect(
      () =>
        new ExecutionDaemon({
          databasePath: join(root, "node.sqlite"),
          nodeId: "node:test",
          nodeCredential: "different-secret",
          workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
        }),
    ).toThrow("node_credential_conflict");
    expect(
      () =>
        new ExecutionDaemon({
          databasePath: join(root, "node.sqlite"),
          nodeId: "node:test",
          nodeCredential: "node-secret-fixture",
          workspaces: [
            { workspaceId: "workspace:test", directory: otherWorkspace },
          ],
        }),
    ).toThrow("workspace_mapping_conflict");
  });

  test("does not replay an interrupted uncertain command after restart", async () => {
    const { root, workspace, daemon } = fixture();
    const marker = join(workspace, "command-runs.txt");
    const uncertainJob = job({
      jobId: "job:uncertain-command",
      operation: "argv-command",
      argv: [
        process.execPath,
        "-e",
        `await Bun.sleep(150); require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`,
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 64,
      path: undefined,
      contentBase64: undefined,
    });
    const originalExecution = daemon
      .executeJob(uncertainJob)
      .catch(() => undefined);
    expect(daemon.getReceipt("job:uncertain-command")?.status).toBe("running");
    daemon.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;

    const reopened = new ExecutionDaemon({
      databasePath: join(root, "node.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    });
    fixtures.push({ root, daemon: reopened });
    const retry = await reopened.executeJob(uncertainJob);
    expect(retry.status).toBe("uncertain");
    expect(retry.errorCode).toBe("interrupted_after_start");
    await Bun.sleep(300);
    await originalExecution;
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(() => reopened.fenceWorkspace("workspace:test", 0, 1)).toThrow(
      "workspace_has_uncertain_effects",
    );
    expect(() =>
      reopened.beginWorkspaceCapture("workspace:test", "capture:uncertain-job"),
    ).toThrow("workspace_has_unsettled_effects");
    const uncertainControl = captureControl({
      controlId: "capture-control:uncertain-job",
      captureId: "capture:uncertain-job-control",
      requestId: "request:uncertain-job-control",
    });
    expect(reopened.executeCaptureControl(uncertainControl)).toMatchObject({
      status: "blocked",
      errorCode: "workspace_has_unsettled_effects",
    });

    const resolved = reopened.reconcileUncertainJob(
      "job:uncertain-command",
      "confirmed-completed",
      "operator verified the command marker and process exit",
    );
    expect(resolved.status).toBe("completed");
    expect(() => reopened.fenceWorkspace("workspace:test", 0, 1)).not.toThrow();
  });

  test("refuses quiescence while an argv effect is running and admits only the advanced generation after fencing", async () => {
    const { daemon } = fixture();
    const running = daemon.executeJob(
      job({
        jobId: "job:running",
        operation: "argv-command",
        argv: [process.execPath, "-e", "await Bun.sleep(100)"],
        timeoutMs: 5_000,
        maxOutputBytes: 64,
        path: undefined,
        contentBase64: undefined,
      }),
    );
    expect(() => daemon.fenceWorkspace("workspace:test", 0, 1)).toThrow(
      "workspace_has_uncertain_effects",
    );
    expect(() =>
      daemon.beginWorkspaceCapture("workspace:test", "capture:running-job"),
    ).toThrow("workspace_has_unsettled_effects");
    const control = captureControl();
    const blockedControl = daemon.executeCaptureControl(control);
    expect(blockedControl).toMatchObject({
      controlId: control.controlId,
      status: "blocked",
      errorCode: "workspace_has_unsettled_effects",
    });
    expect(daemon.executeCaptureControl(control)).toEqual(blockedControl);
    expect(daemon.pendingCaptureControlReports()).toEqual([blockedControl]);
    expect((await running).status).toBe("completed");
    expect(daemon.executeCaptureControl(control)).toEqual(blockedControl);
    daemon.beginWorkspaceCapture(
      "workspace:test",
      "capture:local-after-blocked-control",
    );
    daemon.endWorkspaceCapture("capture:local-after-blocked-control");
    daemon.fenceWorkspace("workspace:test", 0, 1);
    await expect(
      daemon.executeJob(job({ jobId: "job:stale", ownershipGeneration: 0 })),
    ).rejects.toThrow("stale_ownership_generation");
    daemon.activateWorkspace("workspace:test", 1);
    const generationOne = await daemon.executeJob(
      job({ jobId: "job:generation-one", ownershipGeneration: 1 }),
    );
    expect(generationOne.status).toBe("completed");
  });

  test("refuses captures for overlapping persisted workspace roots without blocking ordinary execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "uzina-overlapping-workspaces-"));
    const parent = join(root, "repo");
    const child = join(parent, "nested");
    const sibling = join(root, "repo2");
    mkdirSync(child, { recursive: true });
    mkdirSync(sibling);
    const databasePath = join(root, "node.sqlite");
    const nodeOptions = {
      databasePath,
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
    };
    const first = new ExecutionDaemon({
      ...nodeOptions,
      workspaces: [
        { workspaceId: "workspace:parent", directory: parent },
        { workspaceId: "workspace:child", directory: child },
        { workspaceId: "workspace:sibling", directory: sibling },
      ],
    });
    fixtures.push({ root, daemon: first });

    const ready = join(child, "command-ready.txt");
    const changedParentFile = join(parent, "delayed-child-write.txt");
    expect(() =>
      first.beginWorkspaceCapture(
        "workspace:parent",
        "capture:parent-before-child",
      ),
    ).toThrow("workspace_mappings_overlap");
    const childCommand = first.executeJob(
      job({
        jobId: "job:delayed-child-write",
        target: { nodeId: "node:test", workspaceId: "workspace:child" },
        operation: "argv-command",
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); await Bun.sleep(100); require('node:fs').writeFileSync(${JSON.stringify(changedParentFile)}, 'changed')`,
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 64,
      }),
    );
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    expect(() =>
      first.beginWorkspaceCapture(
        "workspace:parent",
        "capture:parent-during-child",
      ),
    ).toThrow("workspace_mappings_overlap");
    expect(() =>
      first.beginWorkspaceCapture(
        "workspace:child",
        "capture:child-during-child",
      ),
    ).toThrow("workspace_mappings_overlap");

    first.beginWorkspaceCapture("workspace:sibling", "capture:sibling");
    first.endWorkspaceCapture("capture:sibling");
    const siblingWrite = await first.executeJob(
      job({
        jobId: "job:sibling-after-capture",
        target: { nodeId: "node:test", workspaceId: "workspace:sibling" },
      }),
    );
    expect(siblingWrite.status).toBe("completed");
    expect((await childCommand).status).toBe("completed");
    expect(readFileSync(changedParentFile, "utf8")).toBe("changed");

    first.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;
    const reopened = new ExecutionDaemon({
      ...nodeOptions,
      workspaces: [
        { workspaceId: "workspace:parent", directory: parent },
        { workspaceId: "workspace:sibling", directory: sibling },
      ],
    });
    fixtures.push({ root, daemon: reopened });
    expect(() =>
      reopened.beginWorkspaceCapture(
        "workspace:parent",
        "capture:persisted-child",
      ),
    ).toThrow("workspace_mappings_overlap");
    expect(() =>
      reopened.beginWorkspaceCapture(
        "workspace:sibling",
        "capture:sibling-after-reopen",
      ),
    ).not.toThrow();
    reopened.endWorkspaceCapture("capture:sibling-after-reopen");
    reopened.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;
    rmSync(child, { recursive: true, force: true });
    const unavailable = new ExecutionDaemon({
      ...nodeOptions,
      workspaces: [
        { workspaceId: "workspace:parent", directory: parent },
        { workspaceId: "workspace:sibling", directory: sibling },
      ],
    });
    fixtures.push({ root, daemon: unavailable });
    expect(() =>
      unavailable.beginWorkspaceCapture(
        "workspace:parent",
        "capture:unavailable-child",
      ),
    ).toThrow("workspace_mapping_unavailable");
  });

  test("uses canonical symlink roots and segment-aware boundaries for capture preflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "uzina-workspace-root-alias-"));
    const workspace = join(root, "repo");
    const sibling = join(root, "repo2");
    const alias = join(root, "repo-alias");
    mkdirSync(workspace);
    mkdirSync(sibling);
    symlinkSync(workspace, alias);
    const aliasDaemon = new ExecutionDaemon({
      databasePath: join(root, "alias.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [
        { workspaceId: "workspace:real", directory: workspace },
        { workspaceId: "workspace:alias", directory: alias },
      ],
    });
    fixtures.push({ root, daemon: aliasDaemon });
    expect(() =>
      aliasDaemon.beginWorkspaceCapture("workspace:real", "capture:real-alias"),
    ).toThrow("workspace_mappings_overlap");

    aliasDaemon.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;
    const siblingDaemon = new ExecutionDaemon({
      databasePath: join(root, "sibling.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [
        { workspaceId: "workspace:repo", directory: workspace },
        { workspaceId: "workspace:repo2", directory: sibling },
      ],
    });
    fixtures.push({ root, daemon: siblingDaemon });
    expect(() =>
      siblingDaemon.beginWorkspaceCapture("workspace:repo", "capture:repo"),
    ).not.toThrow();
    siblingDaemon.endWorkspaceCapture("capture:repo");
    expect(() =>
      siblingDaemon.beginWorkspaceCapture("workspace:repo2", "capture:repo2"),
    ).not.toThrow();
    siblingDaemon.endWorkspaceCapture("capture:repo2");
  });

  test("creates and stops only persisted Rex resources using structured inspection", async () => {
    const root = mkdtempSync(join(tmpdir(), "uzina-rex-fixture-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const statePath = join(root, "rex-state.json");
    writeFileSync(statePath, "{}", "utf8");
    const executable = join(root, "rex-fixture");
    writeFileSync(
      executable,
      `#!/usr/bin/env bun\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst stateFile = ${JSON.stringify(statePath)};\nconst state = JSON.parse(readFileSync(stateFile, 'utf8'));\nconst [command, ...args] = process.argv.slice(2);\nconst persist = () => writeFileSync(stateFile, JSON.stringify(state));\nif (command === 'new') { const label = args[0]; const session_id = 'session-' + label; const block_id = 'block-' + label; state[session_id] = { block_id, running: true, last_exit: null }; persist(); console.log(JSON.stringify({ session_id, initial_windows: [{ block_ids: [block_id] }] })); }\nelse if (command === 'session' && args[0] === 'inspect') { const s = state[args[1]]; if (!s) process.exit(3); console.log(JSON.stringify({ session_id: args[1], windows: [{ window_id: 'window-' + args[1], focused_block_id: s.block_id }] })); }\nelse if (command === 'block' && args[0] === 'call') { const session = args[args.indexOf('--session') + 1]; const s = state[session]; if (!s) process.exit(3); console.log(JSON.stringify({ running: s.running, last_exit: s.last_exit })); }\nelse if (command === 'kill') { const s = state[args[0]]; if (!s) process.exit(3); s.running = false; s.last_exit = 143; persist(); console.log('{}'); }\nelse process.exit(4);\n`,
    );
    chmodSync(executable, 0o700);
    const daemon = new ExecutionDaemon({
      databasePath: join(root, "node.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
      rexExecutable: executable,
    });
    fixtures.push({ root, daemon });

    const request = {
      contractVersion: 1,
      processId: "process:isolated",
      nodeId: "node:test",
      target: { nodeId: "node:test", workspaceId: "workspace:test" },
      ownershipGeneration: 0,
      argv: [process.execPath, "-e", "await Bun.sleep(10000)"],
    };
    const launched = await daemon.rex.launch(request);
    expect(launched.status).toBe("running");
    expect(launched.sessionId).toBe("session-uzina-process:isolated");
    expect(launched.blockId).toBe("block-uzina-process:isolated");
    expect(await daemon.rex.inspect("process:isolated")).toMatchObject({
      status: "running",
    });
    expect(() =>
      daemon.beginWorkspaceCapture("workspace:test", "capture:rex-active"),
    ).toThrow("workspace_has_running_rex_processes");
    const rexControl = captureControl({
      controlId: "capture-control:rex-active",
      captureId: "capture:rex-active-control",
      requestId: "request:rex-active-control",
    });
    const blockedRexControl = daemon.executeCaptureControl(rexControl);
    expect(blockedRexControl).toMatchObject({
      status: "blocked",
      errorCode: "workspace_has_running_rex_processes",
    });
    expect(daemon.executeCaptureControl(rexControl)).toEqual(blockedRexControl);
    expect(() => daemon.fenceWorkspace("workspace:test", 0, 1)).toThrow(
      "workspace_has_running_rex_processes",
    );
    const stopped = await daemon.rex.stop("process:isolated");
    expect(stopped.status).toBe("exited");
    expect(daemon.executeCaptureControl(rexControl)).toEqual(blockedRexControl);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      "session-uzina-process:isolated": {
        block_id: "block-uzina-process:isolated",
        running: false,
        last_exit: 143,
      },
    });
    expect(() => daemon.fenceWorkspace("workspace:test", 0, 1)).not.toThrow();
    daemon.activateWorkspace("workspace:test", 1);

    const captureId = "capture:rex-quiescent";
    daemon.beginWorkspaceCapture("workspace:test", captureId);
    await expect(
      daemon.executeJob(
        job({ jobId: "job:local-capture-block", ownershipGeneration: 1 }),
      ),
    ).rejects.toThrow("workspace_capture_active");
    await expect(
      daemon.rex.launch({
        ...request,
        processId: "process:capture-blocked",
        ownershipGeneration: 1,
      }),
    ).rejects.toThrow("workspace_capture_active");
    daemon.endWorkspaceCapture(captureId);
    expect(() =>
      daemon.beginWorkspaceCapture("workspace:test", captureId),
    ).not.toThrow();
    daemon.endWorkspaceCapture(captureId);

    const stateDatabase = new Database(join(root, "node.sqlite"));
    stateDatabase
      .query(
        "UPDATE execution_rex_processes SET status = 'unknown' WHERE process_id = ?",
      )
      .run("process:isolated");
    stateDatabase.close();
    const unknownRexControl = captureControl({
      controlId: "capture-control:unknown-rex",
      captureId: "capture:unknown-rex",
      requestId: "request:unknown-rex",
      ownershipGeneration: 1,
    });
    const blockedUnknownRex = daemon.executeCaptureControl(unknownRexControl);
    expect(blockedUnknownRex).toMatchObject({
      status: "blocked",
      errorCode: "workspace_has_running_rex_processes",
    });
    expect(blockedUnknownRex.sourceFence).toBeUndefined();
  });
});
