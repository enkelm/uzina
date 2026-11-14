export const PORTABLE_WORKSPACE_CHECKPOINT_FORMAT =
  "uzina-workspace-checkpoint" as const;
export const PORTABLE_WORKSPACE_CHECKPOINT_VERSION = 1 as const;
export const PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
export const PORTABLE_WORKSPACE_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const PORTABLE_WORKSPACE_RUNTIME_MAX_BYTES = 32 * 1024 * 1024;
export const PORTABLE_WORKSPACE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
export const PORTABLE_WORKSPACE_TOTAL_MAX_BYTES = 512 * 1024 * 1024;
export const PORTABLE_WORKSPACE_MAX_FILES = 100_000;
export const PORTABLE_WORKSPACE_MAX_OMISSIONS = 10_000;
/** Maximum pattern-code-unit and NFA state visits for one portable manifest. */
const PORTABLE_WORKSPACE_GLOB_WORK_LIMIT = 64_000_000;
export const WORKSPACE_CHECKPOINT_DEFAULT_EXCLUSIONS = [
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

const REQUIRED_WORKSPACE_CAPABILITIES = [
  "workspace-files-v1",
  "git-bundle-v1",
  "git-index-patch-v1",
] as const;

export interface PortableCheckpointBlobReference {
  reference: string;
  size: number;
}

const GLOB_LITERAL = 0;
const GLOB_ONE = 1;
const GLOB_STAR = 2;
const GLOBSTAR = 3;
const GLOBSTAR_DIRECTORY_START = 4;
const GLOBSTAR_DIRECTORY_LOOP = 5;
const GLOB_TOKEN_SHIFT = 16;
const GLOB_TOKEN_MASK = 0xffff;
const MAX_WORKSPACE_GLOB_LENGTH = 1024;
const MAX_GLOB_STATES = MAX_WORKSPACE_GLOB_LENGTH + 1;
const globCache = new Map<string, Uint32Array>();
// Matching is synchronous; reusable state arrays avoid per-path allocations.
const globStates = new Uint16Array(MAX_GLOB_STATES);
const nextGlobStates = new Uint16Array(MAX_GLOB_STATES);
const seenGlobStates = new Uint32Array(MAX_GLOB_STATES);
let globGeneration = 0;

interface WorkspaceGlobWorkBudget {
  remaining: number;
}

export function validatePortableAttachmentName(name: string): void {
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

export function validatePortableMediaType(mediaType: string): string {
  if (
    typeof mediaType !== "string" ||
    mediaType.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(mediaType)
  ) {
    throw new Error(`invalid media type: ${String(mediaType)}`);
  }
  return mediaType;
}

export function normalizeWorkspaceGlobs(globs: string[]): string[] {
  if (!Array.isArray(globs)) throw new Error("path globs must be an array");
  if (globs.length > 128)
    throw new Error("path pattern count exceeds the safety limit");
  return [
    ...new Set(
      globs.map((glob) => {
        if (
          typeof glob !== "string" ||
          !glob ||
          glob.length > MAX_WORKSPACE_GLOB_LENGTH ||
          glob.includes("\\") ||
          glob.startsWith("/") ||
          /^[A-Za-z]:\//.test(glob) ||
          glob.split("/").includes("..")
        ) {
          throw new Error(`invalid workspace path pattern: ${String(glob)}`);
        }
        return glob.replace(/^\.\//, "");
      }),
    ),
  ].sort();
}

function compiledGlob(glob: string): Uint32Array {
  const cached = globCache.get(glob);
  if (cached) return cached;
  const tokens = new Uint32Array(glob.length);
  let count = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    let kind = GLOB_LITERAL;
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        // The loop state exits only on slash; the start state also allows zero segments.
        tokens[count] = GLOBSTAR_DIRECTORY_START << GLOB_TOKEN_SHIFT;
        count += 1;
        tokens[count] = GLOBSTAR_DIRECTORY_LOOP << GLOB_TOKEN_SHIFT;
        count += 1;
        continue;
      }
      kind = GLOBSTAR;
    } else if (char === "*") {
      kind = GLOB_STAR;
    } else if (char === "?") {
      kind = GLOB_ONE;
    }
    tokens[count] = (kind << GLOB_TOKEN_SHIFT) | char.charCodeAt(0);
    count += 1;
  }
  const result = tokens.slice(0, count);
  if (globCache.size >= 512) globCache.delete(globCache.keys().next().value!);
  globCache.set(glob, result);
  return result;
}

