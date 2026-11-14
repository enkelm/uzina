import type {
  StoredWorkspaceBlob,
  WorkspaceSnapshotStorage,
} from "@uzina/core/snapshot-storage";
import { Sha256Stream } from "@uzina/checkpoints/portable";

export interface R2WorkspaceBucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<unknown | null>;
  get(key: string): Promise<{
    size: number;
    body: ReadableStream<Uint8Array>;
  } | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 512 * 1024 * 1024 + 16 * 1024 * 1024;
const MAX_CAPTURE_OBJECTS = 100_003;

async function hashText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** R2 adapter with capture-hash namespaces and streaming SHA-256 verification. */
export class R2WorkspaceSnapshotStorage implements WorkspaceSnapshotStorage {
  readonly #locks = new Map<string, Promise<void>>();

  constructor(private readonly bucket: R2WorkspaceBucket) {}

  async putBlob(
    captureId: string,
    reference: string,
    body: ReadableStream<Uint8Array>,
    declaredSize: number | null,
  ): Promise<number> {
    this.#assertIdentity(captureId, reference);
    return this.#withCaptureLock(captureId, async () => {
      if (declaredSize === null) {
        await body.cancel();
        throw new Error(
          "R2 streaming uploads require a bounded Content-Length",
        );
      }
      if (
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 0 ||
        declaredSize > MAX_OBJECT_BYTES
      ) {
        await body.cancel();
        throw new Error("Workspace blob declaration exceeds its byte limit");
      }
      const key = `${await this.#prefix(captureId)}${reference}`;
      const prior = await this.bucket.get(key);
      if (prior) {
        await body.cancel();
        const verified = await this.#verify(
          prior.body,
          reference,
          prior.size,
          MAX_OBJECT_BYTES,
        );
        if (verified.size !== declaredSize) {
          throw new Error(
            "Existing immutable workspace blob has a conflicting size",
          );
        }
        return verified.size;
      }
      const current = await this.listBlobs(captureId);
      if (current.length >= MAX_CAPTURE_OBJECTS) {
        await body.cancel();
        throw new Error("Workspace capture object quota exceeded");
      }
      const alreadyStored = current.reduce(
        (sum, object) => sum + object.size,
        0,
      );
      const maximum = Math.min(
        MAX_OBJECT_BYTES,
        MAX_CAPTURE_BYTES - alreadyStored,
      );
      if (
        maximum < 0 ||
        alreadyStored >= MAX_CAPTURE_BYTES ||
        declaredSize > maximum
      ) {
        await body.cancel();
        throw new Error("Workspace capture byte quota exceeded");
      }
      const fixedLengthFactory = (
        globalThis as typeof globalThis & {
          FixedLengthStream?: new (length: number) => {
            readable: ReadableStream<Uint8Array>;
            writable: WritableStream<Uint8Array>;
          };
        }
      ).FixedLengthStream;
      if (!fixedLengthFactory) {
        await body.cancel();
        throw new Error(
          "Workerd FixedLengthStream is required for bounded R2 upload",
        );
      }
      const fixed = new fixedLengthFactory(declaredSize);
      const reader = body.getReader();
      const writer = fixed.writable.getWriter();
      let total = 0;
      const hash = new Sha256Stream();
      const pump = (async () => {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > maximum || total > declaredSize) {
              throw new Error(
                "Workspace blob exceeded its declared transfer size",
              );
            }
            hash.update(part.value);
            await writer.write(part.value);
          }
          if (total !== declaredSize) {
            throw new Error("Workspace blob content length mismatch");
          }
          if (hash.digest() !== reference) {
            throw new Error("Workspace blob SHA-256 mismatch");
          }
          await writer.close();
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          await writer.abort(error).catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      })();
      const putPromise = this.bucket.put(key, fixed.readable, {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      const [putResult, pumpResult] = await Promise.allSettled([
        putPromise,
        pump,
      ]);
      if (pumpResult.status === "rejected") {
        await reader.cancel(pumpResult.reason).catch(() => {});
        await this.bucket.delete(key);
        throw pumpResult.reason;
      }
      if (putResult.status === "rejected") {
        await this.bucket.delete(key);
        throw putResult.reason;
      }
      const inserted = putResult.value;
      if (inserted === null) {
        const winner = await this.bucket.get(key);
        if (!winner)
          throw new Error(
            "Immutable R2 workspace blob disappeared after conflict",
          );
        const verified = await this.#verify(
          winner.body,
          reference,
          winner.size,
          MAX_OBJECT_BYTES,
        );
        if (verified.size !== declaredSize) {
          throw new Error("Immutable R2 workspace blob has a conflicting size");
        }
        return verified.size;
      }
      if (alreadyStored + total > MAX_CAPTURE_BYTES) {
        await this.bucket.delete(key);
        throw new Error("Workspace capture byte quota exceeded");
      }
      return total;
    });
  }

  async getBlob(
    captureId: string,
    reference: string,
  ): Promise<StoredWorkspaceBlob | null> {
    this.#assertIdentity(captureId, reference);
    const object = await this.bucket.get(
      `${await this.#prefix(captureId)}${reference}`,
    );
    return object ? { size: object.size, body: object.body } : null;
  }

  async listBlobs(
    captureId: string,
  ): Promise<readonly { reference: string; size: number }[]> {
    const prefix = await this.#prefix(captureId);
    const result: { reference: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) {
        const reference = object.key.slice(prefix.length);
        if (
          !/^[a-f0-9]{64}$/.test(reference) ||
          object.key !== `${prefix}${reference}`
        ) {
          throw new Error(
            "R2 capture namespace contains an unrecognized object key",
          );
        }
        if (
          !Number.isSafeInteger(object.size) ||
          object.size < 0 ||
          object.size > MAX_OBJECT_BYTES
        ) {
          throw new Error(
            "R2 capture namespace contains an invalid object size",
          );
        }
        result.push({ reference, size: object.size });
        if (result.length > MAX_CAPTURE_OBJECTS)
          throw new Error("Workspace capture object quota exceeded");
      }
      if (page.truncated && !page.cursor)
        throw new Error("R2 capture listing has no continuation cursor");
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (
      result.reduce((sum, object) => sum + object.size, 0) > MAX_CAPTURE_BYTES
    ) {
      throw new Error("Workspace capture byte quota exceeded");
    }
    return result;
  }

  async #prefix(captureId: string): Promise<string> {
    return `workspace-snapshots/${await hashText(captureId)}/`;
  }

  #assertIdentity(captureId: string, reference: string): void {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(captureId) ||
      !/^[a-f0-9]{64}$/.test(reference)
    ) {
      throw new Error("Invalid capture-scoped R2 workspace blob identity");
    }
  }

  async #withCaptureLock<T>(
    captureId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const before = this.#locks.get(captureId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = before.then(() => gate);
    this.#locks.set(captureId, queued);
    await before;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(captureId) === queued) this.#locks.delete(captureId);
    }
  }

  async #verify(
    stream: ReadableStream<Uint8Array>,
    expected: string,
    declaredSize: number,
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
        if (size > maxBytes)
          throw new Error("R2 workspace blob exceeds its byte limit");
        hash.update(part.value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const reference = hash.digest();
    if (size !== declaredSize || reference !== expected) {
      throw new Error("R2 workspace blob content integrity mismatch");
    }
    return { reference, size };
  }
}
