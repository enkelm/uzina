import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  watch,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { buildCloudflareWorkerArtifact } from "../scripts/build-worker";
import {
  FileBlobTransport,
  restoreManagedWorkBundle,
  restoreWorkspaceCheckpoint,
  validateManagedWorkBundle,
  type BlobTransport,
  type WorkspaceCheckpointManifest,
} from "@uzina/checkpoints";
import {
  composeManagedWorkBundleFromWorkspace,
  prepareManagedWorkBundleComposition,
} from "@uzina/checkpoints/managed-work-composition";
import {
  MANAGED_WORK_RUNTIME_REQUIREMENTS,
  type ManagedWorkBundleManifest,
  type ManagedWorkCheckpointArtifactReference,
} from "@uzina/checkpoints/managed-work-composition";
import { portableWorkspaceBlobReferences } from "@uzina/checkpoints/portable";
import type { FactoryProvenanceEvidence } from "@uzina/contracts/factory";
import {
  importManagedWorkCheckpoint,
  validateManagedWorkCheckpoint,
  verifyManagedWorkCheckpointStorage,
  type ManagedWorkCheckpoint,
} from "@uzina/pi-runtime/checkpoint";
import {
  ROOT_CONVERSATION_ID,
  type DocumentRecord,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openBunSqliteStorage } from "../../daemon/src/runtime/sqlite";
import { ExecutionDaemon } from "../../daemon/src/execution/daemon";
import {
  ControllerTransportError,
  HttpExecutionControllerConnector,
  type ExecutionControllerConnector,
} from "../../daemon/src/execution/connector";
import { ExecutionLoop } from "../../daemon/src/execution/loop";

type Fixture = {
  directory: string;
  miniflare: Miniflare;
  close(): Promise<void>;
};
const fixtures: Fixture[] = [];

type WorkerdId = { toString(): string };
type ManagedWorkNamespace = {
  idFromName(name: string): WorkerdId;
};
type FactoryNamespace = {
  idFromName(name: string): WorkerdId;
};
type PublicStorageObservation = Pick<
  ManagedWorkCheckpoint,
  "conversations" | "entries" | "tasks" | "submissions" | "documents"
> & { sessionDocuments: DocumentRecord[] };

type ManagedWorkTestOperation =
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

async function call<T>(
  baseUrl: string,
  path: string,
  options: { credential?: string; bootstrap?: boolean; body?: unknown } = {},
): Promise<{ response: Response; value: T }> {
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
  const body = await response.text();
  let value: T;
  try {
    value = JSON.parse(body) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${path} (${response.status}), received: ${body.slice(0, 240)}`,
    );
  }
  return { response, value };
}

async function fetchAndConsume(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<number> {
  const response = await fetch(input, init);
  const status = response.status;
  await response.arrayBuffer();
  return status;
}

async function forwardAndDiscardResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<number> {
  const response = await fetch(input, init);
  const status = response.status;
  await response.body?.cancel();
  return status;
}

type RelocationReplyDrop = {
  method: "claimWorkspaceRelocation" | "reportWorkspaceRelocation";
  matches(result: unknown, args: unknown[]): boolean;
  afterForward(): Promise<void>;
};

function withDroppedRelocationReplies(
  controller: ExecutionControllerConnector,
  drops: readonly RelocationReplyDrop[],
): ExecutionControllerConnector {
  const dropped = new Set<number>();
  const dropIfConfigured = async (
    method: string | symbol,
    result: unknown,
    args: unknown[],
  ): Promise<void> => {
    const index = drops.findIndex(
      (drop, candidate) =>
        !dropped.has(candidate) &&
        method === drop.method &&
        drop.matches(result, args),
    );
    if (index >= 0) {
      dropped.add(index);
      await drops[index]!.afterForward();
      throw new ControllerTransportError();
    }
  };
  return new Proxy(controller, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (property === "claimWorkspaceRelocation") {
        return async () => {
          const result = await target.claimWorkspaceRelocation();
          await dropIfConfigured(property, result, []);
          return result;
        };
      }
      if (property === "reportWorkspaceRelocation") {
        return async (report: unknown) => {
          await target.reportWorkspaceRelocation(report);
          await dropIfConfigured(property, undefined, [report]);
        };
      }
      return method.bind(target);
    },
  });
}

function withInterruptedFirstWorkspaceBlob(
  controller: ExecutionControllerConnector,
  waitBeforeFailure: () => Promise<void>,
  onFailureBoundary: () => void,
  onResponse: (reference: string, size: number) => void,
): ExecutionControllerConnector {
  let interrupted = false;
  return new Proxy(controller, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (property !== "fetchWorkspaceRelocationBlob") {
        return method.bind(target);
      }
      return async (relocationId: string, reference: string) => {
        const response = await target.fetchWorkspaceRelocationBlob(
          relocationId,
          reference,
        );
        onResponse(reference, response.size);
        if (interrupted) return response;
        interrupted = true;
        const source = response.body.getReader();
        let partialDelivered = false;
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(stream) {
              if (!partialDelivered) {
                let part = await source.read();
                while (!part.done && part.value.byteLength === 0) {
                  part = await source.read();
                }
                if (part.done) {
                  stream.close();
                  return;
                }
                partialDelivered = true;
                stream.enqueue(part.value.subarray(0, 64).slice());
                return;
              }
              onFailureBoundary();
              await waitBeforeFailure();
              await source.cancel().catch(() => {});
              stream.error(new ControllerTransportError());
            },
            async cancel(reason) {
              await source.cancel(reason).catch(() => {});
            },
          },
          { highWaterMark: 0 },
        );
        return { body, size: response.size };
      };
    },
  });
}

function withCapturedRetryClaim(
  controller: ExecutionControllerConnector,
  abort: AbortController,
  shouldCapture: () => boolean,
  capture: (claim: unknown) => void,
): ExecutionControllerConnector {
  let captured = false;
  return new Proxy(controller, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (property !== "claimWorkspaceRelocation") return method.bind(target);
      return async () => {
        const result = await target.claimWorkspaceRelocation();
        if (result && shouldCapture() && !captured) {
          captured = true;
          capture(result);
          abort.abort();
        }
        return result;
      };
    },
  });
}

async function waitForCreatedFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  const abort = new AbortController();
  const watcher = watch(dirname(path), { signal: abort.signal });
  const observed = (async () => {
    for await (const event of watcher) {
      if (
        event.filename !== null &&
        String(event.filename) === basename(path) &&
        existsSync(path)
      ) {
        return;
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      observed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${basename(path)}`)),
          20_000,
        );
      }),
    ]);
    if (!existsSync(path)) throw new Error(`Expected ${path} to exist`);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    await observed.catch(() => {});
  }
}

async function assertBlockedRelocationPreflight(options: {
  databasePath: string;
  nodeId: string;
  nodeCredential: string;
  claim: unknown;
  expectedErrorCode: string;
  workspaces: Array<{
    workspaceId: string;
    directory: string;
    ownershipGeneration?: number;
  }>;
  snapshotCacheDirectory?: string;
  beforeExecute?: () => Promise<void>;
}): Promise<void> {
  const daemon = new ExecutionDaemon({
    databasePath: options.databasePath,
    nodeId: options.nodeId,
    nodeCredential: options.nodeCredential,
    workspaces: options.workspaces,
    ...(options.snapshotCacheDirectory
      ? { snapshotCacheDirectory: options.snapshotCacheDirectory }
      : {}),
  });
  try {
    await options.beforeExecute?.();
    const report = await daemon.executeWorkspaceRelocation(
      options.claim,
      async () => {
        throw new Error("A refused relocation must not fetch blobs");
      },
    );
    expect(report).toMatchObject({
      status: "blocked",
      errorCode: options.expectedErrorCode,
    });
  } finally {
    daemon.close();
  }
}

function startWorkspaceRelocationChild(env: Record<string, string>) {
  return Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "workspace-relocation-recovery-child.ts"),
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
}

async function stopOwnedProcessGroup(
  child: ReturnType<typeof startWorkspaceRelocationChild>,
): Promise<void> {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await child.exited.catch(() => {});
}

function managedWorkCall<T>(
  baseUrl: string,
  threadId: string,
  operation: ManagedWorkTestOperation,
) {
  return call<T>(baseUrl, "/__test/managed-work", {
    body: { threadId, operation },
  });
}

function providerConfiguration(
  baseUrl: string,
  mode: "deterministic" | "reconfigured" | "unusable",
) {
  return call<{ mode: string }>(baseUrl, "/__test/provider-configuration", {
    body: { mode },
  });
}

