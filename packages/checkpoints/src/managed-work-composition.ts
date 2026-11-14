import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { prepareManagedWorkCheckpointArtifact } from "@uzina/pi-runtime/checkpoint";
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

const RUNTIME_REQUIREMENTS = [
  "managed-work-profile:quiescent-current-documents-no-forks-v1",
  "pi-durable:1.4.0",
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
  const hash = new Sha256Stream();
  hash.update(bytes);
  return hash.digest();
}

function bundleChecksum(value: unknown): string {
  return sha256(new TextEncoder().encode(canonicalJson(value)));
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
      ...RUNTIME_REQUIREMENTS,
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
  if (canonicalJson(decoded) !== canonicalJson(workspaceManifest)) {
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
    sha256: bundleChecksum(body),
  };
  const outerManifestBytes = new TextEncoder().encode(canonicalJson(manifest));
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
