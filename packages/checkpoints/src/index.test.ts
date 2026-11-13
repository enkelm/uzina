import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorkspaceCheckpoint,
  FileBlobTransport,
  loadWorkspaceCheckpoint,
  previewWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  validateWorkspaceCheckpoint,
  type BlobTransport,
} from "./index";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "uzina-checkpoint-test-"));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeLinkedDirtyRepository(
  root: string,
): Promise<{ source: string; base: string }> {
  const base = join(root, "repository");
  const source = join(root, "linked-checkout");
  await mkdir(base, { recursive: true });
  git(base, "init", "--initial-branch=main", "--quiet");
  git(base, "config", "user.name", "Checkpoint Test");
  git(base, "config", "user.email", "checkpoint@example.invalid");
  await writeFile(join(base, ".gitignore"), ".env\n");
  await writeFile(join(base, "notes.txt"), "base text\n");
  await writeFile(join(base, "image.bin"), Buffer.from([0, 255, 1, 0, 128]));
  await writeFile(join(base, "tool.sh"), "#!/bin/sh\necho base\n", {
    mode: 0o644,
  });
  git(base, "add", ".gitignore", "notes.txt", "image.bin", "tool.sh");
  git(base, "commit", "-m", "initial");
  git(base, "branch", "preserved");
  git(base, "tag", "checkpoint-test");
  git(base, "worktree", "add", "-b", "transfer", source, "main");

  await writeFile(join(source, "notes.txt"), "staged text\n");
  git(source, "add", "notes.txt");
  await writeFile(join(source, "notes.txt"), "staged then unstaged text\n");
  await writeFile(
    join(source, "image.bin"),
    Buffer.from([0, 255, 1, 0, 129, 0]),
  );
  git(source, "add", "image.bin");
  await writeFile(
    join(source, "image.bin"),
    Buffer.from([0, 255, 1, 0, 130, 0, 255]),
  );
  await chmod(join(source, "tool.sh"), 0o755);
  git(source, "add", "tool.sh");
  await writeFile(join(source, "new.bin"), Buffer.from([255, 0, 254, 128]));
  await writeFile(join(source, ".env"), "never exported\n");
  return { source, base };
}

async function capture(root: string) {
  const source = await makeLinkedDirtyRepository(root);
  const transport = new FileBlobTransport(join(root, "blobs"));
  const captured = await captureWorkspaceCheckpoint({
    workspacePath: source.source,
    transport,
    runtimeArtifact: {
      formatVersion: 7,
      mediaType: "application/vnd.uzina.runtime+binary",
      bytes: Buffer.from([0, 9, 255, 0]),
      compatibilityRequirements: ["pi-durable:1.x"],
    },
    attachments: [
      {
        name: "image-1",
        mediaType: "image/png",
        bytes: Buffer.from([137, 80, 0, 255]),
      },
    ],
  });
  return { ...source, transport, captured };
}

