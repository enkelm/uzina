import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ExecutionDaemon,
  type ExecutionDaemonOptions,
} from "../src/execution/daemon";
import { createStandaloneFactoryServer } from "../src/factory/standalone";
import { deterministicToolModels } from "../../../packages/pi-runtime/test-support/deterministic-tool-model";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "uzina-native-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const statePath = join(root, "rex-state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      instanceId: "server:native-test",
      jobs: {},
      loseNext: true,
    }),
  );
  const rexExecutable = join(root, "rex-fixture");
  writeFileSync(
    rexExecutable,
    `#!/usr/bin/env bun\nprocess.env.UZINA_REX_FIXTURE_STATE = ${JSON.stringify(statePath)};\nawait import(${JSON.stringify(resolve(import.meta.dir, "fixtures/rex-tool-cli.ts"))});\n`,
    { mode: 0o700 },
  );
  const cliExecutable = join(root, "agent-fixture");
  writeFileSync(
    cliExecutable,
    '#!/bin/sh\nprintf "%s\\n" "--extension --session-id --session-dir --config --cd --no-daemon"\n',
    { mode: 0o700 },
  );
  const options: ExecutionDaemonOptions = {
    databasePath: join(root, "executor.sqlite"),
    nodeId: "node:test",
    nodeCredential: "node-credential-not-for-the-worker",
    workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    rexExecutable,
    rexServer: "unix:///rex-test.sock",
    nativeAgents: {
      stateDirectory: join(root, "private"),
      bunExecutable: process.execPath,
      runnerEntry: resolve(import.meta.dir, "../src/native-agent.ts"),
      rexToolsEntry: resolve(import.meta.dir, "../src/rex-tools.ts"),
      profiles: {
        pi: {
          agent: "pi",
          executable: cliExecutable,
          environment: { WORKER_MODEL_KEY: "dedicated-test-model-key" },
        },
      },
    },
  };
  return { root, workspace, statePath, options };
}

