import {
  factoryProvenanceEvidenceSchema,
  type FactoryProvenanceEvidence,
} from "@uzina/contracts/factory";
import {
  canonicalManagedWorkJson,
  parseManagedWorkBundleManifestBytes,
  verifyManagedWorkBundleMetadata,
  type ManagedWorkCheckpointArtifactReference,
} from "@uzina/checkpoints/managed-work-composition";
import {
  PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES,
  PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  PORTABLE_WORKSPACE_MAX_FILES,
  PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES,
  PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
  Sha256Stream,
  digestReadableStream,
} from "@uzina/checkpoints/portable";
import {
  verifyPublishedWorkspaceManifestDetails,
  type WorkspaceSnapshotStorage,
} from "./snapshot-storage";

const MAX_PRIVATE_OBJECTS = PORTABLE_WORKSPACE_MAX_FILES + 3;
const MAX_PRIVATE_OBJECT_BYTES = PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES;
const MAX_CLOSURE_OBJECTS = MAX_PRIVATE_OBJECTS * 2;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PrivateCheckpointArtifactObject {
  size: number;
  body: ReadableStream<Uint8Array>;
}

/** A request-scoped private store. Its implementation must not expose source-node credentials. */
export interface ManagedWorkCheckpointPrivateStorage {
  putBlob(bytes: Uint8Array): Promise<string>;
  getBlob(reference: string): Promise<Uint8Array>;
  getBlobStream(
    reference: string,
  ): Promise<PrivateCheckpointArtifactObject | null>;
  listBlobs(): Promise<readonly { reference: string; size: number }[]>;
}

export interface VerifyManagedWorkCheckpointClosureOptions {
  checkpointRequestId: string;
  captureId: string;
  sourceWorkspaceManifestReference: string;
  authoritativeWorkspaceReferences: readonly {
    reference: string;
    size: number;
  }[];
  authorizedCommandPlacements: readonly {
    nodeId: string;
    workspaceId: string;
    ownershipGeneration: number;
  }[];
  manifestReference: string;
  expectedRuntimeRequirements: readonly string[];
  expectedEvidence: FactoryProvenanceEvidence;
  privateArtifacts: readonly ManagedWorkCheckpointArtifactReference[];
  workspaceStorage: WorkspaceSnapshotStorage;
  privateStorage: ManagedWorkCheckpointPrivateStorage;
}

export interface ManagedWorkCheckpointClosureVerification {
  checkpointRequestId: string;
  captureId: string;
  sourceWorkspaceManifestReference: string;
  manifestReference: string;
  workspaceObjectCount: number;
  privateObjectCount: number;
  totalBytes: number;
}

export interface ManagedWorkCheckpointClosurePublicationBinding {
  checkpointRequestId: string;
  captureId: string;
  sourceWorkspaceManifestReference: string;
  manifestReference: string;
  authoritativeWorkspaceReferences: readonly {
    reference: string;
    size: number;
  }[];
  authorizedCommandPlacements: readonly {
    nodeId: string;
    workspaceId: string;
    ownershipGeneration: number;
  }[];
  expectedEvidence: FactoryProvenanceEvidence;
  expectedRuntimeRequirements: readonly string[];
  privateArtifacts: readonly ManagedWorkCheckpointArtifactReference[];
}

interface ManagedWorkCheckpointClosureProof {
  summary: ManagedWorkCheckpointClosureVerification;
  checkpointRequestId: string;
  captureId: string;
  sourceWorkspaceManifestReference: string;
  manifestReference: string;
  authoritativeWorkspaceReferences: readonly {
    reference: string;
    size: number;
  }[];
  authorizedCommandPlacements: readonly {
    nodeId: string;
    workspaceId: string;
    ownershipGeneration: number;
  }[];
  privateArtifacts: readonly ManagedWorkCheckpointArtifactReference[];
  // Bind verifier-only expectations that Core does not rederive at publication.
  expectedRuntimeRequirements: readonly string[];
  expectedEvidenceJson: string;
}

const managedWorkCheckpointClosureProofs = new WeakMap<
  object,
  ManagedWorkCheckpointClosureProof
>();

/**
 * Reverify one persisted request's complete source/private object closure.
 * Only bounded private manifests/runtime are materialized; source blobs remain streams.
 */
