import {
  createConfiguredModels,
  readManagedModelConfig,
} from "@uzina/pi-runtime";
import { createDaemonServer } from "./server";
import { createStandaloneFactoryServer } from "./factory/standalone";
import { ExecutionDaemon, type WorkspaceMapping } from "./execution/daemon";
import { HttpExecutionControllerConnector } from "./execution/connector";
import { ExecutionLoop } from "./execution/loop";

function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`Configuration requires ${name}`);
  return value;
}

function workspaceMappings(value: string): WorkspaceMapping[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("UZINA_EXECUTION_WORKSPACES must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("UZINA_EXECUTION_WORKSPACES must be a nonempty JSON array");
  }
  return parsed as WorkspaceMapping[];
}

const mode = Bun.env.UZINA_MODE ?? "local";
const port = Number(Bun.env.PORT ?? "8788");
const hostname = Bun.env.HOST ?? "127.0.0.1";

async function startLocalFactory(): Promise<void> {
  const modelConfig = readManagedModelConfig({
    UZINA_MODEL_PROVIDER: Bun.env.UZINA_MODEL_PROVIDER,
    UZINA_MODEL_ID: Bun.env.UZINA_MODEL_ID,
    UZINA_MODEL_API_KEY: Bun.env.UZINA_MODEL_API_KEY,
  });
  const models = await createConfiguredModels(modelConfig);
  const server = await createStandaloneFactoryServer({
    databasePath: Bun.env.UZINA_FACTORY_DATABASE_PATH,
    runtimeDirectory: Bun.env.UZINA_MANAGED_WORK_DIRECTORY,
    bootstrapSecret: required("UZINA_BOOTSTRAP_SECRET"),
    models,
    modelProvider: modelConfig.provider,
    modelId: modelConfig.modelId,
    port,
    hostname,
  });
  const close = () => {
    void server.close(false);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  console.log(`Uzina standalone Factory listening at ${server.server.url}`);
}

function startConnectedExecutor(): void {
  const server = createDaemonServer(port, hostname);
  let daemon: ExecutionDaemon | undefined;
  const shutdown = new AbortController();
  try {
    daemon = new ExecutionDaemon({
      databasePath: required("UZINA_EXECUTION_DATABASE_PATH"),
      nodeId: required("UZINA_NODE_ID"),
      nodeCredential: required("UZINA_NODE_CREDENTIAL"),
      workspaces: workspaceMappings(required("UZINA_EXECUTION_WORKSPACES")),
      daemonVersion: Bun.env.UZINA_DAEMON_VERSION ?? "0.0.0",
    });
    const connector = new HttpExecutionControllerConnector({
      controllerUrl: required("UZINA_CONTROLLER_URL"),
      nodeId: required("UZINA_NODE_ID"),
      credential: required("UZINA_NODE_CREDENTIAL"),
    });
    const loop = new ExecutionLoop({ daemon, controller: connector });
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`Uzina connected executor listening at ${server.url}`);
    void loop
      .run(shutdown.signal)
      .then(() => {
        server.stop(false);
        daemon?.close();
      })
      .catch((error: unknown) => {
        console.error(
          error instanceof Error
            ? `Uzina executor stopped: ${error.message}`
            : "Uzina executor stopped",
        );
        shutdown.abort();
        server.stop(false);
        daemon?.close();
        process.exitCode = 1;
      });
  } catch (error) {
    server.stop(true);
    daemon?.close();
    console.error(
      error instanceof Error ? error.message : "Executor configuration failed",
    );
    process.exitCode = 1;
  }
}

if (mode === "local") {
  void startLocalFactory().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Standalone Factory configuration failed",
    );
    process.exitCode = 1;
  });
} else if (mode === "connected-executor") {
  startConnectedExecutor();
} else {
  console.error("UZINA_MODE must be local or connected-executor");
  process.exitCode = 1;
}