function runtimeOptionsBarrier(
  baseUrl: string,
  action: "hold" | "release" | "entered",
) {
  return call<{ entered: boolean }>(
    baseUrl,
    "/__test/runtime-options-barrier",
    { body: { action } },
  );
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the workerd workspace snapshot");
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

async function workspaceEffectState(
  directory: string,
): Promise<Array<{ path: string; mode: number; content: string }>> {
  const files: Array<{ path: string; mode: number; content: string }> = [];
  const visit = async (root: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const absolute = join(root, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(absolute, path);
      } else if (entry.isSymbolicLink()) {
        files.push({
          path,
          mode: 0o120000,
          content: await readlink(absolute),
        });
      } else if (entry.isFile()) {
        const [bytes, metadata] = await Promise.all([
          readFile(absolute),
          stat(absolute),
        ]);
        files.push({
          path,
          mode: metadata.mode & 0o777,
          content: bytes.toString("base64"),
        });
      }
    }
  };
  await visit(directory, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function makeDirtyGitWorkspace(directory: string): Promise<void> {
  await mkdir(directory);
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.name", "Workerd snapshot fixture");
  git(directory, "config", "user.email", "snapshot@example.invalid");
  await writeFile(join(directory, "tracked.txt"), "base\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-m", "base");
  await writeFile(join(directory, "tracked.txt"), "staged content\n");
  git(directory, "add", "tracked.txt");
  await writeFile(join(directory, "tracked.txt"), "unstaged content\n");
  await writeFile(join(directory, "binary"), new Uint8Array([0, 255, 17, 128]));
  await chmod(join(directory, "binary"), 0o755);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("workspace snapshot transport in production-shaped workerd + R2", () => {
  test("fences, captures Git state on the node, uploads scoped R2 objects, and prepares an inactive workspace", async () => {
    const expectedSourceRuntimeRequirements = [
      "model:uzina-capture-test/capture-test-model",
      "tool:remote_read_file:v1",
      "tool:remote_write_file:v1",
      "tool:remote_run_command:v1",
    ];
    const expectedRuntimeRequirements = [
      ...MANAGED_WORK_RUNTIME_REQUIREMENTS,
      ...expectedSourceRuntimeRequirements,
    ];
    const directory = await mkdtemp(join(tmpdir(), "uzina-workerd-snapshot-"));
    const workspace = join(directory, "workspace");
    const recoveryWorkspace = join(directory, "workspace-lost-export-ack");
    const durableObjectsPath = join(directory, "durable-objects");
    const r2Path = join(directory, "r2");
    await makeDirtyGitWorkspace(workspace);
    await makeDirtyGitWorkspace(recoveryWorkspace);
    const workerArtifact = await buildCloudflareWorkerArtifact(
      join(import.meta.dir, "capture-aware-workerd-entry.ts"),
    );
    const createMiniflare = (
      testState: {
        holdPublication?: boolean;
        holdPrivateReadRequestId?: string;
        holdPrivateReadMode?: "first-read" | "second-read";
        forbidExportThreadId?: string;
      } = {},
    ) =>
      new Miniflare({
        name: "uzina-workspace-snapshot",
        script: workerArtifact.script,
        modules: true,
        compatibilityDate: "2026-05-01",
        host: "127.0.0.1",
        port: 0,
        bindings: {
          UZINA_BOOTSTRAP_SECRET: "snapshot-workerd-bootstrap",
          UZINA_TEST_HOLD_CHECKPOINT_PUBLICATION: testState.holdPublication
            ? "true"
            : "false",
          UZINA_TEST_HOLD_PRIVATE_READ_REQUEST_ID:
            testState.holdPrivateReadRequestId ?? "",
          UZINA_TEST_HOLD_PRIVATE_READ_MODE:
            testState.holdPrivateReadMode ?? "first-read",
          UZINA_TEST_FORBID_CHECKPOINT_EXPORT_THREAD_ID:
            testState.forbidExportThreadId ?? "",
        },
        durableObjects: {
          FACTORY: { className: "CaptureTestFactory", useSQLite: true },
          MANAGED_WORK: {
            className: "CaptureTestManagedWork",
            useSQLite: true,
          },
        },
        durableObjectsPersist: durableObjectsPath,
        r2Buckets: ["CHECKPOINTS"],
        r2Persist: r2Path,
      });
    let miniflare = createMiniflare();
    let daemon: ExecutionDaemon | undefined;
    let abort: AbortController | undefined;
    let loop: Promise<void> | undefined;
    let destinationDaemon: ExecutionDaemon | undefined;
    let destinationAbort: AbortController | undefined;
    let destinationLoop: Promise<void> | undefined;
    const fixture: Fixture = {
      directory,
      miniflare,
      async close() {
        abort?.abort();
        destinationAbort?.abort();
        await Promise.all([
          loop?.catch(() => {}),
          destinationLoop?.catch(() => {}),
        ]);
        daemon?.close();
        destinationDaemon?.close();
        await miniflare.dispose();
      },
    };
    fixtures.push(fixture);
    let baseUrl = (await miniflare.ready).toString();
    const bootstrap = await call<{ credential: string }>(
      baseUrl,
      "/v1/bootstrap",
      {
        credential: "snapshot-workerd-bootstrap",
        bootstrap: true,
        body: { name: "Snapshot owner" },
      },
    );
    const owner = bootstrap.value.credential;
    expect(bootstrap.response.status).toBe(201);
    const project = await call<{ projectId: string }>(baseUrl, "/v1/projects", {
      credential: owner,
      body: { projectId: "project:workspace-snapshot", name: "Snapshot proof" },
    });
    const node = await call<{ node: { nodeId: string }; credential: string }>(
      baseUrl,
      "/v1/nodes",
      {
        credential: owner,
        body: { nodeId: "node:snapshot-workerd", name: "Snapshot node" },
      },
    );
    const workspaceRecord = await call<{ workspaceId: string }>(
      baseUrl,
      "/v1/workspaces",
      {
        credential: owner,
        body: {
          workspaceId: "workspace:snapshot-workerd",
          nodeId: node.value.node.nodeId,
          name: "Git workspace",
        },
      },
    );
    const recoveryWorkspaceRecord = await call<{ workspaceId: string }>(
      baseUrl,
      "/v1/workspaces",
      {
        credential: owner,
        body: {
          workspaceId: "workspace:lost-export-ack",
          nodeId: node.value.node.nodeId,
          name: "Lost export acknowledgement workspace",
        },
      },
    );
    const startExecutionLoop = () => {
      const runningDaemon = new ExecutionDaemon({
        databasePath: join(directory, "node.sqlite"),
        nodeId: node.value.node.nodeId,
        nodeCredential: node.value.credential,
        workspaces: [
          {
            workspaceId: workspaceRecord.value.workspaceId,
            directory: workspace,
          },
          {
            workspaceId: recoveryWorkspaceRecord.value.workspaceId,
            directory: recoveryWorkspace,
          },
        ],
      });
      daemon = runningDaemon;
      abort = new AbortController();
      loop = new ExecutionLoop({
        daemon: runningDaemon,
        controller: new HttpExecutionControllerConnector({
          controllerUrl: baseUrl,
          nodeId: node.value.node.nodeId,
          credential: node.value.credential,
        }),
        pollIntervalMs: 20,
        heartbeatIntervalMs: 500,
      }).run(abort.signal);
    };
    const stopExecutionLoop = async () => {
      abort?.abort();
      await loop?.catch(() => {});
      loop = undefined;
      abort = undefined;
      daemon?.close();
      daemon = undefined;
    };
    const waitForNodeOnline = () =>
      until(async () => {
        const nodes = await call<{ nodes: Array<{ availability: string }> }>(
          baseUrl,
          "/v1/nodes",
          { credential: owner },
        );
        return nodes.value.nodes[0]?.availability === "online";
      });
    startExecutionLoop();
    await waitForNodeOnline();
    const thread = await call<{
      threadId: string;
      ownershipGeneration: number;
    }>(baseUrl, "/v1/threads", {
      credential: owner,
      body: {
        threadId: "thread:workspace-snapshot",
        projectId: project.value.projectId,
        title: "Workspace-only snapshot",
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspaceRecord.value.workspaceId,
        },
      },
    });
    const recoveryThread = await call<{
      threadId: string;
      ownershipGeneration: number;
    }>(baseUrl, "/v1/threads", {
      credential: owner,
      body: {
        threadId: "thread:lost-export-ack",
        projectId: project.value.projectId,
        title: "Lost export acknowledgement recovery",
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: recoveryWorkspaceRecord.value.workspaceId,
        },
      },
    });
    const recoveryInputRequestId = "request:lost-export-ack-seed";
    const recoveryInput = await call<{ requestId: string }>(
      baseUrl,
      `/v1/threads/${recoveryThread.value.threadId}/inputs`,
      {
        credential: owner,
        body: {
          requestId: recoveryInputRequestId,
          text: "Seed a second real managed Pi root for recovery proof.",
        },
      },
    );
    expect(recoveryInput.response.status).toBe(202);
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        baseUrl,
        `/v1/commands/${recoveryInputRequestId}`,
        { credential: owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    const recoveryThreadClose = await managedWorkCall<string>(
      baseUrl,
      recoveryThread.value.threadId,
      { kind: "close" },
    );
    expect(recoveryThreadClose.value).toBe("resolved");
    const inputRequestId = "request:workerd-capture-seed";
    await call(baseUrl, "/__test/model-response", {
      body: { action: "hold", threadId: thread.value.threadId },
    });
    await call(baseUrl, "/__test/model-response", {
      body: {
        action: "arm-read-failure",
        threadId: thread.value.threadId,
      },
    });
    const acceptedInput = await call<{ requestId: string }>(
      baseUrl,
      `/v1/threads/${thread.value.threadId}/inputs`,
      {
        credential: owner,
        body: {
          requestId: inputRequestId,
          text: "Capture the settled managed Pi root.",
        },
      },
    );
    expect(acceptedInput.response.status).toBe(202);
    let executionEffectJobId: string | undefined;
    let failedEffectJobId: string | undefined;
    try {
      await until(async () => {
        const observation = await managedWorkCall<{ modelCalls: number }>(
          baseUrl,
          thread.value.threadId,
          { kind: "observe" },
        );
        return observation.value.modelCalls > 0;
      });
      const pendingSource = await managedWorkCall<PublicStorageObservation>(
        baseUrl,
        thread.value.threadId,
        { kind: "public-storage-observation" },
      );
      expect(pendingSource.value.submissions).toContainEqual(
        expect.objectContaining({
          requestId: inputRequestId,
          status: "placed",
        }),
      );
      const pendingClose = await managedWorkCall<string>(
        baseUrl,
        thread.value.threadId,
        { kind: "close" },
      );
      expect(pendingClose.value).toBe(
        "Cannot close managed Pi work while runtime work is unsettled",
      );
      const executionAdmission = await call<{
        jobId: string;
        status: string;
      }>(baseUrl, "/__test/managed-effect", {
        body: {
          action: "enqueue",
          threadId: thread.value.threadId,
          taskId: "task:checkpoint-provenance",
          callId: "call:checkpoint-provenance",
          operation: {
            operation: "read-file",
            path: "tracked.txt",
            maxBytes: 1024,
          },
        },
      });
      expect(executionAdmission.value.status).toBe("queued");
      expect(executionAdmission.value.jobId).toStartWith("job:pi-");
      executionEffectJobId = executionAdmission.value.jobId;
      const queuedInputReceipt = await call<{
        executionEffects?: Array<{
          jobId: string;
          status: string;
          operation: string;
          payloadSha256: string;
        }>;
      }>(baseUrl, `/v1/commands/${inputRequestId}`, { credential: owner });
      expect(queuedInputReceipt.value.executionEffects).toHaveLength(1);
      expect(queuedInputReceipt.value.executionEffects).toContainEqual(
        expect.objectContaining({
          jobId: executionEffectJobId,
          operation: "read-file",
          payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
      const refusedCapture = await call<{ error: string }>(
        baseUrl,
        `/v1/threads/${thread.value.threadId}/capture-controls`,
        {
          credential: owner,
          body: {
            contractVersion: 1,
            requestId: "request:capture-during-pending-close",
          },
        },
      );
      expect(refusedCapture.response.status).toBe(409);
      expect(refusedCapture.value.error).toBe("managed_work_runtime_active");
      const afterCloseRefusal = await managedWorkCall<PublicStorageObservation>(
        baseUrl,
        thread.value.threadId,
        { kind: "public-storage-observation" },
      );
      expect(afterCloseRefusal.value).toEqual(pendingSource.value);
    } finally {
      await call(baseUrl, "/__test/model-response", {
        body: { action: "release", threadId: thread.value.threadId },
      });
    }
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        baseUrl,
        `/v1/commands/${inputRequestId}`,
        { credential: owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    await until(async () => {
      const receipt = await call<{
        executionEffects?: Array<{
          jobId: string;
          status: string;
          operation: string;
          payloadSha256: string;
          finishedAt?: string;
          errorCode?: string;
        }>;
      }>(baseUrl, `/v1/commands/${inputRequestId}`, { credential: owner });
      return Boolean(
        receipt.value.executionEffects?.some(
          (effect) =>
            effect.jobId === executionEffectJobId &&
            effect.status === "completed",
        ) &&
        receipt.value.executionEffects?.some(
          (effect) =>
            effect.status === "failed" && effect.operation === "read-file",
        ),
      );
    });
    const completedInputEffectReceipt = await call<{
      executionEffects?: Array<{
        jobId: string;
        status: string;
        operation: string;
        payloadSha256: string;
        finishedAt?: string;
        errorCode?: string;
      }>;
    }>(baseUrl, `/v1/commands/${inputRequestId}`, { credential: owner });
    const completedEffect =
      completedInputEffectReceipt.value.executionEffects?.find(
        (effect) => effect.jobId === executionEffectJobId,
      );
    expect(completedEffect).toMatchObject({
      jobId: executionEffectJobId,
      status: "completed",
      operation: "read-file",
    });
    expect(completedEffect?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completedEffect?.finishedAt).toBeString();
    const failedEffectReceipt =
      completedInputEffectReceipt.value.executionEffects?.find(
        (effect) =>
          effect.status === "failed" && effect.operation === "read-file",
      );
    if (!failedEffectReceipt)
      throw new Error("Pi read-file effect did not fail");
    failedEffectJobId = failedEffectReceipt.jobId;
    expect(failedEffectJobId).toStartWith("job:pi-");
    expect(failedEffectReceipt).toMatchObject({
      jobId: failedEffectJobId,
      status: "failed",
      operation: "read-file",
      errorCode: "workspace_path_not_found",
    });
    const normalContext = await call<{
      runtime: {
        entries: ManagedWorkCheckpoint["entries"];
        messages: unknown[];
      };
    }>(baseUrl, `/v1/threads/${thread.value.threadId}/context`, {
      credential: owner,
    });
    expect(JSON.stringify(normalContext.value.runtime)).toContain(
      "Capture the settled managed Pi root.",
    );
    expect(JSON.stringify(normalContext.value.runtime)).toContain(
      "The captured Pi root is settled.",
    );
    const completedInputReceipt = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/commands/${inputRequestId}`,
      { credential: owner },
    );
    expect(completedInputReceipt.value.dispatchStatus).toBe("completed");
    const sourceObservationResult =
      await managedWorkCall<PublicStorageObservation>(
        baseUrl,
        thread.value.threadId,
        { kind: "public-storage-observation" },
      );
    expect(sourceObservationResult.response.status).toBe(200);
    const sourceObservation = sourceObservationResult.value;
    const workspaceBeforeCapture = await workspaceEffectState(workspace);
    expect(sourceObservation.sessionDocuments).toEqual([]);
    expect(sourceObservation.conversations.length).toBeGreaterThan(0);
    expect(sourceObservation.tasks.length).toBeGreaterThan(0);
    expect(sourceObservation.submissions.length).toBeGreaterThan(0);
    expect(sourceObservation.documents.length).toBeGreaterThan(0);
    expect(
      sourceObservation.entries.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "conversationId" in entry &&
          entry.conversationId === ROOT_CONVERSATION_ID,
      ),
    ).toEqual(normalContext.value.runtime.entries);

    const managedNamespace = (await miniflare.getDurableObjectNamespace(
      "MANAGED_WORK",
    )) as unknown as ManagedWorkNamespace;
    const managedId = managedNamespace.idFromName(thread.value.threadId);
    await miniflare.unsafeEvictDurableObject(
      "uzina-workspace-snapshot",
      "CaptureTestManagedWork",
      { id: managedId.toString() },
    );
    // Reopening resolves a changed host default, but the existing Pi root keeps
    // its own committed model. Its checkpoint must require that persisted model.
    expect(
      (await providerConfiguration(baseUrl, "reconfigured")).response.status,
    ).toBe(200);
    await runtimeOptionsBarrier(baseUrl, "hold");
    const coldOpen = managedWorkCall<{ conversationId: number }>(
      baseUrl,
      thread.value.threadId,
      { kind: "status" },
    );
    let runtimeFirstAdmission:
      { response: Response; value: { error?: string } } | undefined;
    let coldOpenStatus: number | undefined;
    try {
      await until(
        async () =>
          (await runtimeOptionsBarrier(baseUrl, "entered")).value.entered,
      );
      runtimeFirstAdmission = await call<{ error?: string }>(
        baseUrl,
        `/v1/threads/${thread.value.threadId}/capture-controls`,
        {
          credential: owner,
          body: {
            contractVersion: 1,
            requestId: "request:capture-during-cold-open",
          },
        },
      );
      expect(runtimeFirstAdmission.response.status).toBe(409);
      expect(runtimeFirstAdmission.value.error).toBe(
        "managed_work_runtime_active",
      );
    } finally {
      await runtimeOptionsBarrier(baseUrl, "release");
      coldOpenStatus = (await coldOpen.catch(() => undefined))?.response.status;
    }
    expect(runtimeFirstAdmission?.response.status).toBe(409);
    expect(coldOpenStatus).toBe(200);
    const reopenedSource = await managedWorkCall<PublicStorageObservation>(
      baseUrl,
      thread.value.threadId,
      { kind: "public-storage-observation" },
    );
    const persistedRootAgent = reopenedSource.value.documents.find(
      (document) =>
        document.record.kind === "pi.agent" &&
        document.record.scope.kind === "conversation" &&
        document.record.scope.conversationId === ROOT_CONVERSATION_ID,
    );
    expect(persistedRootAgent?.value.model).toEqual({
      provider: "uzina-capture-test",
      modelId: "capture-test-model",
    });
    const quiescentClose = await managedWorkCall<string>(
      baseUrl,
      thread.value.threadId,
      { kind: "close" },
    );
    expect(quiescentClose.value).toBe("resolved");

    const sourceAdmission = await call<{
      requestId: string;
      captureId: string;
    }>(baseUrl, `/v1/threads/${thread.value.threadId}/capture-controls`, {
      credential: owner,
      body: { contractVersion: 1, requestId: "request:snapshot-source-fence" },
    });
    expect(sourceAdmission.response.status).toBe(202);
    await until(async () => {
      const status = await call<{ status: string }>(
        baseUrl,
        `/v1/capture-controls/${sourceAdmission.value.requestId}`,
        { credential: owner },
      );
      return status.value.status === "source-capture-fenced";
    });
    const fencedCaptureReceipt = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/capture-controls/${sourceAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(fencedCaptureReceipt.value.status).toBe("source-capture-fenced");
    const snapshotAdmission = await call<{
      requestId: string;
      snapshotId: string;
      captureId: string;
      status: string;
    }>(baseUrl, "/v1/workspace-snapshots", {
      credential: owner,
      body: {
        contractVersion: 1,
        requestId: "snapshot:workerd-workspace",
        captureRequestId: sourceAdmission.value.requestId,
      },
    });
    expect(snapshotAdmission.response.status).toBe(202);
    expect(snapshotAdmission.value.captureId).toBe(
      sourceAdmission.value.captureId,
    );
    await until(async () => {
      const status = await call<{ status: string }>(
        baseUrl,
        `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}`,
        { credential: owner },
      );
      return status.value.status === "workspace-checkpoint-available";
    });
    const status = await call<{ status: string; manifestReference: string }>(
      baseUrl,
      `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(status.value.status).toBe("workspace-checkpoint-available");
    const coherentRequest = {
      contractVersion: 1,
      requestId: "checkpoint:workerd-admission",
      captureRequestId: sourceAdmission.value.requestId,
      workspaceSnapshotRequestId: snapshotAdmission.value.requestId,
    };
    const checkpointPath = `/v1/threads/${thread.value.threadId}/managed-work-checkpoints`;
    const unauthenticatedCheckpoint = await fetchAndConsume(
      new URL(checkpointPath, baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(coherentRequest),
      },
    );
    expect(unauthenticatedCheckpoint).toBe(401);
    const nodeCheckpoint = await call<{ error: string }>(
      baseUrl,
      checkpointPath,
      { credential: node.value.credential, body: coherentRequest },
    );
    expect(nodeCheckpoint.response.status).toBe(403);
    const nonStrictRequest = await call<{ error: string }>(
      baseUrl,
      checkpointPath,
      {
        credential: owner,
        body: { ...coherentRequest, actor: { kind: "human" } },
      },
    );
    expect(nonStrictRequest.response.status).toBe(400);

    await call(baseUrl, "/__test/private-checkpoint-read", {
      body: {
        action: "hold",
        requestId: coherentRequest.requestId,
        mode: "second-read",
      },
    });
    const checkpointAdmission = await call<{
      requestId: string;
      captureRequestId: string;
      workspaceSnapshotRequestId: string;
      captureId: string;
      threadId: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
      status: string;
      stage: string;
      acceptedAt: string;
      updatedAt: string;
    }>(baseUrl, checkpointPath, {
      credential: owner,
      body: coherentRequest,
    });
    expect(checkpointAdmission.response.status).toBe(202);
    expect(checkpointAdmission.value).toMatchObject({
      requestId: coherentRequest.requestId,
      captureRequestId: sourceAdmission.value.requestId,
      workspaceSnapshotRequestId: snapshotAdmission.value.requestId,
      captureId: sourceAdmission.value.captureId,
      threadId: thread.value.threadId,
      target: {
        nodeId: node.value.node.nodeId,
        workspaceId: workspaceRecord.value.workspaceId,
      },
      ownershipGeneration: thread.value.ownershipGeneration,
      status: "assembling",
      stage: "admitted",
    });
    expect(checkpointAdmission.value.acceptedAt).toBe(
      checkpointAdmission.value.updatedAt,
    );
    const checkpointRetry = await call<Record<string, unknown>>(
      baseUrl,
      checkpointPath,
      { credential: owner, body: coherentRequest },
    );
    expect(checkpointRetry.response.status).toBe(202);
    expect(checkpointRetry.value).toMatchObject({
      requestId: coherentRequest.requestId,
      captureId: sourceAdmission.value.captureId,
      threadId: thread.value.threadId,
    });
    const checkpointStatusPath = `/v1/managed-work-checkpoints/${coherentRequest.requestId}`;
    const readCheckpointJournal = async () => {
      const journal = await call<{
        status: string;
        stage: string;
        runtimeRequirements: string[] | null;
        artifacts: Array<{ role: string; reference: string; size: number }>;
      }>(baseUrl, "/__test/managed-checkpoint-journal", {
        body: { requestId: coherentRequest.requestId },
      });
      if (journal.response.status !== 200) {
        throw new Error("Could not read persisted checkpoint journal");
      }
      return journal.value;
    };
    const listPrivateCheckpointObjects = async () => {
      const bucket = (await miniflare.getR2Bucket(
        "CHECKPOINTS",
      )) as unknown as {
        list(options: { prefix: string; limit: number }): Promise<{
          truncated: boolean;
          objects: Array<{ key: string; size: number }>;
        }>;
      };
      const requestHash = createHash("sha256")
        .update(coherentRequest.requestId)
        .digest("hex");
      const prefix = `managed-work-checkpoints/${requestHash}/`;
      const listing = await bucket.list({ prefix, limit: 1000 });
      if (listing.truncated) {
        throw new Error(
          "Test request private namespace unexpectedly paginated",
        );
      }
      return listing.objects
        .map((object) => ({
          reference: object.key.slice(prefix.length),
          size: object.size,
        }))
        .sort((left, right) => left.reference.localeCompare(right.reference));
    };
    await until(async () => {
      const gate = await call<{ entered: boolean }>(
        baseUrl,
        "/__test/private-checkpoint-read",
        { body: { action: "state" } },
      );
      const current = await call<{ status: string; stage: string }>(
        baseUrl,
        checkpointStatusPath,
        { credential: owner },
      );
      return gate.value.entered && current.value.stage === "evidence-recorded";
    });
    const interruptedStatus = await call<{
      status: string;
      stage: string;
      requestId: string;
    }>(baseUrl, checkpointStatusPath, { credential: owner });
    expect(interruptedStatus.value).toMatchObject({
      status: "assembling",
      stage: "evidence-recorded",
      requestId: coherentRequest.requestId,
    });
    const interruptedJournal = await readCheckpointJournal();
    expect(interruptedJournal).toMatchObject({
      status: "assembling",
      stage: "evidence-recorded",
      runtimeRequirements: expectedRuntimeRequirements,
    });
    const interruptedRuntimeEvidenceArtifacts = interruptedJournal.artifacts
      .filter(
        (artifact) =>
          artifact.role === "runtime" || artifact.role === "evidence",
      )
      .sort((left, right) => left.role.localeCompare(right.role));
    expect(interruptedRuntimeEvidenceArtifacts.map(({ role }) => role)).toEqual(
      ["evidence", "runtime"],
    );
    const privateObjectsBeforeRestart = await listPrivateCheckpointObjects();
    expect(privateObjectsBeforeRestart).toEqual(
      interruptedRuntimeEvidenceArtifacts
        .map(({ reference, size }) => ({ reference, size }))
        .sort((left, right) => left.reference.localeCompare(right.reference)),
    );
    const fenceBeforeRestart = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/capture-controls/${sourceAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(fenceBeforeRestart.value).toEqual(fencedCaptureReceipt.value);
    await stopExecutionLoop();
    await miniflare.dispose();
    miniflare = createMiniflare({
      holdPublication: true,
      holdPrivateReadRequestId: coherentRequest.requestId,
      holdPrivateReadMode: "first-read",
      forbidExportThreadId: thread.value.threadId,
    });
    fixture.miniflare = miniflare;
    baseUrl = (await miniflare.ready).toString();
    const recordedStageRetry = await call<Record<string, unknown>>(
      baseUrl,
      checkpointPath,
      { credential: owner, body: coherentRequest },
    );
    expect(recordedStageRetry.response.status).toBe(202);
    await until(async () => {
      const gate = await call<{ entered: boolean }>(
        baseUrl,
        "/__test/private-checkpoint-read",
        { body: { action: "state" } },
      );
      return gate.value.entered;
    });
    const resumedStatus = await call<{
      status: string;
      stage: string;
      requestId: string;
      captureRequestId: string;
      workspaceSnapshotRequestId: string;
      captureId: string;
      threadId: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, checkpointStatusPath, { credential: owner });
    expect(resumedStatus.value).toMatchObject({
      status: "assembling",
      stage: "evidence-recorded",
      requestId: coherentRequest.requestId,
      captureRequestId: sourceAdmission.value.requestId,
      workspaceSnapshotRequestId: snapshotAdmission.value.requestId,
      captureId: sourceAdmission.value.captureId,
      threadId: thread.value.threadId,
      target: {
        nodeId: node.value.node.nodeId,
        workspaceId: workspaceRecord.value.workspaceId,
      },
      ownershipGeneration: thread.value.ownershipGeneration,
    });
    const resumedJournal = await readCheckpointJournal();
    expect(resumedJournal).toMatchObject({
      status: "assembling",
      stage: "evidence-recorded",
      runtimeRequirements: expectedRuntimeRequirements,
      artifacts: interruptedJournal.artifacts,
    });
    expect(await listPrivateCheckpointObjects()).toEqual(
      privateObjectsBeforeRestart,
    );
    const fenceAfterRestart = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/capture-controls/${sourceAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(fenceAfterRestart.value).toEqual(fencedCaptureReceipt.value);
    const sourceWorkspaceAfterRestart = await call<{
      status: string;
      manifestReference: string;
    }>(
      baseUrl,
      `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(sourceWorkspaceAfterRestart.value).toEqual(status.value);
    const ownerExecutionReceiptAfterRestart = await call<
      Record<string, unknown>
    >(baseUrl, `/v1/commands/${inputRequestId}`, { credential: owner });
    expect(ownerExecutionReceiptAfterRestart.value).toEqual(
      completedInputEffectReceipt.value,
    );
    await call(baseUrl, "/__test/private-checkpoint-read", {
      body: { action: "release" },
    });
    startExecutionLoop();
    await waitForNodeOnline();

    let callerConstructedVerification:
      | {
          checkpointRequestId: string;
          captureId: string;
          sourceWorkspaceManifestReference: string;
          manifestReference: string;
          workspaceObjectCount: number;
          privateObjectCount: number;
          totalBytes: number;
        }
      | undefined;
    await until(async () => {
      const barrier = await call<{
        entered: boolean;
        verificationFrozen: boolean;
        verification?: typeof callerConstructedVerification;
      }>(baseUrl, "/__test/managed-checkpoint-publication", {
        body: { action: "state" },
      });
      if (barrier.value.entered && barrier.value.verification) {
        expect(barrier.value.verificationFrozen).toBe(true);
        callerConstructedVerification = barrier.value.verification;
        return true;
      }
      return false;
    });
    if (!callerConstructedVerification) {
      throw new Error("Verified publication barrier did not capture a summary");
    }
    try {
      const copiedPublication = await call<{ error: string }>(
        baseUrl,
        "/__test/managed-checkpoint-publication",
        {
          body: {
            action: "attempt",
            requestId: coherentRequest.requestId,
            manifestReference: callerConstructedVerification.manifestReference,
            verification: callerConstructedVerification,
          },
        },
      );
      expect(copiedPublication.response.status).toBe(409);
      expect(copiedPublication.value.error).toBe(
        "managed_work_checkpoint_verification_mismatch",
      );
      const mutatedPublication = await call<{ error: string }>(
        baseUrl,
        "/__test/managed-checkpoint-publication",
        {
          body: {
            action: "attempt",
            requestId: coherentRequest.requestId,
            manifestReference: callerConstructedVerification.manifestReference,
            verification: {
              ...callerConstructedVerification,
              totalBytes: callerConstructedVerification.totalBytes + 1,
            },
          },
        },
      );
      expect(mutatedPublication.response.status).toBe(409);
      expect(mutatedPublication.value.error).toBe(
        "managed_work_checkpoint_verification_mismatch",
      );
      const unpublishedStatus = await call<{
        status: string;
        stage: string;
        manifestReference?: string;
      }>(baseUrl, checkpointStatusPath, { credential: owner });
      expect(unpublishedStatus.value).toMatchObject({
        status: "assembling",
        stage: "closure-verification-started",
      });
      expect(unpublishedStatus.value.manifestReference).toBeUndefined();
    } finally {
      await call(baseUrl, "/__test/managed-checkpoint-publication", {
        body: { action: "release" },
      });
    }
    await until(async () => {
      const current = await call<Record<string, unknown>>(
        baseUrl,
        checkpointStatusPath,
        { credential: owner },
      );
      if (
        current.value.status === "blocked" ||
        current.value.status === "uncertain"
      ) {
        throw new Error(JSON.stringify(current.value));
      }
      return current.value.status === "available";
    });
    const checkpointStatus = await call<{
      status: string;
      stage: string;
      manifestReference: string;
      requestId: string;
    }>(baseUrl, checkpointStatusPath, { credential: owner });
    expect(checkpointStatus.value).toMatchObject({
      status: "available",
      stage: "available",
      requestId: coherentRequest.requestId,
    });
    expect(checkpointStatus.value.manifestReference).toMatch(/^[a-f0-9]{64}$/);

    const destinationNode = await call<{
      node: { nodeId: string };
      credential: string;
    }>(baseUrl, "/v1/nodes", {
      credential: owner,
      body: {
        nodeId: "node:relocation-destination",
        name: "Offline relocation destination",
      },
    });
    const destinationWorkspace = await call<{ workspaceId: string }>(
      baseUrl,
      "/v1/workspaces",
      {
        credential: owner,
        body: {
          workspaceId: "workspace:relocation-destination",
          nodeId: destinationNode.value.node.nodeId,
          name: "Relocation destination",
        },
      },
    );
    const busyDestinationWorkspace = await call<{ workspaceId: string }>(
      baseUrl,
      "/v1/workspaces",
      {
        credential: owner,
        body: {
          workspaceId: "workspace:relocation-busy",
          nodeId: destinationNode.value.node.nodeId,
          name: "Occupied relocation destination",
        },
      },
    );
    const unrelatedDestinationWorkspace = await call<{
      workspaceId: string;
    }>(baseUrl, "/v1/workspaces", {
      credential: owner,
      body: {
        workspaceId: "workspace:relocation-unrelated",
        nodeId: destinationNode.value.node.nodeId,
        name: "Unrelated destination workspace",
      },
    });
    const busyDestinationThread = await call<{ threadId: string }>(
      baseUrl,
      "/v1/threads",
      {
        credential: owner,
        body: {
          threadId: "thread:relocation-busy",
          projectId: project.value.projectId,
          title: "Existing unrelated destination assignment",
          target: {
            nodeId: destinationNode.value.node.nodeId,
            workspaceId: busyDestinationWorkspace.value.workspaceId,
          },
        },
      },
    );
    expect(busyDestinationThread.response.status).toBe(201);
    const relocationPath = `/v1/threads/${thread.value.threadId}/workspace-relocations`;
    const relocationRequest = {
      contractVersion: 1,
      requestId: "relocation:workerd-coherent-source",
      checkpointRequestId: coherentRequest.requestId,
      destination: {
        nodeId: destinationNode.value.node.nodeId,
        workspaceId: destinationWorkspace.value.workspaceId,
      },
    };
    const nonStrictRelocationRequest = await call<{ error: string }>(
      baseUrl,
      relocationPath,
      {
        credential: owner,
        body: { ...relocationRequest, actor: { kind: "human" } },
      },
    );
    expect(nonStrictRelocationRequest.response.status).toBe(400);
    const sameNodeRelocation = await call<{ error: string }>(
      baseUrl,
      relocationPath,
      {
        credential: owner,
        body: {
          ...relocationRequest,
          requestId: "relocation:same-source-node",
          destination: {
            nodeId: node.value.node.nodeId,
            workspaceId: recoveryWorkspaceRecord.value.workspaceId,
          },
        },
      },
    );
    expect(sameNodeRelocation.response.status).toBe(409);
    const busyRelocation = await call<{ error: string }>(
      baseUrl,
      relocationPath,
      {
        credential: owner,
        body: {
          ...relocationRequest,
          requestId: "relocation:busy-destination",
          destination: {
            nodeId: destinationNode.value.node.nodeId,
            workspaceId: busyDestinationWorkspace.value.workspaceId,
          },
        },
      },
    );
    expect(busyRelocation.response.status).toBe(409);
    const wrongThreadRelocation = await call<{ error: string }>(
      baseUrl,
      "/v1/threads/thread:wrong-relocation-thread/workspace-relocations",
      { credential: owner, body: relocationRequest },
    );
    expect(wrongThreadRelocation.response.status).toBe(409);
    await stopExecutionLoop();
    const evictFactory = async () => {
      const factoryNamespace = (await miniflare.getDurableObjectNamespace(
        "FACTORY",
      )) as unknown as FactoryNamespace;
      await miniflare.unsafeEvictDurableObject(
        "uzina-workspace-snapshot",
        "CaptureTestFactory",
        {
          id: factoryNamespace.idFromName("uzina-single-factory").toString(),
        },
      );
    };
    const legacyRelocationColumns = await call<string[]>(
      baseUrl,
      "/__test/workspace-relocation-schema",
      { body: { action: "drop-history-columns" } },
    );
    expect(legacyRelocationColumns.value).not.toContain("previous_report_json");
    expect(legacyRelocationColumns.value).not.toContain(
      "previous_report_sha256",
    );
    expect(legacyRelocationColumns.value).not.toContain(
      "previous_receipt_sha256",
    );
    await evictFactory();
    const reopenedRelocationColumns = await call<string[]>(
      baseUrl,
      "/__test/workspace-relocation-schema",
      { body: { action: "read" } },
    );
    expect(reopenedRelocationColumns.value).toContain("previous_report_json");
    expect(reopenedRelocationColumns.value).toContain("previous_report_sha256");
    expect(reopenedRelocationColumns.value).toContain(
      "previous_receipt_sha256",
    );
    const lostOwnerAdmissionStatus = await forwardAndDiscardResponse(
      new URL(relocationPath, baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(relocationRequest),
      },
    );
    expect(lostOwnerAdmissionStatus).toBe(202);
    await evictFactory();
    const relocationAdmission = await call<{
      relocationId: string;
      requestId: string;
      checkpointRequestId: string;
      captureRequestId: string;
      captureId: string;
      workspaceSnapshotRequestId: string;
      snapshotId: string;
      source: { nodeId: string; workspaceId: string };
      destination: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
      manifestReference: string;
      status: string;
      acceptedAt: string;
      updatedAt: string;
    }>(baseUrl, relocationPath, {
      credential: owner,
      body: relocationRequest,
    });
    expect(relocationAdmission.response.status).toBe(202);
    expect(relocationAdmission.value).toMatchObject({
      requestId: relocationRequest.requestId,
      checkpointRequestId: coherentRequest.requestId,
      captureRequestId: sourceAdmission.value.requestId,
      captureId: sourceAdmission.value.captureId,
      workspaceSnapshotRequestId: snapshotAdmission.value.requestId,
      snapshotId: snapshotAdmission.value.snapshotId,
      threadId: thread.value.threadId,
      source: {
        nodeId: node.value.node.nodeId,
        workspaceId: workspaceRecord.value.workspaceId,
      },
      destination: relocationRequest.destination,
      ownershipGeneration: thread.value.ownershipGeneration,
      manifestReference: status.value.manifestReference,
      status: "queued",
    });
    expect(relocationAdmission.value.acceptedAt).toBe(
      relocationAdmission.value.updatedAt,
    );
    expect(relocationAdmission.value.relocationId).toMatch(
      /^workspace-relocation:/,
    );
    const relocationStatusPath = `/v1/workspace-relocations/${relocationRequest.requestId}`;
    const relocationRetry = await call<Record<string, unknown>>(
      baseUrl,
      relocationPath,
      { credential: owner, body: relocationRequest },
    );
    expect(relocationRetry.value).toEqual(relocationAdmission.value);
    const relocationOwnerStatus = await call<Record<string, unknown>>(
      baseUrl,
      relocationStatusPath,
      { credential: owner },
    );
    expect(relocationOwnerStatus.value).toEqual(relocationAdmission.value);
    const nodeRelocationStatus = await call<{ error: string }>(
      baseUrl,
      relocationStatusPath,
      { credential: destinationNode.value.credential },
    );
    expect(nodeRelocationStatus.response.status).toBe(403);
    const conflictingRelocationRequest = await call<{ error: string }>(
      baseUrl,
      relocationPath,
      {
        credential: owner,
        body: {
          ...relocationRequest,
          destination: {
            nodeId: destinationNode.value.node.nodeId,
            workspaceId: unrelatedDestinationWorkspace.value.workspaceId,
          },
        },
      },
    );
    expect(conflictingRelocationRequest.response.status).toBe(409);
    const secondRelocationForCheckpoint = await call<{ error: string }>(
      baseUrl,
      relocationPath,
      {
        credential: owner,
        body: {
          ...relocationRequest,
          requestId: "relocation:second-for-same-checkpoint",
          destination: {
            nodeId: destinationNode.value.node.nodeId,
            workspaceId: unrelatedDestinationWorkspace.value.workspaceId,
          },
        },
      },
    );
    expect(secondRelocationForCheckpoint.response.status).toBe(409);
    const reservedDestinationThread = await call<{ error: string }>(
      baseUrl,
      "/v1/threads",
      {
        credential: owner,
        body: {
          threadId: "thread:relocation-reserved-destination",
          projectId: project.value.projectId,
          title: "Must not use reserved destination",
          target: relocationRequest.destination,
        },
      },
    );
    expect(reservedDestinationThread.response.status).toBe(409);
    const unrelatedDestinationThread = await call<{ threadId: string }>(
      baseUrl,
      "/v1/threads",
      {
        credential: owner,
        body: {
          threadId: "thread:relocation-unrelated-destination",
          projectId: project.value.projectId,
          title: "Unrelated destination remains available",
          target: {
            nodeId: destinationNode.value.node.nodeId,
            workspaceId: unrelatedDestinationWorkspace.value.workspaceId,
          },
        },
      },
    );
    expect(unrelatedDestinationThread.response.status).toBe(201);
    const relocationClaimPath = `/v1/nodes/${destinationNode.value.node.nodeId}/workspace-relocations/claim`;
    const nonStrictRelocationClaim = await call<{ error: string }>(
      baseUrl,
      relocationClaimPath,
      {
        credential: destinationNode.value.credential,
        body: {
          contractVersion: 1,
          nodeId: destinationNode.value.node.nodeId,
          workspaceId: "workspace:anything",
        },
      },
    );
    expect(nonStrictRelocationClaim.response.status).toBe(400);
    const relocationReportPath = `/v1/nodes/${destinationNode.value.node.nodeId}/workspace-relocations/${relocationAdmission.value.relocationId}/report`;
    const nonStrictRelocationReport = await call<{ error: string }>(
      baseUrl,
      relocationReportPath,
      {
        credential: destinationNode.value.credential,
        body: {
          contractVersion: 1,
          relocationId: relocationAdmission.value.relocationId,
          actor: { kind: "node", nodeId: destinationNode.value.node.nodeId },
        },
      },
    );
    expect(nonStrictRelocationReport.response.status).toBe(400);
    const offlineDestinationClaim = await call<{ relocation: unknown }>(
      baseUrl,
      relocationClaimPath,
      {
        credential: destinationNode.value.credential,
        body: { contractVersion: 1, nodeId: destinationNode.value.node.nodeId },
      },
    );
    expect(offlineDestinationClaim.response.status).toBe(200);
    expect(offlineDestinationClaim.value.relocation).toBeNull();
    const sourceNodeRead = await fetch(
      new URL(
        `/v1/nodes/${destinationNode.value.node.nodeId}/workspace-relocations/${relocationAdmission.value.relocationId}/blobs/${status.value.manifestReference}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${node.value.credential}` } },
    );
    expect(sourceNodeRead.status).toBe(403);
    await sourceNodeRead.body?.cancel();
    const unclaimedDestinationRead = await fetch(
      new URL(
        `/v1/nodes/${destinationNode.value.node.nodeId}/workspace-relocations/${relocationAdmission.value.relocationId}/blobs/${status.value.manifestReference}`,
        baseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${destinationNode.value.credential}`,
        },
      },
    );
    expect(unclaimedDestinationRead.status).toBe(404);
    await unclaimedDestinationRead.body?.cancel();
    const privateCheckpointNodeRead = await fetch(
      new URL(
        `/v1/managed-work-checkpoints/${coherentRequest.requestId}/blobs/${checkpointStatus.value.manifestReference}`,
        baseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${destinationNode.value.credential}`,
        },
      },
    );
    expect(privateCheckpointNodeRead.status).toBe(403);
    await privateCheckpointNodeRead.body?.cancel();

    const destinationDirectory = join(directory, "destination-workspace");
    const destinationDatabasePath = join(directory, "destination-node.sqlite");
    await mkdir(destinationDirectory);
    destinationDaemon = new ExecutionDaemon({
      databasePath: destinationDatabasePath,
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      workspaces: [
        {
          workspaceId: destinationWorkspace.value.workspaceId,
          directory: destinationDirectory,
        },
      ],
    });
    let droppedDestinationClaimAcknowledgement = false;
    let droppedPreparedReportAcknowledgement = false;
    let lostClaimRelocationId: string | undefined;
    const destinationController = withDroppedRelocationReplies(
      new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: destinationNode.value.node.nodeId,
        credential: destinationNode.value.credential,
      }),
      [
        {
          method: "claimWorkspaceRelocation",
          matches: (result) => {
            if (
              typeof result !== "object" ||
              result === null ||
              !("relocationId" in result) ||
              typeof result.relocationId !== "string"
            ) {
              return false;
            }
            lostClaimRelocationId = result.relocationId;
            return true;
          },
          async afterForward() {
            droppedDestinationClaimAcknowledgement = true;
            await evictFactory();
          },
        },
        {
          method: "reportWorkspaceRelocation",
          matches: (_result, args) =>
            typeof args[0] === "object" &&
            args[0] !== null &&
            "status" in args[0] &&
            args[0].status === "prepared-inactive",
          async afterForward() {
            droppedPreparedReportAcknowledgement = true;
            await evictFactory();
          },
        },
      ],
    );

    let signalPartialStreamBoundary!: () => void;
    const partialStreamBoundary = new Promise<void>((resolve) => {
      signalPartialStreamBoundary = resolve;
    });
    let releasePartialStreamFailure!: () => void;
    const partialStreamFailureGate = new Promise<void>((resolve) => {
      releasePartialStreamFailure = resolve;
    });
    let interruptedBlob: { reference: string; size: number } | undefined;
    const interruptedDownloadController = withInterruptedFirstWorkspaceBlob(
      destinationController,
      () => partialStreamFailureGate,
      () => signalPartialStreamBoundary(),
      (reference, size) => {
        if (!interruptedBlob) interruptedBlob = { reference, size };
      },
    );
    let captureNextClaim = false;
    let captureRetriedClaim!: (claim: unknown) => void;
    const retriedClaimPromise = new Promise<unknown>((resolve) => {
      captureRetriedClaim = resolve;
    });
    destinationAbort = new AbortController();
    destinationLoop = new ExecutionLoop({
      daemon: destinationDaemon,
      controller: withCapturedRetryClaim(
        interruptedDownloadController,
        destinationAbort,
        () => captureNextClaim,
        captureRetriedClaim,
      ),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 30_000,
    }).run(destinationAbort.signal);
    await until(async () => {
      const nodes = await call<{
        nodes: Array<{ nodeId: string; availability: string }>;
      }>(baseUrl, "/v1/nodes", { credential: owner });
      return nodes.value.nodes.some(
        (candidate) =>
          candidate.nodeId === destinationNode.value.node.nodeId &&
          candidate.availability === "online",
      );
    });
    await partialStreamBoundary;
    try {
      const partialReceiptDb = new Database(destinationDatabasePath, {
        readonly: true,
      });
      let partialReceipt:
        | {
            status: string;
            stage: string;
            cache_directory: string | null;
            report_json: string | null;
          }
        | null
        | undefined;
      try {
        partialReceipt = partialReceiptDb
          .query<
            {
              status: string;
              stage: string;
              cache_directory: string | null;
              report_json: string | null;
            },
            [string]
          >(
            `SELECT status, stage, cache_directory, report_json
             FROM execution_workspace_relocations WHERE relocation_id = ?`,
          )
          .get(relocationAdmission.value.relocationId);
      } finally {
        partialReceiptDb.close();
      }
      expect(partialReceipt).toMatchObject({
        status: "preparing",
        stage: "downloading",
        report_json: null,
      });
      expect(interruptedBlob).toMatchObject({
        reference: status.value.manifestReference,
      });
      expect(interruptedBlob!.size).toBeGreaterThan(64);
      expect(await readdir(destinationDirectory)).toEqual([]);
      const partialFiles = (
        await readdir(partialReceipt!.cache_directory!)
      ).filter((name) => name.endsWith(".part"));
      expect(partialFiles).toHaveLength(1);
      const partialFile = await stat(
        join(partialReceipt!.cache_directory!, partialFiles[0]!),
      );
      expect(partialFile.size).toBe(64);
      expect(partialFile.size).toBeLessThan(interruptedBlob!.size);
      const ownerStillClaimed = await call<{ status: string }>(
        baseUrl,
        relocationStatusPath,
        { credential: owner },
      );
      expect(ownerStillClaimed.value.status).toBe("claimed");
    } finally {
      captureNextClaim = true;
      releasePartialStreamFailure();
    }
    const retriedClaim = (await retriedClaimPromise) as {
      relocationId: string;
      requestId: string;
      destination: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
      manifestReference: string;
    };
    expect(retriedClaim).toMatchObject({
      relocationId: relocationAdmission.value.relocationId,
      requestId: relocationAdmission.value.requestId,
      destination: relocationAdmission.value.destination,
      ownershipGeneration: thread.value.ownershipGeneration,
      manifestReference: status.value.manifestReference,
    });
    await destinationLoop?.catch(() => {});
    destinationLoop = undefined;
    destinationAbort = undefined;
    destinationDaemon.close();
    destinationDaemon = undefined;
    expect(droppedDestinationClaimAcknowledgement).toBe(true);
    expect(lostClaimRelocationId).toBe(retriedClaim.relocationId);
    const retryReceiptDb = new Database(destinationDatabasePath, {
      readonly: true,
    });
    let retryReceipt:
      | {
          stage: string;
          cache_directory: string | null;
          report_json: string | null;
        }
      | null
      | undefined;
    try {
      retryReceipt = retryReceiptDb
        .query<
          {
            stage: string;
            cache_directory: string | null;
            report_json: string | null;
          },
          [string]
        >(
          `SELECT stage, cache_directory, report_json
           FROM execution_workspace_relocations WHERE relocation_id = ?`,
        )
        .get(retriedClaim.relocationId);
    } finally {
      retryReceiptDb.close();
    }
    expect(retryReceipt).toMatchObject({
      stage: "downloading",
      report_json: null,
    });
    expect(await readdir(retryReceipt!.cache_directory!)).toEqual([]);
    expect(await readdir(destinationDirectory)).toEqual([]);

    const preflightDirectory = join(directory, "relocation-preflight");
    await mkdir(preflightDirectory);
    const preflightWorkspace = (
      workspaceId: string,
      directoryPath: string,
    ) => ({
      workspaceId,
      directory: directoryPath,
      ownershipGeneration: retriedClaim.ownershipGeneration,
    });
    const preflightDatabase = (name: string) =>
      join(preflightDirectory, `${name}.sqlite`);
    await assertBlockedRelocationPreflight({
      databasePath: preflightDatabase("missing-mapping"),
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      claim: retriedClaim,
      expectedErrorCode: "workspace_not_configured",
      workspaces: [],
    });
    const missingRoot = join(preflightDirectory, "missing-root");
    expect(
      () =>
        new ExecutionDaemon({
          databasePath: preflightDatabase("missing-root"),
          nodeId: destinationNode.value.node.nodeId,
          nodeCredential: destinationNode.value.credential,
          workspaces: [
            preflightWorkspace(
              destinationWorkspace.value.workspaceId,
              missingRoot,
            ),
          ],
        }),
    ).toThrow();
    expect(existsSync(missingRoot)).toBe(false);

    const nonemptyRoot = join(preflightDirectory, "nonempty-root");
    await mkdir(nonemptyRoot);
    await writeFile(join(nonemptyRoot, "operator-data.txt"), "preserve me");
    await assertBlockedRelocationPreflight({
      databasePath: preflightDatabase("nonempty"),
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      claim: retriedClaim,
      expectedErrorCode: "workspace_relocation_destination_not_empty",
      workspaces: [
        preflightWorkspace(
          destinationWorkspace.value.workspaceId,
          nonemptyRoot,
        ),
      ],
    });
    expect(
      await readFile(join(nonemptyRoot, "operator-data.txt"), "utf8"),
    ).toBe("preserve me");

    const symlinkRoot = join(preflightDirectory, "symlink-root");
    const symlinkRootMoved = join(preflightDirectory, "symlink-root-moved");
    const symlinkTarget = join(preflightDirectory, "symlink-target");
    await mkdir(symlinkRoot);
    await mkdir(symlinkTarget);
    await assertBlockedRelocationPreflight({
      databasePath: preflightDatabase("symlink-swap"),
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      claim: retriedClaim,
      expectedErrorCode: "workspace_relocation_destination_path_invalid",
      workspaces: [
        preflightWorkspace(destinationWorkspace.value.workspaceId, symlinkRoot),
      ],
      beforeExecute: async () => {
        await rename(symlinkRoot, symlinkRootMoved);
        await symlink(symlinkTarget, symlinkRoot);
      },
    });
    expect(await readdir(symlinkTarget)).toEqual([]);

    const overlapParent = join(preflightDirectory, "overlap-parent");
    const overlapDestination = join(overlapParent, "destination");
    await mkdir(overlapDestination, { recursive: true });
    await assertBlockedRelocationPreflight({
      databasePath: preflightDatabase("nested-overlap"),
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      claim: retriedClaim,
      expectedErrorCode: "workspace_relocation_destination_overlap",
      workspaces: [
        preflightWorkspace(
          destinationWorkspace.value.workspaceId,
          overlapDestination,
        ),
        preflightWorkspace(
          "workspace:relocation-overlap-parent",
          overlapParent,
        ),
      ],
    });

    const aliasRoot = join(preflightDirectory, "alias-root");
    await mkdir(aliasRoot);
    await assertBlockedRelocationPreflight({
      databasePath: preflightDatabase("alias-overlap"),
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      claim: retriedClaim,
      expectedErrorCode: "workspace_relocation_destination_overlap",
      workspaces: [
        preflightWorkspace(destinationWorkspace.value.workspaceId, aliasRoot),
        preflightWorkspace("workspace:relocation-preflight-alias", aliasRoot),
      ],
    });

    const cacheOverlapRoot = join(preflightDirectory, "cache-overlap-root");
    await mkdir(cacheOverlapRoot);
    await assertBlockedRelocationPreflight({
      databasePath: preflightDatabase("cache-overlap"),
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      claim: retriedClaim,
      expectedErrorCode: "workspace_relocation_cache_overlap",
      workspaces: [
        preflightWorkspace(
          destinationWorkspace.value.workspaceId,
          cacheOverlapRoot,
        ),
      ],
      snapshotCacheDirectory: join(cacheOverlapRoot, "private-cache"),
    });

    const databaseCacheRoot = join(preflightDirectory, "database-cache-root");
    const databaseCacheDirectory = join(
      databaseCacheRoot,
      "workspace-relocations",
      createHash("sha256").update(retriedClaim.relocationId).digest("hex"),
    );
    await mkdir(databaseCacheDirectory, { recursive: true, mode: 0o700 });
    await chmod(databaseCacheRoot, 0o700);
    await chmod(join(databaseCacheRoot, "workspace-relocations"), 0o700);
    await chmod(databaseCacheDirectory, 0o700);
    const databaseOverlapDestination = join(
      preflightDirectory,
      "database-overlap-destination",
    );
    await mkdir(databaseOverlapDestination);
    await assertBlockedRelocationPreflight({
      databasePath: join(databaseCacheDirectory, "daemon.sqlite"),
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      claim: retriedClaim,
      expectedErrorCode: "workspace_relocation_database_overlap",
      workspaces: [
        preflightWorkspace(
          destinationWorkspace.value.workspaceId,
          databaseOverlapDestination,
        ),
      ],
      snapshotCacheDirectory: databaseCacheRoot,
    });

    const exerciseCorruptLocalCache = async (
      name: string,
      corrupt: "manifest" | "workspace-blob" | "workspace-blob-size",
    ) => {
      const localRoot = join(preflightDirectory, `${name}-destination`);
      const localDatabasePath = preflightDatabase(name);
      await mkdir(localRoot);
      const cacheDirectory = join(
        `${localDatabasePath}.snapshot-cache`,
        "workspace-relocations",
        createHash("sha256").update(retriedClaim.relocationId).digest("hex"),
      );
      const controller = new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: destinationNode.value.node.nodeId,
        credential: destinationNode.value.credential,
      });
      const requestedReferences: string[] = [];
      let corruptionCreated = false;
      let corruptReference = retriedClaim.manifestReference;
      let corruptBytes: Buffer | undefined;
      const fetchBlob = async (relocationId: string, reference: string) => {
        if (
          corrupt === "manifest" &&
          !corruptionCreated &&
          reference !== retriedClaim.manifestReference
        ) {
          corruptBytes = Buffer.from("corrupt manifest cache evidence");
          await writeFile(
            join(cacheDirectory, retriedClaim.manifestReference),
            corruptBytes,
            { mode: 0o600 },
          );
          corruptionCreated = true;
          throw new ControllerTransportError();
        }
        const response = await controller.fetchWorkspaceRelocationBlob(
          relocationId,
          reference,
        );
        requestedReferences.push(reference);
        if (
          corrupt !== "manifest" &&
          !corruptionCreated &&
          reference !== retriedClaim.manifestReference
        ) {
          const validBytes = Buffer.from(
            await new Response(response.body).arrayBuffer(),
          );
          if (validBytes.byteLength === 0)
            throw new Error("Expected a non-empty workspace blob");
          corruptBytes =
            corrupt === "workspace-blob-size"
              ? Buffer.concat([validBytes, Buffer.from([0])])
              : Buffer.from(validBytes);
          if (corrupt === "workspace-blob") {
            corruptBytes[0] = corruptBytes[0]! ^ 0xff;
          }
          corruptReference = reference;
          await writeFile(
            join(cacheDirectory, corruptReference),
            corruptBytes,
            { mode: 0o600 },
          );
          corruptionCreated = true;
          throw new ControllerTransportError();
        }
        return response;
      };
      const daemon = new ExecutionDaemon({
        databasePath: localDatabasePath,
        nodeId: destinationNode.value.node.nodeId,
        nodeCredential: destinationNode.value.credential,
        workspaces: [
          preflightWorkspace(destinationWorkspace.value.workspaceId, localRoot),
        ],
      });
      try {
        await expect(
          daemon.executeWorkspaceRelocation(retriedClaim, fetchBlob),
        ).rejects.toBeInstanceOf(ControllerTransportError);
        expect(corruptionCreated).toBe(true);
        if (!corruptBytes)
          throw new Error("Corrupt cache fixture did not create bytes");
        const expectedCorruptHex = Buffer.from(corruptBytes).toString("hex");
        const localStateDb = new Database(localDatabasePath, {
          readonly: true,
        });
        let localState:
          | { status: string; stage: string; report_json: string | null }
          | null
          | undefined;
        try {
          localState = localStateDb
            .query<
              { status: string; stage: string; report_json: string | null },
              [string]
            >(
              `SELECT status, stage, report_json
               FROM execution_workspace_relocations WHERE relocation_id = ?`,
            )
            .get(retriedClaim.relocationId);
        } finally {
          localStateDb.close();
        }
        expect(localState).toMatchObject({
          status: "preparing",
          stage: "downloading",
          report_json: null,
        });
        expect(await readdir(localRoot)).toEqual([]);
        const corruptedBeforeRetry = await readFile(
          join(cacheDirectory, corruptReference),
        );
        expect(corruptedBeforeRetry.toString("hex")).toBe(expectedCorruptHex);
        const corruptReferenceFetchesBeforeRetry = requestedReferences.filter(
          (reference) => reference === corruptReference,
        ).length;
        expect(corruptReferenceFetchesBeforeRetry).toBe(1);

        const blocked = await daemon.executeWorkspaceRelocation(
          retriedClaim,
          fetchBlob,
        );
        expect(blocked.status).toBe("blocked");
        expect(blocked.errorCode).toBe(
          corrupt === "manifest"
            ? "workspace_relocation_cache_hash_mismatch"
            : corrupt === "workspace-blob-size"
              ? "workspace_relocation_cache_size_mismatch"
              : "workspace_relocation_checkpoint_invalid",
        );
        expect(
          requestedReferences.filter(
            (reference) => reference === corruptReference,
          ),
        ).toHaveLength(corruptReferenceFetchesBeforeRetry);
        expect(
          (await readFile(join(cacheDirectory, corruptReference))).toString(
            "hex",
          ),
        ).toBe(expectedCorruptHex);
        expect(await readdir(localRoot)).toEqual([]);
      } finally {
        daemon.close();
      }
    };
    await exerciseCorruptLocalCache("corrupt-manifest", "manifest");
    await exerciseCorruptLocalCache("corrupt-workspace-blob", "workspace-blob");
    await exerciseCorruptLocalCache(
      "wrong-size-workspace-blob",
      "workspace-blob-size",
    );

    const realGitPath = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const partialCrashDirectory = join(directory, "partial-restore-crash");
    const partialDestination = join(partialCrashDirectory, "destination");
    const partialDatabasePath = join(
      partialCrashDirectory,
      "destination-node.sqlite",
    );
    await mkdir(partialDestination, { recursive: true });
    const partialBarrierDirectory = join(partialCrashDirectory, "barrier");
    const partialGitShimDirectory = join(partialBarrierDirectory, "git-bin");
    await mkdir(partialGitShimDirectory, { recursive: true });
    const partialEnteredPath = join(partialBarrierDirectory, "entered");
    const partialOutputPath = join(partialBarrierDirectory, "git-output");
    const partialReleasePath = join(partialBarrierDirectory, "release");
    const partialGitShimPath = join(partialGitShimDirectory, "git");
    execFileSync("mkfifo", [partialReleasePath]);
    await writeFile(
      partialGitShimPath,
      `#!/bin/sh
set -e
case "$PWD" in
  "$UZINA_RELOCATION_TEST_STAGING_PARENT"/.uzina-restore-*)
    if [ "$1" = "diff" ] && [ "$2" = "--cached" ] &&
       [ "$3" = "--name-only" ] && [ "$4" = "-z" ] &&
       [ "$5" = "--no-renames" ] && [ "$6" = "HEAD" ]; then
      set +e
      "$UZINA_RELOCATION_TEST_REAL_GIT" "$@" > "$UZINA_RELOCATION_TEST_GIT_OUTPUT"
      status=$?
      set -e
      : > "$UZINA_RELOCATION_TEST_GIT_ENTERED"
      IFS= read -r release < "$UZINA_RELOCATION_TEST_GIT_RELEASE"
      cat "$UZINA_RELOCATION_TEST_GIT_OUTPUT"
      exit "$status"
    fi
    ;;
esac
exec "$UZINA_RELOCATION_TEST_REAL_GIT" "$@"
`,
    );
    await chmod(partialGitShimPath, 0o755);
    const partialGitBarrierWait = waitForCreatedFile(partialEnteredPath);
    let interruptedStaging: string | undefined;
    const partialRestoreChild = startWorkspaceRelocationChild({
      PATH: `${partialGitShimDirectory}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      UZINA_RELOCATION_TEST_CLAIM: JSON.stringify(retriedClaim),
      UZINA_RELOCATION_TEST_DATABASE: partialDatabasePath,
      UZINA_RELOCATION_TEST_WORKSPACE: partialDestination,
      UZINA_RELOCATION_TEST_CONTROLLER: baseUrl,
      UZINA_RELOCATION_TEST_NODE_ID: destinationNode.value.node.nodeId,
      UZINA_RELOCATION_TEST_NODE_CREDENTIAL: destinationNode.value.credential,
      UZINA_RELOCATION_TEST_GIT_CWD: "unused",
      UZINA_RELOCATION_TEST_GIT_OUTPUT: partialOutputPath,
      UZINA_RELOCATION_TEST_GIT_ENTERED: partialEnteredPath,
      UZINA_RELOCATION_TEST_GIT_RELEASE: partialReleasePath,
      UZINA_RELOCATION_TEST_REAL_GIT: realGitPath,
      UZINA_RELOCATION_TEST_STAGING_PARENT: await realpath(
        partialCrashDirectory,
      ),
    });
    try {
      await Promise.race([
        partialGitBarrierWait,
        partialRestoreChild.exited.then(async (exitCode) => {
          const output = await new Response(partialRestoreChild.stdout).text();
          throw new Error(
            `Partial relocation child exited before restore barrier (${exitCode}): ${output}`,
          );
        }),
      ]);
      const partialStateDb = new Database(partialDatabasePath, {
        readonly: true,
      });
      let partialState:
        | { status: string; stage: string; report_json: string | null }
        | null
        | undefined;
      try {
        partialState = partialStateDb
          .query<
            { status: string; stage: string; report_json: string | null },
            [string]
          >(
            `SELECT status, stage, report_json
             FROM execution_workspace_relocations WHERE relocation_id = ?`,
          )
          .get(retriedClaim.relocationId);
      } finally {
        partialStateDb.close();
      }
      expect(partialState).toMatchObject({
        status: "preparing",
        stage: "restore-started",
        report_json: null,
      });
      expect(await readdir(partialDestination)).toEqual([]);
      const stagingDirectories = (await readdir(partialCrashDirectory)).filter(
        (name) => name.startsWith(".uzina-restore-"),
      );
      expect(stagingDirectories).toHaveLength(1);
      interruptedStaging = join(partialCrashDirectory, stagingDirectories[0]!);
      expect(await readdir(interruptedStaging)).toEqual([".git"]);
      await stopOwnedProcessGroup(partialRestoreChild);
    } finally {
      await stopOwnedProcessGroup(partialRestoreChild);
    }
    const partialRecoveryDaemon = new ExecutionDaemon({
      databasePath: partialDatabasePath,
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      workspaces: [
        {
          workspaceId: destinationWorkspace.value.workspaceId,
          directory: partialDestination,
        },
      ],
    });
    try {
      await partialRecoveryDaemon.reconcileWorkspaceRelocations();
      const uncertainPartialReport =
        partialRecoveryDaemon.pendingWorkspaceRelocationReports()[0];
      expect(uncertainPartialReport).toMatchObject({
        relocationId: retriedClaim.relocationId,
        status: "uncertain",
        errorCode: "workspace_relocation_restore_unverified",
      });
      const uncertainPartialJson = JSON.stringify(uncertainPartialReport);
      expect(await readdir(partialDestination)).toEqual([]);
      expect(await readdir(interruptedStaging!)).toEqual([".git"]);
      await partialRecoveryDaemon.reconcileWorkspaceRelocations();
      expect(
        JSON.stringify(
          partialRecoveryDaemon.pendingWorkspaceRelocationReports()[0],
        ),
      ).toBe(uncertainPartialJson);
      expect(await readdir(partialDestination)).toEqual([]);
      expect(await readdir(interruptedStaging!)).toEqual([".git"]);
    } finally {
      partialRecoveryDaemon.close();
    }
    const claimStillUnreported = await call<{ status: string }>(
      baseUrl,
      relocationStatusPath,
      { credential: owner },
    );
    expect(claimStillUnreported.value.status).toBe("claimed");

    const barrierDirectory = join(directory, "restore-crash-barrier");
    const gitShimDirectory = join(barrierDirectory, "git-bin");
    await mkdir(gitShimDirectory, { recursive: true });
    const enteredPath = join(barrierDirectory, "verification-entered");
    const outputPath = join(barrierDirectory, "verification-output");
    const releasePath = join(barrierDirectory, "release-verification");
    const gitShimPath = join(gitShimDirectory, "git");
    execFileSync("mkfifo", [releasePath]);
    await writeFile(
      gitShimPath,
      `#!/bin/sh
set -eu
if [ "$PWD" = "$UZINA_RELOCATION_TEST_GIT_CWD" ] &&
   [ "$1" = "diff" ] && [ "$2" = "--cached" ] &&
   [ "$3" = "--name-only" ] && [ "$4" = "-z" ] &&
   [ "$5" = "--no-renames" ] && [ "$6" = "HEAD" ]; then
  set +e
  "$UZINA_RELOCATION_TEST_REAL_GIT" "$@" > "$UZINA_RELOCATION_TEST_GIT_OUTPUT"
  status=$?
  set -e
  : > "$UZINA_RELOCATION_TEST_GIT_ENTERED"
  IFS= read -r release < "$UZINA_RELOCATION_TEST_GIT_RELEASE"
  cat "$UZINA_RELOCATION_TEST_GIT_OUTPUT"
  exit "$status"
fi
exec "$UZINA_RELOCATION_TEST_REAL_GIT" "$@"
`,
    );
    await chmod(gitShimPath, 0o755);
    const gitBarrierWait = waitForCreatedFile(enteredPath);
    const restoreChild = startWorkspaceRelocationChild({
      PATH: `${gitShimDirectory}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      UZINA_RELOCATION_TEST_CLAIM: JSON.stringify(retriedClaim),
      UZINA_RELOCATION_TEST_DATABASE: destinationDatabasePath,
      UZINA_RELOCATION_TEST_WORKSPACE: destinationDirectory,
      UZINA_RELOCATION_TEST_CONTROLLER: baseUrl,
      UZINA_RELOCATION_TEST_NODE_ID: destinationNode.value.node.nodeId,
      UZINA_RELOCATION_TEST_NODE_CREDENTIAL: destinationNode.value.credential,
      UZINA_RELOCATION_TEST_GIT_CWD: await realpath(destinationDirectory),
      UZINA_RELOCATION_TEST_GIT_OUTPUT: outputPath,
      UZINA_RELOCATION_TEST_GIT_ENTERED: enteredPath,
      UZINA_RELOCATION_TEST_GIT_RELEASE: releasePath,
      UZINA_RELOCATION_TEST_REAL_GIT: realGitPath,
    });
    try {
      await Promise.race([
        gitBarrierWait,
        restoreChild.exited.then(async (exitCode) => {
          const output = await new Response(restoreChild.stdout).text();
          throw new Error(
            `Relocation restore child exited before verification barrier (${exitCode}): ${output}`,
          );
        }),
      ]);
      const restoreStartedDb = new Database(destinationDatabasePath, {
        readonly: true,
      });
      let restoreStartedReceipt:
        | {
            status: string;
            stage: string;
            cache_directory: string | null;
            report_json: string | null;
          }
        | null
        | undefined;
      try {
        restoreStartedReceipt = restoreStartedDb
          .query<
            {
              status: string;
              stage: string;
              cache_directory: string | null;
              report_json: string | null;
            },
            [string]
          >(
            `SELECT status, stage, cache_directory, report_json
             FROM execution_workspace_relocations WHERE relocation_id = ?`,
          )
          .get(relocationAdmission.value.relocationId);
      } finally {
        restoreStartedDb.close();
      }
      expect(restoreStartedReceipt).toMatchObject({
        status: "preparing",
        stage: "restore-started",
        report_json: null,
      });
      const manifestBytes = await readFile(
        join(
          restoreStartedReceipt!.cache_directory!,
          retriedClaim.manifestReference,
        ),
      );
      const manifest = JSON.parse(
        manifestBytes.toString("utf8"),
      ) as WorkspaceCheckpointManifest;
      const verifiedReferences = portableWorkspaceBlobReferences(
        manifest,
        retriedClaim.manifestReference,
        manifestBytes.byteLength,
      );
      const cacheNames = await readdir(restoreStartedReceipt!.cache_directory!);
      expect(cacheNames.sort()).toEqual(
        verifiedReferences.map(({ reference }) => reference).sort(),
      );
      for (const reference of verifiedReferences) {
        const bytes = await readFile(
          join(restoreStartedReceipt!.cache_directory!, reference.reference),
        );
        expect(bytes.byteLength).toBe(reference.size);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          reference.reference,
        );
      }
      expect(
        await readFile(join(destinationDirectory, "tracked.txt"), "utf8"),
      ).toBe("unstaged content\n");
      expect(await readdir(destinationDirectory)).toContain("binary");
      if (restoreChild.pid === undefined)
        throw new Error("Restore child has no owned process identifier");
      await stopOwnedProcessGroup(restoreChild);
      expect(existsSync(enteredPath)).toBe(true);
    } finally {
      await stopOwnedProcessGroup(restoreChild);
    }

    await evictFactory();
    destinationDaemon = new ExecutionDaemon({
      databasePath: destinationDatabasePath,
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      workspaces: [
        {
          workspaceId: destinationWorkspace.value.workspaceId,
          directory: destinationDirectory,
        },
      ],
    });
    await destinationDaemon.reconcileWorkspaceRelocations();
    expect(destinationDaemon.pendingWorkspaceRelocationReports()).toHaveLength(
      1,
    );
    destinationAbort = new AbortController();
    destinationLoop = new ExecutionLoop({
      daemon: destinationDaemon,
      controller: destinationController,
      pollIntervalMs: 20,
      heartbeatIntervalMs: 30_000,
    }).run(destinationAbort.signal);
    await until(async () => {
      const current = await call<{
        status: string;
        receiptSha256?: string;
        errorCode?: string;
      }>(baseUrl, relocationStatusPath, { credential: owner });
      if (
        current.value.status === "blocked" ||
        current.value.status === "uncertain"
      ) {
        throw new Error(JSON.stringify(current.value));
      }
      return current.value.status === "prepared-inactive";
    });
    const preparedRelocationStatus = await call<{
      status: string;
      receiptSha256: string;
    }>(baseUrl, relocationStatusPath, { credential: owner });
    expect(preparedRelocationStatus.value).toMatchObject({
      status: "prepared-inactive",
    });
    expect(preparedRelocationStatus.value.receiptSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(git(destinationDirectory, "show", ":tracked.txt")).toBe(
      "staged content\n",
    );
    expect(
      await readFile(join(destinationDirectory, "tracked.txt"), "utf8"),
    ).toBe("unstaged content\n");
    expect(await readFile(join(destinationDirectory, "binary"))).toEqual(
      Buffer.from([0, 255, 17, 128]),
    );
    expect(git(destinationDirectory, "status", "--porcelain").trim()).toBe(
      "MM tracked.txt\n?? binary",
    );
    expect(
      await stat(join(destinationDirectory, "binary")).then(
        (file) => file.mode & 0o111,
      ),
    ).toBe(0o111);

    expect(droppedDestinationClaimAcknowledgement).toBe(true);
    expect(lostClaimRelocationId).toBe(relocationAdmission.value.relocationId);
    expect(droppedPreparedReportAcknowledgement).toBe(true);

    const preparedHistory = await call<{
      status: string;
      currentReport: Record<string, unknown>;
      reportSha256: string;
      receiptSha256: string;
      previousReport: unknown;
      previousReportSha256: string | null;
      previousReceiptSha256: string | null;
    }>(baseUrl, "/__test/workspace-relocation-history", {
      body: { requestId: relocationRequest.requestId },
    });
    expect(preparedHistory.value).toMatchObject({
      status: "prepared-inactive",
      currentReport: { status: "prepared-inactive" },
      receiptSha256: preparedRelocationStatus.value.receiptSha256,
      previousReport: null,
      previousReportSha256: null,
      previousReceiptSha256: null,
    });
    const originalPreparedReport = preparedHistory.value.currentReport;

    destinationAbort.abort();
    await destinationLoop?.catch(() => {});
    destinationLoop = undefined;
    destinationAbort = undefined;
    await destinationDaemon.reconcileWorkspaceRelocations();
    expect(destinationDaemon.pendingWorkspaceRelocationReports()).toEqual([]);
    expect(
      await readFile(join(destinationDirectory, "tracked.txt"), "utf8"),
    ).toBe("unstaged content\n");

    const forgedDegradation = await call<{ error: string }>(
      baseUrl,
      `/v1/nodes/${destinationNode.value.node.nodeId}/workspace-relocations/${relocationAdmission.value.relocationId}/report`,
      {
        credential: destinationNode.value.credential,
        body: {
          contractVersion: 1,
          relocationId: relocationAdmission.value.relocationId,
          requestId: relocationAdmission.value.requestId,
          checkpointRequestId: relocationAdmission.value.checkpointRequestId,
          captureRequestId: relocationAdmission.value.captureRequestId,
          captureId: relocationAdmission.value.captureId,
          workspaceSnapshotRequestId:
            relocationAdmission.value.workspaceSnapshotRequestId,
          snapshotId: relocationAdmission.value.snapshotId,
          threadId: thread.value.threadId,
          source: relocationAdmission.value.source,
          destination: relocationAdmission.value.destination,
          ownershipGeneration: thread.value.ownershipGeneration,
          manifestReference: status.value.manifestReference,
          status: "uncertain",
          receiptSha256: "f".repeat(64),
          previousReceiptSha256: "0".repeat(64),
          reportedAt: new Date().toISOString(),
          errorCode: "workspace_relocation_restore_unverified",
        },
      },
    );
    expect(forgedDegradation.response.status).toBe(409);
    const unchangedPreparedHistory = await call<{
      status: string;
      currentReport: Record<string, unknown>;
      reportSha256: string;
      previousReport: unknown;
    }>(baseUrl, "/__test/workspace-relocation-history", {
      body: { requestId: relocationRequest.requestId },
    });
    expect(unchangedPreparedHistory.value).toMatchObject({
      status: "prepared-inactive",
      currentReport: originalPreparedReport,
      reportSha256: preparedHistory.value.reportSha256,
      previousReport: null,
    });

    const previousReceiptSha256 = preparedRelocationStatus.value.receiptSha256;
    const changedDestinationContent = "changed after preparation\n";
    await writeFile(
      join(destinationDirectory, "tracked.txt"),
      changedDestinationContent,
    );
    destinationDaemon.close();
    destinationDaemon = undefined;
    const unrelatedDestinationDirectory = join(
      directory,
      "unrelated-destination-workspace",
    );
    await mkdir(unrelatedDestinationDirectory);
    const reopenedDestinationDaemon = new ExecutionDaemon({
      databasePath: destinationDatabasePath,
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      workspaces: [
        {
          workspaceId: destinationWorkspace.value.workspaceId,
          directory: destinationDirectory,
        },
        {
          workspaceId: unrelatedDestinationWorkspace.value.workspaceId,
          directory: unrelatedDestinationDirectory,
        },
      ],
    });
    destinationDaemon = reopenedDestinationDaemon;
    await reopenedDestinationDaemon.reconcileWorkspaceRelocations();
    const pendingDegradation =
      reopenedDestinationDaemon.pendingWorkspaceRelocationReports();
    expect(pendingDegradation).toHaveLength(1);
    expect(pendingDegradation[0]).toMatchObject({
      relocationId: relocationAdmission.value.relocationId,
      status: "uncertain",
      previousReceiptSha256,
      errorCode: "workspace_relocation_restore_unverified",
    });
    expect(
      await readFile(join(destinationDirectory, "tracked.txt"), "utf8"),
    ).toBe(changedDestinationContent);
    expect(() =>
      reopenedDestinationDaemon.activateWorkspace(
        destinationWorkspace.value.workspaceId,
        thread.value.ownershipGeneration,
      ),
    ).toThrow(/workspace_relocation_reserved/);
    await expect(
      reopenedDestinationDaemon.executeJob({
        contractVersion: 1,
        jobId: "job:relocation-destination-must-stay-inactive",
        nodeId: destinationNode.value.node.nodeId,
        target: relocationRequest.destination,
        ownershipGeneration: thread.value.ownershipGeneration,
        operation: "write-file",
        path: "must-not-run.txt",
        contentBase64: Buffer.from("inactive").toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "workspace_fenced" });
    await expect(
      reopenedDestinationDaemon.rex.launch({
        contractVersion: 1,
        processId: "rex:relocation-destination-must-stay-inactive",
        nodeId: destinationNode.value.node.nodeId,
        target: relocationRequest.destination,
        ownershipGeneration: thread.value.ownershipGeneration,
        argv: ["true"],
      }),
    ).rejects.toMatchObject({ code: "workspace_fenced" });
    expect(await readdir(destinationDirectory)).not.toContain(
      "must-not-run.txt",
    );

    const canonicalDestinationDirectory = await realpath(destinationDirectory);
    const readLocalRelocation = () => {
      const destinationReceiptDb = new Database(destinationDatabasePath);
      try {
        return destinationReceiptDb
          .query<
            {
              status: string;
              stage: string;
              manifest_reference: string;
              workspace_root: string;
              receipt_sha256: string;
              previous_receipt_sha256: string | null;
              previous_receipt_json: string | null;
              receipt_json: string;
              report_json: string;
              reported_at: string | null;
            },
            [string]
          >(
            `SELECT status, stage, manifest_reference, workspace_root,
              receipt_sha256, previous_receipt_sha256, previous_receipt_json,
              receipt_json, report_json, reported_at
             FROM execution_workspace_relocations WHERE relocation_id = ?`,
          )
          .get(relocationAdmission.value.relocationId);
      } finally {
        destinationReceiptDb.close();
      }
    };
    const localUncertainReceipt = readLocalRelocation();
    expect(localUncertainReceipt).toMatchObject({
      status: "uncertain",
      stage: "terminal",
      manifest_reference: status.value.manifestReference,
      workspace_root: canonicalDestinationDirectory,
      previous_receipt_sha256: previousReceiptSha256,
    });
    expect(
      JSON.parse(localUncertainReceipt!.previous_receipt_json!).status,
    ).toBe("prepared-inactive");
    expect(
      JSON.parse(localUncertainReceipt!.receipt_json).previousReceiptSha256,
    ).toBe(previousReceiptSha256);

    let droppedUncertainReportAcknowledgement = false;
    const degradedDestinationController = withDroppedRelocationReplies(
      new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: destinationNode.value.node.nodeId,
        credential: destinationNode.value.credential,
      }),
      [
        {
          method: "reportWorkspaceRelocation",
          matches: (_result, args) =>
            typeof args[0] === "object" &&
            args[0] !== null &&
            "status" in args[0] &&
            args[0].status === "uncertain",
          async afterForward() {
            droppedUncertainReportAcknowledgement = true;
            await evictFactory();
          },
        },
      ],
    );
    destinationAbort = new AbortController();
    destinationLoop = new ExecutionLoop({
      daemon: reopenedDestinationDaemon,
      controller: degradedDestinationController,
      pollIntervalMs: 20,
      heartbeatIntervalMs: 30_000,
    }).run(destinationAbort.signal);
    await until(async () => {
      const current = await call<{ status: string }>(
        baseUrl,
        relocationStatusPath,
        { credential: owner },
      );
      return current.value.status === "uncertain";
    });
    expect(droppedUncertainReportAcknowledgement).toBe(true);
    await until(async () => Boolean(readLocalRelocation()?.reported_at));
    const uncertainRelocationStatus = await call<{
      relocationId: string;
      requestId: string;
      checkpointRequestId: string;
      captureRequestId: string;
      captureId: string;
      workspaceSnapshotRequestId: string;
      snapshotId: string;
      source: { nodeId: string; workspaceId: string };
      destination: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
      manifestReference: string;
      status: string;
      receiptSha256: string;
      previousReceiptSha256: string;
      errorCode: string;
    }>(baseUrl, relocationStatusPath, { credential: owner });
    expect(uncertainRelocationStatus.value).toMatchObject({
      relocationId: relocationAdmission.value.relocationId,
      requestId: relocationAdmission.value.requestId,
      checkpointRequestId: relocationAdmission.value.checkpointRequestId,
      captureRequestId: relocationAdmission.value.captureRequestId,
      captureId: relocationAdmission.value.captureId,
      workspaceSnapshotRequestId:
        relocationAdmission.value.workspaceSnapshotRequestId,
      snapshotId: relocationAdmission.value.snapshotId,
      source: relocationAdmission.value.source,
      destination: relocationAdmission.value.destination,
      ownershipGeneration: thread.value.ownershipGeneration,
      manifestReference: status.value.manifestReference,
      status: "uncertain",
      previousReceiptSha256,
      errorCode: "workspace_relocation_restore_unverified",
    });
    expect(uncertainRelocationStatus.value.receiptSha256).not.toBe(
      previousReceiptSha256,
    );
    const degradedHistory = await call<{
      status: string;
      currentReport: Record<string, unknown>;
      reportSha256: string;
      receiptSha256: string;
      previousReport: Record<string, unknown>;
      previousReportSha256: string;
      previousReceiptSha256: string;
    }>(baseUrl, "/__test/workspace-relocation-history", {
      body: { requestId: relocationRequest.requestId },
    });
    expect(degradedHistory.value).toMatchObject({
      status: "uncertain",
      currentReport: {
        status: "uncertain",
        previousReceiptSha256,
      },
      reportSha256: expect.any(String),
      receiptSha256: uncertainRelocationStatus.value.receiptSha256,
      previousReport: originalPreparedReport,
      previousReportSha256: preparedHistory.value.reportSha256,
      previousReceiptSha256,
    });
    const sourceFenceAfterDegradation = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/capture-controls/${sourceAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(sourceFenceAfterDegradation.value).toEqual(
      fencedCaptureReceipt.value,
    );

    destinationAbort.abort();
    await destinationLoop?.catch(() => {});
    destinationLoop = undefined;
    destinationAbort = undefined;
    const authorityBeforeMigration = await call<
      Record<string, Array<Record<string, unknown>>>
    >(baseUrl, "/__test/workspace-ownership-migration", {
      body: { action: "read" },
    });
    expect(
      authorityBeforeMigration.value.controls.some(
        (row) => row.status === "source-capture-fenced",
      ),
    ).toBe(true);
    expect(
      authorityBeforeMigration.value.snapshots.some(
        (row) => row.status === "workspace-checkpoint-available",
      ),
    ).toBe(true);
    expect(
      authorityBeforeMigration.value.checkpoints.some(
        (row) => row.status === "available",
      ),
    ).toBe(true);
    expect(
      authorityBeforeMigration.value.relocations.some(
        (row) => row.ownership_generation === 0 && row.report_json !== null,
      ),
    ).toBe(true);
    const legacyAuthoritySchema = await call(
      baseUrl,
      "/__test/workspace-ownership-migration",
      { body: { action: "drop-authority-column" } },
    );
    expect(legacyAuthoritySchema.response.status).toBe(200);
    await evictFactory();
    const authorityAfterMigration = await call<
      Record<string, Array<Record<string, unknown>>>
    >(baseUrl, "/__test/workspace-ownership-migration", {
      body: { action: "read" },
    });
    expect(authorityAfterMigration.value).toEqual(
      authorityBeforeMigration.value,
    );

    await expect(
      reopenedDestinationDaemon.executeJob({
        contractVersion: 1,
        jobId: "job:relocation-unrelated-workspace-remains-usable",
        nodeId: destinationNode.value.node.nodeId,
        target: {
          nodeId: destinationNode.value.node.nodeId,
          workspaceId: unrelatedDestinationWorkspace.value.workspaceId,
        },
        ownershipGeneration: thread.value.ownershipGeneration,
        operation: "write-file",
        path: "still-operational.txt",
        contentBase64: Buffer.from("unrelated remains usable").toString(
          "base64",
        ),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(
      await readFile(
        join(unrelatedDestinationDirectory, "still-operational.txt"),
        "utf8",
      ),
    ).toBe("unrelated remains usable");

    reopenedDestinationDaemon.close();
    destinationDaemon = undefined;
    const aliasDestinationDaemon = new ExecutionDaemon({
      databasePath: destinationDatabasePath,
      nodeId: destinationNode.value.node.nodeId,
      nodeCredential: destinationNode.value.credential,
      workspaces: [
        {
          workspaceId: destinationWorkspace.value.workspaceId,
          directory: destinationDirectory,
        },
        {
          workspaceId: "workspace:relocation-alias",
          directory: destinationDirectory,
        },
        {
          workspaceId: unrelatedDestinationWorkspace.value.workspaceId,
          directory: unrelatedDestinationDirectory,
        },
      ],
    });
    destinationDaemon = aliasDestinationDaemon;
    await expect(
      aliasDestinationDaemon.executeJob({
        contractVersion: 1,
        jobId: "job:relocation-physical-alias-must-stay-fenced",
        nodeId: destinationNode.value.node.nodeId,
        target: {
          nodeId: destinationNode.value.node.nodeId,
          workspaceId: "workspace:relocation-alias",
        },
        ownershipGeneration: thread.value.ownershipGeneration,
        operation: "write-file",
        path: "alias-must-not-run.txt",
        contentBase64: Buffer.from("must remain blocked").toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "workspace_relocation_reserved" });
    expect(await readdir(destinationDirectory)).not.toContain(
      "alias-must-not-run.txt",
    );
    aliasDestinationDaemon.close();
    destinationDaemon = undefined;

    const completedJournal = await readCheckpointJournal();
    expect(completedJournal).toMatchObject({
      status: "available",
      stage: "available",
      runtimeRequirements: expectedRuntimeRequirements,
    });
    const completedRuntimeEvidenceArtifacts = completedJournal.artifacts
      .filter(
        (artifact) =>
          artifact.role === "runtime" || artifact.role === "evidence",
      )
      .sort((left, right) => left.role.localeCompare(right.role));
    expect(completedRuntimeEvidenceArtifacts).toEqual(
      interruptedRuntimeEvidenceArtifacts,
    );
    expect(await listPrivateCheckpointObjects()).toEqual(
      completedJournal.artifacts
        .map(({ reference, size }) => ({ reference, size }))
        .sort((left, right) => left.reference.localeCompare(right.reference)),
    );
    await call(baseUrl, "/__test/checkpoint-export-response", {
      body: { action: "allow" },
    });
    const nodeCheckpointStatus = await call<{ error: string }>(
      baseUrl,
      checkpointStatusPath,
      { credential: node.value.credential },
    );
    expect(nodeCheckpointStatus.response.status).toBe(403);
    const conflictingCheckpointId = await call<{ error: string }>(
      baseUrl,
      checkpointPath,
      {
        credential: owner,
        body: {
          ...coherentRequest,
          workspaceSnapshotRequestId: "snapshot:other-request",
        },
      },
    );
    expect(conflictingCheckpointId.response.status).toBe(409);
    const secondCheckpointForCapture = await call<{ error: string }>(
      baseUrl,
      checkpointPath,
      {
        credential: owner,
        body: { ...coherentRequest, requestId: "checkpoint:second-id" },
      },
    );
    expect(secondCheckpointForCapture.response.status).toBe(409);
    const wrongThreadCheckpoint = await call<{ error: string }>(
      baseUrl,
      "/v1/threads/thread:wrong-checkpoint-thread/managed-work-checkpoints",
      {
        credential: owner,
        body: { ...coherentRequest, requestId: "checkpoint:wrong-thread" },
      },
    );
    expect(wrongThreadCheckpoint.response.status).toBe(409);
    const wrongThreadCheckpointStatus = await call<{ error: string }>(
      baseUrl,
      "/v1/managed-work-checkpoints/checkpoint:wrong-thread",
      { credential: owner },
    );
    expect(wrongThreadCheckpointStatus.response.status).toBe(404);

    await evictFactory();
    const reopenedCheckpointStatus = await call<Record<string, unknown>>(
      baseUrl,
      checkpointStatusPath,
      { credential: owner },
    );
    expect(reopenedCheckpointStatus.value).toEqual(checkpointStatus.value);
    const reopenedRelocationStatus = await call<Record<string, unknown>>(
      baseUrl,
      relocationStatusPath,
      { credential: owner },
    );
    expect(reopenedRelocationStatus.value).toMatchObject({
      relocationId: relocationAdmission.value.relocationId,
      requestId: relocationAdmission.value.requestId,
      checkpointRequestId: relocationAdmission.value.checkpointRequestId,
      captureRequestId: relocationAdmission.value.captureRequestId,
      captureId: relocationAdmission.value.captureId,
      workspaceSnapshotRequestId:
        relocationAdmission.value.workspaceSnapshotRequestId,
      snapshotId: relocationAdmission.value.snapshotId,
      source: relocationAdmission.value.source,
      destination: relocationAdmission.value.destination,
      ownershipGeneration: relocationAdmission.value.ownershipGeneration,
      manifestReference: relocationAdmission.value.manifestReference,
      status: "uncertain",
      previousReceiptSha256,
    });
    expect(reopenedRelocationStatus.value.receiptSha256).toBe(
      uncertainRelocationStatus.value.receiptSha256,
    );
    const reopenedRelocationRetry = await call<Record<string, unknown>>(
      baseUrl,
      relocationPath,
      { credential: owner, body: relocationRequest },
    );
    expect(reopenedRelocationRetry.value).toMatchObject({
      relocationId: relocationAdmission.value.relocationId,
      requestId: relocationAdmission.value.requestId,
      status: "uncertain",
      receiptSha256: reopenedRelocationStatus.value.receiptSha256,
      previousReceiptSha256,
    });
    const reopenedCheckpointRetry = await call<Record<string, unknown>>(
      baseUrl,
      checkpointPath,
      { credential: owner, body: coherentRequest },
    );
    expect(reopenedCheckpointRetry.value).toEqual(checkpointStatus.value);
    startExecutionLoop();
    await waitForNodeOnline();

    const getManagedCheckpointBlob = async (
      reference: string,
      credential = owner,
    ): Promise<Uint8Array> => {
      const response = await fetch(
        new URL(
          `/v1/managed-work-checkpoints/${coherentRequest.requestId}/blobs/${reference}`,
          baseUrl,
        ),
        { headers: { authorization: `Bearer ${credential}` } },
      );
      if (!response.ok) {
        throw new Error(
          `managed-work blob retrieval refused (${response.status})`,
        );
      }
      expect(response.headers.get("x-content-sha256")).toBe(reference);
      return new Uint8Array(await response.arrayBuffer());
    };
    const getWorkspaceCheckpointBlob = async (
      reference: string,
    ): Promise<Uint8Array> => {
      const response = await fetch(
        new URL(
          `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${reference}`,
          baseUrl,
        ),
        { headers: { authorization: `Bearer ${owner}` } },
      );
      if (!response.ok) {
        throw new Error(
          `workspace blob retrieval refused (${response.status})`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    };
    const outerBytes = await getManagedCheckpointBlob(
      checkpointStatus.value.manifestReference,
    );
    const outerManifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(outerBytes),
    ) as ManagedWorkBundleManifest;
    expect(outerManifest.runtime.requirements).toEqual(
      expectedRuntimeRequirements,
    );
    const runtimeArtifact = outerManifest.workspace.runtimeArtifact?.artifact;
    if (!runtimeArtifact)
      throw new Error("Final managed-work runtime is missing");
    const evidenceAttachment = outerManifest.workspace.attachments.find(
      (attachment) => attachment.name === "factory-provenance.json",
    );
    if (!evidenceAttachment) {
      throw new Error("Final factory provenance attachment is missing");
    }
    const sourceManifestBytes = await getWorkspaceCheckpointBlob(
      status.value.manifestReference,
    );
    const sourceManifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(sourceManifestBytes),
    ) as WorkspaceCheckpointManifest;
    const sourceReferences = portableWorkspaceBlobReferences(
      sourceManifest,
      status.value.manifestReference,
      sourceManifestBytes.byteLength,
    );
    const innerManifestBytes = await getManagedCheckpointBlob(
      outerManifest.workspaceManifestReference,
    );
    const evidenceBytes = await getManagedCheckpointBlob(
      evidenceAttachment.blob.reference,
    );
    const evidence = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes),
    ) as FactoryProvenanceEvidence;
    const evidenceJson = JSON.stringify(evidence);
    if (!executionEffectJobId)
      throw new Error("Execution receipt was not admitted");
    expect(evidence.commands.length).toBe(1);
    expect(evidence.commands[0]?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.commands[0]?.dispatchStatus).toBe("completed");
    expect(evidence.commands[0]?.executionEffects).toHaveLength(2);
    expect(evidence.commands[0]?.executionEffects[0]).toMatchObject({
      jobId: executionEffectJobId,
      nodeId: node.value.node.nodeId,
      target: {
        nodeId: node.value.node.nodeId,
        workspaceId: workspaceRecord.value.workspaceId,
      },
      operation: "read-file",
      status: "completed",
      errorCode: null,
    });
    expect(evidence.commands[0]?.executionEffects[0]?.payloadSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const failedProvenanceEffect = evidence.commands[0]?.executionEffects.find(
      (effect) => effect.jobId === failedEffectJobId,
    );
    expect(failedProvenanceEffect?.errorCode as string | null | undefined).toBe(
      failedEffectReceipt?.errorCode as string | null | undefined,
    );
    expect(evidenceJson).not.toContain("Capture the settled managed Pi root.");
    expect(evidenceJson).not.toContain("The captured Pi root is settled.");
    expect(evidenceJson).not.toContain("unstaged content");
    expect(evidenceJson).not.toContain("contentBase64");
    expect(evidenceJson).not.toContain("UZINA_MODEL_API_KEY");
    expect(evidenceJson).not.toContain("outcome");
    expect(evidenceJson).not.toContain("stdout");
    expect(evidenceJson).not.toContain("stderr");
    const privateArtifacts: ManagedWorkCheckpointArtifactReference[] = [
      {
        role: "runtime",
        reference: runtimeArtifact.reference,
        size: runtimeArtifact.size,
      },
      {
        role: "evidence",
        reference: evidenceAttachment.blob.reference,
        size: evidenceAttachment.blob.size,
      },
      {
        role: "inner-manifest",
        reference: outerManifest.workspaceManifestReference,
        size: innerManifestBytes.byteLength,
      },
      {
        role: "outer-manifest",
        reference: checkpointStatus.value.manifestReference,
        size: outerBytes.byteLength,
      },
    ];
    const verifyClosure = async () => {
      const response = await fetch(
        new URL("/__test/verify-checkpoint", baseUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: coherentRequest.requestId,
            captureId: sourceAdmission.value.captureId,
            sourceWorkspaceManifestReference: status.value.manifestReference,
            authoritativeWorkspaceReferences: sourceReferences.map(
              (object) => ({
                reference: object.reference,
                size: object.size,
              }),
            ),
            manifestReference: checkpointStatus.value.manifestReference,
            expectedEvidence: evidence,
            privateArtifacts,
          }),
        },
      );
      const body = await response.text();
      return {
        status: response.status,
        json: async () => JSON.parse(body) as unknown,
      };
    };
    const verifiedClosure = await verifyClosure();
    expect(verifiedClosure.status).toBe(200);
    expect(await verifiedClosure.json()).toEqual({
      checkpointRequestId: coherentRequest.requestId,
      captureId: sourceAdmission.value.captureId,
      sourceWorkspaceManifestReference: status.value.manifestReference,
      manifestReference: checkpointStatus.value.manifestReference,
      workspaceObjectCount: sourceReferences.length,
      privateObjectCount: privateArtifacts.length,
      totalBytes:
        sourceReferences.reduce((sum, object) => sum + object.size, 0) +
        privateArtifacts.reduce((sum, object) => sum + object.size, 0),
    });

    const privateOrphan = await call<{ reference: string }>(
      baseUrl,
      `/__test/checkpoint-storage/${coherentRequest.requestId}/orphan`,
      {
        body: {
          bytes: [...new TextEncoder().encode("unlisted private object")],
        },
      },
    );
    expect(privateOrphan.response.status).toBe(200);
    expect((await verifyClosure()).status).toBe(422);
    await fetchAndConsume(
      new URL(
        `/__test/checkpoint-storage/${coherentRequest.requestId}/${privateOrphan.value.reference}/delete`,
        baseUrl,
      ),
      { method: "POST" },
    );
    expect((await verifyClosure()).status).toBe(200);

    const originalRuntimeBytes = await getManagedCheckpointBlob(
      runtimeArtifact.reference,
    );
    await fetchAndConsume(
      new URL(
        `/__test/checkpoint-storage/${coherentRequest.requestId}/${runtimeArtifact.reference}/delete`,
        baseUrl,
      ),
      { method: "POST" },
    );
    expect((await verifyClosure()).status).toBe(422);
    await fetchAndConsume(
      new URL(
        `/__test/checkpoint-storage/${coherentRequest.requestId}/${runtimeArtifact.reference}/replace`,
        baseUrl,
      ),
      {
        method: "POST",
        body: originalRuntimeBytes.buffer.slice(
          originalRuntimeBytes.byteOffset,
          originalRuntimeBytes.byteOffset + originalRuntimeBytes.byteLength,
        ) as ArrayBuffer,
      },
    );
    const corruptRuntime = new Uint8Array(originalRuntimeBytes);
    corruptRuntime[0] = corruptRuntime[0]! ^ 0xff;
    await fetchAndConsume(
      new URL(
        `/__test/checkpoint-storage/${coherentRequest.requestId}/${runtimeArtifact.reference}/replace`,
        baseUrl,
      ),
      {
        method: "POST",
        body: corruptRuntime.buffer.slice(
          corruptRuntime.byteOffset,
          corruptRuntime.byteOffset + corruptRuntime.byteLength,
        ) as ArrayBuffer,
      },
    );
    expect((await verifyClosure()).status).toBe(422);
    await fetchAndConsume(
      new URL(
        `/__test/checkpoint-storage/${coherentRequest.requestId}/${runtimeArtifact.reference}/replace`,
        baseUrl,
      ),
      {
        method: "POST",
        body: originalRuntimeBytes.buffer.slice(
          originalRuntimeBytes.byteOffset,
          originalRuntimeBytes.byteOffset + originalRuntimeBytes.byteLength,
        ) as ArrayBuffer,
      },
    );

    const corruptSource = sourceReferences.find(
      (object) =>
        object.reference !== status.value.manifestReference && object.size > 1,
    );
    if (!corruptSource)
      throw new Error("Workspace source has no testable blob");
    const originalSourceBytes = await getWorkspaceCheckpointBlob(
      corruptSource.reference,
    );
    const changedSourceBytes = new Uint8Array(originalSourceBytes);
    changedSourceBytes[0] = changedSourceBytes[0]! ^ 0xff;
    await fetchAndConsume(
      new URL(
        `/__test/workspace-storage/${sourceAdmission.value.captureId}/${corruptSource.reference}/replace`,
        baseUrl,
      ),
      {
        method: "POST",
        body: changedSourceBytes.buffer.slice(
          changedSourceBytes.byteOffset,
          changedSourceBytes.byteOffset + changedSourceBytes.byteLength,
        ) as ArrayBuffer,
      },
    );
    expect((await verifyClosure()).status).toBe(422);
    await fetchAndConsume(
      new URL(
        `/__test/workspace-storage/${sourceAdmission.value.captureId}/${corruptSource.reference}/replace`,
        baseUrl,
      ),
      {
        method: "POST",
        body: originalSourceBytes.buffer.slice(
          originalSourceBytes.byteOffset,
          originalSourceBytes.byteOffset + originalSourceBytes.byteLength,
        ) as ArrayBuffer,
      },
    );
    expect((await verifyClosure()).status).toBe(200);
    await fetchAndConsume(
      new URL(
        `/__test/workspace-storage/${sourceAdmission.value.captureId}/${corruptSource.reference}/delete`,
        baseUrl,
      ),
      { method: "POST" },
    );
    expect((await verifyClosure()).status).toBe(422);
    await fetchAndConsume(
      new URL(
        `/__test/workspace-storage/${sourceAdmission.value.captureId}/${corruptSource.reference}/replace`,
        baseUrl,
      ),
      {
        method: "POST",
        body: originalSourceBytes.buffer.slice(
          originalSourceBytes.byteOffset,
          originalSourceBytes.byteOffset + originalSourceBytes.byteLength,
        ) as ArrayBuffer,
      },
    );
    expect((await verifyClosure()).status).toBe(200);

    const checkpointTransport: BlobTransport = {
      async putBlob() {
        throw new Error("owner checkpoint restore transport is read-only");
      },
      async getBlob(reference) {
        if (sourceReferences.some((object) => object.reference === reference)) {
          return getWorkspaceCheckpointBlob(reference);
        }
        return getManagedCheckpointBlob(reference);
      },
    };
    const bundleValidation = await validateManagedWorkBundle(
      checkpointStatus.value.manifestReference,
      checkpointTransport,
      { supportedRuntimeRequirements: expectedRuntimeRequirements },
    );
    expect(bundleValidation.manifest.runtime.requirements).toEqual(
      expectedRuntimeRequirements,
    );
    expect(bundleValidation.managedWork.rootConversationId).toBe(
      ROOT_CONVERSATION_ID,
    );
    const incompatibleRuntimeRequirements =
      expectedSourceRuntimeRequirements.filter(
        (requirement) =>
          requirement !== "model:uzina-capture-test/capture-test-model",
      );
    await expect(
      validateManagedWorkBundle(
        checkpointStatus.value.manifestReference,
        checkpointTransport,
        {
          supportedRuntimeRequirements: incompatibleRuntimeRequirements,
        },
      ),
    ).rejects.toThrow(
      "Unsupported runtime requirements: model:uzina-capture-test/capture-test-model",
    );

    // Rebuild the same Pi runtime with the pre-profile generic-only contract:
    // a destination that knows only the fixed v1 baseline accepts it despite
    // the real source requiring the seeded model and remote-tool catalog.
    const legacyPrivateTransport = new FileBlobTransport(
      join(directory, "legacy-generic-checkpoint-blobs"),
    );
    const legacyTransport: BlobTransport = {
      putBlob: (bytes) => legacyPrivateTransport.putBlob(bytes),
      getBlob: (reference) =>
        sourceReferences.some((object) => object.reference === reference)
          ? checkpointTransport.getBlob(reference)
          : legacyPrivateTransport.getBlob(reference),
    };
    const legacyPrepared = await prepareManagedWorkBundleComposition({
      managedWork: bundleValidation.managedWork,
    });
    const legacyBundle = await composeManagedWorkBundleFromWorkspace({
      prepared: legacyPrepared,
      workspaceManifest: sourceManifest,
      workspaceManifestReference: status.value.manifestReference,
      workspaceManifestBytes: sourceManifestBytes,
      transport: legacyTransport,
    });
    expect(legacyBundle.manifest.runtime.requirements).toEqual([
      ...MANAGED_WORK_RUNTIME_REQUIREMENTS,
    ]);
    const legacyGenericOnlyValidation = await validateManagedWorkBundle(
      legacyBundle.manifestReference,
      legacyTransport,
    );
    expect(legacyGenericOnlyValidation.managedWork.rootConversationId).toBe(
      ROOT_CONVERSATION_ID,
    );

    const restoredManagedWork = await restoreManagedWorkBundle({
      manifestReference: checkpointStatus.value.manifestReference,
      transport: checkpointTransport,
      destinationPath: join(directory, "prepared-managed-work"),
      supportedRuntimeRequirements: expectedRuntimeRequirements,
      async openStorage(path) {
        const storage = await openBunSqliteStorage(path);
        return {
          storage,
          close: () => storage.close(BACKGROUND_CONTEXT),
        };
      },
    });
    expect(restoredManagedWork.receipt.status).toBe("prepared-inactive");
    expect(restoredManagedWork.provenanceAttachments).toHaveLength(1);
    expect(restoredManagedWork.provenanceAttachments[0]?.bytes).toEqual(
      evidenceBytes,
    );
    expect(
      await Bun.file(
        join(restoredManagedWork.workspacePath, "tracked.txt"),
      ).text(),
    ).toBe("unstaged content\n");
    const unauthenticatedManagedBlob = await fetchAndConsume(
      new URL(
        `/v1/managed-work-checkpoints/${coherentRequest.requestId}/blobs/${checkpointStatus.value.manifestReference}`,
        baseUrl,
      ),
    );
    expect(unauthenticatedManagedBlob).toBe(401);
    const nodeManagedBlob = await fetchAndConsume(
      new URL(
        `/v1/managed-work-checkpoints/${coherentRequest.requestId}/blobs/${checkpointStatus.value.manifestReference}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${node.value.credential}` } },
    );
    expect(nodeManagedBlob).toBe(403);

    const recoveryCapture = await call<{
      requestId: string;
      captureId: string;
    }>(
      baseUrl,
      `/v1/threads/${recoveryThread.value.threadId}/capture-controls`,
      {
        credential: owner,
        body: {
          contractVersion: 1,
          requestId: "request:lost-export-ack-fence",
        },
      },
    );
    expect(recoveryCapture.response.status).toBe(202);
    await until(async () => {
      const current = await call<{ status: string }>(
        baseUrl,
        `/v1/capture-controls/${recoveryCapture.value.requestId}`,
        { credential: owner },
      );
      return current.value.status === "source-capture-fenced";
    });
    const recoveryCaptureFence = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/capture-controls/${recoveryCapture.value.requestId}`,
      { credential: owner },
    );
    const recoverySnapshot = await call<{
      requestId: string;
      manifestReference?: string;
    }>(baseUrl, "/v1/workspace-snapshots", {
      credential: owner,
      body: {
        contractVersion: 1,
        requestId: "snapshot:lost-export-ack",
        captureRequestId: recoveryCapture.value.requestId,
      },
    });
    expect(recoverySnapshot.response.status).toBe(202);
    await until(async () => {
      const current = await call<{ status: string }>(
        baseUrl,
        `/v1/workspace-snapshots/${recoverySnapshot.value.requestId}`,
        { credential: owner },
      );
      return current.value.status === "workspace-checkpoint-available";
    });
    const exportCountersBefore = await call<{
      attempts: number;
      lostResponses: number;
    }>(baseUrl, "/__test/checkpoint-export-response", {
      body: { action: "stats" },
    });
    await call(baseUrl, "/__test/checkpoint-export-response", {
      body: { action: "lose-next" },
    });
    const uncertainRequest = {
      contractVersion: 1,
      requestId: "checkpoint:lost-export-ack",
      captureRequestId: recoveryCapture.value.requestId,
      workspaceSnapshotRequestId: recoverySnapshot.value.requestId,
    };
    const uncertainAdmission = await call<{ requestId: string }>(
      baseUrl,
      `/v1/threads/${recoveryThread.value.threadId}/managed-work-checkpoints`,
      { credential: owner, body: uncertainRequest },
    );
    expect(uncertainAdmission.response.status).toBe(202);
    const uncertainStatusPath = `/v1/managed-work-checkpoints/${uncertainRequest.requestId}`;
    await until(async () => {
      const current = await call<{ status: string }>(
        baseUrl,
        uncertainStatusPath,
        { credential: owner },
      );
      return current.value.status === "uncertain";
    });
    const uncertainStatus = await call<{
      status: string;
      stage: string;
      manifestReference?: string;
    }>(baseUrl, uncertainStatusPath, { credential: owner });
    expect(uncertainStatus.value).toMatchObject({
      status: "uncertain",
      stage: "runtime-export-started",
    });
    expect(uncertainStatus.value.manifestReference).toBeUndefined();
    const unavailableUncertainBlob = await fetchAndConsume(
      new URL(
        `/v1/managed-work-checkpoints/${uncertainRequest.requestId}/blobs/${"a".repeat(64)}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(unavailableUncertainBlob).toBe(404);
    const exportCountersAfter = await call<{
      attempts: number;
      lostResponses: number;
    }>(baseUrl, "/__test/checkpoint-export-response", {
      body: { action: "stats" },
    });
    expect(exportCountersAfter.value.attempts).toBe(
      exportCountersBefore.value.attempts + 1,
    );
    expect(exportCountersAfter.value.lostResponses).toBe(
      exportCountersBefore.value.lostResponses + 1,
    );
    await stopExecutionLoop();
    await miniflare.dispose();
    miniflare = createMiniflare();
    fixture.miniflare = miniflare;
    baseUrl = (await miniflare.ready).toString();
    const uncertainAfterReopen = await call<Record<string, unknown>>(
      baseUrl,
      uncertainStatusPath,
      { credential: owner },
    );
    expect(uncertainAfterReopen.value).toEqual(uncertainStatus.value);
    const captureFenceAfterReopen = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/capture-controls/${recoveryCapture.value.requestId}`,
      { credential: owner },
    );
    expect(captureFenceAfterReopen.value).toEqual(recoveryCaptureFence.value);
    const countersAfterReopen = await call<{
      attempts: number;
      lostResponses: number;
    }>(baseUrl, "/__test/checkpoint-export-response", {
      body: { action: "stats" },
    });
    expect(countersAfterReopen.value).toEqual({
      attempts: 0,
      lostResponses: 0,
    });
    const uncertainRetry = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/threads/${recoveryThread.value.threadId}/managed-work-checkpoints`,
      { credential: owner, body: uncertainRequest },
    );
    expect(uncertainRetry.response.status).toBe(202);
    expect(uncertainRetry.value).toEqual(uncertainStatus.value);
    const exportCountersAfterRetry = await call<{
      attempts: number;
      lostResponses: number;
    }>(baseUrl, "/__test/checkpoint-export-response", {
      body: { action: "stats" },
    });
    expect(exportCountersAfterRetry.value).toEqual(countersAfterReopen.value);

    const exportRequest = {
      captureId: sourceAdmission.value.captureId,
      captureRequestId: sourceAdmission.value.requestId,
    };
    expect(
      (await providerConfiguration(baseUrl, "unusable")).response.status,
    ).toBe(200);
    // The full Miniflare restart leaves the captured object cold; unusable production credentials make any accidental runtime open fail.
    const coldConstructionResult = await managedWorkCall<{
      modelCalls: number;
      alarmCalls: number;
    }>(baseUrl, thread.value.threadId, { kind: "observe" });
    expect(coldConstructionResult.response.status).toBe(200);
    const coldConstruction = coldConstructionResult.value;
    expect(coldConstruction.modelCalls).toBe(0);
    expect(coldConstruction.alarmCalls).toBe(0);
    const refusedCapturedWork = await managedWorkCall<Record<string, string>>(
      baseUrl,
      thread.value.threadId,
      { kind: "refusals" },
    );
    expect(refusedCapturedWork.value).toMatchObject({
      create: expect.stringContaining("active capture lock"),
      acceptManagedInput: expect.stringContaining("active capture lock"),
      submit: expect.stringContaining("active capture lock"),
      context: expect.stringContaining("active capture lock"),
      status: expect.stringContaining("active capture lock"),
      resume: expect.stringContaining("active capture lock"),
    });
    const coldExportResult = await managedWorkCall<{
      captureId: string;
      captureRequestId: string;
      threadId: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
      rootConversationId: number;
      profile: string;
      sourceRuntimeProfile: {
        version: number;
        threadId: string;
        model: { provider: string; modelId: string };
        requirements: string[];
        captureId: string;
        captureRequestId: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
        checkpointSha256: string;
      } | null;
      checkpointSha256: string;
      sizeBytes: number;
      bytes: number[];
    }>(baseUrl, thread.value.threadId, {
      kind: "export",
      request: exportRequest,
    });
    expect(coldExportResult.response.status).toBe(200);
    const coldExport = {
      ...coldExportResult.value,
      bytes: Uint8Array.from(coldExportResult.value.bytes),
    };
    expect(coldExport).toMatchObject({
      captureId: sourceAdmission.value.captureId,
      captureRequestId: sourceAdmission.value.requestId,
      threadId: thread.value.threadId,
      target: {
        nodeId: node.value.node.nodeId,
        workspaceId: workspaceRecord.value.workspaceId,
      },
      ownershipGeneration: thread.value.ownershipGeneration,
      rootConversationId: ROOT_CONVERSATION_ID,
      profile: "quiescent-current-documents-no-forks-v1",
      sourceRuntimeProfile: {
        version: 1,
        threadId: thread.value.threadId,
        model: {
          provider: "uzina-capture-test",
          modelId: "capture-test-model",
        },
        requirements: expectedSourceRuntimeRequirements,
        captureId: sourceAdmission.value.captureId,
        captureRequestId: sourceAdmission.value.requestId,
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspaceRecord.value.workspaceId,
        },
        ownershipGeneration: thread.value.ownershipGeneration,
        checkpointSha256: coldExport.checkpointSha256,
      },
      sizeBytes: coldExport.bytes.byteLength,
    });
    expect(Object.keys(coldExport.sourceRuntimeProfile ?? {}).sort()).toEqual(
      [
        "captureId",
        "captureRequestId",
        "checkpointSha256",
        "model",
        "ownershipGeneration",
        "requirements",
        "target",
        "threadId",
        "version",
      ].sort(),
    );
    expect(JSON.stringify(coldExport.sourceRuntimeProfile)).not.toContain(
      "apiKey",
    );
    const checkpoint = await validateManagedWorkCheckpoint(
      JSON.parse(new TextDecoder().decode(coldExport.bytes)),
    );
    expect(checkpoint.sha256).toBe(coldExport.checkpointSha256);
    expect(checkpoint.conversations).toEqual(sourceObservation.conversations);
    expect(checkpoint.entries).toEqual(sourceObservation.entries);
    expect(checkpoint.tasks).toEqual(sourceObservation.tasks);
    expect(checkpoint.submissions).toEqual(sourceObservation.submissions);
    expect(checkpoint.documents).toEqual(sourceObservation.documents);
    const checkpointJson = JSON.stringify(checkpoint);
    expect(checkpointJson).toContain("Capture the settled managed Pi root.");
    expect(checkpointJson).toContain("The captured Pi root is settled.");
    expect(checkpoint.submissions).toContainEqual(
      expect.objectContaining({ requestId: inputRequestId, status: "done" }),
    );
    expect(
      checkpoint.entries.filter(
        (entry) => entry.conversationId === ROOT_CONVERSATION_ID,
      ),
    ).toEqual(normalContext.value.runtime.entries);
    expect(JSON.stringify(checkpoint)).not.toContain("UZINA_MODEL_API_KEY");
    expect(JSON.stringify(checkpoint)).not.toContain(
      "model:uzina-capture-test/capture-test-model",
    );
    const sourceAfterExportResult =
      await managedWorkCall<PublicStorageObservation>(
        baseUrl,
        thread.value.threadId,
        { kind: "public-storage-observation" },
      );
    expect(sourceAfterExportResult.response.status).toBe(200);
    expect(sourceAfterExportResult.value).toEqual(sourceObservation);
    const coldObservationsResult = await managedWorkCall<{
      modelCalls: number;
      alarmCalls: number;
    }>(baseUrl, thread.value.threadId, { kind: "observe" });
    const coldObservations = coldObservationsResult.value;
    expect(coldObservations.modelCalls).toBe(0);

    // A legacy object without the adapter profile still supports read-only Pi export.
    const removedSourceProfile = await managedWorkCall<boolean>(
      baseUrl,
      thread.value.threadId,
      { kind: "clear-source-runtime-profile" },
    );
    expect(removedSourceProfile.response.status).toBe(200);
    expect(removedSourceProfile.value).toBe(true);
    const legacyRawExport = await managedWorkCall<{
      sourceRuntimeProfile: unknown;
      bytes: number[];
    }>(baseUrl, thread.value.threadId, {
      kind: "export",
      request: exportRequest,
    });
    expect(legacyRawExport.response.status).toBe(200);
    expect(legacyRawExport.value.sourceRuntimeProfile).toBeNull();
    const legacyRawCheckpoint = await validateManagedWorkCheckpoint(
      JSON.parse(
        new TextDecoder().decode(Uint8Array.from(legacyRawExport.value.bytes)),
      ),
    );
    expect(legacyRawCheckpoint.conversations).toEqual(checkpoint.conversations);
    expect(legacyRawCheckpoint.entries).toEqual(checkpoint.entries);
    expect(legacyRawCheckpoint.tasks).toEqual(checkpoint.tasks);
    expect(legacyRawCheckpoint.submissions).toEqual(checkpoint.submissions);
    expect(legacyRawCheckpoint.documents).toEqual(checkpoint.documents);

    const captureReceiptAfterExport = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/capture-controls/${sourceAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(captureReceiptAfterExport.value).toEqual(fencedCaptureReceipt.value);
    const completedInputAfterExport = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/commands/${inputRequestId}`,
      { credential: owner },
    );
    expect(completedInputAfterExport.value).toEqual(
      completedInputReceipt.value,
    );

    const inactiveStorage = await openBunSqliteStorage(
      join(directory, "inactive-managed-work.sqlite"),
    );
    try {
      await importManagedWorkCheckpoint(inactiveStorage, checkpoint);
      await verifyManagedWorkCheckpointStorage(inactiveStorage, checkpoint);
      expect(
        await inactiveStorage.conversation(
          ROOT_CONVERSATION_ID,
          BACKGROUND_CONTEXT,
        ),
      ).toEqual(checkpoint.conversations[0]);
    } finally {
      await inactiveStorage.close(BACKGROUND_CONTEXT);
    }

    const wrongCaptureId = await managedWorkCall<string>(
      baseUrl,
      thread.value.threadId,
      {
        kind: "export-refusal",
        request: { ...exportRequest, captureId: "capture:wrong-binding" },
      },
    );
    expect(wrongCaptureId.value).toContain("persisted capture binding");
    const wrongCaptureRequestId = await managedWorkCall<string>(
      baseUrl,
      thread.value.threadId,
      {
        kind: "export-refusal",
        request: {
          ...exportRequest,
          captureRequestId: "request:wrong-binding",
        },
      },
    );
    expect(wrongCaptureRequestId.value).toContain("persisted capture binding");
    const invalidExportRequest = await managedWorkCall<string>(
      baseUrl,
      thread.value.threadId,
      {
        kind: "export-refusal",
        request: { ...exportRequest, captureId: "" },
      },
    );
    expect(invalidExportRequest.value).toContain(
      "Invalid managed-work capture export request",
    );

    const heldHttpContext = await fetchAndConsume(
      new URL(`/v1/threads/${thread.value.threadId}/context`, baseUrl),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    const heldHttpStatus = await fetchAndConsume(
      new URL(`/v1/threads/${thread.value.threadId}/status`, baseUrl),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(heldHttpContext).toBeGreaterThanOrEqual(400);
    expect(heldHttpStatus).toBeGreaterThanOrEqual(400);
    const refusedInput = await call(
      baseUrl,
      `/v1/threads/${thread.value.threadId}/inputs`,
      {
        credential: owner,
        body: {
          requestId: "request:blocked-by-source-capture",
          text: "must remain blocked",
        },
      },
    );
    expect(refusedInput.response.status).toBe(409);

    const beforeAlarmResult = await managedWorkCall<{
      modelCalls: number;
      alarmCalls: number;
    }>(baseUrl, thread.value.threadId, { kind: "observe" });
    const beforeAlarm = beforeAlarmResult.value;
    const scheduleAlarm = await managedWorkCall<null>(
      baseUrl,
      thread.value.threadId,
      { kind: "schedule-alarm", at: Date.now() + 20 },
    );
    expect(scheduleAlarm.response.status).toBe(200);
    await until(async () => {
      const observations = await managedWorkCall<{
        modelCalls: number;
        alarmCalls: number;
      }>(baseUrl, thread.value.threadId, { kind: "observe" });
      const pendingAlarm = await managedWorkCall<number | null>(
        baseUrl,
        thread.value.threadId,
        { kind: "pending-alarm" },
      );
      return (
        observations.value.alarmCalls > beforeAlarm.alarmCalls &&
        pendingAlarm.value === null
      );
    });
    const afterHeldAlarmResult = await managedWorkCall<{
      modelCalls: number;
      alarmCalls: number;
    }>(baseUrl, thread.value.threadId, { kind: "observe" });
    const afterHeldAlarm = afterHeldAlarmResult.value;
    expect(afterHeldAlarm.modelCalls).toBe(0);
    const sourceAfterAlarm = await managedWorkCall<PublicStorageObservation>(
      baseUrl,
      thread.value.threadId,
      { kind: "public-storage-observation" },
    );
    expect(sourceAfterAlarm.value).toEqual(sourceObservation);
    expect(await workspaceEffectState(workspace)).toEqual(
      workspaceBeforeCapture,
    );
    const captureReceiptAfterAlarm = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/capture-controls/${sourceAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(captureReceiptAfterAlarm.value).toEqual(fencedCaptureReceipt.value);
    const completedInputAfterAlarm = await call<Record<string, unknown>>(
      baseUrl,
      `/v1/commands/${inputRequestId}`,
      { credential: owner },
    );
    expect(completedInputAfterAlarm.value).toEqual(completedInputReceipt.value);

    const foreignRefusal = await managedWorkCall<string>(
      baseUrl,
      "thread:unselected-no-capture",
      { kind: "export-refusal", request: exportRequest },
    );
    expect(foreignRefusal.value).toContain(
      "confirmed source-capture-fenced lock",
    );

    const queuedNode = await call<{
      node: { nodeId: string };
    }>(baseUrl, "/v1/nodes", {
      credential: owner,
      body: {
        nodeId: "node:queued-capture-test",
        name: "Offline capture node",
      },
    });
    const queuedWorkspace = await call<{ workspaceId: string }>(
      baseUrl,
      "/v1/workspaces",
      {
        credential: owner,
        body: {
          workspaceId: "workspace:queued-capture-test",
          nodeId: queuedNode.value.node.nodeId,
          name: "Offline capture workspace",
        },
      },
    );
    const queuedThread = await call<{ threadId: string }>(
      baseUrl,
      "/v1/threads",
      {
        credential: owner,
        body: {
          threadId: "thread:queued-capture-test",
          projectId: project.value.projectId,
          title: "Queued capture control",
          target: {
            nodeId: queuedNode.value.node.nodeId,
            workspaceId: queuedWorkspace.value.workspaceId,
          },
        },
      },
    );
    const queuedControl = await call<{
      requestId: string;
      captureId: string;
      status: string;
    }>(baseUrl, `/v1/threads/${queuedThread.value.threadId}/capture-controls`, {
      credential: owner,
      body: {
        contractVersion: 1,
        requestId: "request:queued-capture-test",
      },
    });
    expect(queuedControl.value.status).toBe("queued");
    const queuedRefusal = await managedWorkCall<string>(
      baseUrl,
      queuedThread.value.threadId,
      {
        kind: "export-refusal",
        request: {
          captureId: queuedControl.value.captureId,
          captureRequestId: queuedControl.value.requestId,
        },
      },
    );
    expect(queuedRefusal.value).toContain(
      "confirmed source-capture-fenced lock",
    );
    const queuedCheckpoint = await call<{ error: string }>(
      baseUrl,
      `/v1/threads/${queuedThread.value.threadId}/managed-work-checkpoints`,
      {
        credential: owner,
        body: {
          contractVersion: 1,
          requestId: "checkpoint:queued-capture-refusal",
          captureRequestId: queuedControl.value.requestId,
          workspaceSnapshotRequestId: "snapshot:not-yet-available",
        },
      },
    );
    expect(queuedCheckpoint.response.status).toBe(409);
    const queuedCheckpointStatus = await call<{ error: string }>(
      baseUrl,
      "/v1/managed-work-checkpoints/checkpoint:queued-capture-refusal",
      { credential: owner },
    );
    expect(queuedCheckpointStatus.response.status).toBe(404);

    const generationMutation = await call(
      baseUrl,
      "/__test/change-generation",
      {
        body: {
          threadId: thread.value.threadId,
          generation: thread.value.ownershipGeneration + 1,
        },
      },
    );
    expect(generationMutation.response.status).toBe(200);
    const staleCheckpointStatus = await call<{ error: string }>(
      baseUrl,
      checkpointStatusPath,
      { credential: owner },
    );
    expect(staleCheckpointStatus.response.status).toBe(409);
    const staleRelocationStatus = await call<{ error: string }>(
      baseUrl,
      relocationStatusPath,
      { credential: owner },
    );
    expect(staleRelocationStatus.response.status).toBe(409);
    const staleGenerationRefusal = await managedWorkCall<string>(
      baseUrl,
      thread.value.threadId,
      { kind: "export-refusal", request: exportRequest },
    );
    expect(staleGenerationRefusal.value).toContain(
      "confirmed source-capture-fenced lock",
    );

    const getBlob = async (reference: string): Promise<Uint8Array> => {
      const response = await fetch(
        new URL(
          `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${reference}`,
          baseUrl,
        ),
        { headers: { authorization: `Bearer ${owner}` } },
      );
      if (!response.ok)
        throw new Error(`owner blob retrieval refused: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const manifestBytes = await getBlob(status.value.manifestReference);
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as WorkspaceCheckpointManifest;
    expect(manifest.runtimeArtifact).toBeNull();
    expect(manifest.attachments).toEqual([]);
    const prepared = join(directory, "prepared-inactive");
    await mkdir(prepared);
    const transport: BlobTransport = {
      async putBlob() {
        throw new Error("owner restore transport is read-only");
      },
      getBlob: getBlob,
    };
    await restoreWorkspaceCheckpoint({
      manifest,
      transport,
      destinationPath: prepared,
    });
    expect(git(prepared, "show", ":tracked.txt")).toBe("staged content\n");
    expect(await readFile(join(prepared, "tracked.txt"), "utf8")).toBe(
      "unstaged content\n",
    );
    expect(await readFile(join(prepared, "binary"))).toEqual(
      Buffer.from([0, 255, 17, 128]),
    );
    expect(git(prepared, "status", "--porcelain").trim()).toBe(
      "MM tracked.txt\n?? binary",
    );
    expect(
      await stat(join(prepared, "binary")).then((file) => file.mode & 0o111),
    ).toBe(0o111);

    const wrongCredential = await fetchAndConsume(
      new URL(
        `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${status.value.manifestReference}`,
        baseUrl,
      ),
    );
    expect(wrongCredential).toBe(401);
    const guessedForeignObject = await fetchAndConsume(
      new URL(
        `/v1/workspace-snapshots/snapshot:foreign/blobs/${status.value.manifestReference}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(guessedForeignObject).toBe(404);
    const wrongNodeUpload = await fetchAndConsume(
      new URL(
        `/v1/nodes/node:other/captures/${sourceAdmission.value.captureId}/blobs/${"f".repeat(64)}`,
        baseUrl,
      ),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${node.value.credential}`,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array([1]),
      },
    );
    expect(wrongNodeUpload).toBe(403);
    const corruptHashUpload = await fetchAndConsume(
      new URL(
        `/v1/nodes/${node.value.node.nodeId}/captures/${sourceAdmission.value.captureId}/blobs/${"f".repeat(64)}`,
        baseUrl,
      ),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${node.value.credential}`,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(corruptHashUpload).not.toBe(204);
    const corruptBlobDownload = await fetchAndConsume(
      new URL(
        `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${"f".repeat(64)}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(corruptBlobDownload).toBe(404);
  }, 30_000);
});
