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
import { describe, expect, test } from "bun:test";
import { openBunSqliteStorage } from "../../daemon/src/runtime/sqlite";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("managed-work composition in Miniflare workerd", () => {
  test("composes already-captured inputs using content-addressed R2 without source blob reads", async () => {
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
      const evidence = new TextEncoder().encode(
        JSON.stringify({ profile: "factory-provenance-v1", commands: [] }),
      );
      const response = await fetch(new URL("/compose", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          managedWork,
          compatibilityRequirements: [
            "model:test/fixed",
            "tool:remote_read_file:v1",
          ],
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
        }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        bundle: CapturedManagedWorkBundle;
        writes: string[];
      };
      expect(result.bundle.manifest.format).toBe(
        "uzina-coherent-managed-work-checkpoint",
      );
      expect(result.bundle.manifest.profile).toBe(
        "quiescent-current-documents-no-forks-v1",
      );
      expect(result.writes).toHaveLength(4);
      const sourceReferences = new Set([
        capturedWorkspace.manifestReference,
        capturedWorkspace.manifest.git.bundle.reference,
        capturedWorkspace.manifest.git.stagedPatch.reference,
        ...capturedWorkspace.manifest.workspace.entries.map(
          (entry) => entry.sha256,
        ),
      ]);
      expect(
        result.writes.some((reference) => sourceReferences.has(reference)),
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

      const assembledTransport: BlobTransport = {
        async putBlob() {
          throw new Error("local validation is read-only");
        },
        async getBlob(reference) {
          if (sourceReferences.has(reference)) {
            return workspaceTransport.getBlob(reference);
          }
          const blob = await fetch(new URL(`/blob/${reference}`, baseUrl));
          if (!blob.ok)
            throw new Error(`workerd blob unavailable: ${reference}`);
          return new Uint8Array(await blob.arrayBuffer());
        },
      };
      const validation = await validateManagedWorkBundle(
        result.bundle.manifestReference,
        assembledTransport,
        {
          supportedRuntimeRequirements: [
            "model:test/fixed",
            "tool:remote_read_file:v1",
          ],
        },
      );
      expect(validation.managedWork).toEqual(managedWork);

      const restored = await restoreManagedWorkBundle({
        manifestReference: result.bundle.manifestReference,
        transport: assembledTransport,
        destinationPath: join(directory, "prepared-inactive"),
        supportedRuntimeRequirements: [
          "model:test/fixed",
          "tool:remote_read_file:v1",
        ],
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
