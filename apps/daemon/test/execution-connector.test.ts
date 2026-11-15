import { afterEach, describe, expect, test } from "bun:test";
import { executionPayloadSha256 } from "../src/execution/payload";
import {
  ControllerHttpError,
  ControllerProtocolError,
  ControllerTransportError,
  HttpExecutionControllerConnector,
  isRetryableControllerFailure,
} from "../src/execution/connector";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function start(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return server;
}

const registerRequest = {
  contractVersion: 1,
  nodeId: "node:test",
  daemonVersion: "0.0.0",
  workspaces: [
    { workspaceId: "workspace:test", ownershipGeneration: 2, state: "active" },
  ],
  capabilities: {
    fileRead: true,
    fileWrite: true,
    argvCommand: true,
    rexProcessCreate: true,
    rexProcessInspect: true,
    rexProcessStop: true,
  },
};

const job = {
  contractVersion: 1,
  jobId: "job:controller",
  nodeId: "node:test",
  target: { nodeId: "node:test", workspaceId: "workspace:test" },
  ownershipGeneration: 2,
  operation: "read-file",
  path: "notes.txt",
  maxBytes: 128,
};

describe("outbound execution controller connector", () => {
  test("uses the reserved authenticated HTTP routes and validates each response", async () => {
    const requests: Array<{ route: string; authorization: string; body: any }> =
      [];
    const server = start(async (request) => {
      const body = await request.json();
      const route = new URL(request.url).pathname;
      requests.push({
        route,
        authorization: request.headers.get("authorization") ?? "",
        body,
      });
      const common = { contractVersion: 1, nodeId: "node:test" };
      if (route.endsWith("/register")) {
        return Response.json({
          ...common,
          registered: true,
          controllerTime: "2026-05-01T12:00:00.000Z",
        });
      }
      if (route.endsWith("/heartbeat")) {
        return Response.json({
          ...common,
          receivedAt: "2026-05-01T12:00:00.000Z",
        });
      }
      if (route.endsWith("/jobs/claim")) {
        return Response.json({ contractVersion: 1, job });
      }
      const report = body as Record<string, unknown>;
      if (
        report.jobId !== "job:controller" ||
        report.payloadSha256 !== executionPayloadSha256(job) ||
        report.ownershipGeneration !== job.ownershipGeneration ||
        (report.target as { workspaceId?: string } | undefined)?.workspaceId !==
          job.target.workspaceId
      ) {
        return Response.json({ error: "assignment_mismatch" }, { status: 409 });
      }
      return Response.json({
        ...common,
        jobId: "job:controller",
        accepted: true,
        status: "completed",
      });
    });
    const connector = new HttpExecutionControllerConnector({
      controllerUrl: server.url.toString(),
      nodeId: "node:test",
      credential: "controller-node-secret",
    });

    await connector.register(registerRequest);
    await connector.heartbeat({
      contractVersion: 1,
      nodeId: "node:test",
      sentAt: "2026-05-01T12:00:00.000Z",
      workspaces: registerRequest.workspaces,
      capabilities: registerRequest.capabilities,
    });
    expect(await connector.claim()).toMatchObject(job);
    const report = {
      contractVersion: 1,
      jobId: "job:controller",
      nodeId: "node:test",
      target: job.target,
      ownershipGeneration: 2,
      status: "completed",
      payloadSha256: executionPayloadSha256(job),
      finishedAt: "2026-05-01T12:00:00.000Z",
    };
    await expect(
      connector.report({ ...report, jobId: "job:other" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      connector.report({
        ...report,
        target: { nodeId: "node:test", workspaceId: "workspace:wrong" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      connector.report({ ...report, ownershipGeneration: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await connector.report(report);
    const restartedConnector = new HttpExecutionControllerConnector({
      controllerUrl: server.url.toString(),
      nodeId: "node:test",
      credential: "controller-node-secret",
    });
    await restartedConnector.report(report);

    expect(requests.slice(0, 3).map(({ route }) => route)).toEqual([
      "/v1/nodes/node:test/register",
      "/v1/nodes/node:test/heartbeat",
      "/v1/nodes/node:test/jobs/claim",
    ]);
    expect(requests.at(-1)?.route).toBe(
      "/v1/nodes/node:test/jobs/job:controller/report",
    );
    expect(
      requests.every(
        ({ authorization }) =>
          authorization === "Bearer controller-node-secret",
      ),
    ).toBe(true);
    expect(requests[2]?.body).toEqual({
      contractVersion: 1,
      nodeId: "node:test",
    });
    expect(requests.at(-1)?.body).toMatchObject({
      jobId: "job:controller",
      target: { nodeId: "node:test", workspaceId: "workspace:test" },
      ownershipGeneration: 2,
    });
  });

  test("claims activation, correlates readiness to the committed command, and reports the stable local receipt", async () => {
    const preflight = {
      contractVersion: 1,
      relocationId: "relocation:activation-http",
      requestId: "request:activation-http",
      checkpointRequestId: "checkpoint:activation-http",
      captureRequestId: "capture-request:activation-http",
      captureId: "capture:activation-http",
      workspaceSnapshotRequestId: "snapshot-request:activation-http",
      snapshotId: "snapshot:activation-http",
      threadId: "thread:activation-http",
      source: { nodeId: "node:source", workspaceId: "workspace:source" },
      destination: {
        nodeId: "node:test",
        workspaceId: "workspace:destination",
      },
      sourceOwnershipGeneration: 4,
      destinationOwnershipGeneration: 2,
      manifestReference: "a".repeat(64),
      sourceProofSha256: "b".repeat(64),
      preparedReceiptSha256: "c".repeat(64),
    };
    const readiness = {
      ...preflight,
      readinessReceiptSha256: "d".repeat(64),
      reportedAt: "2026-06-01T12:00:00.000Z",
    };
    const command = {
      ...preflight,
      ownershipGeneration: 5,
      readinessReceiptSha256: readiness.readinessReceiptSha256,
      committedAt: "2026-06-01T12:00:01.000Z",
    };
    const requests: Array<{ route: string; authorization: string; body: any }> =
      [];
    const server = start(async (request) => {
      const route = new URL(request.url).pathname;
      const body = await request.json();
      requests.push({
        route,
        authorization: request.headers.get("authorization") ?? "",
        body,
      });
      if (route.endsWith("/workspace-relocation-activations/claim")) {
        return Response.json({
          contractVersion: 1,
          activation: { phase: "preflight", assignment: preflight },
        });
      }
      if (route.endsWith("/readiness")) {
        return Response.json({
          contractVersion: 1,
          nodeId: "node:test",
          relocationId: preflight.relocationId,
          accepted: true,
          command,
        });
      }
      return Response.json({
        contractVersion: 1,
        nodeId: "node:test",
        relocationId: preflight.relocationId,
        accepted: true,
        status: "activated",
      });
    });
    const connector = new HttpExecutionControllerConnector({
      controllerUrl: server.url.toString(),
      nodeId: "node:test",
      credential: "activation-node-secret",
    });

    expect(
      (await connector.claimWorkspaceRelocationActivation()) as unknown,
    ).toEqual({ phase: "preflight", assignment: preflight });
    expect(
      (await connector.reportWorkspaceRelocationActivationReadiness(
        readiness,
      )) as unknown,
    ).toEqual(command);
    await connector.reportWorkspaceRelocationActivation({
      status: "activated",
      command,
      activationReceiptSha256: "e".repeat(64),
      reportedAt: "2026-06-01T12:00:02.000Z",
    });
    expect(requests.map(({ route }) => route)).toEqual([
      "/v1/nodes/node%3Atest/workspace-relocation-activations/claim",
      "/v1/nodes/node%3Atest/workspace-relocations/relocation%3Aactivation-http/readiness",
      "/v1/nodes/node%3Atest/workspace-relocations/relocation%3Aactivation-http/activation-report",
    ]);
    expect(
      requests.every(
        ({ authorization }) =>
          authorization === "Bearer activation-node-secret",
      ),
    ).toBe(true);
    expect(requests[0]?.body).toEqual({
      contractVersion: 1,
      nodeId: "node:test",
    });
    expect(requests[1]?.body).toEqual(readiness);
  });

  test("rejects activation responses bound to another node or readiness", async () => {
    const preflight = {
      contractVersion: 1,
      relocationId: "relocation:activation-mismatch",
      requestId: "request:activation-mismatch",
      checkpointRequestId: "checkpoint:activation-mismatch",
      captureRequestId: "capture-request:activation-mismatch",
      captureId: "capture:activation-mismatch",
      workspaceSnapshotRequestId: "snapshot-request:activation-mismatch",
      snapshotId: "snapshot:activation-mismatch",
      threadId: "thread:activation-mismatch",
      source: { nodeId: "node:source", workspaceId: "workspace:source" },
      destination: {
        nodeId: "node:test",
        workspaceId: "workspace:destination",
      },
      sourceOwnershipGeneration: 4,
      destinationOwnershipGeneration: 2,
      manifestReference: "a".repeat(64),
      sourceProofSha256: "b".repeat(64),
      preparedReceiptSha256: "c".repeat(64),
    };
    const readiness = {
      ...preflight,
      readinessReceiptSha256: "d".repeat(64),
      reportedAt: "2026-06-01T12:00:00.000Z",
    };
    const server = start(async (request) => {
      const route = new URL(request.url).pathname;
      if (route.endsWith("/workspace-relocation-activations/claim")) {
        return Response.json({
          contractVersion: 1,
          activation: {
            phase: "activate",
            command: {
              ...preflight,
              ownershipGeneration: 5,
              readinessReceiptSha256: readiness.readinessReceiptSha256,
              committedAt: "2026-06-01T12:00:01.000Z",
              destination: {
                nodeId: "node:other",
                workspaceId: "workspace:destination",
              },
            },
          },
        });
      }
      const command = {
        ...preflight,
        ownershipGeneration: 5,
        readinessReceiptSha256: readiness.readinessReceiptSha256,
        committedAt: "2026-06-01T12:00:01.000Z",
        preparedReceiptSha256: "f".repeat(64),
      };
      return Response.json({
        contractVersion: 1,
        nodeId: "node:test",
        relocationId: preflight.relocationId,
        accepted: true,
        command,
      });
    });
    const connector = new HttpExecutionControllerConnector({
      controllerUrl: server.url.toString(),
      nodeId: "node:test",
      credential: "activation-node-secret",
    });
    await expect(
      connector.claimWorkspaceRelocationActivation(),
    ).rejects.toBeInstanceOf(ControllerProtocolError);
    await expect(
      connector.reportWorkspaceRelocationActivationReadiness(readiness),
    ).rejects.toBeInstanceOf(ControllerProtocolError);
  });

  test("fails closed on unauthorized credentials and claims assigned to a different node", async () => {
    const unauthorized = start(() =>
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const wrongCredential = new HttpExecutionControllerConnector({
      controllerUrl: unauthorized.url.toString(),
      nodeId: "node:test",
      credential: "wrong-secret-value",
    });
    await expect(
      wrongCredential.register(registerRequest),
    ).rejects.toMatchObject({
      status: 401,
    });

    const misrouted = start(() =>
      Response.json({
        contractVersion: 1,
        job: {
          ...job,
          nodeId: "node:other",
          target: { nodeId: "node:other", workspaceId: "workspace:test" },
        },
      }),
    );
    const connector = new HttpExecutionControllerConnector({
      controllerUrl: misrouted.url.toString(),
      nodeId: "node:test",
      credential: "controller-node-secret",
    });
    await expect(connector.claim()).rejects.toBeInstanceOf(
      ControllerProtocolError,
    );
  });

  test("classifies transport loss separately from local and protocol failures", async () => {
    const server = start(() => Response.json({}));
    const controllerUrl = server.url.toString();
    await server.stop(true);
    const connector = new HttpExecutionControllerConnector({
      controllerUrl,
      nodeId: "node:test",
      credential: "controller-node-secret",
    });
    await expect(connector.claim()).rejects.toBeInstanceOf(
      ControllerTransportError,
    );
    expect(isRetryableControllerFailure(new ControllerTransportError())).toBe(
      true,
    );
    expect(isRetryableControllerFailure(new ControllerHttpError(502))).toBe(
      true,
    );
    expect(isRetryableControllerFailure(new ControllerHttpError(409))).toBe(
      false,
    );
    expect(
      isRetryableControllerFailure(
        new ControllerProtocolError("malformed response"),
      ),
    ).toBe(false);
    expect(isRetryableControllerFailure(new Error("local failure"))).toBe(
      false,
    );
  });

  test("does not expose response bodies or credential values in protocol failures", async () => {
    const server = start(() =>
      Response.json({ secret: "controller-error" }, { status: 403 }),
    );
    const connector = new HttpExecutionControllerConnector({
      controllerUrl: server.url.toString(),
      nodeId: "node:test",
      credential: "never-include-this-token",
    });
    try {
      await connector.claim();
      throw new Error("expected a controller failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ControllerHttpError);
      expect(String(error)).not.toContain("never-include-this-token");
      expect(String(error)).not.toContain("controller-error");
    }
  });
});
