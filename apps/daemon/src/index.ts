import { createLocalRuntimeOptions } from "./runtime/models";
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

function optionalPathMappings(
  name: string,
): Readonly<Record<string, string>> | undefined {
  const value = Bun.env[name];
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((path) => typeof path !== "string")
  ) {
    throw new Error(
      `${name} must be a JSON object mapping configured IDs to paths`,
    );
  }
  return parsed as Record<string, string>;
}

const mode = Bun.env.UZINA_MODE ?? "local";
const port = Number(Bun.env.PORT ?? "8788");
const hostname = Bun.env.HOST ?? "127.0.0.1";

async function startLocalFactory(): Promise<void> {
  const { models, agent } = await createLocalRuntimeOptions();
  const server = await createStandaloneFactoryServer({
    localExecution: { entryDirectory: import.meta.dir },
    databasePath: Bun.env.UZINA_FACTORY_DATABASE_PATH,
    runtimeDirectory: Bun.env.UZINA_MANAGED_WORK_DIRECTORY,
    managedWorkImportCatalogs: optionalPathMappings(
      "UZINA_MANAGED_WORK_IMPORT_CATALOGS",
    ),
    managedWorkImportDestinations: optionalPathMappings(
      "UZINA_MANAGED_WORK_IMPORT_DESTINATIONS",
    ),
    ownerSignIn: true,
    models,
    modelProvider: agent.model.provider,
    modelId: agent.model.modelId,
    privateAssistant: Bun.env.UZINA_PRIVATE_ASSISTANT_BEARER
      ? {
          bearer: Bun.env.UZINA_PRIVATE_ASSISTANT_BEARER,
          credentialId: Bun.env.UZINA_PRIVATE_ASSISTANT_CREDENTIAL_ID,
          assistantId: Bun.env.UZINA_PRIVATE_ASSISTANT_ASSISTANT_ID,
          ownerId: Bun.env.UZINA_PRIVATE_ASSISTANT_OWNER_ID,
        }
      : undefined,
    port,
    hostname,
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= server.close(false);
    void closing.catch(() => {
      console.error("Standalone Factory shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  console.log(`Uzina standalone Factory listening at ${server.server.url}`);
  if (server.ownerSignInPath) {
    console.log(
      `Owner sign-in (keep private): http://127.0.0.1:5173${server.ownerSignInPath}`,
    );
  }
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
