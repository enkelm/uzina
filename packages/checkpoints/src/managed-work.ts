import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  mkdtemp,
  readFile,
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
  type CaptureLimits,
  type WorkspaceCheckpointManifest,
} from "./index";

export const MANAGED_WORK_BUNDLE_FORMAT =
  "uzina-coherent-managed-work-checkpoint" as const;
export const MANAGED_WORK_BUNDLE_VERSION = 1 as const;
export const MANAGED_WORK_PROFILE =
  "quiescent-current-documents-no-forks-v1" as const;
export const MANAGED_WORK_ARTIFACT_MEDIA_TYPE =
  "application/vnd.uzina.managed-work+json" as const;

const RUNTIME_REQUIREMENTS = [
  "managed-work-profile:quiescent-current-documents-no-forks-v1",
  "pi-durable:1.4.0",
] as const;
const PREPARED_RECEIPT_FORMAT = "uzina-prepared-managed-work-restore" as const;

export interface ManagedWorkBundleManifest {
  format: typeof MANAGED_WORK_BUNDLE_FORMAT;
  version: typeof MANAGED_WORK_BUNDLE_VERSION;
  profile: typeof MANAGED_WORK_PROFILE;
  runtime: {
    formatVersion: 1;
    mediaType: typeof MANAGED_WORK_ARTIFACT_MEDIA_TYPE;
    requirements: string[];
  };
  workspaceManifestReference: string;
  workspace: WorkspaceCheckpointManifest;
  sha256: string;
}

type ManagedWorkBundleBody = Omit<ManagedWorkBundleManifest, "sha256">;

export interface ManagedWorkBundleCaptureOptions {
  managedWork: ManagedWorkCheckpoint;
  compatibilityRequirements?: string[];
  workspacePath: string;
  transport: BlobTransport;
  attachments?: Array<{ name: string; mediaType: string; bytes: Uint8Array }>;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  limits?: CaptureLimits;
}

export interface CapturedManagedWorkBundle {
  manifest: ManagedWorkBundleManifest;
  manifestReference: string;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Bundle contains non-JSON data");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bundleChecksum(value: unknown): string {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBundle(
  value: unknown,
): asserts value is ManagedWorkBundleManifest {
  if (
    !isRecord(value) ||
    value.format !== MANAGED_WORK_BUNDLE_FORMAT ||
    value.version !== MANAGED_WORK_BUNDLE_VERSION ||
    value.profile !== MANAGED_WORK_PROFILE ||
    typeof value.sha256 !== "string" ||
    !isRecord(value.runtime) ||
    Object.keys(value).some(
      (key) =>
        ![
          "format",
          "version",
          "profile",
          "runtime",
          "workspaceManifestReference",
          "workspace",
          "sha256",
        ].includes(key),
    ) ||
    Object.keys(value.runtime).some(
      (key) => !["formatVersion", "mediaType", "requirements"].includes(key),
    ) ||
    value.runtime.formatVersion !== 1 ||
    value.runtime.mediaType !== MANAGED_WORK_ARTIFACT_MEDIA_TYPE ||
    !Array.isArray(value.runtime.requirements) ||
    typeof value.workspaceManifestReference !== "string" ||
    !isRecord(value.workspace)
  ) {
    throw new Error("Unsupported or malformed coherent managed-work bundle");
  }
}

