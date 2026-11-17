import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Miniflare } from "../../cloudflare/test/miniflare-test-support";
import { buildCloudflareWorkerArtifact } from "../../cloudflare/scripts/build-worker";
import { CaptureStateBarrier } from "../../cloudflare/test/capture-state-barrier";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CONTRACT_VERSION } from "@uzina/contracts";
import type {
  ManagedWorkImportStatus,
  ManagedWorkTransferHoldStatus,
} from "@uzina/contracts/factory";
import { ManagedPiWork, type ManagedModels } from "@uzina/pi-runtime";
import {
  exportManagedWorkCheckpoint,
  type ManagedWorkCheckpoint,
} from "@uzina/pi-runtime/checkpoint";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import {
  captureManagedWorkBundle,
  FileBlobTransport,
  restoreManagedWorkBundle,
  validateManagedWorkBundle,
  WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
  type BlobTransport,
  type WorkspaceCheckpointManifest,
} from "@uzina/checkpoints";
import {
  ExecutionDaemon,
  type WorkspaceMapping,
} from "../src/execution/daemon";
import { HttpExecutionControllerConnector } from "../src/execution/connector";
import { ExecutionLoop } from "../src/execution/loop";
import {
  createStandaloneFactoryServer,
  type StandaloneFactoryServer,
} from "../src/factory/standalone";
import { deterministicFailingModels } from "../../../packages/pi-runtime/test-support/deterministic-failing-model";
import { deterministicToolModels } from "../../../packages/pi-runtime/test-support/deterministic-tool-model";
import {
  MANAGED_WORK_RUNTIME_REQUIREMENTS,
  composeManagedWorkBundleFromWorkspace,
  parseManagedWorkBundleManifestBytes,
  prepareManagedWorkBundleComposition,
  verifyManagedWorkBundleMetadata,
} from "@uzina/checkpoints/managed-work-composition";
import { MANAGED_REMOTE_TOOL_REQUIREMENTS } from "@uzina/pi-runtime/tools";
import { portableWorkspaceBlobReferences } from "@uzina/checkpoints/portable";
import { factoryProvenanceEvidenceSchema } from "@uzina/contracts/factory";
import { BoundedManagedWorkImportCatalog } from "../src/factory/managed-work-import-catalog";
import { openBunSqliteStorage } from "../src/runtime/sqlite";

setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value)!;
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resignedBundle(value: Record<string, unknown>): {
  reference: string;
  bytes: Buffer;
} {
  const { sha256: _oldChecksum, ...body } = value;
  const manifest = {
    ...body,
    sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
  const bytes = Buffer.from(canonicalJson(manifest), "utf8");
  return { reference: sha256(bytes), bytes };
}

function overlayTransport(
  base: BlobTransport,
  blobs: ReadonlyMap<string, Uint8Array>,
): BlobTransport {
  return {
    putBlob: (bytes) => base.putBlob(bytes),
    async getBlob(reference) {
      return blobs.get(reference) ?? base.getBlob(reference);
    },
  };
}

const fixtures: Array<{ directory: string; close(): Promise<void> }> = [];
const ownedImportProcesses = new Set<ReturnType<typeof Bun.spawn>>();
const ownedImportStreams = new Map<
  ReturnType<typeof Bun.spawn>,
  { stdout: OwnedProcessStream; stderr: OwnedProcessStream }
>();

async function call<T>(
  baseUrl: string,
  path: string,
  options: { credential?: string; bootstrap?: boolean; body?: unknown } = {},
): Promise<{ status: number; value: T }> {
  const response = await fetch(new URL(path, baseUrl), {
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
  });
  return { status: response.status, value: (await response.json()) as T };
}

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for composed local managed execution");
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      await Bun.sleep(10);
    }
  }
  throw new Error(`Timed out waiting for owned test file ${path}`);
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

class OwnedProcessStream {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #waiters = new Set<() => void>();
  readonly #pump: Promise<void>;
  #text = "";
  #ended = false;
  #failed = false;
  #failure: unknown;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
    this.#pump = this.#consume();
  }

  get text(): string {
    return this.#text;
  }

  get ended(): boolean {
    return this.#ended;
  }

  async waitForLine(prefix: string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const line = this.#text
        .split("\n")
        .find((candidate) => candidate.startsWith(prefix));
      if (line) return line;
      if (this.#ended) {
        if (this.#failed) throw this.#failure;
        throw new Error(`Owned child exited before output ${prefix}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for child output ${prefix}`);
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          this.#waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(() => {
          this.#waiters.delete(wake);
          reject(new Error(`Timed out waiting for child output ${prefix}`));
        }, remaining);
        this.#waiters.add(wake);
      });
    }
  }

  async join(): Promise<void> {
    await this.#pump;
    if (this.#failed) throw this.#failure;
  }

  async cancel(): Promise<void> {
    if (!this.#ended) {
      try {
        await this.#reader.cancel();
      } catch (error) {
        if (!this.#failed) {
          this.#failed = true;
          this.#failure = error;
        }
      }
    }
    await this.join();
  }

  async #consume(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await this.#reader.read();
        if (chunk.done) {
          this.#text += decoder.decode();
          break;
        }
        this.#text += decoder.decode(chunk.value, { stream: true });
        this.#notify();
      }
    } catch (error) {
      this.#failed = true;
      this.#failure = error;
    } finally {
      this.#ended = true;
      try {
        this.#reader.releaseLock();
      } catch (error) {
        if (!this.#failed) {
          this.#failed = true;
          this.#failure = error;
        }
      }
      this.#notify();
    }
  }

  #notify(): void {
    for (const wake of this.#waiters) wake();
  }
}

interface ManagedWorkImportChildConfiguration {
  databasePath: string;
  runtimeDirectory: string;
  bootstrapSecret: string;
  catalogs: Readonly<Record<string, string>>;
  destinations: Readonly<Record<string, string>>;
  workspacePath: string;
  modelProvider: string;
  modelId: string;
}

interface ManagedWorkImportChild {
  child: ReturnType<typeof Bun.spawn>;
  url: string;
  statsPath: string;
  stdout: OwnedProcessStream;
  stderr: OwnedProcessStream;
}

async function startManagedWorkImportChild(options: {
  configuration: ManagedWorkImportChildConfiguration;
  gateDirectory?: string;
  finalRenameGateDirectory?: string;
  finalRenameTarget?: string;
  catalogOpenGateDirectory?: string;
  catalogOpenTarget?: string;
  catalogChunkReadGateDirectory?: string;
  catalogChunkReadTarget?: string;
  workspaceVerifyGateDirectory?: string;
  workspaceVerifyTarget?: string;
  workspaceVerifyRoot?: string;
  workspaceGrowthGateDirectory?: string;
  workspaceGrowthTarget?: string;
  receiptMarkerProbeGateDirectory?: string;
  receiptMarkerProbeTarget?: string;
  receiptMarkerProbeRoot?: string;
  preparedReceiptGateDirectory?: string;
  preparedReceiptTarget?: string;
  validationGitGateDirectory?: string;
  wrapperDirectory: string;
  realGit: string;
  fetchLog: string;
  temporaryDirectory: string;
  homeDirectory: string;
  statsPath: string;
}): Promise<ManagedWorkImportChild> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "managed-work-import-child.ts"),
    ],
    cwd: process.cwd(),
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${options.wrapperDirectory}:${process.env.PATH ?? ""}`,
      HOME: options.homeDirectory,
      TMPDIR: options.temporaryDirectory,
      LANG: "C",
      UZINA_TEST_REAL_GIT: options.realGit,
      UZINA_TEST_GIT_FETCH_LOG: options.fetchLog,
      UZINA_TEST_GIT_FETCH_GATE_DIR: options.gateDirectory ?? "",
      UZINA_TEST_GIT_VALIDATION_GATE_DIR:
        options.validationGitGateDirectory ?? "",
      UZINA_IMPORT_CHILD_FINAL_RENAME_GATE:
        options.finalRenameGateDirectory ?? "",
      UZINA_IMPORT_CHILD_FINAL_RENAME_TARGET: options.finalRenameTarget ?? "",
      UZINA_IMPORT_CHILD_CATALOG_OPEN_GATE:
        options.catalogOpenGateDirectory ?? "",
      UZINA_IMPORT_CHILD_CATALOG_OPEN_TARGET: options.catalogOpenTarget ?? "",
      UZINA_IMPORT_CHILD_CATALOG_CHUNK_READ_GATE:
        options.catalogChunkReadGateDirectory ?? "",
      UZINA_IMPORT_CHILD_CATALOG_CHUNK_READ_TARGET:
        options.catalogChunkReadTarget ?? "",
      UZINA_IMPORT_CHILD_WORKSPACE_VERIFY_GATE:
        options.workspaceVerifyGateDirectory ?? "",
      UZINA_IMPORT_CHILD_WORKSPACE_VERIFY_TARGET:
        options.workspaceVerifyTarget ?? "",
      UZINA_IMPORT_CHILD_WORKSPACE_VERIFY_ROOT:
        options.workspaceVerifyRoot ?? "",
      UZINA_IMPORT_CHILD_WORKSPACE_GROWTH_GATE:
        options.workspaceGrowthGateDirectory ?? "",
      UZINA_IMPORT_CHILD_WORKSPACE_GROWTH_TARGET:
        options.workspaceGrowthTarget ?? "",
      UZINA_IMPORT_CHILD_RECEIPT_MARKER_PROBE_GATE:
        options.receiptMarkerProbeGateDirectory ?? "",
      UZINA_IMPORT_CHILD_RECEIPT_MARKER_PROBE_TARGET:
        options.receiptMarkerProbeTarget ?? "",
      UZINA_IMPORT_CHILD_RECEIPT_MARKER_PROBE_ROOT:
        options.receiptMarkerProbeRoot ?? "",
      UZINA_IMPORT_CHILD_PREPARED_RECEIPT_GATE:
        options.preparedReceiptGateDirectory ?? "",
      UZINA_IMPORT_CHILD_PREPARED_RECEIPT_TARGET:
        options.preparedReceiptTarget ?? "",
      UZINA_IMPORT_CHILD_CONFIG: JSON.stringify(options.configuration),
      UZINA_IMPORT_CHILD_STATS: options.statsPath,
    },
  });
  ownedImportProcesses.add(child);
  const stdout = new OwnedProcessStream(child.stdout);
  const stderr = new OwnedProcessStream(child.stderr);
  ownedImportStreams.set(child, { stdout, stderr });
  try {
    const line = await stdout.waitForLine("RECOVERY_CHILD_READY ");
    const ready = JSON.parse(line.slice("RECOVERY_CHILD_READY ".length)) as {
      url: string;
    };
    return {
      child,
      url: ready.url,
      statsPath: options.statsPath,
      stdout,
      stderr,
    };
  } catch (error) {
    let cleanupError: unknown;
    try {
      await stopManagedWorkImportChild(child, "SIGKILL");
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure;
    }
    const cause = cleanupError
      ? new AggregateError(
          [error, cleanupError],
          "Owned child startup and cleanup failed",
        )
      : error;
    throw new Error(`Owned standalone child failed to start: ${stderr.text}`, {
      cause,
    });
  }
}

function processGroupExists(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalOwnedProcessGroup(
  processId: number,
  signal: "SIGKILL" | "SIGTERM",
): void {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      return;
    }
    throw error;
  }
}

async function stopManagedWorkImportChild(
  child: ReturnType<typeof Bun.spawn>,
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  const processId = child.pid;
  const failures: unknown[] = [];
  try {
    signalOwnedProcessGroup(processId, signal);
  } catch (error) {
    failures.push(error);
  }

  let exitCode: number | undefined;
  try {
    exitCode = await withTimeout(
      child.exited,
      5_000,
      "Timed out reaping owned standalone process",
    );
  } catch (error) {
    failures.push(error);
    try {
      signalOwnedProcessGroup(processId, "SIGKILL");
      exitCode = await withTimeout(
        child.exited,
        5_000,
        "Timed out reaping SIGKILLed standalone process",
      );
    } catch (killError) {
      failures.push(killError);
    }
  }
  if (signal === "SIGTERM" && exitCode !== undefined && exitCode !== 0) {
    failures.push(
      new Error(`Graceful standalone child exited with code ${exitCode}`),
    );
  }

  let deadline = Date.now() + 5_000;
  while (processGroupExists(processId) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  if (processGroupExists(processId)) {
    failures.push(
      new Error("Owned standalone process group survived termination"),
    );
    try {
      signalOwnedProcessGroup(processId, "SIGKILL");
    } catch (error) {
      failures.push(error);
    }
    deadline = Date.now() + 5_000;
    while (processGroupExists(processId) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    if (processGroupExists(processId)) {
      failures.push(
        new Error("Owned standalone process group survived SIGKILL"),
      );
    }
  }

  const streams = ownedImportStreams.get(child);
  let streamsClean = true;
  if (streams) {
    for (const stream of [streams.stdout, streams.stderr]) {
      try {
        await withTimeout(
          stream.join(),
          5_000,
          "Timed out joining owned standalone process stream",
        );
      } catch (error) {
        failures.push(error);
        if (!stream.ended) {
          try {
            await withTimeout(
              stream.cancel(),
              5_000,
              "Timed out cancelling owned standalone process stream",
            );
          } catch (cancelError) {
            streamsClean = false;
            if (cancelError !== error) failures.push(cancelError);
          }
        }
      }
    }
    if (streamsClean) ownedImportStreams.delete(child);
  }
  if (!processGroupExists(processId) && streamsClean) {
    ownedImportProcesses.delete(child);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Owned standalone process cleanup failed",
    );
  }
}

async function makeDirtyGitWorkspace(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.name", "Cloud producer fixture");
  git(directory, "config", "user.email", "producer@example.invalid");
  await writeFile(join(directory, "tracked.txt"), "base\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-m", "base");
  await writeFile(join(directory, "tracked.txt"), "staged source\n");
  git(directory, "add", "tracked.txt");
  await writeFile(join(directory, "tracked.txt"), "working source\n");
  await writeFile(join(directory, "binary"), new Uint8Array([0, 255, 17, 128]));
  await chmod(join(directory, "binary"), 0o755);
}

async function gitWorkspaceEvidence(directory: string) {
  const binary = await readFile(join(directory, "binary"));
  const binaryStat = await stat(join(directory, "binary"));
  return {
    head: git(directory, "rev-parse", "HEAD"),
    status: git(directory, "status", "--porcelain=v1", "--untracked-files=all"),
    stagedDiff: git(directory, "diff", "--cached", "--binary", "HEAD"),
    workingDiff: git(directory, "diff", "--binary"),
    binarySha256: sha256(binary),
    binaryMode: binaryStat.mode & 0o777,
    sourceEffect: await readFile(join(directory, "source-effect.txt"), "utf8"),
  };
}

type PublicStorageObservation = Pick<
  ManagedWorkCheckpoint,
  "conversations" | "entries" | "tasks" | "submissions" | "documents"
> & { sessionDocuments: unknown[] };

async function readPublicStorageObservation(
  baseUrl: string,
  threadId: string,
): Promise<PublicStorageObservation> {
  const response = await call<PublicStorageObservation>(
    baseUrl,
    "/__test/managed-work",
    {
      body: {
        threadId,
        operation: { kind: "public-storage-observation" },
      },
    },
  );
  expect(response.status).toBe(200);
  return response.value;
}

async function readRawImportedCheckpoint(path: string) {
  const storage = await openBunSqliteStorage(path);
  try {
    return await exportManagedWorkCheckpoint(
      storage,
      ROOT_CONVERSATION_ID as ConversationId,
    );
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

function localCoreSurfaceCounts(host: StandaloneFactoryServer) {
  const tables = [
    "factory_users",
    "credentials",
    "assistant_credential_grants",
    "access_grants",
    "invitations",
    "projects",
    "nodes",
    "workspaces",
    "threads",
    "dispatch_intents",
    "command_receipts",
    "execution_jobs",
  ] as const;
  return Object.fromEntries(
    tables.map((table) => [
      table,
      host.database.all<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table}`,
      )[0]?.count,
    ]),
  );
}

async function scenario(options: {
  models: ManagedModels;
  modelProvider: string;
  modelId: string;
  directoryPrefix: string;
  deferExecutor?: boolean;
  extraWorkspaceDirectories?: Readonly<Record<string, string>>;
  extraWorkspaceSubdirectories?: Readonly<Record<string, string>>;
  extraWorkspaceAliases?: readonly string[];
  managedWorkImportPaths?: (directory: string) => {
    catalogs: Readonly<Record<string, string>>;
    destinations: Readonly<Record<string, string>>;
  };
  managedWorkImportEnabled?: () => boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), options.directoryPrefix));
  const workspaceDirectory = join(directory, "workspace");
  await mkdir(workspaceDirectory);
  const managedWorkImportPaths = options.managedWorkImportPaths?.(directory);
  if (managedWorkImportPaths) {
    for (const catalogPath of Object.values(managedWorkImportPaths.catalogs)) {
      await mkdir(catalogPath, { recursive: true });
    }
    for (const destinationPath of Object.values(
      managedWorkImportPaths.destinations,
    )) {
      await mkdir(dirname(destinationPath), { recursive: true });
    }
  }
  for (const workspacePath of Object.values(
    options.extraWorkspaceDirectories ?? {},
  )) {
    await mkdir(workspacePath, { recursive: true });
  }
  const extraWorkspaceMappings = {
    ...options.extraWorkspaceDirectories,
  };
  for (const [workspaceId, relativePath] of Object.entries(
    options.extraWorkspaceSubdirectories ?? {},
  )) {
    const workspacePath = join(workspaceDirectory, relativePath);
    await mkdir(workspacePath, { recursive: true });
    extraWorkspaceMappings[workspaceId] = workspacePath;
  }
  for (const [index, workspaceId] of (
    options.extraWorkspaceAliases ?? []
  ).entries()) {
    const aliasPath = join(directory, `workspace-alias-${index}`);
    await symlink(workspaceDirectory, aliasPath);
    extraWorkspaceMappings[workspaceId] = aliasPath;
  }
  let host: StandaloneFactoryServer | undefined;
  let execution: ExecutionDaemon | undefined;
  let abort: AbortController | undefined;
  let runningLoop: Promise<void> | undefined;
  const bootstrapSecret = `${options.directoryPrefix}-bootstrap`;
  const openHost = () =>
    createStandaloneFactoryServer({
      databasePath: join(directory, "factory.sqlite"),
      runtimeDirectory: join(directory, "managed-work"),
      ...(managedWorkImportPaths &&
      (options.managedWorkImportEnabled?.() ?? true)
        ? {
            managedWorkImportCatalogs: managedWorkImportPaths.catalogs,
            managedWorkImportDestinations: managedWorkImportPaths.destinations,
          }
        : {}),
      bootstrapSecret,
      models: options.models,
      modelProvider: options.modelProvider,
      modelId: options.modelId,
      workspaceDirectories: {
        "workspace:local-proof": workspaceDirectory,
        ...extraWorkspaceMappings,
      },
      workspaceCaptureQuiescence: {
        async acquire(workspaceId, captureId) {
          if (!execution)
            throw new Error("Local execution daemon is unavailable");
          execution.beginWorkspaceCapture(workspaceId, captureId);
          return {
            workspacePath: execution.workspaceDirectory(workspaceId),
            release: () => execution?.endWorkspaceCapture(captureId),
          };
        },
      },
      port: 0,
    });
  try {
    host = await openHost();
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Local Factory startup and temporary-directory cleanup failed",
      );
    }
    throw error;
  }
  const fixture = {
    directory,
    get host() {
      if (!host) throw new Error("Factory host is closed");
      return host;
    },
    get baseUrl() {
      return this.host.server.url.toString();
    },
    workspaceDirectory,
    async stopExecution() {
      abort?.abort();
      const loop = runningLoop;
      const currentExecution = execution;
      runningLoop = undefined;
      abort = undefined;
      execution = undefined;
      const failures: unknown[] = [];
      try {
        await loop;
      } catch (error) {
        failures.push(error);
      }
      try {
        currentExecution?.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Local execution cleanup failed");
      }
    },
    addWorkspaceMapping(workspaceId: string, path: string) {
      extraWorkspaceMappings[workspaceId] = path;
    },
    removeWorkspaceMapping(workspaceId: string) {
      delete extraWorkspaceMappings[workspaceId];
    },
    async reopenFactory() {
      const failures: unknown[] = [];
      try {
        await this.stopExecution();
      } catch (error) {
        failures.push(error);
      }
      try {
        await host?.close();
      } catch (error) {
        failures.push(error);
      }
      host = undefined;
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Local Factory reopen cleanup failed",
        );
      }
      host = await openHost();
    },
    async close() {
      const failures: unknown[] = [];
      try {
        await this.stopExecution();
      } catch (error) {
        failures.push(error);
      }
      try {
        await host?.close();
      } catch (error) {
        failures.push(error);
      }
      host = undefined;
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Local Factory fixture cleanup failed",
        );
      }
    },
  };
  fixtures.push(fixture);

  const bootstrapped = await call<{ credential: string }>(
    fixture.baseUrl,
    "/v1/bootstrap",
    {
      credential: bootstrapSecret,
      bootstrap: true,
      body: { name: "Local test owner" },
    },
  );
  expect(bootstrapped.status).toBe(201);
  const owner = bootstrapped.value.credential;
  const project = await call<{ projectId: string }>(
    fixture.baseUrl,
    "/v1/projects",
    {
      credential: owner,
      body: { projectId: "project:local-proof", name: "Local proof" },
    },
  );
  const node = await call<{
    node: { nodeId: string };
    credential: string;
  }>(fixture.baseUrl, "/v1/nodes", {
    credential: owner,
    body: { nodeId: "node:local-proof", name: "Temporary local executor" },
  });
  const workspace = await call<{ workspaceId: string }>(
    fixture.baseUrl,
    "/v1/workspaces",
    {
      credential: owner,
      body: {
        workspaceId: "workspace:local-proof",
        nodeId: node.value.node.nodeId,
        name: "Selected temporary workspace",
      },
    },
  );
  const mapping: WorkspaceMapping = {
    workspaceId: workspace.value.workspaceId,
    directory: workspaceDirectory,
  };
  const startExecution = async () => {
    if (execution) return;
    execution = new ExecutionDaemon({
      databasePath: join(directory, "executor.sqlite"),
      nodeId: node.value.node.nodeId,
      nodeCredential: node.value.credential,
      workspaces: [mapping],
      daemonVersion: "slice-4b-test",
    });
    abort = new AbortController();
    runningLoop = new ExecutionLoop({
      daemon: execution,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: fixture.baseUrl,
        nodeId: node.value.node.nodeId,
        credential: node.value.credential,
      }),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 500,
    }).run(abort.signal);
    await until(async () => {
      const nodes = await call<{ nodes: Array<{ availability: string }> }>(
        fixture.baseUrl,
        "/v1/nodes",
        { credential: owner },
      );
      return nodes.value.nodes[0]?.availability === "online";
    });
  };
  if (!options.deferExecutor) await startExecution();
  const thread = await call<{ threadId: string }>(
    fixture.baseUrl,
    "/v1/threads",
    {
      credential: owner,
      body: {
        threadId: "thread:local-proof",
        projectId: project.value.projectId,
        title: "Managed tool proof",
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspace.value.workspaceId,
        },
      },
    },
  );
  return Object.assign(fixture, {
    executionDaemon() {
      if (!execution) throw new Error("Execution daemon is not running");
      return execution;
    },
    owner,
    nodeId: node.value.node.nodeId,
    nodeCredential: node.value.credential,
    workspaceId: workspace.value.workspaceId,
    threadId: thread.value.threadId,
    startExecution,
  });
}

