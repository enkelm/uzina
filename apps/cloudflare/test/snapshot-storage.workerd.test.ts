import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "bun:test";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("capture-scoped R2 streaming adapter in Miniflare workerd", () => {
  test("streams and verifies bytes, rejects corrupt hashes, and isolates capture namespaces", async () => {
    const directory = await mkdtemp(join(import.meta.dir, "snapshot-r2-"));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "snapshot-storage-worker.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "R2 snapshot worker build failed",
      );
    }
    const miniflare = new Miniflare({
      name: "uzina-capture-scoped-r2",
      script: await build.outputs[0]!.text(),
      modules: true,
      compatibilityDate: "2026-05-01",
      r2Buckets: ["CHECKPOINTS"],
    });
    try {
      const bytes = new Uint8Array([0, 255, 4, 128, 10]);
      const reference = sha256(bytes);
      const upload = await miniflare.dispatchFetch(
        `http://uzina.test/upload/capture:one/${reference}`,
        {
          method: "PUT",
          headers: { "content-length": String(bytes.length) },
          body: bytes,
        },
      );
      const uploadBody = await upload.json();
      expect(upload.status).toBe(200);
      expect(uploadBody).toEqual({ size: bytes.length });
      const firstCapture = await miniflare.dispatchFetch(
        "http://uzina.test/list/capture:one",
      );
      expect(await firstCapture.json()).toEqual([
        { reference, size: bytes.length },
      ]);
      const foreignCapture = await miniflare.dispatchFetch(
        "http://uzina.test/list/capture:two",
      );
      expect(await foreignCapture.json()).toEqual([]);

      const corrupt = await miniflare.dispatchFetch(
        `http://uzina.test/upload/capture:one/${"f".repeat(64)}`,
        {
          method: "PUT",
          body: new Uint8Array([1, 2, 3]),
        },
      );
      expect(corrupt.status).toBe(500);
      expect(
        await (
          await miniflare.dispatchFetch("http://uzina.test/list/capture:one")
        ).json(),
      ).toEqual([{ reference, size: bytes.length }]);
      const oversized = await miniflare.dispatchFetch(
        `http://uzina.test/upload/capture:two/${"e".repeat(64)}`,
        {
          method: "PUT",
          headers: { "content-length": "3" },
          body: new Uint8Array([1, 2, 3, 4]),
        },
      );
      expect(oversized.status).toBe(500);
      expect(
        await (
          await miniflare.dispatchFetch("http://uzina.test/list/capture:two")
        ).json(),
      ).toEqual([]);
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
