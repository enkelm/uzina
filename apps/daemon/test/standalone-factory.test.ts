import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ManagedPiWork, type ManagedModels } from "@uzina/pi-runtime";
import {
  captureManagedWorkBundle,
  FileBlobTransport,
  restoreManagedWorkBundle,
  validateManagedWorkBundle,
  WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
  type BlobTransport,
} from "@uzina/checkpoints";
import {
  ExecutionDaemon,
  type WorkspaceMapping,
} from "../src/execution/daemon";
import { HttpExecutionControllerConnector } from "../src/execution/connector";
import { ExecutionLoop } from "../src/execution/loop";
import {
  createStandaloneFactoryServer,
  type StandaloneFactoryServer,
} from "../src/factory/standalone";
import { deterministicFailingModels } from "../../../packages/pi-runtime/test-support/deterministic-failing-model";
import { deterministicToolModels } from "../../../packages/pi-runtime/test-support/deterministic-tool-model";
import { openBunSqliteStorage } from "../src/runtime/sqlite";

setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value)!;
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resignedBundle(value: Record<string, unknown>): {
  reference: string;
  bytes: Buffer;
} {
  const { sha256: _oldChecksum, ...body } = value;
  const manifest = {
    ...body,
    sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
  const bytes = Buffer.from(canonicalJson(manifest), "utf8");
  return { reference: sha256(bytes), bytes };
}

function overlayTransport(
  base: BlobTransport,
  blobs: ReadonlyMap<string, Uint8Array>,
): BlobTransport {
  return {
    putBlob: (bytes) => base.putBlob(bytes),
    async getBlob(reference) {
      return blobs.get(reference) ?? base.getBlob(reference);
    },
  };
}

const fixtures: Array<{ directory: string; close(): Promise<void> }> = [];

async function call<T>(
  baseUrl: string,
  path: string,
  options: { credential?: string; bootstrap?: boolean; body?: unknown } = {},
): Promise<{ status: number; value: T }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.credential
        ? {
            authorization: `${options.bootstrap ? "Bootstrap" : "Bearer"} ${options.credential}`,
          }
        : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, value: (await response.json()) as T };
}

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for composed local managed execution");
}