export async function verifyManagedWorkCheckpointClosure(
  inputOptions: VerifyManagedWorkCheckpointClosureOptions,
): Promise<ManagedWorkCheckpointClosureVerification> {
  const options: VerifyManagedWorkCheckpointClosureOptions = {
    ...inputOptions,
    authoritativeWorkspaceReferences:
      inputOptions.authoritativeWorkspaceReferences.map((reference) => ({
        ...reference,
      })),
    authorizedCommandPlacements: inputOptions.authorizedCommandPlacements.map(
      (placement) => ({ ...placement }),
    ),
    expectedRuntimeRequirements: [...inputOptions.expectedRuntimeRequirements],
    privateArtifacts: inputOptions.privateArtifacts.map((artifact) => ({
      ...artifact,
    })),
  };
  const expectedEvidenceJson = canonicalManagedWorkJson(
    inputOptions.expectedEvidence,
  );
  assertIdentity(options.checkpointRequestId, options.captureId);
  assertDigest(options.sourceWorkspaceManifestReference);
  assertDigest(options.manifestReference);
  if (
    options.authoritativeWorkspaceReferences.length === 0 ||
    options.authoritativeWorkspaceReferences.length > MAX_PRIVATE_OBJECTS
  ) {
    throw new Error("Authoritative workspace reference count is invalid");
  }
  const authoritativeWorkspaceReferences = new Map<string, number>();
  for (const object of options.authoritativeWorkspaceReferences) {
    assertDigest(object.reference);
    if (
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      object.size > PORTABLE_WORKSPACE_TOTAL_MAX_BYTES ||
      authoritativeWorkspaceReferences.has(object.reference)
    ) {
      throw new Error("Authoritative workspace references are invalid");
    }
    authoritativeWorkspaceReferences.set(object.reference, object.size);
  }

  const source = await verifyPublishedWorkspaceManifestDetails(
    options.workspaceStorage,
    options.captureId,
    options.sourceWorkspaceManifestReference,
  );
  const sourceReferences = [...source.references].sort(byReference);
  if (
    sourceReferences.length !== authoritativeWorkspaceReferences.size ||
    sourceReferences.some(
      ({ reference, size }) =>
        authoritativeWorkspaceReferences.get(reference) !== size,
    )
  ) {
    throw new Error(
      "Published workspace closure does not match Core's persisted references",
    );
  }

  const listedPrivate = normalizePrivateListing(
    await options.privateStorage.listBlobs(),
  );
  const listedPrivateByReference = new Map(
    listedPrivate.map((object) => [object.reference, object.size]),
  );
  const outerReference = requireListedObject(
    listedPrivateByReference,
    options.manifestReference,
    PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  );
  const outerBytes = await readBoundedPrivateObject(
    options.privateStorage,
    options.manifestReference,
    outerReference,
    PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  );
  const manifest = parseManagedWorkBundleManifestBytes(
    outerBytes,
    options.manifestReference,
  );
  if (
    !manifest.workspace.runtimeArtifact ||
    !Array.isArray(manifest.workspace.attachments) ||
    manifest.workspace.attachments.length > PORTABLE_WORKSPACE_MAX_FILES
  ) {
    throw new Error("Managed-work bundle resource metadata is invalid");
  }
  const innerReference = requireListedObject(
    listedPrivateByReference,
    manifest.workspaceManifestReference,
    PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  );
  const innerBytes = await readBoundedPrivateObject(
    options.privateStorage,
    manifest.workspaceManifestReference,
    innerReference,
    PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  );
  const runtimeMetadata = manifest.workspace.runtimeArtifact.artifact;
  const runtimeReference = requireListedObject(
    listedPrivateByReference,
    runtimeMetadata.reference,
    PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES,
  );
  if (runtimeReference !== runtimeMetadata.size) {
    throw new Error(
      "Managed-work runtime size does not match the private object",
    );
  }
  const runtimeBytes = await readBoundedPrivateObject(
    options.privateStorage,
    runtimeMetadata.reference,
    runtimeReference,
    PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES,
  );

  const metadata = await verifyManagedWorkBundleMetadata({
    manifestBytes: outerBytes,
    manifestReference: options.manifestReference,
    sourceWorkspaceManifestBytes: source.manifestBytes,
    sourceWorkspaceManifestReference: options.sourceWorkspaceManifestReference,
    innerWorkspaceManifestBytes: innerBytes,
    expectedRuntimeRequirements: options.expectedRuntimeRequirements,
    runtimeArtifactBytes: runtimeBytes,
  });
  const persistedEvidence = options.privateArtifacts.find(
    (artifact) => artifact.role === "evidence",
  );
  const persistedArtifacts = normalizeArtifactReferences(
    options.privateArtifacts,
  );
  const expectedArtifacts = normalizeArtifactReferences(
    metadata.privateArtifacts,
  );
  if (!sameArtifacts(persistedArtifacts, expectedArtifacts)) {
    throw new Error(
      "Persisted private artifact references do not match the bundle closure",
    );
  }
  const evidenceArtifact = expectedArtifacts.find(
    (artifact) =>
      artifact.role === "attachment" &&
      artifact.reference === persistedEvidence?.reference,
  );
  if (!evidenceArtifact || !persistedEvidence) {
    throw new Error("Managed-work bundle provenance evidence is missing");
  }
  const evidenceBytes = await readBoundedPrivateObject(
    options.privateStorage,
    evidenceArtifact.reference,
    evidenceArtifact.size,
    PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES,
  );
  let evidenceValue: unknown;
  try {
    evidenceValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes),
    );
  } catch {
    throw new Error("Managed-work provenance evidence is not valid JSON");
  }
  const evidence = factoryProvenanceEvidenceSchema.parse(evidenceValue);
  if (
    evidence.workspaceSnapshot.manifestReference !==
      options.sourceWorkspaceManifestReference ||
    canonicalManagedWorkJson(evidence) !== expectedEvidenceJson
  ) {
    throw new Error(
      "Managed-work provenance evidence does not match current Core authority",
    );
  }
  assertSettledProvenance(evidence, options.authorizedCommandPlacements);

  const expectedPrivateByReference = new Map<string, number>();
  for (const artifact of expectedArtifacts) {
    const prior = expectedPrivateByReference.get(artifact.reference);
    if (prior !== undefined && prior !== artifact.size) {
      throw new Error("Private artifact references have conflicting sizes");
    }
    expectedPrivateByReference.set(artifact.reference, artifact.size);
  }
  if (
    listedPrivate.length !== expectedPrivateByReference.size ||
    listedPrivate.some(
      ({ reference, size }) =>
        expectedPrivateByReference.get(reference) !== size,
    )
  ) {
    throw new Error(
      "Private request namespace contains missing, extra, or mismatched objects",
    );
  }

  const verifiedPrivate = new Set<string>([
    options.manifestReference,
    manifest.workspaceManifestReference,
    runtimeMetadata.reference,
    evidenceArtifact.reference,
  ]);
  for (const artifact of expectedArtifacts) {
    if (verifiedPrivate.has(artifact.reference)) continue;
    const expectedSize = expectedPrivateByReference.get(artifact.reference)!;
    await verifyPrivateObjectStream(
      options.privateStorage,
      artifact.reference,
      expectedSize,
      PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES,
    );
    verifiedPrivate.add(artifact.reference);
  }

  let totalBytes = 0;
  for (const object of sourceReferences) {
    totalBytes += object.size;
    if (totalBytes > PORTABLE_WORKSPACE_TOTAL_MAX_BYTES) {
      throw new Error("Complete checkpoint closure exceeds its byte limit");
    }
  }
  for (const object of listedPrivate) {
    totalBytes += object.size;
    if (totalBytes > PORTABLE_WORKSPACE_TOTAL_MAX_BYTES) {
      throw new Error("Complete checkpoint closure exceeds its byte limit");
    }
  }
  if (sourceReferences.length + listedPrivate.length > MAX_CLOSURE_OBJECTS) {
    throw new Error(
      "Complete checkpoint closure exceeds its object-count limit",
    );
  }

  const summary = Object.freeze({
    checkpointRequestId: options.checkpointRequestId,
    captureId: options.captureId,
    sourceWorkspaceManifestReference: options.sourceWorkspaceManifestReference,
    manifestReference: options.manifestReference,
    workspaceObjectCount: sourceReferences.length,
    privateObjectCount: listedPrivate.length,
    totalBytes,
  });
  managedWorkCheckpointClosureProofs.set(
    summary,
    Object.freeze({
      summary: Object.freeze({ ...summary }),
      checkpointRequestId: options.checkpointRequestId,
      captureId: options.captureId,
      sourceWorkspaceManifestReference:
        options.sourceWorkspaceManifestReference,
      manifestReference: options.manifestReference,
      authoritativeWorkspaceReferences: Object.freeze(
        sourceReferences.map((reference) => Object.freeze({ ...reference })),
      ),
      authorizedCommandPlacements: Object.freeze(
        normalizeAuthorizedCommandPlacements(
          options.authorizedCommandPlacements,
        ).map((placement) => Object.freeze({ ...placement })),
      ),
      privateArtifacts: Object.freeze(
        expectedArtifacts.map((artifact) => Object.freeze({ ...artifact })),
      ),
      expectedRuntimeRequirements: Object.freeze([
        ...options.expectedRuntimeRequirements,
      ]),
      expectedEvidenceJson,
    }),
  );
  return summary;
}

