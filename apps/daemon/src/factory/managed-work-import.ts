import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  restoreManagedWorkBundle,
  validateManagedWorkBundle,
} from "@uzina/checkpoints";
import type { ManagedWorkCheckpoint } from "@uzina/pi-runtime/checkpoint";
import {
  managedWorkImportPreparationReceiptSchema,
  type ManagedWorkImportHostBinding,
  type ManagedWorkImportRequest,
} from "@uzina/contracts/factory";
import type {
  ManagedWorkImportHost,
  ManagedWorkImportJournal,
} from "@uzina/core/http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openBunSqliteStorage } from "../runtime/sqlite";
import { BoundedManagedWorkImportCatalog } from "./managed-work-import-catalog";

const HOST_DESCRIPTOR = "uzina-standalone-offline-files-v1";
const UNCERTAIN_ERROR = "managed_work_import_restore_uncertain";
const BLOCKED_ERROR = "managed_work_import_bundle_invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StandaloneManagedWorkImportOptions {
  catalogs: Readonly<Record<string, string>>;
  destinations: Readonly<Record<string, string>>;
  localRoots: readonly string[];
  supportedRuntimeRequirements: readonly string[];
  supportedModel: { provider: string; modelId: string };
  supportedToolNames: readonly string[];
}

interface ResolvedImportConfiguration {
  catalogs: Map<string, { configuredPath: string; canonicalRoot: string }>;
  destinations: Map<string, { configuredPath: string; canonicalRoot: string }>;
  localRoots: string[];
}

function rootsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
    );
  };
  return contains(left, right) || contains(right, left);
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Managed-work import configuration has an invalid ID");
  }
}

function assertPathMap(value: Readonly<Record<string, string>>, name: string) {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error(`${name} must contain at least one configured ID`);
  }
  for (const [id, path] of entries) {
    assertIdentifier(id);
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error(`${name} paths must be absolute operator configuration`);
    }
  }
  return entries;
}

async function existingDirectory(path: string): Promise<string> {
  const configuredPath = resolve(path);
  const details = await lstat(configuredPath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(
      "Configured managed-work import catalog must be a real directory",
    );
  }
  const canonicalRoot = await realpath(configuredPath);
  const canonicalDetails = await lstat(canonicalRoot);
  if (!canonicalDetails.isDirectory() || canonicalDetails.isSymbolicLink()) {
    throw new Error(
      "Configured managed-work import catalog is not a real directory",
    );
  }
  return canonicalRoot;
}

async function destinationDirectory(path: string): Promise<string> {
  const configuredPath = resolve(path);
  if (configuredPath === dirname(configuredPath)) {
    throw new Error(
      "Managed-work import destination cannot be a filesystem root",
    );
  }
  try {
    const details = await lstat(configuredPath);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(
        "Managed-work import destination must be a real directory",
      );
    }
    return await realpath(configuredPath);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  const parent = dirname(configuredPath);
  const parentDetails = await lstat(parent);
  if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
    throw new Error(
      "Managed-work import destination parent must be an existing real directory",
    );
  }
  return join(await realpath(parent), basename(configuredPath));
}

async function localPhysicalPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const physical = await realpath(cursor);
      return resolve(physical, ...suffix.reverse());
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(cursor.slice(parent.length + (parent === sep ? 0 : 1)));
      cursor = parent;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function assertNoOverlaps(
  catalogs: Map<string, { configuredPath: string; canonicalRoot: string }>,
  destinations: Map<string, { configuredPath: string; canonicalRoot: string }>,
  localRoots: readonly string[],
): void {
  const roots = [...catalogs.values(), ...destinations.values()];
  for (const [index, root] of roots.entries()) {
    if (
      localRoots.some((localRoot) =>
        rootsOverlap(root.canonicalRoot, localRoot),
      )
    ) {
      throw new Error(
        "Managed-work import roots must be outside local runtime, database, snapshot, and workspace roots",
      );
    }
    if (
      roots
        .slice(index + 1)
        .some((other) => rootsOverlap(root.canonicalRoot, other.canonicalRoot))
    ) {
      throw new Error(
        "Managed-work import catalog and destination roots must not overlap",
      );
    }
  }
}

