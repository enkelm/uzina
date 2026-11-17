import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { redactProviderErrors } from "../src/provider-errors";
import {
  createConfiguredModels,
  readManagedModelConfig,
} from "../src/provider";
import {
  createWorkerConfiguredModels,
  createWorkerManagedRuntimeOptions,
} from "../src/worker-provider";

describe("managed provider configuration", () => {
  test("fails closed when any selected provider, model or API credential is missing", async () => {
    expect(() =>
      readManagedModelConfig({ UZINA_MODEL_PROVIDER: "openai" }),
    ).toThrow("UZINA_MODEL_PROVIDER, UZINA_MODEL_ID, and UZINA_MODEL_API_KEY");
    expect(() =>
      readManagedModelConfig({
        UZINA_MODEL_PROVIDER: "openai",
        UZINA_MODEL_ID: "gpt-4o-mini",
      }),
    ).toThrow("UZINA_MODEL_API_KEY");
    await expect(
      createConfiguredModels({
        provider: "",
        modelId: "gpt-4o-mini",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("provider, model ID, and API key are required");
    await expect(
      createConfiguredModels({
        provider: "unknown-provider",
        modelId: "unknown-model",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("provider is not supported");
    await expect(
      createWorkerConfiguredModels({
        provider: "unknown-provider",
        modelId: "unknown-model",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("other providers are unsupported");
  });

  test("resolves multiple Worker credentials without machine environment discovery", async () => {
    const options = await createWorkerManagedRuntimeOptions({
      UZINA_PROVIDER_CREDENTIALS: JSON.stringify({
        openai: { type: "api_key", key: "worker-openai-dummy" },
        anthropic: { type: "api_key", key: "worker-anthropic-dummy" },
      }),
    });
    expect(options.agent.model).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    expect((await options.models.getAuth("anthropic"))?.auth.apiKey).toBe(
      "worker-anthropic-dummy",
    );
    expect(options.models.getProvider("google")).toBeUndefined();
    await expect(
      createWorkerManagedRuntimeOptions({
        UZINA_PROVIDER_CREDENTIALS:
          '{"openai":{"type":"oauth","access":"not-a-worker-key"}}',
      }),
    ).rejects.toThrow("OAuth remains local-only");
    await expect(
      createWorkerManagedRuntimeOptions({
        UZINA_PROVIDER_CREDENTIALS: "not-json",
      }),
    ).rejects.toThrow("JSON provider credential map");
  });

  test("redacts an echoed configured key from local OpenAI SDK errors", async () => {
    const apiKey = "sk-test-local-provider-redaction-dummy";
    const invalidKeyBody = JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${apiKey}. You can find your API key at https://platform.openai.com/account/api-keys.`,
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    });
    const observedRequests: Array<{
      url: string;
      authorization: string;
      body: string;
    }> = [];
    const unexpectedRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== "https://api.openai.com" ||
        url.pathname !== "/v1/responses"
      ) {
        unexpectedRequests.push(url.toString());
        return new Response("Unexpected outbound request", { status: 599 });
      }
      observedRequests.push({
        url: url.toString(),
        authorization: request.headers.get("authorization") ?? "",
        body: await request.clone().text(),
      });
      return new Response(invalidKeyBody, {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const models = await createConfiguredModels({
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey,
      });
      const model = models.getModel("openai", "gpt-4o-mini");
      expect(model).toBeDefined();
      const context = {
        messages: [
          {
            role: "user" as const,
            content: "Return a short answer.",
            timestamp: Date.now(),
          },
        ],
      };
      const result = await models.completeSimple(model!, context);
      const stream = models.streamSimple(model!, context);
      const events = [];
      for await (const event of stream) events.push(event);
      const streamedResult = await stream.result();
      const errorEvents = events.filter((event) => event.type === "error");

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("401");
      expect(result.errorMessage).not.toContain(apiKey);
      expect(result.errorMessage).not.toContain(`Bearer ${apiKey}`);
      expect(JSON.stringify(result)).not.toContain(apiKey);
      expect(JSON.stringify(result)).not.toContain(`Bearer ${apiKey}`);
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: "error",
        error: {
          stopReason: "error",
          errorMessage: expect.stringContaining("401"),
        },
      });
      expect(JSON.stringify(errorEvents)).not.toContain(apiKey);
      expect(JSON.stringify(errorEvents)).not.toContain(`Bearer ${apiKey}`);
      expect(streamedResult.stopReason).toBe("error");
      expect(JSON.stringify(streamedResult)).not.toContain(apiKey);
      expect(JSON.stringify(streamedResult)).not.toContain(`Bearer ${apiKey}`);
      expect(observedRequests).toHaveLength(2);
      expect(
        observedRequests.every(
          (request) =>
            request.url === "https://api.openai.com/v1/responses" &&
            request.authorization === `Bearer ${apiKey}` &&
            !request.body.includes(apiKey),
        ),
      ).toBe(true);
      expect(unexpectedRequests).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("settles a sanitized provider result when the source iterator throws", async () => {
    const apiKey = "sk-test-stream-failure-dummy";
    const provider = openaiProvider();
    const model = provider
      .getModels()
      .find((candidate) => candidate.id === "gpt-4o-mini");
    expect(model).toBeDefined();
    class ThrowingStream extends AssistantMessageEventStream {
      override async *[Symbol.asyncIterator](): AsyncGenerator<
        AssistantMessageEvent,
        void,
        unknown
      > {
        throw new Error(`source stream failed with ${apiKey}`);
      }
    }
    provider.streamSimple = () => new ThrowingStream();
    const protectedProvider = redactProviderErrors(provider);
    const context = { messages: [] } as unknown as Parameters<
      typeof provider.streamSimple
    >[1];
    const failedStream = protectedProvider.streamSimple(model!, context, {
      apiKey,
    });
    const events = [];
    for await (const event of failedStream) events.push(event);
    const result = await failedStream.result();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "error" });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("source stream failed");
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  test("preserves abort signaling while settling a source failure as aborted", async () => {
    const apiKey = "sk-test-abort-stream-dummy";
    const provider = openaiProvider();
    const model = provider
      .getModels()
      .find((candidate) => candidate.id === "gpt-4o-mini");
    expect(model).toBeDefined();
    class ThrowingStream extends AssistantMessageEventStream {
      override async *[Symbol.asyncIterator](): AsyncGenerator<
        AssistantMessageEvent,
        void,
        unknown
      > {
        throw new Error(`aborted source failed with ${apiKey}`);
      }
    }
    const controller = new AbortController();
    let sourceSignal: AbortSignal | undefined;
    provider.streamSimple = (_model, _context, options) => {
      sourceSignal = options?.signal;
      return new ThrowingStream();
    };
    const protectedProvider = redactProviderErrors(provider, apiKey);
    const context = { messages: [] } as unknown as Parameters<
      typeof provider.streamSimple
    >[1];
    const abortedStream = protectedProvider.streamSimple(model!, context, {
      signal: controller.signal,
    });
    controller.abort();
    const events = [];
    for await (const event of abortedStream) events.push(event);
    const result = await abortedStream.result();

    expect(sourceSignal).toBe(controller.signal);
    expect(events).toMatchObject([
      { type: "error", reason: "aborted", error: { stopReason: "aborted" } },
    ]);
    expect(result.stopReason).toBe("aborted");
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  test("resolves a real Pi AI catalog model and credential without making a paid request", async () => {
    const config = readManagedModelConfig({
      UZINA_MODEL_PROVIDER: "openai",
      UZINA_MODEL_ID: "gpt-4o-mini",
      UZINA_MODEL_API_KEY: "test-only-not-a-credential",
    });
    const models = await createConfiguredModels(config);
    const model = models.getModel(config.provider, config.modelId);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-4o-mini",
    });
    expect(await models.getAuth(model!)).toBeDefined();
  });
});
