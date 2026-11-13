import type { Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const model = {
  id: "fixed-model",
  name: "Deterministic failing test model",
  provider: "uzina-test-failure",
  api: "uzina-test-failure-api",
  baseUrl: "https://test.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 4096,
  maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Test-only model-provider failure at the real Pi model-stream boundary. */
export function deterministicFailingModels(): Models {
  const failure = () => {
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "deterministic provider failure",
      timestamp: Date.now(),
    });
    return stream;
  };
  return {
    getModel(provider: string, id: string) {
      return provider === model.provider && id === model.id ? model : undefined;
    },
    async getAuth() {
      return undefined;
    },
    stream: failure,
    streamSimple: failure,
  } as unknown as Models;
}
