import {
  Sha256Stream,
  digestReadableStream,
} from "@uzina/checkpoints/portable";
import type { ManagedWorkCheckpointPrivateStorage } from "@uzina/core/managed-work-checkpoint-verification";
import type { R2WorkspaceBucket } from "./snapshot-storage";

const MAX_PRIVATE_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_PRIVATE_OBJECTS = 100_003;
const MAX_PRIVATE_BYTES = 512 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Immutable R2 storage scoped to one admitted checkpoint request. Keys contain
 * only a request hash and content digest; writes never clean up shared objects.
 */
export class R2ManagedWorkCheckpointStorage implements ManagedWorkCheckpointPrivateStorage {
  readonly #prefix: Promise<string>;
  #inventory: Map<string, number> | null = null;
  #inventoryBytes = 0;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly bucket: R2WorkspaceBucket,
    readonly requestId: string,
  ) {
    if (!REQUEST_ID.test(requestId)) {
      throw new Error("Invalid managed-work checkpoint request ID");
    }
    this.#prefix = hashText(requestId).then(
      (requestHash) => `managed-work-checkpoints/${requestHash}/`,
    );
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > MAX_PRIVATE_OBJECT_BYTES
    ) {
      throw new Error("Private checkpoint blob exceeds its byte limit");
    }
    const reference = digestBytes(bytes);
    return this.#withWriteLock(() => this.#putBlob(bytes, reference));
  }

  async #putBlob(bytes: Uint8Array, reference: string): Promise<string> {
    await this.#loadInventory();
    const existingSize = this.#inventory!.get(reference);
    if (existingSize !== undefined) {
      if (existingSize !== bytes.byteLength) {
        throw new Error(
          "Existing private checkpoint blob has a conflicting size",
        );
      }
      await this.#verifyExistingBlob(reference, bytes.byteLength);
      return reference;
    }
    if (
      this.#inventory!.size >= MAX_PRIVATE_OBJECTS ||
      this.#inventoryBytes + bytes.byteLength > MAX_PRIVATE_BYTES
    ) {
      throw new Error("Private checkpoint namespace quota exceeded");
    }
    const key = `${await this.#prefix}${reference}`;
    const fixedLengthFactory = (
      globalThis as typeof globalThis & {
        FixedLengthStream?: new (length: number) => {
          readable: ReadableStream<Uint8Array>;
          writable: WritableStream<Uint8Array>;
        };
      }
    ).FixedLengthStream;
    if (!fixedLengthFactory) {
      throw new Error(
        "Workerd FixedLengthStream is required for private R2 upload",
      );
    }
    const fixed = new fixedLengthFactory(bytes.byteLength);
    const writer = fixed.writable.getWriter();
    const putPromise = this.bucket.put(key, fixed.readable, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    const writePromise = (async () => {
      try {
        await writer.write(bytes);
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => {});
        throw error;
      } finally {
        writer.releaseLock();
      }
    })();
    const [putResult, writeResult] = await Promise.allSettled([
      putPromise,
      writePromise,
    ]);
    if (writeResult.status === "rejected") throw writeResult.reason;
    if (putResult.status === "rejected") throw putResult.reason;
    const inserted = putResult.value;
    if (inserted !== null) {
      this.#inventory!.set(reference, bytes.byteLength);
      this.#inventoryBytes += bytes.byteLength;
      return reference;
    }

    // A concurrent immutable writer may have won this content address. Refresh
    // the bounded listing before trusting it; never delete a shared object.
    await this.#refreshInventory();
    const winningSize = this.#inventory!.get(reference);
    if (winningSize === undefined) {
      throw new Error(
        "Private checkpoint blob disappeared after write conflict",
      );
    }
    if (winningSize !== bytes.byteLength) {
      throw new Error(
        "Existing private checkpoint blob has a conflicting size",
      );
    }
    await this.#verifyExistingBlob(reference, bytes.byteLength);
    return reference;
  }

  async getBlob(reference: string): Promise<Uint8Array> {
    const object = await this.getBlobStream(reference);
    if (!object) throw new Error("Private checkpoint blob is unavailable");
    const bytes = new Uint8Array(object.size);
    const reader = object.body.getReader();
    const hash = new Sha256Stream();
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.byteLength > object.size - total) {
          throw new Error("Private checkpoint blob exceeded its declared size");
        }
        bytes.set(part.value, total);
        hash.update(part.value);
        total += part.value.byteLength;
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (total !== object.size || hash.digest() !== reference) {
      throw new Error("Private checkpoint blob failed byte verification");
    }
    return bytes;
  }

  async getBlobStream(
    reference: string,
  ): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null> {
    this.#assertReference(reference);
    const object = await this.bucket.get(`${await this.#prefix}${reference}`);
    if (!object) return null;
    if (
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      object.size > MAX_PRIVATE_OBJECT_BYTES
    ) {
      await object.body.cancel().catch(() => {});
      throw new Error("Private checkpoint blob has an invalid size");
    }
    return object;
  }

  async listBlobs(): Promise<readonly { reference: string; size: number }[]> {
    return this.#listBlobs();
  }

  async #listBlobs(): Promise<readonly { reference: string; size: number }[]> {
    const prefix = await this.#prefix;
    const result: Array<{ reference: string; size: number }> = [];
    let cursor: string | undefined;
    let totalBytes = 0;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) {
        const reference = object.key.slice(prefix.length);
        if (
          !SHA256.test(reference) ||
          object.key !== `${prefix}${reference}` ||
          !Number.isSafeInteger(object.size) ||
          object.size < 0 ||
          object.size > MAX_PRIVATE_OBJECT_BYTES
        ) {
          throw new Error(
            "Private checkpoint namespace contains an invalid object",
          );
        }
        result.push({ reference, size: object.size });
        if (result.length > MAX_PRIVATE_OBJECTS) {
          throw new Error(
            "Private checkpoint namespace exceeds its object limit",
          );
        }
        totalBytes += object.size;
        if (totalBytes > MAX_PRIVATE_BYTES) {
          throw new Error(
            "Private checkpoint namespace exceeds its byte limit",
          );
        }
      }
      if (page.truncated && !page.cursor) {
        throw new Error(
          "R2 private checkpoint listing has no continuation cursor",
        );
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return result.sort((left, right) =>
      left.reference.localeCompare(right.reference),
    );
  }

  async #loadInventory(): Promise<void> {
    if (this.#inventory !== null) return;
    await this.#refreshInventory();
  }

  async #refreshInventory(): Promise<void> {
    const blobs = await this.#listBlobs();
    this.#inventory = new Map(
      blobs.map(({ reference, size }) => [reference, size]),
    );
    this.#inventoryBytes = blobs.reduce((sum, { size }) => sum + size, 0);
  }

  async #verifyExistingBlob(
    reference: string,
    expectedSize: number,
  ): Promise<void> {
    const existing = await this.getBlobStream(reference);
    if (!existing) {
      throw new Error("Private checkpoint blob disappeared after listing");
    }
    const integrity = await digestReadableStream(
      existing.body,
      MAX_PRIVATE_OBJECT_BYTES,
    );
    if (
      existing.size !== expectedSize ||
      integrity.size !== expectedSize ||
      integrity.reference !== reference
    ) {
      throw new Error("Existing private checkpoint blob failed verification");
    }
  }

  async #withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#writeTail;
    let release!: () => void;
    this.#writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #assertReference(reference: string): void {
    if (!SHA256.test(reference)) {
      throw new Error("Private checkpoint reference is not a SHA-256 digest");
    }
  }
}

function digestBytes(bytes: Uint8Array): string {
  const hash = new Sha256Stream();
  hash.update(bytes);
  return hash.digest();
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