/** A frozen summary is not proof unless this module issued it for the exact persisted closure. */
export function isVerifiedManagedWorkCheckpointClosure(
  value: unknown,
  expected: ManagedWorkCheckpointClosurePublicationBinding,
): value is ManagedWorkCheckpointClosureVerification {
  if (!value || typeof value !== "object") return false;
  const proof = managedWorkCheckpointClosureProofs.get(value);
  if (!proof) return false;
  const candidate = value as Partial<ManagedWorkCheckpointClosureVerification>;
  try {
    const expectedReferences = [...expected.authoritativeWorkspaceReferences]
      .map(({ reference, size }) => ({ reference, size }))
      .sort(byReference);
    const expectedArtifacts = normalizeArtifactReferences(
      expected.privateArtifacts,
    );
    return (
      proof.checkpointRequestId === expected.checkpointRequestId &&
      proof.captureId === expected.captureId &&
      proof.sourceWorkspaceManifestReference ===
        expected.sourceWorkspaceManifestReference &&
      proof.manifestReference === expected.manifestReference &&
      proof.summary.checkpointRequestId === expected.checkpointRequestId &&
      proof.summary.captureId === expected.captureId &&
      proof.summary.sourceWorkspaceManifestReference ===
        expected.sourceWorkspaceManifestReference &&
      proof.summary.manifestReference === expected.manifestReference &&
      candidate.checkpointRequestId === proof.summary.checkpointRequestId &&
      candidate.captureId === proof.summary.captureId &&
      candidate.sourceWorkspaceManifestReference ===
        proof.summary.sourceWorkspaceManifestReference &&
      candidate.manifestReference === proof.summary.manifestReference &&
      candidate.workspaceObjectCount === proof.summary.workspaceObjectCount &&
      candidate.privateObjectCount === proof.summary.privateObjectCount &&
      candidate.totalBytes === proof.summary.totalBytes &&
      canonicalManagedWorkJson(expectedReferences) ===
        canonicalManagedWorkJson(proof.authoritativeWorkspaceReferences) &&
      canonicalManagedWorkJson(expectedArtifacts) ===
        canonicalManagedWorkJson(proof.privateArtifacts) &&
      canonicalManagedWorkJson(
        normalizeAuthorizedCommandPlacements(
          expected.authorizedCommandPlacements,
        ),
      ) === canonicalManagedWorkJson(proof.authorizedCommandPlacements) &&
      canonicalManagedWorkJson(expected.expectedEvidence) ===
        proof.expectedEvidenceJson &&
      JSON.stringify(expected.expectedRuntimeRequirements) ===
        JSON.stringify(proof.expectedRuntimeRequirements)
    );
  } catch {
    return false;
  }
}

