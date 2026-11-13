import { afterEach, describe, expect, test } from "bun:test";
import { executionPayloadSha256 } from "../src/execution/payload";
import {
  ControllerHttpError,
  ControllerProtocolError,
  HttpExecutionControllerConnector,
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
