import type { JsonObject } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export function deterministicToolModels(options: {
  toolName: string;
  arguments: JsonObject;
  answer?: string;
  providerId?: string;
  modelId?: string;
}) {
  let requests = 0;
  const providerId = options.providerId ?? "uzina-test";
  const modelId = options.modelId ?? "fixed-model";
  const provider = createProvider({
    id: providerId,
    name: "Uzina deterministic tool test adapter",
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
        id: modelId,
        name: "Fixed model",
        provider: providerId,
        api: `${providerId}-api`,
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
        return responseStream(++requests, options, providerId, modelId);
      },
      streamSimple() {
        return responseStream(++requests, options, providerId, modelId);
      },
    },
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, requests: () => requests };
}

function responseStream(
  request: number,
  options: { toolName: string; arguments: JsonObject; answer?: string },
  providerId: string,
  modelId: string,
) {
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant",
    content:
      request === 1
        ? [
            {
              type: "toolCall",
              id: "call:remote-effect-1",
              name: options.toolName,
              arguments: options.arguments,
            },
          ]
        : [{ type: "text", text: options.answer ?? "remote tool settled" }],
    api: `${providerId}-api`,
    provider: providerId,
    model: modelId,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: request === 1 ? "toolUse" : "stop",
    timestamp: Date.now(),
  });
  return stream;
}
