// External Pi process substitute: actual Pi runtime and generated extension, controlled model only.
// Never fabricates MCP readiness, native admission/start receipts, questions, or workspace effects.
import {
  createMcpExtension,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type AgentSession,
  type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { nativeWorkerModel } from "../../../../packages/pi-runtime/test-support/native-worker-model";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const configPath = process.argv[process.argv.indexOf("--config") + 1]!;
const launch = JSON.parse(readFileSync(configPath, "utf8"));
const directory =
  launch.environment.NATIVE_TEST_DRIVER ?? process.env.NATIVE_TEST_DRIVER;
let host: AgentSessionRuntime | undefined;
let stopping = false;
const terminalInputs = new Set<TerminalInputHandler>();
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
try {
  const args: string[] = launch.argv;
  const argument = (name: string) => args[args.indexOf(name) + 1]!;
  const agentDir = join(directory, "agent");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(nativeWorkerModel(directory));
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  host = await createAgentSessionRuntime(
    async (options) => {
      const services = await createAgentSessionServices({
        cwd: options.cwd,
        agentDir,
        modelRuntime,
        settingsManager: settings,
        resourceLoaderOptions: {
          extensionFactories: [createMcpExtension()],
          additionalExtensionPaths: [argument("--extension")],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        model: modelRuntime.getModel("uzina-native-proof", "controlled"),
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    {
      cwd: launch.workspaceDirectory,
      agentDir,
      sessionManager: SessionManager.create(
        launch.workspaceDirectory,
        argument("--session-dir"),
        { id: argument("--session-id") },
      ),
    },
  );
  const bind = (session: AgentSession) =>
    session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        onTerminalInput(handler) {
          terminalInputs.add(handler);
          return () => {
            terminalInputs.delete(handler);
          };
        },
      },
      onError(error) {
        writeFileSync(
          join(directory, "extension-error"),
          JSON.stringify(error),
        );
      },
    });
  host.setRebindSession(bind);
  await bind(host.session);
  writeFileSync(
    join(directory, "started"),
    JSON.stringify({
      pid: process.pid,
      sessionFile: host.session.sessionManager.getSessionFile(),
      diagnostics: host.diagnostics,
    }),
  );
  while (!stopping) {
    const control = join(directory, "control.json");
    if (existsSync(control)) {
      const request = JSON.parse(readFileSync(control, "utf8"));
      const response = join(directory, `control-${request.id}.json`);
      if (!existsSync(response)) {
        if (request.op === "abort") await host.session.abort();
        if (request.op === "escape") {
          for (const listener of terminalInputs) listener("\x1b");
          await host.session.abort();
        }
        if (request.op === "pause" || request.op === "resume")
          await host.session.prompt(`/factory ${request.op}`);
        if (request.op === "new") await host.newSession();
        if (request.op === "switch") await host.switchSession(request.path);
        if (request.op === "fork") await host.fork(request.entryId);
        if (request.op === "reload") await host.session.reload();
        writeFileSync(response, "done");
      }
    }
    await Bun.sleep(20);
  }
} catch (error) {
  writeFileSync(join(directory, "failure"), String(error));
} finally {
  await host?.dispose();
  process.exit(0);
}
