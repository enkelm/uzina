import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  type Conversation,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { FactoryClient } from "@uzina/client";
import { FactoryService } from "@uzina/core";
import { createFactoryBotExtension } from "@uzina/pi-runtime";
import type { NativeProvisioningStatus } from "@uzina/contracts/native-provisioning";
import type { Goal } from "../../../packages/pi-runtime/src/factory-bot-state";
import { factoryBotTestModels } from "../../../packages/pi-runtime/test-support/factory-bot-model";
import { BunFactoryDatabase } from "../src/factory/sqlite";
import { createStandaloneFactoryServer } from "../src/factory/standalone";
import { openBunSqliteStorage } from "../src/runtime/sqlite";
import { ExecutionDaemon } from "../src/execution/daemon";
import { FactoryWorkerHost } from "../src/execution/factory-worker";

async function until(check: () => boolean | Promise<boolean>, duration = 7000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Provisioning scenario did not settle");
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "uzina-provision-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const factoryPath = join(root, "factory.sqlite");
  const db = new BunFactoryDatabase(factoryPath);
  const core = new FactoryService(db, "bootstrap");
  const owner = await core.bootstrap("bootstrap", "Owner");
  const session = await core.authenticate(owner.credential);
  core.createProject(session, "project:test", "Test");
  core.createProject(session, "project:other", "Other");
  const node = await core.provisionNode(session, "node:test", "Test");
  core.createWorkspace(session, "workspace:test", "node:test", "Test");
  const assistant = await core.provisionCredential(
    session,
    "assistant",
    "Coordinator",
    [{ type: "project", resourceId: "project:test" }],
  );
  db.close();
  const runnerEntry = resolve(import.meta.dir, "fixtures/native-mcp-client.ts");
  const statePath = join(root, "rex.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      instanceId: "server:provision-test",
      jobs: {},
      backgroundEntry: runnerEntry,
    }),
  );
  const rexExecutable = join(root, "rex-fixture");
  writeFileSync(
    rexExecutable,
    `#!/usr/bin/env bun\nprocess.env.UZINA_REX_FIXTURE_STATE = ${JSON.stringify(statePath)};\nawait import(${JSON.stringify(resolve(import.meta.dir, "fixtures/rex-tool-cli.ts"))});\n`,
    { mode: 0o700 },
  );
  const executable = join(root, "agent-help");
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf "%s\\n" "--extension --session-id --session-dir --config --cd --no-daemon"\n',
    { mode: 0o700 },
  );
  const drivers = Object.fromEntries(
    ["pi", "codex"].map((agent) => {
      const directory = join(root, agent);
      mkdirSync(directory);
      mkdirSync(join(directory, "requests"));
      mkdirSync(join(directory, "responses"));
      return [agent, directory];
    }),
  );
  const config = {
    nodeId: "node:test",
    databasePath: join(root, "executor.sqlite"),
    workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    rexServer: "unix:///rex-test.sock",
    rexExecutable,
    nativeAgents: {
      stateDirectory: join(root, "private"),
      bunExecutable: process.execPath,
      runnerEntry,
      rexToolsEntry: resolve(import.meta.dir, "../src/rex-tools.ts"),
      factoryWorkerEntry: resolve(import.meta.dir, "../src/factory-worker.ts"),
      profiles: Object.fromEntries(
        (["pi", "codex"] as const).map((agent) => [
          agent,
          {
            agent,
            executable,
            environment: { NATIVE_TEST_DRIVER: drivers[agent] },
          },
        ]),
      ),
    },
    targets: [
      {
        targetId: "local",
        projectId: "project:test",
        profileIds: ["pi", "codex"],
        target: { nodeId: "node:test", workspaceId: "workspace:test" },
        ownershipGeneration: 0,
        allowAssistant: true,
        maxWorkers: 2,
      },
      {
        targetId: "owner-only",
        projectId: "project:test",
        profileIds: ["pi"],
        target: { nodeId: "node:test", workspaceId: "workspace:test" },
        ownershipGeneration: 0,
        allowAssistant: false,
        maxWorkers: 1,
      },
    ],
  };
  const openExecutor = (removed = false) => {
    const { factoryWorkerEntry, ...nativeAgents } = config.nativeAgents;
    const executor = new ExecutionDaemon({
      ...config,
      nodeCredential: node.credential.credential,
      nativeAgents: removed
        ? { ...nativeAgents, profiles: { removed: nativeAgents.profiles.pi! } }
        : nativeAgents,
    });
    return {
      executor,
      workspaceDirectories: { "workspace:test": workspace },
      nativeWorkerProvisioning: {
        launcher: executor.nativeAgents!,
        factoryWorkerEntry,
        targets: removed ? [] : config.targets,
      },
    };
  };
  let native = openExecutor();
  const model = factoryBotTestModels();
  const serverOptions = {
    databasePath: factoryPath,
    runtimeDirectory: join(root, "runtime"),
    models: model.models,
    modelProvider: "uzina-test",
    modelId: "fixed-model",
    port: 0,
  };
  let server = await createStandaloneFactoryServer({
    ...serverOptions,
    workspaceDirectories: native.workspaceDirectories,
    nativeWorkerProvisioning: native.nativeWorkerProvisioning,
  });
  let origin = server.server.url.origin;
  const ownerClient = () =>
    new FactoryClient({ baseUrl: origin, credential: owner.credential });
  let lostProvisioningResponse = false,
    loseResponse = false;
  const provisioningResponses: { requestId: string; status: number }[] = [];
  const client = new FactoryClient({
    baseUrl: origin,
    credential: assistant.credential,
    fetch: (async (input, init) => {
      const response = await fetch(input, init);
      if (
        init?.method === "POST" &&
        String(input).endsWith("/v1/native-worker-provisionings")
      )
        provisioningResponses.push({
          requestId: JSON.parse(String(init.body)).requestId,
          status: response.status,
        });
      if (
        loseResponse &&
        init?.method === "POST" &&
        String(input).endsWith("/v1/native-worker-provisionings") &&
        response.ok
      ) {
        loseResponse = false;
        lostProvisioningResponse = true;
        throw new TypeError("Lost provisioning response");
      }
      return response;
    }) as typeof fetch,
  });
  const registry = createRegistry();
  registry.install(
    createFactoryBotExtension(client, {
      credentialToRedact: assistant.credential,
    }),
  );
  let harness: Harness,
    conversation: Conversation,
    clock = Date.now(),
    sequence = 0;
  async function openBot() {
    harness = await Harness.open(
      await openBunSqliteStorage(join(root, "bot.sqlite")),
      { registry, models: model.models, now: () => clock },
      context,
    );
    conversation = await harness.root(context, {
      agent: { model: { provider: "uzina-test", modelId: "fixed-model" } },
    });
    harness.resume();
  }
  await openBot();
  async function board<T>(args: JsonObject) {
    const submission = await conversation.submit(
      {
        type: "input",
        requestId: `test:${++sequence}`,
        content: JSON.stringify({ tool: "factory_board", args }),
      },
      context,
    );
    const result = await submission.wait(context);
    if (result.type === "write" || result.status !== "done")
      throw new Error("Board input unanswered");
    const view = await conversation.context(context, { at: result.answer });
    const answer = view.messages.at(-1);
    if (answer?.role !== "assistant" || answer.content[0]?.type !== "text")
      throw new Error("Missing board answer");
    return JSON.parse(answer.content[0].text) as { error: boolean; value: T };
  }
  let driverSequence = 0;
  async function tool(agent: string, name: string, input: JsonObject) {
    const file = `${++driverSequence}.json`;
    writeFileSync(
      join(drivers[agent]!, "requests", `${file}.tmp`),
      JSON.stringify({ server: name, input }),
    );
    // Atomic publish: the fixture never reads a partially written request.
    const { renameSync } = await import("node:fs");
    renameSync(
      join(drivers[agent]!, "requests", `${file}.tmp`),
      join(drivers[agent]!, "requests", file),
    );
    const path = join(drivers[agent]!, "responses", file);
    await until(() => existsSync(path));
    return JSON.parse(readFileSync(path, "utf8")) as {
      isError?: boolean;
      structuredContent: { result?: any; error?: string };
    };
  }
  return {
    root,
    config,
    workspace,
    statePath,
    drivers,
    board,
    client,
    tool,
    get server() {
      return server;
    },
    get native() {
      return native;
    },
    ownerClient,
    async ready(requestId: string) {
      let status: NativeProvisioningStatus | undefined;
      await until(async () => {
        try {
          status = await client.getNativeWorkerProvisioning(requestId);
          return status.status === "ready";
        } catch {
          return false;
        }
      });
      return status!;
    },
    provisioningResponses,
    loseNextResponse() {
      loseResponse = true;
    },
    async waitLostResponse() {
      await until(() => lostProvisioningResponse);
    },
    async tick() {
      clock += 31_000;
      harness.resume();
      await Bun.sleep(20);
    },
    async reopenBot() {
      await harness.close(context);
      await openBot();
    },
    async reopenHostWithoutProfiles() {
      const port = server.server.port!;
      await server.close();
      await native.executor.nativeAgents!.close();
      native.executor.close();
      native = openExecutor(true);
      server = await createStandaloneFactoryServer({
        ...serverOptions,
        port,
        workspaceDirectories: native.workspaceDirectories,
        nativeWorkerProvisioning: native.nativeWorkerProvisioning,
      });
      origin = server.server.url.origin;
    },
    async openForeignFactory() {
      return createStandaloneFactoryServer({
        ...serverOptions,
        databasePath: join(root, "foreign.sqlite"),
        runtimeDirectory: join(root, "foreign-runtime"),
        nativeWorkerProvisioning: native.nativeWorkerProvisioning,
      });
    },
    credential(requestId: string) {
      const path = join(
        config.nativeAgents.stateDirectory,
        "factory-workers",
        server.factory.coordination.provisioningScopeId,
        createHash("sha256").update(requestId).digest("hex"),
        "server.json",
      );
      return { path, config: JSON.parse(readFileSync(path, "utf8")) };
    },
    async setGrant(enabled: boolean) {
      const ownerSession = await server.factory.authenticate(owner.credential);
      server.factory.setAssistantCredentialGrants(
        ownerSession,
        assistant.credentialId,
        [
          {
            type: "project",
            resourceId: enabled ? "project:test" : "project:other",
          },
        ],
      );
    },
    secrets: [
      owner.credential,
      node.credential.credential,
      assistant.credential,
    ],
    async close() {
      await harness.close(context).catch(() => {});
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.identityPausePath)
        writeFileSync(`${state.identityPausePath}.release`, "cleanup");
      await server.close();
      await native.executor.nativeAgents!.close();
      const jobs = Object.values(
        JSON.parse(readFileSync(statePath, "utf8")).jobs,
      ) as { pid?: number }[];
      const pids = jobs.flatMap((job) => (job.pid ? [job.pid] : []));
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      await until(
        () =>
          pids.every((pid) => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          }),
        12_000,
      );
      native.executor.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("durable coordinator provisioning survives a lost reply/restart; native MCP workers ask, receive Owner answers and report without equating acknowledgement with execution", async () => {
  const f = await fixture();
  try {
    const targets = await f.board<{ targets: { targetId: string }[] }>({
      op: "view",
      projectId: "project:test",
      section: "targets",
    });
    expect(targets.error).toBe(false);
    expect(targets.value.targets.map((target) => target.targetId)).toEqual([
      "local",
      "owner-only",
    ]);
    f.loseNextResponse();
    const queued = await f.board<{ requestId: string }>({
      op: "provision",
      projectId: "project:test",
      targetId: "local",
      profileId: "pi",
      name: "Pi worker",
    });
    expect(queued.error).toBe(false);
    await f.waitLostResponse();
    await f.reopenBot();
    await f.tick();
    const pi = await f.ready(queued.value.requestId);
    expect(pi.mcp?.factory.verifiedAt).toBeDefined();
    expect(pi.mcp?.factory.client?.name).toBe("test-native-pi");
    expect(pi.mcp?.rex.status).toBe("ready");
    expect(
      JSON.parse(readFileSync(join(f.drivers.pi!, "started"), "utf8"))
        .catalogues,
    ).toEqual({ rex: ["rex"], factory: ["factory"] });
    const codex = await f.client.provisionNativeWorker({
      requestId: "provision:codex",
      projectId: "project:test",
      targetId: "local",
      profileId: "codex",
      name: "Codex worker",
    });
    const readyCodex = await f.ready(codex.request.requestId);
    expect(readyCodex.mcp?.factory.client?.name).toBe("test-native-codex");
    expect(readyCodex.workerId).not.toBe(pi.workerId);
    expect(readyCodex.process?.sessionId).not.toBe(pi.process?.sessionId);
    expect(
      (await f.tool("codex", "factory", { op: "inbox" })).structuredContent
        .result.messages,
    ).toEqual([]);
    const worker = await f.ownerClient().getNativeWorker(pi.workerId);
    expect(worker.provisioningStatus).toBe("ready");
    expect(worker.rex).toEqual({
      sessionId: pi.process!.sessionId!,
      blockId: pi.process!.blockId!,
    });
    const credential = f.credential(pi.request.requestId);
    expect(lstatSync(credential.path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(pi)).not.toContain(credential.config.credential);
    for (const secret of f.secrets) {
      expect(readFileSync(credential.path, "utf8")).not.toContain(secret);
      expect(JSON.stringify(pi)).not.toContain(secret);
    }
    await expect(FactoryWorkerHost.open(credential.config)).rejects.toThrow(
      "factory_worker_journal_in_use",
    );
    await expect(
      FactoryWorkerHost.open({
        ...credential.config,
        workerId: readyCodex.workerId,
        journalPath: join(f.root, "private", "wrong-binding.sqlite"),
      }),
    ).rejects.toThrow("factory_worker_binding_conflict");
    expect(
      (
        await f.tool("pi", "factory", {
          op: "status",
          projectId: "project:other",
        })
      ).isError,
    ).toBe(true);
    const captured = await f.board<{ card: Goal }>({
      op: "capture",
      projectId: "project:test",
      title: "Bounded effect",
      brief: {
        objective: "Write a bounded result",
        inputs: [],
        deliverables: ["result.txt"],
        acceptance: ["Result file contains verified text"],
        constraints: ["Keep native chats in Rex"],
      },
    });
    const card = captured.value.card;
    expect(
      (
        await f.board({
          op: "dispatch",
          cardId: card.cardId,
          expectedRevision: card.revision,
          target: { kind: "native", workerId: pi.workerId },
        })
      ).error,
    ).toBe(false);
    let inbox: any;
    await until(async () => {
      inbox = (await f.tool("pi", "factory", { op: "inbox" })).structuredContent
        .result;
      return inbox.messages.length === 1;
    });
    const assignment = inbox.messages[0];
    expect(
      (
        await f.tool("pi", "factory", {
          op: "acknowledge",
          messageId: assignment.messageId,
        })
      ).isError,
    ).not.toBe(true);
    await f.tick();
    const waiting = await f.board<{ card: Goal }>({
      op: "view",
      cardId: card.cardId,
    });
    expect(waiting.value.card.state).toBe("waiting");
    const question = {
      op: "ask",
      itemId: "question:effect",
      title: "Which text?",
      text: "Please authorize the bounded result text.",
      blocking: true,
    };
    expect(
      (await f.tool("pi", "factory", question)).structuredContent.result.kind,
    ).toBe("question");
    expect(
      (await f.tool("pi", "factory", question)).structuredContent.result.itemId,
    ).toBe("question:effect");
    await f.ownerClient().decideCoordinationItem("question:effect", {
      requestId: "decision:effect",
      action: "answer",
      text: "Write verified.",
    });
    const answerInbox = (await f.tool("pi", "factory", { op: "inbox" }))
      .structuredContent.result;
    expect(answerInbox.messages).toHaveLength(1);
    expect(answerInbox.messages[0].text).toBe("Write verified.");
    await f.tool("pi", "factory", {
      op: "acknowledge",
      messageId: answerInbox.messages[0].messageId,
    });
    const effect = await f.tool("pi", "rex", {
      op: "run",
      requestId: "effect:verified",
      argv: ["/bin/sh", "-c", "printf verified > result.txt"],
      waitMs: 0,
    });
    expect(effect.isError).not.toBe(true);
    expect(readFileSync(join(f.workspace, "result.txt"), "utf8")).toBe(
      "verified",
    );
    const report = {
      op: "report",
      itemId: waiting.value.card.attempt!.resultItemId,
      title: "Bounded result",
      text: "result.txt contains verified; command effect:verified completed.",
    };
    expect(
      (await f.tool("pi", "factory", report)).structuredContent.result.kind,
    ).toBe("report");
    expect(
      (await f.tool("pi", "factory", report)).structuredContent.result.itemId,
    ).toBe(report.itemId);
    await f.tick();
    const reviewed = await f.board<{ card: Goal }>({
      op: "view",
      cardId: card.cardId,
    });
    expect(reviewed.value.card.state).toBe("review");
    expect(
      (
        await f.board({
          op: "accept",
          cardId: card.cardId,
          expectedRevision: reviewed.value.card.revision,
          review: [
            {
              criterion: "Result file contains verified text",
              evidence: `coordination:${report.itemId}`,
              note: "Verified the bounded effect and its correlated report.",
            },
          ],
        })
      ).error,
    ).toBe(false);
    expect(
      (await f.ownerClient().listNativeWorkers("project:test")).workers,
    ).toHaveLength(2);
    await f.reopenHostWithoutProfiles();
    expect(
      (await f.client.provisionNativeWorker(pi.request)).process?.processId,
    ).toBe(pi.process?.processId);
    expect(
      (await f.client.getNativeWorkerProvisioning(pi.request.requestId)).status,
    ).toBe("ready");
    expect(JSON.parse(readFileSync(f.statePath, "utf8")).launchCount).toBe(3); // two agents + the one bounded command
    expect(readdirSync(f.workspace)).toEqual(["result.txt"]);
    const refreshed = await f.board<NativeProvisioningStatus>({
      op: "view",
      provisioningRequestId: pi.request.requestId,
    });
    expect(refreshed.value.status).toBe("ready");
    await expect(f.openForeignFactory()).rejects.toThrow(
      "native_agent_factory_scope_conflict",
    );
    await f.ownerClient().revokeNativeWorker(pi.workerId);
    expect((await f.tool("pi", "factory", { op: "inbox" })).isError).toBe(true);
    expect(
      (await f.tool("codex", "factory", { op: "status" })).isError,
    ).not.toBe(true);
    expect(
      (await f.client.getNativeWorkerProvisioning(pi.request.requestId))
        .errorCode,
    ).toBe("worker_revoked");
    for (let index = 0; index < 20; index++)
      await f.ownerClient().messageNativeWorker(readyCodex.workerId, {
        requestId: `large:${index}`,
        text: "漢".repeat(8000),
      });
    const bounded = await f.tool("codex", "factory", {
      op: "inbox",
      limit: 100,
    });
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(256 * 1024);
    expect(bounded.structuredContent.result.truncated).toBe(true);
    const firstIds = bounded.structuredContent.result.messages.map(
      (message: { messageId: string }) => message.messageId,
    );
    expect(firstIds.length).toBeGreaterThan(0);
    await f.tool("codex", "factory", {
      op: "acknowledge",
      messageId: firstIds[0],
    });
    const remaining = (
      await f.tool("codex", "factory", { op: "inbox", limit: 100 })
    ).structuredContent.result.messages;
    expect(
      remaining.some(
        (message: { messageId: string }) => message.messageId === firstIds[0],
      ),
    ).toBe(false);
    expect(
      remaining.some(
        (message: { messageId: string }) =>
          !firstIds.includes(message.messageId),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);

test("provisioning requires current project delegation at process admission and refuses arbitrary targets, capacity and changed retry identities", async () => {
  const f = await fixture();
  try {
    const request = {
      requestId: "provision:fenced",
      projectId: "project:test",
      targetId: "local",
      profileId: "pi",
      name: "Fenced",
    };
    await expect(
      f.client.provisionNativeWorker({
        ...request,
        projectId: "project:other",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.client.provisionNativeWorker({ ...request, targetId: "owner-only" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.client.provisionNativeWorker({ ...request, profileId: "arbitrary" }),
    ).rejects.toMatchObject({ status: 409 });
    const raw = await fetch(
      new URL("/v1/native-worker-provisionings", f.server.server.url),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.secrets[2]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...request, credential: f.secrets[0] }),
      },
    );
    expect(raw.status).toBe(400);
    const pause = join(f.root, "admission-pause");
    const state = JSON.parse(readFileSync(f.statePath, "utf8"));
    writeFileSync(
      f.statePath,
      JSON.stringify({ ...state, identityPausePath: pause }),
    );
    const queued = await f.board<{ requestId: string; taskId: string }>({
      op: "provision",
      projectId: request.projectId,
      targetId: request.targetId,
      profileId: request.profileId,
      name: request.name,
    });
    expect(queued.error).toBe(false);
    request.requestId = queued.value.requestId;
    await until(() => existsSync(`${pause}.entered`));
    const reserved = (await f.ownerClient().listNativeWorkers("project:test"))
      .workers[0]!;
    expect(reserved.rex).toBeNull();
    expect(reserved.provisioningStatus).toBe("preparing");
    await expect(
      f.ownerClient().messageNativeWorker(reserved.workerId, {
        requestId: "premature:assignment",
        text: "Do not dispatch before attachment",
      }),
    ).rejects.toMatchObject({ code: "worker_not_ready" });
    const reservedClient = new FactoryClient({
      baseUrl: f.server.server.url.origin,
      credential: f.credential(request.requestId).config.credential,
    });
    await expect(
      reservedClient.postWorkerItem({
        itemId: "premature:report",
        kind: "report",
        title: "Not ready",
        text: "No native assignment was admitted.",
        blocking: false,
      }),
    ).rejects.toMatchObject({ code: "worker_not_ready" });
    await f.setGrant(false);
    writeFileSync(`${pause}.release`, "release");
    await until(() =>
      f.provisioningResponses.some(
        (response) =>
          response.requestId === request.requestId && response.status === 404,
      ),
    );
    expect(
      JSON.parse(readFileSync(f.statePath, "utf8")).launchCount,
    ).toBeUndefined();
    await f.setGrant(true);
    writeFileSync(f.statePath, JSON.stringify(state));
    await until(async () => {
      const history = await f.board<{
        provisionings: { request: { requestId: string }; state: string }[];
      }>({ op: "view", projectId: "project:test", section: "provisioning" });
      return history.value.provisionings.some(
        (job) =>
          job.request.requestId === request.requestId &&
          job.state === "blocked",
      );
    });
    const resumed = await f.board<{ requestId: string; taskId: string }>({
      op: "provision",
      ...request,
    });
    expect(resumed.error).toBe(false);
    expect(resumed.value.requestId).toBe(queued.value.requestId);
    expect(resumed.value.taskId).not.toBe(queued.value.taskId);
    const admitted = await f.ready(request.requestId);
    await f.tick();
    await expect(
      f.client.provisionNativeWorker({ ...request, name: "Changed retry" }),
    ).rejects.toMatchObject({ status: 409 });
    const other = await f.client.provisionNativeWorker({
      ...request,
      requestId: "provision:second",
      profileId: "codex",
    });
    await f.ready(other.request.requestId);
    await expect(
      f.client.provisionNativeWorker({
        ...request,
        requestId: "provision:capacity",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(readFileSync(f.statePath, "utf8")).launchCount).toBe(2);
    expect(
      readdirSync(
        join(
          f.config.nativeAgents.stateDirectory,
          "factory-workers",
          f.server.factory.coordination.provisioningScopeId,
        ),
      ),
    ).toHaveLength(2);
    expect(
      (await f.client.getNativeWorkerProvisioning(request.requestId)).workerId,
    ).toBe(admitted.workerId);
  } finally {
    await f.close();
  }
}, 30_000);
