import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  type BlobTransport,
  type WorkspaceCheckpointManifest,
} from "@uzina/checkpoints";
import { portableWorkspaceBlobReferences } from "@uzina/checkpoints/portable";
import {
  executionCaptureControlSchema,
  executionJobSchema,
  executionRexLaunchRequestSchema,
  executionRegisterRequestSchema,
  type ExecutionCaptureControl,
  type ExecutionCaptureControlReport,
  type ExecutionJob,
  type ExecutionRegisterRequest,
} from "@uzina/contracts/execution";
import type { WorkspaceSnapshotClaim } from "@uzina/contracts/factory";
import {
  createLocalFactoryServer,
  type LocalFactoryServer,
} from "../src/factory/server";
import { ExecutionDaemon } from "../src/execution/daemon";
import { executionPayloadSha256 } from "../src/execution/payload";
import {
  ControllerProtocolError,
  HttpExecutionControllerConnector,
} from "../src/execution/connector";
import { ExecutionLoop } from "../src/execution/loop";

const bootstrapSecret = "private-controller-bootstrap-fixture";
const directories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let localFactory: LocalFactoryServer | undefined;
let executionDaemon: ExecutionDaemon | undefined;

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

function initializeDirtyGitWorkspace(directory: string): void {
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.name", "Snapshot fixture");
  git(directory, "config", "user.email", "snapshot@example.invalid");
  writeFileSync(join(directory, "tracked.txt"), "base\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-m", "base");
  writeFileSync(join(directory, "tracked.txt"), "staged state\n");
  git(directory, "add", "tracked.txt");
  writeFileSync(join(directory, "tracked.txt"), "working state\n");
  writeFileSync(
    join(directory, "binary-and-mode"),
    Buffer.from([0, 255, 4, 128]),
  );
  chmodSync(join(directory, "binary-and-mode"), 0o755);
}

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "uzina-execution-controller-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  executionDaemon?.close();
  executionDaemon = undefined;
  localFactory?.close();
  localFactory = undefined;
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function postJson<T>(
  baseUrl: string,
  path: string,
  credential: string,
  body: unknown,
): Promise<{ response: Response; value: T }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, value: (await response.json()) as T };
}

function waitFor(timeoutMs = 5_000) {
  const started = Date.now();
  return async (predicate: () => boolean | Promise<boolean>) => {
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for the authenticated execution loop");
  };
}

