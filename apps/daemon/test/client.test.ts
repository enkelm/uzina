import { describe, expect, test } from "bun:test";
import { FactoryClient, type FactoryFetch } from "@uzina/client";
import { FactoryService } from "@uzina/core";
import { createFactoryHttpHandler } from "@uzina/core/http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFactoryDatabase } from "../src/factory/sqlite";

describe("FactoryClient over the authorized Factory HTTP boundary", () => {
  test("creates projects and explicitly targeted Work items through authorized Core HTTP", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uzina-client-create-"));
    const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
    const factory = new FactoryService(database, "client-create-bootstrap");
    const ownerCredential = await factory.bootstrap(
      "client-create-bootstrap",
      "Client test owner",
    );
    const owner = await factory.authenticate(ownerCredential.credential);
    const { node } = await factory.provisionNode(
      owner,
      "node:client-create",
      "Create test node",
    );
    const workspace = factory.createWorkspace(
      owner,
      "workspace:client-create",
      node.nodeId,
      "Create test workspace",
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createFactoryHttpHandler(factory),
    });
    const client = new FactoryClient({
      baseUrl: server.url,
      credential: ownerCredential.credential,
    });
    try {
      const project = await client.createProject(
        "A real project",
        "project:client-create",
      );
      const thread = await client.createThread({
        projectId: project.projectId,
        title: "An explicitly placed Work item",
        target: { nodeId: node.nodeId, workspaceId: workspace.workspaceId },
      });
      expect(await client.listProjects()).toMatchObject({
        projects: [{ projectId: project.projectId, name: "A real project" }],
      });
      expect(
        await client.listThreads({ projectId: project.projectId }),
      ).toMatchObject({
        threads: [
          {
            threadId: thread.threadId,
            target: { nodeId: node.nodeId, workspaceId: workspace.workspaceId },
          },
        ],
      });
    } finally {
      server.stop(true);
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an aborted submit acknowledgement remains uncertain and reconciles/retries with the same ID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uzina-client-abort-"));
    const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
    const factory = new FactoryService(database, "client-abort-bootstrap");
    const ownerCredential = await factory.bootstrap(
      "client-abort-bootstrap",
      "Client test owner",
    );
    const owner = await factory.authenticate(ownerCredential.credential);
    const project = factory.createProject(
      owner,
      "project:client-abort",
      "Client",
    );
    const { node } = await factory.provisionNode(
      owner,
      "node:client-abort",
      "Client test node",
    );
    const workspace = factory.createWorkspace(
      owner,
      "workspace:client-abort",
      node.nodeId,
      "Client test workspace",
    );
    const thread = factory.createThread(owner, {
      threadId: "thread:client-abort",
      projectId: project.projectId,
      title: "Client request target",
      target: { nodeId: node.nodeId, workspaceId: workspace.workspaceId },
    });
    const assistantCredential = await factory.provisionCredential(
      owner,
      "assistant",
      "Client test assistant",
      [{ type: "thread", resourceId: thread.threadId }],
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createFactoryHttpHandler(factory),
    });
    const requestId = "request:stable-after-body-abort";
    const text = "Create one durable accepted request";
    const abortError = new DOMException(
      "Connection lost while reading the acknowledgement",
      "AbortError",
    );
    let interruptNextSubmitAcknowledgement = true;
    const fetchWithInterruptedAcknowledgement: FactoryFetch = async (
      input,
      init,
    ) => {
      const response = await fetch(input, init);
      if (
        !interruptNextSubmitAcknowledgement ||
        init?.method !== "POST" ||
        !String(input).endsWith(
          `/v1/threads/${encodeURIComponent(thread.threadId)}/inputs`,
        )
      ) {
        return response;
      }
      interruptNextSubmitAcknowledgement = false;

      // The real Core has accepted and emitted this HTTP response. The transport
      // seam loses its body acknowledgement after headers, as a dropped connection can.
      const acknowledgedBytes = new Uint8Array(await response.arrayBuffer());
      expect(acknowledgedBytes.byteLength).toBeGreaterThan(1);
      let sentPrefix = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (!sentPrefix) {
              sentPrefix = true;
              controller.enqueue(acknowledgedBytes.subarray(0, 1));
            } else {
              controller.error(abortError);
            }
          },
        },
        { highWaterMark: 0 },
      );
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
    const client = new FactoryClient({
      baseUrl: server.url,
      credential: assistantCredential.credential,
      fetch: fetchWithInterruptedAcknowledgement,
    });

    try {
      const identity = await client.me();
      expect(identity).toMatchObject({
        credentialId: assistantCredential.credentialId,
        actor: assistantCredential.actor,
        participant: null,
      });
      await expect(
        client.submitInput(thread.threadId, requestId, text),
      ).rejects.toBe(abortError);

      const reconciled = await client.getReceipt(requestId);
      expect(reconciled).toMatchObject({
        requestId,
        threadId: thread.threadId,
        status: "accepted",
      });
      const retried = await client.submitInput(
        thread.threadId,
        requestId,
        text,
      );
      expect(retried).toMatchObject({
        requestId,
        threadId: thread.threadId,
        jobId: reconciled.jobId,
        status: "accepted",
      });
      expect(factory.listThreadReceipts(owner, thread.threadId)).toHaveLength(
        1,
      );
    } finally {
      server.stop(true);
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
