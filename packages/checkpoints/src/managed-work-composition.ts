import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
  prepareManagedWorkCheckpointArtifact,
  validateManagedWorkCheckpoint,
} from "@uzina/pi-runtime/checkpoint";
import {
  portableWorkspaceBlobReferences,
  PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES,
  PORTABLE_WORKSPACE_FILE_MAX_BYTES,
  PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  PORTABLE_WORKSPACE_MAX_FILES,
  PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES,
  PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
  Sha256Stream,
  validatePortableAttachmentName,
  validatePortableMediaType,
} from "./portable";
import type {
  BlobTransport,
  CaptureLimits,
  CheckpointAttachment,
  WorkspaceCheckpointManifest,
} from "./index";

export const MANAGED_WORK_BUNDLE_FORMAT =
  "uzina-coherent-managed-work-checkpoint" as const;
export const MANAGED_WORK_BUNDLE_VERSION = 1 as const;
export const MANAGED_WORK_PROFILE =
  "quiescent-current-documents-no-forks-v1" as const;
export const MANAGED_WORK_ARTIFACT_MEDIA_TYPE =
  "application/vnd.uzina.managed-work+json" as const;

export const MANAGED_WORK_RUNTIME_REQUIREMENTS = [
  "managed-work-profile:quiescent-current-documents-no-forks-v1",
  "pi-durable:1.5.2",
] as const;
const MANIFEST_MAX_BYTES = PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES;
const HARD_LIMITS = {
  files: PORTABLE_WORKSPACE_MAX_FILES,
  fileBytes: PORTABLE_WORKSPACE_FILE_MAX_BYTES,
  checkpointBytes: PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
  runtimeBytes: PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES,
  attachmentBytes: PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES,
} as const;

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

export type ManagedWorkCheckpointArtifactRole =
  | "runtime"
  | "evidence"
  | "attachment"
  | "inner-manifest"
  | "outer-manifest";

export interface ManagedWorkCheckpointArtifactReference {
  role: ManagedWorkCheckpointArtifactRole;
  reference: string;
  size: number;
}

export interface ManagedWorkBundleMetadataVerification {
  manifest: ManagedWorkBundleManifest;
  sourceWorkspaceReferences: readonly {
    reference: string;
    size: number;
  }[];
  privateArtifacts: readonly ManagedWorkCheckpointArtifactReference[];
}

export interface ManagedWorkBundleMetadataVerificationOptions {
  manifestBytes: Uint8Array;
  manifestReference: string;
  sourceWorkspaceManifestBytes: Uint8Array;
  sourceWorkspaceManifestReference: string;
  innerWorkspaceManifestBytes: Uint8Array;
  expectedRuntimeRequirements: readonly string[];
  runtimeArtifactBytes: Uint8Array;
}

export type ManagedWorkBundleMetadataPreflightOptions = Omit<
  ManagedWorkBundleMetadataVerificationOptions,
  "runtimeArtifactBytes"
>;

export interface CapturedManagedWorkBundle {
  manifest: ManagedWorkBundleManifest;
  manifestReference: string;
}

export interface ManagedWorkBundleCompositionOptions {
  managedWork: unknown;
  compatibilityRequirements?: string[];
  attachments?: Array<{ name: string; mediaType: string; bytes: Uint8Array }>;
  limits?: CaptureLimits;
}

interface ResolvedCaptureLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxCheckpointBytes: number;
  maxRuntimeBytes: number;
  maxAttachmentBytes: number;
}

interface PreparedAttachment {
  attachment: CheckpointAttachment;
  bytes: Uint8Array;
}

/** Validated artifacts held until the source workspace snapshot is available. */
export interface PreparedManagedWorkBundleComposition {
  readonly runtimeBytes: Uint8Array;
  readonly runtimeReference: string;
  readonly requirements: readonly string[];
  readonly attachments: readonly PreparedAttachment[];
  readonly limits: ResolvedCaptureLimits;
}

