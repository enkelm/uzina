import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryService, createFactoryHttpHandler } from "@uzina/core";
import { BunFactoryDatabase } from "../src/factory/sqlite";

type Fixture = {
  directory: string;
  database: BunFactoryDatabase;
  factory: FactoryService;
  owner: Awaited<ReturnType<FactoryService["authenticate"]>>;
  ownerCredential: string;
  assistantCredential: string;
  assistantCredentialId: string;
  threadA: string;
  threadB: string;
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  close(): void;
};

const fixtures: Fixture[] = [];
const bootstrapSecret = "mcp-test-private-bootstrap";

async function openFixture() {
  const directory = mkdtempSync(join(tmpdir(), "uzina-mcp-test-"));
  const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
  const factory = new FactoryService(database, bootstrapSecret);
  const ownerCredential = await factory.bootstrap(bootstrapSecret, "MCP owner");
  const owner = await factory.authenticate(ownerCredential.credential);
  const projectA = factory.createProject(owner, "project:mcp-a", "MCP A");
  const projectB = factory.createProject(owner, "project:mcp-b", "MCP B");
  const { node } = await factory.provisionNode(owner, "node:mcp", "MCP node");
  const workspaceA = factory.createWorkspace(
    owner,
    "workspace:mcp-a",
    node.nodeId,
    "A",
  );
  const workspaceB = factory.createWorkspace(
    owner,
    "workspace:mcp-b",
    node.nodeId,
    "B",
  );
  const threadA = factory.createThread(owner, {
    threadId: "thread:mcp-a",
    projectId: projectA.projectId,
    title: "Permitted thread",
    target: { nodeId: node.nodeId, workspaceId: workspaceA.workspaceId },
  });
  const threadB = factory.createThread(owner, {
    threadId: "thread:mcp-b",
    projectId: projectB.projectId,
    title: "Denied thread",
    target: { nodeId: node.nodeId, workspaceId: workspaceB.workspaceId },
  });
  const assistant = await factory.provisionCredential(
    owner,
    "assistant",
    "MCP assistant",
    [{ type: "project", resourceId: projectA.projectId }],
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createFactoryHttpHandler(factory, {
      async context(threadId) {
        return {
          threadId,
          messages: [{ role: "assistant", text: "authorized context" }],
        };
      },
      async status(threadId) {
        return { threadId, status: "not-created" };
      },
    }),
  });
  const fixture: Fixture = {
    directory,
    database,
    factory,
    owner,
    ownerCredential: ownerCredential.credential,
    assistantCredential: assistant.credential,
    assistantCredentialId: assistant.credentialId,
    threadA: threadA.threadId,
    threadB: threadB.threadId,
    server,
    baseUrl: server.url.toString(),
    close() {
      server.stop(true);
      database.close();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function createClient(
  fixture: Fixture,
  fetcher: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
  credential = fixture.assistantCredential,
) {
  const transport = new StreamableHTTPClientTransport(
    new URL("/v1/mcp", fixture.baseUrl),
    {
      requestInit: {
        headers: { authorization: `Bearer ${credential}` },
      },
      fetch: fetcher,
      redirectPolicy: "same-origin",
    },
  );
  return {
    client: new Client({ name: "uzina-mcp-test", version: "1.0.0" }),
    transport,
  };
}

describe("official MCP Streamable HTTP adapter", () => {
  test("official SDK handshake, tool listing, scoped calls, unsupported refusal, and reauthentication per request", async () => {
    const fixture = await openFixture();
    const { client, transport } = createClient(fixture);
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("list_projects");
      expect(names).toContain("submit_input");
      expect(names).toContain("get_context");
      expect(names).toContain("request_lifecycle_operation");

      const projects = await client.callTool({
        name: "list_projects",
        arguments: { limit: 5 },
      });
      expect(projects.isError).not.toBe(true);
      expect(projects.structuredContent).toMatchObject({
        result: [{ projectId: "project:mcp-a" }],
      });

      const allowed = await client.callTool({
        name: "get_context",
        arguments: { threadId: fixture.threadA },
      });
      expect(allowed.isError).not.toBe(true);
      const denied = await client.callTool({
        name: "get_context",
        arguments: { threadId: fixture.threadB },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ error: "not_found" });

      const before = fixture.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM command_receipts",
      )[0]?.count;
      const unsupported = await client.callTool({
        name: "request_lifecycle_operation",
        arguments: { threadId: fixture.threadA, operation: "transfer" },
      });
      expect(unsupported.isError).toBe(true);
      expect(unsupported.structuredContent).toMatchObject({
        error: "unsupported_operation",
      });
      expect(
        fixture.database.all<{ count: number }>(
          "SELECT COUNT(*) AS count FROM command_receipts",
        )[0]?.count,
      ).toBe(before);

      await fixture.factory.revokeCredential(
        fixture.owner,
        fixture.assistantCredentialId,
      );
      await expect(client.listTools()).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test("lost tool acknowledgement reuses application requestId despite a new JSON-RPC ID", async () => {
    const fixture = await openFixture();
    let drop = true;
    const losingFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const response = await fetch(input, init);
      if (drop && init?.method === "POST" && typeof init.body === "string") {
        const rpc = JSON.parse(init.body) as {
          method?: string;
          params?: { name?: string; arguments?: { requestId?: string } };
        };
        if (
          rpc.method === "tools/call" &&
          rpc.params?.name === "submit_input" &&
          rpc.params.arguments?.requestId === "request:stable-mcp"
        ) {
          drop = false;
          await response.arrayBuffer();
          throw new TypeError("simulated lost acknowledgement");
        }
      }
      return response;
    };
    const { client, transport } = createClient(fixture, losingFetch);
    await client.connect(transport);
    try {
      await expect(
        client.callTool({
          name: "submit_input",
          arguments: {
            threadId: fixture.threadA,
            requestId: "request:stable-mcp",
            text: "Use the same app identity after a lost MCP acknowledgement",
          },
        }),
      ).rejects.toThrow();
      const stored = fixture.factory.getReceipt(
        await fixture.factory.authenticate(fixture.assistantCredential),
        "request:stable-mcp",
      );
      const retried = await client.callTool({
        name: "submit_input",
        arguments: {
          threadId: fixture.threadA,
          requestId: "request:stable-mcp",
          text: "Use the same app identity after a lost MCP acknowledgement",
        },
      });
      expect(retried.isError).not.toBe(true);
      expect(retried.structuredContent).toMatchObject({
        result: { requestId: stored.requestId, jobId: stored.jobId },
      });
      expect(
        fixture.database.all<{ count: number }>(
          "SELECT COUNT(*) AS count FROM command_receipts WHERE request_id = ?",
          ["request:stable-mcp"],
        )[0]?.count,
      ).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("rejects anonymous, foreign-origin, query-token, and cross-Factory resource requests without CORS", async () => {
    const fixture = await openFixture();
    const url = new URL("/v1/mcp", fixture.baseUrl);
    const anonymous = await fetch(url, { method: "POST" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("access-control-allow-origin")).toBeNull();
    const foreignOrigin = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.assistantCredential}`,
        origin: "https://attacker.example",
      },
    });
    expect(foreignOrigin.status).toBe(403);
    const queryToken = await fetch(
      `${url.href}?access_token=${encodeURIComponent(fixture.assistantCredential)}`,
      { method: "POST" },
    );
    expect(queryToken.status).toBe(400);

    const otherDirectory = mkdtempSync(
      join(tmpdir(), "uzina-mcp-other-factory-"),
    );
    const otherDatabase = new BunFactoryDatabase(
      join(otherDirectory, "factory.sqlite"),
    );
    const otherFactory = new FactoryService(otherDatabase, "other-bootstrap");
    await otherFactory.bootstrap("other-bootstrap", "Other owner");
    const otherServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createFactoryHttpHandler(otherFactory),
    });
    try {
      const isolated = await fetch(new URL("/v1/mcp", otherServer.url), {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.assistantCredential}` },
      });
      expect(isolated.status).toBe(401);
    } finally {
      otherServer.stop(true);
      otherDatabase.close();
      rmSync(otherDirectory, { recursive: true, force: true });
    }
  });
});
