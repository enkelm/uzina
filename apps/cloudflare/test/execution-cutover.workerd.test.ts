import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { buildCloudflareWorkerArtifact } from "../scripts/build-worker";
import { CaptureStateBarrier } from "./capture-state-barrier";
import { ExecutionDaemon } from "../../daemon/src/execution/daemon";
import {
  ControllerTransportError,
  HttpExecutionControllerConnector,
  type ExecutionControllerConnector,
} from "../../daemon/src/execution/connector";
import { ExecutionLoop } from "../../daemon/src/execution/loop";
import { factoryProvenanceEvidenceSchema } from "@uzina/contracts/factory";
import type {
  WorkspaceRelocationActivationCommand,
  WorkspaceRelocationActivationReport,
} from "@uzina/contracts/factory";

type Fixture = {
  directory: string;
  miniflare: Miniflare;
  close(): Promise<void>;
};
const fixtures: Fixture[] = [];

type WorkspaceConfiguration = {
  workspaceId: string;
  directory: string;
  ownershipGeneration?: number;
};

type RunningNode = {
  daemon: ExecutionDaemon;
  abort: AbortController;
  loop: Promise<void>;
  stopped: boolean;
};

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
  const text = await response.text();
  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${path} (${response.status}), received ${text.slice(0, 240)}`,
    );
  }
  return { response, value };
}

async function forwardAndDiscardPost(
  baseUrl: string,
  path: string,
  credential: string,
  body: unknown,
): Promise<number> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const status = response.status;
  await response.body?.cancel();
  return status;
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the execution cutover owner");
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

async function makeDirtyGitWorkspace(directory: string): Promise<void> {
  await mkdir(directory);
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.name", "Execution cutover fixture");
  git(directory, "config", "user.email", "cutover@example.invalid");
  await writeFile(join(directory, "tracked.txt"), "base\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-m", "base");
  await writeFile(join(directory, "tracked.txt"), "staged source\n");
  git(directory, "add", "tracked.txt");
  await writeFile(join(directory, "tracked.txt"), "working source\n");
  await writeFile(join(directory, "binary"), new Uint8Array([0, 255, 17, 128]));
  await chmod(join(directory, "binary"), 0o755);
}

async function gitWorkspaceEvidence(directory: string) {
  const binary = await readFile(join(directory, "binary"));
  const binaryMode = (await stat(join(directory, "binary"))).mode & 0o777;
  return {
    head: git(directory, "rev-parse", "HEAD"),
    status: git(directory, "status", "--porcelain", "--untracked-files=all"),
    stagedDiff: git(
      directory,
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-color",
    ),
    unstagedDiff: git(
      directory,
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-color",
    ),
    stagedTrackedContent: git(directory, "show", ":tracked.txt"),
    workingTrackedContent: await readFile(
      join(directory, "tracked.txt"),
      "utf8",
    ),
    untrackedFiles: git(
      directory,
      "ls-files",
      "--others",
      "--exclude-standard",
    ),
    binaryBase64: binary.toString("base64"),
    binaryMode,
    sourceEffect: await readFile(join(directory, "source-effect.txt"), "utf8"),
  };
}

function startNode(
  directory: string,
  nodeId: string,
  credential: string,
  workspaces: WorkspaceConfiguration[],
  controllerUrl: string,
  controller?: ExecutionControllerConnector,
  heartbeatIntervalMs = 100,
): RunningNode {
  const daemon = new ExecutionDaemon({
    databasePath: join(
      directory,
      `${nodeId.slice(nodeId.indexOf(":") + 1)}.sqlite`,
    ),
    nodeId,
    nodeCredential: credential,
    workspaces,
  });
  const abort = new AbortController();
  const loop = new ExecutionLoop({
    daemon,
    controller:
      controller ??
      new HttpExecutionControllerConnector({
        controllerUrl,
        nodeId,
        credential,
      }),
    pollIntervalMs: 20,
    heartbeatIntervalMs,
  }).run(abort.signal);
  return { daemon, abort, loop, stopped: false };
}

async function stopNode(node: RunningNode): Promise<void> {
  if (node.stopped) return;
  node.stopped = true;
  node.abort.abort();
  let failure: unknown;
  try {
    await node.loop;
  } catch (error) {
    failure = error;
  }
  try {
    node.daemon.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function hasWorkspaceReport(
  daemon: ExecutionDaemon,
  workspaceId: string,
  ownershipGeneration: number,
  state: "active" | "fenced",
): boolean {
  return daemon
    .heartbeatRequest()
    .workspaces.some(
      (report) =>
        report.workspaceId === workspaceId &&
        report.ownershipGeneration === ownershipGeneration &&
        report.state === state,
    );
}

async function writeThroughManagedPi(
  baseUrl: string,
  owner: string,
  threadId: string,
  requestId: string,
  callId: string,
  path: string,
  content: string,
) {
  const queued = await call(baseUrl, "/__test/model-tool-call", {
    body: { id: callId, path, content },
  });
  expect(queued.response.status).toBe(200);
  const accepted = await call(baseUrl, `/v1/threads/${threadId}/inputs`, {
    credential: owner,
    body: { requestId, text: `Write ${path} for ${requestId}` },
  });
  expect(accepted.response.status).toBe(202);
  await until(async () => {
    const receipt = await call<{
      dispatchStatus: string;
      executionEffects?: Array<{ status: string }>;
    }>(baseUrl, `/v1/commands/${requestId}`, { credential: owner });
    return (
      receipt.value.dispatchStatus === "completed" &&
      receipt.value.executionEffects?.some(
        (effect) => effect.status === "completed",
      ) === true
    );
  });
  return call<Record<string, unknown>>(baseUrl, `/v1/commands/${requestId}`, {
    credential: owner,
  });
}

async function readOwnerBlob(
  baseUrl: string,
  owner: string,
  path: string,
  reference: string,
): Promise<Uint8Array> {
  const response = await fetch(new URL(path, baseUrl), {
    headers: { authorization: `Bearer ${owner}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-content-sha256")).toBe(reference);
  expect(response.headers.get("x-uzina-evidence-authority")).toBe(
    "historical-inactive",
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(reference);
  return bytes;
}

async function captureCurrentWorkspaceCheckpoint(
  baseUrl: string,
  owner: string,
  threadId: string,
  prefix: string,
) {
  const captureRequestId = `request:${prefix}-control`;
  const capture = await call<{ requestId: string; captureId: string }>(
    baseUrl,
    `/v1/threads/${threadId}/capture-controls`,
    {
      credential: owner,
      body: { contractVersion: 1, requestId: captureRequestId },
    },
  );
  expect(capture.response.status).toBe(202);
  await until(async () => {
    const status = await call<{ status: string }>(
      baseUrl,
      `/v1/capture-controls/${captureRequestId}`,
      { credential: owner },
    );
    return status.value.status === "source-capture-fenced";
  });

  const snapshotRequestId = `snapshot:${prefix}`;
  const snapshot = await call<{
    requestId: string;
    snapshotId: string;
    captureId: string;
  }>(baseUrl, "/v1/workspace-snapshots", {
    credential: owner,
    body: {
      contractVersion: 1,
      requestId: snapshotRequestId,
      captureRequestId,
    },
  });
  expect(snapshot.response.status).toBe(202);
  await until(async () => {
    const status = await call<{ status: string }>(
      baseUrl,
      `/v1/workspace-snapshots/${snapshotRequestId}`,
      { credential: owner },
    );
    return status.value.status === "workspace-checkpoint-available";
  });
  const snapshotStatus = await call<{
    status: string;
    manifestReference: string;
    target: { nodeId: string; workspaceId: string };
    ownershipGeneration: number;
  }>(baseUrl, `/v1/workspace-snapshots/${snapshotRequestId}`, {
    credential: owner,
  });

  const checkpointRequestId = `checkpoint:${prefix}`;
  const checkpoint = await call<{ requestId: string }>(
    baseUrl,
    `/v1/threads/${threadId}/managed-work-checkpoints`,
    {
      credential: owner,
      body: {
        contractVersion: 1,
        requestId: checkpointRequestId,
        captureRequestId,
        workspaceSnapshotRequestId: snapshotRequestId,
      },
    },
  );
  expect(checkpoint.response.status).toBe(202);
  await until(async () => {
    const status = await call<{ status: string; stage: string }>(
      baseUrl,
      `/v1/managed-work-checkpoints/${checkpointRequestId}`,
      { credential: owner },
    );
    if (["blocked", "uncertain"].includes(status.value.status)) {
      throw new Error(JSON.stringify(status.value));
    }
    return (
      status.value.status === "available" && status.value.stage === "available"
    );
  });
  const checkpointStatus = await call<{
    status: string;
    manifestReference: string;
    target: { nodeId: string; workspaceId: string };
    ownershipGeneration: number;
  }>(baseUrl, `/v1/managed-work-checkpoints/${checkpointRequestId}`, {
    credential: owner,
  });
  return {
    captureRequestId,
    capture: capture.value,
    snapshotRequestId,
    snapshot: snapshot.value,
    snapshotStatus: snapshotStatus.value,
    checkpointRequestId,
    checkpointStatus: checkpointStatus.value,
  };
}