test("the local Factory authorizes Pi bootstrap, keeps private launch input out of receipts, and reconciles a lost process response across restart without relaunching", async () => {
  const f = fixture();
  let executor = new ExecutionDaemon(f.options);
  const model = deterministicToolModels({ toolName: "unused", arguments: {} });
  const factoryOptions = {
    databasePath: join(f.root, "factory.sqlite"),
    runtimeDirectory: join(f.root, "runtime"),
    bootstrapSecret: "test-bootstrap",
    models: model.models,
    modelProvider: "uzina-test",
    modelId: "fixed-model",
    port: 0,
  };
  let server = await createStandaloneFactoryServer({
    ...factoryOptions,
    nativeAgentLauncher: executor.nativeAgents,
  });
  const owner = await server.factory.bootstrap("test-bootstrap", "Owner");
  const ownerSession = await server.factory.authenticate(owner.credential);
  server.factory.createProject(ownerSession, "project:test", "Test");
  server.factory.createProject(ownerSession, "project:other", "Other");
  await server.factory.provisionNode(ownerSession, "node:test", "Test");
  server.factory.createWorkspace(
    ownerSession,
    "workspace:test",
    "node:test",
    "Test",
  );
  const assistant = await server.factory.provisionCredential(
    ownerSession,
    "assistant",
    "Coordinator",
    [{ type: "project", resourceId: "project:test" }],
  );
  const previousHostToken = process.env.UZINA_NATIVE_TEST_OWNER_TOKEN;
  process.env.UZINA_NATIVE_TEST_OWNER_TOKEN = owner.credential;
  const request = {
    requestId: "launch:one",
    projectId: "project:test",
    profileId: "pi",
    target: { nodeId: "node:test", workspaceId: "workspace:test" },
    ownershipGeneration: 0,
  };
  try {
    await expect(
      server.launchNativeAgent({ credential: assistant.credential, request }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      server.launchNativeAgent({ credential: "not-an-owner", request }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      server.launchNativeAgent({
        credential: owner.credential,
        request: { ...request, ownershipGeneration: 1 },
      }),
    ).rejects.toMatchObject({ code: "ownership_fenced" });
    await expect(
      server.launchNativeAgent({
        credential: owner.credential,
        request: { ...request, projectId: "project:missing" },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      executor.nativeAgents!.launch({
        ...request,
        argv: ["arbitrary-command"],
      }),
    ).rejects.toThrow("invalid_native_agent_launch");
    expect(readdirSync(f.options.nativeAgents!.stateDirectory)).toEqual([]);

    // A valid Owner call can lose authority while Rex connection discovery is
    // in flight. The production Core callback must recheck at intent admission.
    const revocable = await server.factory.createOwnerSignIn("Revocable owner");
    const pause = join(f.root, "identity-pause");
    const pausedState = JSON.parse(readFileSync(f.statePath, "utf8"));
    writeFileSync(
      f.statePath,
      JSON.stringify({ ...pausedState, identityPausePath: pause }),
    );
    const revokedLaunch = server.launchNativeAgent({
      credential: revocable.credential,
      request: { ...request, requestId: "launch:revoked" },
    });
    const rejected = revokedLaunch.then(
      () => null,
      (error: unknown) => error,
    );
    const pauseDeadline = Date.now() + 3000;
    while (!existsSync(`${pause}.entered`) && Date.now() < pauseDeadline)
      await Bun.sleep(10);
    expect(existsSync(`${pause}.entered`)).toBe(true);
    expect(() => executor.close()).toThrow("native_agent_operations_active");
    await server.factory.revokeCredential(ownerSession, revocable.credentialId);
    writeFileSync(`${pause}.release`, "release");
    expect(await rejected).toMatchObject({ status: 401 });
    expect(
      JSON.parse(readFileSync(f.statePath, "utf8")).launchCount,
    ).toBeUndefined();
    writeFileSync(f.statePath, JSON.stringify(pausedState));
    const previousDirectories = new Set(
      readdirSync(f.options.nativeAgents!.stateDirectory),
    );
    const incompleteDirectory = join(
      f.options.nativeAgents!.stateDirectory,
      [...previousDirectories][0]!,
    );
    writeFileSync(
      join(incompleteDirectory, "launch.json"),
      "partial bootstrap",
    );
    await expect(
      server.launchNativeAgent({
        credential: owner.credential,
        request: { ...request, requestId: "launch:revoked" },
      }),
    ).rejects.toThrow("native_agent_bootstrap_conflict");
    expect(readFileSync(join(incompleteDirectory, "launch.json"), "utf8")).toBe(
      "partial bootstrap",
    );
    expect(
      JSON.parse(readFileSync(f.statePath, "utf8")).launchCount,
    ).toBeUndefined();

    const launched = await server.launchNativeAgent({
      credential: owner.credential,
      request,
    });
    expect(launched.process.status).toBe("uncertain");
    expect(launched.mcp.status).toBe("pending");
    expect(launched.capabilities).toEqual({
      rexTools: true,
      factoryCoordination: false,
      automaticDelivery: false,
      nativeActivity: false,
    });
    expect(JSON.stringify(launched)).not.toContain(owner.credential);
    expect(JSON.stringify(launched)).not.toContain("dedicated-test-model-key");
    expect(JSON.stringify(launched)).not.toContain(
      "node-credential-not-for-the-worker",
    );
    expect(
      server.factory.coordination.listWorkers(ownerSession, "project:test")
        .workers,
    ).toEqual([]);

    const directory = join(
      f.options.nativeAgents!.stateDirectory,
      readdirSync(f.options.nativeAgents!.stateDirectory).find(
        (name) => !previousDirectories.has(name),
      )!,
    );
    const launch = JSON.parse(
      readFileSync(join(directory, "launch.json"), "utf8"),
    );
    expect(launch.environment.WORKER_MODEL_KEY).toBe(
      "dedicated-test-model-key",
    );
    expect(JSON.stringify(launch)).not.toContain(owner.credential);
    expect(
      Object.keys(launch.environment).some((name) =>
        /^(UZINA_|FACTORY_)/.test(name),
      ),
    ).toBe(false);
    for (const file of [
      "launch.json",
      "client.json",
      "rex-mcp.ts",
      "rex/server.json",
    ])
      expect(lstatSync(join(directory, file)).mode & 0o777).toBe(0o600);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(directory, "rex")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(f.workspace, ".pi"))).toBe(false);
    expect(existsSync(join(f.workspace, ".codex"))).toBe(false);
    const state = () => JSON.parse(readFileSync(f.statePath, "utf8"));
    expect(state().launchCount).toBe(1);
    // All native output here is from the real bootstrap executable refusing the
    // non-PTY fake Rex. Readiness is never inferred from a created session.
    expect(Object.values(state().jobs).map((job: any) => job.output)).toEqual([
      "native_agent_bootstrap_failed\n",
    ]);
    rmSync(join(directory, "launch.json"));
    await server.close();
    await executor.nativeAgents!.close();
    executor.close();
    executor = new ExecutionDaemon({
      ...f.options,
      nativeAgents: { ...f.options.nativeAgents!, profiles: {} },
    });
    server = await createStandaloneFactoryServer({
      ...factoryOptions,
      nativeAgentLauncher: executor.nativeAgents,
    });
    const recovered = await server.launchNativeAgent({
      credential: owner.credential,
      request,
    });
    expect(recovered.process.processId).toBe(launched.process.processId);
    expect(recovered.process.status).toBe("uncertain");
    expect(existsSync(join(directory, "launch.json"))).toBe(false);
    expect(state().launchCount).toBe(1);
    await expect(
      server.launchNativeAgent({
        credential: owner.credential,
        request: { ...request, projectId: "project:other" },
      }),
    ).rejects.toThrow("native_agent_launch_conflict");
    const changed = state();
    changed.instanceId = "server:replacement";
    writeFileSync(f.statePath, JSON.stringify(changed));
    const stale = await server.inspectNativeAgent({
      credential: owner.credential,
      request,
    });
    expect(stale.process.processId).toBe(launched.process.processId);
    expect(stale.observationError).toBe(
      "native_agent_process_observation_unavailable",
    );
    expect(state().launchCount).toBe(1);
  } finally {
    if (previousHostToken === undefined)
      delete process.env.UZINA_NATIVE_TEST_OWNER_TOKEN;
    else process.env.UZINA_NATIVE_TEST_OWNER_TOKEN = previousHostToken;
    await server.close();
    await executor.nativeAgents!.close();
    executor.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15_000);

test("native launch refuses unsafe private state, inherited host authority, unsupported CLI profiles and executor capture fences before any Rex effect", async () => {
  const f = fixture();
  let executor: ExecutionDaemon | undefined;
  try {
    const state = f.options.nativeAgents!.stateDirectory;
    mkdirSync(state, { mode: 0o755 });
    expect(() => new ExecutionDaemon(f.options)).toThrow(
      "native_agent_state_not_private",
    );
    chmodSync(state, 0o700);
    const inside = join(f.workspace, "must-not-be-created");
    expect(
      () =>
        new ExecutionDaemon({
          ...f.options,
          nativeAgents: { ...f.options.nativeAgents!, stateDirectory: inside },
        }),
    ).toThrow("native_agent_state_overlaps_workspace");
    expect(existsSync(inside)).toBe(false);
    const alias = join(f.root, "workspace-alias");
    symlinkSync(f.workspace, alias);
    expect(
      () =>
        new ExecutionDaemon({
          ...f.options,
          nativeAgents: {
            ...f.options.nativeAgents!,
            stateDirectory: join(alias, "must-not-be-created"),
          },
        }),
    ).toThrow("native_agent_state_overlaps_workspace");
    expect(existsSync(inside)).toBe(false);
    const privateAlias = join(f.root, "private-alias");
    symlinkSync(state, privateAlias);
    expect(
      () =>
        new ExecutionDaemon({
          ...f.options,
          nativeAgents: {
            ...f.options.nativeAgents!,
            stateDirectory: privateAlias,
          },
        }),
    ).toThrow("native_agent_state_not_private");
    expect(
      () => new ExecutionDaemon({ ...f.options, rexServer: undefined }),
    ).toThrow("native_agent_explicit_rex_server_required");
    executor = new ExecutionDaemon({
      ...f.options,
      nativeAgents: {
        ...f.options.nativeAgents!,
        profiles: {
          unsafe: {
            agent: "pi",
            executable: f.options.nativeAgents!.profiles.pi!.executable,
            environment: { UZINA_FACTORY_BEARER: "must-not-be-forwarded" },
          },
          unsupported: { agent: "codex", executable: "/usr/bin/true" },
          pi: f.options.nativeAgents!.profiles.pi!,
        },
      },
    });
    const request = {
      requestId: "launch:refused",
      projectId: "project:test",
      profileId: "unsafe",
      target: { nodeId: "node:test", workspaceId: "workspace:test" },
      ownershipGeneration: 0,
    };
    await expect(executor.nativeAgents!.launch(request)).rejects.toThrow(
      "native_agent_reserved_environment",
    );
    await expect(
      executor.nativeAgents!.launch({ ...request, profileId: "unsupported" }),
    ).rejects.toThrow("native_agent_unsupported_cli");
    executor.beginWorkspaceCapture("workspace:test", "capture:test");
    await expect(
      executor.nativeAgents!.launch({ ...request, profileId: "pi" }),
    ).rejects.toThrow("workspace_capture_active");
    expect(
      JSON.parse(readFileSync(f.statePath, "utf8")).launchCount,
    ).toBeUndefined();
    expect(readdirSync(state)).toEqual([]);
  } finally {
    await executor?.nativeAgents?.close();
    executor?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
