import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  open,
  appendFile,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES,
} from "@uzina/checkpoints/portable";
import {
  canonicalManagedWorkJson,
  MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
  MANAGED_WORK_BUNDLE_FORMAT,
  MANAGED_WORK_BUNDLE_VERSION,
  MANAGED_WORK_PROFILE,
  MANAGED_WORK_RUNTIME_REQUIREMENTS,
  managedWorkBundleChecksum,
} from "@uzina/checkpoints/managed-work-composition";
import { BoundedManagedWorkImportCatalog } from "../src/factory/managed-work-import-catalog";

const directories: string[] = [];

async function catalogDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "uzina-bounded-import-"));
  directories.push(directory);
  return directory;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function catalog(
  root: string,
  reference: string,
  beforeAndAfterRead = async () => {},
) {
  return new BoundedManagedWorkImportCatalog({
    canonicalRoot: root,
    manifestReference: reference,
    expectedRuntimeRequirements: [],
    beforeAndAfterRead,
  });
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("bounded standalone import catalog reads", () => {
  test("rejects an oversized outer manifest from stat before allocating its contents", async () => {
    const root = await catalogDirectory();
    const reference = "a".repeat(64);
    const file = await open(join(root, reference), "w");
    try {
      await file.truncate(PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES + 1);
    } finally {
      await file.close();
    }
    await expect(catalog(root, reference).prepare()).rejects.toThrow(
      "exceeds its declared size",
    );
  });

  test("opens catalog objects without following a symlink leaf", async () => {
    const root = await catalogDirectory();
    const bytes = Buffer.from("{}\n");
    const reference = digest(bytes);
    const target = join(root, "target");
    await writeFile(target, bytes);
    await symlink(target, join(root, reference));
    await expect(catalog(root, reference).prepare()).rejects.toThrow();
  });

  test("rejects a FIFO catalog object without waiting for a writer", async () => {
    const root = await catalogDirectory();
    const reference = "b".repeat(64);
    execFileSync("mkfifo", [join(root, reference)]);
    await expect(catalog(root, reference).prepare()).rejects.toThrow(
      "exceeds its declared size",
    );
  });

  test("preflights total closure metadata before reading an unavailable runtime", async () => {
    const root = await catalogDirectory();
    const entries = Array.from({ length: 8 }, (_, index) => ({
      path: `file-${index}.bin`,
      kind: "file" as const,
      size: 60 * 1024 * 1024,
      sha256: (index + 1).toString(16).padStart(64, "0"),
      executable: false,
    }));
    const blob = (reference: string, size: number) => ({
      reference,
      size,
      sha256: reference,
    });
    const sourceWorkspace = {
      format: "uzina-workspace-checkpoint",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      requirements: {
        minimumGitVersion: "2.39.0",
        capabilities: [
          "workspace-files-v1",
          "git-bundle-v1",
          "git-index-patch-v1",
        ],
      },
      source: {
        head: "a".repeat(40),
        branch: "main",
        gitVersion: "git version 2.39.0",
        linkedWorktree: false,
      },
      policy: { includeGlobs: null, excludeGlobs: [] },
      workspace: { entries, omissions: [] },
      git: {
        bundle: blob("b".repeat(64), 0),
        stagedPatch: blob("c".repeat(64), 0),
        stagedPaths: [],
      },
      runtimeArtifact: null,
      attachments: [],
    };
    const runtimeReference = "d".repeat(64);
    const evidenceReference = "e".repeat(64);
    const workspace = {
      ...sourceWorkspace,
      runtimeArtifact: {
        formatVersion: 1,
        mediaType: MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
        artifact: blob(runtimeReference, PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES),
        compatibilityRequirements: [...MANAGED_WORK_RUNTIME_REQUIREMENTS],
      },
      attachments: [
        {
          name: "factory-provenance.json",
          mediaType: "application/json",
          blob: blob(evidenceReference, 32 * 1024 * 1024),
        },
      ],
    };
    const innerBytes = Buffer.from(canonicalManagedWorkJson(workspace));
    const innerReference = digest(innerBytes);
    const requirements = [...MANAGED_WORK_RUNTIME_REQUIREMENTS];
    const body = {
      format: MANAGED_WORK_BUNDLE_FORMAT,
      version: MANAGED_WORK_BUNDLE_VERSION,
      profile: MANAGED_WORK_PROFILE,
      runtime: {
        formatVersion: 1,
        mediaType: MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
        requirements,
      },
      workspaceManifestReference: innerReference,
      workspace,
    };
    const outerBytes = Buffer.from(
      canonicalManagedWorkJson({
        ...body,
        sha256: managedWorkBundleChecksum(body),
      }),
    );
    const outerReference = digest(outerBytes);
    await writeFile(join(root, innerReference), innerBytes);
    await writeFile(join(root, outerReference), outerBytes);
    const bounded = catalog(root, outerReference);
    await expect(bounded.prepare()).rejects.toThrow(
      "Managed-work import closure exceeds the total size limit",
    );
  });

  test("refuses an object that grows while the opened descriptor is being read", async () => {
    const root = await catalogDirectory();
    const bytes = Buffer.from("{}\n");
    const reference = digest(bytes);
    const path = join(root, reference);
    await writeFile(path, bytes);
    let checks = 0;
    const bounded = catalog(root, reference, async () => {
      checks += 1;
      if (checks === 3) await appendFile(path, "x");
    });
    await expect(bounded.prepare()).rejects.toThrow("changed during read");
  });
});
