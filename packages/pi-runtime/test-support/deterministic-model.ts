import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export function deterministicModels(answer = "deterministic answer") {
  let requests = 0;
  const provider = createProvider({
    id: "uzina-test",
    name: "Uzina deterministic test adapter",
    auth: {
      apiKey: {
        name: "test-only",
        async resolve() {
          return { auth: { apiKey: "not-a-credential" }, source: "test" };
        },
      },
    },
    models: [
      {
        id: "fixed-model",
        name: "Fixed model",
        provider: "uzina-test",
        api: "uzina-test-api",
        baseUrl: "https://test.invalid",
        input: ["text"],
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api: {
      stream() {
        requests += 1;
        const stream = createAssistantMessageEventStream();
        stream.end(response(answer));
        return stream;
      },
      streamSimple() {
        requests += 1;
        const stream = createAssistantMessageEventStream();
        stream.end(response(answer));
        return stream;
      },
    },
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, requests: () => requests };
}

function response(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "uzina-test-api",
    provider: "uzina-test",
    model: "fixed-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}
