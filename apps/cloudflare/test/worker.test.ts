import { describe, expect, test } from "bun:test";
import worker, { type WorkerEnvironment } from "../src/worker";

describe("Cloudflare Worker router", () => {
  test("serves its versioned health response without constructing a Durable Object", async () => {
    const response = await worker.fetch(
      new Request("https://uzina.test/health"),
      {} as WorkerEnvironment,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contractVersion: 1, status: "ok" });
  });
});
