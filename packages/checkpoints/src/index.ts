import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { devNull, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const WORKSPACE_CHECKPOINT_FORMAT =
  "uzina-workspace-checkpoint" as const;
export const WORKSPACE_CHECKPOINT_VERSION = 1 as const;

const REQUIRED_CAPABILITIES = [
  "workspace-files-v1",
  "git-bundle-v1",
  "git-index-patch-v1",
] as const;
const DEFAULT_EXCLUSIONS = [
  "**/.env",
  "**/.env.*",
  "**/credentials",
  "**/credentials.*",
  "**/auth.json",
  ".pi/agent/**",
  "**/.pi/agent/**",
  "**/.ssh/**",
  "**/node_modules/**",
] as const;
const HARD_LIMITS = {
  files: 100_000,
  manifestBytes: 16 * 1024 * 1024,
  traversedPaths: 200_000,
  omissions: 10_000,
  fileBytes: 64 * 1024 * 1024,
  checkpointBytes: 512 * 1024 * 1024,
  runtimeBytes: 32 * 1024 * 1024,
  attachmentBytes: 32 * 1024 * 1024,
} as const;
const MINIMUM_GIT_VERSION = "2.20.0";
export const WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES =
  HARD_LIMITS.manifestBytes;
export const WORKSPACE_CHECKPOINT_ATTACHMENT_MAX_BYTES =
  HARD_LIMITS.attachmentBytes;
const FORMAT_CAPABILITIES = new Set<string>(REQUIRED_CAPABILITIES);
const globCache = new Map<string, RegExp>();

export interface BlobTransport {
  /** Store bytes immutably and return their lowercase SHA-256 content address. */
  putBlob(bytes: Uint8Array): Promise<string>;
  getBlob(reference: string): Promise<Uint8Array>;
}

/** Local content-addressed transport. Blob names are validated hashes, never paths. */
export class FileBlobTransport implements BlobTransport {
  constructor(readonly rootDirectory: string) {}

  async putBlob(bytes: Uint8Array): Promise<string> {
    const digest = sha256(bytes);
    await mkdir(this.rootDirectory, { recursive: true });
    const destination = join(this.rootDirectory, digest);
    try {
      const existing = await readSafeBlobFile(destination);
      if (sha256(existing) !== digest) {
        throw new Error(
          `Existing blob ${digest} does not match its content address`,
        );
      }
      return digest;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const temporary = join(
      this.rootDirectory,
      `.${digest}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      if (!isAlreadyExists(error)) throw error;
      const existing = await readFile(destination);
      if (sha256(existing) !== digest) throw error;
    }
    return digest;
  }

  async getBlob(reference: string): Promise<Uint8Array> {
    assertBlobReference(reference);
    const bytes = await readSafeBlobFile(join(this.rootDirectory, reference));
    if (sha256(bytes) !== reference) {
      throw new Error(`Blob integrity mismatch for ${reference}`);
    }
    return bytes;
  }
}

export interface CheckpointEntry {
  path: string;
  kind: "file" | "symlink";
  size: number;
  sha256: string;
  executable?: boolean;
  linkTarget?: string;
}

export interface CheckpointOmission {
  path: string;
  reason: "excluded" | "outside-inclusion" | "size-limit";
}

export interface CheckpointBlob {
  reference: string;
  size: number;
  sha256: string;
}

export interface RuntimeArtifactSlot {
  /** Opaque to this package; lane A owns its serialization and interpretation. */
  formatVersion: number;
  mediaType: string;
  artifact: CheckpointBlob;
  compatibilityRequirements: string[];
}

export interface CheckpointAttachment {
  name: string;
  mediaType: string;
  blob: CheckpointBlob;
}

export interface WorkspaceCheckpointManifest {
  format: typeof WORKSPACE_CHECKPOINT_FORMAT;
  version: number;
  createdAt: string;
  requirements: {
    minimumGitVersion: string;
    capabilities: string[];
  };
  source: {
    head: string;
    branch: string | null;
    gitVersion: string;
    linkedWorktree: boolean;
  };
  policy: {
    includeGlobs: string[] | null;
    excludeGlobs: string[];
  };
  workspace: {
    entries: CheckpointEntry[];
    omissions: CheckpointOmission[];
  };
  git: {
    bundle: CheckpointBlob;
    stagedPatch: CheckpointBlob;
    stagedPaths: string[];
  };
  runtimeArtifact: RuntimeArtifactSlot | null;
  attachments: CheckpointAttachment[];
}

export interface CaptureLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxCheckpointBytes?: number;
  maxRuntimeBytes?: number;
  maxAttachmentBytes?: number;
}

export interface CaptureWorkspaceOptions {
  workspacePath: string;
  transport: BlobTransport;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  limits?: CaptureLimits;
  runtimeArtifact?: {
    formatVersion: number;
    mediaType: string;
    bytes: Uint8Array;
    compatibilityRequirements?: string[];
  } | null;
  attachments?: Array<{
    name: string;
    mediaType: string;
    bytes: Uint8Array;
  }>;
}

export interface CapturedWorkspaceCheckpoint {
  manifest: WorkspaceCheckpointManifest;
  manifestReference: string;
}

export interface CheckpointPreview {
  formatVersion: number;
  createdAt: string;
  gitHead: string;
  gitBranch: string | null;
  linkedWorktreeSource: boolean;
  fileCount: number;
  fileBytes: number;
  stagedPathCount: number;
  omittedCount: number;
  omissions: CheckpointOmission[];
  runtimeArtifact: { formatVersion: number; mediaType: string } | null;
  attachmentNames: string[];
  declaredPolicy: WorkspaceCheckpointManifest["policy"];
}

export interface CheckpointValidationOptions {
  supportedRuntimeFormats?: readonly number[];
  supportedRuntimeRequirements?: readonly string[];
  supportedCapabilities?: readonly string[];
  limits?: CaptureLimits;
}

export interface CheckpointValidation {
  valid: boolean;
  issues: string[];
  preview: CheckpointPreview | null;
}

export interface CheckpointPreviewOptions extends CheckpointValidationOptions {
  destinationPath?: string;
}

export interface RestoreWorkspaceOptions extends CheckpointValidationOptions {
  manifest: WorkspaceCheckpointManifest;
  transport: BlobTransport;
  destinationPath: string;
}

export interface RestoredWorkspaceCheckpoint {
  destinationPath: string;
  runtimeArtifact: { slot: RuntimeArtifactSlot; bytes: Uint8Array } | null;
  attachments: Array<{ attachment: CheckpointAttachment; bytes: Uint8Array }>;
}

interface LoadedCheckpoint {
  validation: CheckpointValidation;
  workspaceContents: Map<string, Uint8Array>;
  bundleBytes: Uint8Array;
  stagedPatchBytes: Uint8Array;
  runtimeBytes: Uint8Array | null;
  attachments: Array<{ attachment: CheckpointAttachment; bytes: Uint8Array }>;
}

/** Capture one Git checkout into portable logical files and content-addressed blobs. */
export async function captureWorkspaceCheckpoint(
  options: CaptureWorkspaceOptions,
): Promise<CapturedWorkspaceCheckpoint> {
  const limits = resolveLimits(options.limits);
  const root = await realpath(options.workspacePath);
  const gitRoot = gitText(root, ["rev-parse", "--show-toplevel"]);
  if ((await realpath(gitRoot)) !== root) {
    throw new Error("workspacePath must be the Git worktree root");
  }
  const gitVersion = gitText(root, ["--version"])
    .replace(/^git version\s+/, "")
    .trim();
  assertVersionAtLeast(gitVersion, MINIMUM_GIT_VERSION, "Git");
  if (gitText(root, ["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error("Shallow Git repositories are not supported");
  }
  rejectUnsupportedIndex(root);
  if (gitRawText(root, ["ls-files", "-u", "-z"])) {
    throw new Error(
      "Git repositories with unresolved index conflicts are not supported",
    );
  }
  if (
    gitRawText(root, ["ls-files", "--stage", "-z"])
      .split("\0")
      .some((line) => line.startsWith("160000 "))
  ) {
    throw new Error(
      "Git submodules are not supported by workspace checkpoints",
    );
  }

  const head = gitText(root, ["rev-parse", "--verify", "HEAD"]);
  const symbolicHead = gitTryText(root, ["symbolic-ref", "-q", "HEAD"]);
  const branch = symbolicHead?.startsWith("refs/heads/")
    ? symbolicHead.slice("refs/heads/".length)
    : null;
  if (branch !== null && !isValidBranchName(branch)) {
    throw new Error("Current Git branch name is not portable");
  }
  const linkedWorktree =
    gitText(root, ["rev-parse", "--git-dir"]) !==
    gitText(root, ["rev-parse", "--git-common-dir"]);
  const includeGlobs =
    options.includeGlobs === undefined
      ? null
      : normalizeGlobs(options.includeGlobs);
  const excludeGlobs = normalizeGlobs([
    ...(options.excludeGlobs ?? []),
    ...DEFAULT_EXCLUSIONS,
  ]);
  await assertFileTransportOutsideWorkspace(options.transport, root);
  const walk = await collectWorkspaceFiles(
    root,
    includeGlobs,
    excludeGlobs,
    limits,
  );
  const selectedStagedPaths = gitRawText(root, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    "HEAD",
  ])
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => matchesPolicy(path, includeGlobs, excludeGlobs))
    .filter((path) => !walk.omittedPaths.has(path));
  const stagedPaths = [...new Set(selectedStagedPaths)].sort();

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "uzina-checkpoint-"));
  let bundleBytes: Uint8Array;
  let stagedPatchBytes: Uint8Array;
  try {
    const bundlePath = join(temporaryDirectory, "workspace.bundle");
    await runGitToFileBounded(
      root,
      ["bundle", "create", "-", "--all", "HEAD"],
      bundlePath,
      limits.maxCheckpointBytes,
      "Git bundle generation exceeded the configured checkpoint byte limit",
    );
    bundleBytes = await readFile(bundlePath);
    stagedPatchBytes = await buildStagedPatch(
      root,
      stagedPaths,
      limits.maxCheckpointBytes - bundleBytes.byteLength,
      join(temporaryDirectory, "staged.patch"),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  let totalBytes = bundleBytes.byteLength + stagedPatchBytes.byteLength;
  if (totalBytes > limits.maxCheckpointBytes) {
    throw new Error("Checkpoint data exceeds the configured byte limit");
  }
  const entries: CheckpointEntry[] = [];
  for (const file of walk.files) {
    const data =
      file.kind === "file"
        ? await readSafeWorkspaceFile(file)
        : Buffer.from(file.linkTarget, "utf8");
    if (data.byteLength !== file.size)
      throw new Error(`Workspace file changed during capture: ${file.path}`);
    totalBytes += data.byteLength;
    if (totalBytes > limits.maxCheckpointBytes)
      throw new Error("Checkpoint data exceeds the configured byte limit");
    const digest = sha256(data);
    const reference = await options.transport.putBlob(data);
    assertStoredReference(reference, digest);
    entries.push({
      path: file.path,
      kind: file.kind,
      size: data.byteLength,
      sha256: digest,
      ...(file.kind === "file"
        ? { executable: file.executable }
        : { linkTarget: file.linkTarget }),
    });
  }

  const bundle = await storeBlob(options.transport, bundleBytes);
  const stagedPatch = await storeBlob(options.transport, stagedPatchBytes);
  const attachments: CheckpointAttachment[] = [];
  const attachmentInputs = options.attachments ?? [];
  if (attachmentInputs.length > limits.maxFiles) {
    throw new Error("Checkpoint attachment count exceeds the configured limit");
  }
  const names = new Set<string>();
  for (const attachment of attachmentInputs) {
    validateAttachmentName(attachment.name);
    validateMediaType(attachment.mediaType);
    if (names.has(attachment.name))
      throw new Error(`Duplicate checkpoint attachment: ${attachment.name}`);
    names.add(attachment.name);
    if (attachment.bytes.byteLength > limits.maxAttachmentBytes) {
      throw new Error(
        `Checkpoint attachment exceeds the size limit: ${attachment.name}`,
      );
    }
    totalBytes += attachment.bytes.byteLength;
    if (totalBytes > limits.maxCheckpointBytes)
      throw new Error("Checkpoint data exceeds the configured byte limit");
    attachments.push({
      name: attachment.name,
      mediaType: attachment.mediaType,
      blob: await storeBlob(options.transport, attachment.bytes),
    });
  }
  let runtimeArtifact: RuntimeArtifactSlot | null = null;
  if (options.runtimeArtifact) {
    if (options.runtimeArtifact.bytes.byteLength > limits.maxRuntimeBytes) {
      throw new Error("Runtime artifact exceeds the size limit");
    }
    totalBytes += options.runtimeArtifact.bytes.byteLength;
    if (totalBytes > limits.maxCheckpointBytes)
      throw new Error("Checkpoint data exceeds the configured byte limit");
    runtimeArtifact = {
      formatVersion: positiveInteger(
        options.runtimeArtifact.formatVersion,
        "runtime formatVersion",
      ),
      mediaType: validateMediaType(options.runtimeArtifact.mediaType),
      artifact: await storeBlob(
        options.transport,
        options.runtimeArtifact.bytes,
      ),
      compatibilityRequirements: [
        ...(options.runtimeArtifact.compatibilityRequirements ?? []),
      ],
    };
  }

  const manifest: WorkspaceCheckpointManifest = {
    format: WORKSPACE_CHECKPOINT_FORMAT,
    version: WORKSPACE_CHECKPOINT_VERSION,
    createdAt: new Date().toISOString(),
    requirements: {
      minimumGitVersion: MINIMUM_GIT_VERSION,
      capabilities: [...REQUIRED_CAPABILITIES],
    },
    source: { head, branch, gitVersion, linkedWorktree },
    policy: { includeGlobs, excludeGlobs },
    workspace: { entries, omissions: walk.omissions },
    git: { bundle, stagedPatch, stagedPaths },
    runtimeArtifact,
    attachments,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.byteLength > WORKSPACE_CHECKPOINT_MANIFEST_MAX_BYTES) {
    throw new Error("Checkpoint manifest exceeds its size limit");
  }
  if (manifestBytes.byteLength + totalBytes > limits.maxCheckpointBytes) {
    throw new Error(
      "Checkpoint manifest exceeds the configured total byte limit",
    );
  }
  const manifestReference = await storeBlob(options.transport, manifestBytes);
  return { manifest, manifestReference: manifestReference.reference };
}

/** Validate all metadata, compatibility declarations, and content before a restore. */
export async function loadWorkspaceCheckpoint(
  manifestReference: string,
  transport: BlobTransport,
): Promise<WorkspaceCheckpointManifest> {
  assertBlobReference(manifestReference);
  const bytes = await transport.getBlob(manifestReference);
  if (bytes.byteLength > HARD_LIMITS.manifestBytes)
    throw new Error("Checkpoint manifest exceeds its size limit");
  if (sha256(bytes) !== manifestReference)
    throw new Error("Checkpoint manifest integrity mismatch");
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Checkpoint manifest is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object")
    throw new Error("Checkpoint manifest must be an object");
  return manifest as WorkspaceCheckpointManifest;
}

export async function validateWorkspaceCheckpoint(
  manifest: WorkspaceCheckpointManifest,
  transport: BlobTransport,
  options: CheckpointValidationOptions = {},
): Promise<CheckpointValidation> {
  return (await loadAndValidate(manifest, transport, options)).validation;
}

/** Preview declarations and validation without touching a destination. */
export async function previewWorkspaceCheckpoint(
  manifest: WorkspaceCheckpointManifest,
  transport: BlobTransport,
  options: CheckpointPreviewOptions = {},
): Promise<CheckpointValidation> {
  const validation = await validateWorkspaceCheckpoint(
    manifest,
    transport,
    options,
  );
  if (!options.destinationPath) return validation;
  try {
    await inspectEmptyDestination(options.destinationPath);
    return validation;
  } catch (error) {
    const issue =
      error instanceof Error ? error.message : "invalid restore destination";
    return {
      ...validation,
      valid: false,
      issues: [...validation.issues, issue],
    };
  }
}

/** Restore an inactive checkout into a nonexistent or empty destination directory. */
export async function restoreWorkspaceCheckpoint(
  options: RestoreWorkspaceOptions,
): Promise<RestoredWorkspaceCheckpoint> {
  const loaded = await loadAndValidate(
    options.manifest,
    options.transport,
    options,
  );
  if (!loaded.validation.valid) {
    throw new Error(
      `Checkpoint validation failed: ${loaded.validation.issues.join("; ")}`,
    );
  }
  const { candidate, existing } = await inspectEmptyDestination(
    options.destinationPath,
  );
  const staging = await mkdtemp(join(dirname(candidate), ".uzina-restore-"));
  try {
    await restoreIntoStaging(staging, options.manifest, loaded);
    if (existing) {
      const current = await lstatIfPresent(candidate);
      if (
        !current?.isDirectory() ||
        current.isSymbolicLink() ||
        (await readdir(candidate)).length > 0
      ) {
        throw new Error("Restore destination changed during preparation");
      }
      await rm(candidate, { recursive: true });
    }
    await rename(staging, candidate);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    destinationPath: candidate,
    runtimeArtifact:
      options.manifest.runtimeArtifact && loaded.runtimeBytes
        ? { slot: options.manifest.runtimeArtifact, bytes: loaded.runtimeBytes }
        : null,
    attachments: loaded.attachments,
  };
}

/** Recheck the materialized workspace, Git index, and files against a checkpoint. */
export async function verifyRestoredWorkspaceCheckpoint(
  manifest: WorkspaceCheckpointManifest,
  transport: BlobTransport,
  destinationPath: string,
): Promise<void> {
  const loaded = await loadAndValidate(manifest, transport, {
    supportedRuntimeFormats: manifest.runtimeArtifact
      ? [manifest.runtimeArtifact.formatVersion]
      : [],
    supportedRuntimeRequirements:
      manifest.runtimeArtifact?.compatibilityRequirements ?? [],
  });
  if (!loaded.validation.valid) {
    throw new Error(
      `Checkpoint validation failed: ${loaded.validation.issues.join("; ")}`,
    );
  }
  const root = await realpath(destinationPath);
  const gitRoot = await realpath(
    restoreGitText(root, ["rev-parse", "--show-toplevel"]),
  );
  if (gitRoot !== root) {
    throw new Error("Prepared workspace is not its Git worktree root");
  }
  const gitDirectory = await lstat(join(root, ".git"));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
    throw new Error("Prepared workspace Git metadata is not a directory");
  }
  rejectUnsupportedIndex(root);

  const actual = await collectWorkspaceFiles(root, null, [], resolveLimits());
  if (actual.omissions.length > 0) {
    throw new Error("Prepared workspace contains omitted entries");
  }
  const expectedEntries = new Map(
    manifest.workspace.entries.map((entry) => [entry.path, entry]),
  );
  if (actual.files.length !== expectedEntries.size) {
    throw new Error("Prepared workspace entries do not match the checkpoint");
  }
  for (const file of actual.files) {
    const expected = expectedEntries.get(file.path);
    if (
      !expected ||
      expected.kind !== file.kind ||
      expected.size !== file.size ||
      (expected.kind === "file" && expected.executable !== file.executable) ||
      (expected.kind === "symlink" && expected.linkTarget !== file.linkTarget)
    ) {
      throw new Error(`Prepared workspace entry changed: ${file.path}`);
    }
    const bytes =
      file.kind === "file"
        ? await readSafeWorkspaceFile(file)
        : Buffer.from(file.linkTarget, "utf8");
    if (sha256(bytes) !== expected.sha256) {
      throw new Error(
        `Prepared workspace entry integrity mismatch: ${file.path}`,
      );
    }
  }
  const expectedDirectories = new Set<string>();
  for (const path of expectedEntries.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  if (
    JSON.stringify([...actual.directories].sort()) !==
    JSON.stringify([...expectedDirectories].sort())
  ) {
    throw new Error(
      "Prepared workspace directories do not match the checkpoint",
    );
  }

  const expectedGit = await expectedGitCheckpointState(
    manifest,
    loaded.bundleBytes,
    loaded.stagedPatchBytes,
  );
  const actualHead = restoreGitText(root, ["rev-parse", "--verify", "HEAD"]);
  const actualBranch = restoreGitTryText(root, [
    "symbolic-ref",
    "-q",
    "--short",
    "HEAD",
  ]);
  const actualRefs = restoreGitRawText(root, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  ]);
  const actualIndex = restoreGitRawText(root, ["ls-files", "--stage", "-z"]);
  const actualStagedPaths = restoreGitRawText(root, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    "HEAD",
  ])
    .split("\0")
    .filter(Boolean)
    .sort();
  if (
    actualHead !== manifest.source.head ||
    actualBranch !== manifest.source.branch ||
    actualRefs !== expectedGit.refs ||
    actualIndex !== expectedGit.index ||
    JSON.stringify(actualStagedPaths) !==
      JSON.stringify([...manifest.git.stagedPaths].sort())
  ) {
    throw new Error("Prepared Git state does not match the checkpoint");
  }
}

async function expectedGitCheckpointState(
  manifest: WorkspaceCheckpointManifest,
  bundleBytes: Uint8Array,
  stagedPatchBytes: Uint8Array,
): Promise<{ refs: string; index: string }> {
  const temporary = await mkdtemp(join(tmpdir(), "uzina-checkpoint-verify-"));
  const checkout = join(temporary, "checkout");
  const bundlePath = join(temporary, "workspace.bundle");
  try {
    await mkdir(checkout);
    await mkdir(join(temporary, "empty-template"));
    await writeFile(bundlePath, bundleBytes, { flag: "wx" });
    restoreGitText(checkout, [
      "init",
      "--quiet",
      `--template=${join(temporary, "empty-template")}`,
    ]);
    restoreGitText(checkout, [
      "fetch",
      "--quiet",
      "--no-tags",
      bundlePath,
      "+refs/*:refs/*",
    ]);
    restoreGitSetHeadAndIndex(
      checkout,
      manifest.source.head,
      manifest.source.branch,
    );
    if (stagedPatchBytes.byteLength > 0) {
      execFileSync(
        "git",
        ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
        {
          cwd: checkout,
          input: stagedPatchBytes,
          maxBuffer: HARD_LIMITS.checkpointBytes,
          env: safeRestoreEnvironment(),
        },
      );
    }
    return {
      refs: restoreGitRawText(checkout, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ]),
      index: restoreGitRawText(checkout, ["ls-files", "--stage", "-z"]),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function inspectEmptyDestination(destinationPath: string): Promise<{
  candidate: string;
  existing: Awaited<ReturnType<typeof lstatIfPresent>>;
}> {
  const destination = resolve(destinationPath);
  const parentPath = dirname(destination);
  const realParent = await realpath(parentPath);
  const candidate = join(realParent, basename(destination));
  if (candidate === realParent || candidate === resolve(realParent)) {
    throw new Error("Destination must be a child of an existing directory");
  }
  const existing = await lstatIfPresent(candidate);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("Restore destination must be a directory or not exist");
  }
  if (existing && (await readdir(candidate)).length > 0) {
    throw new Error("Restore destination must be empty");
  }
  return { candidate, existing };
}

async function loadAndValidate(
  manifest: WorkspaceCheckpointManifest,
  transport: BlobTransport,
  options: CheckpointValidationOptions,
): Promise<LoadedCheckpoint> {
  const issues: string[] = [];
  const limits = resolveLimits(options.limits);
  const shapeError = validateManifestShape(manifest, limits);
  if (shapeError) issues.push(shapeError);
  if (shapeError) {
    return emptyLoaded({ valid: false, issues, preview: null });
  }
  if (manifest.format !== WORKSPACE_CHECKPOINT_FORMAT)
    issues.push("unsupported checkpoint format");
  if (manifest.version !== WORKSPACE_CHECKPOINT_VERSION)
    issues.push("incompatible checkpoint version");
  if (
    !versionIsAtLeast(
      manifest.requirements.minimumGitVersion,
      MINIMUM_GIT_VERSION,
    )
  ) {
    issues.push("checkpoint requires an unsupported Git version");
  }
  const supportedCapabilities = new Set(
    options.supportedCapabilities ?? REQUIRED_CAPABILITIES,
  );
  for (const capability of manifest.requirements.capabilities) {
    if (
      !FORMAT_CAPABILITIES.has(capability) ||
      !supportedCapabilities.has(capability)
    ) {
      issues.push(`unsupported checkpoint capability: ${capability}`);
    }
  }
  const localGitVersion = localGitVersionOrNull();
  if (
    !localGitVersion ||
    !versionIsAtLeast(localGitVersion, manifest.requirements.minimumGitVersion)
  ) {
    issues.push(
      `destination Git ${localGitVersion ?? "unavailable"} does not meet ${manifest.requirements.minimumGitVersion}`,
    );
  }
  if (manifest.runtimeArtifact) {
    const supported = options.supportedRuntimeFormats;
    if (!supported?.includes(manifest.runtimeArtifact.formatVersion)) {
      issues.push(
        `runtime artifact format ${manifest.runtimeArtifact.formatVersion} is not supported by this destination`,
      );
    }
    const supportedRequirements = new Set(
      options.supportedRuntimeRequirements ?? [],
    );
    for (const requirement of manifest.runtimeArtifact
      .compatibilityRequirements) {
      if (!supportedRequirements.has(requirement))
        issues.push(`unsupported runtime requirement: ${requirement}`);
    }
  }

  const workspaceContents = new Map<string, Uint8Array>();
  let totalBytes = 0;
  const readBlob = async (
    blob: CheckpointBlob,
    label: string,
    maxBytes: number,
  ): Promise<Uint8Array> => {
    assertBlobReference(blob.reference);
    if (blob.size > maxBytes)
      throw new Error(`${label} exceeds its size limit`);
    const bytes = await transport.getBlob(blob.reference);
    if (bytes.byteLength > maxBytes)
      throw new Error(`${label} exceeds its size limit`);
    if (
      bytes.byteLength !== blob.size ||
      sha256(bytes) !== blob.sha256 ||
      blob.sha256 !== blob.reference
    ) {
      throw new Error(`${label} integrity mismatch`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxCheckpointBytes)
      throw new Error("checkpoint exceeds total size limit");
    return bytes;
  };
  let bundleBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let stagedPatchBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let runtimeBytes: Uint8Array | null = null;
  const attachments: Array<{
    attachment: CheckpointAttachment;
    bytes: Uint8Array;
  }> = [];
  try {
    bundleBytes = await readBlob(
      manifest.git.bundle,
      "Git bundle",
      limits.maxCheckpointBytes,
    );
    stagedPatchBytes = await readBlob(
      manifest.git.stagedPatch,
      "staged Git patch",
      limits.maxCheckpointBytes,
    );
    for (const entry of manifest.workspace.entries) {
      const bytes = await readBlob(
        { reference: entry.sha256, size: entry.size, sha256: entry.sha256 },
        `workspace entry ${entry.path}`,
        limits.maxFileBytes,
      );
      if (
        entry.kind === "symlink" &&
        Buffer.from(bytes).toString("utf8") !== entry.linkTarget
      ) {
        throw new Error(`symlink target integrity mismatch for ${entry.path}`);
      }
      workspaceContents.set(entry.path, bytes);
    }
    if (manifest.runtimeArtifact) {
      runtimeBytes = await readBlob(
        manifest.runtimeArtifact.artifact,
        "runtime artifact",
        limits.maxRuntimeBytes,
      );
    }
    for (const attachment of manifest.attachments) {
      attachments.push({
        attachment,
        bytes: await readBlob(
          attachment.blob,
          `attachment ${attachment.name}`,
          limits.maxAttachmentBytes,
        ),
      });
    }
    validateStagedPatchPaths(stagedPatchBytes, manifest.git.stagedPaths);
    await verifyGitPayload(manifest, bundleBytes, stagedPatchBytes);
  } catch (error) {
    issues.push(
      error instanceof Error
        ? error.message
        : "checkpoint content could not be read",
    );
  }

  const preview: CheckpointPreview = {
    formatVersion: manifest.version,
    createdAt: manifest.createdAt,
    gitHead: manifest.source.head,
    gitBranch: manifest.source.branch,
    linkedWorktreeSource: manifest.source.linkedWorktree,
    fileCount: manifest.workspace.entries.length,
    fileBytes: manifest.workspace.entries.reduce(
      (sum, entry) => sum + entry.size,
      0,
    ),
    stagedPathCount: manifest.git.stagedPaths.length,
    omittedCount: manifest.workspace.omissions.length,
    omissions: manifest.workspace.omissions.map((omission) => ({
      ...omission,
    })),
    runtimeArtifact: manifest.runtimeArtifact
      ? {
          formatVersion: manifest.runtimeArtifact.formatVersion,
          mediaType: manifest.runtimeArtifact.mediaType,
        }
      : null,
    attachmentNames: manifest.attachments.map(({ name }) => name),
    declaredPolicy: {
      includeGlobs: manifest.policy.includeGlobs
        ? [...manifest.policy.includeGlobs]
        : null,
      excludeGlobs: [...manifest.policy.excludeGlobs],
    },
  };
  return {
    validation: { valid: issues.length === 0, issues, preview },
    workspaceContents,
    bundleBytes,
    stagedPatchBytes,
    runtimeBytes,
    attachments,
  };
}

async function verifyGitPayload(
  manifest: WorkspaceCheckpointManifest,
  bundleBytes: Uint8Array,
  stagedPatchBytes: Uint8Array,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "uzina-checkpoint-validate-"));
  const checkout = join(temporary, "checkout");
  const bundlePath = join(temporary, "workspace.bundle");
  const emptyTemplate = join(temporary, "empty-template");
  try {
    await mkdir(checkout);
    await mkdir(emptyTemplate);
    await writeFile(bundlePath, bundleBytes, { flag: "wx" });
    restoreGitText(checkout, [
      "init",
      "--quiet",
      `--template=${emptyTemplate}`,
    ]);
    restoreGitText(checkout, [
      "fetch",
      "--quiet",
      "--no-tags",
      bundlePath,
      "+refs/*:refs/*",
    ]);
    const bundledHead = restoreGitText(checkout, [
      "rev-parse",
      "--verify",
      `${manifest.source.head}^{commit}`,
    ]);
    if (bundledHead !== manifest.source.head)
      throw new Error("Git bundle does not contain the declared HEAD");
    if (manifest.source.branch) {
      const branchHead = restoreGitText(checkout, [
        "rev-parse",
        "--verify",
        `refs/heads/${manifest.source.branch}^{commit}`,
      ]);
      if (branchHead !== manifest.source.head)
        throw new Error(
          "Git bundle branch does not point at the declared HEAD",
        );
    }
    restoreGitSetHeadAndIndex(
      checkout,
      manifest.source.head,
      manifest.source.branch,
    );
    if (stagedPatchBytes.byteLength > 0) {
      execFileSync(
        "git",
        ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
        {
          cwd: checkout,
          input: stagedPatchBytes,
          maxBuffer: HARD_LIMITS.checkpointBytes,
          env: safeRestoreEnvironment(),
        },
      );
    }
    const stagedPaths = restoreGitRawText(checkout, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "HEAD",
    ])
      .split("\0")
      .filter(Boolean)
      .sort();
    if (
      JSON.stringify(stagedPaths) !==
      JSON.stringify([...manifest.git.stagedPaths].sort())
    ) {
      throw new Error("Staged patch paths do not match the manifest");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function restoreIntoStaging(
  staging: string,
  manifest: WorkspaceCheckpointManifest,
  loaded: LoadedCheckpoint,
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "uzina-bundle-"));
  const bundlePath = join(temp, "workspace.bundle");
  try {
    await writeFile(bundlePath, loaded.bundleBytes, { flag: "wx" });
    const emptyTemplate = join(temp, "empty-template");
    await mkdir(emptyTemplate);
    restoreGitText(staging, ["init", "--quiet", `--template=${emptyTemplate}`]);
    restoreGitText(staging, [
      "fetch",
      "--quiet",
      "--no-tags",
      bundlePath,
      "+refs/*:refs/*",
    ]);
    const bundledHead = restoreGitText(staging, [
      "rev-parse",
      "--verify",
      `${manifest.source.head}^{commit}`,
    ]);
    if (bundledHead !== manifest.source.head)
      throw new Error("Git bundle does not contain the declared HEAD");
    if (manifest.source.branch) {
      const branchHead = restoreGitText(staging, [
        "rev-parse",
        "--verify",
        `refs/heads/${manifest.source.branch}^{commit}`,
      ]);
      if (branchHead !== manifest.source.head)
        throw new Error(
          "Git bundle branch does not point at the declared HEAD",
        );
    }
    restoreGitSetHeadAndIndex(
      staging,
      manifest.source.head,
      manifest.source.branch,
    );
    if (loaded.stagedPatchBytes.byteLength > 0) {
      execFileSync(
        "git",
        ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
        {
          cwd: staging,
          input: loaded.stagedPatchBytes,
          maxBuffer: HARD_LIMITS.checkpointBytes,
          env: safeRestoreEnvironment(),
        },
      );
    }
    const restoredStagedPaths = restoreGitRawText(staging, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "HEAD",
    ])
      .split("\0")
      .filter(Boolean)
      .sort();
    if (
      JSON.stringify(restoredStagedPaths) !==
      JSON.stringify([...manifest.git.stagedPaths].sort())
    ) {
      throw new Error("Staged patch paths do not match the manifest");
    }
    for (const [path, bytes] of loaded.workspaceContents) {
      const absolutePath = safeDestinationPath(staging, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      const entry = manifest.workspace.entries.find(
        (candidate) => candidate.path === path,
      );
      if (!entry)
        throw new Error(`Missing workspace entry metadata for ${path}`);
      if (entry.kind === "symlink") {
        const target = entry.linkTarget!;
        assertSymlinkContained(staging, path, target);
        await symlink(target, absolutePath);
      } else {
        await writeFile(absolutePath, bytes, {
          flag: "wx",
          mode: entry.executable ? 0o755 : 0o644,
        });
        await chmod(absolutePath, entry.executable ? 0o755 : 0o644);
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

interface CapturedFile {
  path: string;
  kind: "file" | "symlink";
  size: number;
  executable: boolean;
  linkTarget: string;
  absolutePath: string;
}

async function collectWorkspaceFiles(
  root: string,
  includeGlobs: string[] | null,
  excludeGlobs: string[],
  limits: ReturnType<typeof resolveLimits>,
): Promise<{
  files: CapturedFile[];
  directories: string[];
  omissions: CheckpointOmission[];
  omittedPaths: Set<string>;
}> {
  const files: CapturedFile[] = [];
  const directories: string[] = [];
  const omissions: CheckpointOmission[] = [];
  const omittedPaths = new Set<string>();
  let traversed = 0;
  const recordOmission = (
    path: string,
    reason: CheckpointOmission["reason"],
  ) => {
    if (omissions.length >= HARD_LIMITS.omissions)
      throw new Error("Workspace omission count exceeds the safety limit");
    omissions.push({ path, reason });
    omittedPaths.add(path);
  };
  const visit = async (
    directory: string,
    relativeDirectory: string,
  ): Promise<void> => {
    const children = await readdir(directory, { encoding: "buffer" });
    children.sort((left, right) => Buffer.compare(left, right));
    for (const child of children) {
      const name = child.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(child))
        throw new Error("Non-UTF-8 workspace paths are not supported");
      const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      traversed += 1;
      if (traversed > HARD_LIMITS.traversedPaths)
        throw new Error("Workspace path count exceeds the safety limit");
      if (path === ".git") continue;
      if (name === ".git")
        throw new Error(`Nested Git repositories are not supported: ${path}`);
      const pathError = validateRelativePath(path);
      if (pathError) throw new Error(pathError);
      const absolutePath = join(directory, name);
      const stat = await lstat(absolutePath);
      if (isExcluded(path, excludeGlobs)) {
        recordOmission(path, "excluded");
        continue;
      }
      if (includeGlobs && !matchesAny(path, includeGlobs)) {
        if (stat.isDirectory()) {
          const mayContainIncluded = includeGlobs.some((glob) =>
            globCouldMatchDescendant(glob, path),
          );
          if (mayContainIncluded) {
            await visit(absolutePath, path);
          } else {
            recordOmission(path, "outside-inclusion");
          }
        } else {
          recordOmission(path, "outside-inclusion");
        }
        continue;
      }
      if (stat.isDirectory()) {
        directories.push(path);
        await visit(absolutePath, path);
      } else if (stat.isSymbolicLink()) {
        const target = await readlinkString(absolutePath);
        assertSymlinkContained(root, path, target);
        const size = Buffer.byteLength(target, "utf8");
        if (size > limits.maxFileBytes) {
          recordOmission(path, "size-limit");
        } else {
          files.push({
            path,
            kind: "symlink",
            size,
            executable: false,
            linkTarget: target,
            absolutePath,
          });
        }
      } else if (stat.isFile()) {
        if (stat.size > limits.maxFileBytes) {
          recordOmission(path, "size-limit");
        } else {
          files.push({
            path,
            kind: "file",
            size: stat.size,
            executable: (stat.mode & 0o111) !== 0,
            linkTarget: "",
            absolutePath,
          });
        }
      } else {
        throw new Error(`Unsupported workspace filesystem entry: ${path}`);
      }
      if (files.length > limits.maxFiles)
        throw new Error("Workspace file count exceeds the configured limit");
    }
  };
  await visit(root, "");
  const symlinks = new Map(
    files
      .filter((file) => file.kind === "symlink")
      .map((file) => [file.path, file.linkTarget]),
  );
  for (const file of files) {
    if (file.kind === "symlink")
      assertNoSymlinkTraversal(root, file.path, file.linkTarget, symlinks);
  }
  return { files, directories, omissions, omittedPaths };
}

function validateManifestShape(
  manifest: WorkspaceCheckpointManifest,
  limits: ReturnType<typeof resolveLimits>,
): string | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return "checkpoint manifest must be an object";
  if (
    !hasOnlyKeys(manifest, [
      "format",
      "version",
      "createdAt",
      "requirements",
      "source",
      "policy",
      "workspace",
      "git",
      "runtimeArtifact",
      "attachments",
    ])
  )
    return "checkpoint manifest contains unrecognized fields";
  let serializedSize: number;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(manifest));
  } catch {
    return "checkpoint manifest cannot be serialized";
  }
  if (serializedSize > HARD_LIMITS.manifestBytes)
    return "checkpoint manifest exceeds its size limit";
  if (manifest.format !== WORKSPACE_CHECKPOINT_FORMAT)
    return "unsupported checkpoint format";
  if (manifest.version !== WORKSPACE_CHECKPOINT_VERSION)
    return "incompatible checkpoint version";
  if (
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  )
    return "invalid checkpoint creation time";
  if (
    !hasOnlyKeys(manifest.requirements, [
      "minimumGitVersion",
      "capabilities",
    ]) ||
    !Array.isArray(manifest.requirements.capabilities) ||
    typeof manifest.requirements.minimumGitVersion !== "string"
  )
    return "invalid checkpoint requirements";
  if (
    !hasOnlyKeys(manifest.source, [
      "head",
      "branch",
      "gitVersion",
      "linkedWorktree",
    ]) ||
    typeof manifest.source.head !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(manifest.source.head)
  )
    return "invalid Git HEAD";
  if (
    typeof manifest.source.gitVersion !== "string" ||
    typeof manifest.source.linkedWorktree !== "boolean"
  )
    return "invalid Git provenance";
  if (
    manifest.source.branch !== null &&
    !isValidBranchName(manifest.source.branch)
  )
    return "invalid Git branch";
  if (
    !hasOnlyKeys(manifest.policy, ["includeGlobs", "excludeGlobs"]) ||
    !Array.isArray(manifest.policy.excludeGlobs)
  )
    return "invalid inclusion policy";
  try {
    normalizeGlobs(manifest.policy.excludeGlobs);
    if (manifest.policy.includeGlobs !== null)
      normalizeGlobs(manifest.policy.includeGlobs);
  } catch (error) {
    return error instanceof Error ? error.message : "invalid inclusion policy";
  }
  if (
    !hasOnlyKeys(manifest.workspace, ["entries", "omissions"]) ||
    !Array.isArray(manifest.workspace.entries) ||
    !Array.isArray(manifest.workspace.omissions)
  )
    return "invalid workspace entries";
  if (
    manifest.workspace.entries.length > limits.maxFiles ||
    manifest.workspace.omissions.length > HARD_LIMITS.omissions
  )
    return "workspace entry count exceeds limits";
  const seen = new Set<string>();
  const portablePaths = new Map<string, string>();
  const symlinks = new Map<string, string>();
  for (const entry of manifest.workspace.entries) {
    if (
      entry &&
      typeof entry === "object" &&
      entry.kind === "symlink" &&
      typeof entry.path === "string" &&
      typeof entry.linkTarget === "string"
    ) {
      symlinks.set(entry.path, entry.linkTarget);
    }
  }
  let total = 0;
  for (const entry of manifest.workspace.entries) {
    if (!entry || typeof entry !== "object") return "invalid workspace entry";
    const allowedEntryKeys =
      entry.kind === "file"
        ? ["path", "kind", "size", "sha256", "executable"]
        : entry.kind === "symlink"
          ? ["path", "kind", "size", "sha256", "linkTarget"]
          : [];
    if (!hasOnlyKeys(entry, allowedEntryKeys))
      return `unrecognized workspace entry fields: ${String(entry.path)}`;
    const pathError = validateRelativePath(entry.path);
    if (pathError) return pathError;
    if (seen.has(entry.path)) return `duplicate workspace entry: ${entry.path}`;
    const segments = entry.path.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const actualPrefix = segments.slice(0, index).join("/");
      const portablePrefix = segments
        .slice(0, index)
        .map((segment) => segment.normalize("NFC").toLowerCase())
        .join("/");
      const existingPrefix = portablePaths.get(portablePrefix);
      if (existingPrefix !== undefined && existingPrefix !== actualPrefix)
        return `conflicting portable workspace paths: ${entry.path}`;
      portablePaths.set(portablePrefix, actualPrefix);
    }
    seen.add(entry.path);
    if (entry.kind !== "file" && entry.kind !== "symlink")
      return `unsupported workspace entry kind: ${entry.path}`;
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > limits.maxFileBytes ||
      !isSha256(entry.sha256)
    )
      return `invalid workspace entry metadata: ${entry.path}`;
    if (entry.kind === "file" && typeof entry.executable !== "boolean")
      return `invalid file mode: ${entry.path}`;
    if (entry.kind === "symlink") {
      if (
        typeof entry.linkTarget !== "string" ||
        entry.executable !== undefined
      )
        return `invalid symlink metadata: ${entry.path}`;
      try {
        assertSymlinkContained(
          "/checkpoint-root",
          entry.path,
          entry.linkTarget,
        );
        assertNoSymlinkTraversal(
          "/checkpoint-root",
          entry.path,
          entry.linkTarget,
          symlinks,
        );
      } catch (error) {
        return error instanceof Error
          ? error.message
          : "invalid symlink target";
      }
    }
    total += entry.size;
  }
  for (const path of seen) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (seen.has(segments.slice(0, index).join("/")))
        return `conflicting workspace entries: ${path}`;
    }
  }
  if (total > limits.maxCheckpointBytes)
    return "workspace files exceed total size limit";
  const omissionPaths = new Set<string>();
  for (const omission of manifest.workspace.omissions) {
    if (
      !hasOnlyKeys(omission, ["path", "reason"]) ||
      validateRelativePath(omission.path) ||
      !["excluded", "outside-inclusion", "size-limit"].includes(omission.reason)
    )
      return "invalid omission record";
    if (omissionPaths.has(omission.path))
      return `duplicate omission record: ${omission.path}`;
    omissionPaths.add(omission.path);
  }
  if (
    !hasOnlyKeys(manifest.git, ["bundle", "stagedPatch", "stagedPaths"]) ||
    !Array.isArray(manifest.git.stagedPaths)
  )
    return "invalid Git checkpoint metadata";
  const stagedPaths = new Set<string>();
  for (const stagedPath of manifest.git.stagedPaths) {
    if (validateRelativePath(stagedPath)) return "invalid staged Git path";
    if (stagedPaths.has(stagedPath))
      return `duplicate staged Git path: ${stagedPath}`;
    stagedPaths.add(stagedPath);
  }
  if (
    !isBlobMetadata(manifest.git.bundle) ||
    !isBlobMetadata(manifest.git.stagedPatch)
  )
    return "invalid Git blob metadata";
  if (
    !Array.isArray(manifest.attachments) ||
    manifest.attachments.length > limits.maxFiles
  )
    return "invalid attachments";
  const attachmentNames = new Set<string>();
  for (const attachment of manifest.attachments) {
    if (!hasOnlyKeys(attachment, ["name", "mediaType", "blob"]))
      return "invalid or unrecognized checkpoint attachment";
    try {
      validateAttachmentName(attachment.name);
      validateMediaType(attachment.mediaType);
    } catch (error) {
      return error instanceof Error ? error.message : "invalid attachment";
    }
    if (
      attachmentNames.has(attachment.name) ||
      !isBlobMetadata(attachment.blob)
    )
      return `duplicate or invalid attachment: ${attachment.name}`;
    if (attachment.blob.size > limits.maxAttachmentBytes)
      return `attachment exceeds its size limit: ${attachment.name}`;
    attachmentNames.add(attachment.name);
  }
  if (manifest.runtimeArtifact !== null) {
    const slot = manifest.runtimeArtifact;
    if (
      !hasOnlyKeys(slot, [
        "formatVersion",
        "mediaType",
        "artifact",
        "compatibilityRequirements",
      ]) ||
      !Number.isSafeInteger(slot.formatVersion) ||
      slot.formatVersion < 1 ||
      !isBlobMetadata(slot.artifact) ||
      !Array.isArray(slot.compatibilityRequirements)
    )
      return "invalid runtime artifact slot";
    if (slot.artifact.size > limits.maxRuntimeBytes)
      return "runtime artifact exceeds its size limit";
    try {
      validateMediaType(slot.mediaType);
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "invalid runtime media type";
    }
    if (
      slot.compatibilityRequirements.some(
        (requirement) => typeof requirement !== "string",
      )
    )
      return "invalid runtime compatibility requirement";
  }
  for (const capability of manifest.requirements.capabilities)
    if (typeof capability !== "string") return "invalid capability requirement";
  if (
    new Set(manifest.requirements.capabilities).size !==
    manifest.requirements.capabilities.length
  )
    return "duplicate capability requirement";
  return null;
}

function validateStagedPatchPaths(patch: Uint8Array, paths: string[]): void {
  if (patch.byteLength === 0 && paths.length > 0)
    throw new Error("staged path metadata has no corresponding patch");
  const unique = new Set(paths);
  if (unique.size !== paths.length)
    throw new Error("duplicate staged Git paths");
  for (const path of paths) {
    const error = validateRelativePath(path);
    if (error) throw new Error(error);
  }
}

function emptyLoaded(validation: CheckpointValidation): LoadedCheckpoint {
  return {
    validation,
    workspaceContents: new Map(),
    bundleBytes: new Uint8Array(),
    stagedPatchBytes: new Uint8Array(),
    runtimeBytes: null,
    attachments: [],
  };
}

function resolveLimits(limits: CaptureLimits = {}) {
  const bounded = (value: number | undefined, hard: number, label: string) => {
    const actual = value ?? hard;
    if (!Number.isSafeInteger(actual) || actual < 1 || actual > hard)
      throw new Error(`${label} must be between 1 and ${hard}`);
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

function normalizeGlobs(globs: string[]): string[] {
  if (!Array.isArray(globs)) throw new Error("path globs must be an array");
  if (globs.length > 128)
    throw new Error("path pattern count exceeds the safety limit");
  return [
    ...new Set(
      globs.map((glob) => {
        if (
          typeof glob !== "string" ||
          !glob ||
          glob.length > 1024 ||
          glob.includes("\\") ||
          isAbsolute(glob) ||
          glob.split("/").includes("..")
        ) {
          throw new Error(`invalid workspace path pattern: ${String(glob)}`);
        }
        return glob.replace(/^\.\//, "");
      }),
    ),
  ].sort();
}

function globExpression(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  const compiled = new RegExp(`${expression}$`);
  if (globCache.size >= 512) globCache.delete(globCache.keys().next().value!);
  globCache.set(glob, compiled);
  return compiled;
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((glob) => globExpression(glob).test(path));
}

function matchesPolicy(
  path: string,
  includeGlobs: string[] | null,
  excludeGlobs: string[],
): boolean {
  return (
    !isExcluded(path, excludeGlobs) &&
    (!includeGlobs || matchesAny(path, includeGlobs))
  );
}

function isExcluded(path: string, globs: string[]): boolean {
  return matchesAny(path, globs);
}

function globCouldMatchDescendant(glob: string, directory: string): boolean {
  if (globExpression(glob).test(directory)) return true;
  const wildcardIndex = glob.search(/[?*]/);
  const literalPrefix = wildcardIndex < 0 ? glob : glob.slice(0, wildcardIndex);
  return (
    literalPrefix.length === 0 ||
    literalPrefix.startsWith(`${directory}/`) ||
    directory.startsWith(literalPrefix)
  );
}

function validateRelativePath(path: string): string | null {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 4096 ||
    path.includes("\\") ||
    isAbsolute(path)
  )
    return `unsafe workspace path: ${String(path)}`;
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\x00-\x1f<>:\"|?*]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    )
  )
    return `unsafe or non-portable workspace path: ${path}`;
  if (parts[0] === ".git")
    return "workspace checkpoint entries may not target .git";
  return null;
}

function safeDestinationPath(root: string, path: string): string {
  const error = validateRelativePath(path);
  if (error) throw new Error(error);
  const destination = resolve(root, ...path.split("/"));
  const rel = relative(resolve(root), destination);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`unsafe destination path: ${path}`);
  return destination;
}

function assertNoSymlinkTraversal(
  root: string,
  path: string,
  target: string,
  symlinks: Map<string, string>,
): void {
  const destination = resolve(
    root,
    dirname(resolve(root, ...path.split("/"))),
    target,
  );
  const destinationRelative = relative(resolve(root), destination)
    .split(sep)
    .filter(Boolean);
  for (let index = 1; index <= destinationRelative.length; index += 1) {
    const prefix = destinationRelative.slice(0, index).join("/");
    if (symlinks.has(prefix)) {
      throw new Error(
        `symlink traversal through another symlink is not supported: ${path}`,
      );
    }
  }
}

function assertSymlinkContained(
  root: string,
  path: string,
  target: string,
): void {
  if (!target || isAbsolute(target) || target.includes("\\"))
    throw new Error(`unsafe symlink target: ${path}`);
  const parent = dirname(resolve(root, ...path.split("/")));
  const destination = resolve(parent, target);
  const rel = relative(resolve(root), destination);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`symlink escapes workspace: ${path}`);
}

async function readlinkString(path: string): Promise<string> {
  return readlink(path);
}

function rejectUnsupportedIndex(root: string): void {
  const taggedPaths = gitRawText(root, ["ls-files", "-v", "-z"])
    .split("\0")
    .filter(Boolean);
  if (taggedPaths.some((entry) => /^[a-z]/.test(entry) || entry[0] === "S")) {
    throw new Error(
      "Assume-unchanged and skip-worktree index entries are not supported",
    );
  }
  const debug = gitText(root, ["ls-files", "--debug"]);
  for (const match of debug.matchAll(/flags:\s*([0-9a-f]+)/gi)) {
    if ((Number.parseInt(match[1]!, 16) & 0x20000000) !== 0) {
      throw new Error("Git intent-to-add index entries are not supported");
    }
  }
  if (
    gitTryText(root, ["config", "--bool", "core.sparseCheckout"]) === "true"
  ) {
    throw new Error("Sparse checkouts are not supported");
  }
  if (gitTryText(root, ["config", "--bool", "core.splitIndex"]) === "true") {
    throw new Error("Split Git indexes are not supported");
  }
}

async function buildStagedPatch(
  root: string,
  paths: string[],
  maxBytes: number,
  patchPath: string,
): Promise<Buffer> {
  if (paths.length === 0) return Buffer.alloc(0);
  await writeFile(patchPath, new Uint8Array(), { flag: "wx" });
  let totalBytes = 0;
  let current: string[] = [];
  let argumentBytes = 0;
  const flush = async () => {
    if (current.length === 0) return;
    totalBytes += await runGitOutputBounded(
      root,
      [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
        ...current.map((path) => `:(literal)${path}`),
      ],
      maxBytes - totalBytes,
      "Staged Git changes exceed the remaining checkpoint byte limit",
      createWriteStream(patchPath, { flags: "a" }),
    );
    current = [];
    argumentBytes = 0;
  };
  for (const path of paths) {
    const encodedSize = Buffer.byteLength(path, "utf8") + 12;
    if (current.length > 0 && argumentBytes + encodedSize > 64 * 1024) {
      await flush();
    }
    current.push(path);
    argumentBytes += encodedSize;
  }
  await flush();
  return readFile(patchPath);
}

async function runGitToFileBounded(
  cwd: string,
  args: string[],
  destination: string,
  maxBytes: number,
  limitError: string,
): Promise<number> {
  return runGitOutputBounded(
    cwd,
    args,
    maxBytes,
    limitError,
    createWriteStream(destination, { flags: "wx" }),
  );
}

async function runGitOutputBounded(
  cwd: string,
  args: string[],
  maxBytes: number,
  limitError: string,
  destination: Writable,
): Promise<number> {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let totalBytes = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length);
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.byteLength > maxBytes - totalBytes) {
        child.kill();
        callback(new Error(limitError));
        return;
      }
      totalBytes += bytes.byteLength;
      callback(null, bytes);
    },
  });
  try {
    const [, exitCode] = await Promise.all([
      pipeline(child.stdout, limiter, destination),
      closed,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim();
      throw new Error(
        detail
          ? `Git command failed: ${detail}`
          : `Git command failed with exit code ${String(exitCode)}`,
      );
    }
    return totalBytes;
  } catch (error) {
    child.kill();
    await closed.catch(() => undefined);
    throw error;
  }
}

function restoreGitRawText(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: HARD_LIMITS.checkpointBytes,
    env: safeRestoreEnvironment(),
  });
}

function restoreGitText(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: HARD_LIMITS.checkpointBytes,
    env: safeRestoreEnvironment(),
  }).trim();
}

function restoreGitSetHeadAndIndex(
  cwd: string,
  head: string,
  branch: string | null,
): void {
  if (branch) {
    restoreGitText(cwd, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  } else {
    restoreGitText(cwd, ["update-ref", "--no-deref", "HEAD", head]);
  }
  restoreGitText(cwd, ["read-tree", head]);
}

function restoreGitTryText(cwd: string, args: string[]): string | null {
  try {
    return restoreGitText(cwd, args);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (code === 1) return null;
    throw error;
  }
}

function safeRestoreEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("GIT_")) delete environment[key];
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function gitRawText(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: HARD_LIMITS.checkpointBytes,
  });
}

function gitText(cwd: string, args: string[]): string {
  return gitRawText(cwd, args).replace(/\r?\n$/, "");
}

function gitTryText(cwd: string, args: string[]): string | null {
  try {
    return gitText(cwd, args);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (code === 1) return null;
    throw error;
  }
}

function localGitVersionOrNull(): string | null {
  try {
    return execFileSync("git", ["--version"], { encoding: "utf8" })
      .replace(/^git version\s+/, "")
      .trim();
  } catch {
    return null;
  }
}

function assertVersionAtLeast(
  actual: string,
  minimum: string,
  name: string,
): void {
  if (!versionIsAtLeast(actual, minimum))
    throw new Error(
      `${name} ${minimum} or newer is required (found ${actual})`,
    );
}

function versionIsAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) =>
    value
      .split(".")
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (actualParts.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

async function assertFileTransportOutsideWorkspace(
  transport: BlobTransport,
  workspaceRoot: string,
): Promise<void> {
  if (!(transport instanceof FileBlobTransport)) return;
  const configuredPath = resolve(transport.rootDirectory);
  let cursor = configuredPath;
  const suffix: string[] = [];
  let canonicalParent: string;
  while (true) {
    try {
      canonicalParent = await realpath(cursor);
      break;
    } catch (error) {
      if (!isMissingFile(error) || dirname(cursor) === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = dirname(cursor);
    }
  }
  const canonicalPath = join(canonicalParent, ...suffix);
  const relativePath = relative(workspaceRoot, canonicalPath);
  if (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  ) {
    throw new Error(
      "File blob transport storage must be outside the captured workspace",
    );
  }
}

async function readSafeWorkspaceFile(file: CapturedFile): Promise<Buffer> {
  const handle = await open(
    file.absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== file.size ||
      ((metadata.mode & 0o111) !== 0) !== file.executable
    ) {
      throw new Error(`Workspace file changed during capture: ${file.path}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readSafeBlobFile(path: string): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > HARD_LIMITS.checkpointBytes) {
      throw new Error("Blob must be a bounded regular file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function storeBlob(
  transport: BlobTransport,
  bytes: Uint8Array,
): Promise<CheckpointBlob> {
  const digest = sha256(bytes);
  const reference = await transport.putBlob(bytes);
  assertStoredReference(reference, digest);
  return { reference, size: bytes.byteLength, sha256: digest };
}

function assertStoredReference(reference: string, expected: string): void {
  if (reference !== expected)
    throw new Error("Blob transport must return the SHA-256 content address");
}

function assertBlobReference(reference: string): void {
  if (!isSha256(reference))
    throw new Error("Invalid content-addressed blob reference");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasOnlyKeys(value: unknown, allowedKeys: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function isBlobMetadata(blob: unknown): blob is CheckpointBlob {
  if (!hasOnlyKeys(blob, ["reference", "size", "sha256"])) return false;
  const candidate = blob as CheckpointBlob;
  return (
    isSha256(candidate.reference) &&
    isSha256(candidate.sha256) &&
    candidate.reference === candidate.sha256 &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0
  );
}

function isValidBranchName(branch: unknown): branch is string {
  if (
    typeof branch !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
  )
    return false;
  if (
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock")
  )
    return false;
  return branch
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
    );
}

function validateAttachmentName(name: string): void {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 256 ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(`invalid checkpoint attachment name: ${String(name)}`);
  }
}

function validateMediaType(mediaType: string): string {
  if (
    typeof mediaType !== "string" ||
    mediaType.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(mediaType)
  ) {
    throw new Error(`invalid media type: ${String(mediaType)}`);
  }
  return mediaType;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY"),
  );
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export { R2BlobTransport } from "./r2";
export type { ImmutableR2Bucket } from "./r2";
export {
  captureManagedWorkBundle,
  validateManagedWorkBundle,
  restoreManagedWorkBundle,
  MANAGED_WORK_ARTIFACT_MEDIA_TYPE,
  MANAGED_WORK_BUNDLE_FORMAT,
  MANAGED_WORK_BUNDLE_VERSION,
  MANAGED_WORK_PROFILE,
} from "./managed-work";
export type {
  CapturedManagedWorkBundle,
  ManagedWorkBundleManifest,
  ManagedWorkBundleCaptureOptions,
  ManagedWorkRestoreStorage,
  PreparedManagedWorkRestoreReceipt,
  RestoreManagedWorkBundleOptions,
  RestoredManagedWorkBundle,
} from "./managed-work";
