import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import {
  importManagedWorkCheckpoint,
  validateManagedWorkCheckpoint,
  verifyManagedWorkCheckpointStorage,
  type ManagedWorkCheckpoint,
} from "@uzina/pi-runtime/checkpoint";
import {
  captureWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  validateWorkspaceCheckpoint,
  verifyRestoredWorkspaceCheckpoint,
  WORKSPACE_CHECKPOINT_ATTACHMENT_MAX_BYTES,
  WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
  type BlobTransport,
  type CheckpointAttachment,
} from "./index";
import {
  canonicalManagedWorkJson,
  composeManagedWorkBundleFromWorkspace,
  managedWorkBundleChecksum,
  parseManagedWorkBundleManifestBytes,
  prepareManagedWorkBundleComposition,
  type CapturedManagedWorkBundle,
  type ManagedWorkBundleCompositionOptions,
  type ManagedWorkBundleManifest,
} from "./managed-work-composition";

export {
  MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
  MANAGED_WORK_BUNDLE_FORMAT,
  MANAGED_WORK_BUNDLE_VERSION,
  MANAGED_WORK_PROFILE,
} from "./managed-work-composition";
export type {
  CapturedManagedWorkBundle,
  ManagedWorkBundleManifest,
} from "./managed-work-composition";

const RUNTIME_REQUIREMENTS = [
  "managed-work-profile:quiescent-current-documents-no-forks-v1",
  "pi-durable:1.5.2",
] as const;
const PREPARED_RECEIPT_FORMAT = "uzina-prepared-managed-work-restore" as const;

