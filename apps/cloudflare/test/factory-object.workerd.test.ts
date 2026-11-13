import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "bun:test";

type WorkerdId = { toString(): string };
type WorkerdNamespace = { idFromName(name: string): WorkerdId };

const bootstrapSecret = "workerd-factory-bootstrap-fixture";

describe("Cloudflare Factory in Miniflare workerd", () => {
  test("bootstraps, admits a managed input, and reconciles its receipt after Durable Object eviction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-factory-workerd-"));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "factory-workerd-entry.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "Could not bundle the Factory workerd test Worker",
      );
    }
    const miniflare = new Miniflare({
      name: "worker",
      script: await build.outputs[0]!.text(),
      modules: true,
      compatibilityDate: "2026-05-01",
      bindings: { UZINA_BOOTSTRAP_SECRET: bootstrapSecret },
      durableObjects: {
        FACTORY: { className: "TestFactory", useSQLite: true },
      },
    });
    const request = async <T>(
      path: string,
      options: {
        credential?: string;
        bootstrap?: boolean;
        body?: unknown;
      } = {},
    ): Promise<{ response: { status: number }; value: T }> => {
      const response = await miniflare.dispatchFetch(
        `http://uzina.test${path}`,
        {
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
        },
      );
      return { response, value: (await response.json()) as T };
    };
    try {
      const namespace = (await miniflare.getDurableObjectNamespace(
        "FACTORY",
      )) as unknown as WorkerdNamespace;
      const durableId = namespace.idFromName("factory-workerd-proof");
      const bootstrap = await request<{
        credential: string;
        actor: { kind: string };
      }>("/v1/bootstrap", {
        bootstrap: true,
        credential: bootstrapSecret,
        body: { name: "Cloud owner" },
      });
      expect(bootstrap.response.status).toBe(201);
      expect(bootstrap.value.actor.kind).toBe("human");
      const ownerCredential = bootstrap.value.credential;

      const project = await request<{ projectId: string }>("/v1/projects", {
        credential: ownerCredential,
        body: { projectId: "project:workerd", name: "Workerd proof" },
      });
      expect(project.response.status).toBe(201);
      const node = await request<{ node: { nodeId: string } }>("/v1/nodes", {
        credential: ownerCredential,
        body: { nodeId: "node:workerd", name: "Workerd node" },
      });
      expect(node.response.status).toBe(201);
      const workspace = await request<{ workspaceId: string }>(
        "/v1/workspaces",
        {
          credential: ownerCredential,
          body: {
            workspaceId: "workspace:workerd",
            nodeId: node.value.node.nodeId,
            name: "Workerd workspace",
          },
        },
      );
      expect(workspace.response.status).toBe(201);
      const thread = await request<{ threadId: string }>("/v1/threads", {
        credential: ownerCredential,
        body: {
          threadId: "thread:workerd",
          projectId: project.value.projectId,
          title: "Durable thread",
          target: {
            nodeId: node.value.node.nodeId,
            workspaceId: workspace.value.workspaceId,
          },
        },
      });
      expect(thread.response.status).toBe(201);
      const firstAcceptance = await request<{
        requestId: string;
        jobId: string;
        dispatchStatus: string;
      }>(`/v1/threads/${thread.value.threadId}/inputs`, {
        credential: ownerCredential,
        body: { requestId: "request:workerd", text: "one durable input" },
      });
      expect(firstAcceptance.response.status).toBe(202);
      expect(firstAcceptance.value).toMatchObject({
        requestId: "request:workerd",
        dispatchStatus: "unavailable",
      });

      await miniflare.unsafeEvictDurableObject("worker", "TestFactory", {
        id: durableId.toString(),
      });
      const recoveredReceipt = await request<{
        contractVersion: number;
        status: string;
        requestId: string;
        jobId: string;
        threadId: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
        dispatchStatus: string;
        acceptedAt: string;
      }>("/v1/commands/request:workerd", { credential: ownerCredential });
      expect(recoveredReceipt.response.status).toBe(200);
      expect(recoveredReceipt.value).toEqual({
        ...firstAcceptance.value,
        contractVersion: 1,
        status: "accepted",
        threadId: thread.value.threadId,
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspace.value.workspaceId,
        },
        ownershipGeneration: 0,
        acceptedAt: expect.any(String),
      });

      const duplicate = await request<{ jobId: string }>(
        `/v1/threads/${thread.value.threadId}/inputs`,
        {
          credential: ownerCredential,
          body: { requestId: "request:workerd", text: "one durable input" },
        },
      );
      expect(duplicate.value.jobId).toBe(firstAcceptance.value.jobId);
      const events = await request<{
        events: Array<{ type: string; requestId: string | null }>;
      }>("/v1/events", { credential: ownerCredential });
      expect(
        events.value.events.filter(
          (event) =>
            event.type === "command.accepted" &&
            event.requestId === "request:workerd",
        ),
      ).toHaveLength(1);
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
