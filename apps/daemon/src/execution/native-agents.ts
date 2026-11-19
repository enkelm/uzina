import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  fsyncSync,
  closeSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeConversationBinding } from "@uzina/contracts/assignments";
import {
  nativeAgentLaunchRequestSchema,
  nativeAgentBootstrapSchema,
  nativeAgentProfileSchema,
  type NativeAgentProfile,
  type ParsedNativeAgentProfile,
  type NativeAgentLaunchRequest,
  type NativeAgentLaunchInput,
  type NativeAgentMcpReadiness,
} from "@uzina/contracts/native-agents";
import { rexToolConfigurationSchema } from "@uzina/contracts/rex-tools";
import type { ExecutionRexProcessReceipt } from "@uzina/contracts/execution";
import { ExecutionError } from "./errors";
import type { RexProcessManager } from "./rex";
import { readRexMcpReadiness } from "./rex-tools";
import { readLocalMcpReadiness } from "./mcp-readiness";
import { factoryWorkerConfigurationSchema } from "@uzina/contracts/native-provisioning";
import {
  privateNativeDirectory,
  writeNativeBootstrapFile,
  readNativeBootstrapFile,
} from "./native-agent-bootstrap";
export interface NativeAgentConfiguration {
  stateDirectory: string;
  bunExecutable: string;
  runnerEntry: string;
  rexToolsEntry: string;
  nativePiEntry?: string;
  profiles: Readonly<Record<string, NativeAgentProfile>>;
}

/** Trusted private attachment, never accepted in a model/HTTP launch request. */
export interface NativeAgentFactoryConnection {
  workerId: string;
  configPath: string;
  journalPath: string;
  entry: string;
  baseUrl: string;
  nativeBinding?: NativeConversationBinding;
}
interface LaunchRow {
  request_id: string;
  request_json: string;
  profile_hash: string;
  agent: "pi" | "codex";
  session_id: string;
  directory: string;
  workspace: string;
  prepared_at: string;
  server_endpoint: string;
  server_instance: string;
  factory_json: string | null;
}
export interface NativeAgentLaunchReceipt {
  request: NativeAgentLaunchRequest;
  agent: "pi" | "codex";
  preparedAt: string;
  /** Executor-local process admission, NOT authoritative Factory assignment admission. */
  process: ExecutionRexProcessReceipt;
  mcp: NativeAgentMcpReadiness;
  factoryMcp?: NativeAgentMcpReadiness;
  factoryOrigin?: string;
  observationError?: string;
  nativeBinding?: NativeConversationBinding;
  capabilities: {
    rexTools: true;
    factoryCoordination: boolean;
    automaticDelivery: false;
    nativeActivity: false;
  };
}
interface LauncherOptions {
  database: Database;
  processes: RexProcessManager;
  nodeId: string;
  rexServer: string;
  rexExecutable: string;
  configuration: NativeAgentConfiguration;
  workspaceRoots: readonly string[];
  resolveWorkspace(workspaceId: string): string;
  assertWorkspaceAdmission(workspaceId: string, generation: number): void;
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}
function physicalStatePath(path: string): string {
  if (!isAbsolute(path))
    throw new ExecutionError("native_agent_absolute_state_required");
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync(cursor), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(cursor.slice(parent.length + (parent === sep ? 0 : 1)));
      cursor = parent;
    }
  }
}
function absoluteFile(path: string): string {
  if (!isAbsolute(path) || !statSync(path).isFile())
    throw new ExecutionError("native_agent_absolute_file_required");
  return realpathSync(path);
}
function environment(
  profile: ParsedNativeAgentProfile,
): Record<string, string> {
  // In particular do not forward UZINA_*, provider keys, NODE_OPTIONS, Bun preload
  // configuration, or the parent's native session identity implicitly.
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ];
  const result: Record<string, string> = {};
  for (const name of names)
    if (process.env[name] !== undefined) result[name] = process.env[name]!;
  for (const [name, value] of Object.entries(profile.environment)) {
    if (
      /^(UZINA_|FACTORY_|REX_|PI_SESSION_|NODE_OPTIONS$|BUN_OPTIONS$|BUN_INSPECT)/.test(
        name,
      )
    )
      throw new ExecutionError("native_agent_reserved_environment");
    result[name] = value;
  }
  return result;
}

/** Trusted execution host only. Core admission/authorization belongs to the caller. */
export class NativeAgentLauncher {
  readonly #options: LauncherOptions;
  readonly #stateDirectory: string;
  readonly #bun: string;
  readonly #runner: string;
  readonly #tools: string;
  readonly #rex: string;
  readonly #pending = new Set<Promise<unknown>>();
  #closing = false;

