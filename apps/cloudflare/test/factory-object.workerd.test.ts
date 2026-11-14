import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "bun:test";
import { ExecutionDaemon } from "../../daemon/src/execution/daemon";
import { HttpExecutionControllerConnector } from "../../daemon/src/execution/connector";

type WorkerdId = { toString(): string };
type WorkerdNamespace = {
  idFromName(name: string): WorkerdId;
  get(id: WorkerdId): { fetch(request: Request): Promise<Response> };
};

const bootstrapSecret = "workerd-factory-bootstrap-fixture";

describe("Cloudflare Factory in Miniflare workerd", () => {
  test("bootstraps, admits a managed input, and reconciles its receipt after Durable Object eviction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-factory-workerd-"));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "factory-workerd-entry.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      external: ["cloudflare:workers"],
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
        MANAGED_WORK: { className: "TestManagedWork", useSQLite: true },
      },
    });
    const request = async <T>(
      path: string,
      options: {
        credential?: string;
        bootstrap?: boolean;
        body?: unknown;
        method?: "GET" | "POST" | "PUT";
      } = {},
    ): Promise<{ response: { status: number }; value: T }> => {
      const response = await miniflare.dispatchFetch(
        `http://uzina.test${path}`,
        {
          method:
            options.method ?? (options.body === undefined ? "GET" : "POST"),
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

  test("production Factory workerd persists authenticated capture control and source report after eviction", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "uzina-capture-control-workerd-"),
    );
    const workspaceDirectory = join(directory, "workspace");
    await mkdir(workspaceDirectory);
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "factory-workerd-entry.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      external: ["cloudflare:workers"],
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "Could not bundle the capture-control workerd Worker",
      );
    }
    const miniflare = new Miniflare({
      name: "worker",
      script: await build.outputs[0]!.text(),
      modules: true,
      compatibilityDate: "2026-05-01",
      host: "127.0.0.1",
      port: 0,
      bindings: { UZINA_BOOTSTRAP_SECRET: bootstrapSecret },
      durableObjects: {
        FACTORY: { className: "TestFactory", useSQLite: true },
        MANAGED_WORK: { className: "TestManagedWork", useSQLite: true },
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
    let daemon: ExecutionDaemon | undefined;
    try {
      const namespace = (await miniflare.getDurableObjectNamespace(
        "FACTORY",
      )) as unknown as WorkerdNamespace;
      const durableId = namespace.idFromName("factory-workerd-proof");
      const bootstrap = await request<{ credential: string }>("/v1/bootstrap", {
        bootstrap: true,
        credential: bootstrapSecret,
        body: { name: "Capture workerd owner" },
      });
      const ownerCredential = bootstrap.value.credential;
      const project = await request<{ projectId: string }>("/v1/projects", {
        credential: ownerCredential,
        body: { projectId: "project:capture-workerd", name: "Capture workerd" },
      });
      const node = await request<{
        node: { nodeId: string };
        credential: string;
      }>("/v1/nodes", {
        credential: ownerCredential,
        body: { nodeId: "node:capture-workerd", name: "Capture node" },
      });
      const workspace = await request<{ workspaceId: string }>(
        "/v1/workspaces",
        {
          credential: ownerCredential,
          body: {
            workspaceId: "workspace:capture-workerd",
            nodeId: node.value.node.nodeId,
            name: "Capture workspace",
          },
        },
      );
      const thread = await request<{ threadId: string }>("/v1/threads", {
        credential: ownerCredential,
        body: {
          threadId: "thread:capture-workerd",
          projectId: project.value.projectId,
          title: "Capture workerd thread",
          target: {
            nodeId: node.value.node.nodeId,
            workspaceId: workspace.value.workspaceId,
          },
        },
      });
      const controllerUrl = (await miniflare.ready).toString();
      daemon = new ExecutionDaemon({
        databasePath: join(directory, "executor.sqlite"),
        nodeId: node.value.node.nodeId,
        nodeCredential: node.value.credential,
        workspaces: [
          {
            workspaceId: workspace.value.workspaceId,
            directory: workspaceDirectory,
          },
        ],
        daemonVersion: "capture-control-workerd-test",
      });
      const connector = new HttpExecutionControllerConnector({
        controllerUrl,
        nodeId: node.value.node.nodeId,
        credential: node.value.credential,
      });
      await connector.register(daemon.registerRequest());
      const admission = await request<{
        requestId: string;
        controlId: string;
        captureId: string;
        status: string;
      }>(`/v1/threads/${thread.value.threadId}/capture-controls`, {
        credential: ownerCredential,
        body: {
          contractVersion: 1,
          requestId: "request:capture-workerd-stable",
        },
      });
      expect(admission.response.status).toBe(202);
      expect(admission.value.status).toBe("queued");
      const control = await connector.claimCaptureControl();
      expect(control).toMatchObject({
        controlId: admission.value.controlId,
        captureId: admission.value.captureId,
        requestId: admission.value.requestId,
        nodeId: node.value.node.nodeId,
      });
      if (!control) throw new Error("Expected an assigned capture control");
      const claimedStatus = await request<{ status: string }>(
        `/v1/capture-controls/${admission.value.requestId}`,
        { credential: ownerCredential },
      );
      expect(claimedStatus.value.status).toBe("claimed");
      const report = daemon.executeCaptureControl(control);
      expect(report.status).toBe("source-capture-fenced");
      const localFenceStatus = await request<{ status: string }>(
        `/v1/capture-controls/${admission.value.requestId}`,
        { credential: ownerCredential },
      );
      expect(localFenceStatus.value.status).toBe("claimed");
      await expect(
        daemon.executeJob({
          contractVersion: 1,
          jobId: "job:workerd-capture-blocked-write",
          nodeId: node.value.node.nodeId,
          target: {
            nodeId: node.value.node.nodeId,
            workspaceId: workspace.value.workspaceId,
          },
          ownershipGeneration: 0,
          operation: "write-file",
          path: "blocked.txt",
          contentBase64: Buffer.from("blocked").toString("base64"),
        }),
      ).rejects.toThrow("workspace_capture_active");
      const wrongCorrelation = await request(
        `/v1/nodes/${node.value.node.nodeId}/capture-controls/${control.controlId}/report`,
        {
          credential: node.value.credential,
          body: { ...report, captureId: "capture:stale-correlation" },
        },
      );
      expect(wrongCorrelation.response.status).toBe(409);
      await connector.reportCaptureControl(report);
      daemon.markCaptureControlReported(report.controlId, report);
      const statusBeforeEviction = await request<{
        status: string;
        controlId: string;
        captureId: string;
        sourceFence?: { receiptSha256: string };
      }>(`/v1/capture-controls/${admission.value.requestId}`, {
        credential: ownerCredential,
      });
      expect(statusBeforeEviction.value).toMatchObject({
        status: "source-capture-fenced",
        controlId: admission.value.controlId,
        captureId: admission.value.captureId,
      });
      expect(statusBeforeEviction.value.sourceFence?.receiptSha256).toMatch(
        /^[a-f0-9]{64}$/,
      );

      await miniflare.unsafeEvictDurableObject("worker", "TestFactory", {
        id: durableId.toString(),
      });
      const recovered = await request<{
        status: string;
        controlId: string;
        captureId: string;
        sourceFence?: { receiptSha256: string };
      }>(`/v1/capture-controls/${admission.value.requestId}`, {
        credential: ownerCredential,
      });
      expect(recovered.value).toEqual(statusBeforeEviction.value);
      const duplicateAdmission = await request<{
        status: string;
        controlId: string;
        captureId: string;
      }>(`/v1/threads/${thread.value.threadId}/capture-controls`, {
        credential: ownerCredential,
        body: {
          contractVersion: 1,
          requestId: "request:capture-workerd-stable",
        },
      });
      expect(duplicateAdmission.value).toMatchObject({
        status: "source-capture-fenced",
        controlId: admission.value.controlId,
        captureId: admission.value.captureId,
      });
      await connector.reportCaptureControl(report);
      expect(daemon.pendingCaptureControlReports()).toEqual([]);
    } finally {
      daemon?.close();
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("workerd persists scoped viewer discussion and rechecks access after Durable Object eviction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-access-workerd-"));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "factory-workerd-entry.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      external: ["cloudflare:workers"],
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "Could not bundle the scoped-access workerd test Worker",
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
        MANAGED_WORK: { className: "TestManagedWork", useSQLite: true },
      },
    });
    const request = async <T>(
      path: string,
      options: {
        credential?: string;
        bootstrap?: boolean;
        body?: unknown;
        method?: "GET" | "POST" | "PUT";
      } = {},
    ): Promise<{ response: { status: number }; value: T }> => {
      const response = await miniflare.dispatchFetch(
        `http://uzina.test${path}`,
        {
          method:
            options.method ?? (options.body === undefined ? "GET" : "POST"),
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
      const bootstrap = await request<{ credential: string }>("/v1/bootstrap", {
        bootstrap: true,
        credential: bootstrapSecret,
        body: { name: "Access owner" },
      });
      const ownerCredential = bootstrap.value.credential;
      const project = await request<{ projectId: string }>("/v1/projects", {
        credential: ownerCredential,
        body: {
          projectId: "project:workerd-access",
          name: "Scoped workerd project",
        },
      });
      const node = await request<{ node: { nodeId: string } }>("/v1/nodes", {
        credential: ownerCredential,
        body: { nodeId: "node:workerd-access", name: "Scoped workerd node" },
      });
      const workspace = await request<{ workspaceId: string }>(
        "/v1/workspaces",
        {
          credential: ownerCredential,
          body: {
            workspaceId: "workspace:workerd-access",
            nodeId: node.value.node.nodeId,
            name: "Scoped workerd workspace",
          },
        },
      );
      const thread = await request<{ threadId: string }>("/v1/threads", {
        credential: ownerCredential,
        body: {
          threadId: "thread:workerd-access",
          projectId: project.value.projectId,
          title: "Scoped workerd thread",
          target: {
            nodeId: node.value.node.nodeId,
            workspaceId: workspace.value.workspaceId,
          },
        },
      });
      const invitation = await request<{
        invitation: { invitationId: string };
        code: string;
      }>("/v1/invitations", {
        credential: ownerCredential,
        body: {
          role: "viewer",
          grants: [{ type: "thread", resourceId: thread.value.threadId }],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      expect(invitation.response.status).toBe(201);
      const joined = await request<{
        credential: string;
        participant: { userId: string };
      }>("/v1/invitations/redeem", {
        body: { code: invitation.value.code, displayName: "Workerd viewer" },
      });
      const viewerCredential = joined.value.credential;
      const comment = await request<{
        discussionId: string;
        actor: { userId: string };
        displayName: string;
      }>(`/v1/threads/${thread.value.threadId}/discussion`, {
        credential: viewerCredential,
        body: { text: "Persistent viewer discussion" },
      });
      expect(comment.response.status).toBe(201);
      expect(comment.value.actor.userId).toBe(joined.value.participant.userId);
      expect(comment.value.displayName).toBe("Workerd viewer");
      expect(
        (
          await request(`/v1/threads/${thread.value.threadId}/inputs`, {
            credential: viewerCredential,
            body: {
              requestId: "request:workerd-viewer-denied",
              text: "No Pi admission",
            },
          })
        ).response.status,
      ).toBe(403);

      const managedNamespace = (await miniflare.getDurableObjectNamespace(
        "MANAGED_WORK",
      )) as unknown as WorkerdNamespace;
      const managedId = managedNamespace.idFromName(thread.value.threadId);
      const managedObject = managedNamespace.get(managedId);
      const observations = async () =>
        (
          await managedObject.fetch(new Request("http://managed/observations"))
        ).json() as Promise<{
          modelCalls: number;
        }>;
      expect((await observations()).modelCalls).toBe(0);
      await miniflare.unsafeEvictDurableObject("worker", "TestFactory", {
        id: durableId.toString(),
      });
      const persistedDiscussion = await request<{
        discussion: Array<{ discussionId: string; actor: { userId: string } }>;
      }>(`/v1/threads/${thread.value.threadId}/discussion`, {
        credential: viewerCredential,
      });
      expect(persistedDiscussion.value.discussion).toMatchObject([
        {
          discussionId: comment.value.discussionId,
          actor: { userId: joined.value.participant.userId },
        },
      ]);
      expect((await observations()).modelCalls).toBe(0);

      const changed = await request(
        `/v1/people/${joined.value.participant.userId}/access`,
        {
          method: "PUT",
          credential: ownerCredential,
          body: { role: "viewer", grants: [] },
        },
      );
      expect(changed.response.status).toBe(200);
      await miniflare.unsafeEvictDurableObject("worker", "TestFactory", {
        id: durableId.toString(),
      });
      expect(
        (
          await request(`/v1/threads/${thread.value.threadId}/discussion`, {
            credential: viewerCredential,
          })
        ).response.status,
      ).toBe(404);
      const deniedEvents = await request<{ events: unknown[] }>(
        "/v1/events?after=0",
        {
          credential: viewerCredential,
        },
      );
      expect(deniedEvents.value.events).toEqual([]);
      expect((await observations()).modelCalls).toBe(0);
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
