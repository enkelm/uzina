import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FactoryClient } from "@uzina/client";
import { createHash } from "node:crypto";
import { nativeAssignmentSchema } from "@uzina/contracts/assignments";
import type { NativeProvisioningStatus } from "@uzina/contracts/native-provisioning";
import { ExecutionDaemon } from "../src/execution/daemon";
import { createStandaloneFactoryServer } from "../src/factory/standalone";
import { readLocalMcpReadiness } from "../src/execution/mcp-readiness";
import { factoryBotTestModels } from "../../../packages/pi-runtime/test-support/factory-bot-model";

const optIn = process.env.UZINA_NATIVE_AGENT_INTEGRATION === "1";
test.skipIf(!optIn)(
  "installed Pi completes a controlled native assignment loop; Codex initializes both private MCP catalogues without inference",
  async () => {
    const identity = JSON.parse(
      execFileSync("rex", ["--autostart=false", "whoami", "--json"], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    );
    const rexExecutable = Bun.which("rex")!,
      piExecutable = Bun.which("pi")!,
      codexExecutable = Bun.which("codex")!;
    expect(piExecutable).toBeTruthy();
    expect(codexExecutable).toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), "uzina-native-live-"));
    const workspace = join(root, "workspace with spaces"),
      home = join(root, "home");
    const piHome = join(home, "pi"),
      codexHome = join(home, "codex");
    for (const path of [workspace, piHome, codexHome])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    const modelRequests: string[] = [];
    const model = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        modelRequests.push(new URL(request.url).pathname);
        return Response.json({ data: [] });
      },
    });
    // Isolated settings trust only the empty workspace just created by this test.
    // The production launcher does not add or weaken any approval/trust/sandbox setting.
    writeFileSync(
      join(codexHome, "config.toml"),
      `model_provider = "uzina-proof"\nmodel = "bootstrap-proof"\ncheck_for_update_on_startup = false\n[model_providers.uzina-proof]\nname = "No paid model calls"\nbase_url = "${model.url}v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
      { mode: 0o600 },
    );
    const entry = (name: string) =>
      process.env.UZINA_NATIVE_AGENT_ARTIFACT_DIRECTORY
        ? join(process.env.UZINA_NATIVE_AGENT_ARTIFACT_DIRECTORY, `${name}.js`)
        : resolve(import.meta.dir, `../src/${name}.ts`);
    const driver = join(root, "native-model");
    mkdirSync(driver, { mode: 0o700 });
    writeFileSync(
      join(driver, "plan.json"),
      JSON.stringify({
        forbiddenArgv: [
          process.execPath,
          "--eval",
          "require('node:fs').writeFileSync('forbidden.txt','unsafe')",
        ],
        effectArgv: [
          process.execPath,
          "--eval",
          "require('node:fs').appendFileSync('result.txt','verified\\n')",
        ],
      }),
      { mode: 0o600 },
    );
    mkdirSync(join(piHome, "extensions"), { mode: 0o700 });
    writeFileSync(
      join(piHome, "extensions", "controlled-model.ts"),
      `import { nativeWorkerModel } from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/pi-runtime/test-support/native-worker-model.ts"))}; export default function(pi) { pi.registerProvider(nativeWorkerModel(${JSON.stringify(driver)})); }\n`,
      { mode: 0o600 },
    );
    const piSettings = JSON.stringify({
      defaultProvider: "uzina-native-proof",
      defaultModel: "controlled",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    writeFileSync(join(piHome, "settings.json"), piSettings, { mode: 0o600 });
    const dbPath = join(root, "executor.sqlite");
    const configuration = {
      stateDirectory: join(root, "private"),
      bunExecutable: process.execPath,
      runnerEntry: entry("native-agent"),
      rexToolsEntry: entry("rex-tools"),
      nativePiEntry: entry("native-pi"),
      profiles: {
        pi: {
          agent: "pi" as const,
          executable: piExecutable,
          offline: true,
          environment: { HOME: home, PI_CODING_AGENT_DIR: piHome },
        },
        codex: {
          agent: "codex" as const,
          executable: codexExecutable,
          environment: { HOME: home, CODEX_HOME: codexHome },
        },
      },
    };
    const executorOptions = {
      databasePath: dbPath,
      nodeId: "node:live",
      nodeCredential: "node-secret-must-not-enter-worker",
      workspaces: [{ workspaceId: "workspace:live", directory: workspace }],
      rexExecutable,
      rexServer: identity.endpoint,
      nativeAgents: configuration,
    };
    let daemon = new ExecutionDaemon(executorOptions);
    const factoryOptions = {
      databasePath: join(root, "factory.sqlite"),
      runtimeDirectory: join(root, "runtime"),
      bootstrapSecret: "bootstrap-live",
      models: factoryBotTestModels().models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
    };
    const provisioningOptions = () => ({
      launcher: daemon.nativeAgents!,
      factoryWorkerEntry: entry("factory-worker"),
      targets: [
        {
          targetId: "local",
          projectId: "project:live",
          profileIds: ["pi", "codex"],
          target: { nodeId: "node:live", workspaceId: "workspace:live" },
          ownershipGeneration: 0,
          allowAssistant: true,
          maxWorkers: 2,
        },
      ],
    });
    let factory = await createStandaloneFactoryServer({
      ...factoryOptions,
      port: 0,
      nativeWorkerProvisioning: provisioningOptions(),
    });
    const owner = await factory.factory.bootstrap("bootstrap-live", "Owner");
    const session = await factory.factory.authenticate(owner.credential);
    factory.factory.createProject(
      session,
      "project:live",
      "Live bootstrap proof",
    );
    await factory.factory.provisionNode(session, "node:live", "Live");
    factory.factory.createWorkspace(
      session,
      "workspace:live",
      "node:live",
      "Live",
    );
    const client = new FactoryClient({
      baseUrl: factory.server.url.origin,
      credential: owner.credential,
    });
    const rex = (...args: string[]) =>
      JSON.parse(
        execFileSync(
          rexExecutable,
          ["--autostart=false", "--server", identity.endpoint, ...args],
          { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 },
        ),
      );
    let failure: unknown, cleanupFailure: unknown;
    try {
      const sessions: string[] = [],
        statuses: NativeProvisioningStatus[] = [];
      for (const agent of ["pi", "codex"] as const) {
        const input = {
          requestId: `live:${agent}`,
          projectId: "project:live",
          profileId: agent,
          targetId: "local",
          name: `Live ${agent}`,
        };
        let launched = await client.provisionNativeWorker(input);
        const deadline = Date.now() + 20_000;
        while (
          launched.status !== "ready" &&
          !["uncertain", "stopped"].includes(launched.status) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(100);
          launched = await client.getNativeWorkerProvisioning(input.requestId);
        }
        if (launched.status !== "ready") {
          const output = launched.process
            ? await daemon.rex.capture(launched.process.processId, {
                tailLines: 30,
                maxBytes: 8192,
              })
            : null;
          console.error(
            `${agent} bootstrap diagnostic: ${JSON.stringify({ launched, output })}`,
          );
        }
        expect(launched.status).toBe("ready");
        expect(launched.process?.status).toBe("running");
        for (const mcp of [launched.mcp?.rex, launched.mcp?.factory]) {
          expect(mcp?.status).toBe("ready");
          expect(mcp?.initializedAt).toBeTruthy();
          expect(mcp?.catalogServedAt).toBeTruthy();
          expect(mcp?.client?.name).toBeTruthy();
        }
        expect(launched.mcp?.factory.verifiedAt).toBeTruthy();
        expect(launched.capabilities.factoryCoordination).toBe(true);
        if (agent === "codex")
          expect(launched.capabilities).toMatchObject({
            automaticDelivery: false,
            nativeActivity: false,
          });
        expect((await client.getNativeWorker(launched.workerId)).rex).toEqual({
          sessionId: launched.process!.sessionId!,
          blockId: launched.process!.blockId!,
        });
        expect(
          (await client.provisionNativeWorker(input)).process?.sessionId,
        ).toBe(launched.process!.sessionId);
        sessions.push(launched.process!.sessionId!);
        statuses.push(launched);
        expect(() =>
          daemon.beginWorkspaceCapture("workspace:live", `capture:${agent}`),
        ).toThrow();
      }
      expect(new Set(sessions).size).toBe(2);
      expect(new Set(statuses.map((status) => status.workerId)).size).toBe(2);
      expect(
        modelRequests.filter((path) =>
          /responses|chat\/completions/.test(path),
        ),
      ).toEqual([]);
      expect(existsSync(join(workspace, ".pi"))).toBe(false);
      expect(existsSync(join(workspace, ".codex"))).toBe(false);
      expect(
        readFileSync(join(codexHome, "config.toml"), "utf8"),
      ).not.toContain("mcp_servers");
      const pi = statuses[0]!;
      const configPath = join(
        configuration.stateDirectory,
        "factory-workers",
        factory.factory.coordination.provisioningScopeId,
        createHash("sha256").update(pi.request.requestId).digest("hex"),
        "server.json",
      );
      const privateConfig = JSON.parse(readFileSync(configPath, "utf8"));
      const worker = new FactoryClient({
        baseUrl: factory.server.url.origin,
        credential: privateConfig.credential,
      });
      async function until(predicate: () => Promise<boolean>) {
        const deadline = Date.now() + 15_000;
        while (!(await predicate())) {
          if (Date.now() > deadline)
            throw new Error("Installed native loop did not settle");
          await Bun.sleep(50);
        }
      }
      await until(
        async () =>
          (await worker.getWorkerRuntime()).worker.activity?.state === "armed",
      );
      const assignment = nativeAssignmentSchema.parse({
        protocol: "uzina.assignment.v1",
        cardId: "live:card",
        attemptId: "live:attempt",
        title: "Controlled native lifecycle",
        brief: {
          objective: "Write verified text once after the Owner answer",
          inputs: [],
          deliverables: ["result.txt"],
          acceptance: ["One verified line"],
          constraints: ["Ask the blocking question first"],
        },
        report: {
          itemId: "report:live-native",
          kind: "report",
          instruction: "Use this exact report ID.",
        },
      });
      await client.messageNativeWorker(pi.workerId, {
        requestId: "assignment:live-native",
        text: JSON.stringify(assignment),
        assignment,
      });
      await until(async () =>
        (await client.listCoordinationItems("project:live")).items.some(
          (item) => item.itemId === "question:native-loop",
        ),
      );
      expect((await worker.getWorkerRuntime()).assignment?.status).toBe(
        "started",
      );
      expect(existsSync(join(workspace, "result.txt"))).toBe(false);
      expect(existsSync(join(workspace, "forbidden.txt"))).toBe(false);
      await client.decideCoordinationItem("question:native-loop", {
        requestId: "answer:live-native",
        action: "answer",
        text: "Write verified and one newline.",
      });
      await until(async () =>
        (await client.listCoordinationItems("project:live")).items.some(
          (item) => item.itemId === assignment.report.itemId,
        ),
      );
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe(
        "verified\n",
      );
      expect(existsSync(join(workspace, "forbidden.txt"))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(driver, "model-requests.json"), "utf8"))
          .requests,
      ).toBe(3);
      const { lastChangelogVersion: _nativeVersion, ...retainedPiSettings } =
        JSON.parse(readFileSync(join(piHome, "settings.json"), "utf8"));
      expect(retainedPiSettings).toEqual(JSON.parse(piSettings));
      expect((await worker.getWorkerRuntime()).assignment).toBeNull();
      const port = factory.server.port!;
      await factory.close();
      await daemon.nativeAgents!.close();
      daemon.close();
      daemon = new ExecutionDaemon(executorOptions);
      factory = await createStandaloneFactoryServer({
        ...factoryOptions,
        port,
        nativeWorkerProvisioning: provisioningOptions(),
      });
      const recovered = await client.getNativeWorkerProvisioning("live:pi");
      expect(recovered.process?.sessionId).toBe(sessions[0]);
      expect(recovered.status).toBe("ready");
      expect(
        (await client.provisionNativeWorker(statuses[0]!.request)).workerId,
      ).toBe(statuses[0]!.workerId);
    } catch (error) {
      failure = error;
    } finally {
      await factory.close();
      await daemon.nativeAgents!.close();
      try {
        const db = new Database(dbPath, { readonly: true });
        const labels = db
          .query<{ process_id: string }, []>(
            "SELECT process_id FROM execution_rex_processes",
          )
          .all()
          .map((row) => `uzina-${row.process_id}`);
        db.close();
        for (const name of readdirSync(configuration.stateDirectory).filter(
          (name) => name !== "factory-workers",
        )) {
          const journal = join(
            configuration.stateDirectory,
            name,
            "rex",
            "journal.sqlite",
          );
          if (!existsSync(journal)) continue;
          const tools = new Database(journal, { readonly: true });
          try {
            labels.push(
              ...tools
                .query<{ process_id: string }, []>(
                  "SELECT process_id FROM execution_rex_processes",
                )
                .all()
                .map((row) => `uzina-${row.process_id}`),
            );
          } finally {
            tools.close();
          }
        }
        const owned = rex("ls", "--json").sessions.filter(
          (session: { label: string }) => labels.includes(session.label),
        );
        for (const session of owned)
          execFileSync(
            rexExecutable,
            [
              "--autostart=false",
              "--server",
              identity.endpoint,
              "kill",
              session.session_id,
            ],
            { timeout: 10_000 },
          );
        expect(
          rex("ls", "--json").sessions.filter((session: { label: string }) =>
            labels.includes(session.label),
          ),
        ).toEqual([]);
        const journals = readdirSync(configuration.stateDirectory)
          .filter((name) => name !== "factory-workers")
          .map((name) => ({
            path: join(
              configuration.stateDirectory,
              name,
              "rex",
              "journal.sqlite",
            ),
            kind: "rex" as const,
          }));
        const workerRoot = join(
          configuration.stateDirectory,
          "factory-workers",
          factory.factory.coordination.provisioningScopeId,
        );
        const all = [
          ...journals,
          ...readdirSync(workerRoot).map((name) => ({
            path: join(workerRoot, name, "journal.sqlite"),
            kind: "factory" as const,
          })),
        ];
        const deadline = Date.now() + 8000;
        while (
          all.some(
            (journal) =>
              readLocalMcpReadiness(journal.path, journal.kind).status ===
              "ready",
          ) &&
          Date.now() < deadline
        )
          await Bun.sleep(100);
        for (const journal of all)
          expect(
            readLocalMcpReadiness(journal.path, journal.kind).status,
          ).not.toBe("ready");
      } catch (error) {
        cleanupFailure = error;
      }
      daemon.close();
      model.stop(true);
      if (!failure && !cleanupFailure)
        rmSync(root, { recursive: true, force: true });
      else
        console.error(
          `Preserving native-agent integration evidence at ${root}`,
        );
    }
    if (failure && cleanupFailure)
      throw new AggregateError(
        [failure, cleanupFailure],
        "Native bootstrap and cleanup failed",
      );
    if (failure) throw failure;
    if (cleanupFailure) throw cleanupFailure;
  },
  60_000,
);
