import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";
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
import { HttpExecutionControllerConnector } from "../../daemon/src/execution/connector";
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
    const fixture: Fixture = {
      directory,
      miniflare,
      async close() {
        abort?.abort();
        await loop?.catch(() => {});
        daemon?.close();
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
    const reopenedCheckpointStatus = await call<Record<string, unknown>>(
      baseUrl,
      checkpointStatusPath,
      { credential: owner },
    );
    expect(reopenedCheckpointStatus.value).toEqual(checkpointStatus.value);
    const reopenedCheckpointRetry = await call<Record<string, unknown>>(
      baseUrl,
      checkpointPath,
      { credential: owner, body: coherentRequest },
    );
    expect(reopenedCheckpointRetry.value).toEqual(checkpointStatus.value);

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
