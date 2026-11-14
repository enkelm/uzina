import { afterEach, describe, expect, test } from "bun:test";
import { createDaemonServer } from "../src/server";

const servers: ReturnType<typeof createDaemonServer>[] = [];

function startServer() {
  const server = createDaemonServer(0);
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("Bun daemon HTTP behavior", () => {
  test("rejects a non-loopback listener", () => {
    expect(() => createDaemonServer(0, "0.0.0.0")).toThrow(
      "Uzina daemon must bind to a loopback hostname",
    );
  });

  test("serves a versioned health response over HTTP", async () => {
    const server = startServer();
    const response = await fetch(new URL("/health", server.url));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ contractVersion: 1, status: "ok" });
  });

  test("accepts validated actor identities and rejects invalid documents", async () => {
    const server = startServer();
    const valid = await fetch(new URL("/identity", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: 1,
        kind: "assistant",
        assistantId: "assistant:factory",
        ownerId: "user:owner",
      }),
    });

    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      contractVersion: 1,
      actor: {
        contractVersion: 1,
        kind: "assistant",
        assistantId: "assistant:factory",
        ownerId: "user:owner",
      },
    });

    const invalid = await fetch(new URL("/identity", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractVersion: 1, kind: "human" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_identity" });
  });
});
