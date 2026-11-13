import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import type { ManagedModels } from "@uzina/pi-runtime";
import {
  ExecutionDaemon,
  type WorkspaceMapping,
} from "../src/execution/daemon";
import { HttpExecutionControllerConnector } from "../src/execution/connector";
import { ExecutionLoop } from "../src/execution/loop";
import {
  createStandaloneFactoryServer,
  type StandaloneFactoryServer,
} from "../src/factory/standalone";
import { deterministicFailingModels } from "../../../packages/pi-runtime/test-support/deterministic-failing-model";
import { deterministicToolModels } from "../../../packages/pi-runtime/test-support/deterministic-tool-model";

const fixtures: Array<{ directory: string; close(): Promise<void> }> = [];

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

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for composed local managed execution");
}

async function scenario(options: {
  models: ManagedModels;
  modelProvider: string;
  modelId: string;
  directoryPrefix: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), options.directoryPrefix));
  const workspaceDirectory = join(directory, "workspace");
  await mkdir(workspaceDirectory);
  let host: StandaloneFactoryServer | undefined;
  let execution: ExecutionDaemon | undefined;
  let abort: AbortController | undefined;
  let runningLoop: Promise<void> | undefined;
  const bootstrapSecret = `${options.directoryPrefix}-bootstrap`;
  const openHost = () =>
    createStandaloneFactoryServer({
      databasePath: join(directory, "factory.sqlite"),
      runtimeDirectory: join(directory, "managed-work"),
      bootstrapSecret,
      models: options.models,
      modelProvider: options.modelProvider,
      modelId: options.modelId,
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
    workspaceDirectory,
    async stopExecution() {
      abort?.abort();
      await runningLoop;
      runningLoop = undefined;
      abort = undefined;
      execution?.close();
      execution = undefined;
    },
    async reopenFactory() {
      await this.stopExecution();
      await host?.close();
      host = await openHost();
    },
    async close() {
      await this.stopExecution();
      await host?.close();
      host = undefined;
    },
  };
  fixtures.push(fixture);

  const bootstrapped = await call<{ credential: string }>(
    fixture.baseUrl,
    "/v1/bootstrap",
    {
      credential: bootstrapSecret,
      bootstrap: true,
      body: { name: "Local test owner" },
    },
  );
  expect(bootstrapped.status).toBe(201);
  const owner = bootstrapped.value.credential;
  const project = await call<{ projectId: string }>(
    fixture.baseUrl,
    "/v1/projects",
    {
      credential: owner,
      body: { projectId: "project:local-proof", name: "Local proof" },
    },
  );
  const node = await call<{
    node: { nodeId: string };
    credential: string;
  }>(fixture.baseUrl, "/v1/nodes", {
    credential: owner,
    body: { nodeId: "node:local-proof", name: "Temporary local executor" },
  });
  const workspace = await call<{ workspaceId: string }>(
    fixture.baseUrl,
    "/v1/workspaces",
    {
      credential: owner,
      body: {
        workspaceId: "workspace:local-proof",
        nodeId: node.value.node.nodeId,
        name: "Selected temporary workspace",
      },
    },
  );
  const mapping: WorkspaceMapping = {
    workspaceId: workspace.value.workspaceId,
    directory: workspaceDirectory,
  };
  execution = new ExecutionDaemon({
    databasePath: join(directory, "executor.sqlite"),
    nodeId: node.value.node.nodeId,
    nodeCredential: node.value.credential,
    workspaces: [mapping],
    daemonVersion: "slice-4b-test",
  });
  abort = new AbortController();
  runningLoop = new ExecutionLoop({
    daemon: execution,
    controller: new HttpExecutionControllerConnector({
      controllerUrl: fixture.baseUrl,
      nodeId: node.value.node.nodeId,
      credential: node.value.credential,
    }),
    pollIntervalMs: 20,
    heartbeatIntervalMs: 500,
  }).run(abort.signal);
  await until(async () => {
    const nodes = await call<{ nodes: Array<{ availability: string }> }>(
      fixture.baseUrl,
      "/v1/nodes",
      { credential: owner },
    );
    return nodes.value.nodes[0]?.availability === "online";
  });
  const thread = await call<{ threadId: string }>(
    fixture.baseUrl,
    "/v1/threads",
    {
      credential: owner,
      body: {
        threadId: "thread:local-proof",
        projectId: project.value.projectId,
        title: "Managed tool proof",
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspace.value.workspaceId,
        },
      },
    },
  );
  return Object.assign(fixture, {
    owner,
    nodeId: node.value.node.nodeId,
    workspaceId: workspace.value.workspaceId,
    threadId: thread.value.threadId,
  });
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("standalone local Factory managed Pi composition", () => {
  test("accepted input selects one bounded remote write and settles with persistent context and events", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "managed-result.txt",
        content: "Pi wrote this remotely",
      },
      answer: "The assigned workspace was updated.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-proof-",
    });
    const input = {
      requestId: "request:local-proof",
      text: "Update the result in my selected workspace.",
    };
    const accepted = await call<{
      jobId: string;
      dispatchStatus: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    expect(accepted.status).toBe(202);
    expect(accepted.value.dispatchStatus).toBe("queued");

    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });

    expect(
      await readFile(
        join(local.workspaceDirectory, "managed-result.txt"),
        "utf8",
      ),
    ).toBe("Pi wrote this remotely");
    expect(provider.requests()).toBeGreaterThanOrEqual(2);

    const retry = await call<{ jobId: string; dispatchStatus: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    expect(retry.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "completed",
    });
    expect(provider.requests()).toBeGreaterThanOrEqual(2);

    const context = await call<{ runtime: { messages: readonly unknown[] } }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "The assigned workspace was updated.",
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "Pi wrote this remotely",
    );
    const status = await call<{
      runtime: {
        context: { messages: readonly unknown[] };
        inspection: unknown;
      };
    }>(local.baseUrl, `/v1/threads/${local.threadId}/status`, {
      credential: local.owner,
    });
    expect(JSON.stringify(status.value.runtime.context)).toContain(
      "The assigned workspace was updated.",
    );
    const unauthorizedContext = await fetch(
      new URL(`/v1/threads/${local.threadId}/context`, local.baseUrl),
    );
    expect(unauthorizedContext.status).toBe(401);

    const events = await call<{
      events: Array<{
        type: string;
        requestId: string | null;
        payload: Record<string, unknown>;
      }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const proofEvents = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "command.accepted",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "execution.accepted",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "execution.completed",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "dispatch.completed",
    );
    expect(
      proofEvents.find((event) => event.type === "execution.completed")
        ?.payload,
    ).toMatchObject({
      target: accepted.value.target,
      ownershipGeneration: accepted.value.ownershipGeneration,
      piCallId: "call:remote-effect-1",
    });
    expect(
      proofEvents.filter((event) => event.type === "execution.accepted"),
    ).toHaveLength(1);
    expect(
      proofEvents.filter((event) => event.type === "execution.completed"),
    ).toHaveLength(1);
  });

  test("rejects model-selected node, workspace and generation instead of changing accepted placement", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "forged-placement.txt",
        content: "must not execute",
        nodeId: "node:other",
        workspaceId: "workspace:other",
        ownershipGeneration: 99,
      },
      answer: "The model-selected destination was rejected.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-placement-reject-",
    });
    const input = {
      requestId: "request:placement-rejected",
      text: "Write a file but do not change the selected destination.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "forged-placement.txt"),
        "utf8",
      ).catch(() => null),
    ).toBeNull();
    const events = await call<{
      events: Array<{ type: string; requestId: string | null }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const related = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(related.map((event) => event.type)).not.toContain(
      "execution.accepted",
    );
  });

  test("a real provider failure settles a persistent command as failed without inventing an executor effect", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-model-failure-",
    });
    const input = {
      requestId: "request:model-failure",
      text: "The selected provider will fail before choosing a tool.",
    };
    const accepted = await call<{ jobId: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "failed";
    });
    const receipt = await call<{
      jobId: string;
      dispatchStatus: string;
      outcome?: string;
    }>(local.baseUrl, `/v1/commands/${input.requestId}`, {
      credential: local.owner,
    });
    expect(receipt.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "failed",
    });
    const events = await call<{
      events: Array<{ type: string; requestId: string | null }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const modelEvents = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(modelEvents.map((event) => event.type)).toContain("dispatch.failed");
    expect(modelEvents.map((event) => event.type)).not.toContain(
      "execution.accepted",
    );
    const context = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "deterministic provider failure",
    );
  });

  test("a timed-out command keeps its actual partial cwd effect and uncertain receipt after reopen", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: [
          "/bin/sh",
          "-c",
          "printf before > partial-effect.txt; sleep 5; printf after >> partial-effect.txt",
        ],
        cwd: "subdir",
        timeoutMs: 500,
      },
      answer: "The command outcome requires reconciliation.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-command-uncertain-",
    });
    await mkdir(join(local.workspaceDirectory, "subdir"));
    const input = {
      requestId: "request:command-uncertain",
      text: "Run the bounded command in the selected relative directory.",
    };
    const accepted = await call<{ jobId: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "uncertain";
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "subdir", "partial-effect.txt"),
        "utf8",
      ),
    ).toBe("before");
    await local.reopenFactory();
    const recovered = await call<{
      jobId: string;
      dispatchStatus: string;
      outcome?: string;
      executionEffects: Array<{
        jobId: string;
        status: string;
        operation: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
        errorCode?: string;
      }>;
    }>(local.baseUrl, `/v1/commands/${input.requestId}`, {
      credential: local.owner,
    });
    expect(recovered.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "uncertain",
      executionEffects: [
        {
          status: "uncertain",
          operation: "argv-command",
          target: { nodeId: local.nodeId, workspaceId: local.workspaceId },
          ownershipGeneration: 0,
          errorCode: "command_timed_out",
        },
      ],
    });
    const context = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "The command outcome requires reconciliation.",
    );
    expect(
      await readFile(
        join(local.workspaceDirectory, "subdir", "partial-effect.txt"),
        "utf8",
      ),
    ).toBe("before");
  });

  test("rejects a model-selected cwd escape before a workspace effect", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: ["/bin/sh", "-c", "printf escaped > escaped.txt"],
        cwd: "../outside",
      },
      answer: "The requested working directory was rejected.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-command-cwd-reject-",
    });
    const outsideDirectory = join(local.directory, "outside");
    await mkdir(outsideDirectory);
    const input = {
      requestId: "request:cwd-rejected",
      text: "Run the command outside this workspace.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(join(outsideDirectory, "escaped.txt")).catch(() => null),
    ).toBeNull();
    const events = await call<{
      events: Array<{
        type: string;
        requestId: string | null;
        payload: Record<string, unknown>;
      }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    expect(
      events.value.events.find(
        (event) =>
          event.type === "execution.failed" &&
          event.requestId === input.requestId,
      )?.payload,
    ).toMatchObject({ errorCode: "unsafe_workspace_path" });
  });
});