  deliveryConfiguration(input: NativeAgentLaunchInput) {
    if (
      !this.#options.configuration.nativePiEntry ||
      this.#options.configuration.profiles[input.profileId]?.agent !== "pi"
    )
      return undefined;
    absoluteFile(this.#options.configuration.nativePiEntry);
    const hex = hash(`${this.#options.nodeId}:${input.requestId}`);
    const sessionId =
      this.#row(input.requestId)?.session_id ??
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return {
      binding: { adapter: "pi" as const, sessionId },
      factoryToolName: `mcp__uzina_factory_${hash(input.requestId).slice(0, 20)}__factory`,
      sessionDirectory: join(this.#stateDirectory, hex, "sessions"),
      workspaceDirectory: this.#options.resolveWorkspace(
        input.target.workspaceId,
      ),
    };
  }

  constructor(options: LauncherOptions) {
    this.#options = options;
    if (
      !rexToolConfigurationSchema.shape.server.safeParse(options.rexServer)
        .success
    )
      throw new ExecutionError("native_agent_explicit_rex_server_required");
    const projected = physicalStatePath(options.configuration.stateDirectory);
    if (
      options.workspaceRoots.some(
        (root) => within(root, projected) || within(projected, root),
      )
    )
      throw new ExecutionError("native_agent_state_overlaps_workspace");
    this.#stateDirectory = privateNativeDirectory(
      options.configuration.stateDirectory,
    );
    this.#bun = absoluteFile(options.configuration.bunExecutable);
    this.#runner = absoluteFile(options.configuration.runnerEntry);
    this.#tools = absoluteFile(options.configuration.rexToolsEntry);
    this.#rex = absoluteFile(options.rexExecutable);
    options.database.exec(`CREATE TABLE IF NOT EXISTS execution_native_agents (
      request_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, profile_hash TEXT NOT NULL,
      agent TEXT NOT NULL, session_id TEXT NOT NULL, directory TEXT NOT NULL,
      workspace TEXT NOT NULL, prepared_at TEXT NOT NULL,
      server_endpoint TEXT NOT NULL, server_instance TEXT NOT NULL, factory_json TEXT
    );
    CREATE TABLE IF NOT EXISTS execution_native_factory_binding(id INTEGER PRIMARY KEY CHECK(id = 1), scope_id TEXT NOT NULL);`);
    if (
      !options.database
        .query<{ name: string }, []>(
          "PRAGMA table_info(execution_native_agents)",
        )
        .all()
        .some((column) => column.name === "factory_json")
    )
      options.database.exec(
        "ALTER TABLE execution_native_agents ADD COLUMN factory_json TEXT",
      );
  }

