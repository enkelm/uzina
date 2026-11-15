import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { BlobTransport } from "@uzina/checkpoints";
import {
  canonicalManagedWorkJson,
  MANAGED_WORK_RUNTIME_REQUIREMENTS,
  parseManagedWorkBundleManifestBytes,
  preflightManagedWorkBundleMetadata,
  verifyManagedWorkBundleRuntimeArtifact,
} from "@uzina/checkpoints/managed-work-composition";
import {
  PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES,
  PORTABLE_WORKSPACE_FILE_MAX_BYTES,
  PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES,
  PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
} from "@uzina/checkpoints/portable";
import type { ManagedWorkBundleManifest } from "@uzina/checkpoints";

const HASH = /^[a-f0-9]{64}$/;

type ImportBlobRole =
  | "outer-manifest"
  | "inner-manifest"
  | "git-bundle"
  | "staged-patch"
  | "workspace-file"
  | "runtime"
  | "attachment"
  | "evidence";

interface BlobDeclaration {
  reference: string;
  size: number;
  maxBytes: number;
  role: ImportBlobRole;
}

export interface BoundedManagedWorkImportCatalogOptions {
  canonicalRoot: string;
  manifestReference: string;
  expectedRuntimeRequirements: readonly string[];
  beforeAndAfterRead(): Promise<void>;
}

