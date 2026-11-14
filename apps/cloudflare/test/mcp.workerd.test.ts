import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Miniflare } from "miniflare";
import { buildCloudflareWorkerArtifact } from "../scripts/build-worker";

const fixtures: Array<{ close(): Promise<void> }> = [];

async function http<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: "GET" | "POST";
    credential?: string;
    bootstrap?: boolean;
    body?: unknown;
  } = {},
) {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
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
  return {
    status: response.status,
    value: (await response.json()) as T,
  };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe("production Worker MCP transport in workerd", () => {
  test("the compatibility-built Worker composes authenticated stateless MCP with the real Factory Durable Object", async () => {
    const artifact = await buildCloudflareWorkerArtifact();
    const miniflare = new Miniflare({
      name: "uzina-mcp-worker",
      script: artifact.script,
      modules: true,
      compatibilityDate: "2026-05-01",
      host: "127.0.0.1",
      port: 0,
      bindings: { UZINA_BOOTSTRAP_SECRET: "workerd-mcp-private-bootstrap" },
      durableObjects: {
        FACTORY: { className: "FactoryObject", useSQLite: true },
        MANAGED_WORK: { className: "ManagedWorkObject", useSQLite: true },
      },
    });
    fixtures.push({ close: () => miniflare.dispose() });
    const baseUrl = (await miniflare.ready).toString();
    const ownerResponse = await http<{ credential: string }>(
      baseUrl,
      "/v1/bootstrap",
      {
        credential: "workerd-mcp-private-bootstrap",
        bootstrap: true,
        body: { name: "Worker owner" },
      },
    );
    expect(ownerResponse.status).toBe(201);
    const owner = ownerResponse.value.credential;
    const projectA = await http<{ projectId: string }>(
      baseUrl,
      "/v1/projects",
      {
        credential: owner,
        body: { projectId: "project:worker-mcp-a", name: "A" },
      },
    );
    const projectB = await http<{ projectId: string }>(
      baseUrl,
      "/v1/projects",
      {
        credential: owner,
        body: { projectId: "project:worker-mcp-b", name: "B" },
      },
    );
    const node = await http<{ node: { nodeId: string } }>(
      baseUrl,
      "/v1/nodes",
      {
        credential: owner,
        body: { nodeId: "node:worker-mcp", name: "Node" },
      },
    );
    const workspaceA = await http<{ workspaceId: string }>(
      baseUrl,
      "/v1/workspaces",
      {
        credential: owner,
        body: {
          workspaceId: "workspace:worker-mcp-a",
          nodeId: node.value.node.nodeId,
          name: "A",
        },
      },
    );
    await http<{ threadId: string }>(baseUrl, "/v1/threads", {
      credential: owner,
      body: {
        threadId: "thread:worker-mcp-a",
        projectId: projectA.value.projectId,
        title: "Permitted thread",
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspaceA.value.workspaceId,
        },
      },
    });
    const workspaceB = await http<{ workspaceId: string }>(
      baseUrl,
      "/v1/workspaces",
      {
        credential: owner,
        body: {
          workspaceId: "workspace:worker-mcp-b",
          nodeId: node.value.node.nodeId,
          name: "B",
        },
      },
    );
    const threadB = await http<{ threadId: string }>(baseUrl, "/v1/threads", {
      credential: owner,
      body: {
        threadId: "thread:worker-mcp-b",
        projectId: projectB.value.projectId,
        title: "Denied thread",
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspaceB.value.workspaceId,
        },
      },
    });
    const assistant = await http<{
      credential: string;
      credentialId: string;
    }>(baseUrl, "/v1/credentials", {
      credential: owner,
      body: {
        kind: "assistant",
        name: "Workerd MCP assistant",
        assistantGrants: [
          { type: "project", resourceId: projectA.value.projectId },
        ],
      },
    });
    expect(assistant.status).toBe(201);

    const transport = new StreamableHTTPClientTransport(
      new URL("/v1/mcp", baseUrl),
      {
        requestInit: {
          headers: { authorization: `Bearer ${assistant.value.credential}` },
        },
      },
    );
    const client = new Client({ name: "workerd-mcp-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).toContain("list_projects");
      const projects = await client.callTool({
        name: "list_projects",
        arguments: {},
      });
      expect(projects.structuredContent).toMatchObject({
        result: [{ projectId: "project:worker-mcp-a" }],
      });
      const denied = await client.callTool({
        name: "get_context",
        arguments: { threadId: threadB.value.threadId },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ error: "not_found" });
      const ownerEvents = await http<{ events: unknown[] }>(
        baseUrl,
        "/v1/events",
        {
          credential: owner,
        },
      );
      expect(ownerEvents.status).toBe(200);

      await http(
        baseUrl,
        `/v1/credentials/${assistant.value.credentialId}/revoke`,
        {
          credential: owner,
          body: {},
        },
      );
      await expect(client.listTools()).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