async function resolveConfiguration(
  options: StandaloneManagedWorkImportOptions,
): Promise<ResolvedImportConfiguration> {
  const catalogEntries = assertPathMap(options.catalogs, "Import catalogs");
  const destinationEntries = assertPathMap(
    options.destinations,
    "Import destinations",
  );
  const catalogs = new Map<
    string,
    { configuredPath: string; canonicalRoot: string }
  >();
  const destinations = new Map<
    string,
    { configuredPath: string; canonicalRoot: string }
  >();
  for (const [id, path] of catalogEntries) {
    catalogs.set(id, {
      configuredPath: resolve(path),
      canonicalRoot: await existingDirectory(path),
    });
  }
  for (const [id, path] of destinationEntries) {
    destinations.set(id, {
      configuredPath: resolve(path),
      canonicalRoot: await destinationDirectory(path),
    });
  }
  const localRoots = await Promise.all(
    options.localRoots.map((path) => localPhysicalPath(path)),
  );
  assertNoOverlaps(catalogs, destinations, localRoots);
  return { catalogs, destinations, localRoots };
}

async function resolveSelectedRoots(
  sourceCatalogId: string,
  destinationId: string,
  catalog: { configuredPath: string; canonicalRoot: string },
  destination: { configuredPath: string; canonicalRoot: string },
  options: StandaloneManagedWorkImportOptions,
  localRoots: readonly string[],
): Promise<{
  catalog: { configuredPath: string; canonicalRoot: string };
  destination: { configuredPath: string; canonicalRoot: string };
}> {
  if (
    resolve(options.catalogs[sourceCatalogId] ?? "") !==
      catalog.configuredPath ||
    resolve(options.destinations[destinationId] ?? "") !==
      destination.configuredPath
  ) {
    throw new Error(
      "Managed-work import configured IDs changed during preparation",
    );
  }
  const currentCatalog = {
    ...catalog,
    canonicalRoot: await existingDirectory(catalog.configuredPath),
  };
  const currentDestination = {
    ...destination,
    canonicalRoot: await destinationDirectory(destination.configuredPath),
  };
  const selectedCatalog = new Map([["selected", currentCatalog]]);
  const selectedDestination = new Map([["selected", currentDestination]]);
  assertNoOverlaps(selectedCatalog, selectedDestination, localRoots);
  return { catalog: currentCatalog, destination: currentDestination };
}

function assertSameBinding(
  actual: ManagedWorkImportHostBinding,
  expected: ManagedWorkImportHostBinding,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Managed-work import host binding changed during preparation",
    );
  }
}

function assertKnownToolSelection(
  selection: unknown,
  property: string,
  supportedToolNames: ReadonlySet<string>,
): void {
  if (selection === undefined) return;
  const names: unknown[] = [];
  if (Array.isArray(selection)) {
    names.push(...selection);
  } else if (isRecord(selection)) {
    if (
      Object.keys(selection).some((key) => key !== "add" && key !== "remove")
    ) {
      throw new Error(`Imported Pi ${property} selection is unsupported`);
    }
    for (const value of Object.values(selection)) {
      if (!Array.isArray(value)) {
        throw new Error(`Imported Pi ${property} selection is malformed`);
      }
      names.push(...value);
    }
  } else {
    throw new Error(`Imported Pi ${property} selection is malformed`);
  }
  if (
    names.some(
      (name) => typeof name !== "string" || !supportedToolNames.has(name),
    )
  ) {
    throw new Error(
      `Imported Pi ${property} selection includes unsupported tools`,
    );
  }
}

function assertActualCheckpointProfile(
  checkpoint: ManagedWorkCheckpoint,
  options: StandaloneManagedWorkImportOptions,
): void {
  const rootAgent = checkpoint.documents.find(
    ({ record }) =>
      record.kind === "pi.agent" &&
      record.key === undefined &&
      record.scope.kind === "conversation" &&
      record.scope.conversationId === checkpoint.rootConversationId,
  );
  const selectedModel = rootAgent?.value.model;
  if (
    !rootAgent ||
    rootAgent.version !== 1 ||
    !isRecord(selectedModel) ||
    selectedModel.provider !== options.supportedModel.provider ||
    selectedModel.modelId !== options.supportedModel.modelId
  ) {
    throw new Error(
      "Imported Pi root model does not match the configured standalone model",
    );
  }
  const supportedTools = new Set(options.supportedToolNames);
  assertKnownToolSelection(rootAgent.value.tools, "tools", supportedTools);
  assertKnownToolSelection(
    rootAgent.value.modelTools,
    "modelTools",
    supportedTools,
  );
  const extensions = rootAgent.value.extensions;
  if (extensions !== undefined) {
    if (Array.isArray(extensions)) {
      if (extensions.length > 0) {
        throw new Error("Imported Pi root selects unsupported extensions");
      }
    } else if (!isRecord(extensions)) {
      throw new Error(
        "Imported Pi root extension configuration is unsupported",
      );
    } else {
      const add = extensions.add;
      const remove = extensions.remove;
      if (
        Object.keys(extensions).some(
          (key) => key !== "add" && key !== "remove",
        ) ||
        (add !== undefined && (!Array.isArray(add) || add.length > 0)) ||
        (remove !== undefined && !Array.isArray(remove))
      ) {
        throw new Error(
          "Imported Pi root extension configuration is unsupported",
        );
      }
    }
  }
}