function nextGlobGeneration(): number {
  if (globGeneration >= 0xffff_fffe) {
    seenGlobStates.fill(0);
    globGeneration = 1;
  } else {
    globGeneration += 1;
  }
  return globGeneration;
}

function consumeGlobWork(
  budget: WorkspaceGlobWorkBudget | undefined,
  amount = 1,
): void {
  if (!budget) return;
  budget.remaining -= amount;
  if (budget.remaining < 0) {
    throw new Error(
      "Workspace checkpoint glob matching exceeded its validation work limit",
    );
  }
}

function addGlobClosure(
  state: number,
  tokens: Uint32Array,
  target: Uint16Array,
  targetLength: number,
  generation: number,
  budget?: WorkspaceGlobWorkBudget,
): number {
  const pendingStart = targetLength;
  const addState = (candidate: number) => {
    if (seenGlobStates[candidate] === generation) return;
    consumeGlobWork(budget);
    seenGlobStates[candidate] = generation;
    target[targetLength] = candidate;
    targetLength += 1;
  };
  addState(state);
  for (let index = pendingStart; index < targetLength; index += 1) {
    const pending = target[index]!;
    if (pending >= tokens.length) continue;
    const kind = tokens[pending]! >>> GLOB_TOKEN_SHIFT;
    if (kind === GLOB_STAR || kind === GLOBSTAR) {
      addState(pending + 1);
    } else if (kind === GLOBSTAR_DIRECTORY_START) {
      addState(pending + 1);
      addState(pending + 2);
    }
  }
  return targetLength;
}

function compiledGlobMatches(
  path: string,
  tokens: Uint32Array,
  budget?: WorkspaceGlobWorkBudget,
): boolean {
  let generation = nextGlobGeneration();
  let currentLength = addGlobClosure(
    0,
    tokens,
    globStates,
    0,
    generation,
    budget,
  );
  let current = globStates;
  let next = nextGlobStates;
  for (let pathIndex = 0; pathIndex < path.length; pathIndex += 1) {
    const charCode = path.charCodeAt(pathIndex);
    generation = nextGlobGeneration();
    let nextLength = 0;
    for (let index = 0; index < currentLength; index += 1) {
      const state = current[index]!;
      consumeGlobWork(budget);
      if (state >= tokens.length) continue;
      const token = tokens[state]!;
      const kind = token >>> GLOB_TOKEN_SHIFT;
      if (kind === GLOB_LITERAL) {
        if ((token & GLOB_TOKEN_MASK) === charCode) {
          nextLength = addGlobClosure(
            state + 1,
            tokens,
            next,
            nextLength,
            generation,
            budget,
          );
        }
      } else if (kind === GLOB_ONE) {
        if (charCode !== 47) {
          nextLength = addGlobClosure(
            state + 1,
            tokens,
            next,
            nextLength,
            generation,
            budget,
          );
        }
      } else if (kind === GLOB_STAR) {
        if (charCode !== 47) {
          nextLength = addGlobClosure(
            state,
            tokens,
            next,
            nextLength,
            generation,
            budget,
          );
        }
      } else if (kind === GLOBSTAR) {
        nextLength = addGlobClosure(
          state,
          tokens,
          next,
          nextLength,
          generation,
          budget,
        );
      } else if (kind === GLOBSTAR_DIRECTORY_LOOP) {
        nextLength = addGlobClosure(
          state,
          tokens,
          next,
          nextLength,
          generation,
          budget,
        );
        if (charCode === 47) {
          nextLength = addGlobClosure(
            state + 1,
            tokens,
            next,
            nextLength,
            generation,
            budget,
          );
        }
      }
    }
    currentLength = nextLength;
    const prior = current;
    current = next;
    next = prior;
    if (currentLength === 0) return false;
  }
  for (let index = 0; index < currentLength; index += 1) {
    if (current[index] === tokens.length) return true;
  }
  return false;
}

function matchesAny(
  path: string,
  globs: string[],
  budget?: WorkspaceGlobWorkBudget,
): boolean {
  return globs.some((glob) =>
    compiledGlobMatches(path, compiledGlob(glob), budget),
  );
}

export function workspacePathMatchesAny(
  path: string,
  globs: string[],
): boolean {
  return matchesAny(path, globs);
}

