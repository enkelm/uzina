import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "bun:test";

const MAX_RESPONSE_BYTES = 256 * 1024;
const CHUNK_BYTES = 16 * 1024;
const OVERSIZED_REMAINDER_CHUNKS = 64;

type FactoryHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
type ResponseProbe = {
  request: {
    url: string;
    method: string;
    authorization: string;
    fixtureHeader: string;
  };
  pullCalls: number;
  producedBytes: number;
  totalBytes: number;
  totalChunks: number;
  cancelled: boolean;
  bodyLocked: boolean;
};

async function wrappedRequest(
  miniflare: Miniflare,
  path: string,
  options: { method?: "GET" | "POST"; body?: string } = {},
) {
  return miniflare.dispatchFetch(`http://factory-http.test${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: "Bearer disposable-fixture-token",
      "x-fixture": "preserved",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

async function responseProbe(
  miniflare: Miniflare,
  name: string,
): Promise<ResponseProbe> {
  const response = await miniflare.dispatchFetch(
    `http://factory-http.test/__response-probe/${name}`,
  );
  return (await response.json()) as ResponseProbe;
}

describe("Factory HTTP Durable Object RPC response bounds in workerd", () => {
  test("streams through the byte cap, preserves UTF-8, and cancels oversized bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-factory-http-rpc-"));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "factory-http-rpc-entry.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      external: ["cloudflare:workers"],
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "Could not bundle the Factory HTTP RPC test Worker",
      );
    }
    const miniflare = new Miniflare({
      name: "factory-http-rpc",
      script: await build.outputs[0]!.text(),
      modules: true,
      compatibilityDate: "2026-05-01",
      bindings: { UZINA_BOOTSTRAP_SECRET: "workerd-factory-http-fixture" },
      durableObjects: {
        FACTORY: { className: "FactoryHttpRpcProbeObject", useSQLite: true },
      },
    });
    try {
      await miniflare.ready;
      const limitText = `{"value":"${"a".repeat(MAX_RESPONSE_BYTES - 15)}€"}`;
      expect(new TextEncoder().encode(limitText).byteLength).toBe(
        MAX_RESPONSE_BYTES,
      );
      const cases = [
        { name: "empty", expected: "", status: 201, method: "GET" },
        {
          name: "small",
          expected: '{"value":"café"}',
          status: 201,
          method: "POST",
        },
        {
          name: "at-limit",
          expected: limitText,
          status: 202,
          method: "GET",
        },
      ] as const;
      for (const item of cases) {
        const inputBody =
          item.method === "POST" ? '{"request":"fixture"}' : undefined;
        const wrapped = await wrappedRequest(
          miniflare,
          `/__factory-http/${item.name}`,
          {
            method: item.method,
            ...(inputBody === undefined ? {} : { body: inputBody }),
          },
        );
        expect(wrapped.status).toBe(200);
        const result = (await wrapped.json()) as FactoryHttpResponse;
        expect(result.status).toBe(item.status);
        expect(result.body).toBe(item.expected);
        expect(result.headers["x-fixture-response"]).toBe(item.name);
        const probe = await responseProbe(miniflare, item.name);
        expect(probe.request).toEqual({
          url: `https://uzina-factory.internal/v1/test-response/${item.name}`,
          method: item.method,
          authorization: "Bearer disposable-fixture-token",
          fixtureHeader: "preserved",
        });
        expect(probe.producedBytes).toBe(
          new TextEncoder().encode(item.expected).byteLength,
        );
        expect(probe.cancelled).toBe(false);
      }

      const oversizedResponse = await wrappedRequest(
        miniflare,
        "/__factory-http/oversized",
      );
      expect(oversizedResponse.status).toBe(200);
      const oversized = (await oversizedResponse.json()) as FactoryHttpResponse;
      expect(oversized).toEqual({
        status: 502,
        headers: { "content-type": "application/json" },
        body: '{"error":"response_too_large"}',
      });
      const oversizedProbe = await responseProbe(miniflare, "oversized");
      expect({
        pullCalls: oversizedProbe.pullCalls,
        producedBytes: oversizedProbe.producedBytes,
        totalBytes: oversizedProbe.totalBytes,
        totalChunks: oversizedProbe.totalChunks,
        cancelled: oversizedProbe.cancelled,
        bodyLocked: oversizedProbe.bodyLocked,
      }).toEqual({
        pullCalls: MAX_RESPONSE_BYTES / CHUNK_BYTES + 1,
        producedBytes: MAX_RESPONSE_BYTES + 1,
        totalBytes:
          MAX_RESPONSE_BYTES + 1 + OVERSIZED_REMAINDER_CHUNKS * CHUNK_BYTES,
        totalChunks:
          MAX_RESPONSE_BYTES / CHUNK_BYTES + 1 + OVERSIZED_REMAINDER_CHUNKS,
        cancelled: true,
        bodyLocked: false,
      });

      const readFailure = await wrappedRequest(
        miniflare,
        "/__factory-http/read-error",
      );
      expect(readFailure.status).toBe(500);
      expect(await readFailure.json()).toMatchObject({
        error: expect.stringContaining("fixture response stream failed"),
      });
      expect((await responseProbe(miniflare, "read-error")).bodyLocked).toBe(
        false,
      );
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