async function destinationHasReceiptMarker(
  path: string,
  beforeAndAfterEffect?: () => Promise<void>,
): Promise<boolean> {
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    await beforeAndAfterEffect?.();
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      await beforeAndAfterEffect?.();
      throw error;
    }
    await beforeAndAfterEffect?.();
    return result;
  };
  try {
    const root = await guarded(() => lstat(path));
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    const metadata = await guarded(() => lstat(join(path, ".uzina")));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const receipt = await guarded(() =>
      lstat(join(path, ".uzina", "prepared-restore.json")),
    );
    return receipt.isFile() && !receipt.isSymbolicLink();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function assertMissingDestination(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("Managed-work import destination already exists");
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
}

async function runImport(
  request: ManagedWorkImportRequest,
  journal: ManagedWorkImportJournal,
  configuration: ResolvedImportConfiguration,
  options: StandaloneManagedWorkImportOptions,
): Promise<void> {
  const catalog = configuration.catalogs.get(request.sourceCatalogId);
  const destination = configuration.destinations.get(request.destinationId);
  if (!catalog || !destination) {
    throw new Error(
      "Managed-work import IDs are not configured on this standalone host",
    );
  }
  const binding: ManagedWorkImportHostBinding = {
    hostDescriptor: HOST_DESCRIPTOR,
    sourceCatalog: {
      sourceCatalogId: request.sourceCatalogId,
      canonicalRoot: catalog.canonicalRoot,
    },
    destination: {
      destinationId: request.destinationId,
      canonicalRoot: destination.canonicalRoot,
    },
  };
  const assertCurrentBinding = async () => {
    const before = journal.status(request.requestId);
    assertSameBinding(before.hostBinding, binding);
    const roots = await resolveSelectedRoots(
      request.sourceCatalogId,
      request.destinationId,
      catalog,
      destination,
      options,
      configuration.localRoots,
    );
    const actual: ManagedWorkImportHostBinding = {
      hostDescriptor: HOST_DESCRIPTOR,
      sourceCatalog: {
        sourceCatalogId: request.sourceCatalogId,
        canonicalRoot: roots.catalog.canonicalRoot,
      },
      destination: {
        destinationId: request.destinationId,
        canonicalRoot: roots.destination.canonicalRoot,
      },
    };
    assertSameBinding(actual, binding);
    const after = journal.status(request.requestId);
    assertSameBinding(after.hostBinding, binding);
    return roots;
  };

  let status = journal.admit(request, binding);
  if (status.status === "blocked") return;
  journal.status(request.requestId);
  const startedBeforeAttempt = status.status !== "admitted";
  let claimedFreshRestore = false;

  try {
    await assertCurrentBinding();
    if (status.status === "admitted") {
      try {
        await assertMissingDestination(destination.canonicalRoot);
      } catch {
        const current = journal.status(request.requestId);
        if (current.status === "admitted") {
          await journal.recordOutcome(request.requestId, binding, {
            status: "blocked",
            errorCode: "managed_work_import_destination_not_empty",
          });
          return;
        }
        throw new Error("Managed-work import admission changed before restore");
      }
      await assertCurrentBinding();
    } else {
      const hasReceipt = await destinationHasReceiptMarker(
        destination.canonicalRoot,
        async () => {
          await assertCurrentBinding();
        },
      );
      await assertCurrentBinding();
      if (!hasReceipt) {
        if (
          status.status === "preparing" ||
          status.status === "prepared-inactive"
        ) {
          await journal.recordOutcome(request.requestId, binding, {
            status: "uncertain",
            errorCode: UNCERTAIN_ERROR,
          });
        }
        return;
      }
    }

    const transport = new BoundedManagedWorkImportCatalog({
      canonicalRoot: catalog.canonicalRoot,
      manifestReference: request.manifestSha256,
      expectedRuntimeRequirements: options.supportedRuntimeRequirements,
      beforeAndAfterRead: async () => {
        await assertCurrentBinding();
      },
    });
    await transport.prepare();
    await assertCurrentBinding();
    const validation = await validateManagedWorkBundle(
      request.manifestSha256,
      transport,
      {
        supportedRuntimeRequirements: options.supportedRuntimeRequirements,
        beforeAndAfterEffect: async () => {
          await assertCurrentBinding();
        },
      },
    );
    assertActualCheckpointProfile(validation.managedWork, options);
    await assertCurrentBinding();

    if (status.status === "admitted") {
      const beforeStart = journal.status(request.requestId);
      assertSameBinding(beforeStart.hostBinding, binding);
      if (beforeStart.status !== "admitted") {
        throw new Error(
          "Managed-work import restore boundary was claimed elsewhere",
        );
      }
      status = journal.beginPreparation(request.requestId, binding);
      claimedFreshRestore = true;
    }
    if (
      status.status !== "preparing" &&
      status.status !== "prepared-inactive" &&
      status.status !== "uncertain"
    ) {
      return;
    }

    const roots = await assertCurrentBinding();
    const restored = await restoreManagedWorkBundle({
      manifestReference: request.manifestSha256,
      transport,
      destinationPath: roots.destination.canonicalRoot,
      allowFreshRestore: claimedFreshRestore,
      requireFreshDestination: claimedFreshRestore,
      beforeAndAfterEffect: async () => {
        await assertCurrentBinding();
      },
      supportedRuntimeRequirements: options.supportedRuntimeRequirements,
      openStorage: async (path) => {
        const storage = await openBunSqliteStorage(path);
        return {
          storage,
          close: () => storage.close(BACKGROUND_CONTEXT),
        };
      },
    });
    const finalRoots = await assertCurrentBinding();
    if (
      restored.destinationPath !== finalRoots.destination.canonicalRoot ||
      restored.receipt.manifestReference !== request.manifestSha256
    ) {
      throw new Error(
        "Prepared managed-work output does not match its host binding",
      );
    }
    const beforePublication = journal.status(request.requestId);
    assertSameBinding(beforePublication.hostBinding, binding);
    await journal.recordOutcome(request.requestId, binding, {
      status: "prepared-inactive",
      preparationReceipt: managedWorkImportPreparationReceiptSchema.parse(
        restored.receipt,
      ),
    });
    journal.status(request.requestId);
  } catch (error) {
    const current = journal.status(request.requestId);
    if (current.status === "admitted") {
      await journal.recordOutcome(request.requestId, binding, {
        status: "blocked",
        errorCode: BLOCKED_ERROR,
      });
    } else if (
      (claimedFreshRestore || startedBeforeAttempt) &&
      (current.status === "preparing" || current.status === "prepared-inactive")
    ) {
      await journal.recordOutcome(request.requestId, binding, {
        status: "uncertain",
        errorCode: UNCERTAIN_ERROR,
      });
    } else if (
      current.status !== "uncertain" &&
      current.status !== "prepared-inactive" &&
      current.status !== "blocked"
    ) {
      throw error;
    }
  }
}

export interface StandaloneManagedWorkImportHost extends ManagedWorkImportHost {
  close(): Promise<void>;
}

/** Resolve only configured roots; shutdown rejects admission and joins finite owned requests. */
export async function createStandaloneManagedWorkImportHost(
  options: StandaloneManagedWorkImportOptions,
): Promise<StandaloneManagedWorkImportHost> {
  const configuration = await resolveConfiguration(options);
  const running = new Map<
    string,
    { requestJson: string; promise: Promise<void> }
  >();
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  return {
    async run(request, journal) {
      if (!accepting)
        throw new Error("Standalone managed-work import host is closing");
      const requestJson = JSON.stringify(request);
      const existing = running.get(request.requestId);
      if (existing) {
        if (existing.requestJson !== requestJson) {
          throw new Error("Managed-work import request ID is already in use");
        }
        await existing.promise;
        return;
      }
      const promise = runImport(request, journal, configuration, options);
      running.set(request.requestId, { requestJson, promise });
      try {
        await promise;
      } finally {
        if (running.get(request.requestId)?.promise === promise) {
          running.delete(request.requestId);
        }
      }
    },
    close() {
      if (closePromise) return closePromise;
      accepting = false;
      const pending = [...running.values()].map(({ promise }) => promise);
      closePromise = (async () => {
        const results = await Promise.allSettled(pending);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(
            failures,
            "Standalone managed-work import operations failed while closing",
          );
        }
      })();
      return closePromise;
    },
  };
}