async function scenario(options: {
  models: ManagedModels;
  modelProvider: string;
  modelId: string;
  directoryPrefix: string;
  deferExecutor?: boolean;
  extraWorkspaceDirectories?: Readonly<Record<string, string>>;
  extraWorkspaceSubdirectories?: Readonly<Record<string, string>>;
  extraWorkspaceAliases?: readonly string[];
}) {
  const directory = await mkdtemp(join(tmpdir(), options.directoryPrefix));
  const workspaceDirectory = join(directory, "workspace");
  await mkdir(workspaceDirectory);
  for (const workspacePath of Object.values(
    options.extraWorkspaceDirectories ?? {},
  )) {
    await mkdir(workspacePath, { recursive: true });
  }
  const extraWorkspaceMappings = {
    ...options.extraWorkspaceDirectories,
  };
  for (const [workspaceId, relativePath] of Object.entries(
    options.extraWorkspaceSubdirectories ?? {},
  )) {
    const workspacePath = join(workspaceDirectory, relativePath);
    await mkdir(workspacePath, { recursive: true });
    extraWorkspaceMappings[workspaceId] = workspacePath;
  }
  for (const [index, workspaceId] of (
    options.extraWorkspaceAliases ?? []
  ).entries()) {
    const aliasPath = join(directory, `workspace-alias-${index}`);
    await symlink(workspaceDirectory, aliasPath);
    extraWorkspaceMappings[workspaceId] = aliasPath;
  }
  let host: StandaloneFactoryServer | undefined;
  let execution: ExecutionDaemon | undefined;
  let abort: AbortController | undefined;
  let runningLoop: Promise<void> | undefined;
  const bootstrapSecret = `${options.directoryPrefix}-bootstrap`;
  const openHost = () =>
    createStandaloneFactoryServer({
      databasePath: join(directory, "factory.sqlite"),
      runtimeDirectory: join(directory, "managed-work"),
      bootstrapSecret,
      models: options.models,
      modelProvider: options.modelProvider,
      modelId: options.modelId,
      workspaceDirectories: {
        "workspace:local-proof": workspaceDirectory,
        ...extraWorkspaceMappings,
      },
      workspaceCaptureQuiescence: {
        async acquire(workspaceId, captureId) {
          if (!execution)
            throw new Error("Local execution daemon is unavailable");
          execution.beginWorkspaceCapture(workspaceId, captureId);
          return {
            workspacePath: execution.workspaceDirectory(workspaceId),
            release: () => execution?.endWorkspaceCapture(captureId),
          };
        },
      },
      port: 0,
    });
  host = await openHost();
  const fixture = {
    directory,
    get host() {
      if (!host) throw new Error("Factory host is closed");
      return host;
    },
    get baseUrl() {
      return this.host.server.url.toString();
    },
    workspaceDirectory,
    async stopExecution() {
      abort?.abort();
      await runningLoop;
      runningLoop = undefined;
      abort = undefined;
      execution?.close();
      execution = undefined;
    },
    async reopenFactory() {
      await this.stopExecution();
      await host?.close();
      host = await openHost();
    },
    async close() {
      await this.stopExecution();
      await host?.close();
      host = undefined;
    },
  };
  fixtures.push(fixture);

  const bootstrapped = await call<{ credential: string }>(
    fixture.baseUrl,
    "/v1/bootstrap",
    {
      credential: bootstrapSecret,
      bootstrap: true,
      body: { name: "Local test owner" },
    },
  );
  expect(bootstrapped.status).toBe(201);
  const owner = bootstrapped.value.credential;
  const project = await call<{ projectId: string }>(
    fixture.baseUrl,
    "/v1/projects",
    {
      credential: owner,
      body: { projectId: "project:local-proof", name: "Local proof" },
    },
  );
  const node = await call<{
    node: { nodeId: string };
    credential: string;
  }>(fixture.baseUrl, "/v1/nodes", {
    credential: owner,
    body: { nodeId: "node:local-proof", name: "Temporary local executor" },
  });
  const workspace = await call<{ workspaceId: string }>(
    fixture.baseUrl,
    "/v1/workspaces",
    {
      credential: owner,
      body: {
        workspaceId: "workspace:local-proof",
        nodeId: node.value.node.nodeId,
        name: "Selected temporary workspace",
      },
    },
  );
  const mapping: WorkspaceMapping = {
    workspaceId: workspace.value.workspaceId,
    directory: workspaceDirectory,
  };
  const startExecution = async () => {
    if (execution) return;
    execution = new ExecutionDaemon({
      databasePath: join(directory, "executor.sqlite"),
      nodeId: node.value.node.nodeId,
      nodeCredential: node.value.credential,
      workspaces: [mapping],
      daemonVersion: "slice-4b-test",
    });
    abort = new AbortController();
    runningLoop = new ExecutionLoop({
      daemon: execution,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: fixture.baseUrl,
        nodeId: node.value.node.nodeId,
        credential: node.value.credential,
      }),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 500,
    }).run(abort.signal);
    await until(async () => {
      const nodes = await call<{ nodes: Array<{ availability: string }> }>(
        fixture.baseUrl,
        "/v1/nodes",
        { credential: owner },
      );
      return nodes.value.nodes[0]?.availability === "online";
    });
  };
  if (!options.deferExecutor) await startExecution();
  const thread = await call<{ threadId: string }>(
    fixture.baseUrl,
    "/v1/threads",
    {
      credential: owner,
      body: {
        threadId: "thread:local-proof",
        projectId: project.value.projectId,
        title: "Managed tool proof",
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspace.value.workspaceId,
        },
      },
    },
  );
  return Object.assign(fixture, {
    executionDaemon() {
      if (!execution) throw new Error("Execution daemon is not running");
      return execution;
    },
    owner,
    nodeId: node.value.node.nodeId,
    nodeCredential: node.value.credential,
    workspaceId: workspace.value.workspaceId,
    threadId: thread.value.threadId,
    startExecution,
  });
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("standalone local Factory managed Pi composition", () => {
  test("accepted input selects one bounded remote write and settles with persistent context and events", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "managed-result.txt",
        content: "Pi wrote this remotely",
      },
      answer: "The assigned workspace was updated.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-proof-",
    });
    const input = {
      requestId: "request:local-proof",
      text: "Update the result in my selected workspace.",
    };
    const accepted = await call<{
      jobId: string;
      dispatchStatus: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    expect(accepted.status).toBe(202);
    expect(accepted.value.dispatchStatus).toBe("queued");

    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });

    expect(
      await readFile(
        join(local.workspaceDirectory, "managed-result.txt"),
        "utf8",
      ),
    ).toBe("Pi wrote this remotely");
    expect(provider.requests()).toBeGreaterThanOrEqual(2);

    const retry = await call<{ jobId: string; dispatchStatus: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    expect(retry.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "completed",
    });
    expect(provider.requests()).toBeGreaterThanOrEqual(2);

    const context = await call<{ runtime: { messages: readonly unknown[] } }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "The assigned workspace was updated.",
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "Pi wrote this remotely",
    );
    const status = await call<{
      runtime: {
        context: { messages: readonly unknown[] };
        inspection: unknown;
      };
    }>(local.baseUrl, `/v1/threads/${local.threadId}/status`, {
      credential: local.owner,
    });
    expect(JSON.stringify(status.value.runtime.context)).toContain(
      "The assigned workspace was updated.",
    );
    const unauthorizedContext = await fetch(
      new URL(`/v1/threads/${local.threadId}/context`, local.baseUrl),
    );
    expect(unauthorizedContext.status).toBe(401);

    const events = await call<{
      events: Array<{
        type: string;
        requestId: string | null;
        payload: Record<string, unknown>;
      }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const proofEvents = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "command.accepted",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "execution.accepted",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "execution.completed",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "dispatch.completed",
    );
    expect(
      proofEvents.find((event) => event.type === "execution.completed")
        ?.payload,
    ).toMatchObject({
      target: accepted.value.target,
      ownershipGeneration: accepted.value.ownershipGeneration,
      piCallId: "call:remote-effect-1",
    });
    expect(
      proofEvents.filter((event) => event.type === "execution.accepted"),
    ).toHaveLength(1);
    expect(
      proofEvents.filter((event) => event.type === "execution.completed"),
    ).toHaveLength(1);
  });

  test("captures quiescent local managed work and restores one validated inactive bundle", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "managed-result.txt",
        content: "Pi wrote this before capture",
      },
      answer: "The managed work is settled and ready to checkpoint.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-coherent-checkpoint-",
    });
    const workspace = local.workspaceDirectory;
    git(workspace, "init", "--initial-branch=main", "--quiet");
    git(workspace, "config", "user.name", "Checkpoint test");
    git(workspace, "config", "user.email", "checkpoint@example.invalid");
    await writeFile(join(workspace, "notes.txt"), "initial note\n");
    await writeFile(join(workspace, "image.bin"), Buffer.from([0, 255, 1, 0]));
    await writeFile(join(workspace, "run.sh"), "#!/bin/sh\necho ready\n");
    await chmod(join(workspace, "run.sh"), 0o644);
    git(workspace, "add", "--all");
    git(workspace, "commit", "-m", "checkpoint base");
    await writeFile(join(workspace, "notes.txt"), "staged note\n");
    git(workspace, "add", "notes.txt");
    await writeFile(join(workspace, "notes.txt"), "staged then unstaged\n");
    await writeFile(
      join(workspace, "image.bin"),
      Buffer.from([0, 255, 2, 0, 128]),
    );
    git(workspace, "add", "image.bin");
    await writeFile(
      join(workspace, "image.bin"),
      Buffer.from([0, 255, 3, 0, 129, 0]),
    );
    await chmod(join(workspace, "run.sh"), 0o755);
    git(workspace, "add", "run.sh");
    await writeFile(
      join(workspace, "untracked.bin"),
      Buffer.from([255, 0, 254, 128]),
    );

    const input = {
      requestId: "request:coherent-capture",
      text: "Write the result and finish this managed task before capture.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    const sourceContext = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );

    const blobs = new FileBlobTransport(
      join(local.directory, "checkpoint-blobs"),
    );
    let signalFirstPut!: () => void;
    let releasePut!: () => void;
    const firstPut = new Promise<void>((resolve) => {
      signalFirstPut = resolve;
    });
    const putBlocked = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let firstWrite = true;
    const blockingTransport: BlobTransport = {
      async putBlob(bytes) {
        if (firstWrite) {
          firstWrite = false;
          signalFirstPut();
          await putBlocked;
        }
        return blobs.putBlob(bytes);
      },
      getBlob(reference) {
        return blobs.getBlob(reference);
      },
    };
    const pendingCapture = local.host.captureManagedWorkCheckpoint({
      credential: local.owner,
      threadId: local.threadId,
      transport: blockingTransport,
    });
    void pendingCapture.catch(() => {});
    await firstPut;
    let session: Awaited<ReturnType<typeof local.host.factory.authenticate>>;
    try {
      const blockedInput = await call<{ error: string }>(
        local.baseUrl,
        `/v1/threads/${local.threadId}/inputs`,
        {
          credential: local.owner,
          body: {
            requestId: "request:blocked-during-capture",
            text: "This must not enter managed work during capture.",
          },
        },
      );
      expect(blockedInput.status).toBe(409);
      expect(blockedInput.value.error).toBe("managed_work_capture_active");

      session = await local.host.factory.authenticate(local.owner);
      const thread = local.host.factory.getAuthorizedThread(
        session,
        local.threadId,
      );
      await expect(
        local.host.factory.enqueueRemoteExecution({
          contractVersion: 1,
          jobId: "job:blocked-during-capture",
          nodeId: thread.target.nodeId,
          target: thread.target,
          ownershipGeneration: thread.ownershipGeneration,
          operation: "write-file",
          path: "blocked.txt",
          contentBase64: Buffer.from("no write").toString("base64"),
        }),
      ).rejects.toThrow("Input or execution admission is blocked");
      await expect(
        local.executionDaemon().executeJob({
          contractVersion: 1,
          jobId: "job:direct-daemon-write-during-capture",
          nodeId: thread.target.nodeId,
          target: thread.target,
          ownershipGeneration: thread.ownershipGeneration,
          operation: "write-file",
          path: "blocked-local-writer.txt",
          contentBase64: Buffer.from("no local write").toString("base64"),
        }),
      ).rejects.toThrow("workspace_capture_active");
      expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(
        1,
      );
    } finally {
      releasePut();
    }
    const captured = await pendingCapture;
    session = await local.host.factory.authenticate(local.owner);
    expect(captured.manifest.format).toBe(
      "uzina-coherent-managed-work-checkpoint",
    );
    expect(captured.manifest.profile).toBe(
      "quiescent-current-documents-no-forks-v1",
    );
    expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(0);

    const capturedRecord = captured.manifest as unknown as Record<
      string,
      unknown
    >;
    const oversizedOuter = resignedBundle({
      ...capturedRecord,
      padding: "x".repeat(WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES + 128),
    });
    expect(oversizedOuter.bytes.byteLength).toBeGreaterThan(
      WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
    );
    const oversizedTransport = overlayTransport(
      blobs,
      new Map([[oversizedOuter.reference, oversizedOuter.bytes]]),
    );
    await expect(
      validateManagedWorkBundle(oversizedOuter.reference, oversizedTransport),
    ).rejects.toThrow("Managed-work bundle manifest exceeds its size limit");
    const untouchedOversizedDestination = join(
      local.directory,
      "untouched-oversized-destination",
    );
    await mkdir(untouchedOversizedDestination);
    await writeFile(join(untouchedOversizedDestination, "keep.txt"), "keep me");
    await expect(
      restoreManagedWorkBundle({
        manifestReference: oversizedOuter.reference,
        transport: oversizedTransport,
        destinationPath: untouchedOversizedDestination,
        supportedRuntimeRequirements: [
          "model:uzina-test/fixed-model",
          "tool:remote_read_file:v1",
          "tool:remote_write_file:v1",
          "tool:remote_run_command:v1",
        ],
        async openStorage() {
          throw new Error("oversized manifest must fail before storage open");
        },
      }),
    ).rejects.toThrow("Managed-work bundle manifest exceeds its size limit");
    expect(
      await readFile(join(untouchedOversizedDestination, "keep.txt"), "utf8"),
    ).toBe("keep me");

    const unknownOuter = resignedBundle({
      ...capturedRecord,
      futureField: true,
    });
    expect(unknownOuter.bytes.byteLength).toBeLessThan(
      WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
    );
    const unknownOuterTransport = overlayTransport(
      blobs,
      new Map([[unknownOuter.reference, unknownOuter.bytes]]),
    );
    await expect(
      validateManagedWorkBundle(unknownOuter.reference, unknownOuterTransport),
    ).rejects.toThrow("Unsupported or malformed coherent managed-work bundle");

    const unknownRuntime = resignedBundle({
      ...capturedRecord,
      runtime: {
        ...(capturedRecord.runtime as Record<string, unknown>),
        futureField: true,
      },
    });
    await expect(
      validateManagedWorkBundle(
        unknownRuntime.reference,
        overlayTransport(
          blobs,
          new Map([[unknownRuntime.reference, unknownRuntime.bytes]]),
        ),
      ),
    ).rejects.toThrow("Unsupported or malformed coherent managed-work bundle");

    const oversizedWorkspaceValue = {
      ...captured.manifest.workspace,
      padding: "w".repeat(WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES + 128),
    } as unknown as Record<string, unknown>;
    const oversizedWorkspaceBytes = Buffer.from(
      canonicalJson(oversizedWorkspaceValue),
      "utf8",
    );
    const oversizedWorkspaceReference = sha256(oversizedWorkspaceBytes);
    const oversizedWorkspaceOuter = resignedBundle({
      ...capturedRecord,
      workspaceManifestReference: oversizedWorkspaceReference,
    });
    await expect(
      validateManagedWorkBundle(
        oversizedWorkspaceOuter.reference,
        overlayTransport(
          blobs,
          new Map([
            [oversizedWorkspaceOuter.reference, oversizedWorkspaceOuter.bytes],
            [oversizedWorkspaceReference, oversizedWorkspaceBytes],
          ]),
        ),
      ),
    ).rejects.toThrow("Workspace manifest exceeds its size limit");

    const destinationRequirements = [
      "model:uzina-test/fixed-model",
      "tool:remote_read_file:v1",
      "tool:remote_write_file:v1",
      "tool:remote_run_command:v1",
    ];
    const validatedSource = await validateManagedWorkBundle(
      captured.manifestReference,
      blobs,
      { supportedRuntimeRequirements: destinationRequirements },
    );
    const outerCaptureRequirements = Array.from(
      { length: 36_000 },
      (_, index) =>
        `capture-${String(index).padStart(5, "0")}-${"r".repeat(235)}`,
    );
    await expect(
      captureManagedWorkBundle({
        managedWork: validatedSource.managedWork,
        compatibilityRequirements: outerCaptureRequirements,
        workspacePath: workspace,
        transport: blobs,
      }),
    ).rejects.toThrow("Managed-work bundle manifest exceeds its size limit");
    const oversizedWorkspaceRequirements = Array.from(
      { length: 75_000 },
      (_, index) =>
        `workspace-${String(index).padStart(5, "0")}-${"r".repeat(235)}`,
    );
    await expect(
      captureManagedWorkBundle({
        managedWork: validatedSource.managedWork,
        compatibilityRequirements: oversizedWorkspaceRequirements,
        workspacePath: workspace,
        transport: blobs,
      }),
    ).rejects.toThrow("Checkpoint manifest exceeds its size limit");
    await expect(
      validateManagedWorkBundle(captured.manifestReference, blobs),
    ).rejects.toThrow("Unsupported runtime requirements");
    const failedDestination = join(local.directory, "failed-destination");
    await mkdir(failedDestination);
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: failedDestination,
        supportedRuntimeRequirements: destinationRequirements,
        async openStorage() {
          throw new Error("staged runtime storage allocation failed");
        },
      }),
    ).rejects.toThrow("staged runtime storage allocation failed");
    expect(await readdir(failedDestination)).toEqual([]);

    const destination = join(local.directory, "restored-inactive");
    await mkdir(destination);
    const providerCallsBeforeRestore = provider.requests();
    let toolCalls = 0;
    const restored = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: destination,
      supportedRuntimeRequirements: destinationRequirements,
      async openStorage(path) {
        const storage = await openBunSqliteStorage(path);
        return {
          storage,
          close: () => storage.close(BACKGROUND_CONTEXT),
        };
      },
    });
    expect(restored.receipt.status).toBe("prepared-inactive");
    expect(provider.requests()).toBe(providerCallsBeforeRestore);
    expect(toolCalls).toBe(0);

    const restoredWorkspace = restored.workspacePath;
    expect(
      git(
        restoredWorkspace,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    ).toBe(git(workspace, "status", "--porcelain=v1", "--untracked-files=all"));
    expect(git(restoredWorkspace, "diff", "--cached", "--binary", "HEAD")).toBe(
      git(workspace, "diff", "--cached", "--binary", "HEAD"),
    );
    expect(git(restoredWorkspace, "diff", "--binary")).toBe(
      git(workspace, "diff", "--binary"),
    );
    expect(
      git(
        restoredWorkspace,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ),
    ).toBe(git(workspace, "for-each-ref", "--format=%(refname) %(objectname)"));
    for (const filename of [
      "notes.txt",
      "image.bin",
      "run.sh",
      "untracked.bin",
      "managed-result.txt",
    ]) {
      expect(await readFile(join(restoredWorkspace, filename))).toEqual(
        await readFile(join(workspace, filename)),
      );
    }
    expect((await stat(join(restoredWorkspace, "run.sh"))).mode & 0o111).toBe(
      (await stat(join(workspace, "run.sh"))).mode & 0o111,
    );
    const provenanceText = await readFile(
      join(destination, ".uzina", "attachments", "factory-provenance.json"),
      "utf8",
    );
    expect(provenanceText).not.toContain(local.owner);
    expect(provenanceText).not.toContain(local.nodeCredential);
    const provenance = JSON.parse(provenanceText) as {
      commands: Array<{ requestId: string; executionEffects?: unknown[] }>;
    };
    expect(provenance.commands.map((command) => command.requestId)).toContain(
      input.requestId,
    );
    expect(
      provenance.commands.find(
        (command) => command.requestId === input.requestId,
      )?.executionEffects,
    ).toHaveLength(1);

    const restoredStorage = await openBunSqliteStorage(restored.runtimePath);
    const restoredWork = await ManagedPiWork.open({
      storage: restoredStorage,
      models: provider.models,
      agent: { model: { provider: "uzina-test", modelId: "fixed-model" } },
      toolExecutor: {
        async readFile() {
          toolCalls += 1;
          return { content: "", truncated: false };
        },
        async writeFile() {
          toolCalls += 1;
        },
        async runCommand() {
          toolCalls += 1;
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            outputTruncated: false,
          };
        },
      },
    });
    try {
      expect(await restoredWork.context()).toEqual(
        sourceContext.value.runtime as never,
      );
      const importedReceipt = await restoredWork.submission(input.requestId);
      expect(importedReceipt).toBeDefined();
      const duplicate = await restoredWork.submit(input.requestId, input.text);
      expect(duplicate.submissionId).toBe(importedReceipt!.id);
      expect(provider.requests()).toBe(providerCallsBeforeRestore);
      expect(toolCalls).toBe(0);
    } finally {
      await restoredWork.close();
    }

    let retryStorageOpens = 0;
    const openPreparedStorage = async (path: string) => {
      retryStorageOpens += 1;
      const storage = await openBunSqliteStorage(path);
      return {
        storage,
        close: () => storage.close(BACKGROUND_CONTEXT),
      };
    };
    const providerCallsAfterRestore = provider.requests();
    const retried = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: destination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    expect(retried.receipt).toEqual(restored.receipt);
    expect(retryStorageOpens).toBe(1);
    expect(provider.requests()).toBe(providerCallsAfterRestore);
    expect(toolCalls).toBe(0);

    const unexpectedLargePath = join(
      restoredWorkspace,
      "unexpected-oversized.bin",
    );
    const originalNotesBytes = await readFile(
      join(restoredWorkspace, "notes.txt"),
    );
    const receiptPath = join(destination, ".uzina", "prepared-restore.json");
    const originalReceiptBytes = await readFile(receiptPath);
    const unexpectedLargeFile = await open(unexpectedLargePath, "w");
    try {
      await unexpectedLargeFile.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await unexpectedLargeFile.close();
    }
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: destination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow("Prepared workspace contains omitted entries");
    expect((await stat(unexpectedLargePath)).size).toBe(64 * 1024 * 1024 + 1);
    expect(await readFile(join(restoredWorkspace, "notes.txt"))).toEqual(
      originalNotesBytes,
    );
    expect(await readFile(receiptPath)).toEqual(originalReceiptBytes);
    expect(provider.requests()).toBe(providerCallsAfterRestore);
    expect(toolCalls).toBe(0);
    await rm(unexpectedLargePath, { force: true });

    const originalWorkspaceBytes = await readFile(
      join(destination, "workspace", "notes.txt"),
    );
    const changedWorkspaceBytes = "x".repeat(originalWorkspaceBytes.byteLength);
    await writeFile(
      join(destination, "workspace", "notes.txt"),
      changedWorkspaceBytes,
    );
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: destination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow("Prepared workspace entry integrity mismatch: notes.txt");
    expect(
      await readFile(join(destination, "workspace", "notes.txt"), "utf8"),
    ).toBe(changedWorkspaceBytes);

    const modeDestination = join(local.directory, "tampered-mode-restore");
    const modeRestore = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: modeDestination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    await chmod(join(modeRestore.workspacePath, "run.sh"), 0o644);
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: modeDestination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow("Prepared workspace entry changed: run.sh");
    expect(
      (await stat(join(modeRestore.workspacePath, "run.sh"))).mode & 0o111,
    ).toBe(0);

    const indexDestination = join(local.directory, "tampered-index-restore");
    const indexRestore = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: indexDestination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    git(
      indexRestore.workspacePath,
      "update-index",
      "--assume-unchanged",
      "notes.txt",
    );
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: indexDestination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow(
      "Assume-unchanged and skip-worktree index entries are not supported",
    );
    expect(
      git(indexRestore.workspacePath, "ls-files", "-v", "notes.txt"),
    ).toMatch(/^h /);

    const runtimeDestination = join(
      local.directory,
      "tampered-runtime-restore",
    );
    const runtimeRestore = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: runtimeDestination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    const runtimeDatabase = new Database(runtimeRestore.runtimePath);
    const entryRow = runtimeDatabase
      .query<{ id: number; record: string }, []>(
        "SELECT id, record FROM entries ORDER BY id LIMIT 1",
      )
      .get();
    expect(entryRow).toBeDefined();
    const changedEntry = JSON.parse(entryRow!.record) as Record<
      string,
      unknown
    >;
    changedEntry.kind = `${String(changedEntry.kind)}-tampered`;
    runtimeDatabase
      .query("UPDATE entries SET record = ? WHERE id = ?")
      .run(JSON.stringify(changedEntry), entryRow!.id);
    runtimeDatabase.close();
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: runtimeDestination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow("Prepared managed-work runtime does not match bundle");
    const preservedRuntimeDatabase = new Database(runtimeRestore.runtimePath);
    expect(
      JSON.parse(
        preservedRuntimeDatabase
          .query<{ record: string }, [number]>(
            "SELECT record FROM entries WHERE id = ?",
          )
          .get(entryRow!.id)!.record,
      ).kind,
    ).toBe(changedEntry.kind);
    preservedRuntimeDatabase.close();

    const attachmentDestination = join(
      local.directory,
      "tampered-attachment-restore",
    );
    await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: attachmentDestination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    const attachmentPath = join(
      attachmentDestination,
      ".uzina",
      "attachments",
      "factory-provenance.json",
    );
    const preparedReceiptPath = join(
      attachmentDestination,
      ".uzina",
      "prepared-restore.json",
    );
    const preparedReceiptBytes = await readFile(preparedReceiptPath);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const oversizedAttachmentBytes = 32 * 1024 * 1024 + 1;
      const attachmentHandle = await open(attachmentPath, "w");
      try {
        await attachmentHandle.truncate(oversizedAttachmentBytes);
      } finally {
        await attachmentHandle.close();
      }
      await chmod(attachmentPath, 0);
      try {
        await expect(
          restoreManagedWorkBundle({
            manifestReference: captured.manifestReference,
            transport: blobs,
            destinationPath: attachmentDestination,
            supportedRuntimeRequirements: destinationRequirements,
            openStorage: openPreparedStorage,
          }),
        ).rejects.toThrow(
          "Prepared attachment size mismatch: factory-provenance.json",
        );
        expect((await stat(attachmentPath)).size).toBe(
          oversizedAttachmentBytes,
        );
      } finally {
        await chmod(attachmentPath, 0o600);
      }
    } else {
      // Root bypasses POSIX mode bits; keep only the ordinary content-corruption control here.
      const changedAttachmentBytes = "tampered provenance\n";
      await writeFile(attachmentPath, changedAttachmentBytes);
      await expect(
        restoreManagedWorkBundle({
          manifestReference: captured.manifestReference,
          transport: blobs,
          destinationPath: attachmentDestination,
          supportedRuntimeRequirements: destinationRequirements,
          openStorage: openPreparedStorage,
        }),
      ).rejects.toThrow(
        "Prepared attachment integrity mismatch: factory-provenance.json",
      );
      expect(await readFile(attachmentPath, "utf8")).toBe(
        changedAttachmentBytes,
      );
    }
    expect(await readFile(preparedReceiptPath)).toEqual(preparedReceiptBytes);
    expect(provider.requests()).toBe(providerCallsAfterRestore);
    expect(toolCalls).toBe(0);
  });

  test("capture preflight rejects symlink aliases before invoking the writer quiescence adapter", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-alias-",
      deferExecutor: true,
      extraWorkspaceAliases: ["workspace:alias"],
    });
    await expect(
      local.host.captureManagedWorkCheckpoint({
        credential: local.owner,
        threadId: local.threadId,
        transport: new FileBlobTransport(join(local.directory, "unused-blobs")),
      }),
    ).rejects.toThrow("overlaps a local directory with workspace:alias");
    const session = await local.host.factory.authenticate(local.owner);
    expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(0);
  });

  test("capture preflight rejects canonical ancestor and descendant workspaces", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-nested-roots-",
      deferExecutor: true,
      extraWorkspaceSubdirectories: {
        "workspace:nested": "nested-workspace",
      },
    });
    await expect(
      local.host.captureManagedWorkCheckpoint({
        credential: local.owner,
        threadId: local.threadId,
        transport: new FileBlobTransport(join(local.directory, "unused-blobs")),
      }),
    ).rejects.toThrow("overlaps a local directory with workspace:nested");
    const session = await local.host.factory.authenticate(local.owner);
    expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(0);
  });

  test("refuses unavailable and uncertain work instead of pausing it", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-uncertain-",
      deferExecutor: true,
    });
    const session = await local.host.factory.authenticate(local.owner);
    await local.host.factory.submitInput(
      session,
      local.threadId,
      "request:queued-for-capture",
      "This remains unavailable and must block capture.",
    );
    expect(() =>
      local.host.factory.beginManagedWorkCapture(session, local.threadId),
    ).toThrow("unsettled unavailable input receipt");
    expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(0);

    const uncertain = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-uncertain-dispatch-",
    });
    const uncertainSession = await uncertain.host.factory.authenticate(
      uncertain.owner,
    );
    const accepted = await uncertain.host.factory.submitInput(
      uncertainSession,
      uncertain.threadId,
      "request:uncertain-capture",
      "An interrupted adapter outcome must block capture.",
    );
    expect(accepted.dispatchStatus).toBe("queued");
    let signalDispatch!: () => void;
    let releaseDispatch!: () => void;
    const enteredDispatch = new Promise<void>((resolve) => {
      signalDispatch = resolve;
    });
    const holdDispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const runningDispatch = uncertain.host.factory.dispatchNext({
      async dispatch() {
        signalDispatch();
        await holdDispatch;
        return { status: "uncertain", detail: "adapter outcome is uncertain" };
      },
    });
    await enteredDispatch;
    try {
      expect(() =>
        uncertain.host.factory.beginManagedWorkCapture(
          uncertainSession,
          uncertain.threadId,
        ),
      ).toThrow("unsettled running input receipt");
    } finally {
      releaseDispatch();
    }
    const receipt = await runningDispatch;
    expect(receipt?.dispatchStatus).toBe("uncertain");
    expect(() =>
      uncertain.host.factory.beginManagedWorkCapture(
        uncertainSession,
        uncertain.threadId,
      ),
    ).toThrow("unsettled uncertain input receipt");
    expect(
      uncertain.host.factory.listManagedWorkCaptures(uncertainSession),
    ).toHaveLength(0);
  });

  test("refuses shared workspaces and keeps a capture fence durable across restart", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-restart-",
      deferExecutor: true,
    });
    const session = await local.host.factory.authenticate(local.owner);
    local.host.factory.createThread(session, {
      projectId: "project:local-proof",
      title: "Second thread sharing workspace",
      target: { nodeId: local.nodeId, workspaceId: local.workspaceId },
    });
    expect(() =>
      local.host.factory.beginManagedWorkCapture(session, local.threadId),
    ).toThrow("requires an exclusive workspace");

    const exclusive = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-durable-lock-",
      deferExecutor: true,
    });
    const ownerSession = await exclusive.host.factory.authenticate(
      exclusive.owner,
    );
    const capture = exclusive.host.factory.beginManagedWorkCapture(
      ownerSession,
      exclusive.threadId,
    );
    await exclusive.reopenFactory();
    const reopenedSession = await exclusive.host.factory.authenticate(
      exclusive.owner,
    );
    expect(
      exclusive.host.factory.listManagedWorkCaptures(reopenedSession),
    ).toEqual([
      expect.objectContaining({
        capture_id: capture.captureId,
        thread_id: exclusive.threadId,
        workspace_id: exclusive.workspaceId,
      }),
    ]);
    await expect(
      exclusive.host.factory.submitInput(
        reopenedSession,
        exclusive.threadId,
        "request:blocked-after-restart",
        "The durable capture lock remains active.",
      ),
    ).rejects.toThrow("Input or execution admission is blocked");
    exclusive.host.factory.endManagedWorkCapture(
      reopenedSession,
      capture.captureId,
    );
    expect(
      exclusive.host.factory.listManagedWorkCaptures(reopenedSession),
    ).toHaveLength(0);
  });

  test("rejects model-selected node, workspace and generation instead of changing accepted placement", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "forged-placement.txt",
        content: "must not execute",
        nodeId: "node:other",
        workspaceId: "workspace:other",
        ownershipGeneration: 99,
      },
      answer: "The model-selected destination was rejected.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-placement-reject-",
    });
    const input = {
      requestId: "request:placement-rejected",
      text: "Write a file but do not change the selected destination.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "forged-placement.txt"),
        "utf8",
      ).catch(() => null),
    ).toBeNull();
    const events = await call<{
      events: Array<{ type: string; requestId: string | null }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const related = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(related.map((event) => event.type)).not.toContain(
      "execution.accepted",
    );
  });

  test("a real provider failure settles a persistent command as failed without inventing an executor effect", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-model-failure-",
    });
    const input = {
      requestId: "request:model-failure",
      text: "The selected provider will fail before choosing a tool.",
    };
    const accepted = await call<{ jobId: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "failed";
    });
    const receipt = await call<{
      jobId: string;
      dispatchStatus: string;
      outcome?: string;
    }>(local.baseUrl, `/v1/commands/${input.requestId}`, {
      credential: local.owner,
    });
    expect(receipt.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "failed",
    });
    const events = await call<{
      events: Array<{ type: string; requestId: string | null }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const modelEvents = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(modelEvents.map((event) => event.type)).toContain("dispatch.failed");
    expect(modelEvents.map((event) => event.type)).not.toContain(
      "execution.accepted",
    );
    const context = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "deterministic provider failure",
    );
  });

  test("reports node-side argv truncation when returned stdout exactly meets the limit", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: [process.execPath, "-e", 'process.stdout.write("ABCDEFGHIJK")'],
        timeoutMs: 5_000,
        maxOutputBytes: 8,
      },
      answer: "The bounded command completed.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-truncated-output-",
    });
    const input = {
      requestId: "request:truncated-output",
      text: "Run the bounded command and report its output.",
    };
    const accepted = await call<{ dispatchStatus: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    expect(accepted.value.dispatchStatus).toBe("queued");

    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    const receipt = await call<{
      executionEffects: Array<{
        result?: {
          operation?: string;
          stdout?: string;
          outputTruncated?: boolean;
        };
      }>;
    }>(local.baseUrl, `/v1/commands/${input.requestId}`, {
      credential: local.owner,
    });
    expect(
      receipt.value.executionEffects.find(
        (effect) => effect.result?.operation === "argv-command",
      )?.result,
    ).toMatchObject({ stdout: "ABCDEFGH", outputTruncated: true });

    const context = await call<{
      runtime: {
        entries: Array<{
          model?: Array<{
            content?: Array<{ type: string; text?: string }>;
          }>;
        }>;
      };
    }>(local.baseUrl, `/v1/threads/${local.threadId}/context`, {
      credential: local.owner,
    });
    const toolText = context.value.runtime.entries
      .flatMap((entry) => entry.model ?? [])
      .flatMap((message) => message.content ?? [])
      .find(
        (part) => part.type === "text" && part.text?.includes("truncated"),
      )?.text;
    expect(JSON.parse(toolText ?? "null")).toMatchObject({
      stdout: "ABCDEFGH",
      truncated: true,
    });
  });

  test("reopens and drains a persisted accepted input without another input request", async () => {
    const outputPath = "startup-recovered.txt";
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(outputPath)}, "startup recovered")`,
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 64,
      },
      answer: "The startup command completed.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-startup-drain-",
    });
    const input = {
      requestId: "request:startup-drain",
      text: "Run the startup recovery command.",
    };
    const session = await local.host.factory.authenticate(local.owner);
    const accepted = await local.host.factory.submitInput(
      session,
      local.threadId,
      input.requestId,
      input.text,
    );
    expect(accepted.dispatchStatus).toBe("queued");

    await local.reopenFactory();
    let startupReceipt: { dispatchStatus: string } | undefined;
    const startupDeadline = Date.now() + 1_000;
    while (Date.now() < startupDeadline) {
      startupReceipt = (
        await call<{ dispatchStatus: string }>(
          local.baseUrl,
          `/v1/commands/${input.requestId}`,
          { credential: local.owner },
        )
      ).value;
      if (startupReceipt.dispatchStatus !== "queued") break;
      await Bun.sleep(10);
    }
    expect(startupReceipt?.dispatchStatus).toBe("running");
    await local.startExecution();
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(join(local.workspaceDirectory, outputPath), "utf8"),
    ).toBe("startup recovered");

    await local.reopenFactory();
    const context = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "The startup command completed.",
    );
  });

  test("wakes unavailable accepted work when its node registers after host startup", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "node-recovered.txt",
        content: "node came online",
      },
      answer: "The node recovered the accepted input.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-node-wake-",
      deferExecutor: true,
    });
    const input = {
      requestId: "request:node-wake",
      text: "Write the result after the executor comes online.",
    };
    const session = await local.host.factory.authenticate(local.owner);
    const accepted = await local.host.factory.submitInput(
      session,
      local.threadId,
      input.requestId,
      input.text,
    );
    expect(accepted.dispatchStatus).toBe("unavailable");

    await local.startExecution();
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "node-recovered.txt"),
        "utf8",
      ),
    ).toBe("node came online");
  });

  test("a timed-out command keeps its actual partial cwd effect and uncertain receipt after reopen", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: [
          "/bin/sh",
          "-c",
          "printf before > partial-effect.txt; sleep 5; printf after >> partial-effect.txt",
        ],
        cwd: "subdir",
        timeoutMs: 500,
      },
      answer: "The command outcome requires reconciliation.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-command-uncertain-",
    });
    await mkdir(join(local.workspaceDirectory, "subdir"));
    const input = {
      requestId: "request:command-uncertain",
      text: "Run the bounded command in the selected relative directory.",
    };
    const accepted = await call<{ jobId: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "uncertain";
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "subdir", "partial-effect.txt"),
        "utf8",
      ),
    ).toBe("before");
    await local.reopenFactory();
    const recovered = await call<{
      jobId: string;
      dispatchStatus: string;
      outcome?: string;
      executionEffects: Array<{
        jobId: string;
        status: string;
        operation: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
        errorCode?: string;
      }>;
    }>(local.baseUrl, `/v1/commands/${input.requestId}`, {
      credential: local.owner,
    });
    expect(recovered.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "uncertain",
      executionEffects: [
        {
          status: "uncertain",
          operation: "argv-command",
          target: { nodeId: local.nodeId, workspaceId: local.workspaceId },
          ownershipGeneration: 0,
          errorCode: "command_timed_out",
        },
      ],
    });
    const context = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "The command outcome requires reconciliation.",
    );
    expect(
      await readFile(
        join(local.workspaceDirectory, "subdir", "partial-effect.txt"),
        "utf8",
      ),
    ).toBe("before");
  });

  test("rejects a model-selected cwd escape before a workspace effect", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: ["/bin/sh", "-c", "printf escaped > escaped.txt"],
        cwd: "../outside",
      },
      answer: "The requested working directory was rejected.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-command-cwd-reject-",
    });
    const outsideDirectory = join(local.directory, "outside");
    await mkdir(outsideDirectory);
    const input = {
      requestId: "request:cwd-rejected",
      text: "Run the command outside this workspace.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(join(outsideDirectory, "escaped.txt")).catch(() => null),
    ).toBeNull();
    const events = await call<{
      events: Array<{
        type: string;
        requestId: string | null;
        payload: Record<string, unknown>;
      }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    expect(
      events.value.events.find(
        (event) =>
          event.type === "execution.failed" &&
          event.requestId === input.requestId,
      )?.payload,
    ).toMatchObject({ errorCode: "unsafe_workspace_path" });
  });
});