afterEach(async () => {
  const cleanupFailures: unknown[] = [];
  for (const child of ownedImportProcesses) {
    try {
      await stopManagedWorkImportChild(child, "SIGKILL");
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await rm(fixture.directory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Owned test fixture cleanup failed",
    );
  }
});

describe("standalone local Factory managed Pi composition", () => {
  test("authenticated offline import prepares a real bundle once and remains isolated across reopen", async () => {
    let importsEnabled = true;
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: { path: "managed-result.txt", content: "captured locally" },
      answer: "The managed work is ready for an offline handoff.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-offline-import-consumer-",
      managedWorkImportEnabled: () => importsEnabled,
      managedWorkImportPaths: (directory) => ({
        catalogs: {
          "catalog:offline-proof": join(directory, "offline-catalog"),
        },
        destinations: {
          "destination:offline-proof": join(
            directory,
            "prepared-import",
            "slot",
          ),
          "destination:model-proof": join(
            directory,
            "prepared-import",
            "model-mismatch",
          ),
          "destination:tool-proof": join(
            directory,
            "prepared-import",
            "unsupported-tools",
          ),
          "destination:foreign-proof": join(
            directory,
            "prepared-import",
            "foreign-existing",
          ),
          "destination:empty-proof": join(
            directory,
            "prepared-import",
            "preexisting-empty",
          ),
          "destination:shutdown-proof": join(
            directory,
            "prepared-import",
            "shutdown-owned",
          ),
        },
      }),
    });
    const catalogPath = join(local.directory, "offline-catalog");
    const destinationPath = join(local.directory, "prepared-import", "slot");
    const importTransport = new FileBlobTransport(catalogPath);
    const workspace = local.workspaceDirectory;
    git(workspace, "init", "--initial-branch=main", "--quiet");
    git(workspace, "config", "user.name", "Offline import test");
    git(workspace, "config", "user.email", "offline-import@example.invalid");
    await writeFile(join(workspace, "notes.txt"), "offline source note\n");
    git(workspace, "add", "--all");
    git(workspace, "commit", "-m", "offline source");

    const input = {
      requestId: "request:offline-import-source",
      text: "Write a result and prepare this work for a file handoff.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });

    const runtimeFilename = join(
      local.directory,
      "managed-work",
      createHash("sha256").update(local.threadId).digest("hex") + ".sqlite",
    );
    const runtimeBeforeImport = await stat(runtimeFilename);
    const captured = await local.host.captureManagedWorkCheckpoint({
      credential: local.owner,
      threadId: local.threadId,
      transport: importTransport,
    });
    const validatedBundle = await validateManagedWorkBundle(
      captured.manifestReference,
      importTransport,
      {
        supportedRuntimeRequirements: [
          "model:uzina-test/fixed-model",
          "tool:remote_read_file:v1",
          "tool:remote_write_file:v1",
          "tool:remote_run_command:v1",
        ],
      },
    );
    expect(validatedBundle.manifest.format).toBe(
      "uzina-coherent-managed-work-checkpoint",
    );
    const boundedCatalog = new BoundedManagedWorkImportCatalog({
      canonicalRoot: await realpath(catalogPath),
      manifestReference: captured.manifestReference,
      expectedRuntimeRequirements: [
        "model:uzina-test/fixed-model",
        "tool:remote_read_file:v1",
        "tool:remote_write_file:v1",
        "tool:remote_run_command:v1",
      ],
      beforeAndAfterRead: async () => {},
    });
    await boundedCatalog.prepare();
    await expect(boundedCatalog.getBlob("f".repeat(64))).rejects.toThrow(
      "unlisted blob",
    );

    const staleModelCheckpoint = structuredClone(validatedBundle.managedWork);
    const rootAgent = staleModelCheckpoint.documents.find(
      ({ record }) =>
        record.kind === "pi.agent" &&
        record.scope.kind === "conversation" &&
        record.scope.conversationId === staleModelCheckpoint.rootConversationId,
    );
    if (!rootAgent) throw new Error("Real source checkpoint has no root agent");
    rootAgent.value.model = {
      provider: "uzina-test",
      modelId: "stale-model",
    };
    const { sha256: _priorCheckpointHash, ...staleCheckpointBody } =
      staleModelCheckpoint;
    staleModelCheckpoint.sha256 = sha256(
      Buffer.from(canonicalJson(staleCheckpointBody), "utf8"),
    );
    const stalePrepared = await prepareManagedWorkBundleComposition({
      managedWork: staleModelCheckpoint,
      compatibilityRequirements: [
        "model:uzina-test/fixed-model",
        "tool:remote_read_file:v1",
        "tool:remote_write_file:v1",
        "tool:remote_run_command:v1",
      ],
    });
    const staleSourceManifest = {
      ...validatedBundle.manifest.workspace,
      runtimeArtifact: null,
      attachments: [],
    };
    const staleSourceManifestBytes = Buffer.from(
      canonicalJson(staleSourceManifest),
      "utf8",
    );
    const staleSourceManifestReference = await importTransport.putBlob(
      staleSourceManifestBytes,
    );
    const staleBundle = await composeManagedWorkBundleFromWorkspace({
      prepared: stalePrepared,
      workspaceManifest: staleSourceManifest,
      workspaceManifestReference: staleSourceManifestReference,
      workspaceManifestBytes: staleSourceManifestBytes,
      transport: importTransport,
    });

    const request = {
      contractVersion: CONTRACT_VERSION,
      requestId: "import:offline-local-proof",
      sourceCatalogId: "catalog:offline-proof",
      manifestSha256: captured.manifestReference,
      destinationId: "destination:offline-proof",
    };
    const first = await call<{
      status: string;
      preparationReceipt?: { preparedAt: string; status: string };
      preparationReceiptSha256?: string;
    }>(local.baseUrl, "/v1/managed-work-imports", {
      credential: local.owner,
      body: request,
    });
    expect(first.status).toBe(202);
    expect(first.value.status).toBe("prepared-inactive");
    expect(first.value.preparationReceipt?.status).toBe("prepared-inactive");
    expect(first.value.preparationReceiptSha256).toMatch(/^[a-f0-9]{64}$/);

    const persistedReceipt = JSON.parse(
      await readFile(
        join(destinationPath, ".uzina", "prepared-restore.json"),
        "utf8",
      ),
    ) as { manifestReference: string; status: string; preparedAt: string };
    expect(persistedReceipt).toMatchObject({
      manifestReference: captured.manifestReference,
      status: "prepared-inactive",
      preparedAt: first.value.preparationReceipt?.preparedAt,
    });
    expect(
      git(destinationPath + "/workspace", "status", "--porcelain=v1"),
    ).toContain("managed-result.txt");
    const rawDatabase = new Database(
      join(destinationPath, "managed-work.sqlite"),
      {
        readonly: true,
      },
    );
    try {
      expect(
        Object.values(
          rawDatabase.query("PRAGMA quick_check").get() as object,
        )[0],
      ).toBe("ok");
    } finally {
      rawDatabase.close();
    }

    const staleModelImport = await call<{ status: string }>(
      local.baseUrl,
      "/v1/managed-work-imports",
      {
        credential: local.owner,
        body: {
          ...request,
          requestId: "import:stale-root-model",
          manifestSha256: staleBundle.manifestReference,
          destinationId: "destination:model-proof",
        },
      },
    );
    expect(staleModelImport.status).toBe(202);
    expect(staleModelImport.value.status).toBe("blocked");
    await expect(
      lstat(join(local.directory, "prepared-import", "model-mismatch")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const unsupportedToolCheckpoint = structuredClone(
      validatedBundle.managedWork,
    );
    const unsupportedToolRoot = unsupportedToolCheckpoint.documents.find(
      ({ record }) =>
        record.kind === "pi.agent" &&
        record.scope.kind === "conversation" &&
        record.scope.conversationId ===
          unsupportedToolCheckpoint.rootConversationId,
    );
    if (!unsupportedToolRoot) {
      throw new Error("Real source checkpoint has no root agent");
    }
    unsupportedToolRoot.value.tools = ["unavailable_local_tool"];
    const { sha256: _oldToolCheckpointHash, ...toolCheckpointBody } =
      unsupportedToolCheckpoint;
    unsupportedToolCheckpoint.sha256 = sha256(
      Buffer.from(canonicalJson(toolCheckpointBody), "utf8"),
    );
    const unsupportedToolPrepared = await prepareManagedWorkBundleComposition({
      managedWork: unsupportedToolCheckpoint,
      compatibilityRequirements: [
        "model:uzina-test/fixed-model",
        "tool:remote_read_file:v1",
        "tool:remote_write_file:v1",
        "tool:remote_run_command:v1",
      ],
    });
    const unsupportedToolBundle = await composeManagedWorkBundleFromWorkspace({
      prepared: unsupportedToolPrepared,
      workspaceManifest: staleSourceManifest,
      workspaceManifestReference: staleSourceManifestReference,
      workspaceManifestBytes: staleSourceManifestBytes,
      transport: importTransport,
    });
    const unsupportedToolImport = await call<{ status: string }>(
      local.baseUrl,
      "/v1/managed-work-imports",
      {
        credential: local.owner,
        body: {
          ...request,
          requestId: "import:unsupported-root-tool",
          manifestSha256: unsupportedToolBundle.manifestReference,
          destinationId: "destination:tool-proof",
        },
      },
    );
    expect(unsupportedToolImport.value.status).toBe("blocked");
    await expect(
      lstat(join(local.directory, "prepared-import", "unsupported-tools")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const foreignDestination = join(
      local.directory,
      "prepared-import",
      "foreign-existing",
    );
    await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: importTransport,
      destinationPath: foreignDestination,
      supportedRuntimeRequirements: [
        "model:uzina-test/fixed-model",
        "tool:remote_read_file:v1",
        "tool:remote_write_file:v1",
        "tool:remote_run_command:v1",
      ],
      openStorage: async (path) => {
        const storage = await openBunSqliteStorage(path);
        return {
          storage,
          close: () => storage.close(BACKGROUND_CONTEXT),
        };
      },
    });
    const foreignReceiptPath = join(
      foreignDestination,
      ".uzina",
      "prepared-restore.json",
    );
    const foreignReceiptBefore = await readFile(foreignReceiptPath, "utf8");
    const foreignImport = await call<{ status: string }>(
      local.baseUrl,
      "/v1/managed-work-imports",
      {
        credential: local.owner,
        body: {
          ...request,
          requestId: "import:refuse-existing-output",
          destinationId: "destination:foreign-proof",
        },
      },
    );
    expect(foreignImport.status).toBe(202);
    expect(foreignImport.value.status).toBe("blocked");
    expect(await readFile(foreignReceiptPath, "utf8")).toBe(
      foreignReceiptBefore,
    );

    const emptyDestination = join(
      local.directory,
      "prepared-import",
      "preexisting-empty",
    );
    await mkdir(emptyDestination);
    const emptyImport = await call<{ status: string }>(
      local.baseUrl,
      "/v1/managed-work-imports",
      {
        credential: local.owner,
        body: {
          ...request,
          requestId: "import:refuse-existing-empty-root",
          destinationId: "destination:empty-proof",
        },
      },
    );
    expect(emptyImport.value.status).toBe("blocked");
    expect(await readdir(emptyDestination)).toEqual([]);

    const retry = await call<typeof first.value>(
      local.baseUrl,
      "/v1/managed-work-imports",
      { credential: local.owner, body: request },
    );
    expect(retry.status).toBe(202);
    expect(retry.value).toEqual(first.value);
    const localRuntime = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/status`,
      { credential: local.owner },
    );
    expect(localRuntime.status).toBe(200);
    expect(JSON.stringify(localRuntime.value.runtime)).toContain(
      "The managed work is ready for an offline handoff.",
    );
    expect(await stat(runtimeFilename)).toMatchObject({
      dev: runtimeBeforeImport.dev,
      ino: runtimeBeforeImport.ino,
    });

    await local.reopenFactory();
    const reopened = await call<typeof first.value>(
      local.baseUrl,
      `/v1/managed-work-imports/${request.requestId}`,
      { credential: local.owner },
    );
    expect(reopened.status).toBe(200);
    expect(reopened.value).toEqual(first.value);
    const reopenedRetry = await call<typeof first.value>(
      local.baseUrl,
      "/v1/managed-work-imports",
      { credential: local.owner, body: request },
    );
    expect(reopenedRetry.status).toBe(202);
    expect(reopenedRetry.value).toEqual(first.value);
    const isolatedRuntime = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/status`,
      { credential: local.owner },
    );
    expect(isolatedRuntime.status).toBe(200);
    expect(JSON.stringify(isolatedRuntime.value.runtime)).toContain(
      "The managed work is ready for an offline handoff.",
    );
    expect(await stat(runtimeFilename)).toMatchObject({
      dev: runtimeBeforeImport.dev,
      ino: runtimeBeforeImport.ino,
    });

    await writeFile(
      join(local.workspaceDirectory, "shutdown-large.bin"),
      Buffer.alloc(32 * 1024 * 1024, 0x5a),
    );
    await local.startExecution();
    const shutdownBundle = await local.host.captureManagedWorkCheckpoint({
      credential: local.owner,
      threadId: local.threadId,
      transport: importTransport,
    });
    const shutdownDestination = join(
      local.directory,
      "prepared-import",
      "shutdown-owned",
    );
    const shutdownRequest = {
      ...request,
      requestId: "import:shutdown-joins-real-restore",
      manifestSha256: shutdownBundle.manifestReference,
      destinationId: "destination:shutdown-proof",
    };
    await local.stopExecution();
    let responseFinished = false;
    const shutdownResponse = call<{ status: string }>(
      local.baseUrl,
      "/v1/managed-work-imports",
      { credential: local.owner, body: shutdownRequest },
    ).then((response) => {
      responseFinished = true;
      return response;
    });
    await until(async () => {
      const rows = local.host.database.all<{ status: string }>(
        "SELECT status FROM managed_work_imports WHERE request_id = ?",
        [shutdownRequest.requestId],
      );
      return rows[0]?.status === "preparing";
    });
    expect(responseFinished).toBe(false);
    await local.host.close(false);
    const shutdownResult = await shutdownResponse;
    expect(responseFinished).toBe(true);
    expect(shutdownResult.status).toBe(202);
    expect(shutdownResult.value.status).toBe("prepared-inactive");
    expect(
      JSON.parse(
        await readFile(
          join(shutdownDestination, ".uzina", "prepared-restore.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      manifestReference: shutdownBundle.manifestReference,
      status: "prepared-inactive",
    });
    const closedDatabase = new Database(
      join(local.directory, "factory.sqlite"),
      {
        readonly: true,
      },
    );
    try {
      expect(
        closedDatabase
          .query("SELECT status FROM managed_work_imports WHERE request_id = ?")
          .get(shutdownRequest.requestId),
      ).toEqual({ status: "prepared-inactive" });
    } finally {
      closedDatabase.close();
    }

    local.addWorkspaceMapping("workspace:reserved-import", destinationPath);
    importsEnabled = false;
    await local.stopExecution();
    await local.host.close();
    await expect(local.reopenFactory()).rejects.toThrow(
      "managed_work_import_destination_reserved",
    );
    local.removeWorkspaceMapping("workspace:reserved-import");
    await local.reopenFactory();
    const blockedImportStatus = await call<ManagedWorkImportStatus>(
      local.baseUrl,
      "/v1/managed-work-imports/import:stale-root-model",
      { credential: local.owner },
    );
    expect(blockedImportStatus.value.status).toBe("blocked");
    const blockedImportDestination = join(
      local.directory,
      "prepared-import",
      "model-mismatch",
    );
    await mkdir(blockedImportDestination);
    local.addWorkspaceMapping(
      "workspace:blocked-import-reservation",
      blockedImportDestination,
    );
    await expect(local.reopenFactory()).rejects.toThrow(
      "managed_work_import_destination_reserved",
    );
  });

  test("accepted input selects one bounded remote write and settles with persistent context and events", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "managed-result.txt",
        content: "Pi wrote this remotely",
      },
      answer: "The assigned workspace was updated.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-proof-",
    });
    const input = {
      requestId: "request:local-proof",
      text: "Update the result in my selected workspace.",
    };
    const accepted = await call<{
      jobId: string;
      dispatchStatus: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    expect(accepted.status).toBe(202);
    expect(accepted.value.dispatchStatus).toBe("queued");

    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });

    expect(
      await readFile(
        join(local.workspaceDirectory, "managed-result.txt"),
        "utf8",
      ),
    ).toBe("Pi wrote this remotely");
    expect(provider.requests()).toBeGreaterThanOrEqual(2);

    const retry = await call<{ jobId: string; dispatchStatus: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    expect(retry.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "completed",
    });
    expect(provider.requests()).toBeGreaterThanOrEqual(2);

    const context = await call<{ runtime: { messages: readonly unknown[] } }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "The assigned workspace was updated.",
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "Pi wrote this remotely",
    );
    const status = await call<{
      runtime: {
        context: { messages: readonly unknown[] };
        inspection: unknown;
      };
    }>(local.baseUrl, `/v1/threads/${local.threadId}/status`, {
      credential: local.owner,
    });
    expect(JSON.stringify(status.value.runtime.context)).toContain(
      "The assigned workspace was updated.",
    );
    const unauthorizedContext = await fetch(
      new URL(`/v1/threads/${local.threadId}/context`, local.baseUrl),
    );
    expect(unauthorizedContext.status).toBe(401);

    const events = await call<{
      events: Array<{
        type: string;
        requestId: string | null;
        payload: Record<string, unknown>;
      }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const proofEvents = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "command.accepted",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "execution.accepted",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "execution.completed",
    );
    expect(proofEvents.map((event) => event.type)).toContain(
      "dispatch.completed",
    );
    expect(
      proofEvents.find((event) => event.type === "execution.completed")
        ?.payload,
    ).toMatchObject({
      target: accepted.value.target,
      ownershipGeneration: accepted.value.ownershipGeneration,
      piCallId: "call:remote-effect-1",
    });
    expect(
      proofEvents.filter((event) => event.type === "execution.accepted"),
    ).toHaveLength(1);
    expect(
      proofEvents.filter((event) => event.type === "execution.completed"),
    ).toHaveLength(1);
  });

  test("captures quiescent local managed work and restores one validated inactive bundle", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "managed-result.txt",
        content: "Pi wrote this before capture",
      },
      answer: "The managed work is settled and ready to checkpoint.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-coherent-checkpoint-",
    });
    const workspace = local.workspaceDirectory;
    git(workspace, "init", "--initial-branch=main", "--quiet");
    git(workspace, "config", "user.name", "Checkpoint test");
    git(workspace, "config", "user.email", "checkpoint@example.invalid");
    await writeFile(join(workspace, "notes.txt"), "initial note\n");
    await writeFile(join(workspace, "image.bin"), Buffer.from([0, 255, 1, 0]));
    await writeFile(join(workspace, "run.sh"), "#!/bin/sh\necho ready\n");
    await chmod(join(workspace, "run.sh"), 0o644);
    git(workspace, "add", "--all");
    git(workspace, "commit", "-m", "checkpoint base");
    await writeFile(join(workspace, "notes.txt"), "staged note\n");
    git(workspace, "add", "notes.txt");
    await writeFile(join(workspace, "notes.txt"), "staged then unstaged\n");
    await writeFile(
      join(workspace, "image.bin"),
      Buffer.from([0, 255, 2, 0, 128]),
    );
    git(workspace, "add", "image.bin");
    await writeFile(
      join(workspace, "image.bin"),
      Buffer.from([0, 255, 3, 0, 129, 0]),
    );
    await chmod(join(workspace, "run.sh"), 0o755);
    git(workspace, "add", "run.sh");
    await writeFile(
      join(workspace, "untracked.bin"),
      Buffer.from([255, 0, 254, 128]),
    );

    const input = {
      requestId: "request:coherent-capture",
      text: "Write the result and finish this managed task before capture.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    const sourceContext = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );

    const blobs = new FileBlobTransport(
      join(local.directory, "checkpoint-blobs"),
    );
    let signalFirstPut!: () => void;
    let releasePut!: () => void;
    const firstPut = new Promise<void>((resolve) => {
      signalFirstPut = resolve;
    });
    const putBlocked = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let firstWrite = true;
    let sourceWorkspaceManifest: WorkspaceCheckpointManifest | undefined;
    let sourceManifestPutIndex = -1;
    const sourceManifestReferences: string[] = [];
    const putReferences: string[] = [];
    const blockingTransport: BlobTransport = {
      async putBlob(bytes) {
        if (firstWrite) {
          firstWrite = false;
          signalFirstPut();
          await putBlocked;
        }
        const reference = await blobs.putBlob(bytes);
        putReferences.push(reference);
        try {
          const value = JSON.parse(new TextDecoder().decode(bytes)) as {
            format?: unknown;
            runtimeArtifact?: unknown;
            attachments?: unknown;
          };
          if (
            value.format === "uzina-workspace-checkpoint" &&
            value.runtimeArtifact === null &&
            Array.isArray(value.attachments) &&
            value.attachments.length === 0
          ) {
            sourceWorkspaceManifest = value as WorkspaceCheckpointManifest;
            sourceManifestReferences.push(reference);
            sourceManifestPutIndex = putReferences.length - 1;
          }
        } catch {
          // Workspace objects are binary or non-manifest payloads.
        }
        return reference;
      },
      async getBlob() {
        throw new Error("managed-work composition must not read source blobs");
      },
    };
    const pendingCapture = local.host.captureManagedWorkCheckpoint({
      credential: local.owner,
      threadId: local.threadId,
      transport: blockingTransport,
    });
    void pendingCapture.catch(() => {});
    await firstPut;
    let session: Awaited<ReturnType<typeof local.host.factory.authenticate>>;
    try {
      const blockedInput = await call<{ error: string }>(
        local.baseUrl,
        `/v1/threads/${local.threadId}/inputs`,
        {
          credential: local.owner,
          body: {
            requestId: "request:blocked-during-capture",
            text: "This must not enter managed work during capture.",
          },
        },
      );
      expect(blockedInput.status).toBe(409);
      expect(blockedInput.value.error).toBe("managed_work_capture_active");

      session = await local.host.factory.authenticate(local.owner);
      const thread = local.host.factory.getAuthorizedThread(
        session,
        local.threadId,
      );
      await expect(
        local.host.factory.enqueueRemoteExecution({
          contractVersion: 1,
          jobId: "job:blocked-during-capture",
          nodeId: thread.target.nodeId,
          target: thread.target,
          ownershipGeneration: thread.ownershipGeneration,
          operation: "write-file",
          path: "blocked.txt",
          contentBase64: Buffer.from("no write").toString("base64"),
        }),
      ).rejects.toThrow("Input or execution admission is blocked");
      await expect(
        local.executionDaemon().executeJob({
          contractVersion: 1,
          jobId: "job:direct-daemon-write-during-capture",
          nodeId: thread.target.nodeId,
          target: thread.target,
          ownershipGeneration: thread.ownershipGeneration,
          operation: "write-file",
          path: "blocked-local-writer.txt",
          contentBase64: Buffer.from("no local write").toString("base64"),
        }),
      ).rejects.toThrow("workspace_capture_active");
      expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(
        1,
      );
    } finally {
      releasePut();
    }
    const captured = await pendingCapture;
    session = await local.host.factory.authenticate(local.owner);
    expect(captured.manifest.format).toBe(
      "uzina-coherent-managed-work-checkpoint",
    );
    expect(captured.manifest.profile).toBe(
      "quiescent-current-documents-no-forks-v1",
    );
    expect(sourceWorkspaceManifest).toBeDefined();
    expect(sourceManifestReferences).toHaveLength(1);
    expect(sourceManifestPutIndex).toBeGreaterThanOrEqual(0);
    const capturedSource = sourceWorkspaceManifest!;
    const {
      runtimeArtifact: _sourceRuntime,
      attachments: _sourceAttachments,
      ...capturedWorkspaceCore
    } = captured.manifest.workspace;
    const {
      runtimeArtifact: _sourceRuntimeOriginal,
      attachments: _sourceAttachmentsOriginal,
      ...sourceWorkspaceCore
    } = capturedSource;
    expect(capturedWorkspaceCore).toEqual(sourceWorkspaceCore);
    expect(capturedSource.runtimeArtifact).toBeNull();
    expect(capturedSource.attachments).toEqual([]);
    const sourceObjectReferences = new Set([
      capturedSource.git.bundle.reference,
      capturedSource.git.stagedPatch.reference,
      ...capturedSource.workspace.entries.map((entry) => entry.sha256),
    ]);
    expect(
      [...sourceObjectReferences].every((reference) =>
        putReferences.slice(0, sourceManifestPutIndex).includes(reference),
      ),
    ).toBe(true);
    expect(
      putReferences
        .slice(sourceManifestPutIndex + 1)
        .some((reference) => sourceObjectReferences.has(reference)),
    ).toBe(false);
    expect(putReferences.slice(sourceManifestPutIndex + 1)).toHaveLength(4);
    expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(0);

    const capturedRecord = captured.manifest as unknown as Record<
      string,
      unknown
    >;
    const oversizedOuter = resignedBundle({
      ...capturedRecord,
      padding: "x".repeat(WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES + 128),
    });
    expect(oversizedOuter.bytes.byteLength).toBeGreaterThan(
      WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
    );
    const oversizedTransport = overlayTransport(
      blobs,
      new Map([[oversizedOuter.reference, oversizedOuter.bytes]]),
    );
    await expect(
      validateManagedWorkBundle(oversizedOuter.reference, oversizedTransport),
    ).rejects.toThrow("Managed-work bundle manifest exceeds its size limit");
    const untouchedOversizedDestination = join(
      local.directory,
      "untouched-oversized-destination",
    );
    await mkdir(untouchedOversizedDestination);
    await writeFile(join(untouchedOversizedDestination, "keep.txt"), "keep me");
    await expect(
      restoreManagedWorkBundle({
        manifestReference: oversizedOuter.reference,
        transport: oversizedTransport,
        destinationPath: untouchedOversizedDestination,
        supportedRuntimeRequirements: [
          "model:uzina-test/fixed-model",
          "tool:remote_read_file:v1",
          "tool:remote_write_file:v1",
          "tool:remote_run_command:v1",
        ],
        async openStorage() {
          throw new Error("oversized manifest must fail before storage open");
        },
      }),
    ).rejects.toThrow("Managed-work bundle manifest exceeds its size limit");
    expect(
      await readFile(join(untouchedOversizedDestination, "keep.txt"), "utf8"),
    ).toBe("keep me");

    const unknownOuter = resignedBundle({
      ...capturedRecord,
      futureField: true,
    });
    expect(unknownOuter.bytes.byteLength).toBeLessThan(
      WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
    );
    const unknownOuterTransport = overlayTransport(
      blobs,
      new Map([[unknownOuter.reference, unknownOuter.bytes]]),
    );
    await expect(
      validateManagedWorkBundle(unknownOuter.reference, unknownOuterTransport),
    ).rejects.toThrow("Unsupported or malformed coherent managed-work bundle");

    const unknownRuntime = resignedBundle({
      ...capturedRecord,
      runtime: {
        ...(capturedRecord.runtime as Record<string, unknown>),
        futureField: true,
      },
    });
    await expect(
      validateManagedWorkBundle(
        unknownRuntime.reference,
        overlayTransport(
          blobs,
          new Map([[unknownRuntime.reference, unknownRuntime.bytes]]),
        ),
      ),
    ).rejects.toThrow("Unsupported or malformed coherent managed-work bundle");

    const oversizedWorkspaceValue = {
      ...captured.manifest.workspace,
      padding: "w".repeat(WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES + 128),
    } as unknown as Record<string, unknown>;
    const oversizedWorkspaceBytes = Buffer.from(
      canonicalJson(oversizedWorkspaceValue),
      "utf8",
    );
    const oversizedWorkspaceReference = sha256(oversizedWorkspaceBytes);
    const oversizedWorkspaceOuter = resignedBundle({
      ...capturedRecord,
      workspaceManifestReference: oversizedWorkspaceReference,
    });
    await expect(
      validateManagedWorkBundle(
        oversizedWorkspaceOuter.reference,
        overlayTransport(
          blobs,
          new Map([
            [oversizedWorkspaceOuter.reference, oversizedWorkspaceOuter.bytes],
            [oversizedWorkspaceReference, oversizedWorkspaceBytes],
          ]),
        ),
      ),
    ).rejects.toThrow("Workspace manifest exceeds its size limit");

    const destinationRequirements = [
      "model:uzina-test/fixed-model",
      "tool:remote_read_file:v1",
      "tool:remote_write_file:v1",
      "tool:remote_run_command:v1",
    ];
    const validatedSource = await validateManagedWorkBundle(
      captured.manifestReference,
      blobs,
      { supportedRuntimeRequirements: destinationRequirements },
    );
    const outerCaptureRequirements = Array.from(
      { length: 36_000 },
      (_, index) =>
        `capture-${String(index).padStart(5, "0")}-${"r".repeat(235)}`,
    );
    await expect(
      captureManagedWorkBundle({
        managedWork: validatedSource.managedWork,
        compatibilityRequirements: outerCaptureRequirements,
        workspacePath: workspace,
        transport: blobs,
      }),
    ).rejects.toThrow("Managed-work bundle manifest exceeds its size limit");
    const oversizedWorkspaceRequirements = Array.from(
      { length: 75_000 },
      (_, index) =>
        `workspace-${String(index).padStart(5, "0")}-${"r".repeat(235)}`,
    );
    await expect(
      captureManagedWorkBundle({
        managedWork: validatedSource.managedWork,
        compatibilityRequirements: oversizedWorkspaceRequirements,
        workspacePath: workspace,
        transport: blobs,
      }),
    ).rejects.toThrow("Checkpoint manifest exceeds its size limit");
    await expect(
      validateManagedWorkBundle(captured.manifestReference, blobs),
    ).rejects.toThrow("Unsupported runtime requirements");
    const failedDestination = join(local.directory, "failed-destination");
    await mkdir(failedDestination);
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: failedDestination,
        supportedRuntimeRequirements: destinationRequirements,
        async openStorage() {
          throw new Error("staged runtime storage allocation failed");
        },
      }),
    ).rejects.toThrow("staged runtime storage allocation failed");
    expect(await readdir(failedDestination)).toEqual([]);
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: failedDestination,
        allowFreshRestore: false,
        supportedRuntimeRequirements: destinationRequirements,
        async openStorage(path) {
          const storage = await openBunSqliteStorage(path);
          return {
            storage,
            close: () => storage.close(BACKGROUND_CONTEXT),
          };
        },
      }),
    ).rejects.toThrow("A prior restore was recorded");
    expect(await readdir(failedDestination)).toEqual([]);

    const destination = join(local.directory, "restored-inactive");
    await mkdir(destination);
    const providerCallsBeforeRestore = provider.requests();
    let toolCalls = 0;
    const restored = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: destination,
      supportedRuntimeRequirements: destinationRequirements,
      async openStorage(path) {
        const storage = await openBunSqliteStorage(path);
        return {
          storage,
          close: () => storage.close(BACKGROUND_CONTEXT),
        };
      },
    });
    expect(restored.receipt.status).toBe("prepared-inactive");
    expect(provider.requests()).toBe(providerCallsBeforeRestore);
    expect(toolCalls).toBe(0);

    const restoredWorkspace = restored.workspacePath;
    expect(
      git(
        restoredWorkspace,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    ).toBe(git(workspace, "status", "--porcelain=v1", "--untracked-files=all"));
    expect(git(restoredWorkspace, "diff", "--cached", "--binary", "HEAD")).toBe(
      git(workspace, "diff", "--cached", "--binary", "HEAD"),
    );
    expect(git(restoredWorkspace, "diff", "--binary")).toBe(
      git(workspace, "diff", "--binary"),
    );
    expect(
      git(
        restoredWorkspace,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ),
    ).toBe(git(workspace, "for-each-ref", "--format=%(refname) %(objectname)"));
    for (const filename of [
      "notes.txt",
      "image.bin",
      "run.sh",
      "untracked.bin",
      "managed-result.txt",
    ]) {
      expect(await readFile(join(restoredWorkspace, filename))).toEqual(
        await readFile(join(workspace, filename)),
      );
    }
    expect((await stat(join(restoredWorkspace, "run.sh"))).mode & 0o111).toBe(
      (await stat(join(workspace, "run.sh"))).mode & 0o111,
    );
    const provenanceText = await readFile(
      join(destination, ".uzina", "attachments", "factory-provenance.json"),
      "utf8",
    );
    expect(provenanceText).not.toContain(local.owner);
    expect(provenanceText).not.toContain(local.nodeCredential);
    const provenance = JSON.parse(provenanceText) as {
      commands: Array<{ requestId: string; executionEffects?: unknown[] }>;
    };
    expect(provenance.commands.map((command) => command.requestId)).toContain(
      input.requestId,
    );
    expect(
      provenance.commands.find(
        (command) => command.requestId === input.requestId,
      )?.executionEffects,
    ).toHaveLength(1);

    const restoredStorage = await openBunSqliteStorage(restored.runtimePath);
    const restoredWork = await ManagedPiWork.open({
      storage: restoredStorage,
      models: provider.models,
      agent: { model: { provider: "uzina-test", modelId: "fixed-model" } },
      toolExecutor: {
        async readFile() {
          toolCalls += 1;
          return { content: "", truncated: false };
        },
        async writeFile() {
          toolCalls += 1;
        },
        async runCommand() {
          toolCalls += 1;
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            outputTruncated: false,
          };
        },
      },
    });
    try {
      expect(await restoredWork.context()).toEqual(
        sourceContext.value.runtime as never,
      );
      const importedReceipt = await restoredWork.submission(input.requestId);
      expect(importedReceipt).toBeDefined();
      const duplicate = await restoredWork.submit(input.requestId, input.text);
      expect(duplicate.submissionId).toBe(importedReceipt!.id);
      expect(provider.requests()).toBe(providerCallsBeforeRestore);
      expect(toolCalls).toBe(0);
    } finally {
      await restoredWork.close();
    }

    let retryStorageOpens = 0;
    const openPreparedStorage = async (path: string) => {
      retryStorageOpens += 1;
      const storage = await openBunSqliteStorage(path);
      return {
        storage,
        close: () => storage.close(BACKGROUND_CONTEXT),
      };
    };
    const providerCallsAfterRestore = provider.requests();
    const retried = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: destination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    expect(retried.receipt).toEqual(restored.receipt);
    expect(retryStorageOpens).toBe(1);
    expect(provider.requests()).toBe(providerCallsAfterRestore);
    expect(toolCalls).toBe(0);

    const unexpectedLargePath = join(
      restoredWorkspace,
      "unexpected-oversized.bin",
    );
    const originalNotesBytes = await readFile(
      join(restoredWorkspace, "notes.txt"),
    );
    const receiptPath = join(destination, ".uzina", "prepared-restore.json");
    const originalReceiptBytes = await readFile(receiptPath);
    const unexpectedLargeFile = await open(unexpectedLargePath, "w");
    try {
      await unexpectedLargeFile.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await unexpectedLargeFile.close();
    }
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: destination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow("Prepared workspace contains omitted entries");
    expect((await stat(unexpectedLargePath)).size).toBe(64 * 1024 * 1024 + 1);
    expect(await readFile(join(restoredWorkspace, "notes.txt"))).toEqual(
      originalNotesBytes,
    );
    expect(await readFile(receiptPath)).toEqual(originalReceiptBytes);
    expect(provider.requests()).toBe(providerCallsAfterRestore);
    expect(toolCalls).toBe(0);
    await rm(unexpectedLargePath, { force: true });

    const originalWorkspaceBytes = await readFile(
      join(destination, "workspace", "notes.txt"),
    );
    const changedWorkspaceBytes = "x".repeat(originalWorkspaceBytes.byteLength);
    await writeFile(
      join(destination, "workspace", "notes.txt"),
      changedWorkspaceBytes,
    );
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: destination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow("Prepared workspace entry integrity mismatch: notes.txt");
    expect(
      await readFile(join(destination, "workspace", "notes.txt"), "utf8"),
    ).toBe(changedWorkspaceBytes);

    const modeDestination = join(local.directory, "tampered-mode-restore");
    const modeRestore = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: modeDestination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    await chmod(join(modeRestore.workspacePath, "run.sh"), 0o644);
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: modeDestination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow("Prepared workspace entry changed: run.sh");
    expect(
      (await stat(join(modeRestore.workspacePath, "run.sh"))).mode & 0o111,
    ).toBe(0);

    const indexDestination = join(local.directory, "tampered-index-restore");
    const indexRestore = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: indexDestination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    git(
      indexRestore.workspacePath,
      "update-index",
      "--assume-unchanged",
      "notes.txt",
    );
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: indexDestination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow(
      "Assume-unchanged and skip-worktree index entries are not supported",
    );
    expect(
      git(indexRestore.workspacePath, "ls-files", "-v", "notes.txt"),
    ).toMatch(/^h /);

    const runtimeDestination = join(
      local.directory,
      "tampered-runtime-restore",
    );
    const runtimeRestore = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: runtimeDestination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    const runtimeDatabase = new Database(runtimeRestore.runtimePath);
    const entryRow = runtimeDatabase
      .query<{ id: number; record: string }, []>(
        "SELECT id, record FROM entries ORDER BY id LIMIT 1",
      )
      .get();
    expect(entryRow).toBeDefined();
    const changedEntry = JSON.parse(entryRow!.record) as Record<
      string,
      unknown
    >;
    changedEntry.kind = `${String(changedEntry.kind)}-tampered`;
    runtimeDatabase
      .query("UPDATE entries SET record = ? WHERE id = ?")
      .run(JSON.stringify(changedEntry), entryRow!.id);
    runtimeDatabase.close();
    await expect(
      restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport: blobs,
        destinationPath: runtimeDestination,
        supportedRuntimeRequirements: destinationRequirements,
        openStorage: openPreparedStorage,
      }),
    ).rejects.toThrow("Prepared managed-work runtime does not match bundle");
    const preservedRuntimeDatabase = new Database(runtimeRestore.runtimePath);
    expect(
      JSON.parse(
        preservedRuntimeDatabase
          .query<{ record: string }, [number]>(
            "SELECT record FROM entries WHERE id = ?",
          )
          .get(entryRow!.id)!.record,
      ).kind,
    ).toBe(changedEntry.kind);
    preservedRuntimeDatabase.close();

    const attachmentDestination = join(
      local.directory,
      "tampered-attachment-restore",
    );
    await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport: blobs,
      destinationPath: attachmentDestination,
      supportedRuntimeRequirements: destinationRequirements,
      openStorage: openPreparedStorage,
    });
    const attachmentPath = join(
      attachmentDestination,
      ".uzina",
      "attachments",
      "factory-provenance.json",
    );
    const preparedReceiptPath = join(
      attachmentDestination,
      ".uzina",
      "prepared-restore.json",
    );
    const preparedReceiptBytes = await readFile(preparedReceiptPath);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const oversizedAttachmentBytes = 32 * 1024 * 1024 + 1;
      const attachmentHandle = await open(attachmentPath, "w");
      try {
        await attachmentHandle.truncate(oversizedAttachmentBytes);
      } finally {
        await attachmentHandle.close();
      }
      await chmod(attachmentPath, 0);
      try {
        await expect(
          restoreManagedWorkBundle({
            manifestReference: captured.manifestReference,
            transport: blobs,
            destinationPath: attachmentDestination,
            supportedRuntimeRequirements: destinationRequirements,
            openStorage: openPreparedStorage,
          }),
        ).rejects.toThrow(
          "Prepared attachment size mismatch: factory-provenance.json",
        );
        expect((await stat(attachmentPath)).size).toBe(
          oversizedAttachmentBytes,
        );
      } finally {
        await chmod(attachmentPath, 0o600);
      }
    } else {
      // Root bypasses POSIX mode bits; keep only the ordinary content-corruption control here.
      const changedAttachmentBytes = "tampered provenance\n";
      await writeFile(attachmentPath, changedAttachmentBytes);
      await expect(
        restoreManagedWorkBundle({
          manifestReference: captured.manifestReference,
          transport: blobs,
          destinationPath: attachmentDestination,
          supportedRuntimeRequirements: destinationRequirements,
          openStorage: openPreparedStorage,
        }),
      ).rejects.toThrow(
        "Prepared attachment integrity mismatch: factory-provenance.json",
      );
      expect(await readFile(attachmentPath, "utf8")).toBe(
        changedAttachmentBytes,
      );
    }
    expect(await readFile(preparedReceiptPath)).toEqual(preparedReceiptBytes);
    expect(provider.requests()).toBe(providerCallsAfterRestore);
    expect(toolCalls).toBe(0);
  });

  test("capture preflight rejects symlink aliases before invoking the writer quiescence adapter", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-alias-",
      deferExecutor: true,
      extraWorkspaceAliases: ["workspace:alias"],
    });
    await expect(
      local.host.captureManagedWorkCheckpoint({
        credential: local.owner,
        threadId: local.threadId,
        transport: new FileBlobTransport(join(local.directory, "unused-blobs")),
      }),
    ).rejects.toThrow("overlaps a local directory with workspace:alias");
    const session = await local.host.factory.authenticate(local.owner);
    expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(0);
  });

  test("capture preflight rejects canonical ancestor and descendant workspaces", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-nested-roots-",
      deferExecutor: true,
      extraWorkspaceSubdirectories: {
        "workspace:nested": "nested-workspace",
      },
    });
    await expect(
      local.host.captureManagedWorkCheckpoint({
        credential: local.owner,
        threadId: local.threadId,
        transport: new FileBlobTransport(join(local.directory, "unused-blobs")),
      }),
    ).rejects.toThrow("overlaps a local directory with workspace:nested");
    const session = await local.host.factory.authenticate(local.owner);
    expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(0);
  });

  test("refuses unavailable and uncertain work instead of pausing it", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-uncertain-",
      deferExecutor: true,
    });
    const session = await local.host.factory.authenticate(local.owner);
    await local.host.factory.submitInput(
      session,
      local.threadId,
      "request:queued-for-capture",
      "This remains unavailable and must block capture.",
    );
    expect(() =>
      local.host.factory.beginManagedWorkCapture(session, local.threadId),
    ).toThrow("unsettled unavailable input receipt");
    expect(local.host.factory.listManagedWorkCaptures(session)).toHaveLength(0);

    const uncertain = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-uncertain-dispatch-",
    });
    const uncertainSession = await uncertain.host.factory.authenticate(
      uncertain.owner,
    );
    const accepted = await uncertain.host.factory.submitInput(
      uncertainSession,
      uncertain.threadId,
      "request:uncertain-capture",
      "An interrupted adapter outcome must block capture.",
    );
    expect(accepted.dispatchStatus).toBe("queued");
    let signalDispatch!: () => void;
    let releaseDispatch!: () => void;
    const enteredDispatch = new Promise<void>((resolve) => {
      signalDispatch = resolve;
    });
    const holdDispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const runningDispatch = uncertain.host.factory.dispatchNext({
      async dispatch() {
        signalDispatch();
        await holdDispatch;
        return { status: "uncertain", detail: "adapter outcome is uncertain" };
      },
    });
    await enteredDispatch;
    try {
      expect(() =>
        uncertain.host.factory.beginManagedWorkCapture(
          uncertainSession,
          uncertain.threadId,
        ),
      ).toThrow("unsettled running input receipt");
    } finally {
      releaseDispatch();
    }
    const receipt = await runningDispatch;
    expect(receipt?.dispatchStatus).toBe("uncertain");
    expect(() =>
      uncertain.host.factory.beginManagedWorkCapture(
        uncertainSession,
        uncertain.threadId,
      ),
    ).toThrow("unsettled uncertain input receipt");
    expect(
      uncertain.host.factory.listManagedWorkCaptures(uncertainSession),
    ).toHaveLength(0);
  });

  test("refuses shared workspaces and keeps a capture fence durable across restart", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-restart-",
      deferExecutor: true,
    });
    const session = await local.host.factory.authenticate(local.owner);
    local.host.factory.createThread(session, {
      projectId: "project:local-proof",
      title: "Second thread sharing workspace",
      target: { nodeId: local.nodeId, workspaceId: local.workspaceId },
    });
    expect(() =>
      local.host.factory.beginManagedWorkCapture(session, local.threadId),
    ).toThrow("requires an exclusive workspace");

    const exclusive = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-capture-durable-lock-",
      deferExecutor: true,
    });
    const ownerSession = await exclusive.host.factory.authenticate(
      exclusive.owner,
    );
    expect(
      await exclusive.host.factory.getManagedWorkCaptureState(
        exclusive.threadId,
      ),
    ).toEqual({ state: "unlocked" });
    const capture = exclusive.host.factory.beginManagedWorkCapture(
      ownerSession,
      exclusive.threadId,
    );
    expect(
      await exclusive.host.factory.getManagedWorkCaptureState(
        exclusive.threadId,
      ),
    ).toEqual({ state: "held", captureId: capture.captureId });
    await exclusive.reopenFactory();
    const reopenedSession = await exclusive.host.factory.authenticate(
      exclusive.owner,
    );
    expect(
      exclusive.host.factory.listManagedWorkCaptures(reopenedSession),
    ).toEqual([
      expect.objectContaining({
        capture_id: capture.captureId,
        thread_id: exclusive.threadId,
        workspace_id: exclusive.workspaceId,
      }),
    ]);
    expect(
      await exclusive.host.factory.getManagedWorkCaptureState(
        exclusive.threadId,
      ),
    ).toEqual({ state: "held", captureId: capture.captureId });
    await expect(
      exclusive.host.factory.submitInput(
        reopenedSession,
        exclusive.threadId,
        "request:blocked-after-restart",
        "The durable capture lock remains active.",
      ),
    ).rejects.toThrow("Input or execution admission is blocked");
    exclusive.host.factory.endManagedWorkCapture(
      reopenedSession,
      capture.captureId,
    );
    expect(
      exclusive.host.factory.listManagedWorkCaptures(reopenedSession),
    ).toHaveLength(0);
    expect(
      await exclusive.host.factory.getManagedWorkCaptureState(
        exclusive.threadId,
      ),
    ).toEqual({ state: "unlocked" });
  });

  test("runtime permits survive lost acknowledgements and cannot release capture fences", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-runtime-permit-restart-",
      deferExecutor: true,
    });
    await expect(
      (async () => {
        await local.host.factory.acquireManagedWorkRuntimePermit(
          local.threadId,
        );
        throw new Error("simulated lost acquisition acknowledgement");
      })(),
    ).rejects.toThrow("simulated lost acquisition acknowledgement");
    const persistedPermit = local.host.database.all<{
      permit_id: string;
      ownership_generation: number;
      released_at: string | null;
    }>(
      "SELECT permit_id, ownership_generation, released_at FROM managed_work_runtime_permits WHERE thread_id = ?",
      [local.threadId],
    );
    expect(persistedPermit).toHaveLength(1);
    expect(persistedPermit[0]).toMatchObject({ released_at: null });
    const lostAcquirePermitId = persistedPermit[0]!.permit_id;

    await local.reopenFactory();
    const ownerSession = await local.host.factory.authenticate(local.owner);
    const recoveredAcquireReply =
      await local.host.factory.acquireManagedWorkRuntimePermit(local.threadId);
    expect(recoveredAcquireReply).toEqual({
      state: "permitted",
      permitId: lostAcquirePermitId,
      ownershipGeneration: local.host.factory.getAuthorizedThread(
        ownerSession,
        local.threadId,
      ).ownershipGeneration,
    });
    expect(() =>
      local.host.factory.beginManagedWorkCapture(ownerSession, local.threadId),
    ).toThrow("runtime lifecycle permission is active");

    await expect(
      (async () => {
        await local.host.factory.releaseManagedWorkRuntimePermit(
          local.threadId,
          lostAcquirePermitId,
        );
        throw new Error("simulated lost release acknowledgement");
      })(),
    ).rejects.toThrow("simulated lost release acknowledgement");
    await local.reopenFactory();
    const reopenedSession = await local.host.factory.authenticate(local.owner);
    await local.host.factory.releaseManagedWorkRuntimePermit(
      local.threadId,
      lostAcquirePermitId,
    );
    const nextPermit = await local.host.factory.acquireManagedWorkRuntimePermit(
      local.threadId,
    );
    expect(nextPermit.state).toBe("permitted");
    if (nextPermit.state !== "permitted") {
      throw new Error("Expected the next runtime permit to be admitted");
    }
    expect(nextPermit.permitId).not.toBe(lostAcquirePermitId);
    await local.host.factory.releaseManagedWorkRuntimePermit(
      local.threadId,
      lostAcquirePermitId,
    );
    expect(() =>
      local.host.factory.beginManagedWorkCapture(
        reopenedSession,
        local.threadId,
      ),
    ).toThrow("runtime lifecycle permission is active");

    await local.host.factory.releaseManagedWorkRuntimePermit(
      local.threadId,
      nextPermit.permitId,
    );
    await local.reopenFactory();
    const captureSession = await local.host.factory.authenticate(local.owner);
    await local.host.factory.releaseManagedWorkRuntimePermit(
      local.threadId,
      nextPermit.permitId,
    );
    const capture = local.host.factory.beginManagedWorkCapture(
      captureSession,
      local.threadId,
    );
    await local.host.factory.releaseManagedWorkRuntimePermit(
      local.threadId,
      nextPermit.permitId,
    );
    expect(
      await local.host.factory.getManagedWorkCaptureState(local.threadId),
    ).toEqual({ state: "held", captureId: capture.captureId });
    local.host.factory.endManagedWorkCapture(captureSession, capture.captureId);
  });

  test("rejects model-selected node, workspace and generation instead of changing accepted placement", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "forged-placement.txt",
        content: "must not execute",
        nodeId: "node:other",
        workspaceId: "workspace:other",
        ownershipGeneration: 99,
      },
      answer: "The model-selected destination was rejected.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-placement-reject-",
    });
    const input = {
      requestId: "request:placement-rejected",
      text: "Write a file but do not change the selected destination.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "forged-placement.txt"),
        "utf8",
      ).catch(() => null),
    ).toBeNull();
    const events = await call<{
      events: Array<{ type: string; requestId: string | null }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const related = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(related.map((event) => event.type)).not.toContain(
      "execution.accepted",
    );
  });

  test("a real provider failure settles a persistent command as failed without inventing an executor effect", async () => {
    const local = await scenario({
      models: deterministicFailingModels(),
      modelProvider: "uzina-test-failure",
      modelId: "fixed-model",
      directoryPrefix: "uzina-model-failure-",
    });
    const input = {
      requestId: "request:model-failure",
      text: "The selected provider will fail before choosing a tool.",
    };
    const accepted = await call<{ jobId: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "failed";
    });
    const receipt = await call<{
      jobId: string;
      dispatchStatus: string;
      outcome?: string;
    }>(local.baseUrl, `/v1/commands/${input.requestId}`, {
      credential: local.owner,
    });
    expect(receipt.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "failed",
    });
    const events = await call<{
      events: Array<{ type: string; requestId: string | null }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    const modelEvents = events.value.events.filter(
      (event) => event.requestId === input.requestId,
    );
    expect(modelEvents.map((event) => event.type)).toContain("dispatch.failed");
    expect(modelEvents.map((event) => event.type)).not.toContain(
      "execution.accepted",
    );
    const context = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "deterministic provider failure",
    );
  });

  test("reports node-side argv truncation when returned stdout exactly meets the limit", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: [process.execPath, "-e", 'process.stdout.write("ABCDEFGHIJK")'],
        timeoutMs: 5_000,
        maxOutputBytes: 8,
      },
      answer: "The bounded command completed.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-truncated-output-",
    });
    const input = {
      requestId: "request:truncated-output",
      text: "Run the bounded command and report its output.",
    };
    const accepted = await call<{ dispatchStatus: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    expect(accepted.value.dispatchStatus).toBe("queued");

    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    const receipt = await call<{
      executionEffects: Array<{
        result?: {
          operation?: string;
          stdout?: string;
          outputTruncated?: boolean;
        };
      }>;
    }>(local.baseUrl, `/v1/commands/${input.requestId}`, {
      credential: local.owner,
    });
    expect(
      receipt.value.executionEffects.find(
        (effect) => effect.result?.operation === "argv-command",
      )?.result,
    ).toMatchObject({ stdout: "ABCDEFGH", outputTruncated: true });

    const context = await call<{
      runtime: {
        entries: Array<{
          model?: Array<{
            content?: Array<{ type: string; text?: string }>;
          }>;
        }>;
      };
    }>(local.baseUrl, `/v1/threads/${local.threadId}/context`, {
      credential: local.owner,
    });
    const toolText = context.value.runtime.entries
      .flatMap((entry) => entry.model ?? [])
      .flatMap((message) => message.content ?? [])
      .find(
        (part) => part.type === "text" && part.text?.includes("truncated"),
      )?.text;
    expect(JSON.parse(toolText ?? "null")).toMatchObject({
      stdout: "ABCDEFGH",
      truncated: true,
    });
  });

  test("reopens and drains a persisted accepted input without another input request", async () => {
    const outputPath = "startup-recovered.txt";
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(outputPath)}, "startup recovered")`,
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 64,
      },
      answer: "The startup command completed.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-startup-drain-",
    });
    const input = {
      requestId: "request:startup-drain",
      text: "Run the startup recovery command.",
    };
    const session = await local.host.factory.authenticate(local.owner);
    const accepted = await local.host.factory.submitInput(
      session,
      local.threadId,
      input.requestId,
      input.text,
    );
    expect(accepted.dispatchStatus).toBe("queued");

    await local.reopenFactory();
    let startupReceipt: { dispatchStatus: string } | undefined;
    const startupDeadline = Date.now() + 1_000;
    while (Date.now() < startupDeadline) {
      startupReceipt = (
        await call<{ dispatchStatus: string }>(
          local.baseUrl,
          `/v1/commands/${input.requestId}`,
          { credential: local.owner },
        )
      ).value;
      if (startupReceipt.dispatchStatus !== "queued") break;
      await Bun.sleep(10);
    }
    expect(startupReceipt?.dispatchStatus).toBe("running");
    await local.startExecution();
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(join(local.workspaceDirectory, outputPath), "utf8"),
    ).toBe("startup recovered");

    await local.reopenFactory();
    const context = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "The startup command completed.",
    );
  });

  test("wakes unavailable accepted work when its node registers after host startup", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "node-recovered.txt",
        content: "node came online",
      },
      answer: "The node recovered the accepted input.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-standalone-node-wake-",
      deferExecutor: true,
    });
    const input = {
      requestId: "request:node-wake",
      text: "Write the result after the executor comes online.",
    };
    const session = await local.host.factory.authenticate(local.owner);
    const accepted = await local.host.factory.submitInput(
      session,
      local.threadId,
      input.requestId,
      input.text,
    );
    expect(accepted.dispatchStatus).toBe("unavailable");

    await local.startExecution();
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "node-recovered.txt"),
        "utf8",
      ),
    ).toBe("node came online");
  });

  test("a timed-out command keeps its actual partial cwd effect and uncertain receipt after reopen", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: [
          "/bin/sh",
          "-c",
          "printf before > partial-effect.txt; sleep 5; printf after >> partial-effect.txt",
        ],
        cwd: "subdir",
        timeoutMs: 500,
      },
      answer: "The command outcome requires reconciliation.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-command-uncertain-",
    });
    await mkdir(join(local.workspaceDirectory, "subdir"));
    const input = {
      requestId: "request:command-uncertain",
      text: "Run the bounded command in the selected relative directory.",
    };
    const accepted = await call<{ jobId: string }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/inputs`,
      { credential: local.owner, body: input },
    );
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "uncertain";
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "subdir", "partial-effect.txt"),
        "utf8",
      ),
    ).toBe("before");
    await local.reopenFactory();
    const recovered = await call<{
      jobId: string;
      dispatchStatus: string;
      outcome?: string;
      executionEffects: Array<{
        jobId: string;
        status: string;
        operation: string;
        target: { nodeId: string; workspaceId: string };
        ownershipGeneration: number;
        errorCode?: string;
      }>;
    }>(local.baseUrl, `/v1/commands/${input.requestId}`, {
      credential: local.owner,
    });
    expect(recovered.value).toMatchObject({
      jobId: accepted.value.jobId,
      dispatchStatus: "uncertain",
      executionEffects: [
        {
          status: "uncertain",
          operation: "argv-command",
          target: { nodeId: local.nodeId, workspaceId: local.workspaceId },
          ownershipGeneration: 0,
          errorCode: "command_timed_out",
        },
      ],
    });
    const context = await call<{ runtime: unknown }>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(JSON.stringify(context.value.runtime)).toContain(
      "The command outcome requires reconciliation.",
    );
    expect(
      await readFile(
        join(local.workspaceDirectory, "subdir", "partial-effect.txt"),
        "utf8",
      ),
    ).toBe("before");
  });

  test("rejects a model-selected cwd escape before a workspace effect", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_run_command",
      arguments: {
        argv: ["/bin/sh", "-c", "printf escaped > escaped.txt"],
        cwd: "../outside",
      },
      answer: "The requested working directory was rejected.",
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-command-cwd-reject-",
    });
    const outsideDirectory = join(local.directory, "outside");
    await mkdir(outsideDirectory);
    const input = {
      requestId: "request:cwd-rejected",
      text: "Run the command outside this workspace.",
    };
    await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
      credential: local.owner,
      body: input,
    });
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    expect(
      await readFile(join(outsideDirectory, "escaped.txt")).catch(() => null),
    ).toBeNull();
    const events = await call<{
      events: Array<{
        type: string;
        requestId: string | null;
        payload: Record<string, unknown>;
      }>;
    }>(local.baseUrl, "/v1/events", { credential: local.owner });
    expect(
      events.value.events.find(
        (event) =>
          event.type === "execution.failed" &&
          event.requestId === input.requestId,
      )?.payload,
    ).toMatchObject({ errorCode: "unsafe_workspace_path" });
  });
});