describe("authenticated Factory execution controller protocol", () => {
  test("keeps interrupted or corrupt cached workspace snapshots uncertain across reopen", async () => {
    const root = temporaryRoot();
    const cachedWorkspace = join(root, "cached-workspace");
    const interruptedWorkspace = join(root, "interrupted-workspace");
    mkdirSync(cachedWorkspace);
    mkdirSync(interruptedWorkspace);
    initializeDirtyGitWorkspace(cachedWorkspace);
    initializeDirtyGitWorkspace(interruptedWorkspace);
    const databasePath = join(root, "snapshot-recovery.sqlite");
    const cacheDirectory = join(root, "snapshot-cache");
    const nodeId = "node:snapshot-recovery";
    const workspaces = [
      { workspaceId: "workspace:cached", directory: cachedWorkspace },
      { workspaceId: "workspace:interrupted", directory: interruptedWorkspace },
    ];
    executionDaemon = new ExecutionDaemon({
      databasePath,
      snapshotCacheDirectory: cacheDirectory,
      nodeId,
      nodeCredential: "snapshot-recovery-credential",
      workspaces,
    });
    const makeControl = (
      label: string,
      workspaceId: string,
    ): ExecutionCaptureControl => {
      const payload = {
        contractVersion: 1 as const,
        controlId: `control:${label}`,
        captureId: `capture:${label}`,
        requestId: `request:${label}`,
        nodeId,
        target: { nodeId, workspaceId },
        ownershipGeneration: 0,
      };
      return executionCaptureControlSchema.parse({
        ...payload,
        payloadSha256: executionPayloadSha256(payload),
      });
    };
    const fenceSource = (control: ExecutionCaptureControl) => {
      const report = executionDaemon!.executeCaptureControl(control);
      expect(report.status).toBe("source-capture-fenced");
      executionDaemon!.markCaptureControlReported(control.controlId, report);
    };
    const cachedControl = makeControl("cached", "workspace:cached");
    fenceSource(cachedControl);
    const cachedClaim: WorkspaceSnapshotClaim = {
      contractVersion: 1,
      snapshotId: "workspace-snapshot:cached",
      requestId: "snapshot-request:cached",
      captureRequestId: cachedControl.requestId,
      captureId: cachedControl.captureId,
      nodeId,
      target: cachedControl.target,
      ownershipGeneration: 0,
    };
    let firstReference: string | undefined;
    await expect(
      executionDaemon.executeWorkspaceSnapshot(
        cachedClaim,
        async (_captureId, reference, stream) => {
          firstReference = reference;
          await stream.cancel("simulated upload interruption").catch(() => {});
          throw new Error("simulated_upload_interruption");
        },
      ),
    ).rejects.toThrow("simulated_upload_interruption");
    if (!firstReference)
      throw new Error("The first cached reference was not uploaded");
    const captureCacheDirectory = join(
      cacheDirectory,
      createHash("sha256").update(cachedClaim.captureId).digest("hex"),
    );
    writeFileSync(
      join(captureCacheDirectory, firstReference),
      Buffer.from([0xff]),
    );
    let retryUploads = 0;
    const corruptReport = await executionDaemon.executeWorkspaceSnapshot(
      cachedClaim,
      async () => {
        retryUploads += 1;
      },
    );
    expect(corruptReport).toMatchObject({
      status: "uncertain",
      errorCode: "snapshot_cache_missing_or_corrupt",
    });
    expect(retryUploads).toBe(0);

    const interruptedControl = makeControl(
      "interrupted",
      "workspace:interrupted",
    );
    fenceSource(interruptedControl);
    const interruptedClaim: WorkspaceSnapshotClaim = {
      contractVersion: 1,
      snapshotId: "workspace-snapshot:interrupted",
      requestId: "snapshot-request:interrupted",
      captureRequestId: interruptedControl.requestId,
      captureId: interruptedControl.captureId,
      nodeId,
      target: interruptedControl.target,
      ownershipGeneration: 0,
    };
    const database = new Database(databasePath);
    try {
      database
        .query(
          `INSERT INTO execution_workspace_snapshots(
            snapshot_id, request_id, capture_request_id, capture_id, node_id,
            workspace_id, ownership_generation, status, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'producing', ?)`,
        )
        .run(
          interruptedClaim.snapshotId,
          interruptedClaim.requestId,
          interruptedClaim.captureRequestId,
          interruptedClaim.captureId,
          interruptedClaim.nodeId,
          interruptedClaim.target.workspaceId,
          interruptedClaim.ownershipGeneration,
          new Date().toISOString(),
        );
    } finally {
      database.close();
    }
    const cacheBeforeRestart = readdirSync(cacheDirectory).sort();
    executionDaemon.close();
    executionDaemon = new ExecutionDaemon({
      databasePath,
      snapshotCacheDirectory: cacheDirectory,
      nodeId,
      nodeCredential: "snapshot-recovery-credential",
      workspaces,
    });
    let interruptedUploads = 0;
    const interruptedReport = await executionDaemon.executeWorkspaceSnapshot(
      interruptedClaim,
      async () => {
        interruptedUploads += 1;
      },
    );
    expect(interruptedReport).toMatchObject({
      status: "uncertain",
      errorCode: "snapshot_production_interrupted",
    });
    expect(interruptedUploads).toBe(0);
    expect(readdirSync(cacheDirectory).sort()).toEqual(cacheBeforeRestart);
    const cachedReportAfterRestart =
      await executionDaemon.executeWorkspaceSnapshot(cachedClaim, async () => {
        interruptedUploads += 1;
      });
    expect(cachedReportAfterRestart).toEqual(corruptReport);
    expect(interruptedUploads).toBe(0);
  });

  test("executes one durable file job, reconciles lost acknowledgements and reopens both stores", async () => {
    const root = temporaryRoot();
    const workspaceDirectory = join(root, "workspace");
    mkdirSync(workspaceDirectory);
    localFactory = createLocalFactoryServer({
      databasePath: join(root, "controller.sqlite"),
      bootstrapSecret,
      port: 0,
    });
    const controllerUrl = localFactory.server.url.toString();
    const bootstrapResponse = await fetch(
      new URL("/v1/bootstrap", controllerUrl),
      {
        method: "POST",
        headers: {
          authorization: "Bootstrap private-controller-bootstrap-fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Owner" }),
      },
    );
    expect(bootstrapResponse.status).toBe(201);
    const ownerCredential = (await bootstrapResponse.json()) as {
      credential: string;
    };
    const provisioned = await postJson<{
      node: { nodeId: string };
      credentialId: string;
      credential: string;
    }>(controllerUrl, "/v1/nodes", ownerCredential.credential, {
      nodeId: "node:test-laptop",
      name: "Temporary test executor",
    });
    expect(provisioned.response.status).toBe(201);
    const nodeCredential = provisioned.value.credential;
    const nodeId = provisioned.value.node.nodeId;
    const workspace = await postJson<{ workspaceId: string }>(
      controllerUrl,
      "/v1/workspaces",
      ownerCredential.credential,
      {
        workspaceId: "workspace:test-repo",
        nodeId,
        name: "Temporary checkout",
      },
    );
    expect(workspace.response.status).toBe(201);
    const workspaceId = workspace.value.workspaceId;

    const registration: ExecutionRegisterRequest =
      executionRegisterRequestSchema.parse({
        contractVersion: 1,
        nodeId,
        daemonVersion: "test",
        workspaces: [{ workspaceId, ownershipGeneration: 0, state: "active" }],
        capabilities: {
          fileRead: true,
          fileWrite: true,
          argvCommand: true,
          rexProcessCreate: true,
          rexProcessInspect: true,
          rexProcessStop: true,
        },
      });
    const offlineJob: ExecutionJob = executionJobSchema.parse({
      contractVersion: 1,
      jobId: "job:offline-check",
      nodeId,
      target: { nodeId, workspaceId },
      ownershipGeneration: 0,
      operation: "write-file",
      path: "outcome.txt",
      contentBase64: Buffer.from("first").toString("base64"),
    });
    await expect(
      localFactory.factory.enqueueRemoteExecution(offlineJob),
    ).rejects.toMatchObject({ status: 503, code: "node_offline" });
    await expect(
      localFactory.factory.enqueueRemoteExecution({
        ...offlineJob,
        ownershipGeneration: 1,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "stale_ownership_generation",
    });

    const unsupported = await postJson(
      controllerUrl,
      `/v1/nodes/${nodeId}/register`,
      nodeCredential,
      {
        ...registration,
        capabilities: { ...registration.capabilities, fileWrite: false },
      },
    );
    expect(unsupported.response.status).toBe(400);
    const unprovisionedWorkspace = await postJson(
      controllerUrl,
      `/v1/nodes/${nodeId}/register`,
      nodeCredential,
      {
        ...registration,
        workspaces: [
          {
            workspaceId: "workspace:unowned",
            ownershipGeneration: 0,
            state: "active",
          },
        ],
      },
    );
    expect(unprovisionedWorkspace.response.status).toBe(403);
    const staleWorkspace = await postJson(
      controllerUrl,
      `/v1/nodes/${nodeId}/register`,
      nodeCredential,
      {
        ...registration,
        workspaces: [{ workspaceId, ownershipGeneration: 1, state: "active" }],
      },
    );
    expect(staleWorkspace.response.status).toBe(409);
    const forgedPathIdentity = await postJson(
      controllerUrl,
      "/v1/nodes/node:other/register",
      nodeCredential,
      { ...registration, nodeId: "node:other" },
    );
    expect(forgedPathIdentity.response.status).toBe(403);
    const publicInjection = await postJson(
      controllerUrl,
      "/v1/execution/jobs",
      ownerCredential.credential,
      offlineJob,
    );
    expect(publicInjection.response.status).toBe(404);

    const nodeDatabasePath = join(root, "executor.sqlite");
    executionDaemon = new ExecutionDaemon({
      databasePath: nodeDatabasePath,
      nodeId,
      nodeCredential,
      workspaces: [{ workspaceId, directory: workspaceDirectory }],
      daemonVersion: "test",
    });

    let loseFirstClaimAcknowledgement = true;
    let loseFirstReportAcknowledgement = true;
    const deliveredJobIds: string[] = [];
    let reportCommittedResolve!: () => void;
    const reportCommitted = new Promise<void>((resolve) => {
      reportCommittedResolve = resolve;
    });
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const route = new URL(request.url).pathname;
        const requestBody =
          request.method === "GET" ? undefined : await request.text();
        const upstream = await fetch(
          new URL(`${route}${new URL(request.url).search}`, controllerUrl),
          {
            method: request.method,
            headers: request.headers,
            ...(requestBody === undefined ? {} : { body: requestBody }),
          },
        );
        if (route.endsWith("/jobs/claim")) {
          const result = (await upstream.clone().json()) as {
            job: ExecutionJob | null;
          };
          if (result.job) deliveredJobIds.push(result.job.jobId);
          if (result.job && loseFirstClaimAcknowledgement) {
            loseFirstClaimAcknowledgement = false;
            return Response.json(
              { error: "lost_claim_acknowledgement" },
              { status: 502 },
            );
          }
        }
        if (route.endsWith("/report") && loseFirstReportAcknowledgement) {
          const report = JSON.parse(requestBody ?? "{}") as { status?: string };
          if (report.status === "completed") {
            loseFirstReportAcknowledgement = false;
            reportCommittedResolve();
            return Response.json(
              { error: "lost_report_acknowledgement" },
              { status: 502 },
            );
          }
        }
        return upstream;
      },
    });
    servers.push(proxy);
    const connector = new HttpExecutionControllerConnector({
      controllerUrl: proxy.url.toString(),
      nodeId,
      credential: nodeCredential,
    });
    const abort = new AbortController();
    const loop = new ExecutionLoop({
      daemon: executionDaemon,
      controller: connector,
      pollIntervalMs: 100,
      heartbeatIntervalMs: 10_000,
    });
    const running = loop.run(abort.signal);
    const waitUntil = waitFor();
    await waitUntil(
      () =>
        localFactory!.database.all<{ node_id: string }>(
          "SELECT node_id FROM execution_node_state WHERE node_id = ?",
          [nodeId],
        ).length === 1,
    );

    writeFileSync(join(workspaceDirectory, "plain-file"), "not a directory");
    const missingFileJob: ExecutionJob = executionJobSchema.parse({
      contractVersion: 1,
      jobId: "job:missing-file",
      nodeId,
      target: { nodeId, workspaceId },
      ownershipGeneration: 0,
      operation: "read-file",
      path: "missing.txt",
      maxBytes: 64,
    });
    const intermediateFileJob: ExecutionJob = executionJobSchema.parse({
      contractVersion: 1,
      jobId: "job:intermediate-file",
      nodeId,
      target: { nodeId, workspaceId },
      ownershipGeneration: 0,
      operation: "read-file",
      path: "plain-file/child.txt",
      maxBytes: 64,
    });
    const excessivePathJob: ExecutionJob = executionJobSchema.parse({
      contractVersion: 1,
      jobId: "job:excessive-path-component",
      nodeId,
      target: { nodeId, workspaceId },
      ownershipGeneration: 0,
      operation: "read-file",
      path: `${"x".repeat(300)}/child.txt`,
      maxBytes: 64,
    });
    const preflightFailures = [
      { job: missingFileJob, errorCode: "workspace_path_not_found" },
      {
        job: intermediateFileJob,
        errorCode: "workspace_path_not_directory",
      },
      { job: excessivePathJob, errorCode: "workspace_path_too_long" },
    ];
    const job: ExecutionJob = executionJobSchema.parse({
      ...offlineJob,
      jobId: "job:write-workspace-file",
      contentBase64: Buffer.from(
        "performed by authenticated executor\n",
      ).toString("base64"),
    });
    for (const failure of preflightFailures) {
      expect(
        (await localFactory.factory.enqueueRemoteExecution(failure.job)).status,
      ).toBe("queued");
    }
    expect(
      (await localFactory.factory.enqueueRemoteExecution(job)).status,
    ).toBe("queued");
    let reportTimedOut: ReturnType<typeof setTimeout> | undefined;
    const completedReportArrived = await Promise.race([
      reportCommitted.then(() => true),
      new Promise<boolean>((resolve) => {
        reportTimedOut = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    if (reportTimedOut) clearTimeout(reportTimedOut);
    abort.abort();
    await running;
    expect(completedReportArrived).toBe(true);

    expect(readFileSync(join(workspaceDirectory, "outcome.txt"), "utf8")).toBe(
      "performed by authenticated executor\n",
    );
    expect(() =>
      readFileSync(join(workspaceDirectory, "missing.txt"), "utf8"),
    ).toThrow();
    const firstClaimedJobId = deliveredJobIds[0];
    expect(deliveredJobIds.slice(0, 2)).toEqual([
      firstClaimedJobId,
      firstClaimedJobId,
    ]);
    expect(
      preflightFailures.some(
        (failure) => failure.job.jobId === firstClaimedJobId,
      ),
    ).toBe(true);
    expect(deliveredJobIds.slice(2, -1).sort()).toEqual(
      preflightFailures
        .map((failure) => failure.job.jobId)
        .filter((jobId) => jobId !== firstClaimedJobId)
        .sort(),
    );
    expect(deliveredJobIds.at(-1)).toBe(job.jobId);
    for (const failure of preflightFailures) {
      expect(executionDaemon.getReceipt(failure.job.jobId)).toMatchObject({
        status: "failed",
        errorCode: failure.errorCode,
      });
    }
    expect(executionDaemon.getReceipt(job.jobId)?.status).toBe("completed");
    expect(
      executionDaemon.pendingReports().map((report) => report.jobId),
    ).toEqual([job.jobId]);

    executionDaemon.close();
    executionDaemon = undefined;
    localFactory.close();
    localFactory = undefined;
    localFactory = createLocalFactoryServer({
      databasePath: join(root, "controller.sqlite"),
      bootstrapSecret,
      port: 0,
    });
    executionDaemon = new ExecutionDaemon({
      databasePath: nodeDatabasePath,
      nodeId,
      nodeCredential,
      workspaces: [{ workspaceId, directory: workspaceDirectory }],
      daemonVersion: "test",
    });
    expect(executionDaemon.pendingReports()).toHaveLength(1);
    for (const failure of preflightFailures) {
      const receipt = executionDaemon.getReceipt(failure.job.jobId);
      if (!receipt) {
        throw new Error(`Receipt for ${failure.job.jobId} was not persisted`);
      }
      expect(receipt).toMatchObject({
        status: "failed",
        errorCode: failure.errorCode,
      });
      expect(await executionDaemon.executeJob(failure.job)).toEqual(receipt);
      expect(
        localFactory.factory.getRemoteExecutionReceipt(failure.job.jobId),
      ).toMatchObject({ status: "failed", errorCode: failure.errorCode });
    }

    const restartedConnector = new HttpExecutionControllerConnector({
      controllerUrl: localFactory.server.url.toString(),
      nodeId,
      credential: nodeCredential,
    });
    const durableReport = executionDaemon.pendingReports()[0]!;
    await expect(
      restartedConnector.report({
        ...durableReport,
        target: { nodeId, workspaceId: "workspace:other" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      restartedConnector.report({
        ...durableReport,
        ownershipGeneration: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      restartedConnector.report({
        ...durableReport,
        finishedAt: new Date(
          Date.parse(durableReport.finishedAt) + 1_000,
        ).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await restartedConnector.report(durableReport);
    await restartedConnector.report(durableReport);
    executionDaemon.markReported(job.jobId, durableReport.status);
    expect(executionDaemon.pendingReports()).toHaveLength(0);
    expect(
      localFactory.factory.getRemoteExecutionReceipt(job.jobId),
    ).toMatchObject({
      status: "completed",
      result: {
        operation: "write-file",
        bytes: Buffer.byteLength("performed by authenticated executor\n"),
      },
    });
    expect(
      localFactory.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM execution_job_claims WHERE job_id = ?",
        [missingFileJob.jobId],
      )[0]?.count,
    ).toBe(firstClaimedJobId === missingFileJob.jobId ? 2 : 1);
    expect(
      localFactory.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM execution_job_claims WHERE job_id = ?",
        [job.jobId],
      )[0]?.count,
    ).toBe(1);
    expect(
      localFactory.database.all<{ report_sha256: string; report_json: string }>(
        "SELECT report_sha256, report_json FROM execution_jobs WHERE job_id = ?",
        [job.jobId],
      )[0],
    ).toMatchObject({ report_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(
      (await localFactory.factory.enqueueRemoteExecution(missingFileJob))
        .status,
    ).toBe("failed");
    expect(await restartedConnector.claim()).toBeNull();
    expect(
      (await localFactory.factory.enqueueRemoteExecution(job)).status,
    ).toBe("completed");
    await expect(
      localFactory.factory.enqueueRemoteExecution({
        ...job,
        contentBase64: Buffer.from("different payload").toString("base64"),
      }),
    ).rejects.toMatchObject({ status: 409, code: "job_id_payload_conflict" });

    await localFactory.factory.revokeCredential(
      await localFactory.factory.authenticate(ownerCredential.credential),
      provisioned.value.credentialId,
    );
    const revokedNode = await postJson(
      localFactory.server.url.toString(),
      `/v1/nodes/${nodeId}/heartbeat`,
      nodeCredential,
      executionDaemon.heartbeatRequest(),
    );
    expect(revokedNode.response.status).toBe(401);
  });

  test("durably admits an owner capture control and reports a real held node fence", async () => {
    const root = temporaryRoot();
    const selectedDirectory = join(root, "selected");
    const unrelatedDirectory = join(root, "unrelated");
    const offlineDirectory = join(root, "offline");
    mkdirSync(selectedDirectory);
    mkdirSync(unrelatedDirectory);
    mkdirSync(offlineDirectory);
    initializeDirtyGitWorkspace(selectedDirectory);
    initializeDirtyGitWorkspace(unrelatedDirectory);
    writeFileSync(join(unrelatedDirectory, ".env"), "private fixture bytes\n");
    localFactory = createLocalFactoryServer({
      databasePath: join(root, "controller.sqlite"),
      bootstrapSecret,
      port: 0,
    });
    const controllerUrl = localFactory.server.url.toString();
    const bootstrap = await fetch(new URL("/v1/bootstrap", controllerUrl), {
      method: "POST",
      headers: {
        authorization: `Bootstrap ${bootstrapSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Capture owner" }),
    });
    const owner = (await bootstrap.json()) as { credential: string };
    const project = await postJson<{ projectId: string }>(
      controllerUrl,
      "/v1/projects",
      owner.credential,
      { projectId: "project:capture-control", name: "Capture control" },
    );
    const provisionNode = async (nodeId: string) =>
      postJson<{ node: { nodeId: string }; credential: string }>(
        controllerUrl,
        "/v1/nodes",
        owner.credential,
        { nodeId, name: nodeId },
      );
    const node = await provisionNode("node:capture-source");
    const unavailableNode = await provisionNode("node:capture-offline");
    const createWorkspace = async (workspaceId: string, nodeId: string) =>
      postJson<{ workspaceId: string }>(
        controllerUrl,
        "/v1/workspaces",
        owner.credential,
        { workspaceId, nodeId, name: workspaceId },
      );
    const selected = await createWorkspace(
      "workspace:capture-selected",
      node.value.node.nodeId,
    );
    const unrelated = await createWorkspace(
      "workspace:capture-unrelated",
      node.value.node.nodeId,
    );
    const offlineWorkspace = await createWorkspace(
      "workspace:capture-offline",
      unavailableNode.value.node.nodeId,
    );
    const createThread = async (
      threadId: string,
      nodeId: string,
      workspaceId: string,
    ) =>
      postJson<{ threadId: string }>(
        controllerUrl,
        "/v1/threads",
        owner.credential,
        {
          threadId,
          projectId: project.value.projectId,
          title: threadId,
          target: { nodeId, workspaceId },
        },
      );
    const selectedThread = await createThread(
      "thread:capture-selected",
      node.value.node.nodeId,
      selected.value.workspaceId,
    );
    const offlineThread = await createThread(
      "thread:capture-offline",
      unavailableNode.value.node.nodeId,
      offlineWorkspace.value.workspaceId,
    );

    let blockedDaemon: ExecutionDaemon | undefined;
    let loseAcceptanceAcknowledgement = true;
    let loseClaimAcknowledgement = true;
    let loseReportAcknowledgement = true;
    let loseSnapshotAdmissionAcknowledgement = true;
    let loseSnapshotClaimAcknowledgement = true;
    let loseSnapshotUploadAcknowledgement = true;
    let loseSnapshotReportAcknowledgement = true;
    let snapshotBlobUploadCount = 0;
    let snapshotClaimRequestCount = 0;
    const claimedControlIds: string[] = [];
    const claimedControls: ExecutionCaptureControl[] = [];
    const receivedReports: string[] = [];
    const reportBodies: ExecutionCaptureControlReport[] = [];
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const streamingUpload = /\/captures\/[^/]+\/blobs\//.test(path);
        const requestBody =
          request.method === "GET" || streamingUpload
            ? undefined
            : await request.text();
        const upstream = await fetch(new URL(path, controllerUrl), {
          method: request.method,
          headers: request.headers,
          ...(streamingUpload
            ? { body: request.body, duplex: "half" }
            : requestBody === undefined
              ? {}
              : { body: requestBody }),
        } as RequestInit & { duplex?: "half" });
        if (
          path === "/v1/workspace-snapshots" &&
          requestBody?.includes('"snapshot:workspace-only"') &&
          loseSnapshotAdmissionAcknowledgement
        ) {
          loseSnapshotAdmissionAcknowledgement = false;
          return new Response("lost snapshot admission acknowledgement", {
            status: 502,
          });
        }
        if (streamingUpload && upstream.ok) {
          snapshotBlobUploadCount += 1;
          if (loseSnapshotUploadAcknowledgement) {
            loseSnapshotUploadAcknowledgement = false;
            return new Response("lost immutable upload acknowledgement", {
              status: 502,
            });
          }
        }
        if (path.endsWith("/workspace-snapshots/claim"))
          snapshotClaimRequestCount += 1;
        if (
          path.endsWith("/workspace-snapshots/claim") &&
          loseSnapshotClaimAcknowledgement
        ) {
          const claimed = (await upstream.clone().json()) as {
            snapshot: unknown;
          };
          if (claimed.snapshot) {
            loseSnapshotClaimAcknowledgement = false;
            return new Response("lost snapshot claim acknowledgement", {
              status: 502,
            });
          }
        }
        if (
          path.includes("/workspace-snapshots/") &&
          path.endsWith("/report") &&
          loseSnapshotReportAcknowledgement &&
          upstream.ok
        ) {
          loseSnapshotReportAcknowledgement = false;
          return new Response("lost snapshot report acknowledgement", {
            status: 502,
          });
        }
        if (
          path ===
            `/v1/threads/${selectedThread.value.threadId}/capture-controls` &&
          loseAcceptanceAcknowledgement
        ) {
          loseAcceptanceAcknowledgement = false;
          return new Response("lost owner acknowledgement", { status: 502 });
        }
        if (path.endsWith("/capture-controls/claim")) {
          const value = (await upstream.clone().json()) as {
            control: ExecutionCaptureControl | null;
          };
          if (value.control) {
            claimedControlIds.push(value.control.controlId);
            claimedControls.push(value.control);
            if (loseClaimAcknowledgement) {
              loseClaimAcknowledgement = false;
              return new Response("lost claim acknowledgement", {
                status: 502,
              });
            }
          }
        }
        if (
          path.includes("/capture-controls/") &&
          path.endsWith("/report") &&
          requestBody
        ) {
          const value = JSON.parse(
            requestBody,
          ) as ExecutionCaptureControlReport;
          if (value.controlId) receivedReports.push(value.controlId);
          reportBodies.push(value);
          if (
            value.status === "source-capture-fenced" &&
            loseReportAcknowledgement
          ) {
            loseReportAcknowledgement = false;
            return new Response("lost report acknowledgement", {
              status: 502,
            });
          }
        }
        return upstream;
      },
    });
    servers.push(proxy);
    const nodeId = node.value.node.nodeId;
    const nodeCredential = node.value.credential;
    const nodeDatabasePath = join(root, "executor.sqlite");
    executionDaemon = new ExecutionDaemon({
      databasePath: nodeDatabasePath,
      nodeId,
      nodeCredential,
      workspaces: [
        {
          workspaceId: selected.value.workspaceId,
          directory: selectedDirectory,
        },
        {
          workspaceId: unrelated.value.workspaceId,
          directory: unrelatedDirectory,
        },
      ],
      daemonVersion: "capture-control-test",
    });
    const sourceDaemon = executionDaemon;
    if (!sourceDaemon)
      throw new Error("The capture source daemon did not open");
    const connector = new HttpExecutionControllerConnector({
      controllerUrl: proxy.url.toString(),
      nodeId,
      credential: nodeCredential,
    });
    const abort = new AbortController();
    const loop = new ExecutionLoop({
      daemon: executionDaemon,
      controller: connector,
      pollIntervalMs: 20,
      heartbeatIntervalMs: 100,
    });
    const running = loop.run(abort.signal);
    const waitUntil = waitFor(10_000);
    try {
      await waitUntil(
        () =>
          localFactory!.database.all<{ node_id: string }>(
            "SELECT node_id FROM execution_node_state WHERE node_id = ?",
            [nodeId],
          ).length === 1,
      );
      const requestUrl = new URL(
        `/v1/threads/${selectedThread.value.threadId}/capture-controls`,
        proxy.url,
      );
      const requestBody = JSON.stringify({
        contractVersion: 1,
        requestId: "request:stable-capture-control",
      });
      const lostAcceptance = await fetch(requestUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.credential}`,
          "content-type": "application/json",
        },
        body: requestBody,
      });
      expect(lostAcceptance.status).toBe(502);
      const acceptedResponse = await fetch(requestUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.credential}`,
          "content-type": "application/json",
        },
        body: requestBody,
      });
      expect(acceptedResponse.status).toBe(202);
      const accepted = (await acceptedResponse.json()) as {
        requestId: string;
        controlId: string;
        captureId: string;
        status: string;
        ownershipGeneration: number;
      };
      expect(accepted).toMatchObject({
        requestId: "request:stable-capture-control",
        ownershipGeneration: 0,
      });
      expect(["queued", "claimed"]).toContain(accepted.status);
      const duplicate = await fetch(requestUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.credential}`,
          "content-type": "application/json",
        },
        body: requestBody,
      });
      const duplicateValue = (await duplicate.json()) as {
        controlId: string;
        captureId: string;
        status: string;
      };
      expect(duplicateValue).toMatchObject({
        controlId: accepted.controlId,
        captureId: accepted.captureId,
      });
      expect(["queued", "claimed"]).toContain(duplicateValue.status);
      expect(
        (
          await postJson(
            proxy.url.toString(),
            `/v1/threads/${offlineThread.value.threadId}/capture-controls`,
            owner.credential,
            {
              contractVersion: 1,
              requestId: "request:stable-capture-control",
            },
          )
        ).response.status,
      ).toBe(409);
      const unavailableAdmission = await postJson<{
        controlId: string;
        captureId: string;
        status: string;
      }>(
        proxy.url.toString(),
        `/v1/threads/${offlineThread.value.threadId}/capture-controls`,
        owner.credential,
        { contractVersion: 1, requestId: "request:offline-capture-control" },
      );
      expect(unavailableAdmission.value.status).toBe("queued");
      const unavailableClaim = await postJson<{ control: unknown }>(
        proxy.url.toString(),
        `/v1/nodes/${unavailableNode.value.node.nodeId}/capture-controls/claim`,
        unavailableNode.value.credential,
        { contractVersion: 1, nodeId: unavailableNode.value.node.nodeId },
      );
      expect(unavailableClaim.value.control).toBeNull();

      const selectedInput = await postJson(
        proxy.url.toString(),
        `/v1/threads/${selectedThread.value.threadId}/inputs`,
        owner.credential,
        { requestId: "request:capture-must-block-input", text: "no dispatch" },
      );
      expect(selectedInput.response.status).toBe(409);

      const wrongCredential = await postJson(
        proxy.url.toString(),
        `/v1/nodes/${nodeId}/capture-controls/claim`,
        "not-the-node-credential",
        { contractVersion: 1, nodeId },
      );
      expect(wrongCredential.response.status).toBe(401);
      const wrongNode = await postJson(
        proxy.url.toString(),
        "/v1/nodes/node:other/capture-controls/claim",
        nodeCredential,
        { contractVersion: 1, nodeId: "node:other" },
      );
      expect(wrongNode.response.status).toBe(403);
      const nodeCannotAdmit = await postJson(
        proxy.url.toString(),
        `/v1/threads/${selectedThread.value.threadId}/capture-controls`,
        nodeCredential,
        { contractVersion: 1, requestId: "request:node-must-not-admit" },
      );
      expect(nodeCannotAdmit.response.status).toBe(403);

      const sourceStatusUrl = new URL(
        "/v1/capture-controls/request:stable-capture-control",
        proxy.url,
      );
      await waitUntil(async () => {
        const response = await fetch(sourceStatusUrl, {
          headers: { authorization: `Bearer ${owner.credential}` },
        });
        const value = (await response.json()) as { status: string };
        return value.status === "source-capture-fenced";
      });
      await waitUntil(
        () => executionDaemon!.pendingCaptureControlReports().length === 0,
      );
      expect(loseClaimAcknowledgement).toBe(false);
      expect(loseReportAcknowledgement).toBe(false);
      expect(loseAcceptanceAcknowledgement).toBe(false);
      expect(claimedControlIds.length).toBeGreaterThanOrEqual(2);
      expect(new Set(claimedControlIds)).toEqual(new Set([accepted.controlId]));
      expect(
        receivedReports.filter((id) => id === accepted.controlId).length,
      ).toBeGreaterThanOrEqual(2);

      const statusResponse = await fetch(sourceStatusUrl, {
        headers: { authorization: `Bearer ${owner.credential}` },
      });
      const sourceStatus = (await statusResponse.json()) as {
        status: string;
        sourceFence?: { receiptSha256: string };
      };
      expect(sourceStatus.status).toBe("source-capture-fenced");
      expect(sourceStatus.sourceFence?.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(sourceStatus).not.toHaveProperty("manifestReference");
      expect(executionDaemon.pendingCaptureControlReports()).toEqual([]);
      const validReport = reportBodies[0];
      expect(validReport).toBeDefined();
      const reportRoute = `/v1/nodes/${nodeId}/capture-controls/${accepted.controlId}/report`;
      const invalidReports = [
        { ...validReport, captureId: "capture:stale-control" },
        { ...validReport, requestId: "request:stale-control" },
        {
          ...validReport,
          target: { nodeId, workspaceId: "workspace:wrong-capture-report" },
        },
        { ...validReport, ownershipGeneration: 1 },
        { ...validReport, payloadSha256: "0".repeat(64) },
      ];
      for (const invalidReport of invalidReports) {
        expect(
          (
            await postJson(
              controllerUrl,
              reportRoute,
              nodeCredential,
              invalidReport,
            )
          ).response.status,
        ).toBe(409);
      }
      const unavailableSnapshot = await postJson(
        proxy.url.toString(),
        "/v1/workspace-snapshots",
        owner.credential,
        {
          contractVersion: 1,
          requestId: "snapshot:source-offline",
          captureRequestId: "request:offline-capture-control",
        },
      );
      expect(unavailableSnapshot.response.status).toBe(409);
      const snapshotRequest = {
        contractVersion: 1,
        requestId: "snapshot:workspace-only",
        captureRequestId: accepted.requestId,
      };
      const lostSnapshotAdmission = await fetch(
        new URL("/v1/workspace-snapshots", proxy.url),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(snapshotRequest),
        },
      );
      expect(lostSnapshotAdmission.status).toBe(502);
      const acceptedSnapshotResponse = await fetch(
        new URL("/v1/workspace-snapshots", proxy.url),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(snapshotRequest),
        },
      );
      expect(acceptedSnapshotResponse.status).toBe(202);
      const acceptedSnapshot = (await acceptedSnapshotResponse.json()) as {
        requestId: string;
        captureId: string;
        status: string;
        snapshotId: string;
      };
      const duplicateSnapshot = await postJson<{
        requestId: string;
        captureId: string;
        status: string;
        snapshotId: string;
      }>(
        proxy.url.toString(),
        "/v1/workspace-snapshots",
        owner.credential,
        snapshotRequest,
      );
      expect(duplicateSnapshot.value).toMatchObject({
        requestId: acceptedSnapshot.requestId,
        captureId: acceptedSnapshot.captureId,
        snapshotId: acceptedSnapshot.snapshotId,
      });
      expect(acceptedSnapshot.captureId).toBe(accepted.captureId);
      expect(acceptedSnapshot.snapshotId).toBeTruthy();
      const secondSnapshotForCapture = await postJson(
        proxy.url.toString(),
        "/v1/workspace-snapshots",
        owner.credential,
        {
          contractVersion: 1,
          requestId: "snapshot:second-for-same-capture",
          captureRequestId: accepted.requestId,
        },
      );
      expect(secondSnapshotForCapture.response.status).toBe(409);
      const snapshotStatusUrl = new URL(
        `/v1/workspace-snapshots/${acceptedSnapshot.requestId}`,
        proxy.url,
      );
      await waitUntil(async () => {
        const response = await fetch(snapshotStatusUrl, {
          headers: { authorization: `Bearer ${owner.credential}` },
        });
        if (!response.ok) return false;
        const value = (await response.json()) as { status: string };
        return value.status === "workspace-checkpoint-available";
      });
      const availableSnapshotResponse = await fetch(snapshotStatusUrl, {
        headers: { authorization: `Bearer ${owner.credential}` },
      });
      const availableSnapshot = (await availableSnapshotResponse.json()) as {
        status: string;
        manifestReference: string;
      };
      expect(availableSnapshot).toMatchObject({
        status: "workspace-checkpoint-available",
      });
      expect(loseSnapshotAdmissionAcknowledgement).toBe(false);
      expect(loseSnapshotClaimAcknowledgement).toBe(false);
      expect(loseSnapshotUploadAcknowledgement).toBe(false);
      expect(loseSnapshotReportAcknowledgement).toBe(false);
      expect(snapshotClaimRequestCount).toBeGreaterThan(1);
      expect(snapshotBlobUploadCount).toBeGreaterThan(1);
      await waitUntil(
        () => executionDaemon!.pendingWorkspaceSnapshotReports().length === 0,
      );
      expect(executionDaemon.pendingWorkspaceSnapshotReports()).toEqual([]);
      const download = async (reference: string): Promise<Uint8Array> => {
        const response = await fetch(
          new URL(
            `/v1/workspace-snapshots/${acceptedSnapshot.requestId}/blobs/${reference}`,
            controllerUrl,
          ),
          { headers: { authorization: `Bearer ${owner.credential}` } },
        );
        if (!response.ok)
          throw new Error(
            `checkpoint blob download failed: ${response.status}`,
          );
        return new Uint8Array(await response.arrayBuffer());
      };
      const manifestBytes = await download(availableSnapshot.manifestReference);
      const manifest = JSON.parse(
        new TextDecoder().decode(manifestBytes),
      ) as WorkspaceCheckpointManifest;
      expect(manifest.runtimeArtifact).toBeNull();
      expect(manifest.attachments).toEqual([]);
      const restoreTransport: BlobTransport = {
        async putBlob() {
          throw new Error("owner download transport is read-only");
        },
        getBlob: download,
      };
      const preparedDirectory = join(root, "prepared-workspace");
      mkdirSync(preparedDirectory);
      await restoreWorkspaceCheckpoint({
        manifest,
        transport: restoreTransport,
        destinationPath: preparedDirectory,
      });
      expect(git(preparedDirectory, "show", ":tracked.txt")).toBe(
        "staged state\n",
      );
      expect(readFileSync(join(preparedDirectory, "tracked.txt"), "utf8")).toBe(
        "working state\n",
      );
      expect(readFileSync(join(preparedDirectory, "binary-and-mode"))).toEqual(
        Buffer.from([0, 255, 4, 128]),
      );
      expect(
        statSync(join(preparedDirectory, "binary-and-mode")).mode & 0o111,
      ).toBe(0o111);
      expect(git(preparedDirectory, "status", "--porcelain").trim()).toBe(
        "MM tracked.txt\n?? binary-and-mode",
      );
      const foreignReferenceResponse = await fetch(
        new URL(
          `/v1/workspace-snapshots/snapshot:foreign/blobs/${availableSnapshot.manifestReference}`,
          controllerUrl,
        ),
        { headers: { authorization: `Bearer ${owner.credential}` } },
      );
      expect(foreignReferenceResponse.status).toBe(404);
      const wrongNodeUpload = await fetch(
        new URL(
          `/v1/nodes/${unavailableNode.value.node.nodeId}/captures/${accepted.captureId}/blobs/${"f".repeat(64)}`,
          controllerUrl,
        ),
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${unavailableNode.value.credential}`,
            "content-type": "application/octet-stream",
          },
          body: new Uint8Array([1]),
        },
      );
      expect(wrongNodeUpload.status).toBe(404);
      const ownerSession = await localFactory.factory.authenticate(
        owner.credential,
      );
      let controllerFenceCleanupError: unknown;
      try {
        localFactory.factory.endManagedWorkCapture(
          ownerSession,
          accepted.captureId,
        );
      } catch (error) {
        controllerFenceCleanupError = error;
      }
      expect(controllerFenceCleanupError).toMatchObject({
        code: "capture_control_fence_held",
        status: 409,
      });

      const selectedFileJob: ExecutionJob = executionJobSchema.parse({
        contractVersion: 1,
        jobId: "job:capture-selected-file-denied",
        nodeId,
        target: { nodeId, workspaceId: selected.value.workspaceId },
        ownershipGeneration: 0,
        operation: "write-file",
        path: "must-not-write.txt",
        contentBase64: Buffer.from("blocked").toString("base64"),
      });
      const selectedArgvJob: ExecutionJob = executionJobSchema.parse({
        contractVersion: 1,
        jobId: "job:capture-selected-argv-denied",
        nodeId,
        target: { nodeId, workspaceId: selected.value.workspaceId },
        ownershipGeneration: 0,
        operation: "argv-command",
        argv: [process.execPath, "-e", "process.exit(7)"],
        timeoutMs: 1_000,
        maxOutputBytes: 64,
      });
      await expect(sourceDaemon.executeJob(selectedFileJob)).rejects.toThrow(
        "workspace_capture_active",
      );
      await expect(sourceDaemon.executeJob(selectedArgvJob)).rejects.toThrow(
        "workspace_capture_active",
      );
      await expect(
        sourceDaemon.rex.launch(
          executionRexLaunchRequestSchema.parse({
            contractVersion: 1,
            processId: "process:capture-selected-rex-denied",
            nodeId,
            target: { nodeId, workspaceId: selected.value.workspaceId },
            ownershipGeneration: 0,
            argv: ["true"],
          }),
        ),
      ).rejects.toThrow("workspace_capture_active");
      expect(() =>
        sourceDaemon.endWorkspaceCapture(accepted.captureId),
      ).toThrow("capture_control_fence_held");

      const unrelatedJob: ExecutionJob = executionJobSchema.parse({
        contractVersion: 1,
        jobId: "job:capture-unrelated-still-admitted",
        nodeId,
        target: { nodeId, workspaceId: unrelated.value.workspaceId },
        ownershipGeneration: 0,
        operation: "write-file",
        path: "unrelated.txt",
        contentBase64: Buffer.from("unrelated admitted\n").toString("base64"),
      });
      expect(
        (await localFactory.factory.enqueueRemoteExecution(unrelatedJob))
          .status,
      ).toBe("queued");
      await waitUntil(
        async () =>
          localFactory!.factory.getRemoteExecutionReceipt(unrelatedJob.jobId)
            ?.status === "completed",
      );
      expect(
        readFileSync(join(unrelatedDirectory, "unrelated.txt"), "utf8"),
      ).toBe("unrelated admitted\n");

      blockedDaemon = new ExecutionDaemon({
        databasePath: join(root, "offline-executor.sqlite"),
        nodeId: unavailableNode.value.node.nodeId,
        nodeCredential: unavailableNode.value.credential,
        workspaces: [
          {
            workspaceId: offlineWorkspace.value.workspaceId,
            directory: offlineDirectory,
          },
        ],
        daemonVersion: "capture-control-offline-test",
      });
      const blockedConnector = new HttpExecutionControllerConnector({
        controllerUrl,
        nodeId: unavailableNode.value.node.nodeId,
        credential: unavailableNode.value.credential,
      });
      await blockedConnector.register(blockedDaemon.registerRequest());
      const activeSourceEffect: ExecutionJob = executionJobSchema.parse({
        contractVersion: 1,
        jobId: "job:capture-offline-source-active",
        nodeId: unavailableNode.value.node.nodeId,
        target: {
          nodeId: unavailableNode.value.node.nodeId,
          workspaceId: offlineWorkspace.value.workspaceId,
        },
        ownershipGeneration: 0,
        operation: "argv-command",
        argv: [process.execPath, "-e", "await Bun.sleep(250)"],
        timeoutMs: 2_000,
        maxOutputBytes: 64,
      });
      const activeSourceEffectResult =
        blockedDaemon.executeJob(activeSourceEffect);
      expect(blockedDaemon.getReceipt(activeSourceEffect.jobId)?.status).toBe(
        "running",
      );
      const offlineControl = await blockedConnector.claimCaptureControl();
      expect(offlineControl).toMatchObject({
        requestId: "request:offline-capture-control",
        captureId: unavailableAdmission.value.captureId,
      });
      if (!offlineControl)
        throw new Error("Expected the queued offline control");
      const blockedReport = blockedDaemon.executeCaptureControl(offlineControl);
      expect(blockedReport).toMatchObject({
        status: "blocked",
        errorCode: "workspace_has_unsettled_effects",
      });
      await blockedConnector.reportCaptureControl(blockedReport);
      blockedDaemon.markCaptureControlReported(
        blockedReport.controlId,
        blockedReport,
      );
      const blockedStatusResponse = await fetch(
        new URL(
          "/v1/capture-controls/request:offline-capture-control",
          controllerUrl,
        ),
        { headers: { authorization: `Bearer ${owner.credential}` } },
      );
      const blockedStatus = (await blockedStatusResponse.json()) as {
        status: string;
        errorCode?: string;
        sourceFence?: unknown;
      };
      expect(blockedStatus).toMatchObject({
        status: "blocked",
        errorCode: "workspace_has_unsettled_effects",
      });
      expect(blockedStatus.sourceFence).toBeUndefined();
      expect(await activeSourceEffectResult).toMatchObject({
        status: "completed",
      });
      expect(blockedDaemon.executeCaptureControl(offlineControl)).toEqual(
        blockedReport,
      );
      expect(
        (
          await postJson(
            controllerUrl,
            `/v1/threads/${offlineThread.value.threadId}/inputs`,
            owner.credential,
            {
              requestId: "request:blocked-control-still-holds-core-fence",
              text: "still blocked",
            },
          )
        ).response.status,
      ).toBe(409);
      blockedDaemon.close();
      blockedDaemon = undefined;

      const workspaceReports = sourceDaemon.heartbeatRequest().workspaces;
      expect(
        workspaceReports.map((report) => String(report.workspaceId)),
      ).toEqual([
        String(selected.value.workspaceId),
        String(unrelated.value.workspaceId),
      ]);
      expect(
        workspaceReports.map((report) => report.ownershipGeneration),
      ).toEqual([0, 0]);
      expect(workspaceReports.map((report) => report.state)).toEqual([
        "active",
        "active",
      ]);
      abort.abort();
      await running;

      const persistedSourceReport =
        sourceDaemon.pendingCaptureControlReports()[0];
      expect(persistedSourceReport).toBeUndefined();
      sourceDaemon.close();
      executionDaemon = undefined;
      localFactory.close();
      localFactory = undefined;
      localFactory = createLocalFactoryServer({
        databasePath: join(root, "controller.sqlite"),
        bootstrapSecret,
        port: 0,
      });
      executionDaemon = new ExecutionDaemon({
        databasePath: nodeDatabasePath,
        nodeId,
        nodeCredential,
        workspaces: [
          {
            workspaceId: selected.value.workspaceId,
            directory: selectedDirectory,
          },
          {
            workspaceId: unrelated.value.workspaceId,
            directory: unrelatedDirectory,
          },
        ],
        daemonVersion: "capture-control-test",
      });
      const reopenedDaemon = executionDaemon;
      if (!reopenedDaemon)
        throw new Error("The reopened node daemon is absent");
      const restartedControllerUrl = localFactory.server.url.toString();
      const restartedConnector = new HttpExecutionControllerConnector({
        controllerUrl: restartedControllerUrl,
        nodeId,
        credential: nodeCredential,
      });
      await restartedConnector.register(reopenedDaemon.registerRequest());
      const durableReport = reopenedDaemon.pendingCaptureControlReports()[0];
      expect(durableReport).toBeUndefined();
      const statusAfterReopenResponse = await fetch(
        new URL(
          `/v1/capture-controls/${accepted.requestId}`,
          restartedControllerUrl,
        ),
        { headers: { authorization: `Bearer ${owner.credential}` } },
      );
      const statusAfterReopen = (await statusAfterReopenResponse.json()) as {
        controlId: string;
        captureId: string;
        status: string;
        ownershipGeneration: number;
      };
      expect(statusAfterReopen).toMatchObject({
        controlId: accepted.controlId,
        captureId: accepted.captureId,
        status: "source-capture-fenced",
        ownershipGeneration: 0,
      });
      const replayedAcceptance = await postJson<{
        controlId: string;
        captureId: string;
        status: string;
      }>(
        restartedControllerUrl,
        `/v1/threads/${selectedThread.value.threadId}/capture-controls`,
        owner.credential,
        { contractVersion: 1, requestId: accepted.requestId },
      );
      expect(replayedAcceptance.response.status).toBe(202);
      expect(replayedAcceptance.value).toMatchObject({
        controlId: accepted.controlId,
        captureId: accepted.captureId,
        status: "source-capture-fenced",
      });
      expect(() =>
        reopenedDaemon.endWorkspaceCapture(accepted.captureId),
      ).toThrow("capture_control_fence_held");
      expect(claimedControls[0]).toBeDefined();
      expect(
        reopenedDaemon.executeCaptureControl(claimedControls[0]),
      ).toMatchObject({ status: "source-capture-fenced" });
      await restartedConnector.reportCaptureControl(reportBodies[0]);
      const snapshotStatusAfterReopen = await fetch(
        new URL(
          `/v1/workspace-snapshots/${acceptedSnapshot.requestId}`,
          restartedControllerUrl,
        ),
        { headers: { authorization: `Bearer ${owner.credential}` } },
      );
      const durableSnapshot = (await snapshotStatusAfterReopen.json()) as {
        status: string;
        snapshotId: string;
        captureId: string;
        manifestReference: string;
      };
      expect(durableSnapshot).toMatchObject({
        status: "workspace-checkpoint-available",
        snapshotId: acceptedSnapshot.snapshotId,
        captureId: accepted.captureId,
        manifestReference: availableSnapshot.manifestReference,
      });
      const replayedSnapshotReport =
        await reopenedDaemon.executeWorkspaceSnapshot(
          {
            contractVersion: 1,
            snapshotId: acceptedSnapshot.snapshotId,
            requestId: acceptedSnapshot.requestId,
            captureRequestId: accepted.requestId,
            captureId: accepted.captureId,
            nodeId,
            target: { nodeId, workspaceId: selected.value.workspaceId },
            ownershipGeneration: 0,
          },
          async () => {
            throw new Error(
              "A persisted snapshot must not re-upload after reopen",
            );
          },
        );
      expect(replayedSnapshotReport).toMatchObject({
        snapshotId: acceptedSnapshot.snapshotId,
        status: "workspace-checkpoint-available",
        manifestReference: availableSnapshot.manifestReference,
      });
      const reopenedManifestBytes = await fetch(
        new URL(
          `/v1/workspace-snapshots/${acceptedSnapshot.requestId}/blobs/${availableSnapshot.manifestReference}`,
          restartedControllerUrl,
        ),
        { headers: { authorization: `Bearer ${owner.credential}` } },
      );
      expect(reopenedManifestBytes.status).toBe(200);
      expect(Buffer.from(await reopenedManifestBytes.arrayBuffer())).toEqual(
        Buffer.from(manifestBytes),
      );

      const forgedPolicyThread = await postJson<{ threadId: string }>(
        restartedControllerUrl,
        "/v1/threads",
        owner.credential,
        {
          threadId: "thread:capture-forged-policy",
          projectId: project.value.projectId,
          title: "thread:capture-forged-policy",
          target: { nodeId, workspaceId: unrelated.value.workspaceId },
        },
      );
      const forgedPolicyControlAdmission = await postJson<{
        requestId: string;
        captureId: string;
      }>(
        restartedControllerUrl,
        `/v1/threads/${forgedPolicyThread.value.threadId}/capture-controls`,
        owner.credential,
        {
          contractVersion: 1,
          requestId: "request:capture-forged-policy",
        },
      );
      expect(forgedPolicyControlAdmission.response.status).toBe(202);
      const forgedPolicyControl =
        await restartedConnector.claimCaptureControl();
      expect(forgedPolicyControl).toMatchObject({
        requestId: forgedPolicyControlAdmission.value.requestId,
        captureId: forgedPolicyControlAdmission.value.captureId,
        target: { workspaceId: unrelated.value.workspaceId },
      });
      if (!forgedPolicyControl) {
        throw new Error(
          "Expected the authenticated forged-policy source control",
        );
      }
      const forgedPolicyFenceReport =
        reopenedDaemon.executeCaptureControl(forgedPolicyControl);
      expect(forgedPolicyFenceReport.status).toBe("source-capture-fenced");
      await restartedConnector.reportCaptureControl(forgedPolicyFenceReport);
      reopenedDaemon.markCaptureControlReported(
        forgedPolicyFenceReport.controlId,
        forgedPolicyFenceReport,
      );
      const forgedPolicySnapshotAdmission = await postJson<{
        requestId: string;
        snapshotId: string;
        captureId: string;
        status: string;
      }>(restartedControllerUrl, "/v1/workspace-snapshots", owner.credential, {
        contractVersion: 1,
        requestId: "snapshot:forged-private-path-policy",
        captureRequestId: forgedPolicyControl.requestId,
      });
      expect(forgedPolicySnapshotAdmission.response.status).toBe(202);
      const forgedPolicyClaim =
        await restartedConnector.claimWorkspaceSnapshot();
      expect(forgedPolicyClaim).toMatchObject({
        snapshotId: forgedPolicySnapshotAdmission.value.snapshotId,
        requestId: forgedPolicySnapshotAdmission.value.requestId,
        captureId: forgedPolicyControl.captureId,
        target: { workspaceId: unrelated.value.workspaceId },
      });
      if (!forgedPolicyClaim) {
        throw new Error("Expected the authenticated claimed snapshot");
      }

      const checkpointBytes = new Map<string, Uint8Array>();
      const checkpointTransport: BlobTransport = {
        async putBlob(bytes) {
          const reference = createHash("sha256").update(bytes).digest("hex");
          checkpointBytes.set(reference, Uint8Array.from(bytes));
          return reference;
        },
        async getBlob(reference) {
          const bytes = checkpointBytes.get(reference);
          if (!bytes) throw new Error("test checkpoint blob was not recorded");
          return Uint8Array.from(bytes);
        },
      };
      const honestCapture = await captureWorkspaceCheckpoint({
        workspacePath: unrelatedDirectory,
        transport: checkpointTransport,
      });
      const honestManifestBytes = Buffer.from(
        JSON.stringify(honestCapture.manifest),
      );
      const honestReferences = portableWorkspaceBlobReferences(
        honestCapture.manifest,
        honestCapture.manifestReference,
        honestManifestBytes.byteLength,
      );
      expect(honestCapture.manifest.policy.excludeGlobs).toContain("**/.env");
      expect(honestCapture.manifest.workspace.omissions).toContainEqual({
        path: ".env",
        reason: "excluded",
      });
      const forgedManifest = structuredClone(honestCapture.manifest);
      forgedManifest.policy.excludeGlobs = [];
      forgedManifest.workspace.omissions =
        forgedManifest.workspace.omissions.filter(
          (omission) => omission.path !== ".env",
        );
      const privateFixtureBytes = Buffer.from("private fixture bytes\n");
      const privatePathReference =
        await checkpointTransport.putBlob(privateFixtureBytes);
      forgedManifest.workspace.entries.push({
        path: ".env",
        kind: "file",
        size: privateFixtureBytes.byteLength,
        sha256: privatePathReference,
        executable: false,
      });
      forgedManifest.workspace.entries.sort((left, right) =>
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
      );
      const forgedManifestBytes = Buffer.from(JSON.stringify(forgedManifest));
      const forgedManifestReference =
        await checkpointTransport.putBlob(forgedManifestBytes);
      expect(
        createHash("sha256").update(forgedManifestBytes).digest("hex"),
      ).toBe(forgedManifestReference);
      const uploadReferences = [
        ...honestReferences.filter(
          (reference) =>
            reference.reference !== honestCapture.manifestReference,
        ),
        {
          reference: privatePathReference,
          size: privateFixtureBytes.byteLength,
        },
        {
          reference: forgedManifestReference,
          size: forgedManifestBytes.byteLength,
        },
      ].sort((left, right) => left.reference.localeCompare(right.reference));
      expect(new Set(uploadReferences.map((item) => item.reference)).size).toBe(
        uploadReferences.length,
      );
      for (const item of uploadReferences) {
        const bytes = checkpointBytes.get(item.reference);
        if (!bytes) throw new Error("scoped upload blob was not recorded");
        expect(bytes.byteLength).toBe(item.size);
        await restartedConnector.uploadCaptureBlob(
          forgedPolicyClaim.captureId,
          item.reference,
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          bytes.byteLength,
        );
      }
      const forgedPolicyReport = await postJson<{ error: string }>(
        restartedControllerUrl,
        `/v1/nodes/${nodeId}/workspace-snapshots/${forgedPolicyClaim.snapshotId}/report`,
        nodeCredential,
        {
          contractVersion: 1,
          snapshotId: forgedPolicyClaim.snapshotId,
          requestId: forgedPolicyClaim.requestId,
          captureRequestId: forgedPolicyClaim.captureRequestId,
          captureId: forgedPolicyClaim.captureId,
          nodeId,
          target: forgedPolicyClaim.target,
          ownershipGeneration: forgedPolicyClaim.ownershipGeneration,
          status: "workspace-checkpoint-available",
          reportedAt: new Date().toISOString(),
          manifestReference: forgedManifestReference,
        },
      );
      expect(forgedPolicyReport.response.status).toBe(422);
      expect(forgedPolicyReport.value.error).toBe(
        "workspace_checkpoint_integrity_failed",
      );
      const forgedPolicyStatus = await fetch(
        new URL(
          `/v1/workspace-snapshots/${forgedPolicyClaim.requestId}`,
          restartedControllerUrl,
        ),
        { headers: { authorization: `Bearer ${owner.credential}` } },
      );
      expect(
        ((await forgedPolicyStatus.json()) as { status: string }).status,
      ).toBe("claimed");
      const forgedPrivateDownload = await fetch(
        new URL(
          `/v1/workspace-snapshots/${forgedPolicyClaim.requestId}/blobs/${forgedManifestReference}`,
          restartedControllerUrl,
        ),
        { headers: { authorization: `Bearer ${owner.credential}` } },
      );
      expect(forgedPrivateDownload.status).toBe(404);
      const forgedPrivateBlobDownload = await fetch(
        new URL(
          `/v1/workspace-snapshots/${forgedPolicyClaim.requestId}/blobs/${privatePathReference}`,
          restartedControllerUrl,
        ),
        { headers: { authorization: `Bearer ${owner.credential}` } },
      );
      expect(forgedPrivateBlobDownload.status).toBe(404);
      expect(() =>
        reopenedDaemon.endWorkspaceCapture(forgedPolicyClaim.captureId),
      ).toThrow("capture_control_fence_held");
      const reopenedOwnerSession = await localFactory.factory.authenticate(
        owner.credential,
      );
      let forgedCoreFenceError: unknown;
      try {
        localFactory.factory.endManagedWorkCapture(
          reopenedOwnerSession,
          forgedPolicyClaim.captureId,
        );
      } catch (error) {
        forgedCoreFenceError = error;
      }
      expect(forgedCoreFenceError).toMatchObject({
        code: "capture_control_fence_held",
        status: 409,
      });
    } finally {
      blockedDaemon?.close();
      abort.abort();
      await running.catch(() => {});
    }
  });

  test("fails closed on local storage and controller protocol errors", async () => {
    const root = temporaryRoot();
    const workspaceDirectory = join(root, "workspace");
    mkdirSync(workspaceDirectory);
    const makeDaemon = (databaseName: string) =>
      new ExecutionDaemon({
        databasePath: join(root, databaseName),
        nodeId: "node:error-loop",
        nodeCredential: "node-error-loop-secret",
        workspaces: [
          {
            workspaceId: "workspace:error-loop",
            directory: workspaceDirectory,
          },
        ],
      });

    executionDaemon = makeDaemon("local-error.sqlite");
    let claimsAfterLocalFailure = 0;
    const localFailureLoop = new ExecutionLoop({
      daemon: executionDaemon,
      controller: {
        register: async () => undefined,
        heartbeat: async () => executionDaemon!.close(),
        claim: async () => {
          claimsAfterLocalFailure += 1;
          return null;
        },
        report: async () => undefined,
        claimCaptureControl: async () => null,
        reportCaptureControl: async () => undefined,
        claimWorkspaceSnapshot: async () => null,
        reportWorkspaceSnapshot: async () => undefined,
        uploadCaptureBlob: async () => undefined,
      },
      pollIntervalMs: 10,
      heartbeatIntervalMs: 20,
    });
    await expect(
      localFailureLoop.run(new AbortController().signal),
    ).rejects.toThrow("daemon_closed");
    expect(claimsAfterLocalFailure).toBe(0);

    executionDaemon = makeDaemon("protocol-error.sqlite");
    let protocolClaims = 0;
    const protocolFailureLoop = new ExecutionLoop({
      daemon: executionDaemon,
      controller: {
        register: async () => undefined,
        heartbeat: async () => undefined,
        claim: async () => {
          protocolClaims += 1;
          throw new ControllerProtocolError("invalid controller response");
        },
        report: async () => undefined,
        claimCaptureControl: async () => {
          protocolClaims += 1;
          throw new ControllerProtocolError("invalid controller response");
        },
        reportCaptureControl: async () => undefined,
        claimWorkspaceSnapshot: async () => null,
        reportWorkspaceSnapshot: async () => undefined,
        uploadCaptureBlob: async () => undefined,
      },
      pollIntervalMs: 10,
      heartbeatIntervalMs: 20,
    });
    await expect(
      protocolFailureLoop.run(new AbortController().signal),
    ).rejects.toBeInstanceOf(ControllerProtocolError);
    expect(protocolClaims).toBe(1);
  });

  test("keeps the controller heartbeat live during a bounded argv effect", async () => {
    const root = temporaryRoot();
    const workspaceDirectory = join(root, "workspace");
    mkdirSync(workspaceDirectory);
    localFactory = createLocalFactoryServer({
      databasePath: join(root, "controller.sqlite"),
      bootstrapSecret,
      port: 0,
    });
    const controllerUrl = localFactory.server.url.toString();
    const bootstrap = await fetch(new URL("/v1/bootstrap", controllerUrl), {
      method: "POST",
      headers: {
        authorization: `Bootstrap ${bootstrapSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Owner" }),
    });
    const owner = (await bootstrap.json()) as { credential: string };
    const provisioned = await postJson<{
      node: { nodeId: string };
      credential: string;
    }>(controllerUrl, "/v1/nodes", owner.credential, {
      nodeId: "node:heartbeat-test",
      name: "Heartbeat test node",
    });
    const nodeId = provisioned.value.node.nodeId;
    const workspace = await postJson<{ workspaceId: string }>(
      controllerUrl,
      "/v1/workspaces",
      owner.credential,
      {
        workspaceId: "workspace:heartbeat-test",
        nodeId,
        name: "Heartbeat workspace",
      },
    );
    executionDaemon = new ExecutionDaemon({
      databasePath: join(root, "executor.sqlite"),
      nodeId,
      nodeCredential: provisioned.value.credential,
      workspaces: [
        {
          workspaceId: workspace.value.workspaceId,
          directory: workspaceDirectory,
        },
      ],
      daemonVersion: "test",
    });
    const connector = new HttpExecutionControllerConnector({
      controllerUrl,
      nodeId,
      credential: provisioned.value.credential,
    });
    const abort = new AbortController();
    const loop = new ExecutionLoop({
      daemon: executionDaemon,
      controller: connector,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 25,
    });
    const running = loop.run(abort.signal);
    await expect(loop.run(new AbortController().signal)).rejects.toThrow(
      "Execution loop is already running",
    );
    const waitUntil = waitFor(2_000);
    try {
      await waitUntil(
        () =>
          localFactory!.database.all<{ node_id: string }>(
            "SELECT node_id FROM execution_node_state WHERE node_id = ?",
            [nodeId],
          ).length === 1,
      );
      const job: ExecutionJob = executionJobSchema.parse({
        contractVersion: 1,
        jobId: "job:long-enough-for-heartbeats",
        nodeId,
        target: { nodeId, workspaceId: workspace.value.workspaceId },
        ownershipGeneration: 0,
        operation: "argv-command",
        argv: [
          process.execPath,
          "-e",
          "await Bun.sleep(400); process.stdout.write('finished')",
        ],
        timeoutMs: 2_000,
        maxOutputBytes: 64,
      });
      expect(
        (await localFactory.factory.enqueueRemoteExecution(job)).status,
      ).toBe("queued");
      await waitUntil(
        () => executionDaemon!.getReceipt(job.jobId)?.status === "running",
      );
      const heartbeatsAtStart = localFactory.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM factory_events WHERE type = 'node.heartbeat'",
      )[0]!.count;
      await waitUntil(
        () =>
          executionDaemon!.getReceipt(job.jobId)?.status === "running" &&
          localFactory!.database.all<{ count: number }>(
            "SELECT COUNT(*) AS count FROM factory_events WHERE type = 'node.heartbeat'",
          )[0]!.count >=
            heartbeatsAtStart + 2,
      );
      expect(executionDaemon.getReceipt(job.jobId)?.status).toBe("running");
      abort.abort();
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const settledBeforeEffectFinished = await Promise.race([
        running.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          settleTimer = setTimeout(() => resolve(false), 25);
        }),
      ]);
      if (settleTimer) clearTimeout(settleTimer);
      expect(settledBeforeEffectFinished).toBe(false);
      expect(executionDaemon.getReceipt(job.jobId)?.status).toBe("running");
      await running;
      expect(
        localFactory.factory.getRemoteExecutionReceipt(job.jobId),
      ).toMatchObject({
        status: "completed",
        result: { operation: "argv-command", stdout: "finished" },
      });
      const heartbeatsAfterShutdown = localFactory.database.all<{
        count: number;
      }>(
        "SELECT COUNT(*) AS count FROM factory_events WHERE type = 'node.heartbeat'",
      )[0]!.count;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(
        localFactory.database.all<{ count: number }>(
          "SELECT COUNT(*) AS count FROM factory_events WHERE type = 'node.heartbeat'",
        )[0]!.count,
      ).toBe(heartbeatsAfterShutdown);
    } finally {
      abort.abort();
      await running;
    }
  });

  test("stops claiming after a heartbeat credential refusal and propagates it", async () => {
    const root = temporaryRoot();
    const workspaceDirectory = join(root, "workspace");
    mkdirSync(workspaceDirectory);
    localFactory = createLocalFactoryServer({
      databasePath: join(root, "controller.sqlite"),
      bootstrapSecret,
      port: 0,
    });
    const controllerUrl = localFactory.server.url.toString();
    const bootstrap = await fetch(new URL("/v1/bootstrap", controllerUrl), {
      method: "POST",
      headers: {
        authorization: `Bootstrap ${bootstrapSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Owner" }),
    });
    const owner = (await bootstrap.json()) as { credential: string };
    const provisioned = await postJson<{
      node: { nodeId: string };
      credentialId: string;
      credential: string;
    }>(controllerUrl, "/v1/nodes", owner.credential, {
      nodeId: "node:revoked-loop",
      name: "Revoked loop node",
    });
    const nodeId = provisioned.value.node.nodeId;
    const workspace = await postJson<{ workspaceId: string }>(
      controllerUrl,
      "/v1/workspaces",
      owner.credential,
      {
        workspaceId: "workspace:revoked-loop",
        nodeId,
        name: "Revoked workspace",
      },
    );
    executionDaemon = new ExecutionDaemon({
      databasePath: join(root, "executor.sqlite"),
      nodeId,
      nodeCredential: provisioned.value.credential,
      workspaces: [
        {
          workspaceId: workspace.value.workspaceId,
          directory: workspaceDirectory,
        },
      ],
    });

    let claimRequests = 0;
    let heartbeatRequests = 0;
    let refusedHeartbeats = 0;
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const route = new URL(request.url).pathname;
        if (route.endsWith("/jobs/claim")) claimRequests += 1;
        if (route.endsWith("/heartbeat")) {
          heartbeatRequests += 1;
          if (heartbeatRequests > 1) {
            refusedHeartbeats += 1;
            return Response.json(
              { error: "credential_revoked" },
              { status: 401 },
            );
          }
        }
        const body =
          request.method === "GET" ? undefined : await request.text();
        return fetch(new URL(route, controllerUrl), {
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
        });
      },
    });
    servers.push(proxy);
    const loop = new ExecutionLoop({
      daemon: executionDaemon,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: proxy.url.toString(),
        nodeId,
        credential: provisioned.value.credential,
      }),
      pollIntervalMs: 500,
      heartbeatIntervalMs: 20,
    });
    const abort = new AbortController();
    const running = loop.run(abort.signal);
    const waitUntil = waitFor(2_000);
    try {
      await waitUntil(
        () =>
          localFactory!.database.all<{ node_id: string }>(
            "SELECT node_id FROM execution_node_state WHERE node_id = ?",
            [nodeId],
          ).length === 1,
      );
      await expect(running).rejects.toThrow(
        "Controller rejected the configured node identity or credential",
      );
      expect(refusedHeartbeats).toBeGreaterThan(0);
      const claimsAtStop = claimRequests;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(claimRequests).toBe(claimsAtStop);
    } finally {
      abort.abort();
      await running.catch(() => undefined);
    }
  });
});
