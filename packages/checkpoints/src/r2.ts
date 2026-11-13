import type { BlobTransport } from "./index";

/** Minimal structural shape implemented by Cloudflare's R2Bucket. */
export interface ImmutableR2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<unknown | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Immutable SHA-256 BlobTransport backed by an R2-compatible bucket. */
export class R2BlobTransport implements BlobTransport {
  constructor(private readonly bucket: ImmutableR2Bucket) {}

  async putBlob(bytes: Uint8Array): Promise<string> {
    const reference = await sha256(bytes);
    const inserted = await this.bucket.put(reference, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (inserted !== null) return reference;
    const existing = await this.bucket.get(reference);
    if (!existing) {
      throw new Error(
        `Immutable R2 blob ${reference} disappeared after conflict`,
      );
    }
    const stored = new Uint8Array(await existing.arrayBuffer());
    if ((await sha256(stored)) !== reference) {
      throw new Error(
        `Immutable R2 blob ${reference} failed content verification`,
      );
    }
    return reference;
  }

  async getBlob(reference: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(reference)) {
      throw new Error("R2 blob reference is not a SHA-256 digest");
    }
    const object = await this.bucket.get(reference);
    if (!object) throw new Error(`R2 blob ${reference} is unavailable`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256(bytes)) !== reference) {
      throw new Error(`R2 blob integrity mismatch for ${reference}`);
    }
    return bytes;
  }
}
