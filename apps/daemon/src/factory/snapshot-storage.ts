import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type {
  StoredWorkspaceBlob,
  WorkspaceSnapshotStorage,
} from "@uzina/core/snapshot-storage";

const OBJECT_MAX_BYTES = 512 * 1024 * 1024;
const CAPTURE_MAX_BYTES = 512 * 1024 * 1024 + 16 * 1024 * 1024;
const CAPTURE_MAX_OBJECTS = 100_003;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/** Private capture-namespaced file storage; blobs publish by atomic hard-link. */
export class FileWorkspaceSnapshotStorage implements WorkspaceSnapshotStorage {
  readonly #root: string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(rootDirectory: string) {
    this.#root = resolve(rootDirectory);
  }

  async putBlob(
    captureId: string,
    reference: string,
    body: ReadableStream<Uint8Array>,
    declaredSize: number | null,
  ): Promise<number> {
    this.#validateReference(captureId, reference);
    const namespace = this.#namespace(captureId);
    return this.#withCaptureLock(namespace, async () => {
      await mkdir(namespace, { recursive: true, mode: 0o700 });
      await this.#assertPrivateDirectory(namespace);
      const destination = join(namespace, reference);
      const existing = await this.#sizeIfPresent(destination);
      if (existing !== null) {
        const verified = await this.#verifyFile(
          destination,
          reference,
          OBJECT_MAX_BYTES,
        );
        await body.cancel();
        if (declaredSize !== null && declaredSize !== verified.size) {
          throw new Error(
            "Duplicate workspace blob has a different declared size",
          );
        }
        return verified.size;
      }
      const totals = await this.listBlobs(captureId);
      if (totals.length >= CAPTURE_MAX_OBJECTS) {
        await body.cancel();
        throw new Error("Workspace capture object quota exceeded");
      }
      const alreadyStored = totals.reduce((sum, blob) => sum + blob.size, 0);
      if (alreadyStored >= CAPTURE_MAX_BYTES) {
        await body.cancel();
        throw new Error("Workspace capture byte quota exceeded");
      }
      const maximum = Math.min(
        OBJECT_MAX_BYTES,
        CAPTURE_MAX_BYTES - alreadyStored,
      );
      const temporary = join(namespace, `.${reference}.${randomUUID()}.tmp`);
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const hash = createHash("sha256");
      const reader = body.getReader();
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (
            size > maximum ||
            (declaredSize !== null && size > declaredSize)
          ) {
            throw new Error(
              "Workspace blob exceeds its declared or actual byte limit",
            );
          }
          hash.update(part.value);
          let offset = 0;
          while (offset < part.value.byteLength) {
            const result = await handle.write(
              part.value,
              offset,
              part.value.byteLength - offset,
            );
            if (result.bytesWritten <= 0)
              throw new Error("Workspace blob write made no progress");
            offset += result.bytesWritten;
          }
        }
        if (declaredSize !== null && declaredSize !== size) {
          throw new Error(
            "Workspace blob content length did not match the declaration",
          );
        }
        if (hash.digest("hex") !== reference) {
          throw new Error("Workspace blob failed its SHA-256 content address");
        }
        if (alreadyStored + size > CAPTURE_MAX_BYTES) {
          throw new Error("Workspace capture byte quota exceeded");
        }
        await handle.sync();
        await handle.close();
        try {
          await link(temporary, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const winner = await this.#verifyFile(
            destination,
            reference,
            OBJECT_MAX_BYTES,
          );
          if (winner.size !== size)
            throw new Error("Immutable workspace blob size conflict");
        }
        await rm(temporary, { force: true });
        return size;
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        await handle.close().catch(() => {});
        await rm(temporary, { force: true });
        throw error;
      } finally {
        reader.releaseLock();
      }
    });
  }

  async getBlob(
    captureId: string,
    reference: string,
  ): Promise<StoredWorkspaceBlob | null> {
    this.#validateReference(captureId, reference);
    const path = join(this.#namespace(captureId), reference);
    try {
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink()) return null;
      return {
        size: file.size,
        body: Readable.toWeb(
          createReadStream(path),
        ) as unknown as ReadableStream<Uint8Array>,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listBlobs(
    captureId: string,
  ): Promise<readonly { reference: string; size: number }[]> {
    const namespace = this.#namespace(captureId);
    try {
      await this.#assertPrivateDirectory(namespace);
      const names = await readdir(namespace);
      if (names.length > CAPTURE_MAX_OBJECTS)
        throw new Error("Workspace capture object quota exceeded");
      const result: { reference: string; size: number }[] = [];
      for (const name of names) {
        if (!isDigest(name))
          throw new Error(
            "Workspace capture contains an unpublished temporary object",
          );
        const file = await lstat(join(namespace, name));
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          file.size > OBJECT_MAX_BYTES
        ) {
          throw new Error("Workspace capture contains an invalid blob object");
        }
        result.push({ reference: name, size: file.size });
      }
      if (
        result.reduce((sum, object) => sum + object.size, 0) > CAPTURE_MAX_BYTES
      ) {
        throw new Error("Workspace capture byte quota exceeded");
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #verifyFile(
    path: string,
    expectedReference: string,
    maxBytes: number,
  ): Promise<{ size: number }> {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size > maxBytes) {
      throw new Error("Existing workspace blob is not a bounded regular file");
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      size += chunk.byteLength;
      if (size > maxBytes)
        throw new Error("Existing workspace blob is oversized");
      hash.update(chunk);
    }
    if (size !== file.size || hash.digest("hex") !== expectedReference) {
      throw new Error(
        "Existing workspace blob failed content integrity verification",
      );
    }
    return { size };
  }

  async #sizeIfPresent(path: string): Promise<number | null> {
    try {
      return (await lstat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  #validateReference(captureId: string, reference: string): void {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(captureId) ||
      !isDigest(reference)
    ) {
      throw new Error("Invalid capture-scoped workspace blob identity");
    }
  }

  #namespace(captureId: string): string {
    return join(this.#root, sha256(captureId));
  }

  async #assertPrivateDirectory(path: string): Promise<void> {
    const root = await realpath(this.#root);
    const directory = await realpath(path);
    const rootStat = await lstat(root);
    const directoryStat = await lstat(directory);
    if (
      !rootStat.isDirectory() ||
      !directoryStat.isDirectory() ||
      (rootStat.mode & 0o077) !== 0 ||
      (directoryStat.mode & 0o077) !== 0 ||
      (directory !== root && !directory.startsWith(`${root}/`))
    ) {
      throw new Error(
        "Workspace snapshot storage escaped its private root or has unsafe permissions",
      );
    }
  }

  async #withCaptureLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const before = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = before.then(() => next);
    this.#locks.set(key, queued);
    await before;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}
