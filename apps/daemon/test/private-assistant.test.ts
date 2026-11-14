import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FactoryClient, type FactoryFetch } from "@uzina/client";
import { FactoryService } from "@uzina/core";
import { FACTORY_INPUT_REQUEST_MEMO } from "@uzina/pi-runtime";
import { BunFactoryDatabase } from "../src/factory/sqlite";
import {
  createStandaloneFactoryServer,
  type StandaloneFactoryServer,
} from "../src/factory/standalone";
import { ExecutionDaemon } from "../src/execution/daemon";
import { HttpExecutionControllerConnector } from "../src/execution/connector";
import { ExecutionLoop } from "../src/execution/loop";
import { deterministicPrivateAssistantModels } from "../../../packages/pi-runtime/test-support/deterministic-private-assistant-model";

setDefaultTimeout(30_000);

const fixtures: Array<{
  directory: string;
  close(): Promise<void>;
}> = [];

async function call<T>(
  baseUrl: string,
  path: string,
  options: { credential?: string; bootstrap?: boolean; body?: unknown } = {},
): Promise<{ status: number; value: T }> {
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
  return { status: response.status, value: (await response.json()) as T };
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(
    "Timed out waiting for the private Factory assistant scenario",
  );
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("owner-private Factory assistant production composition", () => {
  test("keeps baseline Factory work available while missing optional assistant identity is parked", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "uzina-private-assistant-unconfigured-"),
    );
    const databasePath = join(directory, "factory.sqlite");
    const bootstrapSecret = "private-assistant-unconfigured-bootstrap";
    const database = new BunFactoryDatabase(databasePath);
    const factory = new FactoryService(database, bootstrapSecret);
    const bootstrapped = await factory.bootstrap(bootstrapSecret, "Owner");
    database.close();
    const host = await createStandaloneFactoryServer({
      databasePath,
      runtimeDirectory: join(directory, "managed-work"),
      bootstrapSecret,
      models: deterministicPrivateAssistantModels(),
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      port: 0,
    });
    fixtures.push({ directory, close: () => host.close() });
    const projects = await call(host.server.url.toString(), "/v1/projects", {
      credential: bootstrapped.credential,
    });
    expect(projects.status).toBe(200);
    const client = new FactoryClient({
      baseUrl: host.server.url,
      credential: bootstrapped.credential,
    });
    const status = await client.getPrivateAssistantStatus();
    expect(status).toMatchObject({
      available: false,
      state: "parked",
      reason: "configuration_missing",
    });
    await expect(
      client.submitPrivateAssistantInput(
        "private-input:unconfigured",
        "must not run",
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "private_assistant_unavailable",
    });
  });

  test("lists permitted work, submits one attributed input, settles a bounded workspace effect, and reopens privately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-private-assistant-"));
    const databasePath = join(directory, "factory.sqlite");
    const runtimeDirectory = join(directory, "managed-work");
    const workspaceDirectory = join(directory, "workspace");
    await mkdir(workspaceDirectory, { recursive: true });
    const bootstrapSecret = "private-assistant-bootstrap-dummy";
    const initialDatabase = new BunFactoryDatabase(databasePath);
    const initialFactory = new FactoryService(initialDatabase, bootstrapSecret);
    const bootstrapped = await initialFactory.bootstrap(
      bootstrapSecret,
      "Owner",
    );
    const ownerSession = await initialFactory.authenticate(
      bootstrapped.credential,
    );
    const project = initialFactory.createProject(
      ownerSession,
      "project:private-assistant-proof",
      "Private assistant proof",
    );
    const provisionedNode = await initialFactory.provisionNode(
      ownerSession,
      "node:private-assistant-proof",
      "Local executor",
    );
    const workspace = initialFactory.createWorkspace(
      ownerSession,
      "workspace:private-assistant-proof",
      provisionedNode.node.nodeId,
      "Private assistant workspace",
    );
    const thread = initialFactory.createThread(ownerSession, {
      threadId: "thread:private-assistant-proof",
      projectId: project.projectId,
      title: "Explicit assistant target",
      target: {
        nodeId: provisionedNode.node.nodeId,
        workspaceId: workspace.workspaceId,
      },
    });
    const assistant = await initialFactory.provisionCredential(
      ownerSession,
      "assistant",
      "Owner private assistant",
      [{ type: "project", resourceId: project.projectId }],
    );
    const assistantActor = assistant.actor;
    if (assistantActor.kind !== "assistant") {
      throw new Error("Factory provisioned the wrong credential kind");
    }
    const guestInvitation = await initialFactory.createInvitation(
      ownerSession,
      {
        role: "guest",
        grants: [{ type: "project", resourceId: project.projectId }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const guest = await initialFactory.redeemInvitation(
      guestInvitation.code,
      "Guest",
    );
    const viewerInvitation = await initialFactory.createInvitation(
      ownerSession,
      {
        role: "viewer",
        grants: [{ type: "project", resourceId: project.projectId }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const viewer = await initialFactory.redeemInvitation(
      viewerInvitation.code,
      "Viewer",
    );
    const otherAssistant = await initialFactory.provisionCredential(
      ownerSession,
      "assistant",
      "Different assistant",
      [{ type: "project", resourceId: project.projectId }],
    );
    initialDatabase.close();

    const models = deterministicPrivateAssistantModels();
    let identityProbeFailures = 1;
    let identityProbeAttempts = 0;
    let loseInputAcknowledgement = true;
    let lostAcknowledgementWasAccepted = false;
    let memoPersistedBeforeMutation = false;
    let privateInputRequests = 0;
    let lostFactoryRequestId: string | undefined;
    const privateAssistantFetch: FactoryFetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname === "/v1/me") {
        identityProbeAttempts += 1;
        if (identityProbeFailures > 0) {
          identityProbeFailures -= 1;
          return Response.json(
            { error: "temporary_unavailable" },
            { status: 503 },
          );
        }
      }
      const isInputSubmission =
        init?.method === "POST" &&
        /^\/v1\/threads\/[^/]+\/inputs$/.test(url.pathname);
      const mutation = isInputSubmission
        ? (JSON.parse(String(init.body)) as { requestId: string })
        : undefined;
      if (loseInputAcknowledgement && mutation) {
        const piDatabase = new Database(
          join(runtimeDirectory, "private-assistant", "pi-durable.sqlite"),
          { readonly: true },
        );
        try {
          const taskRecords = piDatabase
            .query("SELECT record FROM tasks")
            .all() as Array<{ record: string }>;
          memoPersistedBeforeMutation = taskRecords.some((task) => {
            const record = JSON.parse(task.record) as {
              memos?: Record<string, { requestId?: string }>;
            };
            return (
              record.memos?.[FACTORY_INPUT_REQUEST_MEMO]?.requestId ===
              mutation.requestId
            );
          });
        } finally {
          piDatabase.close();
        }
      }
      const response = await fetch(input, init);
      if (loseInputAcknowledgement && mutation) {
        loseInputAcknowledgement = false;
        privateInputRequests += 1;
        lostFactoryRequestId = mutation.requestId;
        const acknowledgedBytes = new Uint8Array(await response.arrayBuffer());
        lostAcknowledgementWasAccepted = response.status === 202;
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        let sentPrefix = false;
        const interruptedBody = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (!sentPrefix) {
                sentPrefix = true;
                controller.enqueue(acknowledgedBytes.subarray(0, 1));
              } else {
                controller.error(
                  new DOMException(
                    "Lost accepted Factory acknowledgement",
                    "AbortError",
                  ),
                );
              }
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(interruptedBody, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return response;
    };
    let host: StandaloneFactoryServer | undefined;
    let execution: ExecutionDaemon | undefined;
    let executionAbort: AbortController | undefined;
    let executionLoop: Promise<void> | undefined;
    const openHost = () =>
      createStandaloneFactoryServer({
        databasePath,
        runtimeDirectory,
        bootstrapSecret,
        models,
        modelProvider: "uzina-test",
        modelId: "fixed-model",
        privateAssistant: {
          bearer: assistant.credential,
          credentialId: assistant.credentialId,
          assistantId: assistantActor.assistantId,
          ownerId: assistantActor.ownerId,
          fetch: privateAssistantFetch,
        },
        port: 0,
      });
    host = await openHost();
    const fixture = {
      directory,
      get host() {
        if (!host) throw new Error("Factory host is closed");
        return host;
      },
      get baseUrl() {
        return this.host.server.url.toString();
      },
      async startExecution() {
        if (execution) return;
        execution = new ExecutionDaemon({
          databasePath: join(directory, "executor.sqlite"),
          nodeId: provisionedNode.node.nodeId,
          nodeCredential: provisionedNode.credential.credential,
          workspaces: [
            {
              workspaceId: workspace.workspaceId,
              directory: workspaceDirectory,
            },
          ],
          daemonVersion: "private-assistant-test",
        });
        executionAbort = new AbortController();
        executionLoop = new ExecutionLoop({
          daemon: execution,
          controller: new HttpExecutionControllerConnector({
            controllerUrl: fixture.baseUrl,
            nodeId: provisionedNode.node.nodeId,
            credential: provisionedNode.credential.credential,
          }),
          pollIntervalMs: 20,
          heartbeatIntervalMs: 500,
        }).run(executionAbort.signal);
        await until(async () => {
          const nodes = await call<{ nodes: Array<{ availability: string }> }>(
            fixture.baseUrl,
            "/v1/nodes",
            { credential: bootstrapped.credential },
          );
          return nodes.value.nodes.some(
            (node) => node.availability === "online",
          );
        });
      },
      async reopen() {
        await host?.close();
        host = await openHost();
      },
      async close() {
        executionAbort?.abort();
        await executionLoop?.catch(() => {});
        execution?.close();
        execution = undefined;
        await host?.close();
        host = undefined;
      },
    };
    fixtures.push(fixture);

    const initialHost = fixture.host;
    await fixture.startExecution();
    expect(identityProbeAttempts).toBe(1);
    expect(
      (await stat(join(runtimeDirectory, "private-assistant"))).mode & 0o777,
    ).toBe(0o700);
    let ownerClient = new FactoryClient({
      baseUrl: fixture.baseUrl,
      credential: bootstrapped.credential,
    });
    const recoveredStatus = await ownerClient.getPrivateAssistantStatus();
    expect(recoveredStatus.available).toBe(true);
    expect(identityProbeAttempts).toBe(3);
    expect(fixture.host).toBe(initialHost);
    const input = {
      inputId: "private-input:owner-request-1",
      text: "OWNER-PRIVATE-COORDINATION",
    };
    const accepted = await ownerClient.submitPrivateAssistantInput(
      input.inputId,
      input.text,
    );
    expect(accepted.inputId).toBe(input.inputId);

    await until(async () => {
      const runs = await call<{
        runs: Array<{ dispatchStatus: string; requestId: string }>;
      }>(fixture.baseUrl, `/v1/threads/${thread.threadId}/runs`, {
        credential: bootstrapped.credential,
      });
      return runs.value.runs.some((run) => run.dispatchStatus === "completed");
    });
    await until(async () => {
      const context = await call<Record<string, unknown>>(
        fixture.baseUrl,
        "/v1/private-assistant/context",
        { credential: bootstrapped.credential },
      );
      return JSON.stringify(context.value).includes(
        "Private coordination finished.",
      );
    });

    expect(lostAcknowledgementWasAccepted).toBe(true);
    expect(memoPersistedBeforeMutation).toBe(true);
    expect(lostFactoryRequestId).toMatch(/^pi-input:[a-f0-9]{64}$/);
    expect(privateInputRequests).toBe(1);
    const privateContext = await call<Record<string, unknown>>(
      fixture.baseUrl,
      "/v1/private-assistant/context",
      { credential: bootstrapped.credential },
    );
    const visibleOutcome = JSON.stringify(privateContext.value);
    expect(visibleOutcome).toContain(lostFactoryRequestId!);
    expect(visibleOutcome).toContain("uncertain");
    expect(visibleOutcome).not.toContain("Factory operation was cancelled");
    const reconciledCommand = await ownerClient.getReceipt(
      lostFactoryRequestId!,
    );
    expect(reconciledCommand).toMatchObject({
      requestId: lostFactoryRequestId,
      threadId: thread.threadId,
      status: "accepted",
    });

    const runs = await call<{
      runs: Array<{ dispatchStatus: string; requestId: string }>;
    }>(fixture.baseUrl, `/v1/threads/${thread.threadId}/runs`, {
      credential: bootstrapped.credential,
    });
    expect(runs.value.runs).toHaveLength(1);
    expect(runs.value.runs[0]?.requestId).toBe(lostFactoryRequestId!);
    expect(runs.value.runs[0]?.dispatchStatus).toBe("completed");
    const events = await call<{
      events: Array<{
        type: string;
        actor: { kind: string; assistantId?: string; ownerId?: string };
      }>;
    }>(fixture.baseUrl, "/v1/events", { credential: bootstrapped.credential });
    const acceptedEvent = events.value.events.find(
      (event) =>
        event.type === "command.accepted" && event.actor.kind === "assistant",
    );
    expect(acceptedEvent?.actor).toMatchObject({
      kind: "assistant",
      assistantId: assistantActor.assistantId,
      ownerId: assistantActor.ownerId,
    });
    expect(
      await readFile(
        join(workspaceDirectory, "private-assistant-result.txt"),
        "utf8",
      ),
    ).toBe("effect from the assigned workspace");

    const originalReceipt = await ownerClient.getPrivateAssistantReceipt(
      input.inputId,
    );
    const duplicate = await ownerClient.submitPrivateAssistantInput(
      input.inputId,
      input.text,
    );
    expect(duplicate.submissionId).toBe(originalReceipt.submissionId);
    await expect(
      ownerClient.submitPrivateAssistantInput(input.inputId, "different text"),
    ).rejects.toMatchObject({
      status: 409,
      code: "private_assistant_input_conflict",
    });

    for (const credential of [
      guest.credential,
      viewer.credential,
      provisionedNode.credential.credential,
      otherAssistant.credential,
    ]) {
      const denied = await call(
        fixture.baseUrl,
        "/v1/private-assistant/status",
        {
          credential,
        },
      );
      expect(denied.status).toBe(403);
    }

    await fixture.reopen();
    ownerClient = new FactoryClient({
      baseUrl: fixture.baseUrl,
      credential: bootstrapped.credential,
    });
    const reopenedStatus = await ownerClient.getPrivateAssistantStatus();
    expect(reopenedStatus.available).toBe(true);
    const reopenedReceipt = await ownerClient.getPrivateAssistantReceipt(
      input.inputId,
    );
    expect(reopenedReceipt.submissionId).toBe(originalReceipt.submissionId);

    const hostFactory = fixture.host.factory;
    const owner = await hostFactory.authenticate(bootstrapped.credential);
    await hostFactory.revokeCredential(owner, assistant.credentialId);
    const historyAfterRevocation = await call<Record<string, unknown>>(
      fixture.baseUrl,
      "/v1/private-assistant/context",
      { credential: bootstrapped.credential },
    );
    expect(historyAfterRevocation.status).toBe(200);
    const parkedStatus = await ownerClient.getPrivateAssistantStatus();
    expect(parkedStatus).toMatchObject({ available: false, state: "parked" });
    await expect(
      ownerClient.submitPrivateAssistantInput(
        "private-input:revoked",
        "must not run",
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "private_assistant_unavailable",
    });

    const privateFiles = [
      join(runtimeDirectory, "private-assistant", "metadata.sqlite"),
      join(runtimeDirectory, "private-assistant", "pi-durable.sqlite"),
      join(runtimeDirectory, "private-assistant", "pi-durable.sqlite-wal"),
    ];
    const piPersistence: Buffer[] = [];
    for (const file of privateFiles) {
      try {
        const bytes = await readFile(file);
        expect(bytes.includes(Buffer.from(assistant.credential))).toBe(false);
        if (
          file.endsWith("pi-durable.sqlite") ||
          file.endsWith("pi-durable.sqlite-wal")
        ) {
          piPersistence.push(bytes);
        }
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    const persistedPiBytes = Buffer.concat(piPersistence);
    expect(persistedPiBytes.includes(Buffer.from(lostFactoryRequestId!))).toBe(
      true,
    );
  });
});