describe("workspace checkpoints", () => {
  test("round-trips a linked worktree's refs, Git index, dirty files, modes, binaries, and opaque artifacts", async () => {
    const root = await temporaryDirectory();
    try {
      const { source, base, transport, captured } = await capture(root);
      const sourceStatus = git(
        source,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      );
      const sourceStaged = git(source, "diff", "--cached", "--binary", "HEAD");
      const sourceUnstaged = git(source, "diff", "--binary");
      const sourceRefs = git(
        source,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      );
      expect(
        await loadWorkspaceCheckpoint(captured.manifestReference, transport),
      ).toEqual(captured.manifest);
      const preview = await previewWorkspaceCheckpoint(
        captured.manifest,
        transport,
        {
          supportedRuntimeFormats: [7],
          supportedRuntimeRequirements: ["pi-durable:1.x"],
        },
      );
      expect(preview.valid).toBe(true);
      expect(preview.preview?.linkedWorktreeSource).toBe(true);
      expect(preview.preview?.omissions).toContainEqual({
        path: ".env",
        reason: "excluded",
      });
      expect(preview.preview?.runtimeArtifact?.formatVersion).toBe(7);

      const destination = join(root, "restored");
      const restored = await restoreWorkspaceCheckpoint({
        manifest: captured.manifest,
        transport,
        destinationPath: destination,
        supportedRuntimeFormats: [7],
        supportedRuntimeRequirements: ["pi-durable:1.x"],
      });
      expect(restored.runtimeArtifact?.bytes).toEqual(
        Buffer.from([0, 9, 255, 0]),
      );
      expect(restored.attachments[0]?.bytes).toEqual(
        Buffer.from([137, 80, 0, 255]),
      );
      expect(await readFile(join(destination, "image.bin"))).toEqual(
        await readFile(join(source, "image.bin")),
      );
      expect((await readFile(join(destination, "tool.sh"))).toString()).toBe(
        "#!/bin/sh\necho base\n",
      );
      expect(
        (await Bun.file(join(destination, "tool.sh")).stat()).mode! & 0o111,
      ).not.toBe(0);
      expect(await Bun.file(join(destination, ".env")).exists()).toBe(false);
      expect(
        git(destination, "status", "--porcelain=v1", "--untracked-files=all"),
      ).toBe(sourceStatus);
      expect(git(destination, "diff", "--cached", "--binary", "HEAD")).toBe(
        sourceStaged,
      );
      expect(git(destination, "diff", "--binary")).toBe(sourceUnstaged);
      expect(
        git(destination, "for-each-ref", "--format=%(refname) %(objectname)"),
      ).toBe(sourceRefs);
      expect(git(destination, "log", "-1", "--format=%H", "main")).toBe(
        git(base, "rev-parse", "main"),
      );
      expect(git(destination, "rev-parse", "HEAD")).toBe(
        git(source, "rev-parse", "HEAD"),
      );
      expect(
        git(destination, "show-ref", "--verify", "refs/tags/checkpoint-test"),
      ).toContain("checkpoint-test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe, duplicate, conflicting, incompatible, and corrupt manifests before restore", async () => {
    const root = await temporaryDirectory();
    try {
      const { transport, captured } = await capture(root);
      const base = captured.manifest;
      const unsafe = structuredClone(base);
      unsafe.workspace.entries[0]!.path = "../outside";
      expect(
        (await validateWorkspaceCheckpoint(unsafe, transport)).issues.join(" "),
      ).toContain("unsafe or non-portable workspace path");

      const duplicate = structuredClone(base);
      duplicate.workspace.entries.push({ ...duplicate.workspace.entries[0]! });
      expect(
        (await validateWorkspaceCheckpoint(duplicate, transport)).issues.join(
          " ",
        ),
      ).toContain("duplicate workspace entry");

      const conflict = structuredClone(base);
      conflict.workspace.entries.push({
        path: "notes.txt/child",
        kind: "file",
        size: 0,
        sha256: "0".repeat(64),
        executable: false,
      });
      expect(
        (await validateWorkspaceCheckpoint(conflict, transport)).issues.join(
          " ",
        ),
      ).toContain("conflicting workspace entries");

      const incompatible = structuredClone(base);
      incompatible.version = 2;
      expect(
        (
          await validateWorkspaceCheckpoint(incompatible, transport)
        ).issues.join(" "),
      ).toContain("incompatible checkpoint version");

      const runtimeRefusal = await validateWorkspaceCheckpoint(base, transport);
      expect(runtimeRefusal.issues.join(" ")).toContain(
        "runtime artifact format 7",
      );
      const requirementRefusal = await validateWorkspaceCheckpoint(
        base,
        transport,
        {
          supportedRuntimeFormats: [7],
          supportedRuntimeRequirements: [],
        },
      );
      expect(requirementRefusal.issues.join(" ")).toContain(
        "unsupported runtime requirement: pi-durable:1.x",
      );

      const corruptTransport: BlobTransport = {
        putBlob: (bytes) => transport.putBlob(bytes),
        async getBlob(reference) {
          const bytes = await transport.getBlob(reference);
          if (reference === base.git.bundle.reference)
            return Buffer.from([0, ...bytes]);
          return bytes;
        },
      };
      expect(
        (
          await validateWorkspaceCheckpoint(base, corruptTransport, {
            supportedRuntimeFormats: [7],
            supportedRuntimeRequirements: ["pi-durable:1.x"],
          })
        ).issues.join(" "),
      ).toContain("Git bundle integrity mismatch");

      const unsafeDestination = join(root, "unsafe-destination");
      await expect(
        restoreWorkspaceCheckpoint({
          manifest: unsafe,
          transport,
          destinationPath: unsafeDestination,
        }),
      ).rejects.toThrow("unsafe or non-portable workspace path");
      expect(await Bun.file(unsafeDestination).exists()).toBe(false);

      const destination = join(root, "occupied");
      await mkdir(destination);
      await writeFile(join(destination, "marker"), "unchanged");
      const destinationPreview = await previewWorkspaceCheckpoint(
        base,
        transport,
        {
          supportedRuntimeFormats: [7],
          supportedRuntimeRequirements: ["pi-durable:1.x"],
          destinationPath: destination,
        },
      );
      expect(destinationPreview.valid).toBe(false);
      expect(destinationPreview.issues.join(" ")).toContain(
        "destination must be empty",
      );
      await expect(
        restoreWorkspaceCheckpoint({
          manifest: base,
          transport,
          destinationPath: destination,
          supportedRuntimeFormats: [7],
          supportedRuntimeRequirements: ["pi-durable:1.x"],
        }),
      ).rejects.toThrow("must be empty");
      expect(await readFile(join(destination, "marker"), "utf8")).toBe(
        "unchanged",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("includes descendants matched through wildcard directory segments", async () => {
    const root = await temporaryDirectory();
    try {
      const { source } = await makeLinkedDirtyRepository(root);
      await mkdir(join(source, "src"));
      await writeFile(join(source, "src", "keep.txt"), "selected by wildcard");
      await writeFile(join(source, "src", "drop.txt"), "not selected");
      const captured = await captureWorkspaceCheckpoint({
        workspacePath: source,
        transport: new FileBlobTransport(join(root, "blobs")),
        includeGlobs: ["*/keep.txt"],
      });
      expect(
        captured.manifest.workspace.entries.map((entry) => entry.path),
      ).toEqual(["src/keep.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds Git bundle generation to the configured checkpoint size", async () => {
    const root = await temporaryDirectory();
    try {
      const source = join(root, "repo");
      await mkdir(source);
      git(source, "init", "--initial-branch=main", "--quiet");
      git(source, "config", "user.name", "Checkpoint Test");
      git(source, "config", "user.email", "checkpoint@example.invalid");
      await writeFile(join(source, "base.txt"), "base");
      git(source, "add", "base.txt");
      git(source, "commit", "-m", "initial");
      await expect(
        captureWorkspaceCheckpoint({
          workspacePath: source,
          transport: new FileBlobTransport(join(root, "blobs")),
          limits: { maxCheckpointBytes: 1 },
        }),
      ).rejects.toThrow(
        "Git bundle generation exceeded the configured checkpoint byte limit",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds staged patch accumulation across Git path chunks", async () => {
    const root = await temporaryDirectory();
    try {
      const source = join(root, "repo");
      await mkdir(source);
      git(source, "init", "--initial-branch=main", "--quiet");
      git(source, "config", "user.name", "Checkpoint Test");
      git(source, "config", "user.email", "checkpoint@example.invalid");
      await writeFile(join(source, "base.txt"), "base");
      git(source, "add", "base.txt");
      git(source, "commit", "-m", "initial");
      for (let index = 0; index < 1800; index += 1) {
        const name = `file-${String(index).padStart(4, "0")}-${"x".repeat(60)}.txt`;
        await writeFile(join(source, name), "");
      }
      git(source, "add", "--all");
      await expect(
        captureWorkspaceCheckpoint({
          workspacePath: source,
          transport: new FileBlobTransport(join(root, "blobs")),
          limits: { maxCheckpointBytes: 256 * 1024 },
        }),
      ).rejects.toThrow(
        "Staged Git changes exceed the remaining checkpoint byte limit",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses symlink escapes while capturing and omits policy-selected resources", async () => {
    const root = await temporaryDirectory();
    try {
      const source = join(root, "repo");
      await mkdir(source);
      git(source, "init", "--initial-branch=main", "--quiet");
      git(source, "config", "user.name", "Checkpoint Test");
      git(source, "config", "user.email", "checkpoint@example.invalid");
      await writeFile(join(source, "safe.txt"), "safe");
      git(source, "add", "safe.txt");
      git(source, "commit", "-m", "initial");
      await writeFile(join(root, "outside-secret"), "outside");
      await symlink("../outside-secret", join(source, "escape"));
      const transport = new FileBlobTransport(join(root, "blobs"));
      await expect(
        captureWorkspaceCheckpoint({ workspacePath: source, transport }),
      ).rejects.toThrow("symlink escapes workspace");

      await rm(join(source, "escape"));
      await writeFile(join(source, "notes.txt"), "skip by policy");
      const captured = await captureWorkspaceCheckpoint({
        workspacePath: source,
        transport,
        includeGlobs: ["safe.txt"],
      });
      expect(
        captured.manifest.workspace.entries.map((entry) => entry.path),
      ).toEqual(["safe.txt"]);
      expect(captured.manifest.workspace.omissions).toContainEqual({
        path: "notes.txt",
        reason: "outside-inclusion",
      });

      const sizeBounded = await captureWorkspaceCheckpoint({
        workspacePath: source,
        transport,
        limits: { maxFileBytes: 2 },
      });
      expect(
        sizeBounded.manifest.workspace.omissions.some(
          (omission) => omission.reason === "size-limit",
        ),
      ).toBe(true);
      await expect(
        captureWorkspaceCheckpoint({
          workspacePath: source,
          transport,
          limits: { maxFiles: 1 },
        }),
      ).rejects.toThrow("file count exceeds");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
