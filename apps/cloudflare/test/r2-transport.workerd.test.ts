import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "bun:test";

describe("R2 checkpoint transport in real Miniflare workerd", () => {
  test("stores immutable content-addressed blobs and verifies reads", async () => {
    const directory = await mkdtemp(join(import.meta.dir, "r2-transport-"));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "r2-transport-worker.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "Could not bundle the R2 transport workerd Worker",
      );
    }
    const miniflare = new Miniflare({
      name: "uzina-r2-checkpoint-transport",
      script: await build.outputs[0]!.text(),
      modules: true,
      compatibilityDate: "2026-05-01",
      r2Buckets: ["CHECKPOINTS"],
    });
    try {
      const content = new Uint8Array([0, 255, 17, 0, 128]);
      const post = async () =>
        miniflare.dispatchFetch("http://uzina.test/put", {
          method: "POST",
          body: content,
        });
      const first = await post();
      const firstValue = (await first.json()) as { reference: string };
      expect(first.status).toBe(200);
      expect(firstValue.reference).toMatch(/^[a-f0-9]{64}$/);

      const duplicate = await post();
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual(firstValue);

      const overwrite = await miniflare.dispatchFetch(
        `http://uzina.test/overwrite/${firstValue.reference}`,
        { method: "POST" },
      );
      expect(await overwrite.json()).toEqual({ inserted: false });
      const fetched = await miniflare.dispatchFetch(
        `http://uzina.test/get/${firstValue.reference}`,
      );
      expect(fetched.status).toBe(200);
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(content);

      const missing = await miniflare.dispatchFetch(
        `http://uzina.test/get/${"0".repeat(64)}`,
      );
      expect(missing.status).toBe(500);
      expect(await missing.json()).toMatchObject({
        error: expect.stringContaining("unavailable"),
      });
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