function matchesPolicy(
  path: string,
  includeGlobs: string[] | null,
  excludeGlobs: string[],
  budget?: WorkspaceGlobWorkBudget,
): boolean {
  return (
    !matchesAny(path, excludeGlobs, budget) &&
    (!includeGlobs || matchesAny(path, includeGlobs, budget))
  );
}

export function workspacePathMatchesPolicy(
  path: string,
  includeGlobs: string[] | null,
  excludeGlobs: string[],
): boolean {
  return matchesPolicy(path, includeGlobs, excludeGlobs);
}

export function workspaceGlobCouldMatchDescendant(
  glob: string,
  directory: string,
): boolean {
  if (compiledGlobMatches(directory, compiledGlob(glob))) return true;
  let wildcardIndex = -1;
  for (let index = 0; index < glob.length; index += 1) {
    if (glob[index] === "?" || glob[index] === "*") {
      wildcardIndex = index;
      break;
    }
  }
  const literalPrefix = wildcardIndex < 0 ? glob : glob.slice(0, wildcardIndex);
  return (
    literalPrefix.length === 0 ||
    literalPrefix.startsWith(`${directory}/`) ||
    directory.startsWith(literalPrefix)
  );
}

const SHA256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

/** Incremental SHA-256 used when the Worker verifies binary bodies without buffering them. */
export class Sha256Stream {
  readonly #state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  readonly #buffer = new Uint8Array(64);
  readonly #words = new Uint32Array(64);
  #buffered = 0;
  #bytes = 0n;
  #finished = false;

  update(bytes: Uint8Array): void {
    if (this.#finished) throw new Error("SHA-256 stream is already finalized");
    this.#bytes += BigInt(bytes.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = Math.min(64 - this.#buffered, bytes.byteLength - offset);
      this.#buffer.set(bytes.subarray(offset, offset + count), this.#buffered);
      this.#buffered += count;
      offset += count;
      if (this.#buffered === 64) {
        this.#compress(this.#buffer);
        this.#buffered = 0;
      }
    }
  }

  digest(): string {
    if (this.#finished) throw new Error("SHA-256 stream is already finalized");
    this.#finished = true;
    const bitLength = this.#bytes * 8n;
    this.#buffer[this.#buffered++] = 0x80;
    if (this.#buffered > 56) {
      this.#buffer.fill(0, this.#buffered);
      this.#compress(this.#buffer);
      this.#buffered = 0;
    }
    this.#buffer.fill(0, this.#buffered, 56);
    for (let i = 0; i < 8; i += 1) {
      this.#buffer[63 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
    }
    this.#compress(this.#buffer);
    return [...this.#state]
      .map((word) => word.toString(16).padStart(8, "0"))
      .join("");
  }

  #compress(block: Uint8Array): void {
    const words = this.#words;
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] =
        ((block[offset]! << 24) |
          (block[offset + 1]! << 16) |
          (block[offset + 2]! << 8) |
          block[offset + 3]!) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.#state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sum1 + choice + SHA256[index]! + words[index]!) >>> 0;
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.#state[0] = (this.#state[0]! + a!) >>> 0;
    this.#state[1] = (this.#state[1]! + b!) >>> 0;
    this.#state[2] = (this.#state[2]! + c!) >>> 0;
    this.#state[3] = (this.#state[3]! + d!) >>> 0;
    this.#state[4] = (this.#state[4]! + e!) >>> 0;
    this.#state[5] = (this.#state[5]! + f!) >>> 0;
    this.#state[6] = (this.#state[6]! + g!) >>> 0;
    this.#state[7] = (this.#state[7]! + h!) >>> 0;
  }
}

function rotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export async function digestReadableStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ reference: string; size: number }> {
  const reader = stream.getReader();
  const hash = new Sha256Stream();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("Stream exceeds its byte limit");
      hash.update(part.value);
    }
    return { reference: hash.digest(), size };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function portableWorkspaceBlobReferences(
  value: unknown,
  manifestReference: string,
  manifestBytes: number,
): PortableCheckpointBlobReference[] {
  if (
    !/^[a-f0-9]{64}$/.test(manifestReference) ||
    !Number.isSafeInteger(manifestBytes) ||
    manifestBytes < 1 ||
    manifestBytes > PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES ||
    !record(value) ||
    !onlyKeys(value, [
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
    ]) ||
    value.format !== PORTABLE_WORKSPACE_CHECKPOINT_FORMAT ||
    value.version !== PORTABLE_WORKSPACE_CHECKPOINT_VERSION ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !record(value.requirements) ||
    !record(value.source) ||
    !record(value.policy) ||
    !record(value.workspace) ||
    !record(value.git) ||
    value.runtimeArtifact !== null ||
    !Array.isArray(value.attachments) ||
    value.attachments.length !== 0
  ) {
    throw new Error("Malformed or unsupported workspace checkpoint manifest");
  }
  const capabilities = value.requirements.capabilities;
  if (!Array.isArray(capabilities))
    throw new Error("Malformed workspace checkpoint capabilities");
  if (
    !Array.isArray(value.workspace.entries) ||
    value.workspace.entries.length > PORTABLE_WORKSPACE_MAX_FILES ||
    !Array.isArray(value.workspace.omissions) ||
    value.workspace.omissions.length > PORTABLE_WORKSPACE_MAX_OMISSIONS ||
    !Array.isArray(value.git.stagedPaths) ||
    !Array.isArray(value.policy.excludeGlobs) ||
    (value.policy.includeGlobs !== null &&
      !Array.isArray(value.policy.includeGlobs)) ||
    typeof value.source.linkedWorktree !== "boolean" ||
    typeof value.source.gitVersion !== "string" ||
    !/^(?:git version )?[0-9]+\.[0-9]+(?:\.[0-9]+)?[. +()A-Za-z0-9_-]{0,64}$/.test(
      value.source.gitVersion,
    ) ||
    typeof value.source.head !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(value.source.head) ||
    (value.source.branch !== null && !validBranchName(value.source.branch)) ||
    typeof value.requirements.minimumGitVersion !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.requirements.minimumGitVersion) ||
    capabilities.length !== REQUIRED_WORKSPACE_CAPABILITIES.length ||
    REQUIRED_WORKSPACE_CAPABILITIES.some(
      (capability) => !capabilities.includes(capability),
    ) ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((capability) => typeof capability !== "string")
  ) {
    throw new Error("Malformed workspace checkpoint metadata");
  }
  let includeGlobs: string[] | null;
  let excludeGlobs: string[];
  try {
    excludeGlobs = normalizeWorkspaceGlobs(
      value.policy.excludeGlobs as string[],
    );
    includeGlobs =
      value.policy.includeGlobs === null
        ? null
        : normalizeWorkspaceGlobs(value.policy.includeGlobs as string[]);
  } catch {
    throw new Error("Malformed workspace checkpoint policy");
  }
  const effectiveExclusions = normalizeWorkspaceGlobs([
    ...excludeGlobs,
    ...WORKSPACE_CHECKPOINT_DEFAULT_EXCLUSIONS,
  ]);
  const policyWork: WorkspaceGlobWorkBudget = {
    remaining: PORTABLE_WORKSPACE_GLOB_WORK_LIMIT,
  };
  const policyPatterns = [...(includeGlobs ?? []), ...effectiveExclusions];
  consumeGlobWork(
    policyWork,
    policyPatterns.reduce((total, glob) => total + glob.length, 0),
  );
  const assertSelectedPathAllowed = (path: string) => {
    if (!matchesPolicy(path, includeGlobs, effectiveExclusions, policyWork)) {
      throw new Error("workspace path violates the checkpoint policy");
    }
  };
  const refs = new Map<string, number>();
  const addBlob = (
    blob: unknown,
    maxBytes = PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
  ) => {
    if (
      !record(blob) ||
      !onlyKeys(blob, ["reference", "size", "sha256"]) ||
      typeof blob.reference !== "string" ||
      !/^[a-f0-9]{64}$/.test(blob.reference) ||
      blob.sha256 !== blob.reference ||
      !Number.isSafeInteger(blob.size) ||
      (blob.size as number) < 0 ||
      (blob.size as number) > maxBytes
    ) {
      throw new Error("Malformed workspace checkpoint blob reference");
    }
    const size = blob.size as number;
    const prior = refs.get(blob.reference);
    if (prior !== undefined && prior !== size)
      throw new Error("Conflicting blob sizes");
    refs.set(blob.reference, size);
  };
  if (!record(value.git.bundle) || !record(value.git.stagedPatch)) {
    throw new Error("Malformed Git checkpoint blobs");
  }
  addBlob(value.git.bundle);
  addBlob(value.git.stagedPatch);
  const paths = new Map<string, string>();
  const symlinks = new Map<string, string>();
  const stagedPaths = new Set<string>();
  const omissionPaths = new Set<string>();
  let aggregate = value.git.bundle.size as number;
  aggregate += value.git.stagedPatch.size as number;
  for (const entry of value.workspace.entries) {
    if (!record(entry) || (entry.kind !== "file" && entry.kind !== "symlink")) {
      throw new Error("Malformed workspace file entry");
    }
    const path = portablePath(entry.path);
    assertSelectedPathAllowed(path);
    const portable = path.normalize("NFC").toLowerCase();
    const prior = paths.get(portable);
    if (prior !== undefined && prior !== path)
      throw new Error("Conflicting portable workspace paths");
    if (prior !== undefined) throw new Error("Duplicate workspace path");
    paths.set(portable, path);
    if (
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > PORTABLE_WORKSPACE_FILE_MAX_BYTES ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Malformed workspace file metadata");
    }
    if (entry.kind === "file") {
      if (
        typeof entry.executable !== "boolean" ||
        !onlyKeys(entry, ["path", "kind", "size", "sha256", "executable"])
      ) {
        throw new Error("Malformed workspace file mode");
      }
    } else {
      if (
        typeof entry.linkTarget !== "string" ||
        !onlyKeys(entry, ["path", "kind", "size", "sha256", "linkTarget"]) ||
        !containedSymlinkTarget(path, entry.linkTarget)
      ) {
        throw new Error("Unsafe workspace symlink");
      }
      symlinks.set(path, entry.linkTarget);
    }
    addBlob(
      { reference: entry.sha256, sha256: entry.sha256, size: entry.size },
      PORTABLE_WORKSPACE_FILE_MAX_BYTES,
    );
    aggregate += entry.size as number;
  }
  for (const path of paths.values()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if (paths.has(parent.normalize("NFC").toLowerCase()))
        throw new Error("Conflicting workspace entry paths");
    }
  }
  for (const entry of value.workspace.entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (symlinks.has(parts.slice(0, index).join("/"))) {
        throw new Error("Workspace path traverses a symlink");
      }
    }
    if (entry.kind === "symlink") {
      const targetParts = [...parts.slice(0, -1)];
      for (const segment of entry.linkTarget.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") targetParts.pop();
        else targetParts.push(segment);
      }
      for (let index = 1; index <= targetParts.length; index += 1) {
        if (symlinks.has(targetParts.slice(0, index).join("/"))) {
          throw new Error("Workspace symlink traverses another symlink");
        }
      }
    }
  }
  for (const stagedPath of value.git.stagedPaths) {
    const path = portablePath(stagedPath);
    assertSelectedPathAllowed(path);
    if (stagedPaths.has(path)) throw new Error("Duplicate staged Git path");
    stagedPaths.add(path);
  }
  for (const omission of value.workspace.omissions) {
    if (
      !record(omission) ||
      !onlyKeys(omission, ["path", "reason"]) ||
      !["excluded", "outside-inclusion", "size-limit"].includes(
        String(omission.reason),
      )
    )
      throw new Error("Malformed workspace omission record");
    const path = portablePath(omission.path);
    if (omissionPaths.has(path))
      throw new Error("Duplicate workspace omission record");
    omissionPaths.add(path);
  }
  if (aggregate > PORTABLE_WORKSPACE_TOTAL_MAX_BYTES)
    throw new Error("Workspace checkpoint exceeds total size limit");
  refs.set(manifestReference, manifestBytes);
  if (refs.size > PORTABLE_WORKSPACE_MAX_FILES + 3)
    throw new Error("Workspace checkpoint has too many blob references");
  return [...refs]
    .map(([reference, size]) => ({ reference, size }))
    .sort((a, b) => a.reference.localeCompare(b.reference));
}

function portablePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error("Unsafe workspace path");
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        /[\u0000-\u001f\u007f]/.test(part) ||
        /[<>:"|?*]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    )
  )
    throw new Error("Unsafe workspace path");
  return value;
}

function containedSymlinkTarget(path: string, target: string): boolean {
  if (
    !target ||
    target.length > 2048 ||
    target.startsWith("/") ||
    target.includes("\\") ||
    target.includes("\0") ||
    /^[A-Za-z]:/.test(target)
  )
    return false;
  const parts = [...path.split("/").slice(0, -1)];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return false;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.length > 0;
}

function validBranchName(branch: unknown): branch is string {
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
