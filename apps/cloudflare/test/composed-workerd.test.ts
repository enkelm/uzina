import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Log, LogLevel, Miniflare } from "miniflare";
import { afterEach, describe, expect, test } from "bun:test";
import { buildCloudflareWorkerArtifact } from "../scripts/build-worker";
import { ExecutionDaemon } from "../../daemon/src/execution/daemon";
import { HttpExecutionControllerConnector } from "../../daemon/src/execution/connector";
import { ExecutionLoop } from "../../daemon/src/execution/loop";
import { FACTORY_DURABLE_OBJECT_NAME } from "../src/factory-object";

type WorkerdId = { toString(): string };
type WorkerdNamespace = { idFromName(name: string): WorkerdId };

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

class CapturingLog extends Log {
  readonly messages: string[] = [];

  protected override log(message: string): void {
    this.messages.push(message);
  }
}

function openAIResponseStream(item: Record<string, unknown>): string {
  const response = {
    id: "resp_uzina_test",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "gpt-4o-mini",
    output: [item],
    usage: {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 18,
    },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(
    "Timed out waiting for the composed workerd managed execution",
  );
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("production-shaped Cloudflare composition in Miniflare workerd", () => {
  test("production managed-work binding fails closed on a missing provider credential", async () => {
    const artifact = await buildCloudflareWorkerArtifact();
    const miniflare = new Miniflare({
      name: "worker",
      script: artifact.script,
      modules: true,
      compatibilityDate: "2026-05-01",
      bindings: {
        UZINA_MODEL_PROVIDER: "openai",
        UZINA_MODEL_ID: "gpt-4o-mini",
      },
      durableObjects: {
        FACTORY: { className: "FactoryObject", useSQLite: true },
        MANAGED_WORK: { className: "ManagedWorkObject", useSQLite: true },
      },
    });
    try {
      const namespace = (await miniflare.getDurableObjectNamespace(
        "MANAGED_WORK",
      )) as unknown as {
        idFromName(name: string): unknown;
        get(id: unknown): { status(): Promise<unknown> };
      };
      const work = namespace.get(
        namespace.idFromName("missing-provider-secret"),
      );
      let error: unknown;
      try {
        await work.status();
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("UZINA_MODEL_API_KEY");
    } finally {
      await miniflare.dispose();
    }
  });

  test("sanitizes provider errors and settles real-provider retry outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-provider-errors-"));
    const workspaceDirectory = join(directory, "workspace");
    await mkdir(workspaceDirectory);
    const artifact = await buildCloudflareWorkerArtifact();
    const apiKey = "sk-test-provider-error-dummy-credential";
    const invalidKeyBody = JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${apiKey}. You can find your API key at https://platform.openai.com/account/api-keys.`,
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    });
    const serverErrorBody = JSON.stringify({
      error: {
        message: "The server had an error while processing your request.",
        type: "server_error",
        code: "internal_error",
      },
    });
    const modelCalls: Array<{
      authorization: string;
      body: Record<string, unknown>;
      responseBody: string;
      status: number;
    }> = [];
    let transientAttempts = 0;
    const openAITransport = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (
        url.origin !== "https://api.openai.com" ||
        url.pathname !== "/v1/responses"
      ) {
        return new Response("Unexpected outbound request", { status: 502 });
      }
      const body = (await request.clone().json()) as Record<string, unknown>;
      const serialized = JSON.stringify(body);
      const unauthorized = serialized.includes("provider-unauthorized-case");
      const transient = serialized.includes("provider-transient-case");
      const recoveredTransient = transient && transientAttempts++ > 0;
      const responseBody = unauthorized
        ? invalidKeyBody
        : recoveredTransient
          ? openAIResponseStream({
              id: "msg_uzina_retry_1",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  annotations: [],
                  text: "The transient provider failure recovered.",
                },
              ],
            })
          : serverErrorBody;
      const status = unauthorized ? 401 : recoveredTransient ? 200 : 503;
      modelCalls.push({
        authorization: request.headers.get("authorization") ?? "",
        body,
        responseBody,
        status,
      });
      return new Response(responseBody, {
        status,
        headers: {
          "content-type":
            status === 200 ? "text/event-stream" : "application/json",
        },
      });
    };
    const log = new CapturingLog(LogLevel.DEBUG);
    const miniflare = new Miniflare({
      name: "worker",
      script: artifact.script,
      modules: true,
      compatibilityDate: "2026-05-01",
      host: "127.0.0.1",
      port: 0,
      log,
      outboundService: openAITransport,
      bindings: {
        UZINA_BOOTSTRAP_SECRET: "workerd-provider-error-bootstrap",
        UZINA_MODEL_PROVIDER: "openai",
        UZINA_MODEL_ID: "gpt-4o-mini",
        UZINA_MODEL_API_KEY: apiKey,
      },
      durableObjects: {
        FACTORY: { className: "FactoryObject", useSQLite: true },
        MANAGED_WORK: { className: "ManagedWorkObject", useSQLite: true },
      },
    });
    try {
      const baseUrl = (await miniflare.ready).toString();
      const bootstrapped = await call<{ credential: string }>(
        baseUrl,
        "/v1/bootstrap",
        {
          credential: "workerd-provider-error-bootstrap",
          bootstrap: true,
          body: { name: "Provider error owner" },
        },
      );
      expect(bootstrapped.status).toBe(201);
      const owner = bootstrapped.value.credential;
      const project = await call<{ projectId: string }>(
        baseUrl,
        "/v1/projects",
        {
          credential: owner,
          body: {
            projectId: "project:provider-errors",
            name: "Provider error proof",
          },
        },
      );
      const provisioned = await call<{
        node: { nodeId: string };
        credential: string;
      }>(baseUrl, "/v1/nodes", {
        credential: owner,
        body: { nodeId: "node:provider-errors", name: "Unclaimed executor" },
      });
      const workspace = await call<{ workspaceId: string }>(
        baseUrl,
        "/v1/workspaces",
        {
          credential: owner,
          body: {
            workspaceId: "workspace:provider-errors",
            nodeId: provisioned.value.node.nodeId,
            name: "Unmodified workspace",
          },
        },
      );
      const cases = [
        {
          requestId: "request:provider-unauthorized",
          threadId: "thread:provider-unauthorized",
          inputText: "provider-unauthorized-case",
          expectedDispatchStatus: "failed",
        },
        {
          requestId: "request:provider-transient",
          threadId: "thread:provider-transient",
          inputText: "provider-transient-case",
          expectedDispatchStatus: "completed",
        },
        {
          requestId: "request:provider-server-error",
          threadId: "thread:provider-server-error",
          inputText: "provider-server-error-case",
          expectedDispatchStatus: "failed",
        },
      ] as const;
      let ownershipGeneration = 0;
      for (const scenario of cases) {
        const thread = await call<{ ownershipGeneration: number }>(
          baseUrl,
          "/v1/threads",
          {
            credential: owner,
            body: {
              threadId: scenario.threadId,
              projectId: project.value.projectId,
              title: scenario.threadId,
              target: {
                nodeId: provisioned.value.node.nodeId,
                workspaceId: workspace.value.workspaceId,
              },
            },
          },
        );
        ownershipGeneration = thread.value.ownershipGeneration;
      }
      await call(
        baseUrl,
        `/v1/nodes/${provisioned.value.node.nodeId}/register`,
        {
          credential: provisioned.value.credential,
          body: {
            contractVersion: 1,
            nodeId: provisioned.value.node.nodeId,
            daemonVersion: "no-executor-provider-error-test",
            workspaces: [
              {
                workspaceId: workspace.value.workspaceId,
                ownershipGeneration,
                state: "active",
              },
            ],
            capabilities: {
              fileRead: true,
              fileWrite: true,
              argvCommand: true,
              rexProcessCreate: true,
              rexProcessInspect: true,
              rexProcessStop: true,
            },
          },
        },
      );

      for (const scenario of cases) {
        const accepted = await call<{
          requestId: string;
          dispatchStatus: string;
        }>(baseUrl, `/v1/threads/${scenario.threadId}/inputs`, {
          credential: owner,
          body: { requestId: scenario.requestId, text: scenario.inputText },
        });
        expect(accepted.status).toBe(202);
        expect(accepted.value).toMatchObject({
          requestId: scenario.requestId,
        });
        expect(["queued", "running"]).toContain(accepted.value.dispatchStatus);
      }

      for (const scenario of cases) {
        await until(
          async () => {
            const receipt = await call<{ dispatchStatus: string }>(
              baseUrl,
              `/v1/commands/${scenario.requestId}`,
              { credential: owner },
            );
            return (
              receipt.value.dispatchStatus === scenario.expectedDispatchStatus
            );
          },
          scenario.expectedDispatchStatus === "failed" &&
            scenario.inputText === "provider-server-error-case"
            ? 45_000
            : 15_000,
        );
        const receipt = await call<{
          requestId: string;
          dispatchStatus: string;
          outcome?: string;
          executionEffects?: unknown[];
        }>(baseUrl, `/v1/commands/${scenario.requestId}`, {
          credential: owner,
        });
        expect(receipt.value).toMatchObject({
          requestId: scenario.requestId,
          dispatchStatus: scenario.expectedDispatchStatus,
        });
        expect(receipt.value.executionEffects ?? []).toEqual([]);
        if (scenario.expectedDispatchStatus === "failed") {
          expect(receipt.value.outcome).toContain("unanswered");
        }
      }
      expect(modelCalls.map((entry) => entry.status)).toContain(401);
      expect(modelCalls.map((entry) => entry.status)).toContain(200);
      expect(modelCalls.filter((entry) => entry.status === 503).length).toBe(5);
      expect(
        modelCalls
          .filter((entry) =>
            JSON.stringify(entry.body).includes("provider-transient-case"),
          )
          .map((entry) => entry.status),
      ).toEqual([503, 200]);
      expect(
        modelCalls
          .filter((entry) =>
            JSON.stringify(entry.body).includes("provider-server-error-case"),
          )
          .map((entry) => entry.status),
      ).toEqual([503, 503, 503, 503]);
      expect(modelCalls.map((entry) => entry.authorization)).toEqual(
        modelCalls.map(() => `Bearer ${apiKey}`),
      );
      expect(modelCalls.map((entry) => entry.responseBody)).toContain(
        invalidKeyBody,
      );
      expect(invalidKeyBody).toContain(apiKey);

      const runtimeByThread = new Map<string, unknown>();
      for (const scenario of cases) {
        const context = await call<{ runtime: unknown }>(
          baseUrl,
          `/v1/threads/${scenario.threadId}/context`,
          { credential: owner },
        );
        const status = await call<{ runtime: unknown }>(
          baseUrl,
          `/v1/threads/${scenario.threadId}/status`,
          { credential: owner },
        );
        runtimeByThread.set(scenario.threadId, {
          context: context.value.runtime,
          status: status.value.runtime,
        });
        const contextJson = JSON.stringify(context.value.runtime);
        const statusJson = JSON.stringify(status.value.runtime);
        if (scenario.expectedDispatchStatus === "failed") {
          expect(contextJson).toContain('"stopReason":"error"');
          expect(statusJson).toContain('"stopReason":"error"');
        } else {
          expect(contextJson).toContain(
            "The transient provider failure recovered.",
          );
          expect(statusJson).toContain(
            "The transient provider failure recovered.",
          );
        }
      }
      const events = await call<{
        events: Array<{
          type: string;
          requestId: string | null;
          payload: Record<string, unknown>;
        }>;
      }>(baseUrl, "/v1/events", { credential: owner });
      const relatedEvents = events.value.events.filter((event) =>
        cases.some((scenario) => event.requestId === scenario.requestId),
      );
      expect(
        relatedEvents
          .filter((event) => event.type === "dispatch.failed")
          .map((event) => event.requestId),
      ).toEqual(
        cases
          .filter((scenario) => scenario.expectedDispatchStatus === "failed")
          .map((scenario) => scenario.requestId),
      );
      expect(
        relatedEvents
          .filter((event) => event.type === "dispatch.completed")
          .map((event) => event.requestId),
      ).toEqual(["request:provider-transient"]);
      expect(
        relatedEvents.filter((event) => event.type === "command.accepted"),
      ).toHaveLength(cases.length);
      const exposedSurfaces = JSON.stringify({
        receipts: await Promise.all(
          cases.map((scenario) =>
            call(baseUrl, `/v1/commands/${scenario.requestId}`, {
              credential: owner,
            }),
          ),
        ),
        runtimeByThread: [...runtimeByThread],
        events: relatedEvents,
        requestBodies: modelCalls.map((entry) => entry.body),
        logs: log.messages,
      });
      expect(exposedSurfaces).not.toContain(apiKey);
      expect(exposedSurfaces).not.toContain(`Bearer ${apiKey}`);

      const nodeClaim = await call<{ job: unknown }>(
        baseUrl,
        `/v1/nodes/${provisioned.value.node.nodeId}/jobs/claim`,
        {
          credential: provisioned.value.credential,
          body: { contractVersion: 1, nodeId: provisioned.value.node.nodeId },
        },
      );
      expect(nodeClaim.value.job).toBeNull();
      expect(await readdir(workspaceDirectory)).toEqual([]);

      const factoryNamespace = (await miniflare.getDurableObjectNamespace(
        "FACTORY",
      )) as unknown as WorkerdNamespace;
      await miniflare.unsafeEvictDurableObject("worker", "FactoryObject", {
        id: factoryNamespace.idFromName(FACTORY_DURABLE_OBJECT_NAME).toString(),
      });
      const managedNamespace = (await miniflare.getDurableObjectNamespace(
        "MANAGED_WORK",
      )) as unknown as WorkerdNamespace;
      for (const scenario of cases) {
        await miniflare.unsafeEvictDurableObject(
          "worker",
          "ManagedWorkObject",
          {
            id: managedNamespace.idFromName(scenario.threadId).toString(),
          },
        );
      }
      const persistedSurfaces = await Promise.all(
        cases.map(async (scenario) => ({
          receipt: await call(baseUrl, `/v1/commands/${scenario.requestId}`, {
            credential: owner,
          }),
          context: await call(
            baseUrl,
            `/v1/threads/${scenario.threadId}/context`,
            {
              credential: owner,
            },
          ),
          status: await call(
            baseUrl,
            `/v1/threads/${scenario.threadId}/status`,
            {
              credential: owner,
            },
          ),
        })),
      );
      const persistedJson = JSON.stringify({
        surfaces: persistedSurfaces,
        events: await call(baseUrl, "/v1/events", { credential: owner }),
        logs: log.messages,
      });
      expect(persistedJson).not.toContain(apiKey);
      expect(persistedJson).not.toContain(`Bearer ${apiKey}`);
      expect(JSON.stringify(persistedSurfaces)).toContain(
        '"dispatchStatus":"failed"',
      );
      expect(JSON.stringify(persistedSurfaces)).toContain(
        '"dispatchStatus":"completed"',
      );
      expect(JSON.stringify(persistedSurfaces)).toContain(
        '"stopReason":"error"',
      );
      expect(JSON.stringify(persistedSurfaces)).toContain(
        "The transient provider failure recovered.",
      );
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  test("routes accepted Pi work through Durable Objects and real HTTP execution into a persistent workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-composed-workerd-"));
    const workspaceDirectory = join(directory, "workspace");
    await mkdir(workspaceDirectory);
    const artifact = await buildCloudflareWorkerArtifact();
    let modelCalls = 0;
    const authorizationHeaders: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const openAITransport = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (
        url.origin !== "https://api.openai.com" ||
        url.pathname !== "/v1/responses"
      ) {
        return new Response("Unexpected outbound request", { status: 502 });
      }
      modelCalls += 1;
      authorizationHeaders.push(request.headers.get("authorization") ?? "");
      requestBodies.push(
        (await request.clone().json()) as Record<string, unknown>,
      );
      const item =
        modelCalls === 1
          ? {
              id: "fc_uzina_1",
              type: "function_call",
              status: "completed",
              call_id: "call_uzina_1",
              name: "remote_write_file",
              arguments: JSON.stringify({
                path: "workerd-result.txt",
                content: "workerd Pi effect",
              }),
            }
          : {
              id: "msg_uzina_1",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  annotations: [],
                  text: "The workerd workspace was updated.",
                },
              ],
            };
      return new Response(openAIResponseStream(item), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const miniflare = new Miniflare({
      name: "worker",
      script: artifact.script,
      modules: true,
      compatibilityDate: "2026-05-01",
      host: "127.0.0.1",
      port: 0,
      outboundService: openAITransport,
      bindings: {
        UZINA_BOOTSTRAP_SECRET: "workerd-composed-bootstrap",
        UZINA_MODEL_PROVIDER: "openai",
        UZINA_MODEL_ID: "gpt-4o-mini",
        UZINA_MODEL_API_KEY: "sk-test-only-not-a-provider-credential",
      },
      durableObjects: {
        FACTORY: { className: "FactoryObject", useSQLite: true },
        MANAGED_WORK: { className: "ManagedWorkObject", useSQLite: true },
      },
    });
    let daemon: ExecutionDaemon | undefined;
    let abort: AbortController | undefined;
    let runningLoop: Promise<void> | undefined;
    try {
      const baseUrl = (await miniflare.ready).toString();
      const bootstrapped = await call<{ credential: string }>(
        baseUrl,
        "/v1/bootstrap",
        {
          credential: "workerd-composed-bootstrap",
          bootstrap: true,
          body: { name: "Workerd owner" },
        },
      );
      expect(bootstrapped.status).toBe(201);
      const owner = bootstrapped.value.credential;
      const project = await call<{ projectId: string }>(
        baseUrl,
        "/v1/projects",
        {
          credential: owner,
          body: {
            projectId: "project:workerd-composed",
            name: "Workerd proof",
          },
        },
      );
      const provisioned = await call<{
        node: { nodeId: string };
        credential: string;
      }>(baseUrl, "/v1/nodes", {
        credential: owner,
        body: { nodeId: "node:workerd-composed", name: "Temporary executor" },
      });
      const workspace = await call<{ workspaceId: string }>(
        baseUrl,
        "/v1/workspaces",
        {
          credential: owner,
          body: {
            workspaceId: "workspace:workerd-composed",
            nodeId: provisioned.value.node.nodeId,
            name: "Workerd selected workspace",
          },
        },
      );

      daemon = new ExecutionDaemon({
        databasePath: join(directory, "executor.sqlite"),
        nodeId: provisioned.value.node.nodeId,
        nodeCredential: provisioned.value.credential,
        workspaces: [
          {
            workspaceId: workspace.value.workspaceId,
            directory: workspaceDirectory,
          },
        ],
        daemonVersion: "slice-4b-workerd-test",
      });
      abort = new AbortController();
      runningLoop = new ExecutionLoop({
        daemon,
        controller: new HttpExecutionControllerConnector({
          controllerUrl: baseUrl,
          nodeId: provisioned.value.node.nodeId,
          credential: provisioned.value.credential,
        }),
        pollIntervalMs: 20,
        heartbeatIntervalMs: 500,
      }).run(abort.signal);

      await until(async () => {
        const nodes = await call<{ nodes: Array<{ availability: string }> }>(
          baseUrl,
          "/v1/nodes",
          { credential: owner },
        );
        return nodes.value.nodes[0]?.availability === "online";
      });
      const thread = await call<{ threadId: string }>(baseUrl, "/v1/threads", {
        credential: owner,
        body: {
          threadId: "thread:workerd-composed",
          projectId: project.value.projectId,
          title: "Workerd managed thread",
          target: {
            nodeId: provisioned.value.node.nodeId,
            workspaceId: workspace.value.workspaceId,
          },
        },
      });
      const input = {
        requestId: "request:workerd-composed",
        text: "Write the result in the assigned workspace.",
      };

      // Deliberately drop the HTTP acknowledgement; the accepted identity is recovered by query.
      const lostAcceptance = await fetch(
        new URL(`/v1/threads/${thread.value.threadId}/inputs`, baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        },
      );
      expect(lostAcceptance.status).toBe(202);
      const recoveredAcceptance = await call<{
        requestId: string;
        jobId: string;
        dispatchStatus: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
      }>(baseUrl, `/v1/commands/${input.requestId}`, { credential: owner });
      expect(recoveredAcceptance.value).toMatchObject({
        requestId: input.requestId,
        dispatchStatus: "running",
        target: {
          nodeId: provisioned.value.node.nodeId,
          workspaceId: workspace.value.workspaceId,
        },
      });

      await until(async () => {
        const receipt = await call<{ dispatchStatus: string }>(
          baseUrl,
          `/v1/commands/${input.requestId}`,
          { credential: owner },
        );
        return receipt.value.dispatchStatus === "completed";
      });
      expect(
        await readFile(join(workspaceDirectory, "workerd-result.txt"), "utf8"),
      ).toBe("workerd Pi effect");

      const factoryNamespace = (await miniflare.getDurableObjectNamespace(
        "FACTORY",
      )) as unknown as WorkerdNamespace;
      const factoryId = factoryNamespace.idFromName(
        FACTORY_DURABLE_OBJECT_NAME,
      );
      await miniflare.unsafeEvictDurableObject("worker", "FactoryObject", {
        id: factoryId.toString(),
      });
      const managedNamespace = (await miniflare.getDurableObjectNamespace(
        "MANAGED_WORK",
      )) as unknown as WorkerdNamespace;
      const workId = managedNamespace.idFromName(thread.value.threadId);
      await miniflare.unsafeEvictDurableObject("worker", "ManagedWorkObject", {
        id: workId.toString(),
      });

      const duplicate = await call<{
        jobId: string;
        dispatchStatus: string;
        executionEffects: Array<{
          jobId: string;
          status: string;
          operation: string;
          target: { nodeId: string; workspaceId: string };
          ownershipGeneration: number;
        }>;
      }>(baseUrl, `/v1/threads/${thread.value.threadId}/inputs`, {
        credential: owner,
        body: input,
      });
      expect(duplicate.value).toMatchObject({
        jobId: recoveredAcceptance.value.jobId,
        dispatchStatus: "completed",
        executionEffects: [
          {
            status: "completed",
            operation: "write-file",
            target: recoveredAcceptance.value.target,
            ownershipGeneration: recoveredAcceptance.value.ownershipGeneration,
          },
        ],
      });
      const context = await call<{ runtime: { messages: readonly unknown[] } }>(
        baseUrl,
        `/v1/threads/${thread.value.threadId}/context`,
        { credential: owner },
      );
      expect(JSON.stringify(context.value.runtime)).toContain(
        "The workerd workspace was updated.",
      );
      expect(JSON.stringify(context.value.runtime)).toContain(
        "workerd Pi effect",
      );
      const eventPage = await call<{
        events: Array<{
          type: string;
          requestId: string | null;
          payload: Record<string, unknown>;
        }>;
      }>(baseUrl, "/v1/events", { credential: owner });
      const related = eventPage.value.events.filter(
        (event) => event.requestId === input.requestId,
      );
      expect(related.map((event) => event.type)).toContain(
        "execution.accepted",
      );
      expect(related.map((event) => event.type)).toContain(
        "execution.completed",
      );
      expect(related.map((event) => event.type)).toContain(
        "dispatch.completed",
      );
      expect(
        related.filter((event) => event.type === "execution.accepted"),
      ).toHaveLength(1);
      expect(
        related.find((event) => event.type === "execution.completed")?.payload,
      ).toMatchObject({
        target: recoveredAcceptance.value.target,
        ownershipGeneration: recoveredAcceptance.value.ownershipGeneration,
        piCallId: expect.stringContaining("call_uzina_1"),
      });
      expect(modelCalls).toBe(2);
      expect(authorizationHeaders).toEqual([
        "Bearer sk-test-only-not-a-provider-credential",
        "Bearer sk-test-only-not-a-provider-credential",
      ]);
      expect(JSON.stringify(requestBodies[0]?.tools)).toContain(
        "remote_write_file",
      );
      expect(JSON.stringify(requestBodies[1]?.input)).toContain(
        "workerd Pi effect",
      );
    } finally {
      abort?.abort();
      if (runningLoop) await runningLoop;
      daemon?.close();
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