function assertIdentity(checkpointRequestId: string, captureId: string): void {
  if (!IDENTIFIER.test(checkpointRequestId) || !IDENTIFIER.test(captureId)) {
    throw new Error("Invalid managed-work checkpoint storage identity");
  }
}

function assertDigest(reference: string): void {
  if (!SHA256.test(reference)) {
    throw new Error("Checkpoint object reference is not a SHA-256 digest");
  }
}

function normalizePrivateListing(
  values: readonly { reference: string; size: number }[],
): Array<{ reference: string; size: number }> {
  if (values.length > MAX_PRIVATE_OBJECTS) {
    throw new Error(
      "Private checkpoint namespace exceeds its object-count limit",
    );
  }
  const seen = new Set<string>();
  let total = 0;
  const sorted = [...values].sort(byReference);
  for (const value of sorted) {
    assertDigest(value.reference);
    if (
      seen.has(value.reference) ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      value.size > MAX_PRIVATE_OBJECT_BYTES
    ) {
      throw new Error("Private checkpoint listing contains invalid objects");
    }
    seen.add(value.reference);
    total += value.size;
    if (total > PORTABLE_WORKSPACE_TOTAL_MAX_BYTES) {
      throw new Error("Private checkpoint namespace exceeds its byte limit");
    }
  }
  return sorted;
}