function interceptActivationReadiness(
  controller: ExecutionControllerConnector,
  intercept: (
    readiness: unknown,
  ) => Promise<WorkspaceRelocationActivationCommand>,
): ExecutionControllerConnector {
  return new Proxy(controller, {
    get(target, property) {
      if (property === "reportWorkspaceRelocationActivationReadiness") {
        return intercept;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function readPersistedRelocationEvidence(
  databasePath: string,
  relocationId: string,
) {
  const database = new Database(databasePath, { readonly: true });
  try {
    const relocation = database
      .query<
        {
          relocation_id: string;
          request_id: string;
          capture_id: string;
          status: string;
          receipt_json: string;
          receipt_sha256: string;
          previous_receipt_json: string | null;
          previous_receipt_sha256: string | null;
        },
        [string]
      >(
        `SELECT relocation_id, request_id, capture_id, status, receipt_json,
          receipt_sha256, previous_receipt_json, previous_receipt_sha256
         FROM execution_workspace_relocations WHERE relocation_id = ?`,
      )
      .get(relocationId);
    const activation = database
      .query<
        {
          status: string;
          preflight_json: string;
          readiness_json: string | null;
          readiness_sha256: string | null;
          readiness_receipt_sha256: string | null;
          accepted_at: string;
        },
        [string]
      >(
        `SELECT status, preflight_json, readiness_json, readiness_sha256,
          readiness_receipt_sha256, accepted_at
         FROM execution_workspace_activation_receipts WHERE relocation_id = ?`,
      )
      .get(relocationId);
    if (!relocation || !activation) {
      throw new Error("Persisted relocation readiness evidence is missing");
    }
    return { relocation, activation };
  } finally {
    database.close();
  }
}

async function runSavedReadinessReopenScenario(
  label: string,
  mutatePreparedTree: boolean,
): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), `uzina-readiness-reopen-${label}-`),
  );
  const sourceWorkspace = join(directory, "source");
  const destinationWorkspace = join(directory, "destination");
  await makeDirtyGitWorkspace(sourceWorkspace);
  await mkdir(destinationWorkspace);

  const workerArtifact = await buildCloudflareWorkerArtifact(
    join(import.meta.dir, "capture-aware-workerd-entry.ts"),
  );
  const durableObjectsPath = join(directory, "durable-objects");
  const r2Path = join(directory, "r2");
  const createMiniflare = () =>
    new Miniflare({
      name: `uzina-readiness-reopen-${label}`,
      script: workerArtifact.script,
      modules: true,
      compatibilityDate: "2026-05-01",
      host: "127.0.0.1",
      port: 0,
      bindings: { UZINA_BOOTSTRAP_SECRET: "cutover-workerd-bootstrap" },
      durableObjects: {
        FACTORY: { className: "CaptureTestFactory", useSQLite: true },
        MANAGED_WORK: { className: "CaptureTestManagedWork", useSQLite: true },
      },
      durableObjectsPersist: durableObjectsPath,
      r2Buckets: ["CHECKPOINTS"],
      r2Persist: r2Path,
    });
  const miniflare = createMiniflare();
  let baseUrl = (await miniflare.ready).toString();
  let releaseReadiness: ((forward: boolean) => void) | undefined;
  const runners: RunningNode[] = [];
  const fixture: Fixture = {
    directory,
    miniflare,
    async close() {
      releaseReadiness?.(false);
      const failures: unknown[] = [];
      for (const runner of runners) {
        try {
          await stopNode(runner);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await miniflare.dispose();
      } finally {
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "Saved-readiness fixture failed to stop owned node loops cleanly",
          );
        }
      }
    },
  };
  fixtures.push(fixture);

  const bootstrap = await call<{ credential: string }>(
    baseUrl,
    "/v1/bootstrap",
    {
      bootstrap: true,
      credential: "cutover-workerd-bootstrap",
      body: { name: `Readiness ${label}` },
    },
  );
  expect(bootstrap.response.status).toBe(201);
  const owner = bootstrap.value.credential;
  const project = await call<{ projectId: string }>(baseUrl, "/v1/projects", {
    credential: owner,
    body: { projectId: `project:${label}`, name: `Readiness ${label}` },
  });
  expect(project.response.status).toBe(201);
  const sourceNode = await call<{
    node: { nodeId: string };
    credential: string;
  }>(baseUrl, "/v1/nodes", {
    credential: owner,
    body: { nodeId: `node:${label}-source`, name: "Readiness source" },
  });
  const destinationNodeIdentity = await call<{
    node: { nodeId: string };
    credential: string;
  }>(baseUrl, "/v1/nodes", {
    credential: owner,
    body: {
      nodeId: `node:${label}-destination`,
      name: "Readiness destination",
    },
  });
  expect(sourceNode.response.status).toBe(201);
  expect(destinationNodeIdentity.response.status).toBe(201);
  const sourceWorkspaceId = `workspace:${label}-source`;
  const destinationWorkspaceId = `workspace:${label}-destination`;
  const sourceWorkspaceRecord = await call<{ workspaceId: string }>(
    baseUrl,
    "/v1/workspaces",
    {
      credential: owner,
      body: {
        workspaceId: sourceWorkspaceId,
        nodeId: sourceNode.value.node.nodeId,
        name: sourceWorkspaceId,
      },
    },
  );
  const destinationWorkspaceRecord = await call<{ workspaceId: string }>(
    baseUrl,
    "/v1/workspaces",
    {
      credential: owner,
      body: {
        workspaceId: destinationWorkspaceId,
        nodeId: destinationNodeIdentity.value.node.nodeId,
        name: destinationWorkspaceId,
      },
    },
  );
  expect(sourceWorkspaceRecord.response.status).toBe(201);
  expect(destinationWorkspaceRecord.response.status).toBe(201);
  const sourceRunner = startNode(
    directory,
    sourceNode.value.node.nodeId,
    sourceNode.value.credential,
    [{ workspaceId: sourceWorkspaceId, directory: sourceWorkspace }],
    baseUrl,
  );
  runners.push(sourceRunner);
  await until(async () => {
    const nodes = await call<{
      nodes: Array<{ nodeId: string; availability: string }>;
    }>(baseUrl, "/v1/nodes", { credential: owner });
    return nodes.value.nodes.some(
      (node) =>
        node.nodeId === sourceNode.value.node.nodeId &&
        node.availability === "online",
    );
  });
  const threadId = `thread:${label}`;
  const thread = await call<{ threadId: string }>(baseUrl, "/v1/threads", {
    credential: owner,
    body: {
      threadId,
      projectId: project.value.projectId,
      title: `Saved readiness ${label}`,
      target: {
        nodeId: sourceNode.value.node.nodeId,
        workspaceId: sourceWorkspaceId,
      },
    },
  });
  expect(thread.response.status).toBe(201);
  const sourceEffect = await writeThroughManagedPi(
    baseUrl,
    owner,
    threadId,
    `request:${label}-source-effect`,
    `call:${label}-source-effect`,
    "source-effect.txt",
    `source effect ${label}\n`,
  );
  expect(sourceEffect.value).toMatchObject({
    target: {
      nodeId: sourceNode.value.node.nodeId,
      workspaceId: sourceWorkspaceId,
    },
    ownershipGeneration: 0,
  });
  const coherent = await captureCurrentWorkspaceCheckpoint(
    baseUrl,
    owner,
    threadId,
    `readiness-${label}`,
  );
  const relocationRequestId = `relocation:${label}`;
  const relocation = await call<{ relocationId: string }>(
    baseUrl,
    `/v1/threads/${threadId}/workspace-relocations`,
    {
      credential: owner,
      body: {
        contractVersion: 1,
        requestId: relocationRequestId,
        checkpointRequestId: coherent.checkpointRequestId,
        destination: {
          nodeId: destinationNodeIdentity.value.node.nodeId,
          workspaceId: destinationWorkspaceId,
        },
      },
    },
  );
  expect(relocation.response.status).toBe(202);
  const controller = new HttpExecutionControllerConnector({
    controllerUrl: baseUrl,
    nodeId: destinationNodeIdentity.value.node.nodeId,
    credential: destinationNodeIdentity.value.credential,
  });
  let resolveReadiness!: (readiness: unknown) => void;
  const readinessObserved = new Promise<unknown>((resolve) => {
    resolveReadiness = resolve;
  });
  let resolveReadinessDecision!: (forward: boolean) => void;
  const readinessDecision = new Promise<boolean>((resolve) => {
    resolveReadinessDecision = resolve;
  });
  let readinessReleased = false;
  releaseReadiness = (forward) => {
    if (readinessReleased) return;
    readinessReleased = true;
    resolveReadinessDecision(forward);
  };
  const heldController = interceptActivationReadiness(
    controller,
    async (readiness) => {
      resolveReadiness(readiness);
      if (await readinessDecision) {
        return controller.reportWorkspaceRelocationActivationReadiness(
          readiness,
        );
      }
      throw new ControllerTransportError();
    },
  );
  let destinationRunner = startNode(
    directory,
    destinationNodeIdentity.value.node.nodeId,
    destinationNodeIdentity.value.credential,
    [{ workspaceId: destinationWorkspaceId, directory: destinationWorkspace }],
    baseUrl,
    heldController,
  );
  runners.push(destinationRunner);
  await until(async () => {
    const status = await call<{ status: string }>(
      baseUrl,
      `/v1/workspace-relocations/${relocationRequestId}`,
      { credential: owner },
    );
    return status.value.status === "prepared-inactive";
  });
  const prepared = await call<{
    status: string;
    receiptSha256: string;
    captureId: string;
    requestId: string;
    relocationId: string;
  }>(baseUrl, `/v1/workspace-relocations/${relocationRequestId}`, {
    credential: owner,
  });
  expect(prepared.value.status).toBe("prepared-inactive");
  const intent = await call(
    baseUrl,
    `/v1/workspace-relocations/${relocationRequestId}/activation-intent`,
    { credential: owner, body: { contractVersion: 1 } },
  );
  expect(intent.response.status).toBe(202);
  const firstReadiness = await readinessObserved;
  expect(firstReadiness).toMatchObject({
    relocationId: relocation.value.relocationId,
    preparedReceiptSha256: prepared.value.receiptSha256,
  });
  destinationRunner.abort.abort();
  releaseReadiness(false);
  await stopNode(destinationRunner);
  const databasePath = join(
    directory,
    `${destinationNodeIdentity.value.node.nodeId.slice(
      destinationNodeIdentity.value.node.nodeId.indexOf(":") + 1,
    )}.sqlite`,
  );
  const saved = readPersistedRelocationEvidence(
    databasePath,
    relocation.value.relocationId,
  );
  expect(saved.relocation.relocation_id).toBe(relocation.value.relocationId);
  expect(saved.relocation.request_id).toBe(relocationRequestId);
  expect(saved.relocation.capture_id).toBe(coherent.capture.captureId);
  expect(saved.relocation.receipt_sha256).toBe(prepared.value.receiptSha256);
  expect(saved.activation.readiness_json).not.toBeNull();
  expect(JSON.stringify(firstReadiness)).toBe(saved.activation.readiness_json!);
  expect(saved.activation.readiness_sha256).toBeTruthy();
  expect(saved.activation.readiness_receipt_sha256).toBe(
    (firstReadiness as { readinessReceiptSha256: string })
      .readinessReceiptSha256,
  );
  if (!mutatePreparedTree) {
    let resolveReplay!: (readiness: unknown) => void;
    const replayObserved = new Promise<unknown>((resolve) => {
      resolveReplay = resolve;
    });
    const replayController = interceptActivationReadiness(
      controller,
      async (readiness) => {
        resolveReplay(readiness);
        return controller.reportWorkspaceRelocationActivationReadiness(
          readiness,
        );
      },
    );
    destinationRunner = startNode(
      directory,
      destinationNodeIdentity.value.node.nodeId,
      destinationNodeIdentity.value.credential,
      [
        {
          workspaceId: destinationWorkspaceId,
          directory: destinationWorkspace,
        },
      ],
      baseUrl,
      replayController,
    );
    runners.push(destinationRunner);
    const replayedReadiness = await replayObserved;
    expect(JSON.stringify(replayedReadiness)).toBe(
      saved.activation.readiness_json!,
    );
    await until(async () => {
      const status = await call<{
        activation?: { status: string };
      }>(baseUrl, `/v1/workspace-relocations/${relocationRequestId}`, {
        credential: owner,
      });
      return status.value.activation?.status === "activated";
    });
    expect(
      await readFile(join(destinationWorkspace, "tracked.txt"), "utf8"),
    ).toBe("working source\n");
    await stopNode(destinationRunner);
    const afterActivation = readPersistedRelocationEvidence(
      databasePath,
      relocation.value.relocationId,
    );
    expect(afterActivation.activation.readiness_json).toBe(
      saved.activation.readiness_json,
    );
    expect(afterActivation.activation.readiness_sha256).toBe(
      saved.activation.readiness_sha256,
    );
    expect(afterActivation.activation.readiness_receipt_sha256).toBe(
      saved.activation.readiness_receipt_sha256,
    );
    expect(afterActivation.activation.accepted_at).toBe(
      saved.activation.accepted_at,
    );
    return;
  }

  await writeFile(
    join(destinationWorkspace, "tracked.txt"),
    "tampered after reopen\n",
  );
  destinationRunner = startNode(
    directory,
    destinationNodeIdentity.value.node.nodeId,
    destinationNodeIdentity.value.credential,
    [{ workspaceId: destinationWorkspaceId, directory: destinationWorkspace }],
    baseUrl,
  );
  runners.push(destinationRunner);
  let finalStatus:
    | {
        status: string;
        previousReceiptSha256?: string;
        activation?: {
          status: string;
          ownershipGeneration?: number;
          readinessReceiptSha256?: string;
        };
      }
    | undefined;
  await until(async () => {
    const current = await call<typeof finalStatus & {}>(
      baseUrl,
      `/v1/workspace-relocations/${relocationRequestId}`,
      { credential: owner },
    );
    finalStatus = current.value;
    return (
      finalStatus.status === "uncertain" ||
      finalStatus.activation?.status === "uncertain"
    );
  });
  const currentThreads = await call<{
    threads: Array<{
      threadId: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>;
  }>(
    baseUrl,
    `/v1/threads?projectId=${encodeURIComponent(project.value.projectId)}`,
    { credential: owner },
  );
  const currentThread = currentThreads.value.threads.find(
    (candidate) => candidate.threadId === threadId,
  );
  expect(currentThread).toMatchObject({
    target: {
      nodeId: sourceNode.value.node.nodeId,
      workspaceId: sourceWorkspaceId,
    },
    ownershipGeneration: 0,
  });
  expect(finalStatus).toMatchObject({
    status: "uncertain",
    previousReceiptSha256: prepared.value.receiptSha256,
    activation: { status: "uncertain" },
  });
  expect(finalStatus?.activation?.ownershipGeneration).toBeUndefined();
  expect(finalStatus?.activation?.readinessReceiptSha256).toBeUndefined();
  const captureStatus = await call<{ status: string }>(
    baseUrl,
    `/v1/capture-controls/${coherent.captureRequestId}`,
    { credential: owner },
  );
  expect(captureStatus.value.status).toBe("source-capture-fenced");
  expect(
    hasWorkspaceReport(
      destinationRunner.daemon,
      destinationWorkspaceId,
      0,
      "fenced",
    ),
  ).toBe(true);
  expect(
    await readFile(join(destinationWorkspace, "tracked.txt"), "utf8"),
  ).toBe("tampered after reopen\n");
  await stopNode(destinationRunner);
  const uncertain = readPersistedRelocationEvidence(
    databasePath,
    relocation.value.relocationId,
  );
  expect(uncertain.relocation.status).toBe("uncertain");
  expect(uncertain.relocation.previous_receipt_sha256).toBe(
    prepared.value.receiptSha256,
  );
  expect(uncertain.relocation.previous_receipt_json).toBe(
    saved.relocation.receipt_json,
  );
  expect(uncertain.activation.readiness_json).toBe(
    saved.activation.readiness_json,
  );
  expect(uncertain.activation.readiness_sha256).toBe(
    saved.activation.readiness_sha256,
  );
  expect(uncertain.activation.readiness_receipt_sha256).toBe(
    saved.activation.readiness_receipt_sha256,
  );
  expect(uncertain.activation.accepted_at).toBe(saved.activation.accepted_at);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("execution cutover in production-shaped workerd + R2", () => {
  test("replays the exact saved readiness after an intact destination SQLite reopen", async () => {
    await runSavedReadinessReopenScenario("readiness-intact", false);
  });

  test("parks changed prepared output before a persisted readiness can commit ownership", async () => {
    await runSavedReadinessReopenScenario("readiness-mutated", true);
  });

  test("moves one real dirty workspace A to B to C, preserves the same cloud Pi root, and keeps unrelated X live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-execution-cutover-"));
    const sourceWorkspace = join(directory, "workspace-a");
    const unrelatedWorkspace = join(directory, "workspace-x");
    const destinationWorkspace = join(directory, "workspace-b");
    await makeDirtyGitWorkspace(sourceWorkspace);
    await mkdir(unrelatedWorkspace);
    await mkdir(destinationWorkspace);

    const workerArtifact = await buildCloudflareWorkerArtifact(
      join(import.meta.dir, "capture-aware-workerd-entry.ts"),
    );
    const durableObjectsPath = join(directory, "durable-objects");
    const r2Path = join(directory, "r2");
    const captureStateBarrier = new CaptureStateBarrier();
    const pendingAdmissionRequests = new Map<Promise<unknown>, () => void>();
    const trackedAdmissionPost = <T>(
      baseUrl: string,
      path: string,
      credential: string,
      body: unknown,
    ) => {
      const controller = new AbortController();
      const promise = (async () => {
        const response = await fetch(new URL(path, baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        return { status: response.status, value: JSON.parse(text) as T };
      })();
      pendingAdmissionRequests.set(promise, () => controller.abort());
      void promise.then(
        () => pendingAdmissionRequests.delete(promise),
        () => undefined,
      );
      return promise;
    };
    const waitForCaptureStateBarrier = async (
      entered: Promise<void>,
      label: string,
    ) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Timed out waiting for ${label}`)),
              15_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    let ownerReadBarrierEntered = false;
    let releaseOwnerRead: (() => void) | undefined;
    const ownerReadBarrier = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== "/owner-blob"
        ) {
          return new Response(null, { status: 404 });
        }
        if (releaseOwnerRead) {
          return new Response(null, { status: 409 });
        }
        ownerReadBarrierEntered = true;
        return new Promise<Response>((resolve) => {
          releaseOwnerRead = () => {
            releaseOwnerRead = undefined;
            resolve(new Response(null, { status: 204 }));
          };
        });
      },
    });
    const createMiniflare = () =>
      new Miniflare({
        name: "uzina-execution-cutover",
        script: workerArtifact.script,
        modules: true,
        compatibilityDate: "2026-05-01",
        host: "127.0.0.1",
        port: 0,
        bindings: {
          UZINA_BOOTSTRAP_SECRET: "cutover-workerd-bootstrap",
          UZINA_TEST_OWNER_BLOB_BARRIER_URL: new URL(
            "/owner-blob",
            ownerReadBarrier.url,
          ).toString(),
          UZINA_TEST_CAPTURE_STATE_BARRIER_URL: captureStateBarrier.url,
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
    let sourceRunner!: RunningNode;
    let destinationNode!: RunningNode;
    let releaseCommitGate: (() => void) | undefined;
    let releaseReadinessDropGate: (() => void) | undefined;
    let releaseActivationClaimGate: (() => void) | undefined;
    let releaseActivationAckGate: (() => void) | undefined;
    let releaseFaultReadinessGate: (() => void) | undefined;
    const runners: RunningNode[] = [];
    const fixture: Fixture = {
      directory,
      get miniflare() {
        return miniflare;
      },
      async close() {
        const failures: unknown[] = [];
        captureStateBarrier.releaseAll();
        const pending = [...pendingAdmissionRequests];
        for (const [, abort] of pending) abort();
        const admissionResults = await Promise.allSettled(
          pending.map(([request]) => request),
        );
        for (const result of admissionResults) {
          if (result.status === "rejected") failures.push(result.reason);
        }
        pendingAdmissionRequests.clear();
        releaseCommitGate?.();
        releaseReadinessDropGate?.();
        releaseActivationClaimGate?.();
        releaseActivationAckGate?.();
        releaseFaultReadinessGate?.();
        releaseOwnerRead?.();
        for (const runner of runners) {
          try {
            await stopNode(runner);
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await miniflare.dispose();
        } catch (error) {
          failures.push(error);
        }
        try {
          await ownerReadBarrier.stop(true);
        } catch (error) {
          failures.push(error);
        }
        try {
          await captureStateBarrier.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "Execution cutover fixture failed to stop owned node loops cleanly",
          );
        }
      },
    };
    fixtures.push(fixture);

    let baseUrl = (await miniflare.ready).toString();
    const reopenPersistedWorkerd = async () => {
      await miniflare.dispose();
      miniflare = createMiniflare();
      baseUrl = (await miniflare.ready).toString();
    };
    const bootstrap = await call<{ credentialId: string; credential: string }>(
      baseUrl,
      "/v1/bootstrap",
      {
        bootstrap: true,
        credential: "cutover-workerd-bootstrap",
        body: { name: "Cutover owner" },
      },
    );
    expect(bootstrap.response.status).toBe(201);
    let owner = bootstrap.value.credential;
    const originalOwner = owner;
    const project = await call<{ projectId: string }>(baseUrl, "/v1/projects", {
      credential: owner,
      body: { projectId: "project:execution-cutover", name: "Cutover" },
    });
    expect(project.response.status).toBe(201);

    const sourceNodeIdentity = await call<{
      node: { nodeId: string };
      credential: string;
    }>(baseUrl, "/v1/nodes", {
      credential: owner,
      body: { nodeId: "node:cutover-a", name: "Source A" },
    });
    const destinationNodeIdentity = await call<{
      node: { nodeId: string };
      credentialId: string;
      credential: string;
    }>(baseUrl, "/v1/nodes", {
      credential: owner,
      body: { nodeId: "node:cutover-b", name: "Destination B" },
    });
    const workspace = async (workspaceId: string, nodeId: string) =>
      call<{ workspaceId: string }>(baseUrl, "/v1/workspaces", {
        credential: owner,
        body: { workspaceId, nodeId, name: workspaceId },
      });
    const workspaceA = await workspace(
      "workspace:cutover-a",
      sourceNodeIdentity.value.node.nodeId,
    );
    const workspaceX = await workspace(
      "workspace:cutover-x",
      sourceNodeIdentity.value.node.nodeId,
    );
    const workspaceB = await workspace(
      "workspace:cutover-b",
      destinationNodeIdentity.value.node.nodeId,
    );
    expect(workspaceA.response.status).toBe(201);
    expect(workspaceX.response.status).toBe(201);
    expect(workspaceB.response.status).toBe(201);

    sourceRunner = startNode(
      directory,
      sourceNodeIdentity.value.node.nodeId,
      sourceNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
      ],
      baseUrl,
    );
    runners.push(sourceRunner);
    const waitOnline = async (nodeId: string) =>
      until(async () => {
        const current = await call<{
          nodes: Array<{ nodeId: string; availability: string }>;
        }>(baseUrl, "/v1/nodes", { credential: owner });
        return current.value.nodes.some(
          (node) => node.nodeId === nodeId && node.availability === "online",
        );
      });
    await waitOnline(sourceNodeIdentity.value.node.nodeId);

    const sourceThread = await call<{
      threadId: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, "/v1/threads", {
      credential: owner,
      body: {
        threadId: "thread:cutover-a",
        projectId: project.value.projectId,
        title: "Workspace execution on A",
        target: {
          nodeId: sourceNodeIdentity.value.node.nodeId,
          workspaceId: workspaceA.value.workspaceId,
        },
      },
    });
    const unrelatedThread = await call<{
      threadId: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, "/v1/threads", {
      credential: owner,
      body: {
        threadId: "thread:cutover-x",
        projectId: project.value.projectId,
        title: "Unrelated workspace X",
        target: {
          nodeId: sourceNodeIdentity.value.node.nodeId,
          workspaceId: workspaceX.value.workspaceId,
        },
      },
    });
    expect(sourceThread.response.status).toBe(201);
    expect(unrelatedThread.response.status).toBe(201);
    expect(sourceThread.value.ownershipGeneration).toBe(0);
    expect(unrelatedThread.value.ownershipGeneration).toBe(0);

    const sourceReceipt = await writeThroughManagedPi(
      baseUrl,
      owner,
      sourceThread.value.threadId,
      "request:cutover-a-before",
      "call:cutover-a-before",
      "source-effect.txt",
      "A effect before move\n",
    );
    expect(sourceReceipt.value).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
      executionEffects: [
        expect.objectContaining({
          status: "completed",
          ownershipGeneration: 0,
        }),
      ],
    });
    const unrelatedBefore = await writeThroughManagedPi(
      baseUrl,
      owner,
      unrelatedThread.value.threadId,
      "request:cutover-x-before",
      "call:cutover-x-before",
      "x-before.txt",
      "X before move\n",
    );
    expect(unrelatedBefore.value).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceX.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    expect(
      await readFile(join(unrelatedWorkspace, "x-before.txt"), "utf8"),
    ).toBe("X before move\n");
    const sourceEvidenceBeforeCutover =
      await gitWorkspaceEvidence(sourceWorkspace);

    const originalPiStorage = await call<{
      conversations: unknown[];
      entries: unknown[];
      tasks: unknown[];
      submissions: unknown[];
      documents: unknown[];
      sessionDocuments: unknown[];
    }>(baseUrl, "/__test/managed-work", {
      body: {
        threadId: sourceThread.value.threadId,
        operation: { kind: "public-storage-observation" },
      },
    });
    const captureRequestId = "request:cutover-source-control";
    const capture = await call<{ requestId: string; captureId: string }>(
      baseUrl,
      `/v1/threads/${sourceThread.value.threadId}/capture-controls`,
      {
        credential: owner,
        body: { contractVersion: 1, requestId: captureRequestId },
      },
    );
    expect(capture.response.status).toBe(202);
    await until(async () => {
      const receipt = await call<{ status: string }>(
        baseUrl,
        `/v1/capture-controls/${captureRequestId}`,
        { credential: owner },
      );
      return receipt.value.status === "source-capture-fenced";
    });

    const snapshotRequestId = "snapshot:cutover-source";
    const snapshot = await call<{
      requestId: string;
      snapshotId: string;
      captureId: string;
    }>(baseUrl, "/v1/workspace-snapshots", {
      credential: owner,
      body: {
        contractVersion: 1,
        requestId: snapshotRequestId,
        captureRequestId,
      },
    });
    expect(snapshot.response.status).toBe(202);
    await until(async () => {
      const status = await call<{ status: string }>(
        baseUrl,
        `/v1/workspace-snapshots/${snapshotRequestId}`,
        { credential: owner },
      );
      return status.value.status === "workspace-checkpoint-available";
    });
    const snapshotStatus = await call<{
      status: string;
      snapshotId: string;
      captureId: string;
      manifestReference: string;
      ownershipGeneration: number;
      target: { nodeId: string; workspaceId: string };
    }>(baseUrl, `/v1/workspace-snapshots/${snapshotRequestId}`, {
      credential: owner,
    });
    expect(snapshotStatus.value).toMatchObject({
      status: "workspace-checkpoint-available",
      ownershipGeneration: 0,
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
    });

    const checkpointRequestId = "checkpoint:cutover-source";
    const checkpointAdmission = await call<{ requestId: string }>(
      baseUrl,
      `/v1/threads/${sourceThread.value.threadId}/managed-work-checkpoints`,
      {
        credential: owner,
        body: {
          contractVersion: 1,
          requestId: checkpointRequestId,
          captureRequestId,
          workspaceSnapshotRequestId: snapshotRequestId,
        },
      },
    );
    expect(checkpointAdmission.response.status).toBe(202);
    await until(async () => {
      const status = await call<{ status: string; stage: string }>(
        baseUrl,
        `/v1/managed-work-checkpoints/${checkpointRequestId}`,
        { credential: owner },
      );
      if (["blocked", "uncertain"].includes(status.value.status)) {
        throw new Error(JSON.stringify(status.value));
      }
      return (
        status.value.status === "available" &&
        status.value.stage === "available"
      );
    });
    const checkpointStatus = await call<{
      status: string;
      manifestReference: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, `/v1/managed-work-checkpoints/${checkpointRequestId}`, {
      credential: owner,
    });
    expect(checkpointStatus.value).toMatchObject({
      status: "available",
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
    });

    const destinationRequest = {
      contractVersion: 1,
      requestId: "relocation:cutover-a-to-b",
      checkpointRequestId,
      destination: {
        nodeId: destinationNodeIdentity.value.node.nodeId,
        workspaceId: workspaceB.value.workspaceId,
      },
    };
    const relocationPath = `/v1/threads/${sourceThread.value.threadId}/workspace-relocations`;
    await stopNode(sourceRunner);
    const deniedHoldRequestId = "hold:denied-after-relocation-commit";
    const pendingHoldGate = captureStateBarrier.arm({
      kind: "managed-work-transfer-hold",
      requestId: deniedHoldRequestId,
      threadId: sourceThread.value.threadId,
    });
    const pendingHold = trackedAdmissionPost<{ error?: string }>(
      baseUrl,
      `/v1/threads/${sourceThread.value.threadId}/managed-work-transfer-holds`,
      owner,
      {
        contractVersion: 1,
        requestId: deniedHoldRequestId,
        captureRequestId,
        checkpointRequestId,
      },
    );
    await waitForCaptureStateBarrier(
      pendingHoldGate.entered,
      "hold capture-state read before relocation admission",
    );
    const relocation = await trackedAdmissionPost<{
      relocationId: string;
      requestId: string;
      destination: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
      destinationOwnershipGeneration?: number;
      status: string;
    }>(baseUrl, relocationPath, owner, destinationRequest);
    expect(relocation.status).toBe(202);
    expect(relocation.value).toMatchObject({
      requestId: destinationRequest.requestId,
      destination: destinationRequest.destination,
      ownershipGeneration: 0,
      destinationOwnershipGeneration: 0,
      status: "queued",
    });
    pendingHoldGate.release();
    expect(await pendingHold).toMatchObject({
      status: 409,
      value: { error: "managed_work_transfer_hold_relocation_exists" },
    });
    expect(
      await call(
        baseUrl,
        `/v1/managed-work-transfer-holds/${deniedHoldRequestId}`,
        { credential: owner },
      ),
    ).toMatchObject({ response: { status: 404 } });
    sourceRunner = startNode(
      directory,
      sourceNodeIdentity.value.node.nodeId,
      sourceNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
      ],
      baseUrl,
    );
    runners.push(sourceRunner);
    await waitOnline(sourceNodeIdentity.value.node.nodeId);
    const relocationStatusPath = `/v1/workspace-relocations/${destinationRequest.requestId}`;
    const unclaimedRead = await fetch(
      new URL(
        `/v1/nodes/${destinationRequest.destination.nodeId}/workspace-relocations/${relocation.value.relocationId}/blobs/${snapshotStatus.value.manifestReference}`,
        baseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${destinationNodeIdentity.value.credential}`,
        },
      },
    );
    expect(unclaimedRead.status).toBe(404);
    await unclaimedRead.body?.cancel();
    const blockedDestination = await call<{ error: string }>(
      baseUrl,
      "/v1/threads",
      {
        credential: owner,
        body: {
          threadId: "thread:cutover-destination-reserved",
          projectId: project.value.projectId,
          title: "Reserved destination is not a fresh thread target",
          target: destinationRequest.destination,
        },
      },
    );
    expect(blockedDestination.response.status).toBe(409);

    destinationNode = startNode(
      directory,
      destinationNodeIdentity.value.node.nodeId,
      destinationNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceB.value.workspaceId,
          directory: destinationWorkspace,
        },
      ],
      baseUrl,
    );
    runners.push(destinationNode);
    await waitOnline(destinationNodeIdentity.value.node.nodeId);
    await until(async () => {
      const current = await call<{ status: string }>(
        baseUrl,
        relocationStatusPath,
        { credential: owner },
      );
      return current.value.status === "prepared-inactive";
    });
    const preparedRelocation = await call<{
      status: string;
      receiptSha256: string;
      destinationOwnershipGeneration?: number;
      ownershipGeneration: number;
    }>(baseUrl, relocationStatusPath, { credential: owner });
    expect(preparedRelocation.value).toMatchObject({
      status: "prepared-inactive",
      receiptSha256: expect.any(String),
      ownershipGeneration: 0,
      destinationOwnershipGeneration: 0,
    });
    expect(
      await readFile(join(destinationWorkspace, "tracked.txt"), "utf8"),
    ).toBe("working source\n");
    expect(git(destinationWorkspace, "rev-parse", "HEAD")).toBe(
      git(sourceWorkspace, "rev-parse", "HEAD"),
    );
    expect(git(destinationWorkspace, "status", "--porcelain")).toBe(
      git(sourceWorkspace, "status", "--porcelain"),
    );
    expect(git(destinationWorkspace, "show", ":tracked.txt")).toBe(
      git(sourceWorkspace, "show", ":tracked.txt"),
    );
    expect(await gitWorkspaceEvidence(destinationWorkspace)).toEqual(
      sourceEvidenceBeforeCutover,
    );
    expect(await readFile(join(destinationWorkspace, "binary"))).toEqual(
      await readFile(join(sourceWorkspace, "binary")),
    );
    expect(
      (await stat(join(destinationWorkspace, "binary"))).mode & 0o111,
    ).toBe((await stat(join(sourceWorkspace, "binary"))).mode & 0o111);
    expect(
      await readFile(join(sourceWorkspace, "source-effect.txt"), "utf8"),
    ).toBe("A effect before move\n");
    expect(
      await readFile(join(destinationWorkspace, "source-effect.txt"), "utf8"),
    ).toBe("A effect before move\n");
    const piBeforeMove = await call<Record<string, unknown>>(
      baseUrl,
      "/__test/managed-work",
      {
        body: {
          threadId: sourceThread.value.threadId,
          operation: { kind: "public-storage-observation" },
        },
      },
    );
    expect(piBeforeMove.value).toEqual(originalPiStorage.value);

    const replacementOwner = await call<{
      credential: string;
      credentialId: string;
    }>(baseUrl, "/v1/credentials", {
      credential: owner,
      body: { kind: "human", name: "Cutover owner continuity credential" },
    });
    expect(replacementOwner.response.status).toBe(201);

    const activationIntentPath = `/v1/workspace-relocations/${destinationRequest.requestId}/activation-intent`;
    const activationIntentBody = { contractVersion: 1 };
    const lostIntentReplyStatus = await forwardAndDiscardPost(
      baseUrl,
      activationIntentPath,
      owner,
      activationIntentBody,
    );
    expect(lostIntentReplyStatus).toBe(202);
    const intent = await call<{
      status: string;
      activation: {
        status: string;
        preparedReceiptSha256: string;
        intentAt: string;
      };
    }>(baseUrl, activationIntentPath, {
      credential: owner,
      body: activationIntentBody,
    });
    expect(intent.response.status).toBe(202);
    expect(intent.value).toMatchObject({
      status: "prepared-inactive",
      activation: {
        status: "intent",
        preparedReceiptSha256: preparedRelocation.value.receiptSha256,
      },
    });

    let signalCommitEntered!: (
      command: WorkspaceRelocationActivationCommand,
    ) => void;
    const commitEntered = new Promise<WorkspaceRelocationActivationCommand>(
      (resolve) => {
        signalCommitEntered = resolve;
      },
    );
    let allowCommitReturn!: () => void;
    const commitReturnGate = new Promise<void>((resolve) => {
      allowCommitReturn = resolve;
    });
    releaseCommitGate = allowCommitReturn;
    let signalReadinessReplyDropped!: () => void;
    const readinessReplyDropped = new Promise<void>((resolve) => {
      signalReadinessReplyDropped = resolve;
    });
    let allowReadinessDropReturn!: () => void;
    const readinessDropGate = new Promise<void>((resolve) => {
      allowReadinessDropReturn = resolve;
    });
    releaseReadinessDropGate = allowReadinessDropReturn;
    let signalActivationClaimDropped!: (
      command: WorkspaceRelocationActivationCommand,
    ) => void;
    const activationClaimDropped =
      new Promise<WorkspaceRelocationActivationCommand>((resolve) => {
        signalActivationClaimDropped = resolve;
      });
    let allowActivationClaimReturn!: () => void;
    const activationClaimGate = new Promise<void>((resolve) => {
      allowActivationClaimReturn = resolve;
    });
    releaseActivationClaimGate = allowActivationClaimReturn;
    let signalActivationAckLost!: () => void;
    const activationAckLost = new Promise<void>((resolve) => {
      signalActivationAckLost = resolve;
    });
    let allowActivationAckReturn!: () => void;
    const activationAckGate = new Promise<void>((resolve) => {
      allowActivationAckReturn = resolve;
    });
    releaseActivationAckGate = allowActivationAckReturn;
    let droppedActivationClaimReply = false;
    let droppedReadinessReply = false;
    let droppedActivationReportAck = false;
    let lostActivationCommand: WorkspaceRelocationActivationCommand | undefined;
    let lostActivationReport: WorkspaceRelocationActivationReport | undefined;
    const activationCommands: WorkspaceRelocationActivationCommand[] = [];
    const activationReportPosts: WorkspaceRelocationActivationReport[] = [];
    const createHeldController = () => {
      const baseController = new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: destinationNodeIdentity.value.node.nodeId,
        credential: destinationNodeIdentity.value.credential,
      });
      return new Proxy(baseController, {
        get(target, property) {
          const member = Reflect.get(target, property, target);
          if (typeof member !== "function") return member;
          if (property === "claimWorkspaceRelocationActivation") {
            return async () => {
              const claim = await target.claimWorkspaceRelocationActivation();
              if (claim?.phase === "activate") {
                activationCommands.push(structuredClone(claim.command));
              }
              if (claim?.phase === "activate" && !droppedActivationClaimReply) {
                droppedActivationClaimReply = true;
                lostActivationCommand = structuredClone(claim.command);
                signalActivationClaimDropped(structuredClone(claim.command));
                await activationClaimGate;
                throw new ControllerTransportError();
              }
              return claim;
            };
          }
          if (property === "reportWorkspaceRelocationActivationReadiness") {
            return async (readiness: Record<string, unknown>) => {
              const readinessPath = `/v1/nodes/${destinationNodeIdentity.value.node.nodeId}/workspace-relocations/${relocation.value.relocationId}/readiness`;
              const badBinding = await call<{ error: string }>(
                baseUrl,
                readinessPath,
                {
                  credential: destinationNodeIdentity.value.credential,
                  body: {
                    ...readiness,
                    sourceProofSha256: "0".repeat(64),
                  },
                },
              );
              expect(badBinding.response.status).toBe(409);
              expect(badBinding.value.error).toBe(
                "workspace_relocation_activation_readiness_mismatch",
              );
              const badDigest = await call<{ error: string }>(
                baseUrl,
                readinessPath,
                {
                  credential: destinationNodeIdentity.value.credential,
                  body: {
                    ...readiness,
                    readinessReceiptSha256: "0".repeat(64),
                  },
                },
              );
              expect(badDigest.response.status).toBe(409);
              expect(badDigest.value.error).toBe(
                "workspace_relocation_activation_readiness_receipt_mismatch",
              );
              const command =
                await target.reportWorkspaceRelocationActivationReadiness(
                  readiness,
                );
              signalCommitEntered(structuredClone(command));
              await commitReturnGate;
              droppedReadinessReply = true;
              signalReadinessReplyDropped();
              await readinessDropGate;
              throw new ControllerTransportError();
            };
          }
          if (property === "reportWorkspaceRelocationActivation") {
            return async (report: WorkspaceRelocationActivationReport) => {
              if (activationReportPosts.length === 0) {
                const invalid = await call<{ error: string }>(
                  baseUrl,
                  `/v1/nodes/${destinationNodeIdentity.value.node.nodeId}/workspace-relocations/${relocation.value.relocationId}/activation-report`,
                  {
                    credential: destinationNodeIdentity.value.credential,
                    body: {
                      ...report,
                      activationReceiptSha256: "0".repeat(64),
                    },
                  },
                );
                expect(invalid.response.status).toBe(409);
                expect(invalid.value.error).toBe(
                  "workspace_relocation_activation_receipt_mismatch",
                );
              }
              activationReportPosts.push(structuredClone(report));
              await target.reportWorkspaceRelocationActivation(report);
              if (!droppedActivationReportAck) {
                droppedActivationReportAck = true;
                lostActivationReport = structuredClone(report);
                signalActivationAckLost();
                await activationAckGate;
                throw new ControllerTransportError();
              }
            };
          }
          return member.bind(target);
        },
      }) as ExecutionControllerConnector;
    };
    let heldController = createHeldController();
    const baseController = new HttpExecutionControllerConnector({
      controllerUrl: baseUrl,
      nodeId: destinationNodeIdentity.value.node.nodeId,
      credential: destinationNodeIdentity.value.credential,
    });
    await stopNode(destinationNode);
    destinationNode = startNode(
      directory,
      destinationNodeIdentity.value.node.nodeId,
      destinationNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceB.value.workspaceId,
          directory: destinationWorkspace,
        },
      ],
      baseUrl,
      heldController,
    );
    runners.push(destinationNode);

    const committedCommand = await commitEntered;
    expect(committedCommand).toMatchObject({
      relocationId: relocation.value.relocationId,
      sourceOwnershipGeneration: 0,
      destinationOwnershipGeneration: 0,
      ownershipGeneration: 1,
      preparedReceiptSha256: preparedRelocation.value.receiptSha256,
    });
    const ownershipCommitted = await call<{
      status: string;
      historical?: true;
      activation: { status: string; ownershipGeneration: number };
    }>(baseUrl, relocationStatusPath, { credential: owner });
    expect(ownershipCommitted.value).toMatchObject({
      status: "prepared-inactive",
      historical: true,
      activation: { status: "ownership-committed", ownershipGeneration: 1 },
    });
    expect(
      hasWorkspaceReport(
        destinationNode.daemon,
        workspaceB.value.workspaceId,
        0,
        "fenced",
      ),
    ).toBe(true);
    await baseController.heartbeat(destinationNode.daemon.heartbeatRequest());
    const staleSourceController = new HttpExecutionControllerConnector({
      controllerUrl: baseUrl,
      nodeId: sourceNodeIdentity.value.node.nodeId,
      credential: sourceNodeIdentity.value.credential,
    });
    await staleSourceController.register(sourceRunner.daemon.registerRequest());
    await staleSourceController.heartbeat(
      sourceRunner.daemon.heartbeatRequest(),
    );
    const threadDuringBarrier = await call<{
      threads: Array<{
        threadId: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
      }>;
    }>(baseUrl, "/v1/threads", { credential: owner });
    expect(
      threadDuringBarrier.value.threads.find(
        (thread) => thread.threadId === sourceThread.value.threadId,
      ),
    ).toMatchObject({
      target: destinationRequest.destination,
      ownershipGeneration: 1,
    });
    expect(
      threadDuringBarrier.value.threads.find(
        (thread) => thread.threadId === unrelatedThread.value.threadId,
      ),
    ).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceX.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    const blockedInput = await call<{ error: string }>(
      baseUrl,
      `/v1/threads/${sourceThread.value.threadId}/inputs`,
      {
        credential: owner,
        body: {
          requestId: "request:cutover-gap-must-not-accept",
          text: "This cannot run before activation finalizes.",
        },
      },
    );
    expect(blockedInput.response.status).toBe(409);
    const absentGapReceipt = await call<{ error: string }>(
      baseUrl,
      "/v1/commands/request:cutover-gap-must-not-accept",
      { credential: owner },
    );
    expect(absentGapReceipt.response.status).toBe(404);
    const blockedContext = await fetch(
      new URL(`/v1/threads/${sourceThread.value.threadId}/context`, baseUrl),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(blockedContext.status).toBeGreaterThanOrEqual(400);
    await blockedContext.body?.cancel();
    const blockedBClaim = await call<{ job: unknown }>(
      baseUrl,
      `/v1/nodes/${destinationNodeIdentity.value.node.nodeId}/jobs/claim`,
      {
        credential: destinationNodeIdentity.value.credential,
        body: {
          contractVersion: 1,
          nodeId: destinationNodeIdentity.value.node.nodeId,
        },
      },
    );
    expect(blockedBClaim.response.status).toBe(200);
    expect(blockedBClaim.value.job).toBeNull();
    const unrelatedDuring = await writeThroughManagedPi(
      baseUrl,
      owner,
      unrelatedThread.value.threadId,
      "request:cutover-x-during",
      "call:cutover-x-during",
      "x-during.txt",
      "X progresses during activation barrier\n",
    );
    expect(unrelatedDuring.value).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceX.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    expect(
      await readFile(join(unrelatedWorkspace, "x-during.txt"), "utf8"),
    ).toBe("X progresses during activation barrier\n");

    allowCommitReturn();
    releaseCommitGate = undefined;
    await readinessReplyDropped;
    expect(droppedReadinessReply).toBe(true);
    destinationNode.abort.abort();
    sourceRunner.abort.abort();
    allowReadinessDropReturn();
    releaseReadinessDropGate = undefined;
    await Promise.all([stopNode(destinationNode), stopNode(sourceRunner)]);
    await reopenPersistedWorkerd();
    heldController = createHeldController();
    const coldCommittedAgain = await call<{
      activation: { status: string; ownershipGeneration: number };
    }>(baseUrl, relocationStatusPath, { credential: owner });
    expect(coldCommittedAgain.value.activation).toMatchObject({
      status: "ownership-committed",
      ownershipGeneration: 1,
    });
    const coldDestinationDaemon = new ExecutionDaemon({
      databasePath: join(directory, "cutover-b.sqlite"),
      nodeId: destinationNodeIdentity.value.node.nodeId,
      nodeCredential: destinationNodeIdentity.value.credential,
      workspaces: [
        {
          workspaceId: workspaceB.value.workspaceId,
          directory: destinationWorkspace,
        },
      ],
    });
    const coldSourceDaemon = new ExecutionDaemon({
      databasePath: join(directory, "cutover-a.sqlite"),
      nodeId: sourceNodeIdentity.value.node.nodeId,
      nodeCredential: sourceNodeIdentity.value.credential,
      workspaces: [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
      ],
    });
    try {
      const coldDestinationController = new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: destinationNodeIdentity.value.node.nodeId,
        credential: destinationNodeIdentity.value.credential,
      });
      const coldSourceController = new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: sourceNodeIdentity.value.node.nodeId,
        credential: sourceNodeIdentity.value.credential,
      });
      expect(
        hasWorkspaceReport(
          coldDestinationDaemon,
          workspaceB.value.workspaceId,
          0,
          "fenced",
        ),
      ).toBe(true);
      await coldDestinationController.register(
        coldDestinationDaemon.registerRequest(),
      );
      await coldDestinationController.heartbeat(
        coldDestinationDaemon.heartbeatRequest(),
      );
      await coldSourceController.register(coldSourceDaemon.registerRequest());
      await coldSourceController.heartbeat(coldSourceDaemon.heartbeatRequest());
    } finally {
      coldDestinationDaemon.close();
      coldSourceDaemon.close();
    }
    expect(await gitWorkspaceEvidence(destinationWorkspace)).toEqual(
      sourceEvidenceBeforeCutover,
    );
    sourceRunner = startNode(
      directory,
      sourceNodeIdentity.value.node.nodeId,
      sourceNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
      ],
      baseUrl,
    );
    runners.push(sourceRunner);
    destinationNode = startNode(
      directory,
      destinationNodeIdentity.value.node.nodeId,
      destinationNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceB.value.workspaceId,
          directory: destinationWorkspace,
        },
      ],
      baseUrl,
      heldController,
    );
    runners.push(destinationNode);
    await waitOnline(destinationNodeIdentity.value.node.nodeId);
    const lostActivationClaim = await activationClaimDropped;
    expect(droppedActivationClaimReply).toBe(true);
    expect(lostActivationCommand).toEqual(committedCommand);
    expect(lostActivationClaim).toEqual(committedCommand);
    expect(activationCommands).toHaveLength(1);
    expect(activationCommands[0]).toEqual(committedCommand);
    expect(
      destinationNode.daemon.pendingWorkspaceRelocationActivationReports(),
    ).toEqual([]);
    expect(
      hasWorkspaceReport(
        destinationNode.daemon,
        workspaceB.value.workspaceId,
        0,
        "fenced",
      ),
    ).toBe(true);
    expect(await gitWorkspaceEvidence(destinationWorkspace)).toEqual(
      sourceEvidenceBeforeCutover,
    );
    allowActivationClaimReturn();
    releaseActivationClaimGate = undefined;
    await activationAckLost;
    expect(droppedActivationReportAck).toBe(true);
    expect(activationCommands).toHaveLength(2);
    expect(activationCommands[1]).toEqual(committedCommand);
    if (!lostActivationReport) {
      throw new Error("Destination activation report was not durably sent");
    }
    const expectedActivationReport = lostActivationReport;
    expect(expectedActivationReport.command).toEqual(committedCommand);
    const pendingLocalActivation =
      destinationNode.daemon.pendingWorkspaceRelocationActivationReports();
    expect(pendingLocalActivation).toHaveLength(1);
    expect(pendingLocalActivation[0]).toEqual(expectedActivationReport);
    const finalizedBeforeDestinationReopen = await call<{
      activation: { status: string; ownershipGeneration: number };
    }>(baseUrl, relocationStatusPath, { credential: owner });
    expect(finalizedBeforeDestinationReopen.value.activation).toMatchObject({
      status: "activated",
      ownershipGeneration: 1,
    });
    destinationNode.abort.abort();
    sourceRunner.abort.abort();
    releaseActivationAckGate?.();
    releaseActivationAckGate = undefined;
    await Promise.all([stopNode(destinationNode), stopNode(sourceRunner)]);
    await reopenPersistedWorkerd();
    heldController = createHeldController();
    const coldFinalized = await call<{
      activation: { status: string; ownershipGeneration: number };
    }>(baseUrl, relocationStatusPath, { credential: owner });
    expect(coldFinalized.value.activation).toMatchObject({
      status: "activated",
      ownershipGeneration: 1,
    });
    const reopenedDestinationDaemon = new ExecutionDaemon({
      databasePath: join(directory, "cutover-b.sqlite"),
      nodeId: destinationNodeIdentity.value.node.nodeId,
      nodeCredential: destinationNodeIdentity.value.credential,
      workspaces: [
        {
          workspaceId: workspaceB.value.workspaceId,
          directory: destinationWorkspace,
        },
      ],
    });
    try {
      expect(
        reopenedDestinationDaemon.pendingWorkspaceRelocationActivationReports(),
      ).toEqual([expectedActivationReport]);
      expect(
        hasWorkspaceReport(
          reopenedDestinationDaemon,
          workspaceB.value.workspaceId,
          1,
          "active",
        ),
      ).toBe(true);
    } finally {
      reopenedDestinationDaemon.close();
    }
    expect(await gitWorkspaceEvidence(destinationWorkspace)).toEqual(
      sourceEvidenceBeforeCutover,
    );
    sourceRunner = startNode(
      directory,
      sourceNodeIdentity.value.node.nodeId,
      sourceNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
      ],
      baseUrl,
    );
    runners.push(sourceRunner);
    destinationNode = startNode(
      directory,
      destinationNodeIdentity.value.node.nodeId,
      destinationNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceB.value.workspaceId,
          directory: destinationWorkspace,
        },
      ],
      baseUrl,
      heldController,
    );
    runners.push(destinationNode);
    await waitOnline(destinationNodeIdentity.value.node.nodeId);
    await until(
      async () =>
        destinationNode.daemon.pendingWorkspaceRelocationActivationReports()
          .length === 0,
    );
    expect(activationReportPosts).toHaveLength(2);
    expect(activationReportPosts[0]).toEqual(expectedActivationReport);
    expect(activationReportPosts[1]).toEqual(expectedActivationReport);
    expect(activationCommands).toHaveLength(2);
    expect(
      hasWorkspaceReport(
        destinationNode.daemon,
        workspaceB.value.workspaceId,
        1,
        "active",
      ),
    ).toBe(true);
    expect(await gitWorkspaceEvidence(destinationWorkspace)).toEqual(
      sourceEvidenceBeforeCutover,
    );
    await until(async () => {
      const current = await call<{
        activation: { status: string };
      }>(baseUrl, relocationStatusPath, { credential: owner });
      return current.value.activation.status === "activated";
    });
    const finalized = await call<{
      status: string;
      historical?: true;
      activation: {
        status: string;
        destinationOwnershipGeneration: number;
        ownershipGeneration: number;
        activationReceiptSha256: string;
      };
    }>(baseUrl, relocationStatusPath, { credential: owner });
    expect(finalized.value).toMatchObject({
      status: "prepared-inactive",
      historical: true,
      activation: {
        status: "activated",
        destinationOwnershipGeneration: 0,
        ownershipGeneration: 1,
        activationReceiptSha256: expect.any(String),
      },
    });

    const sourceAfterMove = await readFile(
      join(sourceWorkspace, "tracked.txt"),
      "utf8",
    );
    expect(sourceAfterMove).toBe("working source\n");
    expect(git(sourceWorkspace, "status", "--porcelain").trimEnd()).toBe(
      "MM tracked.txt\n?? binary\n?? source-effect.txt",
    );
    expect(await gitWorkspaceEvidence(sourceWorkspace)).toEqual(
      sourceEvidenceBeforeCutover,
    );
    expect(
      await readFile(join(destinationWorkspace, "tracked.txt"), "utf8"),
    ).toBe(sourceAfterMove);
    expect(git(destinationWorkspace, "status", "--porcelain")).toBe(
      git(sourceWorkspace, "status", "--porcelain"),
    );
    const piAfterMove = await call<Record<string, unknown>>(
      baseUrl,
      "/__test/managed-work",
      {
        body: {
          threadId: sourceThread.value.threadId,
          operation: { kind: "public-storage-observation" },
        },
      },
    );
    expect(piAfterMove.value).toEqual(originalPiStorage.value);
    const movedContext = await call<{
      thread: {
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
      };
      runtime: { entries: unknown[] };
    }>(baseUrl, `/v1/threads/${sourceThread.value.threadId}/context`, {
      credential: owner,
    });
    if (!movedContext.value.thread) {
      throw new Error(
        `Moved Pi context unavailable (${movedContext.response.status}): ${JSON.stringify(movedContext.value)}`,
      );
    }
    expect(movedContext.value.thread).toMatchObject({
      target: destinationRequest.destination,
      ownershipGeneration: 1,
    });
    expect(movedContext.value.runtime.entries).toEqual(
      originalPiStorage.value.entries,
    );
    expect(JSON.stringify(movedContext.value.runtime.entries)).toContain(
      "Write source-effect.txt",
    );

    const sourceDirectJob = {
      contractVersion: 1,
      jobId: "job:cutover-source-must-stay-fenced",
      nodeId: sourceNodeIdentity.value.node.nodeId,
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
      operation: "write-file",
      path: "source-must-not-run.txt",
      contentBase64: Buffer.from("no").toString("base64"),
    };
    await expect(
      sourceRunner.daemon.executeJob(sourceDirectJob),
    ).rejects.toMatchObject({
      code: "workspace_capture_active",
    });
    await expect(
      sourceRunner.daemon.rex.launch({
        contractVersion: 1,
        processId: "rex:cutover-source-must-stay-fenced",
        nodeId: sourceNodeIdentity.value.node.nodeId,
        target: sourceDirectJob.target,
        ownershipGeneration: 0,
        argv: ["true"],
      }),
    ).rejects.toMatchObject({ code: "workspace_capture_active" });
    expect(
      await readFile(join(sourceWorkspace, "source-must-not-run.txt")).catch(
        () => null,
      ),
    ).toBeNull();

    const aliasGuard = new ExecutionDaemon({
      databasePath: join(directory, "cutover-a.sqlite"),
      nodeId: sourceNodeIdentity.value.node.nodeId,
      nodeCredential: sourceNodeIdentity.value.credential,
      workspaces: [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
        {
          workspaceId: "workspace:cutover-a-new-alias",
          directory: sourceWorkspace,
        },
      ],
    });
    try {
      await expect(
        aliasGuard.executeJob({
          ...sourceDirectJob,
          jobId: "job:cutover-source-alias-must-stay-fenced",
          target: {
            nodeId: sourceNodeIdentity.value.node.nodeId,
            workspaceId: "workspace:cutover-a-new-alias",
          },
        }),
      ).rejects.toMatchObject({ code: "workspace_capture_active" });
      await expect(
        aliasGuard.rex.launch({
          contractVersion: 1,
          processId: "rex:cutover-source-alias-must-stay-fenced",
          nodeId: sourceNodeIdentity.value.node.nodeId,
          target: {
            nodeId: sourceNodeIdentity.value.node.nodeId,
            workspaceId: "workspace:cutover-a-new-alias",
          },
          ownershipGeneration: 0,
          argv: ["true"],
        }),
      ).rejects.toMatchObject({ code: "workspace_capture_active" });
    } finally {
      aliasGuard.close();
    }

    const revokeOldCredential = await call(
      baseUrl,
      `/v1/credentials/${bootstrap.value.credentialId}/revoke`,
      { credential: owner, body: {} },
    );
    expect(revokeOldCredential.response.status).toBe(200);
    owner = replacementOwner.value.credential;
    const oldCredentialRejected = await call<{ error: string }>(
      baseUrl,
      relocationStatusPath,
      { credential: originalOwner },
    );
    expect(oldCredentialRejected.response.status).toBe(401);
    const historicalControl = await call<{
      requestId: string;
      status: string;
      historical?: true;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, `/v1/capture-controls/${captureRequestId}`, {
      credential: owner,
    });
    expect(historicalControl.value).toMatchObject({
      requestId: captureRequestId,
      status: "source-capture-fenced",
      historical: true,
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    const historicalSnapshot = await call<{
      status: string;
      historical?: true;
      manifestReference: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, `/v1/workspace-snapshots/${snapshotRequestId}`, {
      credential: owner,
    });
    expect(historicalSnapshot.value).toMatchObject({
      status: "workspace-checkpoint-available",
      historical: true,
      manifestReference: snapshotStatus.value.manifestReference,
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    const historicalCheckpoint = await call<{
      status: string;
      historical?: true;
      manifestReference: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, `/v1/managed-work-checkpoints/${checkpointRequestId}`, {
      credential: owner,
    });
    expect(historicalCheckpoint.value).toMatchObject({
      status: "available",
      historical: true,
      manifestReference: checkpointStatus.value.manifestReference,
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    const historicalRelocation = await call<Record<string, unknown>>(
      baseUrl,
      relocationStatusPath,
      { credential: owner },
    );
    expect(historicalRelocation.value).toMatchObject({
      historical: true,
      requestId: destinationRequest.requestId,
      captureRequestId,
      captureId: capture.value.captureId,
      workspaceSnapshotRequestId: snapshotRequestId,
      snapshotId: snapshot.value.snapshotId,
      source: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      destination: destinationRequest.destination,
      ownershipGeneration: 0,
      manifestReference: snapshotStatus.value.manifestReference,
      activation: { status: "activated", ownershipGeneration: 1 },
    });
    await readOwnerBlob(
      baseUrl,
      owner,
      `/v1/workspace-snapshots/${snapshotRequestId}/blobs/${snapshotStatus.value.manifestReference}`,
      snapshotStatus.value.manifestReference,
    );
    await readOwnerBlob(
      baseUrl,
      owner,
      `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${checkpointStatus.value.manifestReference}`,
      checkpointStatus.value.manifestReference,
    );
    const privateArtifactDeniedToNode = await fetch(
      new URL(
        `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${checkpointStatus.value.manifestReference}`,
        baseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${destinationNodeIdentity.value.credential}`,
        },
      },
    );
    expect(privateArtifactDeniedToNode.status).toBe(403);
    await privateArtifactDeniedToNode.body?.cancel();
    const retiredSourceRead = await fetch(
      new URL(
        `/v1/nodes/${destinationNodeIdentity.value.node.nodeId}/workspace-relocations/${relocation.value.relocationId}/blobs/${snapshotStatus.value.manifestReference}`,
        baseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${destinationNodeIdentity.value.credential}`,
        },
      },
    );
    expect(retiredSourceRead.status).toBe(404);
    await retiredSourceRead.body?.cancel();

    const xTable = await call<{
      reports: Array<{
        node_id: string;
        workspace_id: string;
        ownership_generation: number;
        state: string;
      }>;
    }>(baseUrl, "/__test/workspace-ownership-migration", {
      body: { action: "read" },
    });
    expect(xTable.value.reports).toContainEqual({
      node_id: sourceNodeIdentity.value.node.nodeId,
      workspace_id: workspaceX.value.workspaceId,
      ownership_generation: 0,
      state: "active",
    });
    expect(xTable.value.reports).toContainEqual({
      node_id: sourceNodeIdentity.value.node.nodeId,
      workspace_id: workspaceA.value.workspaceId,
      ownership_generation: 0,
      state: "fenced",
    });
    expect(xTable.value.reports).toContainEqual({
      node_id: destinationNodeIdentity.value.node.nodeId,
      workspace_id: workspaceB.value.workspaceId,
      ownership_generation: 1,
      state: "active",
    });

    await stopNode(sourceRunner);
    const sourceDatabasePath = join(directory, "cutover-a.sqlite");
    const aliasReconnect = new ExecutionDaemon({
      databasePath: sourceDatabasePath,
      nodeId: sourceNodeIdentity.value.node.nodeId,
      nodeCredential: sourceNodeIdentity.value.credential,
      workspaces: [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
        {
          workspaceId: "workspace:cutover-a-reconnect-alias",
          directory: sourceWorkspace,
        },
      ],
    });
    try {
      await expect(
        aliasReconnect.executeJob({
          ...sourceDirectJob,
          jobId: "job:cutover-reconnect-alias-must-stay-fenced",
          target: {
            nodeId: sourceNodeIdentity.value.node.nodeId,
            workspaceId: "workspace:cutover-a-reconnect-alias",
          },
        }),
      ).rejects.toMatchObject({ code: "workspace_capture_active" });
    } finally {
      aliasReconnect.close();
    }
    const reconnectedDaemon = new ExecutionDaemon({
      databasePath: sourceDatabasePath,
      nodeId: sourceNodeIdentity.value.node.nodeId,
      nodeCredential: sourceNodeIdentity.value.credential,
      workspaces: [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
      ],
    });
    const reconnectedController = new HttpExecutionControllerConnector({
      controllerUrl: baseUrl,
      nodeId: sourceNodeIdentity.value.node.nodeId,
      credential: sourceNodeIdentity.value.credential,
    });
    await reconnectedController.register(reconnectedDaemon.registerRequest());
    await reconnectedController.heartbeat(reconnectedDaemon.heartbeatRequest());
    const afterReconnect = await call<{
      reports: Array<{
        node_id: string;
        workspace_id: string;
        ownership_generation: number;
        state: string;
      }>;
    }>(baseUrl, "/__test/workspace-ownership-migration", {
      body: { action: "read" },
    });
    expect(afterReconnect.value.reports).toContainEqual({
      node_id: sourceNodeIdentity.value.node.nodeId,
      workspace_id: workspaceA.value.workspaceId,
      ownership_generation: 0,
      state: "fenced",
    });
    expect(afterReconnect.value.reports).toContainEqual({
      node_id: sourceNodeIdentity.value.node.nodeId,
      workspace_id: workspaceX.value.workspaceId,
      ownership_generation: 0,
      state: "active",
    });
    sourceRunner = {
      daemon: reconnectedDaemon,
      abort: new AbortController(),
      loop: Promise.resolve(),
      stopped: false,
    };
    runners.push(sourceRunner);
    sourceRunner.loop = new ExecutionLoop({
      daemon: reconnectedDaemon,
      controller: reconnectedController,
      pollIntervalMs: 20,
      heartbeatIntervalMs: 100,
    }).run(sourceRunner.abort.signal);

    const unrelatedAfter = await writeThroughManagedPi(
      baseUrl,
      owner,
      unrelatedThread.value.threadId,
      "request:cutover-x-after",
      "call:cutover-x-after",
      "x-after.txt",
      "X remains usable after A reconnects\n",
    );
    expect(unrelatedAfter.value).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceX.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    expect(
      await readFile(join(unrelatedWorkspace, "x-after.txt"), "utf8"),
    ).toBe("X remains usable after A reconnects\n");
    await expect(
      reconnectedDaemon.executeJob(sourceDirectJob),
    ).rejects.toMatchObject({ code: "workspace_capture_active" });

    const continuation = await writeThroughManagedPi(
      baseUrl,
      owner,
      sourceThread.value.threadId,
      "request:cutover-a-after",
      "call:cutover-a-after",
      "continued-at-b.txt",
      "Same cloud conversation now writes only at B\n",
    );
    expect(continuation.value).toMatchObject({
      target: destinationRequest.destination,
      ownershipGeneration: 1,
      executionEffects: [
        expect.objectContaining({
          target: destinationRequest.destination,
          ownershipGeneration: 1,
          status: "completed",
        }),
      ],
    });
    expect(
      await readFile(join(destinationWorkspace, "continued-at-b.txt"), "utf8"),
    ).toBe("Same cloud conversation now writes only at B\n");
    expect(
      await readFile(join(sourceWorkspace, "continued-at-b.txt")).catch(
        () => null,
      ),
    ).toBeNull();
    expect(
      await readFile(join(unrelatedWorkspace, "continued-at-b.txt")).catch(
        () => null,
      ),
    ).toBeNull();
    const continuedThread = await call<{
      threads: Array<{
        threadId: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
      }>;
    }>(baseUrl, "/v1/threads", { credential: owner });
    expect(
      continuedThread.value.threads.find(
        (thread) => thread.threadId === sourceThread.value.threadId,
      ),
    ).toMatchObject({
      target: destinationRequest.destination,
      ownershipGeneration: 1,
    });
    expect(
      continuedThread.value.threads.find(
        (thread) => thread.threadId === unrelatedThread.value.threadId,
      ),
    ).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceX.value.workspaceId,
      },
      ownershipGeneration: 0,
    });

    const workspaceC = await workspace(
      "workspace:cutover-c",
      sourceNodeIdentity.value.node.nodeId,
    );
    expect(workspaceC.response.status).toBe(201);
    const workspaceCDirectory = join(directory, "workspace-c");
    await mkdir(workspaceCDirectory);
    await stopNode(sourceRunner);
    sourceRunner = startNode(
      directory,
      sourceNodeIdentity.value.node.nodeId,
      sourceNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
        {
          workspaceId: workspaceC.value.workspaceId,
          directory: workspaceCDirectory,
        },
      ],
      baseUrl,
    );
    runners.push(sourceRunner);
    await until(async () =>
      hasWorkspaceReport(
        sourceRunner.daemon,
        workspaceC.value.workspaceId,
        0,
        "active",
      ),
    );

    const secondCapture = await captureCurrentWorkspaceCheckpoint(
      baseUrl,
      owner,
      sourceThread.value.threadId,
      "cutover-b-to-c",
    );
    expect(secondCapture.snapshotStatus).toMatchObject({
      status: "workspace-checkpoint-available",
      target: destinationRequest.destination,
      ownershipGeneration: 1,
    });
    expect(secondCapture.checkpointStatus).toMatchObject({
      status: "available",
      target: destinationRequest.destination,
      ownershipGeneration: 1,
    });

    const secondRelocationRequest = {
      contractVersion: 1,
      requestId: "relocation:cutover-b-to-c",
      checkpointRequestId: secondCapture.checkpointRequestId,
      destination: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceC.value.workspaceId,
      },
    };
    const secondRelocation = await call<{
      relocationId: string;
      requestId: string;
      destination: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
      destinationOwnershipGeneration: number;
      status: string;
    }>(baseUrl, relocationPath, {
      credential: owner,
      body: secondRelocationRequest,
    });
    expect(secondRelocation.response.status).toBe(202);
    expect(secondRelocation.value).toMatchObject({
      requestId: secondRelocationRequest.requestId,
      destination: secondRelocationRequest.destination,
      ownershipGeneration: 1,
      destinationOwnershipGeneration: 0,
      status: "queued",
    });
    const secondRelocationStatusPath = `/v1/workspace-relocations/${secondRelocationRequest.requestId}`;
    await until(async () => {
      const status = await call<{ status: string }>(
        baseUrl,
        secondRelocationStatusPath,
        { credential: owner },
      );
      return status.value.status === "prepared-inactive";
    });
    const secondPrepared = await call<{
      status: string;
      receiptSha256: string;
      ownershipGeneration: number;
      destinationOwnershipGeneration: number;
    }>(baseUrl, secondRelocationStatusPath, { credential: owner });
    expect(secondPrepared.value).toMatchObject({
      status: "prepared-inactive",
      ownershipGeneration: 1,
      destinationOwnershipGeneration: 0,
      receiptSha256: expect.any(String),
    });
    const secondIntent = await call<{ activation: { status: string } }>(
      baseUrl,
      `/v1/workspace-relocations/${secondRelocationRequest.requestId}/activation-intent`,
      { credential: owner, body: { contractVersion: 1 } },
    );
    expect(secondIntent.response.status).toBe(202);
    let lastSecondActivationStatus: unknown;
    try {
      await until(async () => {
        const status = await call<{
          status: string;
          activation?: { status: string; ownershipGeneration?: number };
        }>(baseUrl, secondRelocationStatusPath, { credential: owner });
        lastSecondActivationStatus = status.value;
        if (
          status.response.status >= 400 ||
          status.value.status === "blocked" ||
          status.value.status === "uncertain" ||
          status.value.activation?.status === "uncertain"
        ) {
          throw new Error(JSON.stringify(status.value));
        }
        return status.value.activation?.status === "activated";
      });
    } catch (error) {
      throw new Error(
        `Second transfer did not finalize: ${JSON.stringify(lastSecondActivationStatus)}`,
        { cause: error },
      );
    }
    const secondFinalized = await call<{
      status: string;
      activation: { status: string; ownershipGeneration: number };
    }>(baseUrl, secondRelocationStatusPath, { credential: owner });
    expect(secondFinalized.value).toMatchObject({
      status: "prepared-inactive",
      activation: { status: "activated", ownershipGeneration: 2 },
    });

    const thirdContinuation = await writeThroughManagedPi(
      baseUrl,
      owner,
      sourceThread.value.threadId,
      "request:cutover-c-after",
      "call:cutover-c-after",
      "continued-at-c.txt",
      "Same cloud conversation now writes only at C\n",
    );
    expect(thirdContinuation.value).toMatchObject({
      target: secondRelocationRequest.destination,
      ownershipGeneration: 2,
      executionEffects: [
        expect.objectContaining({
          target: secondRelocationRequest.destination,
          ownershipGeneration: 2,
          status: "completed",
        }),
      ],
    });
    expect(
      await readFile(join(workspaceCDirectory, "continued-at-c.txt"), "utf8"),
    ).toBe("Same cloud conversation now writes only at C\n");
    expect(
      await readFile(join(destinationWorkspace, "continued-at-c.txt")).catch(
        () => null,
      ),
    ).toBeNull();
    const movedAgainThread = await call<{
      threads: Array<{
        threadId: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
      }>;
    }>(baseUrl, "/v1/threads", { credential: owner });
    expect(
      movedAgainThread.value.threads.find(
        (thread) => thread.threadId === sourceThread.value.threadId,
      ),
    ).toMatchObject({
      target: secondRelocationRequest.destination,
      ownershipGeneration: 2,
    });

    const historicalControlAfterSecondMove = await call<{
      status: string;
      historical?: true;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, `/v1/capture-controls/${captureRequestId}`, {
      credential: owner,
    });
    expect(historicalControlAfterSecondMove.value).toMatchObject({
      status: "source-capture-fenced",
      historical: true,
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    const historicalSnapshotAfterSecondMove = await call<{
      historical?: true;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, `/v1/workspace-snapshots/${snapshotRequestId}`, {
      credential: owner,
    });
    expect(historicalSnapshotAfterSecondMove.value).toMatchObject({
      historical: true,
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    const historicalCheckpointAfterSecondMove = await call<{
      historical?: true;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(baseUrl, `/v1/managed-work-checkpoints/${checkpointRequestId}`, {
      credential: owner,
    });
    expect(historicalCheckpointAfterSecondMove.value).toMatchObject({
      historical: true,
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    const historicalRelocationAfterSecondMove = await call<
      Record<string, unknown>
    >(baseUrl, relocationStatusPath, { credential: owner });
    expect(historicalRelocationAfterSecondMove.value).toMatchObject({
      historical: true,
      requestId: destinationRequest.requestId,
      source: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      destination: destinationRequest.destination,
      ownershipGeneration: 0,
      activation: { status: "activated", ownershipGeneration: 1 },
    });
    await readOwnerBlob(
      baseUrl,
      owner,
      `/v1/workspace-snapshots/${snapshotRequestId}/blobs/${snapshotStatus.value.manifestReference}`,
      snapshotStatus.value.manifestReference,
    );
    await readOwnerBlob(
      baseUrl,
      owner,
      `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${checkpointStatus.value.manifestReference}`,
      checkpointStatus.value.manifestReference,
    );
    const ownerBlobReadCases = [
      {
        path: `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${checkpointStatus.value.manifestReference}`,
        namespace: "managed-work-checkpoints" as const,
        identifier: checkpointRequestId,
        reference: checkpointStatus.value.manifestReference,
      },
      {
        path: `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${snapshotStatus.value.manifestReference}`,
        namespace: "workspace-snapshots" as const,
        identifier: snapshotStatus.value.captureId,
        reference: snapshotStatus.value.manifestReference,
      },
      {
        path: `/v1/workspace-snapshots/${snapshotRequestId}/blobs/${snapshotStatus.value.manifestReference}`,
        namespace: "workspace-snapshots" as const,
        identifier: snapshotStatus.value.captureId,
        reference: snapshotStatus.value.manifestReference,
      },
    ];
    for (const blobCase of ownerBlobReadCases) {
      const readerCredential = await call<{
        credentialId: string;
        credential: string;
      }>(baseUrl, "/v1/credentials", {
        credential: owner,
        body: {
          kind: "human",
          name: `Historical blob reader ${blobCase.reference.slice(0, 8)}`,
        },
      });
      expect(readerCredential.response.status).toBe(201);
      ownerReadBarrierEntered = false;
      const heldRead = await call<{ entered: boolean; cancelled: boolean }>(
        baseUrl,
        "/__test/owner-blob-read",
        {
          body: {
            action: "hold",
            namespace: blobCase.namespace,
            identifier: blobCase.identifier,
            reference: blobCase.reference,
          },
        },
      );
      expect(heldRead.response.status).toBe(200);
      let pendingRead:
        Promise<{ response: Response } | { error: unknown }> | undefined;
      let readResponse: Response | undefined;
      try {
        pendingRead = fetch(new URL(blobCase.path, baseUrl), {
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${readerCredential.value.credential}`,
            accept: "application/octet-stream",
          },
        }).then(
          (response) => ({ response }),
          (error: unknown) => ({ error }),
        );
        await until(async () => ownerReadBarrierEntered);
        const revokedReader = await call(
          baseUrl,
          `/v1/credentials/${readerCredential.value.credentialId}/revoke`,
          { credential: owner, body: {} },
        );
        expect(revokedReader.response.status).toBe(200);
        releaseOwnerRead?.();
        const readOutcome = await pendingRead;
        if ("error" in readOutcome) throw readOutcome.error;
        readResponse = readOutcome.response;
        const returnedBytes = new Uint8Array(await readResponse.arrayBuffer());
        expect(
          createHash("sha256").update(returnedBytes).digest("hex"),
        ).not.toBe(blobCase.reference);
        expect(readResponse.status).toBe(401);
        expect(readResponse.headers.get("x-content-sha256")).toBeNull();
        expect(
          readResponse.headers.get("x-uzina-evidence-authority"),
        ).toBeNull();
        const readState = await call<{
          entered: boolean;
          cancelled: boolean;
        }>(baseUrl, "/__test/owner-blob-read", {
          body: { action: "state" },
        });
        expect(readState.value).toEqual({
          entered: false,
          cancelled: true,
        });
      } finally {
        releaseOwnerRead?.();
        await call(baseUrl, "/__test/owner-blob-read", {
          body: { action: "release" },
        });
        if (!readResponse && pendingRead) {
          const outcome = await pendingRead;
          if ("response" in outcome) await outcome.response.body?.cancel();
        } else if (readResponse && !readResponse.bodyUsed) {
          await readResponse.body?.cancel();
        }
      }
    }
    const retiredBDeniedPrivateCheckpoint = await fetch(
      new URL(
        `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${checkpointStatus.value.manifestReference}`,
        baseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${destinationNodeIdentity.value.credential}`,
        },
      },
    );
    expect(retiredBDeniedPrivateCheckpoint.status).toBe(403);
    await retiredBDeniedPrivateCheckpoint.body?.cancel();
    const sourceNodeDeniedUnlistedCheckpoint = await fetch(
      new URL(
        `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${"0".repeat(64)}`,
        baseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${sourceNodeIdentity.value.credential}`,
        },
      },
    );
    expect(sourceNodeDeniedUnlistedCheckpoint.status).toBe(403);
    await sourceNodeDeniedUnlistedCheckpoint.body?.cancel();

    const staleBJob = {
      ...sourceDirectJob,
      jobId: "job:cutover-b-must-stay-fenced-after-c",
      nodeId: destinationNodeIdentity.value.node.nodeId,
      target: destinationRequest.destination,
      ownershipGeneration: 1,
    };
    await expect(
      destinationNode.daemon.executeJob(staleBJob),
    ).rejects.toMatchObject({
      code: "workspace_capture_active",
    });
    await expect(
      sourceRunner.daemon.executeJob(sourceDirectJob),
    ).rejects.toMatchObject({
      code: "workspace_capture_active",
    });
    const unrelatedAfterSecondMove = await writeThroughManagedPi(
      baseUrl,
      owner,
      unrelatedThread.value.threadId,
      "request:cutover-x-after-c",
      "call:cutover-x-after-c",
      "x-after-c.txt",
      "X stays live after B-to-C\n",
    );
    expect(unrelatedAfterSecondMove.value).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceX.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    expect(
      await readFile(join(unrelatedWorkspace, "x-after-c.txt"), "utf8"),
    ).toBe("X stays live after B-to-C\n");

    const revokedOwnerAfterSecondMove = await call<{ error: string }>(
      baseUrl,
      relocationStatusPath,
      { credential: originalOwner },
    );
    expect(revokedOwnerAfterSecondMove.response.status).toBe(401);
    const retiredBBlobRead = await fetch(
      new URL(
        `/v1/nodes/${destinationNodeIdentity.value.node.nodeId}/workspace-relocations/${relocation.value.relocationId}/blobs/${snapshotStatus.value.manifestReference}`,
        baseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${destinationNodeIdentity.value.credential}`,
        },
      },
    );
    expect(retiredBBlobRead.status).toBe(404);
    await retiredBBlobRead.body?.cancel();

    const finalPiStorage = await call<{
      conversations: unknown[];
      entries: unknown[];
    }>(baseUrl, "/__test/managed-work", {
      body: {
        threadId: sourceThread.value.threadId,
        operation: { kind: "public-storage-observation" },
      },
    });
    expect(finalPiStorage.value.conversations).toEqual(
      originalPiStorage.value.conversations,
    );
    const finalPiEntries = JSON.stringify(finalPiStorage.value.entries);
    expect(finalPiEntries).toContain("Write continued-at-b.txt");
    expect(finalPiEntries).toContain("Write continued-at-c.txt");
    const finalContext = await call<{
      thread: {
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
      };
      runtime: { entries: unknown[] };
    }>(baseUrl, `/v1/threads/${sourceThread.value.threadId}/context`, {
      credential: owner,
    });
    expect(finalContext.value.thread).toMatchObject({
      target: secondRelocationRequest.destination,
      ownershipGeneration: 2,
    });
    expect(JSON.stringify(finalContext.value.runtime.entries)).toContain(
      "Write continued-at-b.txt",
    );
    expect(JSON.stringify(finalContext.value.runtime.entries)).toContain(
      "Write continued-at-c.txt",
    );

    const firstBundleBytes = await readOwnerBlob(
      baseUrl,
      owner,
      `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${checkpointStatus.value.manifestReference}`,
      checkpointStatus.value.manifestReference,
    );
    const secondBundleBytes = await readOwnerBlob(
      baseUrl,
      owner,
      `/v1/managed-work-checkpoints/${secondCapture.checkpointRequestId}/blobs/${secondCapture.checkpointStatus.manifestReference}`,
      secondCapture.checkpointStatus.manifestReference,
    );
    type Bundle = {
      profile: string;
      runtime: { requirements: string[] };
      workspace: {
        runtimeArtifact: {
          artifact: { reference: string };
          compatibilityRequirements: string[];
        };
        attachments: Array<{
          name: string;
          mediaType: string;
          blob: { reference: string };
        }>;
      };
    };
    const firstBundle = JSON.parse(
      new TextDecoder().decode(firstBundleBytes),
    ) as Bundle;
    const secondBundle = JSON.parse(
      new TextDecoder().decode(secondBundleBytes),
    ) as Bundle;
    expect(secondBundle.profile).toBe(firstBundle.profile);
    expect(secondBundle.runtime.requirements).toEqual(
      firstBundle.runtime.requirements,
    );
    expect(
      secondBundle.workspace.runtimeArtifact.compatibilityRequirements,
    ).toEqual(firstBundle.workspace.runtimeArtifact.compatibilityRequirements);
    const evidenceAttachment = secondBundle.workspace.attachments.find(
      (attachment) =>
        attachment.name === "factory-provenance.json" &&
        attachment.mediaType === "application/json",
    );
    expect(evidenceAttachment).toBeDefined();
    const evidenceBytes = await readOwnerBlob(
      baseUrl,
      owner,
      `/v1/managed-work-checkpoints/${secondCapture.checkpointRequestId}/blobs/${evidenceAttachment!.blob.reference}`,
      evidenceAttachment!.blob.reference,
    );
    const provenance = factoryProvenanceEvidenceSchema.parse(
      JSON.parse(new TextDecoder().decode(evidenceBytes)),
    );
    expect(provenance.commands).toHaveLength(2);
    expect(
      provenance.commands.map((command) => ({
        requestId: command.requestId,
        target: command.target,
        ownershipGeneration: command.ownershipGeneration,
      })),
    ).toEqual([
      {
        requestId: "request:cutover-a-before",
        target: {
          nodeId: sourceNodeIdentity.value.node.nodeId,
          workspaceId: workspaceA.value.workspaceId,
        },
        ownershipGeneration: 0,
      },
      {
        requestId: "request:cutover-a-after",
        target: destinationRequest.destination,
        ownershipGeneration: 1,
      },
    ]);
    const sourceCommand = provenance.commands.find(
      (command) => command.requestId === "request:cutover-a-before",
    );
    const continuedCommand = provenance.commands.find(
      (command) => command.requestId === "request:cutover-a-after",
    );
    expect(sourceCommand).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
      ownershipGeneration: 0,
      executionEffects: [
        expect.objectContaining({
          target: {
            nodeId: sourceNodeIdentity.value.node.nodeId,
            workspaceId: workspaceA.value.workspaceId,
          },
          ownershipGeneration: 0,
          status: "completed",
        }),
      ],
    });
    expect(continuedCommand).toMatchObject({
      target: destinationRequest.destination,
      ownershipGeneration: 1,
      executionEffects: [
        expect.objectContaining({
          target: destinationRequest.destination,
          ownershipGeneration: 1,
          status: "completed",
        }),
      ],
    });

    const sourceCEvidenceBeforeFault =
      await gitWorkspaceEvidence(workspaceCDirectory);
    const workspaceD = await workspace(
      "workspace:cutover-d",
      destinationNodeIdentity.value.node.nodeId,
    );
    expect(workspaceD.response.status).toBe(201);
    const workspaceDDirectory = join(directory, "workspace-d");
    await mkdir(workspaceDDirectory);
    await stopNode(destinationNode);
    let signalFaultCommit!: (
      command: WorkspaceRelocationActivationCommand,
    ) => void;
    const faultCommitEntered =
      new Promise<WorkspaceRelocationActivationCommand>((resolve) => {
        signalFaultCommit = resolve;
      });
    let releaseFaultReadiness!: () => void;
    const faultReadinessGate = new Promise<void>((resolve) => {
      releaseFaultReadiness = resolve;
    });
    releaseFaultReadinessGate = releaseFaultReadiness;
    const faultControllerBase = new HttpExecutionControllerConnector({
      controllerUrl: baseUrl,
      nodeId: destinationNodeIdentity.value.node.nodeId,
      credential: destinationNodeIdentity.value.credential,
    });
    const faultController = new Proxy(faultControllerBase, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        if (property === "reportWorkspaceRelocationActivationReadiness") {
          return async (readiness: Record<string, unknown>) => {
            const command =
              await target.reportWorkspaceRelocationActivationReadiness(
                readiness,
              );
            signalFaultCommit(structuredClone(command));
            await faultReadinessGate;
            return command;
          };
        }
        return member.bind(target);
      },
    }) as ExecutionControllerConnector;
    destinationNode = startNode(
      directory,
      destinationNodeIdentity.value.node.nodeId,
      destinationNodeIdentity.value.credential,
      [
        {
          workspaceId: workspaceB.value.workspaceId,
          directory: destinationWorkspace,
        },
        {
          workspaceId: workspaceD.value.workspaceId,
          directory: workspaceDDirectory,
        },
      ],
      baseUrl,
      faultController,
      30_000,
    );
    runners.push(destinationNode);
    await waitOnline(destinationNodeIdentity.value.node.nodeId);
    await until(async () =>
      hasWorkspaceReport(
        destinationNode.daemon,
        workspaceD.value.workspaceId,
        0,
        "active",
      ),
    );

    const faultCapture = await captureCurrentWorkspaceCheckpoint(
      baseUrl,
      owner,
      sourceThread.value.threadId,
      "cutover-c-to-d-uncertain",
    );
    expect(faultCapture.snapshotStatus).toMatchObject({
      status: "workspace-checkpoint-available",
      target: secondRelocationRequest.destination,
      ownershipGeneration: 2,
    });
    expect(faultCapture.checkpointStatus).toMatchObject({
      status: "available",
      target: secondRelocationRequest.destination,
      ownershipGeneration: 2,
    });
    const faultRelocationRequest = {
      contractVersion: 1,
      requestId: "relocation:cutover-c-to-d-uncertain",
      checkpointRequestId: faultCapture.checkpointRequestId,
      destination: {
        nodeId: destinationNodeIdentity.value.node.nodeId,
        workspaceId: workspaceD.value.workspaceId,
      },
    };
    const faultRelocation = await call<{
      relocationId: string;
      requestId: string;
      status: string;
      ownershipGeneration: number;
      destinationOwnershipGeneration: number;
    }>(baseUrl, relocationPath, {
      credential: owner,
      body: faultRelocationRequest,
    });
    expect(faultRelocation.response.status).toBe(202);
    expect(faultRelocation.value).toMatchObject({
      requestId: faultRelocationRequest.requestId,
      status: "queued",
      ownershipGeneration: 2,
      destinationOwnershipGeneration: 0,
    });
    const faultRelocationStatusPath = `/v1/workspace-relocations/${faultRelocationRequest.requestId}`;
    await until(async () => {
      const status = await call<{ status: string }>(
        baseUrl,
        faultRelocationStatusPath,
        { credential: owner },
      );
      return status.value.status === "prepared-inactive";
    });
    const faultPrepared = await call<{
      status: string;
      receiptSha256: string;
      ownershipGeneration: number;
      destinationOwnershipGeneration: number;
    }>(baseUrl, faultRelocationStatusPath, { credential: owner });
    expect(faultPrepared.value).toMatchObject({
      status: "prepared-inactive",
      ownershipGeneration: 2,
      destinationOwnershipGeneration: 0,
    });
    expect(faultPrepared.value.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await gitWorkspaceEvidence(workspaceDDirectory)).toEqual(
      sourceCEvidenceBeforeFault,
    );
    const faultIntent = await call<{ activation: { status: string } }>(
      baseUrl,
      `/v1/workspace-relocations/${faultRelocationRequest.requestId}/activation-intent`,
      { credential: owner, body: { contractVersion: 1 } },
    );
    expect(faultIntent.response.status).toBe(202);
    const committedFaultCommand = await faultCommitEntered;
    expect(committedFaultCommand).toMatchObject({
      relocationId: faultRelocation.value.relocationId,
      requestId: faultRelocationRequest.requestId,
      sourceOwnershipGeneration: 2,
      destinationOwnershipGeneration: 0,
      ownershipGeneration: 3,
      preparedReceiptSha256: faultPrepared.value.receiptSha256,
    });
    const faultCommitStatus = await call<{
      status: string;
      captureRequestId: string;
      checkpointRequestId: string;
      activation: {
        status: string;
        ownershipGeneration: number;
        preparedReceiptSha256: string;
        readinessReceiptSha256: string;
        activationReceiptSha256?: string;
      };
    }>(baseUrl, faultRelocationStatusPath, { credential: owner });
    expect(faultCommitStatus.value).toMatchObject({
      status: "prepared-inactive",
      captureRequestId: faultCapture.captureRequestId,
      checkpointRequestId: faultCapture.checkpointRequestId,
      activation: {
        status: "ownership-committed",
        ownershipGeneration: 3,
        preparedReceiptSha256: faultPrepared.value.receiptSha256,
        readinessReceiptSha256: committedFaultCommand.readinessReceiptSha256,
      },
    });
    expect(
      faultCommitStatus.value.activation.activationReceiptSha256,
    ).toBeUndefined();
    expect(
      hasWorkspaceReport(
        destinationNode.daemon,
        workspaceD.value.workspaceId,
        0,
        "fenced",
      ),
    ).toBe(true);
    const blockedFaultInput = await call<{ error: string }>(
      baseUrl,
      `/v1/threads/${sourceThread.value.threadId}/inputs`,
      {
        credential: owner,
        body: {
          requestId: "request:cutover-d-must-remain-blocked",
          text: "Do not admit this while the activation report is pending.",
        },
      },
    );
    expect(blockedFaultInput.response.status).toBe(409);
    const absentFaultInput = await call<{ error: string }>(
      baseUrl,
      "/v1/commands/request:cutover-d-must-remain-blocked",
      { credential: owner },
    );
    expect(absentFaultInput.response.status).toBe(404);
    const blockedFaultContext = await fetch(
      new URL(`/v1/threads/${sourceThread.value.threadId}/context`, baseUrl),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(blockedFaultContext.status).toBeGreaterThanOrEqual(400);
    await blockedFaultContext.body?.cancel();
    const blockedDestinationClaim = await call<{ job: unknown }>(
      baseUrl,
      `/v1/nodes/${destinationNodeIdentity.value.node.nodeId}/jobs/claim`,
      {
        credential: destinationNodeIdentity.value.credential,
        body: {
          contractVersion: 1,
          nodeId: destinationNodeIdentity.value.node.nodeId,
        },
      },
    );
    expect(blockedDestinationClaim.response.status).toBe(200);
    expect(blockedDestinationClaim.value.job).toBeNull();

    await writeFile(
      join(workspaceDDirectory, "tracked.txt"),
      "changed after Core committed the original activation command\n",
    );
    const changedDestinationEvidence =
      await gitWorkspaceEvidence(workspaceDDirectory);
    expect(changedDestinationEvidence).not.toEqual(sourceCEvidenceBeforeFault);
    const revokeDestinationCredential = await call(
      baseUrl,
      `/v1/credentials/${destinationNodeIdentity.value.credentialId}/revoke`,
      { credential: owner, body: {} },
    );
    expect(revokeDestinationCredential.response.status).toBe(200);
    const destinationLoopOutcome = destinationNode.loop.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    releaseFaultReadiness();
    releaseFaultReadinessGate = undefined;
    const failedDestinationLoop = await destinationLoopOutcome;
    expect(failedDestinationLoop.error).toMatchObject({
      message: "Controller rejected the configured node identity or credential",
    });
    const localUncertainReport =
      destinationNode.daemon.pendingWorkspaceRelocationActivationReports()[0]!;
    expect(localUncertainReport).toMatchObject({
      status: "uncertain",
      errorCode: "workspace_relocation_activation_unverified",
      command: committedFaultCommand,
    });
    await expect(stopNode(destinationNode)).rejects.toMatchObject({
      message: "Controller rejected the configured node identity or credential",
    });
    const sourceCJob = {
      ...sourceDirectJob,
      jobId: "job:cutover-c-must-stay-fenced-after-d-commit",
      target: secondRelocationRequest.destination,
      ownershipGeneration: 2,
    };
    await expect(
      sourceRunner.daemon.executeJob(sourceCJob),
    ).rejects.toMatchObject({
      code: "workspace_capture_active",
    });
    const xDuringUnreportedUncertainty = await writeThroughManagedPi(
      baseUrl,
      owner,
      unrelatedThread.value.threadId,
      "request:cutover-x-during-unreported-uncertainty",
      "call:cutover-x-during-unreported-uncertainty",
      "x-during-unreported-uncertainty.txt",
      "X remains available while the destination report is unauthorized\n",
    );
    expect(xDuringUnreportedUncertainty.value).toMatchObject({
      target: {
        nodeId: sourceNodeIdentity.value.node.nodeId,
        workspaceId: workspaceX.value.workspaceId,
      },
      ownershipGeneration: 0,
    });
    expect(
      await readFile(
        join(unrelatedWorkspace, "x-during-unreported-uncertainty.txt"),
        "utf8",
      ),
    ).toBe(
      "X remains available while the destination report is unauthorized\n",
    );

    await stopNode(sourceRunner);
    await reopenPersistedWorkerd();
    const coldFaultStatus = await call<{
      status: string;
      captureRequestId: string;
      checkpointRequestId: string;
      activation: {
        status: string;
        ownershipGeneration: number;
        preparedReceiptSha256: string;
        readinessReceiptSha256: string;
        activationReceiptSha256?: string;
      };
    }>(baseUrl, faultRelocationStatusPath, { credential: owner });
    expect(coldFaultStatus.value).toMatchObject({
      status: "prepared-inactive",
      captureRequestId: faultCapture.captureRequestId,
      checkpointRequestId: faultCapture.checkpointRequestId,
      activation: {
        status: "ownership-committed",
        ownershipGeneration: 3,
        preparedReceiptSha256: faultPrepared.value.receiptSha256,
        readinessReceiptSha256: committedFaultCommand.readinessReceiptSha256,
      },
    });
    expect(
      coldFaultStatus.value.activation.activationReceiptSha256,
    ).toBeUndefined();
    const coldBlockedContext = await fetch(
      new URL(`/v1/threads/${sourceThread.value.threadId}/context`, baseUrl),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(coldBlockedContext.status).toBeGreaterThanOrEqual(400);
    await coldBlockedContext.body?.cancel();

    const reopenedSourceDaemon = new ExecutionDaemon({
      databasePath: join(directory, "cutover-a.sqlite"),
      nodeId: sourceNodeIdentity.value.node.nodeId,
      nodeCredential: sourceNodeIdentity.value.credential,
      workspaces: [
        {
          workspaceId: workspaceA.value.workspaceId,
          directory: sourceWorkspace,
        },
        {
          workspaceId: workspaceX.value.workspaceId,
          directory: unrelatedWorkspace,
        },
        {
          workspaceId: workspaceC.value.workspaceId,
          directory: workspaceCDirectory,
        },
      ],
    });
    const reopenedFaultDestinationDaemon = new ExecutionDaemon({
      databasePath: join(directory, "cutover-b.sqlite"),
      nodeId: destinationNodeIdentity.value.node.nodeId,
      nodeCredential: destinationNodeIdentity.value.credential,
      workspaces: [
        {
          workspaceId: workspaceB.value.workspaceId,
          directory: destinationWorkspace,
        },
        {
          workspaceId: workspaceD.value.workspaceId,
          directory: workspaceDDirectory,
        },
      ],
    });
    try {
      await expect(
        reopenedSourceDaemon.executeJob({
          ...sourceDirectJob,
          jobId: "job:cutover-a-must-remain-capture-fenced-after-reopen",
        }),
      ).rejects.toMatchObject({ code: "workspace_capture_active" });
      await expect(
        reopenedSourceDaemon.executeJob({
          ...sourceDirectJob,
          jobId: "job:cutover-c-must-remain-capture-fenced-after-reopen",
          target: secondRelocationRequest.destination,
          ownershipGeneration: 2,
        }),
      ).rejects.toMatchObject({ code: "workspace_capture_active" });
      expect(
        hasWorkspaceReport(
          reopenedFaultDestinationDaemon,
          workspaceD.value.workspaceId,
          0,
          "fenced",
        ),
      ).toBe(true);
      expect(
        reopenedFaultDestinationDaemon.pendingWorkspaceRelocationActivationReports(),
      ).toEqual([localUncertainReport]);
      expect(await gitWorkspaceEvidence(workspaceDDirectory)).toEqual(
        changedDestinationEvidence,
      );
      const retriedUncertainReport =
        await reopenedFaultDestinationDaemon.activateWorkspaceRelocation(
          committedFaultCommand,
        );
      expect(retriedUncertainReport).toEqual(localUncertainReport);
      expect(
        reopenedFaultDestinationDaemon.pendingWorkspaceRelocationActivationReports(),
      ).toEqual([localUncertainReport]);
      expect(await gitWorkspaceEvidence(workspaceDDirectory)).toEqual(
        changedDestinationEvidence,
      );
    } finally {
      reopenedSourceDaemon.close();
      reopenedFaultDestinationDaemon.close();
    }
  }, 120_000);
});