  launch(
    input: unknown,
    waitMs = 0,
    authorizeAdmission?: () => void,
    factory?: NativeAgentFactoryConnection,
  ): Promise<NativeAgentLaunchReceipt> {
    if (this.#closing)
      return Promise.reject(new ExecutionError("native_agent_host_closed"));
    const pending = this.#launch(input, waitMs, authorizeAdmission, factory);
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }

  inspect(requestId: string): Promise<NativeAgentLaunchReceipt> {
    if (this.#closing)
      return Promise.reject(new ExecutionError("native_agent_host_closed"));
    const row = this.#row(requestId);
    if (!row)
      return Promise.reject(
        new ExecutionError("native_agent_launch_not_found"),
      );
    if (!this.#process(row))
      return Promise.reject(
        new ExecutionError("native_agent_preparation_incomplete"),
      );
    const pending = this.#observe(row);
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }

  get hasPendingOperations(): boolean {
    return this.#pending.size > 0;
  }

  get protectedRoots(): readonly string[] {
    return [
      this.#stateDirectory,
      ...(isAbsolute(this.#options.database.filename)
        ? [this.#options.database.filename]
        : []),
    ];
  }

  /** This executor's native provisioning state belongs to one persisted Core namespace. */
  bindFactoryScope(scopeId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scopeId))
      throw new ExecutionError("native_agent_factory_scope_conflict");
    const db = this.#options.database;
    db.transaction(() => {
      const row = db
        .query<{ scope_id: string }, []>(
          "SELECT scope_id FROM execution_native_factory_binding WHERE id = 1",
        )
        .get();
      if (row && row.scope_id !== scopeId)
        throw new ExecutionError("native_agent_factory_scope_conflict");
      if (!row)
        db.query(
          "INSERT INTO execution_native_factory_binding(id, scope_id) VALUES (1, ?)",
        ).run(scopeId);
    })();
  }

  /** Drains observations only. Native sessions and their MCP subprocesses remain independent. */
  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled(this.#pending);
  }

  #row(id: string): LaunchRow | null {
    return this.#options.database
      .query<LaunchRow, [string]>(
        "SELECT * FROM execution_native_agents WHERE request_id = ?",
      )
      .get(id);
  }
  #processId(row: LaunchRow): string {
    return `native:${hash(`${this.#options.nodeId}:${row.request_id}`)}`;
  }
  #process(row: LaunchRow): ExecutionRexProcessReceipt | undefined {
    try {
      return this.#options.processes.getReceipt(this.#processId(row));
    } catch (error) {
      if (
        error instanceof ExecutionError &&
        error.code === "rex_process_not_found"
      )
        return undefined;
      throw error;
    }
  }

  async #launch(
    input: unknown,
    waitMs: number,
    authorizeAdmission?: () => void,
    factory?: NativeAgentFactoryConnection,
  ): Promise<NativeAgentLaunchReceipt> {
    const parsed = nativeAgentLaunchRequestSchema.safeParse(input);
    if (
      !parsed.success ||
      !Number.isInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 30_000
    )
      throw new ExecutionError("invalid_native_agent_launch");
    const request = parsed.data;
    if (request.target.nodeId !== this.#options.nodeId)
      throw new ExecutionError("target_node_mismatch");
    let row = this.#row(request.requestId);
    if (
      row &&
      (row.request_json !== JSON.stringify(request) ||
        (factory && row.factory_json !== JSON.stringify(factory)))
    )
      throw new ExecutionError("native_agent_launch_conflict");
    // A committed process receipt wins over mutable profile/config preconditions.
    // Do not regenerate bootstrap files or invoke Rex on replay, including uncertainty.
    if (!row || !this.#process(row)) {
      if (row?.factory_json && !factory)
        throw new ExecutionError("native_agent_factory_binding_required");
      let factoryBindingHash: string | undefined;
      if (factory) {
        absoluteFile(factory.entry);
        const raw = readNativeBootstrapFile(factory.configPath);
        const config = factoryWorkerConfigurationSchema.parse(JSON.parse(raw));
        if (
          JSON.stringify(config.nativeDelivery?.binding) !==
            JSON.stringify(factory.nativeBinding) ||
          config.baseUrl !== factory.baseUrl ||
          config.workerId !== factory.workerId ||
          config.projectId !== request.projectId ||
          config.journalPath !== factory.journalPath ||
          config.target.nodeId !== request.target.nodeId ||
          config.target.workspaceId !== request.target.workspaceId ||
          config.ownershipGeneration !== request.ownershipGeneration
        )
          throw new ExecutionError("native_agent_factory_binding_conflict");
        factoryBindingHash = hash(raw);
      }
      const profileInput =
        this.#options.configuration.profiles[request.profileId];
      if (!profileInput)
        throw new ExecutionError("native_agent_profile_not_found");
      const profile = nativeAgentProfileSchema.parse(profileInput);
      const executable = absoluteFile(profile.executable);
      const env = environment(profile);
      const workspace = this.#options.resolveWorkspace(
        request.target.workspaceId,
      );
      const profileHash = hash(
        JSON.stringify({
          profile,
          env,
          executable,
          workspace,
          server: this.#options.rexServer,
          rex: this.#rex,
          bun: this.#bun,
          runner: this.#runner,
          tools: this.#tools,
          state: this.#stateDirectory,
          ...(factory
            ? {
                factory,
                factoryBindingHash,
                ...(factory.nativeBinding
                  ? {
                      nativePiEntry: absoluteFile(
                        this.#options.configuration.nativePiEntry!,
                      ),
                    }
                  : {}),
              }
            : {}),
        }),
      );
      if (row && row.profile_hash !== profileHash)
        throw new ExecutionError("native_agent_profile_conflict");
      this.#options.assertWorkspaceAdmission(
        request.target.workspaceId,
        request.ownershipGeneration,
      );
      const help = Bun.spawnSync([executable, "--help"], {
        env,
        cwd: workspace,
        timeout: 10_000,
        maxBuffer: 131_072,
      });
      const helpText = help.stdout.toString();
      const flags =
        profile.agent === "pi"
          ? ["--extension", "--session-id", "--session-dir"]
          : ["--no-daemon", "--config", "--cd"];
      if (
        help.exitCode !== 0 ||
        flags.some((flag) => !helpText.includes(flag)) ||
        (profile.agent === "codex" && profile.offline)
      )
        throw new ExecutionError("native_agent_unsupported_cli");
      const connection = await this.#options.processes.connection();
      if (this.#closing) throw new ExecutionError("native_agent_host_closed");
      if (connection.endpoint !== this.#options.rexServer)
        throw new ExecutionError("native_agent_rex_binding_conflict");
      // Another call may have prepared the same launch while connection was in flight.
      row = this.#row(request.requestId);
      if (
        row &&
        (row.request_json !== JSON.stringify(request) ||
          row.profile_hash !== profileHash ||
          row.server_endpoint !== connection.endpoint ||
          row.server_instance !== connection.instanceId)
      )
        throw new ExecutionError("native_agent_launch_binding_conflict");
      if (!row) {
        const count = this.#options.database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM execution_native_agents",
          )
          .get()!.count;
        if (count >= 4096)
          throw new ExecutionError("native_agent_launch_limit");
        const directory = join(
          this.#stateDirectory,
          hash(`${this.#options.nodeId}:${request.requestId}`),
        );
        this.#options.database
          .query(`INSERT INTO execution_native_agents
          (request_id, request_json, profile_hash, agent, session_id, directory, workspace, prepared_at, server_endpoint, server_instance, factory_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            request.requestId,
            JSON.stringify(request),
            profileHash,
            profile.agent,
            factory?.nativeBinding?.sessionId ?? randomUUID(),
            directory,
            workspace,
            new Date().toISOString(),
            connection.endpoint,
            connection.instanceId,
            factory ? JSON.stringify(factory) : null,
          );
        row = this.#row(request.requestId)!;
      }
      if (
        row.directory !==
          join(
            this.#stateDirectory,
            hash(`${this.#options.nodeId}:${request.requestId}`),
          ) ||
        row.workspace !== workspace
      )
        throw new ExecutionError("native_agent_launch_binding_conflict");
      // Preparation has no external process effect. After a crash it can only fill
      // missing immutable artifacts with the same pinned identity and bytes.
      privateNativeDirectory(row.directory);
      const mcpDirectory = privateNativeDirectory(join(row.directory, "rex"));
      const configPath = join(mcpDirectory, "server.json");
      writeNativeBootstrapFile(
        configPath,
        JSON.stringify({
          workspaceDirectory: workspace,
          journalPath: join(mcpDirectory, "journal.sqlite"),
          server: this.#options.rexServer,
          rexExecutable: this.#rex,
        }),
      );
      const serverName = `uzina_rex_${hash(request.requestId).slice(0, 20)}`;
      const server = {
        command: this.#bun,
        args: ["--no-env-file", this.#tools, "mcp", "--config", configPath],
        cwd: workspace,
      };
      const servers = [{ name: serverName, server }];
      if (factory)
        servers.push({
          name: `uzina_factory_${hash(request.requestId).slice(0, 20)}`,
          server: {
            command: this.#bun,
            args: [
              "--no-env-file",
              factory.entry,
              "--config",
              factory.configPath,
            ],
            cwd: workspace,
          },
        });
      let argv: string[];
      if (profile.agent === "pi") {
        const extension = join(row.directory, "rex-mcp.ts");
        writeNativeBootstrapFile(
          extension,
          `${factory?.nativeBinding ? `import { getKeybindings } from "@earendil-works/pi-tui"; import { installNativePi } from ${JSON.stringify(pathToFileURL(absoluteFile(this.#options.configuration.nativePiEntry!)).href)};\n` : ""}export default function(pi) { ${factory?.nativeBinding ? `installNativePi(pi, ${JSON.stringify(factory.configPath)}, data => data === "\\x1b" || data === "\\x03" || getKeybindings().matches(data, "app.interrupt")); ` : ""}${servers.map(({ name, server: entry }) => `pi.registerMcpServer(${JSON.stringify(name)}, ${JSON.stringify({ ...entry, exposure: "direct" })});`).join(" ")} }\n`,
        );
        const sessions = privateNativeDirectory(
          join(row.directory, "sessions"),
        );
        argv = [
          "--session-id",
          row.session_id,
          "--session-dir",
          sessions,
          "--extension",
          extension,
          ...(profile.offline ? ["--offline"] : []),
        ];
      } else {
        // CLI overrides are invocation-local; --no-daemon keeps them out of a
        // shared app-server. No approval/sandbox/trust setting is weakened.
        argv = [
          "--no-daemon",
          "--cd",
          workspace,
          ...servers.flatMap(({ name, server: entry }) => {
            const fields = {
              ...entry,
              enabled: true,
              required: true,
              startup_readiness: "connection",
              startup_timeout_sec: 30,
            };
            const override = `mcp_servers.${name}={ ${Object.entries(fields)
              .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
              .join(", ")} }`;
            return ["--config", override];
          }),
        ];
      }
      writeNativeBootstrapFile(
        join(row.directory, "client.json"),
        JSON.stringify({
          agent: profile.agent,
          serverName,
          server,
          ...(factory ? { servers } : {}),
        }),
      );
      writeNativeBootstrapFile(
        join(row.directory, "launch.json"),
        JSON.stringify(
          nativeAgentBootstrapSchema.parse({
            workspaceDirectory: workspace,
            executable,
            argv,
            environment: env,
          }),
        ),
      );
      const fd = openSync(row.directory, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Recheck Core authority after asynchronous connection discovery, directly
      // before the synchronous executor intent transaction. No await separates them.
      authorizeAdmission?.();
      // RexProcessManager owns single-effect admission and interrupted-launch
      // recovery, in the SAME executor journal used by workspace capture fences.
      await this.#options.processes.launch({
        contractVersion: 1,
        processId: this.#processId(row),
        nodeId: this.#options.nodeId,
        target: request.target,
        ownershipGeneration: request.ownershipGeneration,
        argv: [
          this.#bun,
          "--no-env-file",
          this.#runner,
          "--config",
          join(row.directory, "launch.json"),
        ],
      });
    }
    const deadline = Date.now() + waitMs;
    while (true) {
      const result = await this.#observe(row);
      if (
        (result.mcp.status === "ready" &&
          (!result.factoryMcp || result.factoryMcp.status === "ready")) ||
        result.process.status !== "running" ||
        Date.now() >= deadline ||
        this.#closing
      )
        return result;
      await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }

  async #observe(row: LaunchRow): Promise<NativeAgentLaunchReceipt> {
    let observationError: string | undefined;
    try {
      if (row.server_endpoint !== this.#options.rexServer)
        throw new ExecutionError("native_agent_rex_binding_conflict");
      const connection = await this.#options.processes.connection();
      if (
        connection.endpoint !== row.server_endpoint ||
        connection.instanceId !== row.server_instance
      )
        throw new ExecutionError("native_agent_rex_binding_conflict");
      await this.#options.processes.inspect(this.#processId(row));
    } catch {
      observationError = "native_agent_process_observation_unavailable";
    }
    const receipt = this.#options.processes.getReceipt(this.#processId(row));
    let mcp = readRexMcpReadiness(join(row.directory, "rex", "journal.sqlite"));
    if (observationError && mcp.status === "ready")
      mcp = {
        ...mcp,
        status: "unavailable",
        errorCode: "native_agent_process_observation_unavailable",
      };
    else if (receipt.status !== "running" && mcp.status === "ready")
      mcp = { ...mcp, status: "disconnected" };
    let factoryMcp: NativeAgentMcpReadiness | undefined;
    if (row.factory_json) {
      factoryMcp = readLocalMcpReadiness(
        (JSON.parse(row.factory_json) as NativeAgentFactoryConnection)
          .journalPath,
        "factory",
      );
      if (
        factoryMcp.status === "ready" &&
        (observationError || receipt.status !== "running")
      )
        factoryMcp = {
          ...factoryMcp,
          status: observationError ? "unavailable" : "disconnected",
          ...(observationError ? { errorCode: observationError } : {}),
        };
    }
    return {
      request: JSON.parse(row.request_json) as NativeAgentLaunchRequest,
      agent: row.agent,
      preparedAt: row.prepared_at,
      process: receipt,
      mcp,
      ...(factoryMcp
        ? {
            factoryMcp,
            factoryOrigin: (
              JSON.parse(row.factory_json!) as NativeAgentFactoryConnection
            ).baseUrl,
          }
        : {}),
      ...(observationError ? { observationError } : {}),
      ...(row.factory_json && JSON.parse(row.factory_json).nativeBinding
        ? {
            nativeBinding: JSON.parse(row.factory_json)
              .nativeBinding as NativeConversationBinding,
          }
        : {}),
      capabilities: {
        rexTools: true,
        factoryCoordination: !!row.factory_json,
        automaticDelivery: false,
        nativeActivity: false,
      },
    };
  }
}