function normalizeArtifactReferences(
  values: readonly ManagedWorkCheckpointArtifactReference[],
): Array<ManagedWorkCheckpointArtifactReference> {
  if (values.length > MAX_PRIVATE_OBJECTS) {
    throw new Error("Private checkpoint reference count exceeds its limit");
  }
  const unique = new Map<string, ManagedWorkCheckpointArtifactReference>();
  for (const value of values) {
    assertDigest(value.reference);
    const maxBytes =
      value.role === "inner-manifest" || value.role === "outer-manifest"
        ? PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES
        : MAX_PRIVATE_OBJECT_BYTES;
    if (
      ![
        "runtime",
        "evidence",
        "attachment",
        "inner-manifest",
        "outer-manifest",
      ].includes(value.role) ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      value.size > maxBytes
    ) {
      throw new Error("Persisted private artifact reference is invalid");
    }
    const normalized = {
      ...value,
      role: value.role === "evidence" ? "attachment" : value.role,
    };
    const identity = `${normalized.role}:${normalized.reference}`;
    const existing = unique.get(identity);
    if (existing && existing.size !== normalized.size) {
      throw new Error("Private artifact references have conflicting sizes");
    }
    unique.set(identity, normalized);
  }
  return [...unique.values()].sort(byArtifact);
}

function requireListedObject(
  objects: ReadonlyMap<string, number>,
  reference: string,
  maxBytes: number,
): number {
  assertDigest(reference);
  const size = objects.get(reference);
  if (size === undefined || size > maxBytes) {
    throw new Error(
      "Required private checkpoint object is missing or oversized",
    );
  }
  return size;
}

async function readBoundedPrivateObject(
  storage: ManagedWorkCheckpointPrivateStorage,
  reference: string,
  expectedSize: number,
  maxBytes: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > maxBytes
  ) {
    throw new Error("Private checkpoint artifact exceeds its byte limit");
  }
  const object = await storage.getBlobStream(reference);
  if (!object || object.size !== expectedSize || object.size > maxBytes) {
    await object?.body.cancel().catch(() => {});
    throw new Error(
      "Private checkpoint artifact is missing or incorrectly sized",
    );
  }
  const bytes = new Uint8Array(expectedSize);
  const reader = object.body.getReader();
  const hash = new Sha256Stream();
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > expectedSize - total) {
        throw new Error(
          "Private checkpoint artifact exceeded its declared size",
        );
      }
      bytes.set(part.value, total);
      hash.update(part.value);
      total += part.value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedSize || hash.digest() !== reference) {
    throw new Error("Private checkpoint artifact failed byte verification");
  }
  return bytes;
}

async function verifyPrivateObjectStream(
  storage: ManagedWorkCheckpointPrivateStorage,
  reference: string,
  expectedSize: number,
  maxBytes: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > maxBytes
  ) {
    throw new Error("Private checkpoint artifact exceeds its byte limit");
  }
  const object = await storage.getBlobStream(reference);
  if (!object || object.size !== expectedSize || object.size > maxBytes) {
    await object?.body.cancel().catch(() => {});
    throw new Error(
      "Private checkpoint artifact is missing or incorrectly sized",
    );
  }
  const actual = await digestReadableStream(object.body, maxBytes);
  if (actual.reference !== reference || actual.size !== expectedSize) {
    throw new Error("Private checkpoint artifact failed stream verification");
  }
}

