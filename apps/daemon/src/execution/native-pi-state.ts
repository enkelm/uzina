import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  writeFileSync,
  readSync,
  renameSync,
  unlinkSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { FactoryWorkerConfiguration } from "@uzina/contracts/native-provisioning";
import type { NativeActivityEvidence } from "@uzina/contracts/assignments";
import { z } from "zod";
import { readNativeBootstrapFile } from "./native-agent-bootstrap";
import { localProcessAlive } from "./local-process";
import { ExecutionError } from "./errors";
export const deliveryHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const time = z.string().datetime();
const deliverySchema = z
  .object({
    messageId: z.string().min(1).max(128),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    entryId: z.string().min(1).max(128).nullable(),
    admittedAt: time.nullable(),
    startedAt: time.nullable(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    bindingHash: z.string(),
    ownerPid: z.number().int().positive(),
    ownerToken: z.string().uuid(),
    sessionFile: z.string(),
    state: z.enum(["armed", "paused", "detached"]),
    reason: z.string().max(100).nullable(),
    activeMessageId: z.string().nullable(),
    deliveries: z.array(deliverySchema).max(128),
  })
  .strict();
export type NativePiState = z.infer<typeof stateSchema>;
export type NativePiDelivery = NativePiState["deliveries"][number];
const fail = (code: string): never => {
  throw new ExecutionError(code);
};
function bindingHash(config: FactoryWorkerConfiguration) {
  return deliveryHash(JSON.stringify(config));
}
function load(
  config: FactoryWorkerConfiguration,
  bytes = readNativeBootstrapFile(config.nativeDelivery!.statePath),
) {
  const state = stateSchema.parse(JSON.parse(bytes));
  if (state.bindingHash !== bindingHash(config))
    fail("native_activity_binding_conflict");
  validateSessionPath(config, state.sessionFile);
  return state;
}
function validateSessionPath(config: FactoryWorkerConfiguration, file: string) {
  const directory = config.nativeDelivery!.sessionDirectory;
  const info = lstatSync(directory);
  if (
    !isAbsolute(file) ||
    dirname(file) !== directory ||
    realpathSync(directory) !== directory ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.()
  )
    fail("native_activity_session_path_conflict");
}
function lock(config: FactoryWorkerConfiguration) {
  return `${config.nativeDelivery!.statePath}.lock`;
}
function owns(config: FactoryWorkerConfiguration, state: NativePiState) {
  const owner = JSON.parse(readNativeBootstrapFile(lock(config))) as {
    pid: number;
    token: string;
  };
  return (
    owner.pid === state.ownerPid &&
    owner.token === state.ownerToken &&
    localProcessAlive(owner.pid)
  );
}
/** Pi owns this JSONL, including its normal file mode. Its enclosing session directory must be private. */
export function readNativeSession(
  config: FactoryWorkerConfiguration,
  file: string,
  sync = false,
): Array<Record<string, unknown>> {
  validateSessionPath(config, file);
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      info.size > 8 * 1024 * 1024
    )
      fail("native_activity_session_unavailable");
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes === buffer.length) fail("native_activity_session_unavailable");
    const entries = buffer
      .subarray(0, bytes)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = entries[0];
    if (
      header?.type !== "session" ||
      header.id !== config.nativeDelivery!.binding.sessionId ||
      header.cwd !== config.nativeDelivery!.workspaceDirectory
    )
      fail("native_activity_session_binding_conflict");
    if (sync) fsyncSync(fd);
    return entries;
  } finally {
    closeSync(fd);
  }
}
export function nativeEntryText(entry: Record<string, unknown>): string | null {
  const message = entry.message as
    | { role?: string; content?: unknown }
    | undefined;
  if (entry.type !== "message" || message?.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === "text")
  )
    return message.content.map((block) => block.text).join("\n");
  return null;
}
/** Read-only, executor-side evidence. Neither HTTP nor model tools can supply paths or receipts. */
export function observeNativePi(
  config: FactoryWorkerConfiguration,
): NativeActivityEvidence | null {
  if (!config.nativeDelivery) return null;
  const state = load(config);
  if (!owns(config, state) || state.state === "detached") return null;
  const admitted = state.deliveries.filter(
    (delivery) => delivery.entryId && delivery.admittedAt,
  );
  const entries = admitted.length
    ? readNativeSession(config, state.sessionFile)
    : [];
  const deliveries: NativeActivityEvidence["deliveries"] = admitted.map(
    (delivery) => {
      const entry = entries.find(
        (candidate) => candidate.id === delivery.entryId,
      );
      const text = entry ? nativeEntryText(entry) : null;
      if (text === null || deliveryHash(text) !== delivery.payloadSha256)
        fail("native_delivery_evidence_conflict");
      return {
        messageId: delivery.messageId,
        entryId: delivery.entryId!,
        payloadSha256: delivery.payloadSha256,
        admittedAt: delivery.admittedAt!,
        startedAt: delivery.startedAt,
      };
    },
  );
  return {
    binding: config.nativeDelivery.binding,
    state: state.state,
    reason: state.reason,
    deliveries,
  };
}

