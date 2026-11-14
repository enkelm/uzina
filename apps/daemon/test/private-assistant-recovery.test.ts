import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FactoryService } from "@uzina/core";
import { BunFactoryDatabase } from "../src/factory/sqlite";
import { ExecutionDaemon } from "../src/execution/daemon";
import { HttpExecutionControllerConnector } from "../src/execution/connector";
import { ExecutionLoop } from "../src/execution/loop";

setDefaultTimeout(45_000);

type ChildEvent = {
  kind: string;
  baseUrl?: string;
  status?: number;
  requestId?: string;
  threadId?: string;
  text?: string;
  memoPersisted?: boolean;
};

const testDirectories: string[] = [];
const childProcesses: Array<ReturnType<typeof Bun.spawn>> = [];

async function stopChild(
  child: ReturnType<typeof Bun.spawn>,
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited after reporting its result.
  }
  await child.exited.catch(() => {});
  const index = childProcesses.indexOf(child);
  if (index >= 0) childProcesses.splice(index, 1);
}

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    await child.exited.catch(() => {});
  }
  for (const directory of testDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function startPrivateAssistantChild(values: Record<string, string>): {
  child: ReturnType<typeof Bun.spawn>;
  nextEvent(kind: string, timeoutMs?: number): Promise<ChildEvent>;
} {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...values,
  };
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "private-assistant-recovery-child.ts"),
    ],
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  childProcesses.push(child);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    child,
    async nextEvent(kind, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const event = JSON.parse(line) as ChildEvent;
          if (event.kind === "child-error") {
            throw new Error(`Private assistant child failed (${event.kind})`);
          }
          if (event.kind === kind) return event;
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Timed out waiting for private assistant child event ${kind}`,
          );
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out waiting for private assistant child event ${kind}`,
                ),
              ),
            remaining,
          );
        });
        try {
          const chunk = await Promise.race([reader.read(), timeout]);
          if (chunk.done)
            throw new Error(`Private assistant child exited before ${kind}`);
          buffer += decoder.decode(chunk.value, { stream: true });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    },
  };
}

async function call<T>(
  baseUrl: string,
  path: string,
  options: { credential?: string; body?: unknown } = {},
): Promise<{ status: number; value: T }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.credential
        ? { authorization: `Bearer ${options.credential}` }
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

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for restarted private assistant work");
}