export interface ManagedWorkBundleCaptureOptions extends ManagedWorkBundleCompositionOptions {
  managedWork: ManagedWorkCheckpoint;
  workspacePath: string;
  transport: BlobTransport;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

export interface PreparedManagedWorkRestoreReceipt {
  format: typeof PREPARED_RECEIPT_FORMAT;
  version: 1;
  status: "prepared-inactive";
  receiptId: string;
  manifestReference: string;
  preparedAt: string;
  workspacePath: string;
  runtimePath: string;
  attachmentNames: string[];
}

export interface ManagedWorkRestoreStorage {
  storage: Storage;
  close(): Promise<void>;
}

export interface RestoreManagedWorkBundleOptions {
  manifestReference: string;
  transport: BlobTransport;
  destinationPath: string;
  /** Recovery may verify an existing output but must never start a fresh restore. */
  allowFreshRestore?: boolean;
  /** A first local journal admission may not adopt any preexisting output root. */
  requireFreshDestination?: boolean;
  beforeAndAfterEffect?: () => Promise<void>;
  supportedRuntimeRequirements?: readonly string[];
  openStorage(path: string): Promise<ManagedWorkRestoreStorage>;
}

export interface RestoredManagedWorkBundle {
  receipt: PreparedManagedWorkRestoreReceipt;
  destinationPath: string;
  workspacePath: string;
  runtimePath: string;
  provenanceAttachments: Array<{
    attachment: CheckpointAttachment;
    bytes: Uint8Array;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPreparedReceipt(
  path: string,
  beforeAndAfterEffect?: () => Promise<void>,
): Promise<unknown> {
  if (!constants.O_NOFOLLOW) {
    throw new Error("This host cannot safely read a prepared receipt");
  }
  const guarded = <T>(operation: () => Promise<T>) =>
    guardedRestoreEffect(beforeAndAfterEffect, operation);
  const before = await guarded(() => lstat(path));
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Prepared receipt is not a regular file");
  }
  await beforeAndAfterEffect?.();
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    await beforeAndAfterEffect?.();
    throw error;
  }
  try {
    await beforeAndAfterEffect?.();
    const opened = await guarded(() => file.stat());
    if (
      !opened.isFile() ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 1 ||
      opened.size > WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("Prepared receipt exceeds its bounded read limit");
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const end = Math.min(offset + 64 * 1024, opened.size);
      const { bytesRead } = await guarded(() =>
        file.read(bytes, offset, end - offset, offset),
      );
      if (bytesRead === 0) {
        throw new Error("Prepared receipt was truncated during read");
      }
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraRead = await guarded(() => file.read(extra, 0, 1, opened.size));
    const final = await guarded(() => file.stat());
    const after = await guarded(() => lstat(path));
    if (
      offset !== opened.size ||
      extraRead.bytesRead !== 0 ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    ) {
      throw new Error("Prepared receipt changed during read");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await file.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBundle(
  manifestReference: string,
  transport: BlobTransport,
  beforeAndAfterEffect?: () => Promise<void>,
): Promise<ManagedWorkBundleManifest> {
  if (!/^[a-f0-9]{64}$/.test(manifestReference)) {
    throw new Error("Managed-work bundle reference is not a SHA-256 digest");
  }
  const bytes = await guardedRestoreEffect(beforeAndAfterEffect, () =>
    transport.getBlob(manifestReference),
  );
  if (bytes.byteLength > WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES) {
    throw new Error("Managed-work bundle manifest exceeds its size limit");
  }
  const value = parseManagedWorkBundleManifestBytes(bytes, manifestReference);
  const workspaceBytes = await guardedRestoreEffect(beforeAndAfterEffect, () =>
    transport.getBlob(value.workspaceManifestReference),
  );
  if (workspaceBytes.byteLength > WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES) {
    throw new Error("Workspace manifest exceeds its size limit");
  }
  if (sha256(workspaceBytes) !== value.workspaceManifestReference) {
    throw new Error("Workspace manifest content hash mismatch");
  }
  let workspaceManifest: unknown;
  try {
    workspaceManifest = JSON.parse(
      Buffer.from(workspaceBytes).toString("utf8"),
    );
  } catch {
    throw new Error("Workspace manifest is not valid JSON");
  }
  if (
    canonicalManagedWorkJson(workspaceManifest) !==
    canonicalManagedWorkJson(value.workspace)
  ) {
    throw new Error(
      "Managed-work bundle workspace manifest/reference mismatch",
    );
  }
  return value;
}

async function validateBundleResources(
  manifest: ManagedWorkBundleManifest,
  transport: BlobTransport,
  supportedRuntimeRequirements: readonly string[] = RUNTIME_REQUIREMENTS,
  beforeAndAfterEffect?: () => Promise<void>,
): Promise<ManagedWorkCheckpoint> {
  const supported = assertSupportedBundleRequirements(
    manifest,
    supportedRuntimeRequirements,
  );
  const validation = await validateWorkspaceCheckpoint(
    manifest.workspace,
    transport,
    {
      supportedRuntimeFormats: [1],
      supportedRuntimeRequirements: [...supported],
      beforeAndAfterEffect,
    },
  );
  if (!validation.valid) {
    throw new Error(
      `Managed-work bundle validation failed: ${validation.issues.join("; ")}`,
    );
  }
  return validateBundleRuntime(
    manifest,
    transport,
    supportedRuntimeRequirements,
    beforeAndAfterEffect,
  );
}

function assertSupportedBundleRequirements(
  manifest: ManagedWorkBundleManifest,
  supportedRuntimeRequirements: readonly string[],
): Set<string> {
  const supported = new Set([
    ...RUNTIME_REQUIREMENTS,
    ...supportedRuntimeRequirements,
  ]);
  const unsupported = manifest.runtime.requirements.filter(
    (requirement) => !supported.has(requirement),
  );
  if (unsupported.length) {
    throw new Error(
      `Unsupported runtime requirements: ${unsupported.join(", ")}`,
    );
  }
  return supported;
}

async function validateBundleRuntime(
  manifest: ManagedWorkBundleManifest,
  transport: BlobTransport,
  supportedRuntimeRequirements: readonly string[] = RUNTIME_REQUIREMENTS,
  beforeAndAfterEffect?: () => Promise<void>,
): Promise<ManagedWorkCheckpoint> {
  assertSupportedBundleRequirements(manifest, supportedRuntimeRequirements);
  const artifact = manifest.workspace.runtimeArtifact;
  if (
    !artifact ||
    artifact.formatVersion !== manifest.runtime.formatVersion ||
    artifact.mediaType !== manifest.runtime.mediaType ||
    JSON.stringify([...artifact.compatibilityRequirements].sort()) !==
      JSON.stringify([...manifest.runtime.requirements].sort())
  ) {
    throw new Error(
      "Managed-work bundle has no compatible Pi runtime artifact",
    );
  }
  const bytes = await guardedRestoreEffect(beforeAndAfterEffect, () =>
    transport.getBlob(artifact.artifact.reference),
  );
  if (
    bytes.byteLength !== artifact.artifact.size ||
    sha256(bytes) !== artifact.artifact.sha256
  ) {
    throw new Error("Managed-work runtime artifact integrity mismatch");
  }
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Managed-work runtime artifact is not valid JSON");
  }
  const validated = await validateManagedWorkCheckpoint(checkpoint);
  if (
    validated.profile !== manifest.profile ||
    validated.rootConversationId !== ROOT_CONVERSATION_ID
  ) {
    throw new Error("Managed-work runtime profile does not match its bundle");
  }
  return validated;
}

/** Capture workspace state locally, then delegate v1 bundle composition. */
export async function captureManagedWorkBundle(
  options: ManagedWorkBundleCaptureOptions,
): Promise<CapturedManagedWorkBundle> {
  const prepared = await prepareManagedWorkBundleComposition({
    managedWork: options.managedWork,
    compatibilityRequirements: options.compatibilityRequirements,
    attachments: options.attachments,
    limits: options.limits,
  });
  const capturedWorkspace = await captureWorkspaceCheckpoint({
    workspacePath: options.workspacePath,
    transport: options.transport,
    includeGlobs: options.includeGlobs,
    excludeGlobs: options.excludeGlobs,
    limits: options.limits,
  });
  return composeManagedWorkBundleFromWorkspace({
    prepared,
    workspaceManifest: capturedWorkspace.manifest,
    workspaceManifestReference: capturedWorkspace.manifestReference,
    workspaceManifestBytes: capturedWorkspace.manifestBytes,
    transport: options.transport,
  });
}

/** Validate all manifest, compatibility, workspace and managed-runtime resources. */
export async function validateManagedWorkBundle(
  manifestReference: string,
  transport: BlobTransport,
  options: {
    supportedRuntimeRequirements?: readonly string[];
    beforeAndAfterEffect?: () => Promise<void>;
  } = {},
): Promise<{
  manifest: ManagedWorkBundleManifest;
  managedWork: ManagedWorkCheckpoint;
}> {
  const manifest = await readBundle(
    manifestReference,
    transport,
    options.beforeAndAfterEffect,
  );
  const managedWork = await validateBundleResources(
    manifest,
    transport,
    options.supportedRuntimeRequirements,
    options.beforeAndAfterEffect,
  );
  return { manifest, managedWork };
}

async function preparedReceipt(
  destinationPath: string,
  manifestReference: string,
  beforeAndAfterEffect?: () => Promise<void>,
): Promise<PreparedManagedWorkRestoreReceipt | undefined> {
  let guardFailed = false;
  let guardFailure: unknown;
  const trackedGuard = beforeAndAfterEffect
    ? async () => {
        try {
          await beforeAndAfterEffect();
        } catch (error) {
          guardFailed = true;
          guardFailure = error;
          throw error;
        }
      }
    : undefined;
  const guarded = <T>(operation: () => Promise<T>) =>
    guardedRestoreEffect(trackedGuard, operation);
  try {
    const destination = await guarded(() => lstat(destinationPath));
    if (!destination.isDirectory() || destination.isSymbolicLink()) {
      return undefined;
    }
    const metadataDirectory = await guarded(() =>
      lstat(join(destinationPath, ".uzina")),
    );
    const receiptPath = join(
      destinationPath,
      ".uzina",
      "prepared-restore.json",
    );
    const receipt = await guarded(() => lstat(receiptPath));
    if (
      !metadataDirectory.isDirectory() ||
      metadataDirectory.isSymbolicLink() ||
      !receipt.isFile() ||
      receipt.isSymbolicLink()
    ) {
      return undefined;
    }
    const value = await readPreparedReceipt(receiptPath, trackedGuard);
    if (
      !isRecord(value) ||
      value.format !== PREPARED_RECEIPT_FORMAT ||
      value.version !== 1 ||
      value.status !== "prepared-inactive" ||
      value.manifestReference !== manifestReference ||
      value.receiptId !==
        managedWorkBundleChecksum({ manifestReference, destinationPath }) ||
      typeof value.preparedAt !== "string" ||
      !Number.isFinite(Date.parse(value.preparedAt)) ||
      value.workspacePath !== "workspace" ||
      value.runtimePath !== "managed-work.sqlite" ||
      !Array.isArray(value.attachmentNames) ||
      value.attachmentNames.some(
        (name) =>
          typeof name !== "string" ||
          !name ||
          name.length > 256 ||
          name.includes("/") ||
          name.includes("\\") ||
          name === "." ||
          name === "..",
      )
    ) {
      return undefined;
    }
    const workspace = await guarded(() =>
      lstat(join(destinationPath, "workspace")),
    );
    const runtime = await guarded(() =>
      lstat(join(destinationPath, "managed-work.sqlite")),
    );
    if (
      !workspace.isDirectory() ||
      workspace.isSymbolicLink() ||
      !runtime.isFile() ||
      runtime.isSymbolicLink()
    ) {
      return undefined;
    }
    if (value.attachmentNames.length) {
      const attachmentDirectory = await guarded(() =>
        lstat(join(destinationPath, ".uzina", "attachments")),
      );
      if (
        !attachmentDirectory.isDirectory() ||
        attachmentDirectory.isSymbolicLink()
      ) {
        return undefined;
      }
      for (const name of value.attachmentNames) {
        const attachment = await guarded(() =>
          lstat(join(destinationPath, ".uzina", "attachments", name as string)),
        );
        if (!attachment.isFile() || attachment.isSymbolicLink()) {
          return undefined;
        }
      }
    }
    return value as unknown as PreparedManagedWorkRestoreReceipt;
  } catch (error) {
    if (guardFailed && error === guardFailure) throw error;
    return undefined;
  }
}

type RestoreEffectGuard =
  RestoreManagedWorkBundleOptions["beforeAndAfterEffect"];

async function guardedRestoreEffect<T>(
  guard: RestoreEffectGuard,
  operation: () => Promise<T>,
): Promise<T> {
  await guard?.();
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await guard?.();
    throw error;
  }
  await guard?.();
  return result;
}

async function guardedRestoreAcquire<T>(
  guard: RestoreEffectGuard,
  operation: () => Promise<T>,
  takeOwnership: (resource: T) => void,
): Promise<T> {
  await guard?.();
  const resource = await operation();
  takeOwnership(resource);
  await guard?.();
  return resource;
}

async function hashPreparedAttachment(
  path: string,
  expectedSize: number,
  name: string,
  beforeAndAfterEffect: RestoreEffectGuard,
): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await guardedRestoreAcquire(
      beforeAndAfterEffect,
      () => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
      (resource) => {
        file = resource;
      },
    );
    const opened = await guardedRestoreEffect(beforeAndAfterEffect, () =>
      file!.stat(),
    );
    if (
      !opened.isFile() ||
      opened.size !== expectedSize ||
      opened.size > WORKSPACE_CHECKPOINT_ATTACHMENT_MAX_BYTES
    ) {
      throw new Error(`Prepared attachment size mismatch: ${name}`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let totalBytes = 0;
    while (totalBytes < expectedSize) {
      const { bytesRead } = await guardedRestoreEffect(
        beforeAndAfterEffect,
        () =>
          file!.read(
            buffer,
            0,
            Math.min(buffer.byteLength, expectedSize - totalBytes),
            totalBytes,
          ),
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    const extraByte = Buffer.alloc(1);
    const extra = await guardedRestoreEffect(beforeAndAfterEffect, () =>
      file!.read(extraByte, 0, 1, expectedSize),
    );
    const finalStat = await guardedRestoreEffect(beforeAndAfterEffect, () =>
      file!.stat(),
    );
    const pathStat = await guardedRestoreEffect(beforeAndAfterEffect, () =>
      lstat(path),
    );
    if (
      totalBytes !== expectedSize ||
      extra.bytesRead > 0 ||
      finalStat.size !== expectedSize ||
      pathStat.size !== expectedSize ||
      pathStat.dev !== opened.dev ||
      pathStat.ino !== opened.ino
    ) {
      throw new Error(`Prepared attachment size mismatch: ${name}`);
    }
    return digest.digest("hex");
  } finally {
    await file?.close();
  }
}

async function verifyPreparedDestination(
  destinationPath: string,
  receipt: PreparedManagedWorkRestoreReceipt,
  manifest: ManagedWorkBundleManifest,
  managedWork: ManagedWorkCheckpoint,
  transport: BlobTransport,
  openStorage: RestoreManagedWorkBundleOptions["openStorage"],
  beforeAndAfterEffect: RestoreEffectGuard,
): Promise<void> {
  await guardedRestoreEffect(beforeAndAfterEffect, () =>
    verifyRestoredWorkspaceCheckpoint(
      manifest.workspace,
      transport,
      join(destinationPath, receipt.workspacePath),
      beforeAndAfterEffect,
    ),
  );
  const expectedAttachmentNames = manifest.workspace.attachments.map(
    ({ name }) => name,
  );
  if (
    JSON.stringify(receipt.attachmentNames) !==
    JSON.stringify(expectedAttachmentNames)
  ) {
    throw new Error(
      "Prepared restore attachment receipt does not match bundle",
    );
  }
  let runtime: ManagedWorkRestoreStorage | undefined;
  try {
    await guardedRestoreAcquire(
      beforeAndAfterEffect,
      () => openStorage(join(destinationPath, receipt.runtimePath)),
      (resource) => {
        runtime = resource;
      },
    );
    await guardedRestoreEffect(beforeAndAfterEffect, () =>
      verifyManagedWorkCheckpointStorage(
        runtime!.storage,
        managedWork,
        beforeAndAfterEffect,
      ),
    );
  } finally {
    await runtime?.close();
  }

  const attachmentDirectory = join(destinationPath, ".uzina", "attachments");
  if (expectedAttachmentNames.length === 0) {
    try {
      await guardedRestoreEffect(beforeAndAfterEffect, () =>
        lstat(attachmentDirectory),
      );
      throw new Error("Prepared restore has unexpected attachments");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return;
  }
  const directory = await guardedRestoreEffect(beforeAndAfterEffect, () =>
    lstat(attachmentDirectory),
  );
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Prepared restore attachments are unavailable");
  }
  const actualNames = (
    await guardedRestoreEffect(beforeAndAfterEffect, () =>
      readdir(attachmentDirectory),
    )
  ).sort();
  if (
    JSON.stringify(actualNames) !==
    JSON.stringify([...expectedAttachmentNames].sort())
  ) {
    throw new Error("Prepared restore attachments do not match bundle");
  }
  for (const attachment of manifest.workspace.attachments) {
    const path = join(attachmentDirectory, attachment.name);
    const details = await guardedRestoreEffect(beforeAndAfterEffect, () =>
      lstat(path),
    );
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(
        `Prepared attachment is not a regular file: ${attachment.name}`,
      );
    }
    if (
      attachment.blob.size > WORKSPACE_CHECKPOINT_ATTACHMENT_MAX_BYTES ||
      details.size !== attachment.blob.size
    ) {
      throw new Error(`Prepared attachment size mismatch: ${attachment.name}`);
    }
    const actualDigest = await hashPreparedAttachment(
      path,
      attachment.blob.size,
      attachment.name,
      beforeAndAfterEffect,
    );
    if (actualDigest !== attachment.blob.sha256) {
      throw new Error(
        `Prepared attachment integrity mismatch: ${attachment.name}`,
      );
    }
  }
}

async function assertMissingDestination(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("Fresh managed-work import destination already exists");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
}

async function assertEmptyOrMissingDestination(
  path: string,
  beforeAndAfterEffect?: RestoreEffectGuard,
): Promise<void> {
  try {
    const details = await guardedRestoreEffect(beforeAndAfterEffect, () =>
      lstat(path),
    );
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(
        "Restore destination must be an empty inactive directory",
      );
    }
    if (
      (await guardedRestoreEffect(beforeAndAfterEffect, () => readdir(path)))
        .length > 0
    ) {
      throw new Error(
        "Restore destination is not empty and has no matching prepared receipt",
      );
    }
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Stage workspace and Pi records together, write a stable inactive receipt, then
 * place the whole prepared root with one directory rename. No Harness is opened.
 */
export async function restoreManagedWorkBundle(
  options: RestoreManagedWorkBundleOptions,
): Promise<RestoredManagedWorkBundle> {
  const destinationPath = resolve(options.destinationPath);
  const guardedEffect = <T>(operation: () => Promise<T>) =>
    guardedRestoreEffect(options.beforeAndAfterEffect, operation);
  const guardedAcquire = <T>(
    operation: () => Promise<T>,
    takeOwnership: (resource: T) => void,
  ) =>
    guardedRestoreAcquire(
      options.beforeAndAfterEffect,
      operation,
      takeOwnership,
    );
  if (options.requireFreshDestination) {
    await guardedEffect(() => assertMissingDestination(destinationPath));
  }
  let existingReceipt: PreparedManagedWorkRestoreReceipt | undefined;
  if (options.allowFreshRestore === false) {
    existingReceipt = await guardedEffect(() =>
      preparedReceipt(
        destinationPath,
        options.manifestReference,
        options.beforeAndAfterEffect,
      ),
    );
    if (!existingReceipt) {
      throw new Error(
        "A prior restore was recorded, but its exact prepared output is unavailable",
      );
    }
  }
  const manifest = await guardedEffect(() =>
    readBundle(
      options.manifestReference,
      options.transport,
      options.beforeAndAfterEffect,
    ),
  );
  if (!options.requireFreshDestination) {
    existingReceipt ??= await guardedEffect(() =>
      preparedReceipt(
        destinationPath,
        options.manifestReference,
        options.beforeAndAfterEffect,
      ),
    );
  }
  const managedWork = await guardedEffect(() =>
    existingReceipt
      ? validateBundleRuntime(
          manifest,
          options.transport,
          options.supportedRuntimeRequirements,
          options.beforeAndAfterEffect,
        )
      : validateBundleResources(
          manifest,
          options.transport,
          options.supportedRuntimeRequirements,
          options.beforeAndAfterEffect,
        ),
  );
  if (existingReceipt) {
    await guardedEffect(() =>
      verifyPreparedDestination(
        destinationPath,
        existingReceipt,
        manifest,
        managedWork,
        options.transport,
        options.openStorage,
        options.beforeAndAfterEffect,
      ),
    );
    return {
      receipt: existingReceipt,
      destinationPath,
      workspacePath: join(destinationPath, existingReceipt.workspacePath),
      runtimePath: join(destinationPath, existingReceipt.runtimePath),
      provenanceAttachments: [],
    };
  }
  await guardedEffect(() =>
    options.requireFreshDestination
      ? assertMissingDestination(destinationPath)
      : assertEmptyOrMissingDestination(
          destinationPath,
          options.beforeAndAfterEffect,
        ),
  );

  const parent = dirname(destinationPath);
  await guardedEffect(() => mkdir(parent, { recursive: true }));
  let stagingRoot: string | undefined;
  let restoredAttachments: RestoredManagedWorkBundle["provenanceAttachments"] =
    [];
  try {
    const ownedStagingRoot = await guardedAcquire(
      () => mkdtemp(join(parent, ".uzina-prepared-restore-")),
      (resource) => {
        stagingRoot = resource;
      },
    );
    const stagedWorkspace = join(ownedStagingRoot, "workspace");
    const stagedRuntime = join(ownedStagingRoot, "managed-work.sqlite");
    const restored = await guardedEffect(() =>
      restoreWorkspaceCheckpoint({
        manifest: manifest.workspace,
        transport: options.transport,
        destinationPath: stagedWorkspace,
        supportedRuntimeFormats: [1],
        supportedRuntimeRequirements: [
          ...new Set([
            ...RUNTIME_REQUIREMENTS,
            ...(options.supportedRuntimeRequirements ?? []),
          ]),
        ],
        beforeAndAfterEffect: options.beforeAndAfterEffect,
      }),
    );
    const runtimeArtifact = restored.runtimeArtifact;
    if (!runtimeArtifact) {
      throw new Error("Managed-work bundle runtime artifact is missing");
    }
    let runtime: ManagedWorkRestoreStorage | undefined;
    try {
      runtime = await guardedAcquire(
        () => options.openStorage(stagedRuntime),
        (resource) => {
          runtime = resource;
        },
      );
      await guardedEffect(() =>
        importManagedWorkCheckpoint(
          runtime!.storage,
          JSON.parse(Buffer.from(runtimeArtifact.bytes).toString("utf8")),
          undefined,
          options.beforeAndAfterEffect,
        ),
      );
    } finally {
      await runtime?.close();
    }
    restoredAttachments = restored.attachments;
    const metadataDirectory = join(ownedStagingRoot, ".uzina");
    await guardedEffect(() => mkdir(metadataDirectory, { recursive: true }));
    const attachmentDirectory = join(metadataDirectory, "attachments");
    if (restoredAttachments.length) {
      await guardedEffect(() =>
        mkdir(attachmentDirectory, { recursive: true }),
      );
      for (const item of restoredAttachments) {
        await guardedEffect(() =>
          writeFile(
            join(attachmentDirectory, item.attachment.name),
            item.bytes,
            { flag: "wx" },
          ),
        );
      }
    }
    const receipt: PreparedManagedWorkRestoreReceipt = {
      format: PREPARED_RECEIPT_FORMAT,
      version: 1,
      status: "prepared-inactive",
      receiptId: managedWorkBundleChecksum({
        manifestReference: options.manifestReference,
        destinationPath,
      }),
      manifestReference: options.manifestReference,
      preparedAt: new Date().toISOString(),
      workspacePath: "workspace",
      runtimePath: "managed-work.sqlite",
      attachmentNames: restoredAttachments.map(
        ({ attachment }) => attachment.name,
      ),
    };
    await guardedEffect(() =>
      writeFile(
        join(metadataDirectory, "prepared-restore.json"),
        JSON.stringify(receipt),
        { flag: "wx" },
      ),
    );
    if (options.requireFreshDestination) {
      await guardedEffect(() => assertMissingDestination(destinationPath));
    }
    await guardedEffect(() => rename(ownedStagingRoot, destinationPath));
    return {
      receipt,
      destinationPath,
      workspacePath: stagedWorkspace.replace(ownedStagingRoot, destinationPath),
      runtimePath: stagedRuntime.replace(ownedStagingRoot, destinationPath),
      provenanceAttachments: restoredAttachments,
    };
  } catch (error) {
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    const racedReceipt = await guardedEffect(() =>
      preparedReceipt(
        destinationPath,
        options.manifestReference,
        options.beforeAndAfterEffect,
      ),
    );
    if (racedReceipt) {
      await guardedEffect(() =>
        verifyPreparedDestination(
          destinationPath,
          racedReceipt,
          manifest,
          managedWork,
          options.transport,
          options.openStorage,
          options.beforeAndAfterEffect,
        ),
      );
      return {
        receipt: racedReceipt,
        destinationPath,
        workspacePath: join(destinationPath, racedReceipt.workspacePath),
        runtimePath: join(destinationPath, racedReceipt.runtimePath),
        provenanceAttachments: [],
      };
    }
    throw error;
  }
}
