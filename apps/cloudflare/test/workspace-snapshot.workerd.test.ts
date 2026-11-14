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
  restoreWorkspaceCheckpoint,
  type BlobTransport,
  type WorkspaceCheckpointManifest,
} from "@uzina/checkpoints";
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
  mode: "deterministic" | "unusable",
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
    const directory = await mkdtemp(join(tmpdir(), "uzina-workerd-snapshot-"));
    const workspace = join(directory, "workspace");
    await makeDirtyGitWorkspace(workspace);
    const workerArtifact = await buildCloudflareWorkerArtifact(
      join(import.meta.dir, "capture-aware-workerd-entry.ts"),
    );
    const miniflare = new Miniflare({
      name: "uzina-workspace-snapshot",
      script: workerArtifact.script,
      modules: true,
      compatibilityDate: "2026-05-01",
      host: "127.0.0.1",
      port: 0,
      bindings: { UZINA_BOOTSTRAP_SECRET: "snapshot-workerd-bootstrap" },
      durableObjects: {
        FACTORY: { className: "CaptureTestFactory", useSQLite: true },
        MANAGED_WORK: {
          className: "CaptureTestManagedWork",
          useSQLite: true,
        },
      },
      r2Buckets: ["CHECKPOINTS"],
    });
    let daemon: ExecutionDaemon | undefined;
    let abort: AbortController | undefined;
    let loop: Promise<void> | undefined;
    fixtures.push({
      directory,
      miniflare,
      async close() {
        abort?.abort();
        await loop?.catch(() => {});
        daemon?.close();
        await miniflare.dispose();
      },
    });
    const baseUrl = (await miniflare.ready).toString();
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
    daemon = new ExecutionDaemon({
      databasePath: join(directory, "node.sqlite"),
      nodeId: node.value.node.nodeId,
      nodeCredential: node.value.credential,
      workspaces: [
        {
          workspaceId: workspaceRecord.value.workspaceId,
          directory: workspace,
        },
      ],
    });
    abort = new AbortController();
    loop = new ExecutionLoop({
      daemon,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: node.value.node.nodeId,
        credential: node.value.credential,
      }),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 500,
    }).run(abort.signal);
    await until(async () => {
      const nodes = await call<{ nodes: Array<{ availability: string }> }>(
        baseUrl,
        "/v1/nodes",
        { credential: owner },
      );
      return nodes.value.nodes[0]?.availability === "online";
    });
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
    const inputRequestId = "request:workerd-capture-seed";
    await call(baseUrl, "/__test/model-response", {
      body: { action: "hold", threadId: thread.value.threadId },
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
    const observationsBeforeCapture = await managedWorkCall<{
      modelCalls: number;
      alarmCalls: number;
    }>(baseUrl, thread.value.threadId, { kind: "observe" });
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
    abort.abort();
    await loop.catch(() => {});
    loop = Promise.resolve();
    daemon.close();
    daemon = undefined;

    const exportRequest = {
      captureId: sourceAdmission.value.captureId,
      captureRequestId: sourceAdmission.value.requestId,
    };
    expect(
      (await providerConfiguration(baseUrl, "unusable")).response.status,
    ).toBe(200);
    await miniflare.unsafeEvictDurableObject(
      "uzina-workspace-snapshot",
      "CaptureTestManagedWork",
      { id: managedId.toString() },
    );
    // Construction is cold and captured; unusable production credentials make any accidental runtime open fail.
    const coldConstructionResult = await managedWorkCall<{
      modelCalls: number;
      alarmCalls: number;
    }>(baseUrl, thread.value.threadId, { kind: "observe" });
    expect(coldConstructionResult.response.status).toBe(200);
    const coldConstruction = coldConstructionResult.value;
    expect(coldConstruction.modelCalls).toBe(
      observationsBeforeCapture.value.modelCalls,
    );
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
      sizeBytes: coldExport.bytes.byteLength,
    });
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
    expect(coldObservations.modelCalls).toBe(
      observationsBeforeCapture.value.modelCalls,
    );
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

    const heldHttpContext = await fetch(
      new URL(`/v1/threads/${thread.value.threadId}/context`, baseUrl),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    const heldHttpStatus = await fetch(
      new URL(`/v1/threads/${thread.value.threadId}/status`, baseUrl),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(heldHttpContext.status).toBeGreaterThanOrEqual(400);
    expect(heldHttpStatus.status).toBeGreaterThanOrEqual(400);
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
    expect(afterHeldAlarm.modelCalls).toBe(
      observationsBeforeCapture.value.modelCalls,
    );
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

    const wrongCredential = await fetch(
      new URL(
        `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${status.value.manifestReference}`,
        baseUrl,
      ),
    );
    expect(wrongCredential.status).toBe(401);
    const guessedForeignObject = await fetch(
      new URL(
        `/v1/workspace-snapshots/snapshot:foreign/blobs/${status.value.manifestReference}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(guessedForeignObject.status).toBe(404);
    const wrongNodeUpload = await fetch(
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
    expect(wrongNodeUpload.status).toBe(403);
    const corruptHashUpload = await fetch(
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
    expect(corruptHashUpload.status).not.toBe(204);
    const corruptBlobDownload = await fetch(
      new URL(
        `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${"f".repeat(64)}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(corruptBlobDownload.status).toBe(404);
  }, 30_000);
});