function normalizeAuthorizedCommandPlacements(
  placements: readonly {
    nodeId: string;
    workspaceId: string;
    ownershipGeneration: number;
  }[],
): Array<{
  nodeId: string;
  workspaceId: string;
  ownershipGeneration: number;
}> {
  if (placements.length === 0 || placements.length > 100_000) {
    throw new Error("Authorized execution placement count is invalid");
  }
  const unique = new Map<string, (typeof placements)[number]>();
  for (const placement of placements) {
    if (
      !IDENTIFIER.test(placement.nodeId) ||
      !IDENTIFIER.test(placement.workspaceId) ||
      !Number.isSafeInteger(placement.ownershipGeneration) ||
      placement.ownershipGeneration < 0
    ) {
      throw new Error("Authorized execution placement is invalid");
    }
    const key = canonicalManagedWorkJson(placement);
    if (unique.has(key)) {
      throw new Error("Authorized execution placement is duplicated");
    }
    unique.set(key, {
      nodeId: placement.nodeId,
      workspaceId: placement.workspaceId,
      ownershipGeneration: placement.ownershipGeneration,
    });
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.nodeId.localeCompare(right.nodeId) ||
      left.workspaceId.localeCompare(right.workspaceId) ||
      left.ownershipGeneration - right.ownershipGeneration,
  );
}

function assertSettledProvenance(
  evidence: FactoryProvenanceEvidence,
  authorizedCommandPlacements: readonly {
    nodeId: string;
    workspaceId: string;
    ownershipGeneration: number;
  }[],
): void {
  const placements = normalizeAuthorizedCommandPlacements(
    authorizedCommandPlacements,
  );
  const placementKey = (
    target: { nodeId: string; workspaceId: string },
    ownershipGeneration: number,
  ) =>
    canonicalManagedWorkJson({
      nodeId: target.nodeId,
      workspaceId: target.workspaceId,
      ownershipGeneration,
    });
  const authorized = new Set(
    placements.map((placement) =>
      placementKey(placement, placement.ownershipGeneration),
    ),
  );
  if (
    !authorized.has(
      placementKey(
        evidence.capture.target,
        evidence.capture.ownershipGeneration,
      ),
    )
  ) {
    throw new Error(
      "Current capture is outside its authorized execution lineage",
    );
  }
  for (const command of evidence.commands) {
    const commandPlacement = placementKey(
      command.target,
      command.ownershipGeneration,
    );
    if (
      command.threadId !== evidence.threadId ||
      !authorized.has(commandPlacement) ||
      (command.dispatchStatus !== "completed" &&
        command.dispatchStatus !== "failed")
    ) {
      throw new Error("Factory command provenance is unbound or unsettled");
    }
    for (const effect of command.executionEffects) {
      if (
        effect.nodeId !== command.target.nodeId ||
        effect.target.nodeId !== command.target.nodeId ||
        effect.target.workspaceId !== command.target.workspaceId ||
        effect.ownershipGeneration !== command.ownershipGeneration ||
        !authorized.has(
          placementKey(effect.target, effect.ownershipGeneration),
        ) ||
        (effect.status !== "completed" && effect.status !== "failed")
      ) {
        throw new Error("Factory execution-effect provenance is unsettled");
      }
    }
  }
}

function sameArtifacts(
  left: readonly ManagedWorkCheckpointArtifactReference[],
  right: readonly ManagedWorkCheckpointArtifactReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (artifact, index) =>
        artifact.role === right[index]?.role &&
        artifact.reference === right[index]?.reference &&
        artifact.size === right[index]?.size,
    )
  );
}

function byReference(
  left: { reference: string; size: number },
  right: { reference: string; size: number },
): number {
  return left.reference.localeCompare(right.reference);
}

function byArtifact(
  left: ManagedWorkCheckpointArtifactReference,
  right: ManagedWorkCheckpointArtifactReference,
): number {
  return (
    left.role.localeCompare(right.role) ||
    left.reference.localeCompare(right.reference)
  );
}