describe("private assistant pending-task recovery across Bun restart", () => {
  test("replays the same memoized Factory mutation after startup identity recovery without new input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-private-recovery-"));
    testDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const runtimeDirectory = join(directory, "managed-work");
    const workspaceDirectory = join(directory, "workspace");
    await mkdir(workspaceDirectory);
    const bootstrapSecret = "private-recovery-bootstrap-dummy";
    const database = new BunFactoryDatabase(databasePath);
    const factory = new FactoryService(database, bootstrapSecret);
    const ownerCredential = await factory.bootstrap(bootstrapSecret, "Owner");
    const owner = await factory.authenticate(ownerCredential.credential);
    const project = factory.createProject(
      owner,
      "project:private-recovery",
      "Private recovery project",
    );
    const provisionedNode = await factory.provisionNode(
      owner,
      "node:private-recovery",
      "Private recovery executor",
    );
    const workspace = factory.createWorkspace(
      owner,
      "workspace:private-recovery",
      provisionedNode.node.nodeId,
      "Private recovery workspace",
    );
    const thread = factory.createThread(owner, {
      threadId: "thread:private-recovery",
      projectId: project.projectId,
      title: "Recover the existing private task",
      target: {
        nodeId: provisionedNode.node.nodeId,
        workspaceId: workspace.workspaceId,
      },
    });
    const assistant = await factory.provisionCredential(
      owner,
      "assistant",
      "Private recovery assistant",
      [{ type: "project", resourceId: project.projectId }],
    );
    if (assistant.actor.kind !== "assistant") {
      throw new Error("Factory provisioned the wrong credential kind");
    }
    database.close();

    const childConfig = {
      PRIVATE_ASSISTANT_TEST_DATABASE: databasePath,
      PRIVATE_ASSISTANT_TEST_RUNTIME: runtimeDirectory,
      PRIVATE_ASSISTANT_TEST_BOOTSTRAP: bootstrapSecret,
      PRIVATE_ASSISTANT_TEST_BEARER: assistant.credential,
      PRIVATE_ASSISTANT_TEST_CREDENTIAL_ID: assistant.credentialId,
      PRIVATE_ASSISTANT_TEST_ASSISTANT_ID: assistant.actor.assistantId,
      PRIVATE_ASSISTANT_TEST_OWNER_ID: assistant.actor.ownerId,
      PRIVATE_ASSISTANT_TEST_THREAD_ID: thread.threadId,
    };
    const first = startPrivateAssistantChild({
      ...childConfig,
      PRIVATE_ASSISTANT_TEST_MODE: "block-ack",
    });
    const firstReady = await first.nextEvent("ready");
    const firstBaseUrl = firstReady.baseUrl!;
    const inputId = "private-input:restart-recovery";
    const inputText = "OWNER-PRIVATE-COORDINATION";
    const acceptedPrivateInput = await call<{
      inputId: string;
      submissionId: string;
    }>(firstBaseUrl, "/v1/private-assistant/inputs", {
      credential: ownerCredential.credential,
      body: { inputId, text: inputText },
    });
    expect(acceptedPrivateInput.status).toBe(202);
    const firstMutation = await first.nextEvent("mutation-accepted");
    expect(firstMutation).toMatchObject({
      status: 202,
      threadId: thread.threadId,
      text: "BOUNDED-WORK-EFFECT",
      memoPersisted: true,
    });
    expect(firstMutation.requestId).toMatch(/^pi-input:[a-f0-9]{64}$/);
    await stopChild(first.child, "SIGKILL");

    const resumed = startPrivateAssistantChild({
      ...childConfig,
      PRIVATE_ASSISTANT_TEST_MODE: "resume",
    });
    const identityFailure = await resumed.nextEvent("identity-failed");
    expect(identityFailure.kind).toBe("identity-failed");
    const resumedReady = await resumed.nextEvent("ready");
    const baseUrl = resumedReady.baseUrl!;
    const recoveredStatus = await call<{ available: boolean; state: string }>(
      baseUrl,
      "/v1/private-assistant/status",
      { credential: ownerCredential.credential },
    );
    expect(recoveredStatus).toMatchObject({
      status: 200,
      value: { available: true, state: "ready" },
    });

    const replayedMutation = await resumed.nextEvent(
      "mutation-accepted",
      5_000,
    );
    expect(replayedMutation).toMatchObject({
      status: 202,
      requestId: firstMutation.requestId,
      threadId: firstMutation.threadId,
      text: firstMutation.text,
      memoPersisted: true,
    });

    const execution = new ExecutionDaemon({
      databasePath: join(directory, "executor.sqlite"),
      nodeId: provisionedNode.node.nodeId,
      nodeCredential: provisionedNode.credential.credential,
      workspaces: [
        { workspaceId: workspace.workspaceId, directory: workspaceDirectory },
      ],
      daemonVersion: "private-assistant-recovery-test",
    });
    const executionAbort = new AbortController();
    const executionLoop = new ExecutionLoop({
      daemon: execution,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: provisionedNode.node.nodeId,
        credential: provisionedNode.credential.credential,
      }),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 500,
    }).run(executionAbort.signal);
    try {
      await until(async () => {
        const nodes = await call<{
          nodes: Array<{ nodeId: string; availability: string }>;
        }>(baseUrl, "/v1/nodes", { credential: ownerCredential.credential });
        return nodes.value.nodes.some(
          (node) =>
            node.nodeId === provisionedNode.node.nodeId &&
            node.availability === "online",
        );
      });
      await until(async () => {
        const runs = await call<{
          runs: Array<{ requestId: string; dispatchStatus: string }>;
        }>(baseUrl, `/v1/threads/${thread.threadId}/runs`, {
          credential: ownerCredential.credential,
        });
        return runs.value.runs.some(
          (run) =>
            run.requestId === firstMutation.requestId &&
            run.dispatchStatus === "completed",
        );
      });
      await until(async () => {
        const context = await call<Record<string, unknown>>(
          baseUrl,
          "/v1/private-assistant/context",
          { credential: ownerCredential.credential },
        );
        return JSON.stringify(context.value).includes(
          "Private coordination finished.",
        );
      });

      const runs = await call<{
        runs: Array<{ requestId: string; dispatchStatus: string }>;
      }>(baseUrl, `/v1/threads/${thread.threadId}/runs`, {
        credential: ownerCredential.credential,
      });
      expect(runs.value.runs).toHaveLength(1);
      expect(runs.value.runs[0]).toMatchObject({
        requestId: firstMutation.requestId,
        dispatchStatus: "completed",
      });
      expect(
        await readFile(
          join(workspaceDirectory, "private-assistant-result.txt"),
          "utf8",
        ),
      ).toBe("effect from the assigned workspace");
      const receipt = await call<{
        requestId: string;
        threadId: string;
        status: string;
        target: { nodeId: string; workspaceId: string };
      }>(baseUrl, `/v1/commands/${firstMutation.requestId}`, {
        credential: ownerCredential.credential,
      });
      expect(receipt.value).toMatchObject({
        requestId: firstMutation.requestId,
        threadId: thread.threadId,
        status: "accepted",
        target: {
          nodeId: provisionedNode.node.nodeId,
          workspaceId: workspace.workspaceId,
        },
      });
      const commandEvents = await call<{
        events: Array<{ type: string; requestId: string | null }>;
      }>(baseUrl, "/v1/events", { credential: ownerCredential.credential });
      expect(
        commandEvents.value.events.filter(
          (event) =>
            event.type === "command.accepted" &&
            event.requestId === firstMutation.requestId,
        ),
      ).toHaveLength(1);
      const privateReceipt = await call<{
        inputId: string;
        submissionId: string | null;
      }>(baseUrl, `/v1/private-assistant/receipts/${inputId}`, {
        credential: ownerCredential.credential,
      });
      expect(privateReceipt.value).toMatchObject({
        inputId,
        submissionId: acceptedPrivateInput.value.submissionId,
      });
      const piBytes = Buffer.concat([
        await readFile(
          join(runtimeDirectory, "private-assistant", "pi-durable.sqlite"),
        ),
        await readFile(
          join(runtimeDirectory, "private-assistant", "pi-durable.sqlite-wal"),
        ).catch(() => Buffer.alloc(0)),
      ]);
      expect(piBytes.includes(Buffer.from(assistant.credential))).toBe(false);
      expect(piBytes.includes(Buffer.from(firstMutation.requestId!))).toBe(
        true,
      );
    } finally {
      executionAbort.abort();
      await executionLoop.catch(() => {});
      execution.close();
    }
  });
});
