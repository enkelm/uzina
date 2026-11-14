import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { exportManagedWorkCheckpoint } from "@uzina/pi-runtime/checkpoint";
import {
  captureWorkspaceCheckpoint,
  restoreManagedWorkBundle,
  validateManagedWorkBundle,
  FileBlobTransport,
  type BlobTransport,
  type CapturedManagedWorkBundle,
} from "@uzina/checkpoints";
import { canonicalManagedWorkJson } from "@uzina/checkpoints/managed-work-composition";
import { portableWorkspaceBlobReferences } from "@uzina/checkpoints/portable";
import { describe, expect, test } from "bun:test";
import { openBunSqliteStorage } from "../../daemon/src/runtime/sqlite";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("managed-work composition in Miniflare workerd", () => {
  test("stores source and private bundle data separately and restores prepared-inactive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-workerd-composer-"));
    const workerDirectory = join(directory, "worker");
    const workspacePath = join(directory, "workspace");
    await mkdir(workerDirectory);
    await mkdir(workspacePath);
    git(workspacePath, "init", "--initial-branch=main", "--quiet");
    git(workspacePath, "config", "user.name", "Workerd composition");
    git(
      workspacePath,
      "config",
      "user.email",
      "workerd-composition@example.invalid",
    );
    await writeFile(join(workspacePath, "notes.txt"), "captured workspace\n");
    git(workspacePath, "add", "notes.txt");
    git(workspacePath, "commit", "-m", "captured base");
    await writeFile(join(workspacePath, "notes.txt"), "dirty workspace\n");
    const workspaceTransport = new FileBlobTransport(
      join(directory, "workspace-blobs"),
    );
    const capturedWorkspace = await captureWorkspaceCheckpoint({
      workspacePath,
      transport: workspaceTransport,
    });

    const sourceStorage = await openBunSqliteStorage(
      join(directory, "source-managed.sqlite"),
    );
    let managedWork;
    try {
      await sourceStorage.commit(
        [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
        BACKGROUND_CONTEXT,
      );
      managedWork = await exportManagedWorkCheckpoint(
        sourceStorage,
        ROOT_CONVERSATION_ID,
      );
    } finally {
      await sourceStorage.close(BACKGROUND_CONTEXT);
    }

    const reorderedWorkspaceManifest = Object.fromEntries(
      Object.entries(capturedWorkspace.manifest).reverse(),
    ) as typeof capturedWorkspace.manifest;
    const captureId = "capture:composer-workerd";
    const requestId = "checkpoint:composer-workerd";
    const sourceObjects = portableWorkspaceBlobReferences(
      capturedWorkspace.manifest,
      capturedWorkspace.manifestReference,
      capturedWorkspace.manifestBytes.byteLength,
    );
    const sourceReferences = new Set(
      sourceObjects.map((object) => object.reference),
    );
    const evidence = new TextEncoder().encode(
      JSON.stringify({ testFixture: "composer-only, not Core authority" }),
    );
    const compatibilityRequirements = [
      "model:test/fixed",
      "tool:remote_read_file:v1",
    ];
    const compositionRequest = {
      requestId,
      managedWork,
      compatibilityRequirements,
      attachments: [
        {
          name: "factory-provenance.json",
          mediaType: "application/json",
          bytes: [...evidence],
        },
      ],
      workspaceManifest: reorderedWorkspaceManifest,
      workspaceManifestReference: capturedWorkspace.manifestReference,
      workspaceManifestBytes: [...capturedWorkspace.manifestBytes],
    };

    const build = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "managed-work-composer.workerd-entry.ts"),
      ],
      outdir: workerDirectory,
      target: "browser",
      packages: "bundle",
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "Could not bundle the managed-work composer Worker fixture",
      );
    }
    const miniflare = new Miniflare({
      name: "uzina-managed-work-composer",
      script: await build.outputs[0]!.text(),
      modules: true,
      compatibilityDate: "2026-05-01",
      r2Buckets: ["CHECKPOINTS"],
    });
    try {
      const baseUrl = (await miniflare.ready).toString();
      for (const object of sourceObjects) {
        const bytes =
          object.reference === capturedWorkspace.manifestReference
            ? capturedWorkspace.manifestBytes
            : await workspaceTransport.getBlob(object.reference);
        expect(bytes.byteLength).toBe(object.size);
        const upload = await fetch(
          new URL(`/source/${captureId}/${object.reference}`, baseUrl),
          {
            method: "PUT",
            headers: { "content-length": String(bytes.byteLength) },
            body: bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          },
        );
        expect(upload.status).toBe(200);
      }

      async function compose(): Promise<{
        bundle: CapturedManagedWorkBundle;
        privateBlobs: Array<{ reference: string; size: number }>;
      }> {
        const response = await fetch(new URL("/compose", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(compositionRequest),
        });
        if (!response.ok) {
          throw new Error(
            `composition failed (${response.status}): ${await response.text()}`,
          );
        }
        return (await response.json()) as {
          bundle: CapturedManagedWorkBundle;
          privateBlobs: Array<{ reference: string; size: number }>;
        };
      }

      const result = await compose();
      const repeatedComposition = await compose();
      expect(repeatedComposition.bundle.manifestReference).toBe(
        result.bundle.manifestReference,
      );
      expect(repeatedComposition.privateBlobs).toEqual(result.privateBlobs);
      expect(result.bundle.manifest.format).toBe(
        "uzina-coherent-managed-work-checkpoint",
      );
      expect(result.bundle.manifest.profile).toBe(
        "quiescent-current-documents-no-forks-v1",
      );
      expect(result.privateBlobs).toHaveLength(4);
      expect(
        result.privateBlobs.some((object) =>
          sourceReferences.has(object.reference),
        ),
      ).toBe(false);
      expect(result.bundle.manifest.workspace.git).toEqual(
        capturedWorkspace.manifest.git,
      );
      expect(result.bundle.manifest.workspace.workspace).toEqual(
        capturedWorkspace.manifest.workspace,
      );
      expect(result.bundle.manifest.workspace.policy).toEqual(
        capturedWorkspace.manifest.policy,
      );

      const runtimeArtifact = result.bundle.manifest.workspace.runtimeArtifact;
      if (!runtimeArtifact)
        throw new Error("Composed runtime artifact is absent");
      const innerManifestBytes = new TextEncoder().encode(
        JSON.stringify(result.bundle.manifest.workspace),
      );
      const outerManifestBytes = new TextEncoder().encode(
        canonicalManagedWorkJson(result.bundle.manifest),
      );
      expect(sha256(innerManifestBytes)).toBe(
        result.bundle.manifest.workspaceManifestReference,
      );
      expect(sha256(outerManifestBytes)).toBe(result.bundle.manifestReference);
      expect(
        result.privateBlobs.map(({ reference }) => reference).sort(),
      ).toEqual(
        [
          runtimeArtifact.artifact.reference,
          ...result.bundle.manifest.workspace.attachments.map(
            (attachment) => attachment.blob.reference,
          ),
          result.bundle.manifest.workspaceManifestReference,
          result.bundle.manifestReference,
        ].sort(),
      );

      const sourceProbe = await fetch(
        new URL(
          `/source-probe/${captureId}/${runtimeArtifact.artifact.reference}`,
          baseUrl,
        ),
      );
      expect(await sourceProbe.json()).toEqual({ found: false });
      const otherRequest = await fetch(
        new URL("/private-list/checkpoint:other-request", baseUrl),
      );
      expect(await otherRequest.json()).toEqual([]);

      const assembledTransport: BlobTransport = {
        async putBlob() {
          throw new Error("local validation is read-only");
        },
        async getBlob(reference) {
          if (sourceReferences.has(reference)) {
            return workspaceTransport.getBlob(reference);
          }
          const blob = await fetch(
            new URL(`/blob/${requestId}/${reference}`, baseUrl),
          );
          if (!blob.ok)
            throw new Error(`workerd blob unavailable: ${reference}`);
          return new Uint8Array(await blob.arrayBuffer());
        },
      };
      const validation = await validateManagedWorkBundle(
        result.bundle.manifestReference,
        assembledTransport,
        { supportedRuntimeRequirements: compatibilityRequirements },
      );
      expect(validation.managedWork).toEqual(managedWork);

      const restored = await restoreManagedWorkBundle({
        manifestReference: result.bundle.manifestReference,
        transport: assembledTransport,
        destinationPath: join(directory, "prepared-inactive"),
        supportedRuntimeRequirements: compatibilityRequirements,
        async openStorage(path) {
          const storage = await openBunSqliteStorage(path);
          return {
            storage,
            close: () => storage.close(BACKGROUND_CONTEXT),
          };
        },
      });
      expect(restored.receipt.status).toBe("prepared-inactive");
      expect(
        await Bun.file(join(restored.workspacePath, "notes.txt")).text(),
      ).toBe("dirty workspace\n");
      expect(restored.provenanceAttachments).toHaveLength(1);
      expect(restored.provenanceAttachments[0]?.bytes).toEqual(evidence);
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
