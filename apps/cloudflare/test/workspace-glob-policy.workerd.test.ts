import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "bun:test";
import type { WorkspaceCheckpointManifest } from "@uzina/checkpoints";

const EMPTY_FILE_REFERENCE =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const WORKER_RESPONSE_TIMEOUT_MS = 2_000;

function makeManifest(
  paths: string[],
  includeGlobs: string[],
  stagedPaths: string[] = [],
): WorkspaceCheckpointManifest {
  return {
    format: "uzina-workspace-checkpoint",
    version: 1,
    createdAt: new Date(0).toISOString(),
    requirements: {
      minimumGitVersion: "2.20.0",
      capabilities: [
        "workspace-files-v1",
        "git-bundle-v1",
        "git-index-patch-v1",
      ],
    },
    source: {
      head: "a".repeat(40),
      branch: "main",
      gitVersion: "2.43.0",
      linkedWorktree: false,
    },
    policy: { includeGlobs, excludeGlobs: [] },
    workspace: {
      entries: paths.map((path) => ({
        path,
        kind: "file",
        size: 0,
        sha256: EMPTY_FILE_REFERENCE,
        executable: false,
      })),
      omissions: [],
    },
    git: {
      bundle: { reference: "b".repeat(64), size: 20, sha256: "b".repeat(64) },
      stagedPatch: {
        reference: "c".repeat(64),
        size: 0,
        sha256: "c".repeat(64),
      },
      stagedPaths,
    },
    runtimeArtifact: null,
    attachments: [],
  };
}

function requestBody(manifest: WorkspaceCheckpointManifest): string {
  const serialized = JSON.stringify(manifest);
  const manifestBytes = Buffer.byteLength(serialized);
  return JSON.stringify({
    manifest,
    manifestReference: createHash("sha256").update(serialized).digest("hex"),
    manifestBytes,
  });
}

async function dispatchBounded(miniflare: Miniflare, body: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      miniflare.dispatchFetch("http://uzina.test/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Workerd portable manifest validation did not finish within ${WORKER_RESPONSE_TIMEOUT_MS} ms`,
              ),
            ),
          WORKER_RESPONSE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runWorkerdValidation(
  miniflare: Miniflare,
  manifest: WorkspaceCheckpointManifest,
) {
  const response = await dispatchBounded(miniflare, requestBody(manifest));
  return response;
}

describe("portable checkpoint glob validation in Workerd", () => {
  test("promptly rejects hostile and over-budget manifest policies and accepts a matching glob", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-glob-policy-"));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "workspace-glob-policy-worker.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "Workspace glob policy worker build failed",
      );
    }
    const miniflare = new Miniflare({
      name: "uzina-portable-glob-policy",
      script: await build.outputs[0]!.text(),
      modules: true,
      compatibilityDate: "2026-05-01",
    });
    try {
      const backtrackingGlob = `${"a*".repeat(18)}z`;
      const falseManifest = makeManifest(
        [`${"a".repeat(36)}y`],
        [backtrackingGlob],
      );
      const falseResult = await runWorkerdValidation(miniflare, falseManifest);
      expect(falseResult.status).toBe(422);
      expect(await falseResult.json()).toMatchObject({
        outcome: "rejected",
        error: "workspace path violates the checkpoint policy",
      });

      const trueManifest = makeManifest(
        [`${"a".repeat(36)}z`],
        [backtrackingGlob],
      );
      const trueResult = await runWorkerdValidation(miniflare, trueManifest);
      expect(trueResult.status).toBe(200);
      expect(await trueResult.json()).toMatchObject({
        outcome: "accepted",
      });

      const repeatedWildcardGlob = `${"*a".repeat(18)}b*a*`;
      const repeatedWildcardManifest = makeManifest(
        [`${"a".repeat(36)}b`],
        [repeatedWildcardGlob],
      );
      const repeatedWildcardResult = await runWorkerdValidation(
        miniflare,
        repeatedWildcardManifest,
      );
      expect(repeatedWildcardResult.status).toBe(422);
      expect(await repeatedWildcardResult.json()).toMatchObject({
        outcome: "rejected",
        error: "workspace path violates the checkpoint policy",
      });

      const workLimitedGlobs = [
        ...Array.from(
          { length: 127 },
          (_, index) => `${"*a".repeat(index + 1)}b*`,
        ),
        "z*",
      ];
      const workLimitedPaths = Array.from(
        { length: 16 },
        (_, index) => `z${"a".repeat(600)}${index.toString().padStart(4, "0")}`,
      );
      const entriesOnly = await runWorkerdValidation(
        miniflare,
        makeManifest(workLimitedPaths.slice(0, 1), workLimitedGlobs),
      );
      expect(entriesOnly.status).toBe(200);
      expect(await entriesOnly.json()).toMatchObject({ outcome: "accepted" });
      const entriesAndStagedPaths = makeManifest(
        workLimitedPaths.slice(0, 1),
        workLimitedGlobs,
        workLimitedPaths.slice(1),
      );
      const overBudget = await runWorkerdValidation(
        miniflare,
        entriesAndStagedPaths,
      );
      expect(overBudget.status).toBe(422);
      expect(await overBudget.json()).toMatchObject({
        outcome: "rejected",
        error:
          "Workspace checkpoint glob matching exceeded its validation work limit",
      });
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