export interface ComposeManagedWorkBundleFromWorkspaceOptions {
  prepared: PreparedManagedWorkBundleComposition;
  workspaceManifest: WorkspaceCheckpointManifest;
  workspaceManifestReference: string;
  workspaceManifestBytes: Uint8Array;
  transport: BlobTransport;
}

export function canonicalManagedWorkJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Bundle contains non-JSON data");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalManagedWorkJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalManagedWorkJson(record[key])}`,
    )
    .join(",")}}`;
}

function sha256(bytes: Uint8Array): string {
  const hash = new Sha256Stream();
  hash.update(bytes);
  return hash.digest();
}

export function managedWorkBundleChecksum(value: unknown): string {
  return sha256(new TextEncoder().encode(canonicalManagedWorkJson(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function assertManagedWorkBundleEnvelope(
  value: unknown,
): asserts value is ManagedWorkBundleManifest {
  if (
    !isRecord(value) ||
    value.format !== MANAGED_WORK_BUNDLE_FORMAT ||
    value.version !== MANAGED_WORK_BUNDLE_VERSION ||
    value.profile !== MANAGED_WORK_PROFILE ||
    typeof value.sha256 !== "string" ||
    !isRecord(value.runtime) ||
    !hasOnlyKeys(value, [
      "format",
      "version",
      "profile",
      "runtime",
      "workspaceManifestReference",
      "workspace",
      "sha256",
    ]) ||
    !hasOnlyKeys(value.runtime, [
      "formatVersion",
      "mediaType",
      "requirements",
    ]) ||
    value.runtime.formatVersion !== 1 ||
    value.runtime.mediaType !== MANAGED_WORK_ARTIFACT_MEDIA_TYPE ||
    !Array.isArray(value.runtime.requirements) ||
    typeof value.workspaceManifestReference !== "string" ||
    !isRecord(value.workspace)
  ) {
    throw new Error("Unsupported or malformed coherent managed-work bundle");
  }
}

export function parseManagedWorkBundleManifestBytes(
  bytes: Uint8Array,
  manifestReference: string,
): ManagedWorkBundleManifest {
  if (!/^[a-f0-9]{64}$/.test(manifestReference)) {
    throw new Error("Managed-work bundle reference is not a SHA-256 digest");
  }
  if (bytes.byteLength > MANIFEST_MAX_BYTES) {
    throw new Error("Managed-work bundle manifest exceeds its size limit");
  }
  if (sha256(bytes) !== manifestReference) {
    throw new Error("Managed-work bundle manifest content hash mismatch");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Managed-work bundle manifest is not valid JSON");
  }
  assertManagedWorkBundleEnvelope(value);
  const { sha256: checksum, ...body } = value;
  if (managedWorkBundleChecksum(body) !== checksum) {
    throw new Error("Managed-work bundle manifest checksum mismatch");
  }
  if (
    !/^[a-f0-9]{64}$/.test(value.workspaceManifestReference) ||
    value.runtime.requirements.some(
      (requirement) =>
        typeof requirement !== "string" ||
        !requirement.trim() ||
        requirement.length > 256 ||
        /[\r\n]/.test(requirement),
    ) ||
    new Set(value.runtime.requirements).size !==
      value.runtime.requirements.length ||
    MANAGED_WORK_RUNTIME_REQUIREMENTS.some(
      (requirement) => !value.runtime.requirements.includes(requirement),
    )
  ) {
    throw new Error("Managed-work bundle runtime requirements are unsupported");
  }
  return value;
}

export function preflightManagedWorkBundleMetadata(
  options: ManagedWorkBundleMetadataPreflightOptions,
): ManagedWorkBundleMetadataVerification {
  const manifest = parseManagedWorkBundleManifestBytes(
    options.manifestBytes,
    options.manifestReference,
  );
  if (
    !/^[a-f0-9]{64}$/.test(options.sourceWorkspaceManifestReference) ||
    options.sourceWorkspaceManifestBytes.byteLength > MANIFEST_MAX_BYTES ||
    sha256(options.sourceWorkspaceManifestBytes) !==
      options.sourceWorkspaceManifestReference
  ) {
    throw new Error("Source workspace manifest reference or bytes are invalid");
  }
  if (
    options.expectedRuntimeRequirements.some(
      (requirement) =>
        typeof requirement !== "string" ||
        !requirement.trim() ||
        requirement.length > 256 ||
        /[\r\n]/.test(requirement),
    ) ||
    new Set(options.expectedRuntimeRequirements).size !==
      options.expectedRuntimeRequirements.length ||
    JSON.stringify(manifest.runtime.requirements) !==
      JSON.stringify(options.expectedRuntimeRequirements)
  ) {
    throw new Error(
      "Managed-work runtime requirements do not match the source",
    );
  }
  if (
    !/^[a-f0-9]{64}$/.test(manifest.workspaceManifestReference) ||
    options.innerWorkspaceManifestBytes.byteLength > MANIFEST_MAX_BYTES ||
    sha256(options.innerWorkspaceManifestBytes) !==
      manifest.workspaceManifestReference
  ) {
    throw new Error("Managed-work inner workspace manifest is invalid");
  }
  let sourceWorkspace: unknown;
  let innerWorkspace: unknown;
  try {
    sourceWorkspace = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        options.sourceWorkspaceManifestBytes,
      ),
    );
    innerWorkspace = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        options.innerWorkspaceManifestBytes,
      ),
    );
  } catch {
    throw new Error("Workspace manifest is not valid JSON");
  }
  if (
    canonicalManagedWorkJson(innerWorkspace) !==
    canonicalManagedWorkJson(manifest.workspace)
  ) {
    throw new Error("Managed-work inner workspace manifest is invalid");
  }
  if (!isRecord(manifest.workspace)) {
    throw new Error("Managed-work bundle workspace manifest is malformed");
  }
  const sourceWorkspaceReferences = portableWorkspaceBlobReferences(
    sourceWorkspace,
    options.sourceWorkspaceManifestReference,
    options.sourceWorkspaceManifestBytes.byteLength,
  );
  const workspace = manifest.workspace as unknown as Record<string, unknown>;
  if (
    !isRecord(workspace.runtimeArtifact) ||
    !hasOnlyKeys(workspace.runtimeArtifact, [
      "formatVersion",
      "mediaType",
      "artifact",
      "compatibilityRequirements",
    ]) ||
    workspace.runtimeArtifact.formatVersion !==
      manifest.runtime.formatVersion ||
    workspace.runtimeArtifact.mediaType !== manifest.runtime.mediaType ||
    !Array.isArray(workspace.runtimeArtifact.compatibilityRequirements) ||
    JSON.stringify(workspace.runtimeArtifact.compatibilityRequirements) !==
      JSON.stringify(manifest.runtime.requirements) ||
    !isRecord(workspace.runtimeArtifact.artifact) ||
    !hasOnlyKeys(workspace.runtimeArtifact.artifact, [
      "reference",
      "size",
      "sha256",
    ])
  ) {
    throw new Error("Managed-work runtime artifact metadata is invalid");
  }
  const runtimeArtifact = workspace.runtimeArtifact.artifact;
  if (
    typeof runtimeArtifact.reference !== "string" ||
    !/^[a-f0-9]{64}$/.test(runtimeArtifact.reference) ||
    runtimeArtifact.sha256 !== runtimeArtifact.reference ||
    !Number.isSafeInteger(runtimeArtifact.size) ||
    (runtimeArtifact.size as number) < 0 ||
    (runtimeArtifact.size as number) > PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES
  ) {
    throw new Error("Managed-work runtime artifact metadata is invalid");
  }
  const sourceWithoutRuntime: Record<string, unknown> = {
    ...workspace,
    runtimeArtifact: null,
    attachments: [],
  };
  if (
    canonicalManagedWorkJson(sourceWithoutRuntime) !==
    canonicalManagedWorkJson(sourceWorkspace)
  ) {
    throw new Error(
      "Managed-work bundle changed its source workspace metadata",
    );
  }
  if (
    !Array.isArray(workspace.attachments) ||
    workspace.attachments.length > PORTABLE_WORKSPACE_MAX_FILES
  ) {
    throw new Error("Managed-work bundle attachment count exceeds its limit");
  }
  const attachmentNames = new Set<string>();
  let evidenceCount = 0;
  const privateArtifacts: ManagedWorkCheckpointArtifactReference[] = [
    {
      role: "runtime",
      reference: runtimeArtifact.reference,
      size: runtimeArtifact.size as number,
    },
  ];
  for (const value of workspace.attachments) {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["name", "mediaType", "blob"]) ||
      typeof value.name !== "string" ||
      typeof value.mediaType !== "string" ||
      !isRecord(value.blob) ||
      !hasOnlyKeys(value.blob, ["reference", "size", "sha256"])
    ) {
      throw new Error("Managed-work attachment metadata is malformed");
    }
    validatePortableAttachmentName(value.name);
    validatePortableMediaType(value.mediaType);
    if (attachmentNames.has(value.name)) {
      throw new Error("Managed-work attachment names must be unique");
    }
    attachmentNames.add(value.name);
    const blob = value.blob;
    if (
      typeof blob.reference !== "string" ||
      !/^[a-f0-9]{64}$/.test(blob.reference) ||
      blob.sha256 !== blob.reference ||
      !Number.isSafeInteger(blob.size) ||
      (blob.size as number) < 0 ||
      (blob.size as number) > PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES
    ) {
      throw new Error("Managed-work attachment reference is invalid");
    }
    const role =
      value.name === "factory-provenance.json" ? "evidence" : "attachment";
    if (role === "evidence") {
      evidenceCount += 1;
      if (value.mediaType !== "application/json") {
        throw new Error("Factory provenance attachment must be JSON");
      }
    }
    privateArtifacts.push({
      role,
      reference: blob.reference,
      size: blob.size as number,
    });
  }
  if (evidenceCount !== 1) {
    throw new Error(
      "Managed-work bundle requires one complete provenance attachment",
    );
  }
  privateArtifacts.push(
    {
      role: "inner-manifest",
      reference: manifest.workspaceManifestReference,
      size: options.innerWorkspaceManifestBytes.byteLength,
    },
    {
      role: "outer-manifest",
      reference: options.manifestReference,
      size: options.manifestBytes.byteLength,
    },
  );
  return {
    manifest,
    sourceWorkspaceReferences,
    privateArtifacts,
  };
}

export async function verifyManagedWorkBundleRuntimeArtifact(
  metadata: ManagedWorkBundleMetadataVerification,
  runtimeArtifactBytes: Uint8Array,
): Promise<void> {
  const workspace = metadata.manifest.workspace as unknown as Record<
    string,
    unknown
  >;
  const runtimeArtifact = (workspace.runtimeArtifact as Record<string, unknown>)
    .artifact as Record<string, unknown>;
  if (
    runtimeArtifactBytes.byteLength !== runtimeArtifact.size ||
    runtimeArtifactBytes.byteLength > PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES ||
    sha256(runtimeArtifactBytes) !== runtimeArtifact.reference
  ) {
    throw new Error("Managed-work runtime artifact content is invalid");
  }
  let runtimeValue: unknown;
  try {
    runtimeValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(runtimeArtifactBytes),
    );
  } catch {
    throw new Error("Managed-work runtime artifact is not valid JSON");
  }
  const checkpoint = await validateManagedWorkCheckpoint(runtimeValue);
  if (
    checkpoint.profile !== MANAGED_WORK_PROFILE ||
    checkpoint.rootConversationId !== ROOT_CONVERSATION_ID
  ) {
    throw new Error("Managed-work runtime profile does not match its bundle");
  }
}

export async function verifyManagedWorkBundleMetadata(
  options: ManagedWorkBundleMetadataVerificationOptions,
): Promise<ManagedWorkBundleMetadataVerification> {
  const { runtimeArtifactBytes, ...metadataOptions } = options;
  const metadata = preflightManagedWorkBundleMetadata(metadataOptions);
  await verifyManagedWorkBundleRuntimeArtifact(metadata, runtimeArtifactBytes);
  return metadata;
}

function resolveLimits(limits: CaptureLimits = {}): ResolvedCaptureLimits {
  const bounded = (value: number | undefined, hard: number, label: string) => {
    const actual = value ?? hard;
    if (!Number.isSafeInteger(actual) || actual < 1 || actual > hard) {
      throw new Error(`${label} must be between 1 and ${hard}`);
    }
    return actual;
  };
  return {
    maxFiles: bounded(limits.maxFiles, HARD_LIMITS.files, "maxFiles"),
    maxFileBytes: bounded(
      limits.maxFileBytes,
      HARD_LIMITS.fileBytes,
      "maxFileBytes",
    ),
    maxCheckpointBytes: bounded(
      limits.maxCheckpointBytes,
      HARD_LIMITS.checkpointBytes,
      "maxCheckpointBytes",
    ),
    maxRuntimeBytes: bounded(
      limits.maxRuntimeBytes,
      HARD_LIMITS.runtimeBytes,
      "maxRuntimeBytes",
    ),
    maxAttachmentBytes: bounded(
      limits.maxAttachmentBytes,
      HARD_LIMITS.attachmentBytes,
      "maxAttachmentBytes",
    ),
  };
}

/** Prepare and validate Pi data and caller requirements before workspace I/O. */
export async function prepareManagedWorkBundleComposition(
  options: ManagedWorkBundleCompositionOptions,
): Promise<PreparedManagedWorkBundleComposition> {
  const limits = resolveLimits(options.limits);
  const preparedRuntime = await prepareManagedWorkCheckpointArtifact(
    options.managedWork,
    Math.min(limits.maxRuntimeBytes, limits.maxCheckpointBytes),
  );
  if (preparedRuntime.checkpoint.rootConversationId !== ROOT_CONVERSATION_ID) {
    throw new Error("Managed-work checkpoint must use the reserved root");
  }
  const requirements = [
    ...new Set([
      ...MANAGED_WORK_RUNTIME_REQUIREMENTS,
      ...(options.compatibilityRequirements ?? []),
    ]),
  ];
  if (
    requirements.some(
      (requirement) =>
        typeof requirement !== "string" ||
        !requirement.trim() ||
        requirement.length > 256 ||
        /[\r\n]/.test(requirement),
    )
  ) {
    throw new Error("Managed-work compatibility requirements are invalid");
  }
  const attachmentInputs = options.attachments ?? [];
  if (attachmentInputs.length > limits.maxFiles) {
    throw new Error("Checkpoint attachment count exceeds the configured limit");
  }
  const names = new Set<string>();
  let artifactBytes = preparedRuntime.bytes.byteLength;
  for (const input of attachmentInputs) {
    validatePortableAttachmentName(input.name);
    validatePortableMediaType(input.mediaType);
    if (names.has(input.name)) {
      throw new Error(`Duplicate checkpoint attachment: ${input.name}`);
    }
    names.add(input.name);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new Error(`Checkpoint attachment bytes are invalid: ${input.name}`);
    }
    if (input.bytes.byteLength > limits.maxAttachmentBytes) {
      throw new Error(
        `Checkpoint attachment exceeds the size limit: ${input.name}`,
      );
    }
    artifactBytes += input.bytes.byteLength;
    if (artifactBytes > limits.maxCheckpointBytes) {
      throw new Error("Checkpoint data exceeds the configured byte limit");
    }
  }

  // Count all named inputs before copying any bytes. Aliased buffers still
  // occupy separate artifact slots and must each fit the aggregate budget.
  const attachments: PreparedAttachment[] = [];
  for (const input of attachmentInputs) {
    const bytes = new Uint8Array(input.bytes);
    const digest = sha256(bytes);
    attachments.push({
      attachment: {
        name: input.name,
        mediaType: input.mediaType,
        blob: { reference: digest, size: bytes.byteLength, sha256: digest },
      },
      bytes,
    });
  }
  return Object.freeze({
    runtimeBytes: preparedRuntime.bytes,
    runtimeReference: sha256(preparedRuntime.bytes),
    requirements: Object.freeze(requirements),
    attachments: Object.freeze(attachments),
    limits: Object.freeze(limits),
  });
}

function verifyWorkspaceSource(
  options: ComposeManagedWorkBundleFromWorkspaceOptions,
): WorkspaceCheckpointManifest {
  const {
    workspaceManifest,
    workspaceManifestReference,
    workspaceManifestBytes,
  } = options;
  if (!/^[a-f0-9]{64}$/.test(workspaceManifestReference)) {
    throw new Error("Workspace manifest reference is not a SHA-256 digest");
  }
  if (workspaceManifestBytes.byteLength > MANIFEST_MAX_BYTES) {
    throw new Error("Workspace manifest exceeds its size limit");
  }
  if (sha256(workspaceManifestBytes) !== workspaceManifestReference) {
    throw new Error("Workspace manifest content hash mismatch");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(workspaceManifestBytes),
    );
  } catch {
    throw new Error("Workspace manifest is not valid JSON");
  }
  portableWorkspaceBlobReferences(
    workspaceManifest,
    workspaceManifestReference,
    workspaceManifestBytes.byteLength,
  );
  if (
    canonicalManagedWorkJson(decoded) !==
    canonicalManagedWorkJson(workspaceManifest)
  ) {
    throw new Error("Workspace manifest/reference/bytes mismatch");
  }
  const source = decoded as WorkspaceCheckpointManifest;
  if (source.runtimeArtifact !== null || source.attachments.length !== 0) {
    throw new Error(
      "Coherent composition requires a workspace-only source manifest",
    );
  }
  return source;
}

function assertStoredReference(reference: string, expected: string): void {
  if (reference !== expected) {
    throw new Error("Blob transport must return the SHA-256 content address");
  }
}

/**
 * Attach a validated Pi artifact to an already captured workspace manifest.
 * The caller has verified workspace blob integrity and supplies the exact source
 * manifest bytes. This function checks metadata and references but never reads
 * workspace objects, captures a path, or runs Git.
 */
export async function composeManagedWorkBundleFromWorkspace(
  options: ComposeManagedWorkBundleFromWorkspaceOptions,
): Promise<CapturedManagedWorkBundle> {
  const source = verifyWorkspaceSource(options);
  const { prepared } = options;
  const { maxFiles, maxFileBytes, maxCheckpointBytes } = prepared.limits;
  if (source.workspace.entries.length > maxFiles) {
    throw new Error("Workspace file count exceeds the configured limit");
  }
  if (source.workspace.entries.some((entry) => entry.size > maxFileBytes)) {
    throw new Error("Workspace file exceeds the configured size limit");
  }
  if (prepared.attachments.length > maxFiles) {
    throw new Error("Checkpoint attachment count exceeds the configured limit");
  }
  if (source.runtimeArtifact !== null || source.attachments.length !== 0) {
    throw new Error("Workspace source already contains runtime or attachments");
  }

  const baseWorkspaceBytes =
    source.git.bundle.size +
    source.git.stagedPatch.size +
    source.workspace.entries.reduce((sum, entry) => sum + entry.size, 0);
  let resourceBytes = baseWorkspaceBytes + prepared.runtimeBytes.byteLength;
  for (const item of prepared.attachments)
    resourceBytes += item.bytes.byteLength;
  if (resourceBytes > maxCheckpointBytes) {
    throw new Error("Checkpoint data exceeds the configured byte limit");
  }
  if (
    prepared.runtimeBytes.byteLength > prepared.limits.maxRuntimeBytes ||
    sha256(prepared.runtimeBytes) !== prepared.runtimeReference
  ) {
    throw new Error(
      "Prepared managed-work artifact changed before composition",
    );
  }
  const attachmentNames = new Set<string>();
  for (const item of prepared.attachments) {
    validatePortableAttachmentName(item.attachment.name);
    validatePortableMediaType(item.attachment.mediaType);
    const digest = sha256(item.bytes);
    if (
      item.bytes.byteLength > prepared.limits.maxAttachmentBytes ||
      item.attachment.blob.size !== item.bytes.byteLength ||
      item.attachment.blob.reference !== digest ||
      item.attachment.blob.sha256 !== digest ||
      attachmentNames.has(item.attachment.name)
    ) {
      throw new Error(
        `Prepared checkpoint attachment changed: ${item.attachment.name}`,
      );
    }
    attachmentNames.add(item.attachment.name);
  }

  const runtimeArtifact = {
    formatVersion: 1,
    mediaType: MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
    artifact: {
      reference: prepared.runtimeReference,
      size: prepared.runtimeBytes.byteLength,
      sha256: prepared.runtimeReference,
    },
    compatibilityRequirements: [...prepared.requirements],
  };
  const workspace: WorkspaceCheckpointManifest = {
    ...source,
    runtimeArtifact,
    attachments: prepared.attachments.map((item) => item.attachment),
  };
  const workspaceManifestBytes = new TextEncoder().encode(
    JSON.stringify(workspace),
  );
  if (workspaceManifestBytes.byteLength > MANIFEST_MAX_BYTES) {
    throw new Error("Checkpoint manifest exceeds its size limit");
  }
  resourceBytes += workspaceManifestBytes.byteLength;
  if (resourceBytes > maxCheckpointBytes) {
    throw new Error(
      "Checkpoint manifest exceeds the configured total byte limit",
    );
  }
  const workspaceManifestReference = sha256(workspaceManifestBytes);
  const body: ManagedWorkBundleBody = {
    format: MANAGED_WORK_BUNDLE_FORMAT,
    version: MANAGED_WORK_BUNDLE_VERSION,
    profile: MANAGED_WORK_PROFILE,
    runtime: {
      formatVersion: 1,
      mediaType: MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
      requirements: [...prepared.requirements],
    },
    workspaceManifestReference,
    workspace,
  };
  const manifest: ManagedWorkBundleManifest = {
    ...body,
    sha256: managedWorkBundleChecksum(body),
  };
  const outerManifestBytes = new TextEncoder().encode(
    canonicalManagedWorkJson(manifest),
  );
  if (outerManifestBytes.byteLength > MANIFEST_MAX_BYTES) {
    throw new Error("Managed-work bundle manifest exceeds its size limit");
  }

  assertStoredReference(
    await options.transport.putBlob(prepared.runtimeBytes),
    prepared.runtimeReference,
  );
  for (const item of prepared.attachments) {
    assertStoredReference(
      await options.transport.putBlob(item.bytes),
      item.attachment.blob.reference,
    );
  }
  assertStoredReference(
    await options.transport.putBlob(workspaceManifestBytes),
    workspaceManifestReference,
  );
  const manifestReference = sha256(outerManifestBytes);
  assertStoredReference(
    await options.transport.putBlob(outerManifestBytes),
    manifestReference,
  );
  return { manifest, manifestReference };
}