describe("standalone managed-work import process recovery", () => {
  test("parks a real partial restore and verifies a completed root after owned process loss", async () => {
    const directoryPrefix = "uzina-import-process-recovery-";
    const partialDestinationId = "destination:process-partial";
    const completeDestinationId = "destination:process-complete";
    const catalogRevocationDestinationId = "destination:catalog-revocation";
    const catalogChunkRevocationDestinationId =
      "destination:catalog-chunk-revocation";
    const renameRevocationDestinationId = "destination:rename-revocation";
    const validationRevocationDestinationId =
      "destination:validation-git-revocation";
    let importsEnabled = true;
    const sourceProvider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: {
        path: "source-effect.txt",
        content: "one genuine source effect\n",
      },
      answer: "The source effect settled once.",
    });
    const local = await scenario({
      models: sourceProvider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix,
      managedWorkImportEnabled: () => importsEnabled,
      managedWorkImportPaths: (directory) => ({
        catalogs: {
          "catalog:process-recovery": join(directory, "offline-catalog"),
        },
        destinations: {
          [partialDestinationId]: join(
            directory,
            "prepared-import",
            "partial-recovery",
          ),
          [completeDestinationId]: join(
            directory,
            "prepared-import",
            "complete-recovery",
          ),
          [catalogRevocationDestinationId]: join(
            directory,
            "catalog-revocation",
            "root",
          ),
          [catalogChunkRevocationDestinationId]: join(
            directory,
            "catalog-chunk-revocation",
            "root",
          ),
          [renameRevocationDestinationId]: join(
            directory,
            "prepared-import",
            "rename-revocation",
          ),
          [validationRevocationDestinationId]: join(
            directory,
            "validation-git-revocation",
            "root",
          ),
        },
      }),
    });
    const workspace = local.workspaceDirectory;
    await makeDirtyGitWorkspace(workspace);
    const catalogChunkFixtureBytes = Buffer.alloc(192 * 1024);
    for (let index = 0; index < catalogChunkFixtureBytes.length; index++) {
      catalogChunkFixtureBytes[index] = (index * 31 + 7) & 0xff;
    }
    await writeFile(
      join(workspace, "catalog-chunk-fixture.bin"),
      catalogChunkFixtureBytes,
    );
    const sourceInput = {
      requestId: "request:process-recovery-source",
      text: "Write and settle source state before the offline capture.",
    };
    expect(
      (
        await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
          credential: local.owner,
          body: sourceInput,
        })
      ).status,
    ).toBe(202);
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${sourceInput.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });

    const catalogPath = join(local.directory, "offline-catalog");
    const partialDestination = join(
      local.directory,
      "prepared-import",
      "partial-recovery",
    );
    const completeDestination = join(
      local.directory,
      "prepared-import",
      "complete-recovery",
    );
    const catalogRevocationDestination = join(
      local.directory,
      "catalog-revocation",
      "root",
    );
    const catalogChunkRevocationDestination = join(
      local.directory,
      "catalog-chunk-revocation",
      "root",
    );
    const renameRevocationDestination = join(
      local.directory,
      "prepared-import",
      "rename-revocation",
    );
    const validationRevocationDestination = join(
      local.directory,
      "validation-git-revocation",
      "root",
    );
    const partialDestinationRoot = join(
      await realpath(dirname(partialDestination)),
      basename(partialDestination),
    );
    const completeDestinationRoot = join(
      await realpath(dirname(completeDestination)),
      basename(completeDestination),
    );
    const runtimeDirectory = join(local.directory, "managed-work");
    const transport = new FileBlobTransport(catalogPath);
    const captured = await local.host.captureManagedWorkCheckpoint({
      credential: local.owner,
      threadId: local.threadId,
      transport,
    });
    const requirements = [
      "model:uzina-test/fixed-model",
      ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
    ];
    const sourceBundle = await validateManagedWorkBundle(
      captured.manifestReference,
      transport,
      { supportedRuntimeRequirements: requirements },
    );
    const sourceProjection = {
      conversations: sourceBundle.managedWork.conversations,
      entries: sourceBundle.managedWork.entries,
      tasks: sourceBundle.managedWork.tasks,
      submissions: sourceBundle.managedWork.submissions,
      documents: sourceBundle.managedWork.documents,
    };
    expect(sourceProjection.submissions.length).toBeGreaterThan(0);
    expect(
      await readFile(join(workspace, "catalog-chunk-fixture.bin")),
    ).toEqual(catalogChunkFixtureBytes);
    const catalogChunkFile =
      sourceBundle.manifest.workspace.workspace.entries.find(
        ({ path }) => path === "catalog-chunk-fixture.bin",
      );
    expect(catalogChunkFile).toMatchObject({
      size: catalogChunkFixtureBytes.byteLength,
      sha256: sha256(catalogChunkFixtureBytes),
    });
    expect(await readFile(join(workspace, "source-effect.txt"), "utf8")).toBe(
      "one genuine source effect\n",
    );
    const sourceWorkspaceEvidence = await gitWorkspaceEvidence(workspace);
    const sourceModelRequests = sourceProvider.requests();
    const catalogEvidence = async () =>
      Promise.all(
        (await readdir(catalogPath)).sort().map(async (name) => ({
          name,
          size: (await stat(join(catalogPath, name))).size,
          sha256: sha256(await readFile(join(catalogPath, name))),
        })),
      );
    const catalogBefore = await catalogEvidence();
    const coreSurfaceBefore = localCoreSurfaceCounts(local.host);
    const normalRuntimeNames = (await readdir(runtimeDirectory)).sort();

    await local.reopenFactory();
    const processRoot = join(local.directory, "owned-process-recovery");
    const wrapperDirectory = join(processRoot, "bin");
    const temporaryDirectory = join(processRoot, "tmp");
    const homeDirectory = join(processRoot, "home");
    const fetchLog = join(processRoot, "git-fetches.log");
    await Promise.all([
      mkdir(wrapperDirectory, { recursive: true }),
      mkdir(temporaryDirectory, { recursive: true }),
      mkdir(homeDirectory, { recursive: true }),
    ]);
    await writeFile(fetchLog, "");
    const realGit = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const wrapperPath = join(wrapperDirectory, "git");
    await writeFile(
      wrapperPath,
      [
        "#!/bin/sh",
        "workdir=$(pwd -P)",
        'case "$workdir" in',
        '  *"uzina-checkpoint-validate-"*)',
        '    if [ -n "$UZINA_TEST_GIT_VALIDATION_GATE_DIR" ] && [ -f "$UZINA_TEST_GIT_VALIDATION_GATE_DIR/revoked" ]; then',
        '      printf "%s\\n" "$*" >> "$UZINA_TEST_GIT_VALIDATION_GATE_DIR/native-git-after-revocation.log"',
        "    fi",
        '    if [ -n "$UZINA_TEST_GIT_VALIDATION_GATE_DIR" ] && [ "$1" = "init" ]; then',
        '      "$UZINA_TEST_REAL_GIT" "$@"',
        "      status=$?",
        '      if [ "$status" -ne 0 ]; then exit "$status"; fi',
        '      printf "actual checkpoint validation Git init completed: %s\\n" "$workdir" > "$UZINA_TEST_GIT_VALIDATION_GATE_DIR/reached.tmp"',
        '      mv "$UZINA_TEST_GIT_VALIDATION_GATE_DIR/reached.tmp" "$UZINA_TEST_GIT_VALIDATION_GATE_DIR/reached"',
        '      while [ ! -f "$UZINA_TEST_GIT_VALIDATION_GATE_DIR/release" ]; do /bin/sleep 0.01; done',
        '      exit "$status"',
        "    fi",
        "    ;;",
        "esac",
        'if [ "$1" = "fetch" ]; then',
        '  "$UZINA_TEST_REAL_GIT" "$@"',
        "  status=$?",
        '  if [ "$status" -ne 0 ]; then exit "$status"; fi',
        "  workdir=$(pwd -P)",
        '  case "$workdir" in',
        '    *".uzina-prepared-restore-"*)',
        '      printf "%s\\n" "$workdir" >> "$UZINA_TEST_GIT_FETCH_LOG"',
        '      if [ -n "$UZINA_TEST_GIT_FETCH_GATE_DIR" ]; then',
        '        printf "%s\\n" "$workdir" > "$UZINA_TEST_GIT_FETCH_GATE_DIR/reached.tmp"',
        '        mv "$UZINA_TEST_GIT_FETCH_GATE_DIR/reached.tmp" "$UZINA_TEST_GIT_FETCH_GATE_DIR/reached"',
        '        while [ ! -f "$UZINA_TEST_GIT_FETCH_GATE_DIR/release" ]; do /bin/sleep 0.01; done',
        "      fi",
        "      ;;",
        "  esac",
        '  exit "$status"',
        "fi",
        'exec "$UZINA_TEST_REAL_GIT" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const childConfiguration: ManagedWorkImportChildConfiguration = {
      databasePath: join(local.directory, "factory.sqlite"),
      runtimeDirectory,
      bootstrapSecret: `${directoryPrefix}-bootstrap`,
      catalogs: { "catalog:process-recovery": catalogPath },
      destinations: {
        [partialDestinationId]: partialDestination,
        [completeDestinationId]: completeDestination,
        [catalogRevocationDestinationId]: catalogRevocationDestination,
        [catalogChunkRevocationDestinationId]:
          catalogChunkRevocationDestination,
        [renameRevocationDestinationId]: renameRevocationDestination,
        [validationRevocationDestinationId]: validationRevocationDestination,
      },
      workspacePath: workspace,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
    };
    let childSequence = 0;
    const startChild = (
      gateDirectory?: string,
      finalRenameGateDirectory?: string,
      finalRenameTarget?: string,
      catalogOpenGateDirectory?: string,
      catalogOpenTarget?: string,
      catalogChunkReadGateDirectory?: string,
      catalogChunkReadTarget?: string,
      workspaceVerifyGateDirectory?: string,
      workspaceVerifyTarget?: string,
      workspaceVerifyRoot?: string,
      receiptMarkerProbeGateDirectory?: string,
      receiptMarkerProbeTarget?: string,
      receiptMarkerProbeRoot?: string,
      preparedReceiptGateDirectory?: string,
      preparedReceiptTarget?: string,
      validationGitGateDirectory?: string,
      workspaceGrowthGateDirectory?: string,
      workspaceGrowthTarget?: string,
    ) =>
      startManagedWorkImportChild({
        configuration: childConfiguration,
        gateDirectory,
        finalRenameGateDirectory,
        finalRenameTarget,
        catalogOpenGateDirectory,
        catalogOpenTarget,
        catalogChunkReadGateDirectory,
        catalogChunkReadTarget,
        workspaceVerifyGateDirectory,
        workspaceVerifyTarget,
        workspaceVerifyRoot,
        receiptMarkerProbeGateDirectory,
        receiptMarkerProbeTarget,
        receiptMarkerProbeRoot,
        preparedReceiptGateDirectory,
        preparedReceiptTarget,
        validationGitGateDirectory,
        workspaceGrowthGateDirectory,
        workspaceGrowthTarget,
        wrapperDirectory,
        realGit,
        fetchLog,
        temporaryDirectory,
        homeDirectory,
        statsPath: join(processRoot, `child-${++childSequence}.stats`),
      });
    const startReceiptMarkerProbeChild = (
      gateDirectory: string,
      target: string,
      root: string,
    ) =>
      startChild(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        gateDirectory,
        target,
        root,
      );
    const startPreparedReceiptChild = (gateDirectory: string, target: string) =>
      startChild(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        gateDirectory,
        target,
      );
    const startValidationGitChild = (gateDirectory: string) =>
      startChild(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        gateDirectory,
      );
    const startWorkspaceGrowthChild = (gateDirectory: string, target: string) =>
      startChild(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        gateDirectory,
        target,
      );
    const makeRequest = (requestId: string, destinationId: string) => ({
      contractVersion: CONTRACT_VERSION,
      requestId,
      sourceCatalogId: "catalog:process-recovery",
      manifestSha256: captured.manifestReference,
      destinationId,
    });
    const pendingImport = (
      child: ManagedWorkImportChild,
      request: unknown,
      credential = local.owner,
    ) => {
      const controller = new AbortController();
      let settled = false;
      const result = fetch(new URL("/v1/managed-work-imports", child.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      }).then(
        async (response) => ({
          kind: "response" as const,
          status: response.status,
          value: (await response.json()) as ManagedWorkImportStatus,
        }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      void result.then(() => {
        settled = true;
      });
      return { controller, result, settled: () => settled };
    };
    const parentStatus = (requestId: string) =>
      call<ManagedWorkImportStatus>(
        local.baseUrl,
        `/v1/managed-work-imports/${encodeURIComponent(requestId)}`,
        { credential: local.owner },
      );
    let firstChild: ManagedWorkImportChild | undefined;
    let recoveryChild: ManagedWorkImportChild | undefined;
    let completeChild: ManagedWorkImportChild | undefined;
    let completeRecoveryChild: ManagedWorkImportChild | undefined;
    let catalogRevocationChild: ManagedWorkImportChild | undefined;
    let catalogChunkRevocationChild: ManagedWorkImportChild | undefined;
    let workspaceVerifyChild: ManagedWorkImportChild | undefined;
    let workspaceGrowthChild: ManagedWorkImportChild | undefined;
    let receiptMarkerProbeChild: ManagedWorkImportChild | undefined;
    let preparedReceiptRevocationChild: ManagedWorkImportChild | undefined;
    let validationGitRevocationChild: ManagedWorkImportChild | undefined;
    let renameRevocationChild: ManagedWorkImportChild | undefined;
    try {
      const partialRequest = makeRequest(
        "import:partial-process-recovery",
        partialDestinationId,
      );
      const partialGate = join(processRoot, "partial-git-gate");
      await mkdir(partialGate);
      firstChild = await startChild(partialGate);
      const partialPending = pendingImport(firstChild, partialRequest);
      const partialWorkspacePath = (
        await waitForFile(join(partialGate, "reached"))
      ).trim();
      const partialStagingRoot = dirname(partialWorkspacePath);
      expect(
        basename(partialStagingRoot).startsWith(".uzina-prepared-restore-"),
      ).toBe(true);
      expect(dirname(partialStagingRoot)).toBe(dirname(partialDestinationRoot));
      expect((await parentStatus(partialRequest.requestId)).value.status).toBe(
        "preparing",
      );
      expect(partialPending.settled()).toBe(false);
      expect(
        (await lstat(join(partialWorkspacePath, ".git"))).isDirectory(),
      ).toBe(true);
      const fetchedHead = git(
        partialWorkspacePath,
        "rev-parse",
        "refs/heads/main",
      );
      expect(fetchedHead).toBe(sourceBundle.manifest.workspace.source.head);
      const bundleTemporaryName = (await readdir(temporaryDirectory)).find(
        (name) => name.startsWith("uzina-bundle-"),
      );
      if (!bundleTemporaryName) {
        throw new Error(
          "Real restore did not acquire its Git bundle temporary directory",
        );
      }
      const partialBundlePath = join(
        temporaryDirectory,
        bundleTemporaryName,
        "workspace.bundle",
      );
      const partialBundleHash = sha256(await readFile(partialBundlePath));
      const partialStageStat = await stat(partialStagingRoot);
      const partialWorkspaceEntries = await readdir(partialWorkspacePath);
      const partialFetchLog = await readFile(fetchLog, "utf8");
      expect(partialFetchLog.trim().split("\n")).toHaveLength(1);
      await stopManagedWorkImportChild(firstChild.child, "SIGKILL");
      firstChild = undefined;
      partialPending.controller.abort();
      const lostPartialReply = await partialPending.result;
      expect(lostPartialReply.kind).toBe("error");
      expect((await parentStatus(partialRequest.requestId)).value.status).toBe(
        "preparing",
      );
      await expect(lstat(partialDestination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const partialRootAfterKill = await stat(partialStagingRoot);
      expect(partialRootAfterKill).toMatchObject({
        dev: partialStageStat.dev,
        ino: partialStageStat.ino,
      });

      recoveryChild = await startChild();
      expect(
        (
          await call<ManagedWorkImportStatus>(
            recoveryChild.url,
            `/v1/managed-work-imports/${encodeURIComponent(partialRequest.requestId)}`,
            { credential: local.owner },
          )
        ).value.status,
      ).toBe("preparing");
      const partialRetry = await call<ManagedWorkImportStatus>(
        recoveryChild.url,
        "/v1/managed-work-imports",
        { credential: local.owner, body: partialRequest },
      );
      expect(partialRetry.status).toBe(202);
      expect(partialRetry.value.status).toBe("uncertain");
      expect(partialRetry.value.errorCode).toBe(
        "managed_work_import_restore_uncertain",
      );
      expect((await parentStatus(partialRequest.requestId)).value.status).toBe(
        "uncertain",
      );
      expect(await readFile(fetchLog, "utf8")).toBe(partialFetchLog);
      expect(sha256(await readFile(partialBundlePath))).toBe(partialBundleHash);
      expect(await readdir(partialWorkspacePath)).toEqual(
        partialWorkspaceEntries,
      );
      expect(git(partialWorkspacePath, "rev-parse", "refs/heads/main")).toBe(
        fetchedHead,
      );
      expect(await stat(partialStagingRoot)).toMatchObject({
        dev: partialStageStat.dev,
        ino: partialStageStat.ino,
      });
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(await gitWorkspaceEvidence(workspace)).toEqual(
        sourceWorkspaceEvidence,
      );
      expect(await readFile(join(workspace, "source-effect.txt"), "utf8")).toBe(
        sourceWorkspaceEvidence.sourceEffect,
      );
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(coreSurfaceBefore);
      await expect(lstat(partialDestination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await stopManagedWorkImportChild(recoveryChild.child, "SIGTERM");
      await expect(readFile(recoveryChild.statsPath, "utf8")).resolves.toBe(
        "0",
      );
      recoveryChild = undefined;

      const completeRequest = makeRequest(
        "import:complete-output-process-recovery",
        completeDestinationId,
      );
      const completeGate = join(processRoot, "complete-final-rename-gate");
      await mkdir(completeGate);
      completeChild = await startChild(
        undefined,
        completeGate,
        completeDestinationRoot,
      );
      const completePending = pendingImport(completeChild, completeRequest);
      expect(await waitForFile(join(completeGate, "reached"))).toBe(
        "actual final rename completed\n",
      );
      expect((await parentStatus(completeRequest.requestId)).value.status).toBe(
        "preparing",
      );
      const completeFetchLogAtGate = await readFile(fetchLog, "utf8");
      expect(completeFetchLogAtGate.trim().split("\n")).toHaveLength(2);

      expect((await stat(completeDestinationRoot)).isDirectory()).toBe(true);
      expect(completePending.settled()).toBe(false);
      const publishedOutputReceiptPath = join(
        completeDestinationRoot,
        ".uzina",
        "prepared-restore.json",
      );
      const preparedReceiptBytes = await readFile(publishedOutputReceiptPath);
      const preparedReceiptHash = sha256(preparedReceiptBytes);
      const preparedReceipt = JSON.parse(
        preparedReceiptBytes.toString("utf8"),
      ) as ManagedWorkImportStatus["preparationReceipt"];
      if (!preparedReceipt)
        throw new Error("Renamed output has no helper receipt");
      const completeBeforePublication = await parentStatus(
        completeRequest.requestId,
      );
      expect(completeBeforePublication.status).toBe(200);
      expect(completeBeforePublication.value.status).toBe("preparing");
      expect(
        completeBeforePublication.value.preparationReceipt,
      ).toBeUndefined();
      expect(
        (
          await local.host.database.all<{ count: number }>(
            "SELECT COUNT(*) AS count FROM managed_work_imports WHERE request_id = ? AND status = 'prepared-inactive'",
            [completeRequest.requestId],
          )
        )[0]?.count,
      ).toBe(0);
      const completeRootStat = await stat(completeDestinationRoot);
      const completeRuntimePath = join(
        completeDestinationRoot,
        "managed-work.sqlite",
      );
      const completeRuntimeStat = await stat(completeRuntimePath);
      const completeWorkspacePathFinal = join(
        completeDestinationRoot,
        "workspace",
      );
      const completeWorkspaceEvidence = await gitWorkspaceEvidence(
        completeWorkspacePathFinal,
      );
      expect(completeWorkspaceEvidence).toEqual(sourceWorkspaceEvidence);
      const completeRawCheckpoint =
        await readRawImportedCheckpoint(completeRuntimePath);
      const completePublicProjection = {
        conversations: completeRawCheckpoint.conversations,
        entries: completeRawCheckpoint.entries,
        tasks: completeRawCheckpoint.tasks,
        submissions: completeRawCheckpoint.submissions,
        documents: completeRawCheckpoint.documents,
      };

      await stopManagedWorkImportChild(completeChild.child, "SIGKILL");
      completeChild = undefined;
      completePending.controller.abort();
      expect((await completePending.result).kind).toBe("error");
      expect((await parentStatus(completeRequest.requestId)).value.status).toBe(
        "preparing",
      );
      expect((await parentStatus(completeRequest.requestId)).value.status).toBe(
        "preparing",
      );

      completeRecoveryChild = await startChild();
      const reopenedCompleteStatus = await call<ManagedWorkImportStatus>(
        completeRecoveryChild.url,
        `/v1/managed-work-imports/${encodeURIComponent(completeRequest.requestId)}`,
        { credential: local.owner },
      );
      expect(reopenedCompleteStatus.value.status).toBe("preparing");
      const fetchLogBeforeCompleteRetry = await readFile(fetchLog, "utf8");
      const completeRetry = await call<ManagedWorkImportStatus>(
        completeRecoveryChild.url,
        "/v1/managed-work-imports",
        { credential: local.owner, body: completeRequest },
      );
      expect(completeRetry.status).toBe(202);
      expect(completeRetry.value.status).toBe("prepared-inactive");
      expect(completeRetry.value.preparationReceipt).toEqual(preparedReceipt);
      expect(completeRetry.value.preparationReceiptSha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect((await parentStatus(completeRequest.requestId)).value).toEqual(
        completeRetry.value,
      );
      const completeSameIdRetry = await call<ManagedWorkImportStatus>(
        completeRecoveryChild.url,
        "/v1/managed-work-imports",
        { credential: local.owner, body: completeRequest },
      );
      expect(completeSameIdRetry.status).toBe(202);
      expect(completeSameIdRetry.value).toEqual(completeRetry.value);
      expect(await readFile(publishedOutputReceiptPath)).toEqual(
        preparedReceiptBytes,
      );
      expect(await stat(completeDestinationRoot)).toMatchObject({
        dev: completeRootStat.dev,
        ino: completeRootStat.ino,
      });
      expect(await stat(completeRuntimePath)).toMatchObject({
        dev: completeRuntimeStat.dev,
        ino: completeRuntimeStat.ino,
      });
      expect(await gitWorkspaceEvidence(completeWorkspacePathFinal)).toEqual(
        sourceWorkspaceEvidence,
      );
      expect(completePublicProjection).toEqual(sourceProjection);
      expect(
        await readRawImportedCheckpoint(completeRuntimePath),
      ).toMatchObject(sourceProjection);
      expect(await readFile(fetchLog, "utf8")).toBe(
        fetchLogBeforeCompleteRetry,
      );
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(await gitWorkspaceEvidence(workspace)).toEqual(
        sourceWorkspaceEvidence,
      );
      expect(await readFile(join(workspace, "source-effect.txt"), "utf8")).toBe(
        sourceWorkspaceEvidence.sourceEffect,
      );
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(coreSurfaceBefore);
      expect(sourceProvider.requests()).toBe(sourceModelRequests);
      const completeStatsChild = completeRecoveryChild;
      await stopManagedWorkImportChild(completeRecoveryChild.child, "SIGTERM");
      await expect(
        readFile(completeStatsChild.statsPath, "utf8"),
      ).resolves.toBe("0");
      completeRecoveryChild = undefined;

      const ownerActor = (await local.host.factory.authenticate(local.owner))
        .actor;
      const workspaceVerificationOwner = await call<{
        credentialId: string;
        credential: string;
        actor: unknown;
      }>(local.baseUrl, "/v1/credentials", {
        credential: local.owner,
        body: { kind: "human", name: "Prepared-workspace verification Owner" },
      });
      expect(workspaceVerificationOwner.status).toBe(201);
      expect(workspaceVerificationOwner.value.actor).toEqual(ownerActor);
      const workspaceVerificationCountsBefore = localCoreSurfaceCounts(
        local.host,
      );
      const workspaceVerificationRequestStatus = await parentStatus(
        completeRequest.requestId,
      );
      expect(workspaceVerificationRequestStatus.value.status).toBe(
        "prepared-inactive",
      );
      const workspaceVerificationTarget = join(
        completeWorkspacePathFinal,
        "binary",
      );
      const sourceBinaryBytes = await readFile(join(workspace, "binary"));
      expect(await readFile(workspaceVerificationTarget)).toEqual(
        sourceBinaryBytes,
      );
      const workspaceVerificationGate = join(
        processRoot,
        "prepared-workspace-read-owner-revocation",
      );
      await mkdir(workspaceVerificationGate);
      workspaceVerifyChild = await startChild(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        workspaceVerificationGate,
        workspaceVerificationTarget,
        completeWorkspacePathFinal,
      );
      const workspaceVerificationPending = pendingImport(
        workspaceVerifyChild,
        completeRequest,
        workspaceVerificationOwner.value.credential,
      );
      const workspaceReadCompletion = await waitForFile(
        join(workspaceVerificationGate, "reached"),
      );
      const workspaceReadMatch = workspaceReadCompletion.match(
        /^actual prepared workspace (?:chunk )?read completed: (\d+)\n$/,
      );
      if (!workspaceReadMatch) {
        throw new Error(
          `Unexpected prepared workspace read barrier: ${workspaceReadCompletion}`,
        );
      }
      expect(Number(workspaceReadMatch[1])).toBe(sourceBinaryBytes.byteLength);
      expect(workspaceVerificationPending.settled()).toBe(false);
      expect((await parentStatus(completeRequest.requestId)).value).toEqual(
        workspaceVerificationRequestStatus.value,
      );
      const workspaceVerificationRevocation = await call<{
        status: string;
      }>(
        local.baseUrl,
        `/v1/credentials/${encodeURIComponent(workspaceVerificationOwner.value.credentialId)}/revoke`,
        { credential: local.owner, body: {} },
      );
      expect(workspaceVerificationRevocation).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      await writeFile(
        join(workspaceVerificationGate, "revoked"),
        "revoked through Core HTTP after actual prepared workspace read\n",
      );
      await writeFile(join(workspaceVerificationGate, "release"), "release\n");
      const workspaceVerificationReply =
        await workspaceVerificationPending.result;
      if (workspaceVerificationReply.kind !== "response") {
        throw new Error(
          "Revoked prepared-workspace retry lost its HTTP refusal",
        );
      }
      expect(workspaceVerificationReply.status).toBe(401);
      expect((await parentStatus(completeRequest.requestId)).value).toEqual(
        workspaceVerificationRequestStatus.value,
      );
      expect(await readFile(publishedOutputReceiptPath)).toEqual(
        preparedReceiptBytes,
      );
      expect(await stat(completeDestinationRoot)).toMatchObject({
        dev: completeRootStat.dev,
        ino: completeRootStat.ino,
      });
      expect(await stat(completeRuntimePath)).toMatchObject({
        dev: completeRuntimeStat.dev,
        ino: completeRuntimeStat.ino,
      });
      expect(await readFile(workspaceVerificationTarget)).toEqual(
        sourceBinaryBytes,
      );
      expect(await gitWorkspaceEvidence(completeWorkspacePathFinal)).toEqual(
        completeWorkspaceEvidence,
      );
      expect(
        await readRawImportedCheckpoint(completeRuntimePath),
      ).toMatchObject(sourceProjection);
      const workspaceNativeResults = (
        await readFile(
          join(
            workspaceVerificationGate,
            "native-results-after-revocation.jsonl",
          ),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(workspaceNativeResults).toEqual([
        { operation: "close", completed: true },
      ]);
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(
        workspaceVerificationCountsBefore,
      );
      expect(sourceProvider.requests()).toBe(sourceModelRequests);
      const workspaceVerifyStats = workspaceVerifyChild;
      await stopManagedWorkImportChild(workspaceVerifyChild.child, "SIGTERM");
      await expect(
        readFile(workspaceVerifyStats.statsPath, "utf8"),
      ).resolves.toBe("0");
      workspaceVerifyChild = undefined;

      const expectOriginalPreparedEvidence = async (
        expectedStatus: ManagedWorkImportStatus,
      ) => {
        expect((await parentStatus(completeRequest.requestId)).value).toEqual(
          expectedStatus,
        );
        const receiptBytes = await readFile(publishedOutputReceiptPath);
        expect(receiptBytes).toEqual(preparedReceiptBytes);
        expect(sha256(receiptBytes)).toBe(preparedReceiptHash);
        expect(await stat(completeDestinationRoot)).toMatchObject({
          dev: completeRootStat.dev,
          ino: completeRootStat.ino,
        });
        expect(await stat(completeRuntimePath)).toMatchObject({
          dev: completeRuntimeStat.dev,
          ino: completeRuntimeStat.ino,
        });
        expect(await gitWorkspaceEvidence(completeWorkspacePathFinal)).toEqual(
          completeWorkspaceEvidence,
        );
        expect(
          await readRawImportedCheckpoint(completeRuntimePath),
        ).toMatchObject(sourceProjection);
        expect(sourceProvider.requests()).toBe(sourceModelRequests);
      };
      const observedNativeResults = async (gateDirectory: string) => {
        const contents = await readFile(
          join(gateDirectory, "native-results-after-revocation.jsonl"),
          "utf8",
        ).catch((error) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: string }).code === "ENOENT"
          ) {
            return "";
          }
          throw error;
        });
        return contents.trim()
          ? contents
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as Record<string, unknown>)
          : [];
      };

      const receiptMarkerOwner = await call<{
        credentialId: string;
        credential: string;
        actor: unknown;
      }>(local.baseUrl, "/v1/credentials", {
        credential: local.owner,
        body: { kind: "human", name: "Receipt-marker probe Owner" },
      });
      expect(receiptMarkerOwner.status).toBe(201);
      expect(receiptMarkerOwner.value.actor).toEqual(ownerActor);
      const receiptMarkerCountsBefore = localCoreSurfaceCounts(local.host);
      const receiptMarkerStatusBefore = await parentStatus(
        completeRequest.requestId,
      );
      const receiptMarkerGate = join(
        processRoot,
        "receipt-marker-probe-revocation",
      );
      await mkdir(receiptMarkerGate);
      const receiptMarkerTarget = join(completeDestinationRoot, ".uzina");
      receiptMarkerProbeChild = await startReceiptMarkerProbeChild(
        receiptMarkerGate,
        receiptMarkerTarget,
        completeDestinationRoot,
      );
      const receiptMarkerPending = pendingImport(
        receiptMarkerProbeChild,
        completeRequest,
        receiptMarkerOwner.value.credential,
      );
      expect(await waitForFile(join(receiptMarkerGate, "reached"))).toBe(
        "actual prepared metadata directory stat completed\n",
      );
      expect(receiptMarkerPending.settled()).toBe(false);
      expect((await parentStatus(completeRequest.requestId)).value).toEqual(
        receiptMarkerStatusBefore.value,
      );
      const receiptMarkerRevocation = await call<{ status: string }>(
        local.baseUrl,
        `/v1/credentials/${encodeURIComponent(receiptMarkerOwner.value.credentialId)}/revoke`,
        { credential: local.owner, body: {} },
      );
      expect(receiptMarkerRevocation).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      await writeFile(
        join(receiptMarkerGate, "revoked"),
        "revoked through Core HTTP after metadata directory stat\n",
      );
      await writeFile(join(receiptMarkerGate, "release"), "release\n");
      const receiptMarkerReply = await receiptMarkerPending.result;
      if (receiptMarkerReply.kind !== "response") {
        throw new Error("Revoked receipt-marker probe lost its HTTP refusal");
      }
      expect(receiptMarkerReply.status).toBe(401);
      expect(await observedNativeResults(receiptMarkerGate)).toEqual([]);
      await expectOriginalPreparedEvidence(receiptMarkerStatusBefore.value);
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(
        receiptMarkerCountsBefore,
      );
      const receiptMarkerChildStats = receiptMarkerProbeChild;
      await stopManagedWorkImportChild(
        receiptMarkerProbeChild.child,
        "SIGTERM",
      );
      await expect(
        readFile(receiptMarkerChildStats.statsPath, "utf8"),
      ).resolves.toBe("0");
      receiptMarkerProbeChild = undefined;

      const preparedReceiptOwner = await call<{
        credentialId: string;
        credential: string;
        actor: unknown;
      }>(local.baseUrl, "/v1/credentials", {
        credential: local.owner,
        body: { kind: "human", name: "Prepared receipt FD Owner" },
      });
      expect(preparedReceiptOwner.status).toBe(201);
      expect(preparedReceiptOwner.value.actor).toEqual(ownerActor);
      const preparedReceiptCountsBefore = localCoreSurfaceCounts(local.host);
      const preparedReceiptStatusBefore = await parentStatus(
        completeRequest.requestId,
      );
      const preparedReceiptGate = join(
        processRoot,
        "prepared-receipt-fd-revocation",
      );
      await mkdir(preparedReceiptGate);
      preparedReceiptRevocationChild = await startPreparedReceiptChild(
        preparedReceiptGate,
        publishedOutputReceiptPath,
      );
      const preparedReceiptPending = pendingImport(
        preparedReceiptRevocationChild,
        completeRequest,
        preparedReceiptOwner.value.credential,
      );
      expect(await waitForFile(join(preparedReceiptGate, "reached"))).toBe(
        "actual prepared receipt descriptor opened\n",
      );
      expect(preparedReceiptPending.settled()).toBe(false);
      expect((await parentStatus(completeRequest.requestId)).value).toEqual(
        preparedReceiptStatusBefore.value,
      );
      const preparedReceiptRevocation = await call<{ status: string }>(
        local.baseUrl,
        `/v1/credentials/${encodeURIComponent(preparedReceiptOwner.value.credentialId)}/revoke`,
        { credential: local.owner, body: {} },
      );
      expect(preparedReceiptRevocation).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      await writeFile(
        join(preparedReceiptGate, "revoked"),
        "revoked through Core HTTP after actual receipt FD open\n",
      );
      await writeFile(join(preparedReceiptGate, "release"), "release\n");
      const preparedReceiptReply = await preparedReceiptPending.result;
      if (preparedReceiptReply.kind !== "response") {
        throw new Error("Revoked prepared receipt read lost its HTTP refusal");
      }
      expect(preparedReceiptReply.status).toBe(401);
      expect(await observedNativeResults(preparedReceiptGate)).toEqual([
        { operation: "close", completed: true },
      ]);
      await expectOriginalPreparedEvidence(preparedReceiptStatusBefore.value);
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(
        preparedReceiptCountsBefore,
      );
      const preparedReceiptChildStats = preparedReceiptRevocationChild;
      await stopManagedWorkImportChild(
        preparedReceiptRevocationChild.child,
        "SIGTERM",
      );
      await expect(
        readFile(preparedReceiptChildStats.statsPath, "utf8"),
      ).resolves.toBe("0");
      preparedReceiptRevocationChild = undefined;

      const validationOwner = await call<{
        credentialId: string;
        credential: string;
        actor: unknown;
      }>(local.baseUrl, "/v1/credentials", {
        credential: local.owner,
        body: { kind: "human", name: "Validation Git Owner" },
      });
      expect(validationOwner.status).toBe(201);
      expect(validationOwner.value.actor).toEqual(ownerActor);
      const validationCountsBefore = localCoreSurfaceCounts(local.host);
      const validationRequest = makeRequest(
        "import:validation-git-owner-revocation",
        validationRevocationDestinationId,
      );
      const validationGitGate = join(
        processRoot,
        "validation-git-owner-revocation",
      );
      await mkdir(validationGitGate);
      validationGitRevocationChild =
        await startValidationGitChild(validationGitGate);
      const validationPending = pendingImport(
        validationGitRevocationChild,
        validationRequest,
        validationOwner.value.credential,
      );
      const validationGitReached = await waitForFile(
        join(validationGitGate, "reached"),
      );
      const validationGitWorkdir = validationGitReached
        .replace(/^actual checkpoint validation Git init completed: /, "")
        .trim();
      expect(basename(validationGitWorkdir)).toBe("checkout");
      const validationGitTemporaryRoot = dirname(validationGitWorkdir);
      expect(basename(validationGitTemporaryRoot)).toMatch(
        /^uzina-checkpoint-validate-/,
      );
      const validationStatusAtGate = await parentStatus(
        validationRequest.requestId,
      );
      expect(validationStatusAtGate.value.status).toBe("admitted");
      expect(validationPending.settled()).toBe(false);
      const validationRevocation = await call<{ status: string }>(
        local.baseUrl,
        `/v1/credentials/${encodeURIComponent(validationOwner.value.credentialId)}/revoke`,
        { credential: local.owner, body: {} },
      );
      expect(validationRevocation).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      await writeFile(
        join(validationGitGate, "revoked"),
        "revoked through Core HTTP after actual Git init\n",
      );
      await writeFile(join(validationGitGate, "release"), "release\n");
      const validationReply = await validationPending.result;
      if (validationReply.kind !== "response") {
        throw new Error("Revoked validation lost its HTTP refusal");
      }
      expect(validationReply.status).toBe(401);
      const laterGitCommands = await readFile(
        join(validationGitGate, "native-git-after-revocation.log"),
        "utf8",
      ).catch((error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        ) {
          return "";
        }
        throw error;
      });
      expect(laterGitCommands).toBe("");
      expect((await parentStatus(validationRequest.requestId)).value).toEqual(
        validationStatusAtGate.value,
      );
      await expect(
        lstat(validationRevocationDestination),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(validationGitTemporaryRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(
        validationCountsBefore,
      );
      expect(sourceProvider.requests()).toBe(sourceModelRequests);
      const validationChildStats = validationGitRevocationChild;
      await stopManagedWorkImportChild(
        validationGitRevocationChild.child,
        "SIGTERM",
      );
      await expect(
        readFile(validationChildStats.statsPath, "utf8"),
      ).resolves.toBe("0");
      validationGitRevocationChild = undefined;

      const catalogTemporaryOwner = await call<{
        credentialId: string;
        credential: string;
        actor: unknown;
      }>(local.baseUrl, "/v1/credentials", {
        credential: local.owner,
        body: { kind: "human", name: "Catalog-read revocation Owner" },
      });
      expect(catalogTemporaryOwner.status).toBe(201);
      expect(catalogTemporaryOwner.value.actor).toEqual(ownerActor);
      const catalogCoreCountsBefore = localCoreSurfaceCounts(local.host);
      const catalogRevocationRequest = makeRequest(
        "import:catalog-read-owner-revocation",
        catalogRevocationDestinationId,
      );
      const catalogOpenGate = join(processRoot, "catalog-open-revocation");
      await mkdir(catalogOpenGate);
      const canonicalCatalogManifest = join(
        await realpath(catalogPath),
        captured.manifestReference,
      );
      catalogRevocationChild = await startChild(
        undefined,
        undefined,
        undefined,
        catalogOpenGate,
        canonicalCatalogManifest,
      );
      const catalogRevocationPending = pendingImport(
        catalogRevocationChild,
        catalogRevocationRequest,
        catalogTemporaryOwner.value.credential,
      );
      expect(await waitForFile(join(catalogOpenGate, "reached"))).toBe(
        "actual catalog descriptor opened\n",
      );
      expect(
        (await parentStatus(catalogRevocationRequest.requestId)).value.status,
      ).toBe("admitted");
      const admittedOverlapWorkspace = "workspace:admitted-import-reservation";
      local.addWorkspaceMapping(
        admittedOverlapWorkspace,
        dirname(catalogRevocationDestination),
      );
      importsEnabled = false;
      await expect(local.reopenFactory()).rejects.toThrow(
        "managed_work_import_destination_reserved",
      );
      local.removeWorkspaceMapping(admittedOverlapWorkspace);
      importsEnabled = true;
      await local.reopenFactory();
      expect(
        (await parentStatus(catalogRevocationRequest.requestId)).value.status,
      ).toBe("admitted");
      const catalogCredentialRevoked = await call<{ status: string }>(
        local.baseUrl,
        `/v1/credentials/${encodeURIComponent(catalogTemporaryOwner.value.credentialId)}/revoke`,
        { credential: local.owner, body: {} },
      );
      expect(catalogCredentialRevoked).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      await writeFile(
        join(catalogOpenGate, "revoked"),
        "revoked through Core HTTP\n",
      );
      await writeFile(join(catalogOpenGate, "release"), "release\n");
      const catalogRevocationReply = await catalogRevocationPending.result;
      if (catalogRevocationReply.kind !== "response") {
        throw new Error("Revoked catalog request lost its HTTP refusal");
      }
      expect(catalogRevocationReply.status).toBe(401);
      expect(
        (await parentStatus(catalogRevocationRequest.requestId)).value.status,
      ).toBe("admitted");
      await expect(lstat(catalogRevocationDestination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const nativeResults = (
        await readFile(
          join(catalogOpenGate, "native-results-after-revocation.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(nativeResults).toEqual([{ operation: "close", completed: true }]);
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(await gitWorkspaceEvidence(workspace)).toEqual(
        sourceWorkspaceEvidence,
      );
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(
        catalogCoreCountsBefore,
      );
      await stopManagedWorkImportChild(catalogRevocationChild.child, "SIGTERM");
      await expect(
        readFile(catalogRevocationChild.statsPath, "utf8"),
      ).resolves.toBe("0");
      catalogRevocationChild = undefined;

      const catalogChunkTemporaryOwner = await call<{
        credentialId: string;
        credential: string;
        actor: unknown;
      }>(local.baseUrl, "/v1/credentials", {
        credential: local.owner,
        body: { kind: "human", name: "Catalog-chunk revocation Owner" },
      });
      expect(catalogChunkTemporaryOwner.status).toBe(201);
      expect(catalogChunkTemporaryOwner.value.actor).toEqual(ownerActor);
      const catalogChunkCoreCountsBefore = localCoreSurfaceCounts(local.host);
      const catalogChunkRequest = makeRequest(
        "import:catalog-chunk-owner-revocation",
        catalogChunkRevocationDestinationId,
      );
      const catalogChunkReference = catalogChunkFile!.sha256;
      const catalogChunkReadTarget = join(
        await realpath(catalogPath),
        catalogChunkReference,
      );
      expect(await stat(catalogChunkReadTarget)).toMatchObject({
        size: catalogChunkFixtureBytes.byteLength,
      });
      const catalogChunkReadGate = join(
        processRoot,
        "catalog-chunk-read-owner-revocation",
      );
      await mkdir(catalogChunkReadGate);
      catalogChunkRevocationChild = await startChild(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        catalogChunkReadGate,
        catalogChunkReadTarget,
      );
      const catalogChunkPending = pendingImport(
        catalogChunkRevocationChild,
        catalogChunkRequest,
        catalogChunkTemporaryOwner.value.credential,
      );
      const completedChunk = await waitForFile(
        join(catalogChunkReadGate, "reached"),
      );
      const completedChunkMatch = completedChunk.match(
        /^actual first catalog chunk completed: (\d+)\n$/,
      );
      if (!completedChunkMatch) {
        throw new Error(`Unexpected catalog chunk gate: ${completedChunk}`);
      }
      const completedChunkBytes = Number(completedChunkMatch[1]);
      expect(completedChunkBytes).toBeGreaterThan(0);
      expect(completedChunkBytes).toBeLessThan(
        catalogChunkFixtureBytes.byteLength,
      );
      expect(
        (await parentStatus(catalogChunkRequest.requestId)).value.status,
      ).toBe("admitted");
      expect(catalogChunkPending.settled()).toBe(false);
      await expect(
        lstat(catalogChunkRevocationDestination),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      const catalogChunkCredentialRevoked = await call<{ status: string }>(
        local.baseUrl,
        `/v1/credentials/${encodeURIComponent(catalogChunkTemporaryOwner.value.credentialId)}/revoke`,
        { credential: local.owner, body: {} },
      );
      expect(catalogChunkCredentialRevoked).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      await writeFile(
        join(catalogChunkReadGate, "revoked"),
        "revoked through Core HTTP after completed chunk\n",
      );
      await writeFile(join(catalogChunkReadGate, "release"), "release\n");
      const catalogChunkReply = await catalogChunkPending.result;
      if (catalogChunkReply.kind !== "response") {
        throw new Error("Revoked catalog read lost its HTTP refusal");
      }
      expect(catalogChunkReply.status).toBe(401);
      expect(
        (await parentStatus(catalogChunkRequest.requestId)).value.status,
      ).toBe("admitted");
      await expect(
        lstat(catalogChunkRevocationDestination),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(dirname(catalogChunkRevocationDestination))).toEqual(
        [],
      );
      const catalogChunkNativeResults = (
        await readFile(
          join(catalogChunkReadGate, "native-results-after-revocation.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(catalogChunkNativeResults).toEqual([
        { operation: "close", completed: true },
      ]);
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(await gitWorkspaceEvidence(workspace)).toEqual(
        sourceWorkspaceEvidence,
      );
      expect(
        await readFile(join(workspace, "catalog-chunk-fixture.bin")),
      ).toEqual(catalogChunkFixtureBytes);
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(
        catalogChunkCoreCountsBefore,
      );
      expect(sourceProvider.requests()).toBe(sourceModelRequests);
      const catalogChunkChildStats = catalogChunkRevocationChild;
      await stopManagedWorkImportChild(
        catalogChunkRevocationChild.child,
        "SIGTERM",
      );
      await expect(
        readFile(catalogChunkChildStats.statsPath, "utf8"),
      ).resolves.toBe("0");
      catalogChunkRevocationChild = undefined;

      const renameTemporaryOwner = await call<{
        credentialId: string;
        credential: string;
        actor: unknown;
      }>(local.baseUrl, "/v1/credentials", {
        credential: local.owner,
        body: { kind: "human", name: "Prepared-rename revocation Owner" },
      });
      expect(renameTemporaryOwner.status).toBe(201);
      expect(renameTemporaryOwner.value.actor).toEqual(ownerActor);
      const renameCoreCountsBefore = localCoreSurfaceCounts(local.host);
      const renameRevocationRequest = makeRequest(
        "import:prepared-rename-owner-revocation",
        renameRevocationDestinationId,
      );
      const renameRevocationDestinationRoot = join(
        await realpath(dirname(renameRevocationDestination)),
        basename(renameRevocationDestination),
      );
      const finalRenameGate = join(
        processRoot,
        "final-rename-owner-revocation",
      );
      await mkdir(finalRenameGate);
      renameRevocationChild = await startChild(
        undefined,
        finalRenameGate,
        renameRevocationDestinationRoot,
      );
      const renameRevocationPending = pendingImport(
        renameRevocationChild,
        renameRevocationRequest,
        renameTemporaryOwner.value.credential,
      );
      expect(await waitForFile(join(finalRenameGate, "reached"))).toBe(
        "actual final rename completed\n",
      );
      expect(
        (await parentStatus(renameRevocationRequest.requestId)).value.status,
      ).toBe("preparing");
      const renameReceiptPath = join(
        renameRevocationDestinationRoot,
        ".uzina",
        "prepared-restore.json",
      );
      const renameReceiptBytes = await readFile(renameReceiptPath);
      const renameReceipt = JSON.parse(
        renameReceiptBytes.toString("utf8"),
      ) as ManagedWorkImportStatus["preparationReceipt"];
      if (!renameReceipt) {
        throw new Error("Actual final rename omitted its prepared receipt");
      }
      const renameRootStat = await stat(renameRevocationDestinationRoot);
      const preparingOverlapWorkspace =
        "workspace:preparing-import-reservation";
      local.addWorkspaceMapping(
        preparingOverlapWorkspace,
        renameRevocationDestinationRoot,
      );
      importsEnabled = false;
      await expect(local.reopenFactory()).rejects.toThrow(
        "managed_work_import_destination_reserved",
      );
      local.removeWorkspaceMapping(preparingOverlapWorkspace);
      importsEnabled = true;
      await local.reopenFactory();
      expect(
        (await parentStatus(renameRevocationRequest.requestId)).value.status,
      ).toBe("preparing");
      const renameRuntimePath = join(
        renameRevocationDestinationRoot,
        "managed-work.sqlite",
      );
      const renameRuntimeStat = await stat(renameRuntimePath);
      const renameWorkspacePath = join(
        renameRevocationDestinationRoot,
        "workspace",
      );
      const renameWorkspaceEvidence =
        await gitWorkspaceEvidence(renameWorkspacePath);
      expect(renameWorkspaceEvidence).toEqual(sourceWorkspaceEvidence);
      const renameRawCheckpoint =
        await readRawImportedCheckpoint(renameRuntimePath);
      const renamePublicProjection = {
        conversations: renameRawCheckpoint.conversations,
        entries: renameRawCheckpoint.entries,
        tasks: renameRawCheckpoint.tasks,
        submissions: renameRawCheckpoint.submissions,
        documents: renameRawCheckpoint.documents,
      };
      const fetchLogBeforeOwnerRevocation = await readFile(fetchLog, "utf8");
      const renameCredentialRevoked = await call<{ status: string }>(
        local.baseUrl,
        `/v1/credentials/${encodeURIComponent(renameTemporaryOwner.value.credentialId)}/revoke`,
        { credential: local.owner, body: {} },
      );
      expect(renameCredentialRevoked).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      await writeFile(
        join(finalRenameGate, "revoked"),
        "revoked through Core HTTP\n",
      );
      await writeFile(join(finalRenameGate, "release"), "release\n");
      const renameRevocationReply = await renameRevocationPending.result;
      if (renameRevocationReply.kind !== "response") {
        throw new Error("Revoked final-rename request lost its HTTP refusal");
      }
      expect(renameRevocationReply.status).toBe(401);
      expect(
        (await parentStatus(renameRevocationRequest.requestId)).value.status,
      ).toBe("preparing");
      expect(await readFile(renameReceiptPath)).toEqual(renameReceiptBytes);
      expect(await stat(renameRevocationDestinationRoot)).toMatchObject({
        dev: renameRootStat.dev,
        ino: renameRootStat.ino,
      });
      expect(await stat(renameRuntimePath)).toMatchObject({
        dev: renameRuntimeStat.dev,
        ino: renameRuntimeStat.ino,
      });
      expect(await gitWorkspaceEvidence(renameWorkspacePath)).toEqual(
        renameWorkspaceEvidence,
      );
      expect(await readRawImportedCheckpoint(renameRuntimePath)).toMatchObject(
        renamePublicProjection,
      );
      expect(await readFile(fetchLog, "utf8")).toBe(
        fetchLogBeforeOwnerRevocation,
      );

      const ownerReconciliation = await call<ManagedWorkImportStatus>(
        renameRevocationChild.url,
        "/v1/managed-work-imports",
        { credential: local.owner, body: renameRevocationRequest },
      );
      expect(ownerReconciliation.status).toBe(202);
      expect(ownerReconciliation.value.status).toBe("prepared-inactive");
      expect(ownerReconciliation.value.preparationReceipt).toEqual(
        renameReceipt,
      );
      expect(ownerReconciliation.value.preparationReceiptSha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
      const ownerSameIdRetry = await call<ManagedWorkImportStatus>(
        renameRevocationChild.url,
        "/v1/managed-work-imports",
        { credential: local.owner, body: renameRevocationRequest },
      );
      expect(ownerSameIdRetry.value).toEqual(ownerReconciliation.value);
      expect(await readFile(renameReceiptPath)).toEqual(renameReceiptBytes);
      expect(await stat(renameRevocationDestinationRoot)).toMatchObject({
        dev: renameRootStat.dev,
        ino: renameRootStat.ino,
      });
      expect(await stat(renameRuntimePath)).toMatchObject({
        dev: renameRuntimeStat.dev,
        ino: renameRuntimeStat.ino,
      });
      expect(await gitWorkspaceEvidence(renameWorkspacePath)).toEqual(
        sourceWorkspaceEvidence,
      );
      expect(await readRawImportedCheckpoint(renameRuntimePath)).toMatchObject(
        renamePublicProjection,
      );
      expect(await readFile(fetchLog, "utf8")).toBe(
        fetchLogBeforeOwnerRevocation,
      );
      expect(await catalogEvidence()).toEqual(catalogBefore);
      expect(
        await readdir(runtimeDirectory).then((names) => names.sort()),
      ).toEqual(normalRuntimeNames);
      expect(localCoreSurfaceCounts(local.host)).toEqual(
        renameCoreCountsBefore,
      );
      expect(sourceProvider.requests()).toBe(sourceModelRequests);
      expect(
        (await parentStatus(renameRevocationRequest.requestId)).value,
      ).toEqual(ownerReconciliation.value);
      const renameChildStats = renameRevocationChild;
      await stopManagedWorkImportChild(renameRevocationChild.child, "SIGTERM");
      await expect(readFile(renameChildStats.statsPath, "utf8")).resolves.toBe(
        "0",
      );
      renameRevocationChild = undefined;

      const growthTarget = join(completeWorkspacePathFinal, "tracked.txt");
      const growthManifestEntry =
        sourceBundle.manifest.workspace.workspace.entries.find(
          ({ path }) => path === "tracked.txt",
        );
      if (!growthManifestEntry || growthManifestEntry.kind !== "file") {
        throw new Error("Captured workspace omitted the tracked growth target");
      }
      const originalGrowthFile = await readFile(growthTarget);
      expect(originalGrowthFile.byteLength).toBe(growthManifestEntry.size);
      const workspaceGrowthGate = join(
        processRoot,
        "prepared-workspace-growth-boundary",
      );
      await mkdir(workspaceGrowthGate);
      workspaceGrowthChild = await startWorkspaceGrowthChild(
        workspaceGrowthGate,
        growthTarget,
      );
      const growthRequest = pendingImport(
        workspaceGrowthChild,
        completeRequest,
      );
      const growthDescriptorStat = await waitForFile(
        join(workspaceGrowthGate, "reached"),
      );
      expect(growthDescriptorStat).toBe(
        `actual prepared workspace descriptor stat completed: ${growthManifestEntry.size}\n`,
      );
      const appendedBytes = Buffer.alloc(64 * 1024, 0xa7);
      const growthHandle = await open(growthTarget, "a");
      try {
        const appended = await growthHandle.write(appendedBytes);
        expect(appended.bytesWritten).toBe(appendedBytes.byteLength);
        await growthHandle.sync();
      } finally {
        await growthHandle.close();
      }
      expect(await stat(growthTarget)).toMatchObject({
        size: growthManifestEntry.size + appendedBytes.byteLength,
      });
      await writeFile(join(workspaceGrowthGate, "release"), "release\n");
      const growthReply = await growthRequest.result;
      if (growthReply.kind !== "response") {
        throw new Error("Growing prepared file retry lost its HTTP response");
      }
      expect(growthReply.status).toBe(202);
      const growthStatus = await parentStatus(completeRequest.requestId);
      expect(growthStatus.value.status).toBe("uncertain");
      expect(growthStatus.value.preparationReceipt).toEqual(preparedReceipt);
      expect(await readFile(publishedOutputReceiptPath)).toEqual(
        preparedReceiptBytes,
      );
      expect(await stat(completeDestinationRoot)).toMatchObject({
        dev: completeRootStat.dev,
        ino: completeRootStat.ino,
      });
      expect(await stat(completeRuntimePath)).toMatchObject({
        dev: completeRuntimeStat.dev,
        ino: completeRuntimeStat.ino,
      });
      const workspaceReadObservations = (
        await readFile(
          join(workspaceGrowthGate, "workspace-read-observations.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        workspaceReadObservations.filter(
          ({ operation }) => operation === "readFile",
        ),
      ).toEqual([]);
      const workspaceChunkReads = workspaceReadObservations.filter(
        ({ operation }) => operation === "read",
      );
      expect(workspaceChunkReads.length).toBeGreaterThan(0);
      expect(
        workspaceChunkReads.reduce(
          (total, { bytesRead }) => total + Number(bytesRead),
          0,
        ),
      ).toBeLessThanOrEqual(growthManifestEntry.size + 1);
      expect(
        workspaceChunkReads.reduce(
          (total, { requestedBytes }) => total + Number(requestedBytes),
          0,
        ),
      ).toBeLessThanOrEqual(growthManifestEntry.size + 1);
      const grownFileBytes = await readFile(growthTarget);
      expect(grownFileBytes.subarray(0, originalGrowthFile.byteLength)).toEqual(
        originalGrowthFile,
      );
      expect(grownFileBytes.subarray(originalGrowthFile.byteLength)).toEqual(
        appendedBytes,
      );
      expect(
        await readRawImportedCheckpoint(completeRuntimePath),
      ).toMatchObject(sourceProjection);
      const growthChildStats = workspaceGrowthChild;
      await stopManagedWorkImportChild(workspaceGrowthChild.child, "SIGTERM");
      await expect(readFile(growthChildStats.statsPath, "utf8")).resolves.toBe(
        "0",
      );
      workspaceGrowthChild = undefined;
    } finally {
      for (const child of [
        firstChild,
        recoveryChild,
        completeChild,
        completeRecoveryChild,
        catalogRevocationChild,
        catalogChunkRevocationChild,
        workspaceVerifyChild,
        workspaceGrowthChild,
        receiptMarkerProbeChild,
        preparedReceiptRevocationChild,
        validationGitRevocationChild,
        renameRevocationChild,
      ]) {
        if (child && ownedImportProcesses.has(child.child)) {
          await stopManagedWorkImportChild(child.child, "SIGKILL");
        }
      }
    }
  });
});

describe("authenticated cloud producer to standalone inactive consumer", () => {
  test("imports owner-downloaded Workerd bytes as inactive state while local Pi work remains usable", async () => {
    const sourceDirectory = await mkdtemp(
      join(tmpdir(), "uzina-cloud-producer-offline-consumer-"),
    );
    const sourceWorkspace = join(sourceDirectory, "source-workspace");
    await makeDirtyGitWorkspace(sourceWorkspace);
    const workerArtifact = await buildCloudflareWorkerArtifact(
      join(
        import.meta.dir,
        "../../cloudflare/test/capture-aware-workerd-entry.ts",
      ),
    );
    const captureStateBarrier = new CaptureStateBarrier();
    const pendingWorkerdRequests = new Map<Promise<unknown>, () => void>();
    const trackWorkerdRequest = <T>(
      operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const controller = new AbortController();
      const promise = operation(controller.signal);
      pendingWorkerdRequests.set(promise, () => controller.abort());
      void promise.then(
        () => pendingWorkerdRequests.delete(promise),
        () => undefined,
      );
      return promise;
    };
    const waitForCaptureStateBarrier = async (
      entered: Promise<void>,
      label: string,
    ) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Timed out waiting for ${label}`)),
              15_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const trackedJsonPost = <T>(
      baseUrl: string,
      path: string,
      credential: string,
      body: unknown,
    ) =>
      trackWorkerdRequest(async (signal) => {
        const response = await fetch(new URL(path, baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
        return {
          status: response.status,
          value: (await response.json()) as T,
        };
      });
    const trackedDiscardPost = (
      baseUrl: string,
      path: string,
      credential: string,
      body: unknown,
    ) =>
      trackWorkerdRequest(async (signal) => {
        const response = await fetch(new URL(path, baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
        const status = response.status;
        await response.body?.cancel();
        return status;
      });
    const createSourceMiniflare = () =>
      new Miniflare({
        name: "uzina-cloud-producer-offline-consumer",
        script: workerArtifact.script,
        modules: true,
        compatibilityDate: "2026-05-01",
        host: "127.0.0.1",
        port: 0,
        bindings: {
          UZINA_BOOTSTRAP_SECRET: "cloud-producer-test-bootstrap",
          UZINA_TEST_CAPTURE_STATE_BARRIER_URL: captureStateBarrier.url,
        },
        durableObjects: {
          FACTORY: { className: "CaptureTestFactory", useSQLite: true },
          MANAGED_WORK: {
            className: "CaptureTestManagedWork",
            useSQLite: true,
          },
        },
        durableObjectsPersist: join(sourceDirectory, "durable-objects"),
        r2Buckets: ["CHECKPOINTS"],
        r2Persist: join(sourceDirectory, "r2"),
      });
    let miniflare = createSourceMiniflare();
    const sourceDaemonDatabasePath = join(sourceDirectory, "executor.sqlite");
    let sourceDaemon: ExecutionDaemon | undefined;
    let sourceAbort: AbortController | undefined;
    let sourceLoop: Promise<void> | undefined;
    let unrelatedCloudDaemon: ExecutionDaemon | undefined;
    let unrelatedCloudAbort: AbortController | undefined;
    let unrelatedCloudLoop: Promise<void> | undefined;
    fixtures.push({
      directory: sourceDirectory,
      async close() {
        captureStateBarrier.releaseAll();
        const failures: unknown[] = [];
        const pending = [...pendingWorkerdRequests];
        for (const [, abort] of pending) abort();
        for (const [request] of pending) {
          const result = await Promise.allSettled([request]);
          if (result[0]?.status === "rejected") failures.push(result[0].reason);
          pendingWorkerdRequests.delete(request);
        }
        unrelatedCloudAbort?.abort();
        try {
          await unrelatedCloudLoop;
        } catch (error) {
          failures.push(error);
        }
        try {
          unrelatedCloudDaemon?.close();
        } catch (error) {
          failures.push(error);
        }
        sourceAbort?.abort();
        try {
          await sourceLoop;
        } catch (error) {
          failures.push(error);
        }
        try {
          sourceDaemon?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await miniflare.dispose();
        } catch (error) {
          failures.push(error);
        }
        try {
          await captureStateBarrier.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "Owned Workerd source fixture cleanup failed",
          );
        }
      },
    });
    let sourceBaseUrl = (await miniflare.ready).toString();
    const bootstrap = await call<{ credential: string }>(
      sourceBaseUrl,
      "/v1/bootstrap",
      {
        credential: "cloud-producer-test-bootstrap",
        bootstrap: true,
        body: { name: "Cloud source owner" },
      },
    );
    expect(bootstrap.status).toBe(201);
    const cloudOwner = bootstrap.value.credential;
    const sourceProjectId = "project:cloud-producer";
    const sourceNodeId = "node:cloud-producer";
    const sourceWorkspaceId = "workspace:cloud-producer";
    const sourceProject = await call<{ projectId: string }>(
      sourceBaseUrl,
      "/v1/projects",
      {
        credential: cloudOwner,
        body: { projectId: sourceProjectId, name: "Cloud producer" },
      },
    );
    const sourceNode = await call<{
      node: { nodeId: string };
      credential: string;
    }>(sourceBaseUrl, "/v1/nodes", {
      credential: cloudOwner,
      body: { nodeId: sourceNodeId, name: "Real Workerd test executor" },
    });
    const sourceWorkspaceRecord = await call<{ workspaceId: string }>(
      sourceBaseUrl,
      "/v1/workspaces",
      {
        credential: cloudOwner,
        body: {
          workspaceId: sourceWorkspaceId,
          nodeId: sourceNode.value.node.nodeId,
          name: "Cloud producer workspace",
        },
      },
    );
    sourceDaemon = new ExecutionDaemon({
      databasePath: sourceDaemonDatabasePath,
      nodeId: sourceNode.value.node.nodeId,
      nodeCredential: sourceNode.value.credential,
      workspaces: [
        {
          workspaceId: sourceWorkspaceRecord.value.workspaceId,
          directory: sourceWorkspace,
        },
      ],
      daemonVersion: "cloud-producer-c1-test",
    });
    sourceAbort = new AbortController();
    sourceLoop = new ExecutionLoop({
      daemon: sourceDaemon,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: sourceBaseUrl,
        nodeId: sourceNode.value.node.nodeId,
        credential: sourceNode.value.credential,
      }),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 100,
    }).run(sourceAbort.signal);
    await until(async () => {
      const nodes = await call<{ nodes: Array<{ availability: string }> }>(
        sourceBaseUrl,
        "/v1/nodes",
        { credential: cloudOwner },
      );
      return nodes.value.nodes[0]?.availability === "online";
    });

    const modelProvider = "uzina-capture-test";
    const modelId = "capture-test-model";
    const localModel = deterministicToolModels({
      providerId: modelProvider,
      modelId,
      toolName: "remote_write_file",
      arguments: {
        path: "local-after-import.txt",
        content: "local Pi work continued after offline import\n",
      },
      answer:
        "Unrelated local Pi work remained usable after import and reopen.",
    });
    let importsEnabled = true;
    const configuredCatalogs: Record<string, string> = {};
    const configuredDestinations: Record<string, string> = {};
    const local = await scenario({
      models: localModel.models,
      modelProvider,
      modelId,
      directoryPrefix: "uzina-cloud-offline-import-consumer-",
      managedWorkImportEnabled: () => importsEnabled,
      managedWorkImportPaths: (directory) => {
        Object.assign(configuredCatalogs, {
          "catalog:cloud-offline": join(directory, "offline-catalog"),
        });
        Object.assign(configuredDestinations, {
          "destination:cloud-offline": join(
            directory,
            "prepared-import",
            "cloud-source",
          ),
          "destination:receipt-cap-proof": join(
            directory,
            "prepared-import",
            "receipt-cap-proof",
          ),
          "destination:workspace-output-mutation": join(
            directory,
            "prepared-import",
            "workspace-output-mutation",
          ),
          "destination:runtime-output-mutation": join(
            directory,
            "prepared-import",
            "runtime-output-mutation",
          ),
          "destination:receipt-mutation": join(
            directory,
            "prepared-import",
            "receipt-mutation",
          ),
          "destination:catalog-corruption": join(
            directory,
            "prepared-import",
            "catalog-corruption",
          ),
        });
        return {
          catalogs: configuredCatalogs,
          destinations: configuredDestinations,
        };
      },
    });
    const catalogPath = join(local.directory, "offline-catalog");
    const destinationPath = join(
      local.directory,
      "prepared-import",
      "cloud-source",
    );
    const offlineTransport = new FileBlobTransport(catalogPath);
    const invitation = await call<{ code: string }>(
      local.baseUrl,
      "/v1/invitations",
      {
        credential: local.owner,
        body: {
          role: "viewer",
          grants: [],
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    );
    expect(invitation.status).toBe(201);
    const viewer = await call<{ credential: string }>(
      local.baseUrl,
      "/v1/invitations/redeem",
      { body: { code: invitation.value.code, displayName: "Local viewer" } },
    );
    expect(viewer.status).toBe(201);
    expect(local.owner).not.toBe(cloudOwner);
    expect(local.nodeCredential).not.toBe(sourceNode.value.credential);
    expect(localModel.requests()).toBe(0);

    const sourceThreadId = "thread:cloud-producer";
    const sourceThread = await call<{ threadId: string }>(
      sourceBaseUrl,
      "/v1/threads",
      {
        credential: cloudOwner,
        body: {
          threadId: sourceThreadId,
          projectId: sourceProject.value.projectId,
          title: "Quiescent offline source",
          target: {
            nodeId: sourceNode.value.node.nodeId,
            workspaceId: sourceWorkspaceRecord.value.workspaceId,
          },
        },
      },
    );
    expect(sourceThread.status).toBe(201);
    const sourceRequestId = "request:cloud-producer-settled-effect";
    const sourceEffectPath = "source-effect.txt";
    const sourceEffectContent = "settled cloud source effect\n";
    expect(
      (
        await call(sourceBaseUrl, "/__test/model-tool-call", {
          body: {
            id: "call:cloud-producer-settled-effect",
            path: sourceEffectPath,
            content: sourceEffectContent,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(sourceBaseUrl, `/v1/threads/${sourceThreadId}/inputs`, {
          credential: cloudOwner,
          body: {
            requestId: sourceRequestId,
            text: "Use the managed workspace tool to write the settled source file.",
          },
        })
      ).status,
    ).toBe(202);
    await until(async () => {
      const receipt = await call<{
        dispatchStatus: string;
        executionEffects?: Array<{ status: string }>;
      }>(sourceBaseUrl, `/v1/commands/${sourceRequestId}`, {
        credential: cloudOwner,
      });
      return (
        receipt.value.dispatchStatus === "completed" &&
        receipt.value.executionEffects?.some(
          (effect) => effect.status === "completed",
        ) === true
      );
    });
    const sourceStorage = await readPublicStorageObservation(
      sourceBaseUrl,
      sourceThreadId,
    );
    const sourceWorkspaceEvidence = await gitWorkspaceEvidence(sourceWorkspace);
    expect(sourceWorkspaceEvidence.sourceEffect).toBe(sourceEffectContent);
    expect(sourceWorkspaceEvidence.status).toContain("tracked.txt");
    expect(sourceWorkspaceEvidence.status).toContain("binary");
    expect(sourceWorkspaceEvidence.status).toContain(sourceEffectPath);
    expect(sourceWorkspaceEvidence.stagedDiff).toContain("staged source");
    expect(sourceWorkspaceEvidence.workingDiff).toContain("working source");
    expect(sourceWorkspaceEvidence.binaryMode & 0o111).toBe(0o111);

    const captureRequestId = "capture:cloud-producer-offline";
    const captureAdmission = await call<{ captureId: string }>(
      sourceBaseUrl,
      `/v1/threads/${sourceThreadId}/capture-controls`,
      {
        credential: cloudOwner,
        body: {
          contractVersion: CONTRACT_VERSION,
          requestId: captureRequestId,
        },
      },
    );
    expect(captureAdmission.status).toBe(202);
    await until(async () => {
      const status = await call<{ status: string }>(
        sourceBaseUrl,
        `/v1/capture-controls/${captureRequestId}`,
        { credential: cloudOwner },
      );
      return status.value.status === "source-capture-fenced";
    });
    const captureStatus = await call<Record<string, unknown>>(
      sourceBaseUrl,
      `/v1/capture-controls/${captureRequestId}`,
      { credential: cloudOwner },
    );
    expect(captureStatus.value).toMatchObject({
      status: "source-capture-fenced",
      captureId: captureAdmission.value.captureId,
      ownershipGeneration: 0,
    });

    const snapshotRequestId = "snapshot:cloud-producer-offline";
    expect(
      (
        await call(sourceBaseUrl, "/v1/workspace-snapshots", {
          credential: cloudOwner,
          body: {
            contractVersion: CONTRACT_VERSION,
            requestId: snapshotRequestId,
            captureRequestId,
          },
        })
      ).status,
    ).toBe(202);
    await until(async () => {
      const status = await call<{ status: string }>(
        sourceBaseUrl,
        `/v1/workspace-snapshots/${snapshotRequestId}`,
        { credential: cloudOwner },
      );
      return status.value.status === "workspace-checkpoint-available";
    });
    const snapshotStatus = await call<{
      status: string;
      manifestReference: string;
      snapshotId: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(sourceBaseUrl, `/v1/workspace-snapshots/${snapshotRequestId}`, {
      credential: cloudOwner,
    });
    expect(snapshotStatus.value).toMatchObject({
      status: "workspace-checkpoint-available",
      target: { nodeId: sourceNodeId, workspaceId: sourceWorkspaceId },
      ownershipGeneration: 0,
    });

    const checkpointRequestId = "checkpoint:cloud-producer-offline";
    expect(
      (
        await call(
          sourceBaseUrl,
          `/v1/threads/${sourceThreadId}/managed-work-checkpoints`,
          {
            credential: cloudOwner,
            body: {
              contractVersion: CONTRACT_VERSION,
              requestId: checkpointRequestId,
              captureRequestId,
              workspaceSnapshotRequestId: snapshotRequestId,
            },
          },
        )
      ).status,
    ).toBe(202);
    await until(async () => {
      const status = await call<{ status: string; stage: string }>(
        sourceBaseUrl,
        `/v1/managed-work-checkpoints/${checkpointRequestId}`,
        { credential: cloudOwner },
      );
      if (["blocked", "uncertain"].includes(status.value.status)) {
        throw new Error(JSON.stringify(status.value));
      }
      return (
        status.value.status === "available" &&
        status.value.stage === "available"
      );
    });
    const checkpointStatus = await call<{
      status: string;
      stage: string;
      manifestReference: string;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(sourceBaseUrl, `/v1/managed-work-checkpoints/${checkpointRequestId}`, {
      credential: cloudOwner,
    });
    expect(checkpointStatus.value).toMatchObject({
      status: "available",
      stage: "available",
      target: { nodeId: sourceNodeId, workspaceId: sourceWorkspaceId },
      ownershipGeneration: 0,
    });
    expect(
      await readPublicStorageObservation(sourceBaseUrl, sourceThreadId),
    ).toEqual(sourceStorage);
    expect(
      await call(
        sourceBaseUrl,
        `/v1/managed-work-checkpoints/${checkpointRequestId}`,
        {
          credential: local.owner,
        },
      ),
    ).toMatchObject({ status: 401 });
    const nodePrivateBlob = await fetch(
      new URL(
        `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${checkpointStatus.value.manifestReference}`,
        sourceBaseUrl,
      ),
      { headers: { authorization: `Bearer ${sourceNode.value.credential}` } },
    );
    expect(nodePrivateBlob.status).toBe(403);
    await nodePrivateBlob.body?.cancel();

    const destinationNodeId = "node:hold-relocation-refusal";
    const destinationWorkspaceId = "workspace:hold-relocation-refusal";
    const destinationNode = await call<{
      node: { nodeId: string };
      credential: string;
    }>(sourceBaseUrl, "/v1/nodes", {
      credential: cloudOwner,
      body: { nodeId: destinationNodeId, name: "Unassigned refusal target" },
    });
    expect(destinationNode.status).toBe(201);
    const destinationWorkspace = await call<{ workspaceId: string }>(
      sourceBaseUrl,
      "/v1/workspaces",
      {
        credential: cloudOwner,
        body: {
          workspaceId: destinationWorkspaceId,
          nodeId: destinationNodeId,
          name: "Unassigned refusal workspace",
        },
      },
    );
    expect(destinationWorkspace.status).toBe(201);
    const unrelatedCloudWorkspace = join(
      sourceDirectory,
      "unrelated-cloud-workspace",
    );
    await makeDirtyGitWorkspace(unrelatedCloudWorkspace);

    sourceAbort?.abort();
    await sourceLoop;
    sourceAbort = undefined;
    sourceLoop = undefined;

    const admissionOwnerCredential = await call<{
      credentialId: string;
      credential: string;
      actor: unknown;
    }>(sourceBaseUrl, "/v1/credentials", {
      credential: cloudOwner,
      body: { kind: "human", name: "Revoked during hold admission" },
    });
    expect(admissionOwnerCredential.status).toBe(201);
    const holdPath = `/v1/threads/${sourceThreadId}/managed-work-transfer-holds`;
    const revokedAdmissionRequest = {
      contractVersion: CONTRACT_VERSION,
      requestId: "hold:revoked-during-capture-state-read",
      captureRequestId,
      checkpointRequestId,
    };
    const revokedAdmissionGate = captureStateBarrier.arm({
      kind: "managed-work-transfer-hold",
      requestId: revokedAdmissionRequest.requestId,
      threadId: sourceThreadId,
    });
    const pendingRevokedAdmission = trackedJsonPost<{
      error?: string;
    }>(
      sourceBaseUrl,
      holdPath,
      admissionOwnerCredential.value.credential,
      revokedAdmissionRequest,
    );
    await waitForCaptureStateBarrier(
      revokedAdmissionGate.entered,
      "hold capture-state read before credential revocation",
    );
    expect(
      await call(
        sourceBaseUrl,
        `/v1/credentials/${admissionOwnerCredential.value.credentialId}/revoke`,
        { credential: cloudOwner, body: {} },
      ),
    ).toMatchObject({ status: 200, value: { status: "revoked" } });
    revokedAdmissionGate.release();
    expect(await pendingRevokedAdmission).toMatchObject({ status: 401 });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/managed-work-transfer-holds/${revokedAdmissionRequest.requestId}`,
        { credential: cloudOwner },
      ),
    ).toMatchObject({ status: 404 });

    const holdRequests = [
      {
        contractVersion: CONTRACT_VERSION,
        requestId: "hold:cloud-producer-source-a",
        captureRequestId,
        checkpointRequestId,
      },
      {
        contractVersion: CONTRACT_VERSION,
        requestId: "hold:cloud-producer-source-b",
        captureRequestId,
        checkpointRequestId,
      },
    ] as const;
    const relocationRequestId = "relocation:delayed-by-source-hold";
    const relocationGate = captureStateBarrier.arm({
      kind: "workspace-relocation",
      requestId: relocationRequestId,
      threadId: sourceThreadId,
    });
    const pendingRelocation = trackedJsonPost<{ error?: string }>(
      sourceBaseUrl,
      `/v1/threads/${sourceThreadId}/workspace-relocations`,
      cloudOwner,
      {
        contractVersion: CONTRACT_VERSION,
        requestId: relocationRequestId,
        checkpointRequestId,
        destination: {
          nodeId: destinationNodeId,
          workspaceId: destinationWorkspaceId,
        },
      },
    );
    await waitForCaptureStateBarrier(
      relocationGate.entered,
      "relocation capture-state read before source hold admission",
    );
    const discardedHoldPostStatuses = await Promise.all(
      holdRequests.map((request) =>
        trackedDiscardPost(sourceBaseUrl, holdPath, cloudOwner, request),
      ),
    );
    expect(discardedHoldPostStatuses.sort()).toEqual([202, 409]);
    const holdLookups = await Promise.all(
      holdRequests.map(async (request) => ({
        request,
        response: await call<ManagedWorkTransferHoldStatus | { error: string }>(
          sourceBaseUrl,
          `/v1/managed-work-transfer-holds/${request.requestId}`,
          { credential: cloudOwner },
        ),
      })),
    );
    const admittedHold = holdLookups.filter(
      ({ response }) => response.status === 200,
    );
    const absentHold = holdLookups.filter(
      ({ response }) => response.status === 404,
    );
    expect(admittedHold).toHaveLength(1);
    expect(absentHold).toHaveLength(1);
    const holdRequest = admittedHold[0]!.request;
    const holdStatus = admittedHold[0]!.response
      .value as ManagedWorkTransferHoldStatus;
    expect(holdStatus).toMatchObject({
      contractVersion: CONTRACT_VERSION,
      requestId: holdRequest.requestId,
      actor: { kind: "human" },
      captureRequestId,
      checkpointRequestId,
      workspaceSnapshotRequestId: snapshotRequestId,
      captureId: captureAdmission.value.captureId,
      snapshotId: snapshotStatus.value.snapshotId,
      projectId: sourceProjectId,
      threadId: sourceThreadId,
      source: { nodeId: sourceNodeId, workspaceId: sourceWorkspaceId },
      ownershipGeneration: 0,
      controlId: captureStatus.value.controlId,
      sourceFence: captureStatus.value.sourceFence,
      workspaceManifestReference: snapshotStatus.value.manifestReference,
      coherentCheckpointManifestReference:
        checkpointStatus.value.manifestReference,
      status: "held-awaiting-local-preparation",
    });
    expect(holdStatus.sourceCaptureReportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(holdStatus.controlPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(holdStatus.workspaceSnapshotReportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(holdStatus.bindingSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(holdStatus.acceptedAt)).not.toBeNaN();
    expect(admissionOwnerCredential.value.actor).toEqual(holdStatus.actor);
    relocationGate.release();
    expect(await pendingRelocation).toMatchObject({
      status: 409,
      value: { error: "workspace_relocation_transfer_hold_conflict" },
    });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/workspace-relocations/${relocationRequestId}`,
        { credential: cloudOwner },
      ),
    ).toMatchObject({ status: 404 });
    const idempotentHoldRetry = await call<ManagedWorkTransferHoldStatus>(
      sourceBaseUrl,
      holdPath,
      { credential: cloudOwner, body: holdRequest },
    );
    expect(idempotentHoldRetry.status).toBe(202);
    expect(idempotentHoldRetry.value).toEqual(holdStatus);
    const secondaryOwnerCredential = await call<{
      credentialId: string;
      credential: string;
      actor: unknown;
    }>(sourceBaseUrl, "/v1/credentials", {
      credential: cloudOwner,
      body: { kind: "human", name: "Second source Owner credential" },
    });
    expect(secondaryOwnerCredential.status).toBe(201);
    expect(secondaryOwnerCredential.value.actor).toEqual(holdStatus.actor);
    expect(
      await call<ManagedWorkTransferHoldStatus>(sourceBaseUrl, holdPath, {
        credential: secondaryOwnerCredential.value.credential,
        body: holdRequest,
      }),
    ).toMatchObject({ status: 202, value: holdStatus });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/credentials/${secondaryOwnerCredential.value.credentialId}/revoke`,
        {
          credential: cloudOwner,
          body: {},
        },
      ),
    ).toMatchObject({ status: 200, value: { status: "revoked" } });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/managed-work-transfer-holds/${holdRequest.requestId}`,
        { credential: secondaryOwnerCredential.value.credential },
      ),
    ).toMatchObject({ status: 401 });
    expect(
      await call<ManagedWorkTransferHoldStatus>(sourceBaseUrl, holdPath, {
        credential: cloudOwner,
        body: holdRequest,
      }),
    ).toMatchObject({ status: 202, value: holdStatus });
    const changedCaptureHold = await call<{ error: string }>(
      sourceBaseUrl,
      holdPath,
      {
        credential: cloudOwner,
        body: {
          ...holdRequest,
          captureRequestId: "capture:changed-under-hold",
        },
      },
    );
    expect(changedCaptureHold).toMatchObject({
      status: 409,
      value: { error: "managed_work_transfer_hold_request_conflict" },
    });
    const changedCheckpointHold = await call<{ error: string }>(
      sourceBaseUrl,
      holdPath,
      {
        credential: cloudOwner,
        body: {
          ...holdRequest,
          checkpointRequestId: "checkpoint:changed-under-hold",
        },
      },
    );
    expect(changedCheckpointHold).toMatchObject({
      status: 409,
      value: { error: "managed_work_transfer_hold_request_conflict" },
    });
    const changedThreadHold = await call<{ error: string }>(
      sourceBaseUrl,
      "/v1/threads/thread:changed-under-hold/managed-work-transfer-holds",
      { credential: cloudOwner, body: holdRequest },
    );
    expect(changedThreadHold).toMatchObject({
      status: 409,
      value: { error: "managed_work_transfer_hold_request_conflict" },
    });
    const competingHold = await call<{ error: string }>(
      sourceBaseUrl,
      holdPath,
      {
        credential: cloudOwner,
        body: {
          ...holdRequest,
          requestId: "hold:cloud-producer-competing-source",
        },
      },
    );
    expect(competingHold).toMatchObject({
      status: 409,
      value: { error: "managed_work_transfer_hold_source_already_reserved" },
    });

    const sourceViewerInvitation = await call<{ code: string }>(
      sourceBaseUrl,
      "/v1/invitations",
      {
        credential: cloudOwner,
        body: {
          role: "viewer",
          grants: [],
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    );
    expect(sourceViewerInvitation.status).toBe(201);
    const sourceViewer = await call<{ credential: string }>(
      sourceBaseUrl,
      "/v1/invitations/redeem",
      {
        body: {
          code: sourceViewerInvitation.value.code,
          displayName: "Source viewer",
        },
      },
    );
    expect(sourceViewer.status).toBe(201);
    expect(
      await call(sourceBaseUrl, holdPath, {
        credential: sourceViewer.value.credential,
        body: holdRequest,
      }),
    ).toMatchObject({ status: 403 });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/managed-work-transfer-holds/${holdRequest.requestId}`,
        { credential: sourceViewer.value.credential },
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/managed-work-transfer-holds/${holdRequest.requestId}`,
        { credential: sourceNode.value.credential },
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/managed-work-transfer-holds/${holdRequest.requestId}`,
        { credential: local.owner },
      ),
    ).toMatchObject({ status: 401 });

    const heldManifestBlob = await fetch(
      new URL(
        `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${checkpointStatus.value.manifestReference}`,
        sourceBaseUrl,
      ),
      { headers: { authorization: `Bearer ${cloudOwner}` } },
    );
    expect(heldManifestBlob.status).toBe(200);
    expect(heldManifestBlob.headers.get("x-content-sha256")).toBe(
      checkpointStatus.value.manifestReference,
    );
    expect(sha256(new Uint8Array(await heldManifestBlob.arrayBuffer()))).toBe(
      checkpointStatus.value.manifestReference,
    );

    const heldRelocation = await call<{ error: string }>(
      sourceBaseUrl,
      `/v1/threads/${sourceThreadId}/workspace-relocations`,
      {
        credential: cloudOwner,
        body: {
          contractVersion: CONTRACT_VERSION,
          requestId: "relocation:refused-by-transfer-hold",
          checkpointRequestId,
          destination: {
            nodeId: destinationNodeId,
            workspaceId: destinationWorkspaceId,
          },
        },
      },
    );
    expect(heldRelocation).toMatchObject({
      status: 409,
      value: { error: "workspace_relocation_transfer_hold_conflict" },
    });

    const unrelatedThreadId = "thread:unrelated-cloud-progress";
    expect(
      await call(sourceBaseUrl, "/v1/threads", {
        credential: cloudOwner,
        body: {
          threadId: unrelatedThreadId,
          projectId: sourceProjectId,
          title: "Unrelated cloud work during source hold",
          target: {
            nodeId: destinationNodeId,
            workspaceId: destinationWorkspaceId,
          },
        },
      }),
    ).toMatchObject({ status: 201 });
    const unrelatedCloudDatabasePath = join(
      sourceDirectory,
      "unrelated-cloud-executor.sqlite",
    );
    unrelatedCloudDaemon = new ExecutionDaemon({
      databasePath: unrelatedCloudDatabasePath,
      nodeId: destinationNodeId,
      nodeCredential: destinationNode.value.credential,
      workspaces: [
        {
          workspaceId: destinationWorkspaceId,
          directory: unrelatedCloudWorkspace,
        },
      ],
      daemonVersion: "unrelated-cloud-hold-progress-test",
    });
    unrelatedCloudAbort = new AbortController();
    unrelatedCloudLoop = new ExecutionLoop({
      daemon: unrelatedCloudDaemon,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: sourceBaseUrl,
        nodeId: destinationNodeId,
        credential: destinationNode.value.credential,
      }),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 100,
    }).run(unrelatedCloudAbort.signal);
    await until(async () => {
      const nodes = await call<{
        nodes: Array<{ nodeId: string; availability: string }>;
      }>(sourceBaseUrl, "/v1/nodes", { credential: cloudOwner });
      return nodes.value.nodes.some(
        (node) =>
          node.nodeId === destinationNodeId && node.availability === "online",
      );
    });
    const unrelatedEffectPath = "unrelated-cloud-progress.txt";
    const unrelatedEffectContent = "unrelated CLOUD execution continued\n";
    expect(
      (
        await call(sourceBaseUrl, "/__test/model-tool-call", {
          body: {
            id: "call:unrelated-cloud-progress",
            path: unrelatedEffectPath,
            content: unrelatedEffectContent,
          },
        })
      ).status,
    ).toBe(200);
    const unrelatedInput = await call(
      sourceBaseUrl,
      `/v1/threads/${unrelatedThreadId}/inputs`,
      {
        credential: cloudOwner,
        body: {
          requestId: "request:unrelated-cloud-progress",
          text: "Write the unrelated cloud progress file.",
        },
      },
    );
    expect(unrelatedInput.status).toBe(202);
    await until(async () => {
      const receipt = await call<{
        dispatchStatus: string;
        executionEffects?: Array<{
          status: string;
          target?: { nodeId: string };
        }>;
      }>(sourceBaseUrl, "/v1/commands/request:unrelated-cloud-progress", {
        credential: cloudOwner,
      });
      return (
        receipt.value.dispatchStatus === "completed" &&
        receipt.value.executionEffects?.some(
          (effect) =>
            effect.status === "completed" &&
            effect.target?.nodeId === destinationNodeId,
        ) === true
      );
    });
    await expect(
      waitForFile(join(unrelatedCloudWorkspace, unrelatedEffectPath)),
    ).resolves.toBe(unrelatedEffectContent);
    unrelatedCloudAbort.abort();
    await unrelatedCloudLoop;
    unrelatedCloudDaemon.close();
    unrelatedCloudAbort = undefined;
    unrelatedCloudLoop = undefined;
    unrelatedCloudDaemon = undefined;
    expect(
      await readPublicStorageObservation(sourceBaseUrl, sourceThreadId),
    ).toEqual(sourceStorage);
    expect(
      await call<ManagedWorkTransferHoldStatus>(
        sourceBaseUrl,
        `/v1/managed-work-transfer-holds/${holdRequest.requestId}`,
        { credential: cloudOwner },
      ),
    ).toMatchObject({ status: 200, value: holdStatus });

    const blockedSourceInput = await call<{ error: string }>(
      sourceBaseUrl,
      `/v1/threads/${sourceThreadId}/inputs`,
      {
        credential: cloudOwner,
        body: {
          requestId: "request:blocked-by-transfer-hold",
          text: "A held source must not accept new work.",
        },
      },
    );
    expect(blockedSourceInput).toMatchObject({
      status: 409,
      value: { error: "managed_work_capture_active" },
    });
    const heldSourceWrite = join(sourceWorkspace, "held-source-write.txt");
    await expect(
      sourceDaemon!.executeJob({
        contractVersion: 1,
        jobId: "job:blocked-by-transfer-hold",
        nodeId: sourceNodeId,
        target: { nodeId: sourceNodeId, workspaceId: sourceWorkspaceId },
        ownershipGeneration: 0,
        operation: "write-file",
        path: "held-source-write.txt",
        contentBase64: Buffer.from("must not be written").toString("base64"),
      }),
    ).rejects.toThrow("workspace_capture_active");
    await expect(lstat(heldSourceWrite)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const holdCaptureStatus = await call<Record<string, unknown>>(
      sourceBaseUrl,
      `/v1/capture-controls/${captureRequestId}`,
      { credential: cloudOwner },
    );
    expect(holdCaptureStatus.value).toEqual(captureStatus.value);
    const holdSnapshotStatus = await call<Record<string, unknown>>(
      sourceBaseUrl,
      `/v1/workspace-snapshots/${snapshotRequestId}`,
      { credential: cloudOwner },
    );
    expect(holdSnapshotStatus.value).toEqual(snapshotStatus.value);
    const holdCheckpointStatus = await call<Record<string, unknown>>(
      sourceBaseUrl,
      `/v1/managed-work-checkpoints/${checkpointRequestId}`,
      { credential: cloudOwner },
    );
    expect(holdCheckpointStatus.value).toEqual(checkpointStatus.value);
    expect(
      await readPublicStorageObservation(sourceBaseUrl, sourceThreadId),
    ).toEqual(sourceStorage);

    await sourceLoop;
    sourceDaemon?.close();
    sourceAbort = undefined;
    sourceLoop = undefined;
    sourceDaemon = undefined;
    await miniflare.dispose();
    miniflare = createSourceMiniflare();
    sourceBaseUrl = (await miniflare.ready).toString();
    sourceDaemon = new ExecutionDaemon({
      databasePath: sourceDaemonDatabasePath,
      nodeId: sourceNodeId,
      nodeCredential: sourceNode.value.credential,
      workspaces: [
        { workspaceId: sourceWorkspaceId, directory: sourceWorkspace },
      ],
      daemonVersion: "cloud-producer-c1-test",
    });
    sourceAbort = new AbortController();
    sourceLoop = new ExecutionLoop({
      daemon: sourceDaemon,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: sourceBaseUrl,
        nodeId: sourceNodeId,
        credential: sourceNode.value.credential,
      }),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 100,
    }).run(sourceAbort.signal);
    await until(async () => {
      const nodes = await call<{
        nodes: Array<{ nodeId: string; availability: string }>;
      }>(sourceBaseUrl, "/v1/nodes", { credential: cloudOwner });
      return nodes.value.nodes.some(
        (node) =>
          node.nodeId === sourceNodeId && node.availability === "online",
      );
    });
    expect(
      (
        await call<ManagedWorkTransferHoldStatus>(
          sourceBaseUrl,
          `/v1/managed-work-transfer-holds/${holdRequest.requestId}`,
          { credential: cloudOwner },
        )
      ).value,
    ).toEqual(holdStatus);
    expect(
      (
        await call<Record<string, unknown>>(
          sourceBaseUrl,
          `/v1/capture-controls/${captureRequestId}`,
          { credential: cloudOwner },
        )
      ).value,
    ).toEqual(captureStatus.value);
    const postRestartInput = await call<{ error: string }>(
      sourceBaseUrl,
      `/v1/threads/${sourceThreadId}/inputs`,
      {
        credential: cloudOwner,
        body: {
          requestId: "request:blocked-after-workerd-restart",
          text: "Cold source capture remains blocked after restart.",
        },
      },
    );
    expect(postRestartInput).toMatchObject({
      status: 409,
      value: { error: "managed_work_capture_active" },
    });
    for (const path of [
      `/v1/threads/${sourceThreadId}/context`,
      `/v1/threads/${sourceThreadId}/status`,
    ]) {
      const response = await fetch(new URL(path, sourceBaseUrl), {
        headers: { authorization: `Bearer ${cloudOwner}` },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.body?.cancel();
    }
    const managedWorkTest = <T>(operation: Record<string, unknown>) =>
      call<T>(sourceBaseUrl, "/__test/managed-work", {
        body: { threadId: sourceThreadId, operation },
      });
    const coldOpenObservation = await managedWorkTest<{
      modelCalls: number;
      alarmCalls: number;
    }>({ kind: "observe" });
    expect(coldOpenObservation.value.modelCalls).toBe(0);
    const coldOpenRefusals = await managedWorkTest<Record<string, string>>({
      kind: "refusals",
    });
    expect(coldOpenRefusals.value).toMatchObject({
      acceptManagedInput: expect.stringContaining("active capture lock"),
      submit: expect.stringContaining("active capture lock"),
      context: expect.stringContaining("active capture lock"),
      status: expect.stringContaining("active capture lock"),
      resume: expect.stringContaining("active capture lock"),
    });
    expect(
      await managedWorkTest<null>({
        kind: "schedule-alarm",
        at: Date.now() + 20,
      }),
    ).toMatchObject({ status: 200 });
    await until(async () => {
      const observation = await managedWorkTest<{
        modelCalls: number;
        alarmCalls: number;
      }>({ kind: "observe" });
      const pendingAlarm = await managedWorkTest<number | null>({
        kind: "pending-alarm",
      });
      return (
        observation.value.alarmCalls > coldOpenObservation.value.alarmCalls &&
        pendingAlarm.value === null
      );
    });
    expect(
      (
        await managedWorkTest<{ modelCalls: number; alarmCalls: number }>({
          kind: "observe",
        })
      ).value,
    ).toMatchObject({ modelCalls: 0 });
    await expect(
      sourceDaemon!.executeJob({
        contractVersion: 1,
        jobId: "job:blocked-after-workerd-restart",
        nodeId: sourceNodeId,
        target: { nodeId: sourceNodeId, workspaceId: sourceWorkspaceId },
        ownershipGeneration: 0,
        operation: "write-file",
        path: "held-source-write-after-restart.txt",
        contentBase64: Buffer.from("must not be written").toString("base64"),
      }),
    ).rejects.toThrow("workspace_capture_active");
    await expect(
      lstat(join(sourceWorkspace, "held-source-write-after-restart.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const nativeDaemonEvidence = new Database(sourceDaemonDatabasePath, {
      readonly: true,
    });
    try {
      expect(
        nativeDaemonEvidence
          .query<
            {
              control_id: string;
              capture_id: string;
              request_id: string;
              workspace_id: string;
              status: string;
            },
            [string]
          >(
            `SELECT control_id, capture_id, request_id, workspace_id, status
             FROM execution_capture_controls WHERE control_id = ?`,
          )
          .get(captureStatus.value.controlId as string),
      ).toMatchObject({
        control_id: captureStatus.value.controlId,
        capture_id: captureAdmission.value.captureId,
        request_id: captureRequestId,
        workspace_id: sourceWorkspaceId,
        status: "source-capture-fenced",
      });
      expect(
        nativeDaemonEvidence
          .query<{ capture_id: string; control_id: string }, [string]>(
            `SELECT capture_id, control_id FROM execution_workspace_captures
             WHERE workspace_id = ?`,
          )
          .get(sourceWorkspaceId),
      ).toEqual({
        capture_id: captureAdmission.value.captureId,
        control_id: captureStatus.value.controlId as string,
      });
    } finally {
      nativeDaemonEvidence.close();
    }

    const downloads = new Map<string, Uint8Array>();
    const downloadSourceBlob = async (reference: string, size?: number) => {
      const response = await fetch(
        new URL(
          `/v1/managed-work-checkpoints/${checkpointRequestId}/blobs/${reference}`,
          sourceBaseUrl,
        ),
        { headers: { authorization: `Bearer ${cloudOwner}` } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("x-content-sha256")).toBe(reference);
      expect(response.headers.get("x-uzina-evidence-authority")).toBeNull();
      const declaredSize = Number(response.headers.get("content-length"));
      expect(Number.isSafeInteger(declaredSize)).toBe(true);
      expect(declaredSize).toBeGreaterThan(0);
      expect(declaredSize).toBeLessThanOrEqual(512 * 1024 * 1024);
      if (size !== undefined) expect(declaredSize).toBe(size);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(declaredSize);
      expect(sha256(bytes)).toBe(reference);
      expect(await offlineTransport.putBlob(bytes)).toBe(reference);
      downloads.set(reference, bytes);
      return bytes;
    };
    const manifestReference = checkpointStatus.value.manifestReference;
    const outerBytes = await downloadSourceBlob(manifestReference);
    expect(outerBytes.byteLength).toBeLessThanOrEqual(
      WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
    );
    const outerManifest = parseManagedWorkBundleManifestBytes(
      outerBytes,
      manifestReference,
    );
    const innerBytes = await downloadSourceBlob(
      outerManifest.workspaceManifestReference,
    );
    expect(innerBytes.byteLength).toBeLessThanOrEqual(
      WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
    );
    const sourceWorkspaceBytes = await downloadSourceBlob(
      snapshotStatus.value.manifestReference,
    );
    const sourceWorkspaceManifest = JSON.parse(
      Buffer.from(sourceWorkspaceBytes).toString("utf8"),
    ) as unknown;
    const workspaceReferences = portableWorkspaceBlobReferences(
      sourceWorkspaceManifest,
      snapshotStatus.value.manifestReference,
      sourceWorkspaceBytes.byteLength,
    );
    const runtimeArtifact = outerManifest.workspace.runtimeArtifact;
    if (!runtimeArtifact)
      throw new Error("The cloud bundle has no runtime artifact");
    const runtimeBytes = await downloadSourceBlob(
      runtimeArtifact.artifact.reference,
      runtimeArtifact.artifact.size,
    );
    for (const reference of workspaceReferences) {
      if (!downloads.has(reference.reference)) {
        await downloadSourceBlob(reference.reference, reference.size);
      }
    }
    const attachments = new Map<string, Uint8Array>();
    for (const attachment of outerManifest.workspace.attachments) {
      attachments.set(
        attachment.name,
        await downloadSourceBlob(
          attachment.blob.reference,
          attachment.blob.size,
        ),
      );
    }
    const expectedRuntimeRequirements = [
      ...MANAGED_WORK_RUNTIME_REQUIREMENTS,
      `model:${modelProvider}/${modelId}`,
      ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
    ];
    expect(outerManifest.runtime.requirements).toEqual(
      expectedRuntimeRequirements,
    );
    const verifiedMetadata = await verifyManagedWorkBundleMetadata({
      manifestBytes: outerBytes,
      manifestReference,
      sourceWorkspaceManifestBytes: sourceWorkspaceBytes,
      sourceWorkspaceManifestReference: snapshotStatus.value.manifestReference,
      innerWorkspaceManifestBytes: innerBytes,
      expectedRuntimeRequirements,
      runtimeArtifactBytes: runtimeBytes,
    });
    const exactClosure = new Set([
      ...verifiedMetadata.sourceWorkspaceReferences.map(
        ({ reference }) => reference,
      ),
      ...verifiedMetadata.privateArtifacts.map(({ reference }) => reference),
    ]);
    expect([...downloads.keys()].sort()).toEqual([...exactClosure].sort());
    for (const reference of exactClosure) {
      expect(sha256(await offlineTransport.getBlob(reference))).toBe(reference);
    }
    const offlineBundle = await validateManagedWorkBundle(
      manifestReference,
      offlineTransport,
      {
        supportedRuntimeRequirements: [
          `model:${modelProvider}/${modelId}`,
          ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
        ],
      },
    );
    expect(offlineBundle.manifest).toEqual(outerManifest);
    const sourceProjection = {
      conversations: sourceStorage.conversations,
      entries: sourceStorage.entries,
      tasks: sourceStorage.tasks,
      submissions: sourceStorage.submissions,
      documents: sourceStorage.documents,
    };
    expect({
      conversations: offlineBundle.managedWork.conversations,
      entries: offlineBundle.managedWork.entries,
      tasks: offlineBundle.managedWork.tasks,
      submissions: offlineBundle.managedWork.submissions,
      documents: offlineBundle.managedWork.documents,
    }).toEqual(sourceProjection);

    const importRequest = {
      contractVersion: CONTRACT_VERSION,
      requestId: "import:cloud-producer-offline-consumer",
      sourceCatalogId: "catalog:cloud-offline",
      manifestSha256: manifestReference,
      destinationId: "destination:cloud-offline",
    };
    expect(localModel.requests()).toBe(0);
    expect(
      await call(local.baseUrl, "/v1/managed-work-imports", {
        credential: cloudOwner,
        body: importRequest,
      }),
    ).toMatchObject({ status: 401 });
    expect(
      await call(local.baseUrl, "/v1/managed-work-imports", {
        credential: local.nodeCredential,
        body: importRequest,
      }),
    ).toMatchObject({ status: 403 });
    expect(
      await call(local.baseUrl, "/v1/managed-work-imports", {
        credential: viewer.value.credential,
        body: importRequest,
      }),
    ).toMatchObject({ status: 403 });
    expect(
      await call(
        local.baseUrl,
        `/v1/managed-work-imports/${importRequest.requestId}`,
        {
          credential: viewer.value.credential,
        },
      ),
    ).toMatchObject({ status: 403 });
    const localCountsBeforeImport = localCoreSurfaceCounts(local.host);
    const first = await call<ManagedWorkImportStatus>(
      local.baseUrl,
      "/v1/managed-work-imports",
      {
        credential: local.owner,
        body: importRequest,
      },
    );
    expect(first.status).toBe(202);
    expect(first.value.status).toBe("prepared-inactive");
    expect(first.value.preparationReceipt?.status).toBe("prepared-inactive");
    expect(first.value.preparationReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(localModel.requests()).toBe(0);

    const rawRuntimePath = join(destinationPath, "managed-work.sqlite");
    const rawImported = await readRawImportedCheckpoint(rawRuntimePath);
    const importedProjection = {
      conversations: rawImported.conversations,
      entries: rawImported.entries,
      tasks: rawImported.tasks,
      submissions: rawImported.submissions,
      documents: rawImported.documents,
    };
    expect(importedProjection).toEqual(sourceProjection);
    expect(
      rawImported.submissions.some(
        ({ requestId }) => requestId === sourceRequestId,
      ),
    ).toBe(true);
    expect(
      await gitWorkspaceEvidence(join(destinationPath, "workspace")),
    ).toEqual(sourceWorkspaceEvidence);
    const provenanceBytes = await readFile(
      join(destinationPath, ".uzina", "attachments", "factory-provenance.json"),
    );
    const provenance = factoryProvenanceEvidenceSchema.parse(
      JSON.parse(provenanceBytes.toString("utf8")),
    );
    expect(provenance).toMatchObject({
      checkpointRequestId,
      threadId: sourceThreadId,
      projectId: sourceProjectId,
      capture: {
        requestId: captureRequestId,
        captureId: captureAdmission.value.captureId,
        ownershipGeneration: 0,
        target: { nodeId: sourceNodeId, workspaceId: sourceWorkspaceId },
      },
      workspaceSnapshot: {
        requestId: snapshotRequestId,
        snapshotId: snapshotStatus.value.snapshotId,
        manifestReference: snapshotStatus.value.manifestReference,
      },
    });
    expect(provenance.commands).toContainEqual(
      expect.objectContaining({
        requestId: sourceRequestId,
        dispatchStatus: "completed",
        executionEffects: [expect.objectContaining({ status: "completed" })],
      }),
    );
    expect(provenanceBytes.includes(Buffer.from(cloudOwner))).toBe(false);
    expect(provenanceBytes.includes(Buffer.from(local.owner))).toBe(false);
    const localOwnerActor = (await local.host.factory.authenticate(local.owner))
      .actor;
    const importJournal = local.host.database.all<{
      actor_json: string;
      source_catalog_id: string;
      manifest_sha256: string;
      destination_id: string;
    }>(
      `SELECT actor_json, source_catalog_id, manifest_sha256, destination_id
       FROM managed_work_imports WHERE request_id = ?`,
      [importRequest.requestId],
    )[0]!;
    expect(importJournal).toMatchObject({
      source_catalog_id: importRequest.sourceCatalogId,
      manifest_sha256: manifestReference,
      destination_id: importRequest.destinationId,
    });
    expect(JSON.parse(importJournal.actor_json)).toEqual(localOwnerActor);
    for (const table of [
      "factory_users",
      "credentials",
      "assistant_credential_grants",
      "access_grants",
      "invitations",
      "projects",
      "nodes",
      "workspaces",
      "threads",
      "dispatch_intents",
      "command_receipts",
      "execution_jobs",
    ]) {
      expect(localCoreSurfaceCounts(local.host)[table]).toBe(
        localCountsBeforeImport[table],
      );
    }
    expect(
      local.host.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM projects WHERE project_id = ?",
        [sourceProjectId],
      )[0]?.count,
    ).toBe(0);
    expect(
      local.host.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM threads WHERE thread_id = ?",
        [sourceThreadId],
      )[0]?.count,
    ).toBe(0);
    expect(
      local.host.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM dispatch_intents WHERE request_id = ? OR thread_id = ?",
        [sourceRequestId, sourceThreadId],
      )[0]?.count,
    ).toBe(0);
    expect(
      local.host.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM command_receipts WHERE request_id = ? OR thread_id = ?",
        [sourceRequestId, sourceThreadId],
      )[0]?.count,
    ).toBe(0);

    const retry = await call<typeof first.value>(
      local.baseUrl,
      "/v1/managed-work-imports",
      {
        credential: local.owner,
        body: importRequest,
      },
    );
    expect(retry.status).toBe(202);
    expect(retry.value).toEqual(first.value);

    const receiptProofRequest = {
      ...importRequest,
      requestId: "import:bounded-prepared-receipt-retry",
      destinationId: "destination:receipt-cap-proof",
    };
    const receiptProofFirst = await call<{
      status: string;
      preparationReceipt?: { preparedAt: string; status: string };
      preparationReceiptSha256?: string;
    }>(local.baseUrl, "/v1/managed-work-imports", {
      credential: local.owner,
      body: receiptProofRequest,
    });
    expect(receiptProofFirst.value.status).toBe("prepared-inactive");
    const receiptProofPath = join(
      local.directory,
      "prepared-import",
      "receipt-cap-proof",
      ".uzina",
      "prepared-restore.json",
    );
    const oversizedReceipt = await open(receiptProofPath, "w");
    try {
      await oversizedReceipt.truncate(
        WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES + 1,
      );
    } finally {
      await oversizedReceipt.close();
    }
    const damagedReceiptBytes = await readFile(receiptProofPath);
    const damagedReceiptHash = sha256(damagedReceiptBytes);
    const receiptProofRetry = await call<typeof receiptProofFirst.value>(
      local.baseUrl,
      "/v1/managed-work-imports",
      { credential: local.owner, body: receiptProofRequest },
    );
    expect(receiptProofRetry.status).toBe(202);
    expect(receiptProofRetry.value.status).toBe("uncertain");
    expect(receiptProofRetry.value.preparationReceipt).toEqual(
      receiptProofFirst.value.preparationReceipt,
    );
    expect(receiptProofRetry.value.preparationReceiptSha256).toBe(
      receiptProofFirst.value.preparationReceiptSha256,
    );
    expect(sha256(await readFile(receiptProofPath))).toBe(damagedReceiptHash);
    const persistedReceipt = local.host.database.all<{
      status: string;
      preparation_receipt_json: string | null;
      preparation_receipt_sha256: string | null;
    }>(
      `SELECT status, preparation_receipt_json, preparation_receipt_sha256
       FROM managed_work_imports WHERE request_id = ?`,
      [receiptProofRequest.requestId],
    )[0];
    expect(persistedReceipt?.status).toBe("uncertain");
    expect(JSON.parse(persistedReceipt!.preparation_receipt_json!)).toEqual(
      receiptProofFirst.value.preparationReceipt,
    );
    expect(persistedReceipt?.preparation_receipt_sha256).toBe(
      receiptProofFirst.value.preparationReceiptSha256 ?? null,
    );

    expect(
      (
        await call(
          local.baseUrl,
          `/v1/managed-work-imports/${importRequest.requestId}`,
          {
            credential: local.owner,
          },
        )
      ).value,
    ).toEqual(first.value);
    expect(localModel.requests()).toBe(0);
    await local.reopenFactory();
    expect(
      (
        await call(
          local.baseUrl,
          `/v1/managed-work-imports/${importRequest.requestId}`,
          {
            credential: local.owner,
          },
        )
      ).value,
    ).toEqual(first.value);
    expect(
      (
        await call<typeof first.value>(
          local.baseUrl,
          "/v1/managed-work-imports",
          {
            credential: local.owner,
            body: importRequest,
          },
        )
      ).value,
    ).toEqual(first.value);
    expect(localModel.requests()).toBe(0);

    const originalCatalogPath = configuredCatalogs["catalog:cloud-offline"]!;
    const originalDestinationPath =
      configuredDestinations["destination:cloud-offline"]!;
    const importedReceiptPath = join(
      destinationPath,
      ".uzina",
      "prepared-restore.json",
    );
    const originalImportedReceiptBytes = await readFile(importedReceiptPath);
    const originalImportedReceiptHash = sha256(originalImportedReceiptBytes);
    const originalImportedDestinationStat = await stat(destinationPath);
    const originalImportedRuntimeStat = await stat(rawRuntimePath);
    const assertOriginalImportEvidence = async () => {
      expect(await readFile(importedReceiptPath)).toEqual(
        originalImportedReceiptBytes,
      );
      expect(sha256(await readFile(importedReceiptPath))).toBe(
        originalImportedReceiptHash,
      );
      expect(await stat(destinationPath)).toMatchObject({
        dev: originalImportedDestinationStat.dev,
        ino: originalImportedDestinationStat.ino,
      });
      expect(await stat(rawRuntimePath)).toMatchObject({
        dev: originalImportedRuntimeStat.dev,
        ino: originalImportedRuntimeStat.ino,
      });
      expect(await readRawImportedCheckpoint(rawRuntimePath)).toMatchObject(
        sourceProjection,
      );
    };

    const alternateCatalogPath = join(
      local.directory,
      "alternate-offline-catalog",
    );
    await mkdir(alternateCatalogPath);
    configuredCatalogs["catalog:cloud-offline"] = alternateCatalogPath;
    await local.reopenFactory();
    const changedCatalogBinding = await call<{ error: string }>(
      local.baseUrl,
      "/v1/managed-work-imports",
      { credential: local.owner, body: importRequest },
    );
    expect(changedCatalogBinding).toMatchObject({
      status: 409,
      value: { error: "managed_work_import_request_conflict" },
    });
    expect(
      (
        await call<ManagedWorkImportStatus>(
          local.baseUrl,
          `/v1/managed-work-imports/${importRequest.requestId}`,
          { credential: local.owner },
        )
      ).value,
    ).toEqual(first.value);
    expect(await readdir(alternateCatalogPath)).toEqual([]);
    await assertOriginalImportEvidence();
    configuredCatalogs["catalog:cloud-offline"] = originalCatalogPath;
    await local.reopenFactory();
    const restoredCatalogRetry = await call<ManagedWorkImportStatus>(
      local.baseUrl,
      "/v1/managed-work-imports",
      { credential: local.owner, body: importRequest },
    );
    expect(restoredCatalogRetry.value).toEqual(first.value);
    await assertOriginalImportEvidence();

    const alternateDestinationPath = join(
      local.directory,
      "prepared-import",
      "stale-binding",
    );
    configuredDestinations["destination:cloud-offline"] =
      alternateDestinationPath;
    await local.reopenFactory();
    const changedDestinationBinding = await call<{ error: string }>(
      local.baseUrl,
      "/v1/managed-work-imports",
      { credential: local.owner, body: importRequest },
    );
    expect(changedDestinationBinding).toMatchObject({
      status: 409,
      value: { error: "managed_work_import_request_conflict" },
    });
    expect(
      (
        await call<ManagedWorkImportStatus>(
          local.baseUrl,
          `/v1/managed-work-imports/${importRequest.requestId}`,
          { credential: local.owner },
        )
      ).value,
    ).toEqual(first.value);
    await expect(lstat(alternateDestinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertOriginalImportEvidence();
    configuredDestinations["destination:cloud-offline"] =
      originalDestinationPath;
    await local.reopenFactory();
    const restoredDestinationRetry = await call<ManagedWorkImportStatus>(
      local.baseUrl,
      "/v1/managed-work-imports",
      { credential: local.owner, body: importRequest },
    );
    expect(restoredDestinationRetry.value).toEqual(first.value);
    const conflictingSameIdBody = await call<{ error: string }>(
      local.baseUrl,
      "/v1/managed-work-imports",
      {
        credential: local.owner,
        body: { ...importRequest, manifestSha256: "f".repeat(64) },
      },
    );
    expect(conflictingSameIdBody).toMatchObject({
      status: 409,
      value: { error: "managed_work_import_request_conflict" },
    });
    expect(
      (
        await call<ManagedWorkImportStatus>(
          local.baseUrl,
          `/v1/managed-work-imports/${importRequest.requestId}`,
          { credential: local.owner },
        )
      ).value,
    ).toEqual(first.value);
    await assertOriginalImportEvidence();
    expect(localModel.requests()).toBe(0);

    const preparedReservationPath = destinationPath;
    const uncertainReservationPath = join(
      local.directory,
      "prepared-import",
      "receipt-cap-proof",
    );
    const uncertainReceiptBeforeReservation = await readFile(receiptProofPath);
    for (const [workspaceId, reservedPath, expectedStatus, requestId] of [
      [
        "workspace:prepared-import-reservation",
        preparedReservationPath,
        "prepared-inactive",
        importRequest.requestId,
      ],
      [
        "workspace:uncertain-import-reservation",
        uncertainReservationPath,
        "uncertain",
        receiptProofRequest.requestId,
      ],
    ] as const) {
      local.addWorkspaceMapping(workspaceId, reservedPath);
      importsEnabled = false;
      let reservationError: unknown;
      try {
        await local.reopenFactory();
      } catch (error) {
        reservationError = error;
      }
      if (!reservationError) {
        throw new Error(
          `Standalone startup adopted reserved ${workspaceId} root ${reservedPath}`,
        );
      }
      expect(String(reservationError)).toContain(
        "managed_work_import_destination_reserved",
      );
      local.removeWorkspaceMapping(workspaceId);
      importsEnabled = true;
      await local.reopenFactory();
      const reservationStatus = await call<ManagedWorkImportStatus>(
        local.baseUrl,
        `/v1/managed-work-imports/${requestId}`,
        { credential: local.owner },
      );
      expect(reservationStatus.value.status).toBe(expectedStatus);
      if (expectedStatus === "prepared-inactive") {
        await assertOriginalImportEvidence();
      } else {
        expect(await readFile(receiptProofPath)).toEqual(
          uncertainReceiptBeforeReservation,
        );
      }
    }
    expect(localModel.requests()).toBe(0);

    const localRuntimeDirectory = join(local.directory, "managed-work");
    const localRuntimeNamesBeforeFaults = (
      await readdir(localRuntimeDirectory)
    ).sort();
    const catalogEvidence = async () =>
      Promise.all(
        (await readdir(catalogPath)).sort().map(async (name) => ({
          name,
          size: (await stat(join(catalogPath, name))).size,
          sha256: sha256(await readFile(join(catalogPath, name))),
        })),
      );
    const catalogEvidenceBeforeFaults = await catalogEvidence();
    const prepareFaultCase = async (
      requestId: string,
      destinationId: string,
    ) => {
      const request = { ...importRequest, requestId, destinationId };
      const prepared = await call<ManagedWorkImportStatus>(
        local.baseUrl,
        "/v1/managed-work-imports",
        { credential: local.owner, body: request },
      );
      expect(prepared.status).toBe(202);
      expect(prepared.value.status).toBe("prepared-inactive");
      if (
        !prepared.value.preparationReceipt ||
        !prepared.value.preparationReceiptSha256
      ) {
        throw new Error("A real prepared import omitted its committed receipt");
      }
      const destinationRoot = configuredDestinations[destinationId];
      if (!destinationRoot) {
        throw new Error(`No configured destination for ${destinationId}`);
      }
      const receiptPath = join(
        destinationRoot,
        ".uzina",
        "prepared-restore.json",
      );
      const runtimePath = join(destinationRoot, "managed-work.sqlite");
      const receiptBytes = await readFile(receiptPath);
      const rootStat = await stat(destinationRoot);
      const runtimeStat = await stat(runtimePath);
      const receiptStat = await stat(receiptPath);
      const destinationNames = (await readdir(destinationRoot)).sort();
      return {
        request,
        status: prepared.value,
        destinationRoot,
        receiptPath,
        runtimePath,
        receiptBytes,
        expectedReceiptBytes: receiptBytes,
        rootStat,
        runtimeStat,
        receiptStat,
        destinationNames,
        coreCounts: localCoreSurfaceCounts(local.host),
      };
    };
    const assertFaultEvidence = async (
      candidate: Awaited<ReturnType<typeof prepareFaultCase>>,
      expectedCatalog: Awaited<ReturnType<typeof catalogEvidence>>,
      assertMutation: () => Promise<void>,
    ) => {
      expect(await readFile(candidate.receiptPath)).toEqual(
        candidate.expectedReceiptBytes,
      );
      expect(await stat(candidate.receiptPath)).toMatchObject({
        dev: candidate.receiptStat.dev,
        ino: candidate.receiptStat.ino,
      });
      expect(await stat(candidate.destinationRoot)).toMatchObject({
        dev: candidate.rootStat.dev,
        ino: candidate.rootStat.ino,
      });
      expect(await stat(candidate.runtimePath)).toMatchObject({
        dev: candidate.runtimeStat.dev,
        ino: candidate.runtimeStat.ino,
      });
      expect((await readdir(candidate.destinationRoot)).sort()).toEqual(
        candidate.destinationNames,
      );
      expect(localCoreSurfaceCounts(local.host)).toEqual(candidate.coreCounts);
      expect((await readdir(localRuntimeDirectory)).sort()).toEqual(
        localRuntimeNamesBeforeFaults,
      );
      expect(await catalogEvidence()).toEqual(expectedCatalog);
      await assertMutation();
      await assertOriginalImportEvidence();
      expect(
        await readPublicStorageObservation(sourceBaseUrl, sourceThreadId),
      ).toEqual(sourceStorage);
      expect(localModel.requests()).toBe(0);
    };
    const rejectChangedPreparedOutput = async (
      candidate: Awaited<ReturnType<typeof prepareFaultCase>>,
      expectedCatalog: Awaited<ReturnType<typeof catalogEvidence>>,
      assertMutation: () => Promise<void>,
    ) => {
      const getBeforeVerification = await call<ManagedWorkImportStatus>(
        local.baseUrl,
        `/v1/managed-work-imports/${candidate.request.requestId}`,
        { credential: local.owner },
      );
      expect(getBeforeVerification.value).toEqual(candidate.status);
      const degraded = await call<ManagedWorkImportStatus>(
        local.baseUrl,
        "/v1/managed-work-imports",
        { credential: local.owner, body: candidate.request },
      );
      expect(degraded.status).toBe(202);
      expect(degraded.value.status).toBe("uncertain");
      expect(degraded.value.errorCode).toBe(
        "managed_work_import_restore_uncertain",
      );
      expect(degraded.value.preparationReceipt).toEqual(
        candidate.status.preparationReceipt,
      );
      expect(degraded.value.preparationReceiptSha256).toBe(
        candidate.status.preparationReceiptSha256,
      );
      expect(degraded.value.preparationReceipt?.preparedAt).toBe(
        candidate.status.preparationReceipt?.preparedAt,
      );
      await assertFaultEvidence(candidate, expectedCatalog, assertMutation);
      expect(
        (
          await call<ManagedWorkImportStatus>(
            local.baseUrl,
            `/v1/managed-work-imports/${candidate.request.requestId}`,
            { credential: local.owner },
          )
        ).value,
      ).toEqual(degraded.value);

      await local.reopenFactory();
      expect(
        (
          await call<ManagedWorkImportStatus>(
            local.baseUrl,
            `/v1/managed-work-imports/${candidate.request.requestId}`,
            { credential: local.owner },
          )
        ).value,
      ).toEqual(degraded.value);
      const retry = await call<ManagedWorkImportStatus>(
        local.baseUrl,
        "/v1/managed-work-imports",
        { credential: local.owner, body: candidate.request },
      );
      expect(retry.status).toBe(202);
      expect(retry.value).toEqual(degraded.value);
      await assertFaultEvidence(candidate, expectedCatalog, assertMutation);
      expect(localModel.requests()).toBe(0);
    };

    const workspaceMutation = await prepareFaultCase(
      "import:changed-workspace-output",
      "destination:workspace-output-mutation",
    );
    const importedWorkspacePath = join(
      workspaceMutation.destinationRoot,
      "workspace",
    );
    const importedIndexPath = join(importedWorkspacePath, ".git", "index");
    const indexBeforeMutation = await readFile(importedIndexPath);
    git(
      importedWorkspacePath,
      "update-index",
      "--assume-unchanged",
      "tracked.txt",
    );
    const mutatedIndexBytes = await readFile(importedIndexPath);
    expect(mutatedIndexBytes).not.toEqual(indexBeforeMutation);
    await rejectChangedPreparedOutput(
      workspaceMutation,
      catalogEvidenceBeforeFaults,
      async () => {
        expect(await readFile(importedIndexPath)).toEqual(mutatedIndexBytes);
        expect(await gitWorkspaceEvidence(importedWorkspacePath)).not.toEqual(
          sourceWorkspaceEvidence,
        );
      },
    );

    const runtimeMutation = await prepareFaultCase(
      "import:changed-runtime-output",
      "destination:runtime-output-mutation",
    );
    const runtimeStorage = await openBunSqliteStorage(
      runtimeMutation.runtimePath,
    );
    let runtimeMutationProjection: typeof sourceProjection;
    try {
      const targetSubmission = sourceProjection.submissions.find(
        ({ requestId }) => requestId === sourceRequestId,
      );
      if (!targetSubmission?.requestId) {
        throw new Error(
          "The genuine source checkpoint lacks its settled input",
        );
      }
      const changedSubmission = {
        ...targetSubmission,
        requestId: `${targetSubmission.requestId}:offline-corruption`,
      };
      expect(
        await runtimeStorage.commit(
          [[{ type: "submission", value: changedSubmission }]],
          () => {},
          BACKGROUND_CONTEXT,
        ),
      ).toMatchObject({ stored: 1 });
    } finally {
      await runtimeStorage.close(BACKGROUND_CONTEXT);
    }
    const changedRuntime = await readRawImportedCheckpoint(
      runtimeMutation.runtimePath,
    );
    runtimeMutationProjection = {
      conversations: changedRuntime.conversations,
      entries: changedRuntime.entries,
      tasks: changedRuntime.tasks,
      submissions: changedRuntime.submissions,
      documents: changedRuntime.documents,
    };
    expect(runtimeMutationProjection).not.toEqual(sourceProjection);
    await rejectChangedPreparedOutput(
      runtimeMutation,
      catalogEvidenceBeforeFaults,
      async () => {
        expect(
          await readRawImportedCheckpoint(runtimeMutation.runtimePath),
        ).toMatchObject(runtimeMutationProjection);
      },
    );

    const receiptMutation = await prepareFaultCase(
      "import:changed-receipt-output",
      "destination:receipt-mutation",
    );
    const receiptValue = JSON.parse(
      receiptMutation.receiptBytes.toString("utf8"),
    ) as NonNullable<ManagedWorkImportStatus["preparationReceipt"]>;
    const mutatedReceiptBytes = Buffer.from(
      JSON.stringify({
        ...receiptValue,
        preparedAt: "2001-02-03T04:05:06.000Z",
      }),
      "utf8",
    );
    await writeFile(receiptMutation.receiptPath, mutatedReceiptBytes);
    receiptMutation.expectedReceiptBytes = mutatedReceiptBytes;
    await rejectChangedPreparedOutput(
      receiptMutation,
      catalogEvidenceBeforeFaults,
      async () => {
        expect(await readFile(receiptMutation.receiptPath)).toEqual(
          mutatedReceiptBytes,
        );
      },
    );

    const catalogMutation = await prepareFaultCase(
      "import:corrupted-completed-source-catalog",
      "destination:catalog-corruption",
    );
    const manifestFilePath = join(catalogPath, manifestReference);
    const originalManifestFileBytes = await readFile(manifestFilePath);
    const corruptedManifestFileBytes = Buffer.from(originalManifestFileBytes);
    corruptedManifestFileBytes[0] = corruptedManifestFileBytes[0]! ^ 1;
    await writeFile(manifestFilePath, corruptedManifestFileBytes);
    const retainedCorruptedManifestBytes = await readFile(manifestFilePath);
    expect(retainedCorruptedManifestBytes).toEqual(corruptedManifestFileBytes);
    const corruptedCatalogEvidence = await catalogEvidence();
    await rejectChangedPreparedOutput(
      catalogMutation,
      corruptedCatalogEvidence,
      async () => {
        expect(await readFile(manifestFilePath)).toEqual(
          retainedCorruptedManifestBytes,
        );
      },
    );

    const localThreads = await call<{ threads: Array<{ threadId: string }> }>(
      local.baseUrl,
      "/v1/threads",
      { credential: local.owner },
    );
    expect(
      localThreads.value.threads.map(({ threadId }) => threadId),
    ).not.toContain(sourceThreadId);
    expect(await readRawImportedCheckpoint(rawRuntimePath)).toMatchObject(
      sourceProjection,
    );

    await local.startExecution();
    const localRequestId = "request:local-after-cloud-offline-import";
    expect(
      (
        await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
          credential: local.owner,
          body: {
            requestId: localRequestId,
            text: "Use ordinary local Pi work after reopening the prepared import.",
          },
        })
      ).status,
    ).toBe(202);
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${localRequestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    const localReceipt = await call<{
      dispatchStatus: string;
      executionEffects?: Array<{ status: string }>;
      target: { nodeId: string; workspaceId: string };
      ownershipGeneration: number;
    }>(local.baseUrl, `/v1/commands/${localRequestId}`, {
      credential: local.owner,
    });
    expect(localReceipt.value).toMatchObject({
      dispatchStatus: "completed",
      target: { nodeId: local.nodeId, workspaceId: local.workspaceId },
      ownershipGeneration: 0,
      executionEffects: [expect.objectContaining({ status: "completed" })],
    });
    expect(
      await readFile(
        join(local.workspaceDirectory, "local-after-import.txt"),
        "utf8",
      ),
    ).toBe("local Pi work continued after offline import\n");
    const localContext = await call<Record<string, unknown>>(
      local.baseUrl,
      `/v1/threads/${local.threadId}/context`,
      { credential: local.owner },
    );
    expect(localContext.status).toBe(200);
    expect(JSON.stringify(localContext.value)).toContain(
      "Unrelated local Pi work remained usable after import and reopen.",
    );
    expect(localModel.requests()).toBeGreaterThanOrEqual(2);
    expect(await readRawImportedCheckpoint(rawRuntimePath)).toMatchObject(
      sourceProjection,
    );

    expect(
      await readPublicStorageObservation(sourceBaseUrl, sourceThreadId),
    ).toEqual(sourceStorage);
    expect(await gitWorkspaceEvidence(sourceWorkspace)).toEqual(
      sourceWorkspaceEvidence,
    );
    expect(
      await call(sourceBaseUrl, `/v1/capture-controls/${captureRequestId}`, {
        credential: cloudOwner,
      }),
    ).toMatchObject({ status: 200, value: captureStatus.value });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/workspace-snapshots/${snapshotRequestId}`,
        {
          credential: cloudOwner,
        },
      ),
    ).toMatchObject({ status: 200, value: snapshotStatus.value });
    expect(
      await call(
        sourceBaseUrl,
        `/v1/managed-work-checkpoints/${checkpointRequestId}`,
        {
          credential: cloudOwner,
        },
      ),
    ).toMatchObject({ status: 200, value: checkpointStatus.value });
  });
});

describe("guarded managed-work restore resource ownership", () => {
  test("closes the actual raw SQLite store when Owner auth fails after open", async () => {
    const provider = deterministicToolModels({
      toolName: "remote_write_file",
      arguments: { path: "source.txt", content: "source state" },
    });
    const local = await scenario({
      models: provider.models,
      modelProvider: "uzina-test",
      modelId: "fixed-model",
      directoryPrefix: "uzina-guarded-restore-owner-",
    });
    const workspace = local.workspaceDirectory;
    git(workspace, "init", "--initial-branch=main", "--quiet");
    git(workspace, "config", "user.name", "Restore owner test");
    git(workspace, "config", "user.email", "restore-owner@example.invalid");
    await writeFile(join(workspace, "tracked.txt"), "base\n");
    git(workspace, "add", "tracked.txt");
    git(workspace, "commit", "-m", "base");
    const input = {
      requestId: "request:guarded-restore-owner-source",
      text: "Write the source state before capturing it.",
    };
    expect(
      (
        await call(local.baseUrl, `/v1/threads/${local.threadId}/inputs`, {
          credential: local.owner,
          body: input,
        })
      ).status,
    ).toBe(202);
    await until(async () => {
      const receipt = await call<{ dispatchStatus: string }>(
        local.baseUrl,
        `/v1/commands/${input.requestId}`,
        { credential: local.owner },
      );
      return receipt.value.dispatchStatus === "completed";
    });
    const transport = new FileBlobTransport(
      join(local.directory, "source-files"),
    );
    const captured = await local.host.captureManagedWorkCheckpoint({
      credential: local.owner,
      threadId: local.threadId,
      transport,
    });
    const ownerSession = await local.host.factory.authenticate(local.owner);
    const stageOwner = await local.host.factory.provisionCredential(
      ownerSession,
      "human",
      "Temporary staging Owner",
    );
    const stageDestination = join(local.directory, "guarded-stage-destination");
    let ownedStagingRoot: string | undefined;
    let stageOwnerRevoked = false;
    try {
      await expect(
        restoreManagedWorkBundle({
          manifestReference: captured.manifestReference,
          transport,
          destinationPath: stageDestination,
          requireFreshDestination: true,
          supportedRuntimeRequirements: [
            "model:uzina-test/fixed-model",
            ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
          ],
          async beforeAndAfterEffect() {
            if (!ownedStagingRoot) {
              const stagingName = (await readdir(local.directory)).find(
                (name) => name.startsWith(".uzina-prepared-restore-"),
              );
              if (stagingName) {
                ownedStagingRoot = join(local.directory, stagingName);
                await local.host.factory.revokeCredential(
                  ownerSession,
                  stageOwner.credentialId,
                );
                stageOwnerRevoked = true;
              }
            }
            await local.host.factory.authenticate(stageOwner.credential);
          },
          async openStorage(path) {
            const storage = await openBunSqliteStorage(path);
            return {
              storage,
              close: () => storage.close(BACKGROUND_CONTEXT),
            };
          },
        }),
      ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      expect(stageOwnerRevoked).toBe(true);
      if (!ownedStagingRoot) {
        throw new Error("Restore did not acquire its staging directory");
      }
      await expect(lstat(ownedStagingRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (ownedStagingRoot) {
        await rm(ownedStagingRoot, { recursive: true, force: true });
      }
    }

    const temporaryOwner = await local.host.factory.provisionCredential(
      ownerSession,
      "human",
      "Temporary restore Owner",
    );
    const destination = join(local.directory, "guarded-restore-destination");
    let openedStorage:
      | Awaited<ReturnType<typeof openBunSqliteStorage>>
      | undefined;
    let revoked = false;
    try {
      await expect(
        restoreManagedWorkBundle({
          manifestReference: captured.manifestReference,
          transport,
          destinationPath: destination,
          requireFreshDestination: true,
          supportedRuntimeRequirements: [
            "model:uzina-test/fixed-model",
            ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
          ],
          async beforeAndAfterEffect() {
            if (openedStorage && !revoked) {
              await local.host.factory.revokeCredential(
                ownerSession,
                temporaryOwner.credentialId,
              );
              revoked = true;
            }
            await local.host.factory.authenticate(temporaryOwner.credential);
          },
          async openStorage(path) {
            openedStorage = await openBunSqliteStorage(path);
            return {
              storage: openedStorage,
              close: () => openedStorage!.close(BACKGROUND_CONTEXT),
            };
          },
        }),
      ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      expect(revoked).toBe(true);
      if (!openedStorage) throw new Error("Restore did not open raw SQLite");
      await expect(
        openedStorage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT),
      ).rejects.toThrow("SqliteStorage is closed");
      expect(
        (await readdir(local.directory)).filter((name) =>
          name.startsWith(".uzina-prepared-restore-"),
        ),
      ).toEqual([]);
      await expect(lstat(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await openedStorage?.close(BACKGROUND_CONTEXT);
    }

    const existingDestination = join(
      local.directory,
      "guarded-existing-restore-destination",
    );
    const existingRestore = await restoreManagedWorkBundle({
      manifestReference: captured.manifestReference,
      transport,
      destinationPath: existingDestination,
      supportedRuntimeRequirements: [
        "model:uzina-test/fixed-model",
        ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
      ],
      async openStorage(path) {
        const storage = await openBunSqliteStorage(path);
        return {
          storage,
          close: () => storage.close(BACKGROUND_CONTEXT),
        };
      },
    });
    const existingReceiptPath = join(
      existingDestination,
      ".uzina",
      "prepared-restore.json",
    );
    const existingReceiptBytes = await readFile(existingReceiptPath);
    const existingReceiptHash = sha256(existingReceiptBytes);
    const existingRuntimeStat = await stat(existingRestore.runtimePath);
    const existingRootStat = await stat(existingDestination);
    const preparedPublicState = await readRawImportedCheckpoint(
      existingRestore.runtimePath,
    );
    const preparedPublicProjection = {
      conversations: preparedPublicState.conversations,
      entries: preparedPublicState.entries,
      tasks: preparedPublicState.tasks,
      submissions: preparedPublicState.submissions,
      documents: preparedPublicState.documents,
    };
    const retryOwner = await local.host.factory.provisionCredential(
      ownerSession,
      "human",
      "Temporary existing-output verifier Owner",
    );
    expect(retryOwner.actor).toEqual(ownerSession.actor);
    let retryRawStorage:
      | Awaited<ReturnType<typeof openBunSqliteStorage>>
      | undefined;
    let retryOwnerRevoked = false;
    const publicConversationsReadAfterRevocation: unknown[] = [];
    try {
      await expect(
        restoreManagedWorkBundle({
          manifestReference: captured.manifestReference,
          transport,
          destinationPath: existingDestination,
          supportedRuntimeRequirements: [
            "model:uzina-test/fixed-model",
            ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
          ],
          async beforeAndAfterEffect() {
            await local.host.factory.authenticate(retryOwner.credential);
          },
          async openStorage(path) {
            retryRawStorage = await openBunSqliteStorage(path);
            await local.host.factory.revokeCredential(
              ownerSession,
              retryOwner.credentialId,
            );
            retryOwnerRevoked = true;
            const scanConversations =
              retryRawStorage.scanConversations.bind(retryRawStorage);
            const observedStorage = new Proxy(retryRawStorage, {
              get(target, property) {
                if (property !== "scanConversations") {
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                }
                return async (
                  ...args: Parameters<Storage["scanConversations"]>
                ) => {
                  const result = await scanConversations(...args);
                  if (retryOwnerRevoked && result.items.length > 0) {
                    publicConversationsReadAfterRevocation.push(result.items);
                  }
                  return result;
                };
              },
            }) as Storage;
            return {
              storage: observedStorage,
              close: () => retryRawStorage!.close(BACKGROUND_CONTEXT),
            };
          },
        }),
      ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      expect(retryOwnerRevoked).toBe(true);
      expect(publicConversationsReadAfterRevocation).toEqual([]);
      if (!retryRawStorage) {
        throw new Error("Prepared-output retry did not open raw SQLite");
      }
      await expect(
        retryRawStorage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT),
      ).rejects.toThrow("SqliteStorage is closed");
      expect(await readFile(existingReceiptPath)).toEqual(existingReceiptBytes);
      expect(sha256(await readFile(existingReceiptPath))).toBe(
        existingReceiptHash,
      );
      expect(await stat(existingRestore.runtimePath)).toMatchObject({
        dev: existingRuntimeStat.dev,
        ino: existingRuntimeStat.ino,
      });
      const retriedPublicState = await readRawImportedCheckpoint(
        existingRestore.runtimePath,
      );
      expect({
        conversations: retriedPublicState.conversations,
        entries: retriedPublicState.entries,
        tasks: retriedPublicState.tasks,
        submissions: retriedPublicState.submissions,
        documents: retriedPublicState.documents,
      }).toEqual(preparedPublicProjection);
    } finally {
      await retryRawStorage?.close(BACKGROUND_CONTEXT);
    }

    const scanTemporaryOwner = await call<{
      credentialId: string;
      credential: string;
      actor: unknown;
    }>(local.baseUrl, "/v1/credentials", {
      credential: local.owner,
      body: { kind: "human", name: "Temporary post-scan verifier Owner" },
    });
    expect(scanTemporaryOwner.status).toBe(201);
    expect(scanTemporaryOwner.value.actor).toEqual(ownerSession.actor);
    let scanRawStorage:
      | Awaited<ReturnType<typeof openBunSqliteStorage>>
      | undefined;
    let scanOwnerRevoked = false;
    let firstConversationPageRecords = 0;
    let scanRevocationResponse:
      | { status: number; value: { status: string } }
      | undefined;
    const storageOperationsStartedAfterRevocation: string[] = [];
    try {
      await expect(
        restoreManagedWorkBundle({
          manifestReference: captured.manifestReference,
          transport,
          destinationPath: existingDestination,
          supportedRuntimeRequirements: [
            "model:uzina-test/fixed-model",
            ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
          ],
          async beforeAndAfterEffect() {
            await local.host.factory.authenticate(
              scanTemporaryOwner.value.credential,
            );
          },
          async openStorage(path) {
            scanRawStorage = await openBunSqliteStorage(path);
            const observedStorage = new Proxy(scanRawStorage, {
              get(target, property) {
                const operation = Reflect.get(target, property, target);
                if (typeof operation !== "function") return operation;
                return async (...args: unknown[]) => {
                  if (scanOwnerRevoked) {
                    storageOperationsStartedAfterRevocation.push(
                      String(property),
                    );
                  }
                  const result = await Reflect.apply(operation, target, args);
                  if (
                    property === "scanConversations" &&
                    !scanRevocationResponse
                  ) {
                    firstConversationPageRecords = (
                      result as { items: unknown[] }
                    ).items.length;
                    scanRevocationResponse = await call<{
                      status: string;
                    }>(
                      local.baseUrl,
                      `/v1/credentials/${encodeURIComponent(scanTemporaryOwner.value.credentialId)}/revoke`,
                      { credential: local.owner, body: {} },
                    );
                    scanOwnerRevoked =
                      scanRevocationResponse.status === 200 &&
                      scanRevocationResponse.value.status === "revoked";
                  }
                  return result;
                };
              },
            }) as Storage;
            return {
              storage: observedStorage,
              close: () => scanRawStorage!.close(BACKGROUND_CONTEXT),
            };
          },
        }),
      ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      expect(scanRevocationResponse).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      expect(firstConversationPageRecords).toBeGreaterThan(0);
      expect(scanOwnerRevoked).toBe(true);
      expect(storageOperationsStartedAfterRevocation).toEqual([]);
      if (!scanRawStorage) {
        throw new Error("Prepared-output verifier did not open raw SQLite");
      }
      await expect(
        scanRawStorage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT),
      ).rejects.toThrow("SqliteStorage is closed");
      expect(await readFile(existingReceiptPath)).toEqual(existingReceiptBytes);
      expect(sha256(await readFile(existingReceiptPath))).toBe(
        existingReceiptHash,
      );
      expect(await stat(existingDestination)).toMatchObject({
        dev: existingRootStat.dev,
        ino: existingRootStat.ino,
      });
      expect(await stat(existingRestore.runtimePath)).toMatchObject({
        dev: existingRuntimeStat.dev,
        ino: existingRuntimeStat.ino,
      });
      const postScanPublicState = await readRawImportedCheckpoint(
        existingRestore.runtimePath,
      );
      expect({
        conversations: postScanPublicState.conversations,
        entries: postScanPublicState.entries,
        tasks: postScanPublicState.tasks,
        submissions: postScanPublicState.submissions,
        documents: postScanPublicState.documents,
      }).toEqual(preparedPublicProjection);
      expect(
        await readFile(
          join(existingDestination, "workspace", "tracked.txt"),
          "utf8",
        ),
      ).toBe("base\n");
    } finally {
      await scanRawStorage?.close(BACKGROUND_CONTEXT);
    }

    const mintTemporaryOwner = await call<{
      credentialId: string;
      credential: string;
      actor: unknown;
    }>(local.baseUrl, "/v1/credentials", {
      credential: local.owner,
      body: { kind: "human", name: "Post-mint import Owner" },
    });
    expect(mintTemporaryOwner.status).toBe(201);
    expect(mintTemporaryOwner.value.actor).toEqual(ownerSession.actor);
    const mintImportDestination = join(
      local.directory,
      "post-mint-revocation-destination",
    );
    let mintImportStorage:
      | Awaited<ReturnType<typeof openBunSqliteStorage>>
      | undefined;
    let mintImportStoragePath: string | undefined;
    let mintedId: unknown;
    let mintRevocationResponse:
      | { status: number; value: { status: string } }
      | undefined;
    let mintOwnerRevoked = false;
    const storageOperationsAfterMintRevocation: string[] = [];
    try {
      await expect(
        restoreManagedWorkBundle({
          manifestReference: captured.manifestReference,
          transport,
          destinationPath: mintImportDestination,
          requireFreshDestination: true,
          supportedRuntimeRequirements: [
            "model:uzina-test/fixed-model",
            ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
          ],
          async beforeAndAfterEffect() {
            await local.host.factory.authenticate(
              mintTemporaryOwner.value.credential,
            );
          },
          async openStorage(path) {
            mintImportStoragePath = path;
            mintImportStorage = await openBunSqliteStorage(path);
            const observedStorage = new Proxy(mintImportStorage, {
              get(target, property) {
                const operation = Reflect.get(target, property, target);
                if (typeof operation !== "function") return operation;
                if (property === "close") return operation.bind(target);
                return async (...args: unknown[]) => {
                  if (mintOwnerRevoked) {
                    storageOperationsAfterMintRevocation.push(String(property));
                  }
                  const result = await Reflect.apply(operation, target, args);
                  if (property === "mintId" && !mintRevocationResponse) {
                    mintedId = result;
                    mintRevocationResponse = await call<{
                      status: string;
                    }>(
                      local.baseUrl,
                      `/v1/credentials/${encodeURIComponent(mintTemporaryOwner.value.credentialId)}/revoke`,
                      { credential: local.owner, body: {} },
                    );
                    mintOwnerRevoked =
                      mintRevocationResponse.status === 200 &&
                      mintRevocationResponse.value.status === "revoked";
                  }
                  return result;
                };
              },
            }) as Storage;
            return {
              storage: observedStorage,
              close: () => mintImportStorage!.close(BACKGROUND_CONTEXT),
            };
          },
        }),
      ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      expect(mintRevocationResponse).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      expect(mintOwnerRevoked).toBe(true);
      expect(mintedId).toBe(Number(ROOT_CONVERSATION_ID) + 1);
      expect(storageOperationsAfterMintRevocation).toEqual([]);
      if (!mintImportStorage || !mintImportStoragePath) {
        throw new Error("Post-mint revocation did not open raw SQLite");
      }
      await expect(
        mintImportStorage.scanConversations(
          {},
          1,
          undefined,
          BACKGROUND_CONTEXT,
        ),
      ).rejects.toThrow("SqliteStorage is closed");
      const mintImportStagingRoot = dirname(mintImportStoragePath);
      await expect(lstat(mintImportStagingRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(mintImportDestination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        lstat(join(mintImportDestination, ".uzina", "prepared-restore.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(existingReceiptPath)).toEqual(existingReceiptBytes);
      expect(sha256(await readFile(existingReceiptPath))).toBe(
        existingReceiptHash,
      );
    } finally {
      await mintImportStorage?.close(BACKGROUND_CONTEXT);
    }

    const joiningOwner = await call<{
      credentialId: string;
      credential: string;
      actor: unknown;
    }>(local.baseUrl, "/v1/credentials", {
      credential: local.owner,
      body: { kind: "human", name: "Reserved-read join Owner" },
    });
    expect(joiningOwner.status).toBe(201);
    expect(joiningOwner.value.actor).toEqual(ownerSession.actor);
    const joiningDestination = join(
      local.directory,
      "parallel-reserved-read-join-destination",
    );
    const joiningGate = join(local.directory, "parallel-reserved-read-join");
    await mkdir(joiningGate);
    const reservedReadOperations = [
      "conversation",
      "entry",
      "task",
      "submission",
      "document",
    ] as const;
    const returnedReservedReads = new Set<string>();
    const reservedReadSettlements = new Map<string, Promise<void>>();
    const operationsStartedAfterJoinRevocation: string[] = [];
    let joinRawStorage:
      | Awaited<ReturnType<typeof openBunSqliteStorage>>
      | undefined;
    let joinRawStoragePath: string | undefined;
    let readsAtStorageClose: string[] | undefined;
    let joinOwnerRevoked = false;
    let conversationReleaseIssued = false;
    let firstPostcheckDenied = false;
    let joinRestoreSettled = false;
    let joinRestoreOutcome:
      | Promise<
          | { kind: "restored"; value: unknown }
          | { kind: "rejected"; error: unknown }
        >
      | undefined;
    const releasedReads = new Set<string>();
    const releaseReservedRead = async (operation: string) => {
      if (releasedReads.has(operation)) return;
      releasedReads.add(operation);
      if (operation === "conversation") conversationReleaseIssued = true;
      await writeFile(join(joiningGate, `release-${operation}`), "release\n", {
        flag: "wx",
      });
    };
    try {
      joinRestoreOutcome = restoreManagedWorkBundle({
        manifestReference: captured.manifestReference,
        transport,
        destinationPath: joiningDestination,
        requireFreshDestination: true,
        supportedRuntimeRequirements: [
          "model:uzina-test/fixed-model",
          ...MANAGED_REMOTE_TOOL_REQUIREMENTS,
        ],
        async beforeAndAfterEffect() {
          try {
            await local.host.factory.authenticate(
              joiningOwner.value.credential,
            );
          } catch (error) {
            if (conversationReleaseIssued && !firstPostcheckDenied) {
              firstPostcheckDenied = true;
              await writeFile(
                join(joiningGate, "conversation-postcheck-denied"),
                "Core denied the completed conversation read post-check\n",
                { flag: "wx" },
              );
            }
            throw error;
          }
        },
        async openStorage(path) {
          joinRawStoragePath = path;
          joinRawStorage = await openBunSqliteStorage(path);
          const observedStorage = new Proxy(joinRawStorage, {
            get(target, property) {
              const operation = Reflect.get(target, property, target);
              if (typeof operation !== "function") return operation;
              if (property === "close") return operation.bind(target);
              return async (...args: unknown[]) => {
                const name = String(property);
                if (joinOwnerRevoked) {
                  operationsStartedAfterJoinRevocation.push(name);
                }
                const result = await Reflect.apply(operation, target, args);
                if (
                  reservedReadOperations.includes(
                    name as (typeof reservedReadOperations)[number],
                  )
                ) {
                  let settleRead!: () => void;
                  const readSettled = new Promise<void>((resolve) => {
                    settleRead = resolve;
                  });
                  reservedReadSettlements.set(name, readSettled);
                  try {
                    await writeFile(
                      join(joiningGate, `completed-${name}`),
                      JSON.stringify({
                        operation: name,
                        result: "real-storage-read",
                      }),
                      { flag: "wx" },
                    );
                    await waitForFile(join(joiningGate, `release-${name}`));
                    returnedReservedReads.add(name);
                  } finally {
                    settleRead();
                  }
                }
                return result;
              };
            },
          }) as Storage;
          return {
            storage: observedStorage,
            close: async () => {
              readsAtStorageClose = [...returnedReservedReads].sort();
              await joinRawStorage!.close(BACKGROUND_CONTEXT);
            },
          };
        },
      })
        .then(
          (value) => ({ kind: "restored" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        .then((result) => {
          joinRestoreSettled = true;
          return result;
        });
      await Promise.all(
        reservedReadOperations.map((operation) =>
          waitForFile(join(joiningGate, `completed-${operation}`)),
        ),
      );
      const joinRevocationResponse = await call<{
        status: string;
      }>(
        local.baseUrl,
        `/v1/credentials/${encodeURIComponent(joiningOwner.value.credentialId)}/revoke`,
        { credential: local.owner, body: {} },
      );
      expect(joinRevocationResponse).toMatchObject({
        status: 200,
        value: { status: "revoked" },
      });
      joinOwnerRevoked = true;
      await releaseReservedRead("conversation");
      await waitForFile(join(joiningGate, "conversation-postcheck-denied"));
      await Promise.all(
        reservedReadOperations
          .filter((operation) => operation !== "conversation")
          .map((operation) => releaseReservedRead(operation)),
      );
      const joinResult = await joinRestoreOutcome;
      expect(joinResult?.kind).toBe("rejected");
      if (joinResult?.kind !== "rejected") {
        throw new Error("Revoked reserved-read join unexpectedly restored");
      }
      expect(joinResult.error).toMatchObject({
        status: 401,
        code: "unauthorized",
      });
      expect(joinRestoreSettled).toBe(true);
      expect(operationsStartedAfterJoinRevocation).toEqual([]);
      expect(readsAtStorageClose).toEqual([...reservedReadOperations].sort());
      if (!joinRawStorage || !joinRawStoragePath) {
        throw new Error("Reserved-read join did not open raw SQLite");
      }
      await expect(
        joinRawStorage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT),
      ).rejects.toThrow("SqliteStorage is closed");
      await expect(lstat(dirname(joinRawStoragePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(joiningDestination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await Promise.all(
        reservedReadOperations.map((operation) =>
          releaseReservedRead(operation),
        ),
      );
      if (joinRestoreOutcome) await joinRestoreOutcome;
      await Promise.all(reservedReadSettlements.values());
      await joinRawStorage?.close(BACKGROUND_CONTEXT);
    }
  });
});
