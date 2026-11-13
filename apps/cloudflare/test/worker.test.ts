import { describe, expect, test } from "bun:test";
import worker from "../src";

describe("Cloudflare Worker HTTP behavior", () => {
  test("serves a versioned health response", async () => {
    const response = await worker.fetch(
      new Request("https://uzina.test/health"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contractVersion: 1, status: "ok" });
  });

  test("validates the declared actor identity at the HTTP boundary", async () => {
    const response = await worker.fetch(
      new Request("https://uzina.test/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractVersion: 1,
          kind: "node",
          nodeId: "node:laptop-b",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      contractVersion: 1,
      actor: {
        contractVersion: 1,
        kind: "node",
        nodeId: "node:laptop-b",
      },
    });

    const invalid = await worker.fetch(
      new Request("https://uzina.test/identity", {
        method: "POST",
        body: JSON.stringify({ contractVersion: 1, kind: "unknown" }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_identity" });
  });
});
