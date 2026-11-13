import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionJobSchema,
  executionRegisterRequestSchema,
  type ExecutionJob,
  type ExecutionRegisterRequest,
} from "@uzina/contracts/execution";
import {
  createLocalFactoryServer,
  type LocalFactoryServer,
} from "../src/factory/server";
import { ExecutionDaemon } from "../src/execution/daemon";
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
  return async (predicate: () => boolean) => {
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for the authenticated execution loop");
  };
}

describe("authenticated Factory execution controller protocol", () => {
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
