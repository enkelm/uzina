import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryService, createFactoryHttpHandler } from "@uzina/core";
import { FactoryClient } from "@uzina/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BunFactoryDatabase } from "../src/factory/sqlite";

test("native worker questions, human decisions and mailbox acknowledgements survive lost replies and reopen without creating managed chats", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uzina-coordination-"));
  let database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
  let factory = new FactoryService(database, "bootstrap-test");
  const ownerCredential = (await factory.bootstrap("bootstrap-test", "Owner"))
    .credential;
  let owner = await factory.authenticate(ownerCredential);
  factory.createProject(owner, "project:one", "One");
  factory.createProject(owner, "project:two", "Two");
  await factory.provisionNode(owner, "node:one", "One");
  factory.createWorkspace(owner, "workspace:one", "node:one", "One");
  const assistant = await factory.provisionCredential(
    owner,
    "assistant",
    "Coordinator",
    [{ type: "project", resourceId: "project:one" }],
  );
  const outsider = await factory.provisionCredential(
    owner,
    "assistant",
    "Other project",
    [{ type: "project", resourceId: "project:two" }],
  );
  const workerCredential = "worker_test_credential_000000000000000000";
  const registration = {
    workerId: "worker:one",
    projectId: "project:one",
    name: "Rex Pi worker",
    target: { nodeId: "node:one", workspaceId: "workspace:one" },
    ownershipGeneration: 0,
    rex: { sessionId: "session:owned", blockId: "block:owned" },
    credential: workerCredential,
  };
  const call = async (path: string, credential: string, body?: unknown) => {
    const response = await createFactoryHttpHandler(factory)(
      new Request(`http://factory.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return {
      status: response.status,
      value: (await response.json()) as Record<string, unknown>,
    };
  };
  try {
    const registered = await call(
      "/v1/native-workers",
      ownerCredential,
      registration,
    );
    expect(registered.status).toBe(201);
    expect(JSON.stringify(registered.value)).not.toContain(workerCredential);
    expect(
      await call("/v1/native-workers", ownerCredential, registration),
    ).toEqual(registered);
    expect(
      (
        await call("/v1/native-workers", ownerCredential, {
          ...registration,
          name: "Changed",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("/v1/native-workers", ownerCredential, {
          ...registration,
          workerId: "worker:owner-token",
          credential: ownerCredential,
        })
      ).value.error,
    ).toBe("worker_credential_conflict");
    const otherWorkerCredential = "other_worker_credential_0000000000000000";
    await call("/v1/native-workers", ownerCredential, {
      ...registration,
      workerId: "worker:other",
      credential: otherWorkerCredential,
    });
    const question = {
      itemId: "question:one",
      kind: "question",
      title: "Keep compatibility?",
      text: "Removing this field breaks existing clients.",
      blocking: true,
    };
    const posted = await call("/v1/worker/items", workerCredential, question);
    expect(posted.status).toBe(201);
    expect(posted.value.status).toBe("bot_pending");
    let firstDelivery: { inputId: string; text: string } | undefined;
    await expect(
      factory.coordination.dispatchNotifications(async (inputId, text) => {
        firstDelivery = { inputId, text };
        throw new Error("temporary admission unavailable");
      }),
    ).rejects.toThrow("temporary admission unavailable");
    expect(factory.coordination.hasNotifications()).toBe(true);
    expect(await call("/v1/worker/items", workerCredential, question)).toEqual(
      posted,
    );
    expect(
      (
        await call("/v1/worker/items", workerCredential, {
          ...question,
          text: "Different",
        })
      ).status,
    ).toBe(409);
    expect((await call("/v1/projects", workerCredential)).status).toBe(401);
    expect(
      (
        await call(
          "/v1/coordination?projectId=project:one",
          outsider.credential,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call("/v1/coordination/question:one", outsider.credential)).status,
    ).toBe(404);
    const escalate = {
      requestId: "decision:escalate",
      action: "escalate",
      text: "Owner must approve compatibility changes.",
    };
    expect(
      (
        await call(
          "/v1/coordination/question:one/decisions",
          assistant.credential,
          escalate,
        )
      ).value.status,
    ).toBe("needs_user");
    expect(
      (
        await call(
          "/v1/coordination/question:one/decisions",
          assistant.credential,
          {
            requestId: "decision:bot-answer",
            action: "answer",
            text: "Remove it",
          },
        )
      ).status,
    ).toBe(403);
    const answer = {
      requestId: "decision:owner",
      action: "answer",
      text: "Preserve compatibility for one release.",
    };
    const answered = await call(
      "/v1/coordination/question:one/decisions",
      ownerCredential,
      answer,
    );
    expect(answered.value.status).toBe("answered");
    database.close();
    database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
    factory = new FactoryService(database, "bootstrap-test");
    owner = await factory.authenticate(ownerCredential);
    expect(
      await call(
        "/v1/coordination/question:one/decisions",
        ownerCredential,
        answer,
      ),
    ).toEqual(answered);
    const recoveredNotifications: Array<{ inputId: string; text: string }> = [];
    await factory.coordination.dispatchNotifications(async (inputId, text) => {
      recoveredNotifications.push({ inputId, text });
    });
    expect(recoveredNotifications).toEqual([firstDelivery!]);
    expect(factory.coordination.hasNotifications()).toBe(false);
    expect(
      (await call("/v1/coordination-commands/decision:owner", ownerCredential))
        .value,
    ).toMatchObject({
      requestId: "decision:owner",
      item: { status: "answered" },
      message: null,
    });
    expect(
      (
        await call(
          "/v1/coordination-commands/decision:owner",
          assistant.credential,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call("/v1/coordination/question:one/decisions", ownerCredential, {
          ...answer,
          text: "Changed answer",
        })
      ).status,
    ).toBe(409);
    const mailbox = await call("/v1/worker/mailbox", workerCredential);
    expect(mailbox.value.messages).toMatchObject([
      { messageId: "decision:owner", text: answer.text, acknowledgedAt: null },
    ]);
    expect(
      (await call("/v1/worker/mailbox", otherWorkerCredential)).value.messages,
    ).toEqual([]);
    expect(
      (
        await call("/v1/worker/acknowledgements", otherWorkerCredential, {
          messageId: "decision:owner",
        })
      ).status,
    ).toBe(404);
    const acknowledged = await call(
      "/v1/worker/acknowledgements",
      workerCredential,
      { messageId: "decision:owner" },
    );
    expect(acknowledged.status).toBe(200);
    expect(
      await call("/v1/worker/acknowledgements", workerCredential, {
        messageId: "decision:owner",
      }),
    ).toEqual(acknowledged);
    expect(
      (await call("/v1/coordination/question:one", ownerCredential)).value
        .status,
    ).toBe("acknowledged");
    expect(
      (await call("/v1/worker/mailbox", workerCredential)).value.messages,
    ).toEqual([]);
    const instruction = {
      requestId: "instruction:one",
      text: "Run the compatibility checks.",
    };
    expect(
      (
        await call(
          "/v1/native-workers/worker:one/messages",
          assistant.credential,
          instruction,
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await call(
          "/v1/native-workers/worker:one/messages",
          assistant.credential,
          instruction,
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await call(
          "/v1/native-workers/worker:one/messages",
          outsider.credential,
          instruction,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "/v1/coordination-commands/instruction:one",
          assistant.credential,
        )
      ).value,
    ).toMatchObject({ message: { text: instruction.text }, item: null });
    database.exec(
      "UPDATE workspaces SET ownership_generation = 1 WHERE workspace_id = 'workspace:one'",
    );
    expect(
      (await call("/v1/worker/mailbox", workerCredential)).value.error,
    ).toBe("ownership_fenced");
    expect(
      (
        await call(
          "/v1/native-workers/worker:one/messages",
          assistant.credential,
          { ...instruction, requestId: "instruction:fenced" },
        )
      ).value.error,
    ).toBe("ownership_fenced");
    database.exec(
      "UPDATE workspaces SET ownership_generation = 0 WHERE workspace_id = 'workspace:one'",
    );
    expect(
      database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM threads",
      )[0]!.count,
    ).toBe(0);
    expect(
      database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM dispatch_intents",
      )[0]!.count,
    ).toBe(0);
    await call("/v1/native-workers/worker:one/revoke", ownerCredential, {});
    expect((await call("/v1/worker/mailbox", workerCredential)).status).toBe(
      401,
    );
    expect(
      JSON.stringify(database.all("SELECT * FROM native_workers")),
    ).not.toContain(workerCredential);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native MCP is session scoped while coordinator tools use ordinary project grants", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uzina-coordination-mcp-"));
  const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
  const factory = new FactoryService(database, "bootstrap-test");
  const boot = await factory.bootstrap("bootstrap-test", "Owner");
  const owner = await factory.authenticate(boot.credential);
  factory.createProject(owner, "project:mcp", "MCP");
  await factory.provisionNode(owner, "node:mcp", "MCP");
  factory.createWorkspace(owner, "workspace:mcp", "node:mcp", "MCP");
  const credential = "worker_mcp_credential_000000000000000000";
  await factory.coordination.register(owner, {
    workerId: "worker:mcp",
    projectId: "project:mcp",
    name: "MCP worker",
    target: { nodeId: "node:mcp", workspaceId: "workspace:mcp" },
    ownershipGeneration: 0,
    rex: { sessionId: "session:mcp", blockId: "block:mcp" },
    credential,
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createFactoryHttpHandler(factory),
  });
  const worker = new Client({ name: "worker", version: "1" });
  const bot = new Client({ name: "bot", version: "1" });
  try {
    await worker.connect(
      new StreamableHTTPClientTransport(new URL("/v1/worker/mcp", server.url), {
        requestInit: { headers: { authorization: `Bearer ${credential}` } },
      }),
    );
    const response = await worker.callTool({
      name: "ask_factory",
      arguments: {
        itemId: "question:mcp",
        kind: "question",
        title: "Which API?",
        text: "Choose the stable API.",
        blocking: true,
      },
    });
    expect(response.isError).not.toBe(true);
    expect(
      (await worker.callTool({ name: "list_projects", arguments: {} })).isError,
    ).toBe(true);
    await bot.connect(
      new StreamableHTTPClientTransport(new URL("/v1/mcp", server.url), {
        requestInit: {
          headers: { authorization: `Bearer ${boot.credential}` },
        },
      }),
    );
    expect(
      (
        await bot.callTool({
          name: "decide_coordination_item",
          arguments: {
            itemId: "question:mcp",
            requestId: "answer:mcp",
            action: "answer",
            text: "Use v1.",
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (await worker.callTool({ name: "check_factory_mailbox", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ result: { messages: [{ text: "Use v1." }] } });
    const nativeClient = new FactoryClient({ baseUrl: server.url, credential });
    for (let index = 0; index < 20; index += 1)
      await nativeClient.postWorkerItem({
        itemId: `report:large-${index}`,
        kind: "report",
        title: "Unicode progress",
        text: "🙂".repeat(4_000),
        blocking: false,
      });
    const ownerClient = new FactoryClient({
      baseUrl: server.url,
      credential: boot.credential,
    });
    const visibleIds = new Set<string>();
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page = await ownerClient.listCoordinationItems("project:mcp", {
        limit: 100,
        offset,
      });
      expect(
        new TextEncoder().encode(JSON.stringify(page)).byteLength,
      ).toBeLessThan(256 * 1024);
      for (const item of page.items) {
        expect(visibleIds.has(item.itemId)).toBe(false);
        visibleIds.add(item.itemId);
      }
      offset = page.nextOffset;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
    expect(visibleIds.size).toBe(21);
    factory.coordination.revoke(owner, "worker:mcp");
    await expect(
      worker.callTool({ name: "check_factory_mailbox", arguments: {} }),
    ).rejects.toThrow();
    const client = new FactoryClient({
      baseUrl: server.url,
      credential: boot.credential,
    });
    expect(
      (await client.listCoordinationItems("project:mcp", { limit: 1 })).items,
    ).toHaveLength(1);
  } finally {
    await worker.close();
    await bot.close();
    server.stop(true);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
