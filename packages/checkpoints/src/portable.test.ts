import { describe, expect, test } from "bun:test";
import type { WorkspaceCheckpointManifest } from "./index";
import {
  digestReadableStream,
  portableWorkspaceBlobReferences,
  Sha256Stream,
  workspaceGlobCouldMatchDescendant,
  workspacePathMatchesAny,
} from "./portable";

function minimalWorkspaceManifest(): WorkspaceCheckpointManifest {
  const hash = "a".repeat(64);
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
    policy: { includeGlobs: null, excludeGlobs: [] },
    workspace: {
      entries: [
        {
          path: "bin/data",
          kind: "file",
          size: 4,
          sha256: hash,
          executable: false,
        },
      ],
      omissions: [],
    },
    git: {
      bundle: { reference: "b".repeat(64), size: 20, sha256: "b".repeat(64) },
      stagedPatch: {
        reference: "c".repeat(64),
        size: 0,
        sha256: "c".repeat(64),
      },
      stagedPaths: [],
    },
    runtimeArtifact: null,
    attachments: [],
  };
}

describe("portable workspace checkpoint validation", () => {
  test("incremental SHA-256 matches standard empty, small and chunked vectors", async () => {
    const empty = new Sha256Stream();
    expect(empty.digest()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const small = new Sha256Stream();
    small.update(new TextEncoder().encode("abc"));
    expect(small.digest()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4095).fill(0x31));
        controller.enqueue(new Uint8Array(4096).fill(0x32));
        controller.enqueue(new Uint8Array([0, 255, 7]));
        controller.close();
      },
    });
    const result = await digestReadableStream(stream, 8194);
    const expected = new Sha256Stream();
    expected.update(new Uint8Array(4095).fill(0x31));
    expected.update(new Uint8Array(4096).fill(0x32));
    expected.update(new Uint8Array([0, 255, 7]));
    expect(result).toEqual({ reference: expected.digest(), size: 8194 });
  });

  test("returns exactly the bounded workspace object references", () => {
    const manifest = minimalWorkspaceManifest();
    const refs = portableWorkspaceBlobReferences(
      manifest,
      "d".repeat(64),
      1024,
    );
    expect(refs).toEqual([
      { reference: "a".repeat(64), size: 4 },
      { reference: "b".repeat(64), size: 20 },
      { reference: "c".repeat(64), size: 0 },
      { reference: "d".repeat(64), size: 1024 },
    ]);
  });

  test("matches the supported rooted glob language without crossing slash with single stars", () => {
    for (const path of ["foo/bar.txt", "foo/a/bar.txt", "foo/a/b/bar.txt"]) {
      expect(workspacePathMatchesAny(path, ["foo/**/bar.txt"])).toBe(true);
    }
    expect(
      workspacePathMatchesAny("nested/foo/bar.txt", ["foo/**/bar.txt"]),
    ).toBe(false);
    expect(workspacePathMatchesAny("foo/abar.txt", ["foo/**/bar.txt"])).toBe(
      false,
    );
    expect(workspacePathMatchesAny("", ["**/"])).toBe(true);
    expect(workspacePathMatchesAny("a/b/", ["**/"])).toBe(true);
    expect(workspacePathMatchesAny("a", ["**/"])).toBe(false);
    expect(workspacePathMatchesAny("foo/a/bar.txt", ["foo/*/bar.txt"])).toBe(
      true,
    );
    expect(workspacePathMatchesAny("foo/a/b/bar.txt", ["foo/*/bar.txt"])).toBe(
      false,
    );
    expect(
      workspacePathMatchesAny("packages/a/b/index.ts", [
        "packages/**/index.ts",
      ]),
    ).toBe(true);
    expect(workspacePathMatchesAny("src/file.ts", ["src/f?le.ts"])).toBe(true);
    expect(workspacePathMatchesAny("src/f/ile.ts", ["src/f?le.ts"])).toBe(
      false,
    );
    expect(workspacePathMatchesAny("nested/src/file.ts", ["src/**/*.ts"])).toBe(
      false,
    );
    expect(workspacePathMatchesAny("src/[file]+.ts", ["src/[file]+.ts"])).toBe(
      true,
    );
    expect(
      workspaceGlobCouldMatchDescendant("src/**/entry.ts", "src/feature"),
    ).toBe(true);
  });

  test("rejects exporter-excluded paths in selected workspace entries with exact glob semantics", () => {
    const forbiddenPaths = [
      ".env",
      "nested/.env",
      ".env.production",
      "nested/config/.env.local",
      "credentials",
      "nested/credentials",
      "credentials.json",
      "nested/config/credentials.pem",
      "auth.json",
      "nested/.config/auth.json",
      ".pi/agent/auth.json",
      "nested/.pi/agent/settings.json",
      ".ssh/id_ed25519",
      "nested/.ssh/config",
      "node_modules/pkg/index.js",
      "nested/node_modules/pkg/index.js",
    ];
    for (const path of forbiddenPaths) {
      const manifest = minimalWorkspaceManifest();
      manifest.workspace.entries[0]!.path = path;
      expect(() =>
        portableWorkspaceBlobReferences(manifest, "d".repeat(64), 1024),
      ).toThrow("workspace path violates the checkpoint policy");
    }

    for (const path of [
      "src/index.ts",
      "workspace/.envoy/config",
      "package/node_modules-not-managed/file.js",
    ]) {
      const manifest = minimalWorkspaceManifest();
      manifest.workspace.entries[0]!.path = path;
      expect(
        portableWorkspaceBlobReferences(manifest, "d".repeat(64), 1024),
      ).toContainEqual({ reference: "a".repeat(64), size: 4 });
    }

    const omission = minimalWorkspaceManifest();
    omission.workspace.omissions.push({ path: ".env", reason: "excluded" });
    expect(() =>
      portableWorkspaceBlobReferences(omission, "d".repeat(64), 1024),
    ).not.toThrow();
  });

  test("rejects weak policy declarations and applies declared scope to entries and staged paths", () => {
    const weakPolicy = minimalWorkspaceManifest();
    weakPolicy.workspace.entries[0]!.path = ".env";
    expect(() =>
      portableWorkspaceBlobReferences(weakPolicy, "d".repeat(64), 1024),
    ).toThrow("workspace path violates the checkpoint policy");

    const accepted = minimalWorkspaceManifest();
    accepted.policy.includeGlobs = ["src/**"];
    accepted.policy.excludeGlobs.push("src/private/**");
    accepted.workspace.entries[0]!.path = "src/public/index.ts";
    expect(() =>
      portableWorkspaceBlobReferences(accepted, "d".repeat(64), 1024),
    ).not.toThrow();

    for (const path of ["docs/readme.md", "src/private/settings.json"]) {
      const manifest = minimalWorkspaceManifest();
      manifest.policy.includeGlobs = ["src/**"];
      manifest.policy.excludeGlobs.push("src/private/**");
      manifest.workspace.entries[0]!.path = path;
      expect(() =>
        portableWorkspaceBlobReferences(manifest, "d".repeat(64), 1024),
      ).toThrow("workspace path violates the checkpoint policy");
    }

    for (const path of [
      "docs/readme.md",
      "src/private/settings.json",
      ".env",
    ]) {
      const manifest = minimalWorkspaceManifest();
      manifest.policy.includeGlobs = ["src/**"];
      manifest.policy.excludeGlobs.push("src/private/**");
      manifest.workspace.entries = [];
      manifest.git.stagedPaths = [path];
      expect(() =>
        portableWorkspaceBlobReferences(manifest, "d".repeat(64), 1024),
      ).toThrow("workspace path violates the checkpoint policy");
    }
  });

  test("rejects traversal, model/runtime artifacts, and oversized selected files", () => {
    const manifest = minimalWorkspaceManifest();
    manifest.workspace.entries[0]!.path = "../outside";
    expect(() =>
      portableWorkspaceBlobReferences(manifest, "d".repeat(64), 1024),
    ).toThrow("Unsafe workspace path");

    const runtimeManifest = minimalWorkspaceManifest();
    (runtimeManifest as { runtimeArtifact: unknown }).runtimeArtifact = {
      formatVersion: 1,
    };
    expect(() =>
      portableWorkspaceBlobReferences(runtimeManifest, "d".repeat(64), 1024),
    ).toThrow("Malformed or unsupported workspace checkpoint manifest");

    const oversized = minimalWorkspaceManifest();
    oversized.workspace.entries[0]!.size = 64 * 1024 * 1024 + 1;
    expect(() =>
      portableWorkspaceBlobReferences(oversized, "d".repeat(64), 1024),
    ).toThrow("Malformed workspace file metadata");
  });
});
