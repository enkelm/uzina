import { describe, expect, test } from "bun:test";
import { R2ManagedWorkCheckpointStorage } from "../src/managed-work-checkpoint-storage";
import type { R2WorkspaceBucket } from "../src/snapshot-storage";

function bucketWithListing(sizes: readonly number[]): R2WorkspaceBucket {
  return {
    async put() {
      return {};
    },
    async get() {
      return null;
    },
    async delete() {},
    async list({ prefix }) {
      return {
        objects: sizes.map((size, index) => ({
          key: `${prefix}${index.toString(16).padStart(64, "0")}`,
          size,
        })),
        truncated: false,
      };
    },
  };
}

describe("R2 managed-work checkpoint storage quotas", () => {
  test("rejects an oversized private object from bounded metadata alone", async () => {
    const storage = new R2ManagedWorkCheckpointStorage(
      bucketWithListing([32 * 1024 * 1024 + 1]),
      "checkpoint:quota-object",
    );
    await expect(storage.listBlobs()).rejects.toThrow(
      "Private checkpoint namespace contains an invalid object",
    );
  });

  test("rejects aggregate private quota without materializing blob bodies", async () => {
    const storage = new R2ManagedWorkCheckpointStorage(
      bucketWithListing(Array.from({ length: 17 }, () => 32 * 1024 * 1024)),
      "checkpoint:quota-total",
    );
    await expect(storage.listBlobs()).rejects.toThrow(
      "Private checkpoint namespace exceeds its byte limit",
    );
  });

  test("checks aggregate quota before writing a new content address", async () => {
    const storage = new R2ManagedWorkCheckpointStorage(
      bucketWithListing(Array.from({ length: 16 }, () => 32 * 1024 * 1024)),
      "checkpoint:quota-write",
    );
    await expect(storage.putBlob(new Uint8Array([1]))).rejects.toThrow(
      "Private checkpoint namespace quota exceeded",
    );
  });
});