/** One live native adapter per immutable launch. Reopening active work is paused, never replayed. */
export class NativePiJournal {
  readonly state: NativePiState;
  readonly #config: FactoryWorkerConfiguration;
  readonly #owner = { pid: process.pid, token: randomUUID() };
  #closed = false;
  #retainedBytes: string | undefined;
  constructor(config: FactoryWorkerConfiguration, sessionFile: string) {
    this.#config = config;
    validateSessionPath(config, sessionFile);
    const path = lock(config);
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(fd, JSON.stringify(this.#owner));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt)
          throw error;
        const raw = readNativeBootstrapFile(path);
        const previous = JSON.parse(raw) as { pid: number; token: string };
        if (
          !Number.isSafeInteger(previous.pid) ||
          previous.pid <= 0 ||
          typeof previous.token !== "string" ||
          localProcessAlive(previous.pid)
        )
          fail("native_activity_journal_in_use");
        if (readNativeBootstrapFile(path) !== raw)
          fail("native_activity_journal_in_use");
        unlinkSync(path);
      }
    }
    try {
      let previous: NativePiState | undefined;
      try {
        this.#retainedBytes = readNativeBootstrapFile(
          config.nativeDelivery!.statePath,
        );
        previous = load(config, this.#retainedBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (previous && previous.sessionFile !== sessionFile)
        fail("native_activity_session_binding_conflict");
      this.state = previous ?? {
        version: 1,
        bindingHash: bindingHash(config),
        ownerPid: this.#owner.pid,
        ownerToken: this.#owner.token,
        sessionFile,
        state: "armed",
        reason: null,
        activeMessageId: null,
        deliveries: [],
      };
      if (
        previous?.activeMessageId ||
        (previous?.state !== undefined && previous.state !== "armed")
      ) {
        this.state.state = "paused";
        this.state.reason = "native_restart_requires_resume";
      }
      this.state.ownerPid = this.#owner.pid;
      this.state.ownerToken = this.#owner.token;
      this.save();
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
  }
  save() {
    if (this.#closed) fail("native_activity_journal_closed");
    const path = this.#config.nativeDelivery!.statePath;
    // Refuse replaced/permissive artifacts, even on an otherwise atomic update.
    try {
      if (readNativeBootstrapFile(path) !== this.#retainedBytes)
        fail("native_activity_journal_conflict");
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        this.#retainedBytes !== undefined
      )
        throw error;
    }
    if (!owns(this.#config, this.state)) fail("native_activity_journal_in_use");
    const bytes = JSON.stringify(stateSchema.parse(this.state));
    if (Buffer.byteLength(bytes) > 65_536)
      fail("native_activity_journal_limit");
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    this.#retainedBytes = bytes;
    const parent = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  close() {
    if (this.#closed) return;
    this.state.state = "detached";
    this.state.reason ??= "native_session_closed";
    try {
      this.save();
    } finally {
      this.#closed = true;
      if (owns(this.#config, this.state)) unlinkSync(lock(this.#config));
    }
  }
}
