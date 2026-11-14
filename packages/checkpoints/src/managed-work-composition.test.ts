import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedWorkCheckpoint } from "@uzina/pi-runtime/checkpoint";
import { validateManagedWorkCheckpoint } from "@uzina/pi-runtime/checkpoint";
import { describe, expect, test } from "bun:test";
import {
  captureManagedWorkBundle,
  captureWorkspaceCheckpoint,
  FileBlobTransport,
  WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES,
  type BlobTransport,
  type WorkspaceCheckpointManifest,
} from "./index";
import {
  composeManagedWorkBundleFromWorkspace,
  prepareManagedWorkBundleComposition,
  type ComposeManagedWorkBundleFromWorkspaceOptions,
  type PreparedManagedWorkBundleComposition,
} from "./managed-work-composition";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "uzina-managed-work-composition-"));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function serializedWorkspace(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { bytes, reference: sha256(bytes) };
}

function managedWorkFixture(): ManagedWorkCheckpoint {
  const body = {
    format: "uzina.pi-managed-work" as const,
    version: 1 as const,
    profile: "quiescent-current-documents-no-forks-v1" as const,
    rootConversationId: 1 as ManagedWorkCheckpoint["rootConversationId"],
    capturedAt: Date.now(),
    conversations: [{ id: 1 as ManagedWorkCheckpoint["rootConversationId"] }],
    entries: [],
    tasks: [],
    submissions: [],
    documents: [],
    limitations: [],
  };
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const digest = sha256(bytes);
  return { ...body, sha256: digest } as ManagedWorkCheckpoint;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function fixture(root: string) {
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  git(workspacePath, "init", "--initial-branch=main", "--quiet");
  git(workspacePath, "config", "user.name", "Composition test");
  git(workspacePath, "config", "user.email", "composition@example.invalid");
  await writeFile(join(workspacePath, "tracked.txt"), "base workspace\n");
  git(workspacePath, "add", "tracked.txt");
  git(workspacePath, "commit", "-m", "base");
  await writeFile(join(workspacePath, "tracked.txt"), "dirty workspace\n");

  const transport = new FileBlobTransport(join(root, "workspace-blobs"));
  const captured = await captureWorkspaceCheckpoint({
    workspacePath,
    transport,
  });
  return {
    captured,
    managedWork: managedWorkFixture(),
    transport,
    workspacePath,
  };
}

function noWorkspaceReads(
  base: BlobTransport,
  writes: string[],
): BlobTransport {
  return {
    async putBlob(bytes) {
      const reference = await base.putBlob(bytes);
      writes.push(reference);
      return reference;
    },
    async getBlob() {
      throw new Error("composition must not read source workspace objects");
    },
  };
}

function composeOptions(
  prepared: PreparedManagedWorkBundleComposition,
  captured: Awaited<ReturnType<typeof captureWorkspaceCheckpoint>>,
  transport: BlobTransport,
): ComposeManagedWorkBundleFromWorkspaceOptions {
  return {
    prepared,
    workspaceManifest: captured.manifest,
    workspaceManifestReference: captured.manifestReference,
    workspaceManifestBytes: captured.manifestBytes,
    transport,
  };
}

describe("managed-work bundle composition from captured workspaces", () => {
  test("rejects mismatched, non-workspace-only, unsupported, and over-limit inputs before publication", async () => {
    const root = await temporaryDirectory();
    try {
      const source = await fixture(root);
      const writes: string[] = [];
      const transport = noWorkspaceReads(source.transport, writes);
      const prepared = await prepareManagedWorkBundleComposition({
        managedWork: source.managedWork,
      });
      const base = composeOptions(prepared, source.captured, transport);

      const mismatchedBytes = new Uint8Array(source.captured.manifestBytes);
      mismatchedBytes[0] ^= 1;
      await expect(
        composeManagedWorkBundleFromWorkspace({
          ...base,
          workspaceManifestBytes: mismatchedBytes,
        }),
      ).rejects.toThrow("Workspace manifest content hash mismatch");
      await expect(
        composeManagedWorkBundleFromWorkspace({
          ...base,
          workspaceManifestReference: "0".repeat(64),
          workspaceManifestBytes: new Uint8Array(
            WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES + 1,
          ),
        }),
      ).rejects.toThrow("Workspace manifest exceeds its size limit");
      expect(writes).toEqual([]);

      const mismatchedMetadata = {
        ...source.captured.manifest,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(
        composeManagedWorkBundleFromWorkspace({
          ...base,
          workspaceManifest: mismatchedMetadata,
        }),
      ).rejects.toThrow("Workspace manifest/reference/bytes mismatch");
      expect(writes).toEqual([]);

      const unknownField = {
        ...source.captured.manifest,
        futureField: true,
      } as WorkspaceCheckpointManifest;
      const unknownSource = serializedWorkspace(unknownField);
      await expect(
        composeManagedWorkBundleFromWorkspace({
          ...base,
          workspaceManifest: unknownField,
          workspaceManifestReference: unknownSource.reference,
          workspaceManifestBytes: unknownSource.bytes,
        }),
      ).rejects.toThrow(
        "Malformed or unsupported workspace checkpoint manifest",
      );
      expect(writes).toEqual([]);

      const runtimeSlot = {
        ...source.captured.manifest,
        runtimeArtifact: {
          formatVersion: 1,
          mediaType: "application/octet-stream",
          artifact: {
            reference: "a".repeat(64),
            sha256: "a".repeat(64),
            size: 1,
          },
          compatibilityRequirements: [],
        },
      };
      const runtimeSource = serializedWorkspace(runtimeSlot);
      await expect(
        composeManagedWorkBundleFromWorkspace({
          ...base,
          workspaceManifest: runtimeSlot,
          workspaceManifestReference: runtimeSource.reference,
          workspaceManifestBytes: runtimeSource.bytes,
        }),
      ).rejects.toThrow(
        "Malformed or unsupported workspace checkpoint manifest",
      );
      expect(writes).toEqual([]);

      const attachmentSlot = {
        ...source.captured.manifest,
        attachments: [
          {
            name: "runtime.json",
            mediaType: "application/json",
            blob: {
              reference: "b".repeat(64),
              sha256: "b".repeat(64),
              size: 1,
            },
          },
        ],
      };
      const attachmentSource = serializedWorkspace(attachmentSlot);
      await expect(
        composeManagedWorkBundleFromWorkspace({
          ...base,
          workspaceManifest: attachmentSlot,
          workspaceManifestReference: attachmentSource.reference,
          workspaceManifestBytes: attachmentSource.bytes,
        }),
      ).rejects.toThrow(
        "Malformed or unsupported workspace checkpoint manifest",
      );
      expect(writes).toEqual([]);

      const unsupportedProfile = structuredClone(source.managedWork);
      unsupportedProfile.profile = "unsupported-profile" as never;
      await expect(
        prepareManagedWorkBundleComposition({
          managedWork: unsupportedProfile,
        }),
      ).rejects.toThrow("Unsupported or malformed managed-work checkpoint");
      await expect(
        prepareManagedWorkBundleComposition({
          managedWork: source.managedWork,
          compatibilityRequirements: ["  "],
        }),
      ).rejects.toThrow("Managed-work compatibility requirements are invalid");
      await expect(
        prepareManagedWorkBundleComposition({
          managedWork: source.managedWork,
          limits: { maxRuntimeBytes: 1 },
        }),
      ).rejects.toThrow("Managed-work runtime artifact exceeds its size limit");
      await expect(
        prepareManagedWorkBundleComposition({
          managedWork: source.managedWork,
          attachments: [
            {
              name: "evidence.json",
              mediaType: "application/json",
              bytes: new Uint8Array([1, 2]),
            },
          ],
          limits: { maxAttachmentBytes: 1 },
        }),
      ).rejects.toThrow("Checkpoint attachment exceeds the size limit");

      const workspaceDataBytes =
        source.captured.manifest.git.bundle.size +
        source.captured.manifest.git.stagedPatch.size +
        source.captured.manifest.workspace.entries.reduce(
          (sum, entry) => sum + entry.size,
          0,
        );
      const evidenceBytes = new Uint8Array([1, 2, 3, 4]);
      const attachmentBounded = await prepareManagedWorkBundleComposition({
        managedWork: source.managedWork,
        attachments: [
          {
            name: "factory-provenance.json",
            mediaType: "application/json",
            bytes: evidenceBytes,
          },
        ],
        limits: {
          maxCheckpointBytes:
            workspaceDataBytes + prepared.runtimeBytes.byteLength + 2,
        },
      });
      await expect(
        composeManagedWorkBundleFromWorkspace(
          composeOptions(attachmentBounded, source.captured, transport),
        ),
      ).rejects.toThrow("Checkpoint data exceeds the configured byte limit");
      expect(writes).toEqual([]);

      const manifestBounded = await prepareManagedWorkBundleComposition({
        managedWork: source.managedWork,
        attachments: [
          {
            name: "factory-provenance.json",
            mediaType: "application/json",
            bytes: evidenceBytes,
          },
        ],
        limits: {
          maxCheckpointBytes:
            workspaceDataBytes +
            prepared.runtimeBytes.byteLength +
            evidenceBytes.byteLength,
        },
      });
      await expect(
        composeManagedWorkBundleFromWorkspace(
          composeOptions(manifestBounded, source.captured, transport),
        ),
      ).rejects.toThrow(
        "Checkpoint manifest exceeds the configured total byte limit",
      );
      expect(writes).toEqual([]);

      const tooSmallFile = await prepareManagedWorkBundleComposition({
        managedWork: source.managedWork,
        limits: { maxFileBytes: 1 },
      });
      await expect(
        composeManagedWorkBundleFromWorkspace(
          composeOptions(tooSmallFile, source.captured, transport),
        ),
      ).rejects.toThrow("Workspace file exceeds the configured size limit");
      expect(writes).toEqual([]);

      const badReturn: BlobTransport = {
        async putBlob() {
          return "0".repeat(64);
        },
        async getBlob() {
          throw new Error("unexpected source object read");
        },
      };
      await expect(
        composeManagedWorkBundleFromWorkspace(
          composeOptions(prepared, source.captured, badReturn),
        ),
      ).rejects.toThrow(
        "Blob transport must return the SHA-256 content address",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a corrupted Pi checksum before preparing a runtime artifact", async () => {
    const root = await temporaryDirectory();
    try {
      const source = await fixture(root);
      const corrupted = structuredClone(source.managedWork);
      corrupted.sha256 = "0".repeat(64);
      await expect(validateManagedWorkCheckpoint(corrupted)).rejects.toThrow(
        "Managed-work checkpoint checksum mismatch",
      );
      await expect(
        prepareManagedWorkBundleComposition({ managedWork: corrupted }),
      ).rejects.toThrow("Managed-work checkpoint checksum mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflights Pi, requirements, and aggregate bytes before Node workspace capture or blob writes", async () => {
    let writes = 0;
    const transport: BlobTransport = {
      async putBlob() {
        writes += 1;
        return "0".repeat(64);
      },
      async getBlob() {
        throw new Error("unexpected blob read");
      },
    };
    const invalidProfile = managedWorkFixture();
    invalidProfile.profile = "unknown-profile" as never;
    await expect(
      captureManagedWorkBundle({
        managedWork: invalidProfile,
        workspacePath: "/no-such-workspace-for-preflight-test",
        transport,
      }),
    ).rejects.toThrow("Unsupported or malformed managed-work checkpoint");
    await expect(
      captureManagedWorkBundle({
        managedWork: managedWorkFixture(),
        compatibilityRequirements: [" "],
        workspacePath: "/no-such-workspace-for-preflight-test",
        transport,
      }),
    ).rejects.toThrow("Managed-work compatibility requirements are invalid");

    const managedWork = managedWorkFixture();
    const sharedBytes = new Uint8Array(1024).fill(42);
    const attachments = Array.from({ length: 17 }, (_, index) => ({
      name: `evidence-${index}.bin`,
      mediaType: "application/octet-stream",
      bytes: sharedBytes,
    }));
    const artifactBytes = new TextEncoder().encode(
      canonicalJson(managedWork),
    ).byteLength;
    const aggregateBytes = artifactBytes + 17 * sharedBytes.byteLength;
    await expect(
      captureManagedWorkBundle({
        managedWork,
        attachments,
        limits: { maxCheckpointBytes: aggregateBytes - 1 },
        workspacePath: "/no-such-workspace-for-preflight-test",
        transport,
      }),
    ).rejects.toThrow("Checkpoint data exceeds the configured byte limit");
    await expect(
      captureManagedWorkBundle({
        managedWork,
        limits: { maxCheckpointBytes: 1 },
        workspacePath: "/no-such-workspace-for-preflight-test",
        transport,
      }),
    ).rejects.toThrow("Managed-work runtime artifact exceeds its size limit");
    expect(writes).toBe(0);

    // The preparation budget includes every named attachment, even when they
    // share one input buffer. Workspace/manifest bytes are checked at composition.
    const exactBudget = await prepareManagedWorkBundleComposition({
      managedWork,
      attachments,
      limits: { maxCheckpointBytes: aggregateBytes },
    });
    expect(exactBudget.attachments).toHaveLength(17);
  });

  test("rejects a supplied reference that does not match the workspace manifest bytes", async () => {
    const root = await temporaryDirectory();
    try {
      const source = await fixture(root);
      const writes: string[] = [];
      const prepared = await prepareManagedWorkBundleComposition({
        managedWork: source.managedWork,
      });
      await expect(
        composeManagedWorkBundleFromWorkspace({
          ...composeOptions(
            prepared,
            source.captured,
            noWorkspaceReads(source.transport, writes),
          ),
          workspaceManifestReference: "f".repeat(64),
        }),
      ).rejects.toThrow("Workspace manifest content hash mismatch");
      expect(writes).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