async function readBundle(
  manifestReference: string,
  transport: BlobTransport,
): Promise<ManagedWorkBundleManifest> {
  if (!/^[a-f0-9]{64}$/.test(manifestReference)) {
    throw new Error("Managed-work bundle reference is not a SHA-256 digest");
  }
  const bytes = await transport.getBlob(manifestReference);
  if (bytes.byteLength > WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES) {
    throw new Error("Managed-work bundle manifest exceeds its size limit");
  }
  if (sha256(bytes) !== manifestReference) {
    throw new Error("Managed-work bundle manifest content hash mismatch");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Managed-work bundle manifest is not valid JSON");
  }
  assertBundle(value);
  const { sha256: digest, ...body } = value;
  if (bundleChecksum(body) !== digest) {
    throw new Error("Managed-work bundle manifest checksum mismatch");
  }
  if (
    !/^[a-f0-9]{64}$/.test(value.workspaceManifestReference) ||
    value.runtime.requirements.some(
      (requirement) => typeof requirement !== "string",
    ) ||
    new Set(value.runtime.requirements).size !==
      value.runtime.requirements.length ||
    RUNTIME_REQUIREMENTS.some(
      (requirement) => !value.runtime.requirements.includes(requirement),
    )
  ) {
    throw new Error("Managed-work bundle runtime requirements are unsupported");
  }
  const workspaceBytes = await transport.getBlob(
    value.workspaceManifestReference,
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
  if (canonicalJson(workspaceManifest) !== canonicalJson(value.workspace)) {
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
  const bytes = await transport.getBlob(artifact.artifact.reference);
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

/** Compose the public Pi logical profile and existing workspace packer into one bundle. */
export async function captureManagedWorkBundle(
  options: ManagedWorkBundleCaptureOptions,
): Promise<CapturedManagedWorkBundle> {
  const managedWork = await validateManagedWorkCheckpoint(options.managedWork);
  if (managedWork.rootConversationId !== ROOT_CONVERSATION_ID) {
    throw new Error("Managed-work checkpoint must use the reserved root");
  }
  const runtimeBytes = Buffer.from(canonicalJson(managedWork), "utf8");
  const requirements = [
    ...new Set([
      ...RUNTIME_REQUIREMENTS,
      ...(options.compatibilityRequirements ?? []),
    ]),
  ];
  if (
    requirements.some(
      (requirement) =>
        !requirement.trim() ||
        requirement.length > 256 ||
        /[\r\n]/.test(requirement),
    )
  ) {
    throw new Error("Managed-work compatibility requirements are invalid");
  }
  const capturedWorkspace = await captureWorkspaceCheckpoint({
    workspacePath: options.workspacePath,
    transport: options.transport,
    includeGlobs: options.includeGlobs,
    excludeGlobs: options.excludeGlobs,
    limits: options.limits,
    runtimeArtifact: {
      formatVersion: 1,
      mediaType: MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
      bytes: runtimeBytes,
      compatibilityRequirements: requirements,
    },
    attachments: options.attachments,
  });
  const body: ManagedWorkBundleBody = {
    format: MANAGED_WORK_BUNDLE_FORMAT,
    version: MANAGED_WORK_BUNDLE_VERSION,
    profile: MANAGED_WORK_PROFILE,
    runtime: {
      formatVersion: 1,
      mediaType: MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
      requirements,
    },
    workspaceManifestReference: capturedWorkspace.manifestReference,
    workspace: capturedWorkspace.manifest,
  };
  const manifest = { ...body, sha256: bundleChecksum(body) };
  const bytes = Buffer.from(canonicalJson(manifest), "utf8");
  if (bytes.byteLength > WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES) {
    throw new Error("Managed-work bundle manifest exceeds its size limit");
  }
  const reference = await options.transport.putBlob(bytes);
  if (reference !== sha256(bytes)) {
    throw new Error(
      "Blob transport returned an invalid bundle manifest reference",
    );
  }
  return { manifest, manifestReference: reference };
}

/** Validate all manifest, compatibility, workspace and managed-runtime resources. */
export async function validateManagedWorkBundle(
  manifestReference: string,
  transport: BlobTransport,
  options: { supportedRuntimeRequirements?: readonly string[] } = {},
): Promise<{
  manifest: ManagedWorkBundleManifest;
  managedWork: ManagedWorkCheckpoint;
}> {
  const manifest = await readBundle(manifestReference, transport);
  const managedWork = await validateBundleResources(
    manifest,
    transport,
    options.supportedRuntimeRequirements,
  );
  return { manifest, managedWork };
}

async function preparedReceipt(
  destinationPath: string,
  manifestReference: string,
): Promise<PreparedManagedWorkRestoreReceipt | undefined> {
  try {
    const destination = await lstat(destinationPath);
    if (!destination.isDirectory() || destination.isSymbolicLink()) {
      return undefined;
    }
    const metadataDirectory = await lstat(join(destinationPath, ".uzina"));
    const receiptPath = join(
      destinationPath,
      ".uzina",
      "prepared-restore.json",
    );
    const receipt = await lstat(receiptPath);
    if (
      !metadataDirectory.isDirectory() ||
      metadataDirectory.isSymbolicLink() ||
      !receipt.isFile() ||
      receipt.isSymbolicLink()
    ) {
      return undefined;
    }
    const value = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    if (
      !isRecord(value) ||
      value.format !== PREPARED_RECEIPT_FORMAT ||
      value.version !== 1 ||
      value.status !== "prepared-inactive" ||
      value.manifestReference !== manifestReference ||
      value.receiptId !==
        bundleChecksum({ manifestReference, destinationPath }) ||
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
    const workspace = await lstat(join(destinationPath, "workspace"));
    const runtime = await lstat(join(destinationPath, "managed-work.sqlite"));
    if (
      !workspace.isDirectory() ||
      workspace.isSymbolicLink() ||
      !runtime.isFile() ||
      runtime.isSymbolicLink()
    ) {
      return undefined;
    }
    if (value.attachmentNames.length) {
      const attachmentDirectory = await lstat(
        join(destinationPath, ".uzina", "attachments"),
      );
      if (
        !attachmentDirectory.isDirectory() ||
        attachmentDirectory.isSymbolicLink()
      ) {
        return undefined;
      }
      for (const name of value.attachmentNames) {
        const attachment = await lstat(
          join(destinationPath, ".uzina", "attachments", name as string),
        );
        if (!attachment.isFile() || attachment.isSymbolicLink()) {
          return undefined;
        }
      }
    }
    return value as unknown as PreparedManagedWorkRestoreReceipt;
  } catch {
    return undefined;
  }
}

async function hashPreparedAttachment(
  path: string,
  expectedSize: number,
  name: string,
): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await file.stat();
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
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.byteLength, expectedSize - totalBytes),
        totalBytes,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    const extraByte = Buffer.alloc(1);
    const extra = await file.read(extraByte, 0, 1, expectedSize);
    const finalStat = await file.stat();
    const pathStat = await lstat(path);
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
    await file.close();
  }
}

async function verifyPreparedDestination(
  destinationPath: string,
  receipt: PreparedManagedWorkRestoreReceipt,
  manifest: ManagedWorkBundleManifest,
  managedWork: ManagedWorkCheckpoint,
  transport: BlobTransport,
  openStorage: RestoreManagedWorkBundleOptions["openStorage"],
): Promise<void> {
  await verifyRestoredWorkspaceCheckpoint(
    manifest.workspace,
    transport,
    join(destinationPath, receipt.workspacePath),
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
    runtime = await openStorage(join(destinationPath, receipt.runtimePath));
    await verifyManagedWorkCheckpointStorage(runtime.storage, managedWork);
  } finally {
    await runtime?.close();
  }

  const attachmentDirectory = join(destinationPath, ".uzina", "attachments");
  if (expectedAttachmentNames.length === 0) {
    try {
      await lstat(attachmentDirectory);
      throw new Error("Prepared restore has unexpected attachments");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return;
  }
  const directory = await lstat(attachmentDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Prepared restore attachments are unavailable");
  }
  const actualNames = (await readdir(attachmentDirectory)).sort();
  if (
    JSON.stringify(actualNames) !==
    JSON.stringify([...expectedAttachmentNames].sort())
  ) {
    throw new Error("Prepared restore attachments do not match bundle");
  }
  for (const attachment of manifest.workspace.attachments) {
    const path = join(attachmentDirectory, attachment.name);
    const details = await lstat(path);
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
    );
    if (actualDigest !== attachment.blob.sha256) {
      throw new Error(
        `Prepared attachment integrity mismatch: ${attachment.name}`,
      );
    }
  }
}

async function assertEmptyOrMissingDestination(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(
        "Restore destination must be an empty inactive directory",
      );
    }
    if ((await readdir(path)).length > 0) {
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
  const manifest = await readBundle(
    options.manifestReference,
    options.transport,
  );
  const existingReceipt = await preparedReceipt(
    destinationPath,
    options.manifestReference,
  );
  const managedWork = existingReceipt
    ? await validateBundleRuntime(
        manifest,
        options.transport,
        options.supportedRuntimeRequirements,
      )
    : await validateBundleResources(
        manifest,
        options.transport,
        options.supportedRuntimeRequirements,
      );
  if (existingReceipt) {
    await verifyPreparedDestination(
      destinationPath,
      existingReceipt,
      manifest,
      managedWork,
      options.transport,
      options.openStorage,
    );
    return {
      receipt: existingReceipt,
      destinationPath,
      workspacePath: join(destinationPath, existingReceipt.workspacePath),
      runtimePath: join(destinationPath, existingReceipt.runtimePath),
      provenanceAttachments: [],
    };
  }
  await assertEmptyOrMissingDestination(destinationPath);

  const parent = dirname(destinationPath);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(join(parent, ".uzina-prepared-restore-"));
  const stagedWorkspace = join(stagingRoot, "workspace");
  const stagedRuntime = join(stagingRoot, "managed-work.sqlite");
  let restoredAttachments: RestoredManagedWorkBundle["provenanceAttachments"] =
    [];
  try {
    const restored = await restoreWorkspaceCheckpoint({
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
    });
    if (!restored.runtimeArtifact) {
      throw new Error("Managed-work bundle runtime artifact is missing");
    }
    let runtime: ManagedWorkRestoreStorage | undefined;
    try {
      runtime = await options.openStorage(stagedRuntime);
      await importManagedWorkCheckpoint(
        runtime.storage,
        JSON.parse(
          Buffer.from(restored.runtimeArtifact.bytes).toString("utf8"),
        ),
      );
    } finally {
      await runtime?.close();
    }
    restoredAttachments = restored.attachments;
    const metadataDirectory = join(stagingRoot, ".uzina");
    await mkdir(metadataDirectory, { recursive: true });
    const attachmentDirectory = join(metadataDirectory, "attachments");
    if (restoredAttachments.length) {
      await mkdir(attachmentDirectory, { recursive: true });
      for (const item of restoredAttachments) {
        await writeFile(
          join(attachmentDirectory, item.attachment.name),
          item.bytes,
          {
            flag: "wx",
          },
        );
      }
    }
    const receipt: PreparedManagedWorkRestoreReceipt = {
      format: PREPARED_RECEIPT_FORMAT,
      version: 1,
      status: "prepared-inactive",
      receiptId: bundleChecksum({
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
    await writeFile(
      join(metadataDirectory, "prepared-restore.json"),
      JSON.stringify(receipt),
      { flag: "wx" },
    );
    await rename(stagingRoot, destinationPath);
    return {
      receipt,
      destinationPath,
      workspacePath: stagedWorkspace.replace(stagingRoot, destinationPath),
      runtimePath: stagedRuntime.replace(stagingRoot, destinationPath),
      provenanceAttachments: restoredAttachments,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    const racedReceipt = await preparedReceipt(
      destinationPath,
      options.manifestReference,
    );
    if (racedReceipt) {
      await verifyPreparedDestination(
        destinationPath,
        racedReceipt,
        manifest,
        managedWork,
        options.transport,
        options.openStorage,
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
