import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import { FactoryError, type FactoryService } from "@uzina/core";
import type { NativeWorkerProvisioningHost } from "@uzina/core/http";
import type { NativeAgentProfile } from "@uzina/contracts/native-agents";
import { rexToolConfigurationSchema } from "@uzina/contracts/rex-tools";
import {
  privateNativeDirectory,
  readNativeBootstrapFile,
  writeNativeBootstrapFile,
} from "./native-agent-bootstrap";
import { ExecutionDaemon } from "./daemon";
import { HttpExecutionControllerConnector } from "./connector";
import { ExecutionLoop } from "./loop";
import { NativeWorkerProvisioner } from "./native-provisioning";

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

/** Host PATH is policy, not input from a project, model, or HTTP request. Ignore checkout-local executables. */
function executable(name: string, workspace: string): string | undefined {
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => {
      if (!isAbsolute(entry) || !existsSync(entry)) return false;
      return !contains(workspace, realpathSync(entry));
    })
    .join(delimiter);
  const found = Bun.which(name, { PATH: path });
  if (!found) return undefined;
  const canonical = realpathSync(found);
  return contains(workspace, canonical) ? undefined : canonical;
}

/** Normal local startup: private recoverable setup, no feature-specific configuration file. */
export async function openLocalNativeFactoryExecutor(options: {
  factory: FactoryService;
  ownerCredential: string;
  databasePath: string;
  directory: string;
  entryDirectory: string;
}) {
  const directory = realpathSync(options.directory);
  const scopeId = options.factory.coordination.provisioningScopeId;
  const key = createHash("sha256")
    .update(`${scopeId}:${directory}`)
    .digest("hex");
  const statePath = join(
    realpathSync(dirname(options.databasePath)),
    `${basename(options.databasePath)}.local-execution`,
  );
  if (contains(directory, statePath) || contains(statePath, directory))
    throw new Error(
      "Local execution state must be outside the startup workspace",
    );
  const root = privateNativeDirectory(
    join(privateNativeDirectory(statePath), key),
  );
  const binding = {
    scopeId,
    nodeId: `node:local:${key}`,
    workspaceId: `workspace:local:${key}`,
    directory,
  };
  const identityPath = join(root, "identity.json");
  const readIdentity = () => {
    const value = JSON.parse(readNativeBootstrapFile(identityPath));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 5 ||
      Object.entries(binding).some(
        ([name, expected]) => value[name] !== expected,
      ) ||
      typeof value.credential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.credential)
    )
      throw new Error(
        "Local execution identity does not match this Factory and workspace",
      );
    return { ...binding, credential: value.credential as string };
  };
  let identity: ReturnType<typeof readIdentity>;
  try {
    identity = readIdentity();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writeNativeBootstrapFile(
      identityPath,
      JSON.stringify({
        ...binding,
        credential: randomBytes(32).toString("base64url"),
      }),
    );
    identity = readIdentity();
  }
  const owner = await options.factory.authenticate(options.ownerCredential);
  await options.factory.ensureLocalExecutionTarget(owner, {
    ...binding,
    credential: identity.credential,
    name: basename(directory) || "Local workspace",
  });

  const profiles: Record<string, NativeAgentProfile> = {};
  for (const agent of ["pi", "codex"] as const) {
    const path = executable(agent, directory);
    if (path) profiles[agent] = { agent, executable: path };
  }
  const rexExecutable = executable("rex", directory);
  let rexServer: string | undefined;
  let unavailable = "native_rex_not_installed";
  if (rexExecutable) {
    // Official discovery/autostart, no session creation, then pin the exact endpoint.
    // Do not forward Factory/provider credentials or inherited Rex session selectors.
    const env = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "LANG",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
      ].flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]!]],
      ),
    );
    try {
      const discovery = Bun.spawnSync([rexExecutable, "whoami", "--json"], {
        env,
        cwd: directory,
        timeout: 10_000,
        maxBuffer: 131_072,
      });
      const response = JSON.parse(discovery.stdout.toString());
      const endpoint = rexToolConfigurationSchema.shape.server.safeParse(
        response.endpoint,
      );
      if (
        discovery.exitCode === 0 &&
        endpoint.success &&
        typeof response.instance_id === "string" &&
        response.instance_id
      )
        rexServer = endpoint.data;
    } catch {
      /* Only a bounded public diagnostic escapes discovery. */
    }
    unavailable = "native_rex_discovery_failed";
  }
  const entry = (name: string) => {
    const js = join(options.entryDirectory, `${name}.js`);
    return existsSync(js) ? js : join(options.entryDirectory, `${name}.ts`);
  };
  const executor = new ExecutionDaemon({
    databasePath: join(root, "executor.sqlite"),
    nodeId: identity.nodeId,
    nodeCredential: identity.credential,
    workspaces: [{ workspaceId: identity.workspaceId, directory }],
    rexExecutable,
    rexServer,
    nativeAgents: rexServer
      ? {
          stateDirectory: join(root, "native-agents"),
          bunExecutable: process.execPath,
          runnerEntry: entry("native-agent"),
          rexToolsEntry: entry("rex-tools"),
          nativePiEntry: entry("native-pi"),
          profiles,
        }
      : undefined,
  });
  let provisioner: NativeWorkerProvisioner | undefined;
  let loop: Promise<void> | undefined;
  const shutdown = new AbortController();
  let closing: Promise<void> | undefined;
  try {
    const node = await options.factory.authenticate(identity.credential);
    options.factory.registerExecutionNode(node, executor.registerRequest());
    options.factory.heartbeatExecutionNode(node, executor.heartbeatRequest());
  } catch (error) {
    await executor.nativeAgents?.close();
    executor.close();
    throw error;
  }
  const missing = (): never => {
    throw new FactoryError(503, unavailable);
  };
  const host: NativeWorkerProvisioningHost = {
    observeActivity(status) {
      return provisioner?.observeActivity(status) ?? null;
    },
    targets(projectId) {
      return provisioner ? provisioner.targets(projectId) : missing();
    },
    run(request, journal) {
      return provisioner
        ? provisioner.run(request, journal)
        : Promise.reject(new FactoryError(503, unavailable));
    },
    async refresh(status, journal) {
      if (provisioner) return provisioner.refresh(status, journal);
      journal.record({
        process: status.process,
        mcp: null,
        errorCode: unavailable,
      });
    },
  };
  return {
    executor,
    host,
    workspaceDirectories: { [identity.workspaceId]: directory },
    start(origin: string) {
      if (executor.nativeAgents)
        provisioner = new NativeWorkerProvisioner({
          launcher: executor.nativeAgents,
          factoryWorkerEntry: entry("factory-worker"),
          factoryBaseUrl: () => origin,
          factoryScopeId: scopeId,
          // Every discovered project still passes Core's current read/write grants.
          targets: (projectId) => [
            {
              projectId,
              targetId: "local",
              profileIds: Object.keys(profiles),
              target: {
                nodeId: identity.nodeId,
                workspaceId: identity.workspaceId,
              },
              ownershipGeneration: 0,
              allowAssistant: true,
              maxWorkers: 8,
            },
          ],
        });
      else
        console.error(
          `Local native worker capability unavailable: ${unavailable}`,
        );
      const controller = new HttpExecutionControllerConnector({
        controllerUrl: origin,
        nodeId: identity.nodeId,
        credential: identity.credential,
      });
      loop = new ExecutionLoop({ daemon: executor, controller })
        .run(shutdown.signal)
        .catch(() => {
          console.error(
            "Local execution loop stopped; inspect node availability before dispatching work",
          );
        });
    },
    close() {
      closing ??= (async () => {
        shutdown.abort();
        await loop;
        await provisioner?.close();
        await executor.nativeAgents?.close();
        executor.close();
      })();
      return closing;
    },
  };
}