async function readBoundedRegularFile(options: {
  canonicalRoot: string;
  reference: string;
  maxBytes: number;
  expectedSize?: number;
  expectedSha256?: string;
  beforeAndAfterRead(): Promise<void>;
}): Promise<Buffer> {
  if (!HASH.test(options.reference)) {
    throw new Error(
      "Offline import blob reference is not a lowercase SHA-256 digest",
    );
  }
  if (!constants.O_NOFOLLOW) {
    throw new Error(
      "This standalone host cannot enforce no-follow catalog reads",
    );
  }
  const path = join(options.canonicalRoot, options.reference);
  await options.beforeAndAfterRead();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    await options.beforeAndAfterRead();
    const opened = await file.stat();
    await options.beforeAndAfterRead();
    if (
      !opened.isFile() ||
      opened.size < 0 ||
      opened.size > options.maxBytes ||
      (options.expectedSize !== undefined &&
        opened.size !== options.expectedSize)
    ) {
      throw new Error(
        `Offline import ${options.reference} exceeds its declared size`,
      );
    }
    await options.beforeAndAfterRead();
    const size = options.expectedSize ?? opened.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > options.maxBytes) {
      throw new Error(
        `Offline import ${options.reference} exceeds its read bound`,
      );
    }
    bytes = Buffer.allocUnsafe(size);
    const digest = createHash("sha256");
    let offset = 0;
    while (offset < size) {
      const end = Math.min(offset + 64 * 1024, size);
      await options.beforeAndAfterRead();
      const { bytesRead } = await file.read(
        bytes,
        offset,
        end - offset,
        offset,
      );
      await options.beforeAndAfterRead();
      if (bytesRead === 0) {
        throw new Error(
          `Offline import ${options.reference} was truncated during read`,
        );
      }
      digest.update(bytes.subarray(offset, offset + bytesRead));
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    await options.beforeAndAfterRead();
    const extraRead = await file.read(extra, 0, 1, size);
    await options.beforeAndAfterRead();
    await options.beforeAndAfterRead();
    const final = await file.stat();
    await options.beforeAndAfterRead();
    await options.beforeAndAfterRead();
    const pathStat = await lstat(path);
    await options.beforeAndAfterRead();
    if (
      offset !== size ||
      extraRead.bytesRead !== 0 ||
      final.size !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.size !== opened.size ||
      pathStat.dev !== opened.dev ||
      pathStat.ino !== opened.ino
    ) {
      throw new Error(
        `Offline import ${options.reference} changed during read`,
      );
    }
    const actual = digest.digest("hex");
    const expected = options.expectedSha256 ?? options.reference;
    if (actual !== expected || expected !== options.reference) {
      throw new Error(
        `Offline import ${options.reference} content hash mismatch`,
      );
    }
  } finally {
    await file.close();
  }
  await options.beforeAndAfterRead();
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class BoundedManagedWorkImportCatalog implements BlobTransport {
  readonly #options: BoundedManagedWorkImportCatalogOptions;
  readonly #allowlist = new Map<string, BlobDeclaration>();
  readonly #smallBlobs = new Map<string, Buffer>();
  #prepared = false;
  #manifest!: ManagedWorkBundleManifest;

  constructor(options: BoundedManagedWorkImportCatalogOptions) {
    this.#options = options;
    if (!HASH.test(options.manifestReference)) {
      throw new Error("Offline import manifest reference is invalid");
    }
  }

  async prepare(): Promise<{ manifest: ManagedWorkBundleManifest }> {
    if (this.#prepared) return { manifest: this.#manifest };
    const outerBytes = await readBoundedRegularFile({
      canonicalRoot: this.#options.canonicalRoot,
      reference: this.#options.manifestReference,
      maxBytes: PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
      beforeAndAfterRead: this.#options.beforeAndAfterRead,
    });
    const manifest = parseManagedWorkBundleManifestBytes(
      outerBytes,
      this.#options.manifestReference,
    );
    const innerBytes = await readBoundedRegularFile({
      canonicalRoot: this.#options.canonicalRoot,
      reference: manifest.workspaceManifestReference,
      maxBytes: PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
      beforeAndAfterRead: this.#options.beforeAndAfterRead,
    });
    let innerValue: unknown;
    try {
      innerValue = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(innerBytes),
      );
    } catch {
      throw new Error(
        "Managed-work inner workspace manifest is not valid JSON",
      );
    }
    if (!isRecord(innerValue)) {
      throw new Error("Managed-work inner workspace manifest is malformed");
    }
    const sourceWorkspace = {
      ...innerValue,
      runtimeArtifact: null,
      attachments: [],
    };
    const sourceWorkspaceBytes = new TextEncoder().encode(
      canonicalManagedWorkJson(sourceWorkspace),
    );
    const sourceWorkspaceReference = sha256(sourceWorkspaceBytes);
    const verified = preflightManagedWorkBundleMetadata({
      manifestBytes: outerBytes,
      manifestReference: this.#options.manifestReference,
      sourceWorkspaceManifestBytes: sourceWorkspaceBytes,
      sourceWorkspaceManifestReference: sourceWorkspaceReference,
      innerWorkspaceManifestBytes: innerBytes,
      expectedRuntimeRequirements: [
        ...MANAGED_WORK_RUNTIME_REQUIREMENTS,
        ...this.#options.expectedRuntimeRequirements,
      ],
    });
    const sourceReferences = verified.sourceWorkspaceReferences;
    const workspaceFileReferences = new Set(
      manifest.workspace.workspace.entries.map((entry) => entry.sha256),
    );
    for (const reference of sourceReferences) {
      if (reference.reference === sourceWorkspaceReference) continue;
      const isFile = workspaceFileReferences.has(reference.reference);
      const role: ImportBlobRole = isFile
        ? "workspace-file"
        : reference.reference === manifest.workspace.git.bundle.reference
          ? "git-bundle"
          : "staged-patch";
      this.#addDeclaration({
        reference: reference.reference,
        size: reference.size,
        maxBytes:
          role === "workspace-file"
            ? PORTABLE_WORKSPACE_FILE_MAX_BYTES
            : PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
        role,
      });
    }
    for (const artifact of verified.privateArtifacts) {
      const role: ImportBlobRole = artifact.role;
      const maxBytes =
        role === "outer-manifest" || role === "inner-manifest"
          ? PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES
          : role === "runtime"
            ? PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES
            : PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES;
      this.#addDeclaration({
        reference: artifact.reference,
        size: artifact.size,
        maxBytes,
        role,
      });
    }
    const logicalBytes =
      manifest.workspace.git.bundle.size +
      manifest.workspace.git.stagedPatch.size +
      manifest.workspace.workspace.entries.reduce(
        (sum, entry) => sum + entry.size,
        0,
      ) +
      manifest.workspace.runtimeArtifact!.artifact.size +
      manifest.workspace.attachments.reduce(
        (sum, attachment) => sum + attachment.blob.size,
        0,
      ) +
      innerBytes.byteLength;
    if (
      !Number.isSafeInteger(logicalBytes) ||
      logicalBytes > PORTABLE_WORKSPACE_TOTAL_MAX_BYTES
    ) {
      throw new Error(
        "Managed-work import closure exceeds the total size limit",
      );
    }
    const runtimeReference = manifest.workspace.runtimeArtifact!.artifact;
    const runtimeBytes = await readBoundedRegularFile({
      canonicalRoot: this.#options.canonicalRoot,
      reference: runtimeReference.reference,
      maxBytes: PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES,
      expectedSize: runtimeReference.size,
      beforeAndAfterRead: this.#options.beforeAndAfterRead,
    });
    await verifyManagedWorkBundleRuntimeArtifact(verified, runtimeBytes);
    this.#manifest = manifest;
    this.#smallBlobs.set(this.#options.manifestReference, outerBytes);
    this.#smallBlobs.set(manifest.workspaceManifestReference, innerBytes);
    this.#smallBlobs.set(runtimeReference.reference, runtimeBytes);
    this.#prepared = true;
    return { manifest };
  }

  async getBlob(reference: string): Promise<Uint8Array> {
    if (!this.#prepared) {
      throw new Error("Offline import catalog closure has not been verified");
    }
    const declaration = this.#allowlist.get(reference);
    if (!declaration) {
      throw new Error(
        `Offline import requested an unlisted blob: ${reference}`,
      );
    }
    const cached = this.#smallBlobs.get(reference);
    if (cached) {
      await this.#options.beforeAndAfterRead();
      return cached;
    }
    return readBoundedRegularFile({
      canonicalRoot: this.#options.canonicalRoot,
      reference,
      maxBytes: declaration.maxBytes,
      expectedSize: declaration.size,
      expectedSha256: reference,
      beforeAndAfterRead: this.#options.beforeAndAfterRead,
    });
  }

  async putBlob(_bytes: Uint8Array): Promise<string> {
    throw new Error("Standalone managed-work import catalogs are read-only");
  }

  #addDeclaration(declaration: BlobDeclaration): void {
    if (
      !HASH.test(declaration.reference) ||
      !Number.isSafeInteger(declaration.size) ||
      declaration.size < 0 ||
      declaration.size > declaration.maxBytes
    ) {
      throw new Error(
        `Managed-work import ${declaration.role} metadata is out of bounds`,
      );
    }
    const existing = this.#allowlist.get(declaration.reference);
    if (existing) {
      if (existing.size !== declaration.size) {
        throw new Error(
          "Managed-work import aliases declare conflicting blob sizes",
        );
      }
      if (existing.maxBytes <= declaration.maxBytes) return;
      this.#allowlist.set(declaration.reference, {
        ...declaration,
        maxBytes: Math.min(existing.maxBytes, declaration.maxBytes),
      });
      return;
    }
    this.#allowlist.set(declaration.reference, declaration);
  }
}
