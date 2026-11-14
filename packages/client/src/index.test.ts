import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION } from "@uzina/contracts";
import { FactoryClient } from "./index";

describe("authenticated Factory client", () => {
  test("binds credentials to one origin and refuses credential-bearing redirect behavior", async () => {
    expect(
      () =>
        new FactoryClient({
          baseUrl: "https://user:pass@factory.test/",
          credential: "token",
        }),
    ).toThrow();
    expect(
      () =>
        new FactoryClient({
          baseUrl: "https://factory.test/api",
          credential: "token",
        }),
    ).toThrow();

    let requestInit: RequestInit | undefined;
    const client = new FactoryClient({
      baseUrl: "https://factory.test/",
      credential: "assistant-private-token",
      fetch: async (_input, init) => {
        requestInit = init;
        return new Response(
          JSON.stringify({ contractVersion: CONTRACT_VERSION, projects: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    expect(await client.listProjects()).toEqual({
      contractVersion: 1,
      projects: [],
    });
    expect(requestInit?.redirect).toBe("error");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer assistant-private-token",
    );

    const redirected = new Response("{}", { status: 200 });
    Object.defineProperties(redirected, {
      redirected: { value: true },
      url: { value: "https://other.example/v1/projects" },
    });
    const redirectClient = new FactoryClient({
      baseUrl: "https://factory.test/",
      credential: "assistant-private-token",
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("error");
        return redirected;
      },
    });
    await expect(redirectClient.listProjects()).rejects.toMatchObject({
      status: 502,
      code: "cross_origin_redirect_refused",
    });
  });

  test("runtime-decodes responses and preserves cancellation metadata", async () => {
    const invalid = new FactoryClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "valid-token",
      fetch: async () =>
        new Response(JSON.stringify({ contractVersion: 1, projects: [{}] }), {
          status: 200,
        }),
    });
    await expect(invalid.listProjects()).rejects.toMatchObject({
      status: 502,
      code: "invalid_response",
    });

    const controller = new AbortController();
    const aborted = new DOMException("Cancelled", "AbortError");
    const cancellable = new FactoryClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "valid-token",
      fetch: async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        throw aborted;
      },
    });
    await expect(
      cancellable.listProjects({ signal: controller.signal }),
    ).rejects.toBe(aborted);
  });

  test("decodes UTF-8 correctly when a streamed response splits a multibyte character", async () => {
    const responseText = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      projects: [
        {
          contractVersion: CONTRACT_VERSION,
          projectId: "project:emoji",
          name: "Factory 🍕",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    const bytes = new TextEncoder().encode(responseText);
    const emojiStart = new TextEncoder().encode(
      responseText.slice(0, responseText.indexOf("🍕")),
    ).byteLength;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(bytes.subarray(0, emojiStart + 2));
          controller.enqueue(bytes.subarray(emojiStart + 2));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const client = new FactoryClient({
      baseUrl: "https://factory.test",
      credential: "valid-token",
      fetch: async () => new Response(body, { status: 200 }),
    });

    await expect(client.listProjects()).resolves.toMatchObject({
      projects: [{ name: "Factory 🍕" }],
    });
  });

  test("cancels an oversized streamed response at the actual byte cap", async () => {
    const prefix = new TextEncoder().encode(
      JSON.stringify({ contractVersion: CONTRACT_VERSION, projects: [] }),
    );
    const padding = new Uint8Array(128 * 1024).fill(0x20);
    const chunks = [prefix, padding, padding, padding];
    let nextChunk = 0;
    let cancellationReason: unknown;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[nextChunk++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel(reason) {
          cancellationReason = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const client = new FactoryClient({
      baseUrl: "https://factory.test",
      credential: "valid-token",
      fetch: async () => new Response(body, { status: 200 }),
    });

    await expect(client.listProjects()).rejects.toMatchObject({
      status: 502,
      code: "response_too_large",
    });
    expect(cancellationReason).toMatchObject({
      status: 502,
      code: "response_too_large",
    });
    expect(nextChunk).toBeLessThan(chunks.length);
    expect(body.locked).toBe(false);
  });

  test("preserves the original AbortError raised while reading a response body", async () => {
    const aborted = new DOMException("Body stream aborted", "AbortError");
    const prefix = new TextEncoder().encode('{"contractVersion":1,');
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(prefix);
          else controller.error(aborted);
        },
      },
      { highWaterMark: 0 },
    );
    const client = new FactoryClient({
      baseUrl: "https://factory.test",
      credential: "valid-token",
      fetch: async () => new Response(body, { status: 200 }),
    });

    await expect(client.listProjects()).rejects.toBe(aborted);
    expect(body.locked).toBe(false);
  });

  test("input mutation requires and sends the same stable application request ID", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const receipt = {
      contractVersion: 1,
      status: "accepted",
      requestId: "request:one-stable-id",
      jobId: "job:receipt",
      threadId: "thread:target",
      target: { nodeId: "node:target", workspaceId: "workspace:target" },
      ownershipGeneration: 0,
      dispatchStatus: "unavailable",
      acceptedAt: "2026-06-01T00:00:00.000Z",
    };
    const client = new FactoryClient({
      baseUrl: "https://factory.test",
      credential: "named-assistant-token",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify(receipt), { status: 202 });
      },
    });
    const returned = await client.submitInput(
      "thread:target",
      "request:one-stable-id",
      "perform bounded work",
    );
    expect(returned.requestId).toBe("request:one-stable-id");
    expect(requests[0]?.url).toBe(
      "https://factory.test/v1/threads/thread%3Atarget/inputs",
    );
    expect(requests[0]?.body).toEqual({
      requestId: "request:one-stable-id",
      text: "perform bounded work",
    });
  });
});
