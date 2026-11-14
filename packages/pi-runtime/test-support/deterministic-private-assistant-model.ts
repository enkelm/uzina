import type { JsonObject } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export type DeterministicPrivateAssistantModelOptions = {
  factoryThreadId?: string;
  factoryInputText?: string;
};

/** Deterministic provider adapter for owner-private assistant composition tests only. */
export function deterministicPrivateAssistantModels(
  options: DeterministicPrivateAssistantModelOptions = {},
) {
  const provider = createProvider({
    id: "uzina-test",
    name: "Private assistant deterministic test adapter",
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
      stream(_model, context) {
        return scriptedResponse(context.messages, options);
      },
      streamSimple(_model, context) {
        return scriptedResponse(context.messages, options);
      },
    },
  });
  const models = createModels();
  models.setProvider(provider);
  return models;
}

function scriptedResponse(
  messages: unknown[],
  options: DeterministicPrivateAssistantModelOptions,
) {
  const history = JSON.stringify(
    messages.filter((message) => {
      return (
        !message ||
        typeof message !== "object" ||
        !("role" in message) ||
        message.role !== "system"
      );
    }),
  );
  const ownerConversation = history.includes("OWNER-PRIVATE-COORDINATION");
  const workConversation = history.includes("BOUNDED-WORK-EFFECT");
  if (ownerConversation) {
    if (history.includes("factory_get_receipt")) {
      return message(
        [{ type: "text", text: "Private coordination finished." }],
        "stop",
      );
    }
    const uncertainMutation = findUncertainMutation(messages);
    if (uncertainMutation) {
      return message(
        [
          {
            type: "toolCall",
            id: "call:private-receipt",
            name: "factory_get_receipt",
            arguments: { requestId: uncertainMutation.requestId },
          },
        ],
        "toolUse",
      );
    }
    if (history.includes("factory_submit_input")) {
      return message(
        [{ type: "text", text: "Private coordination finished." }],
        "stop",
      );
    }
    if (history.includes("factory_list_projects")) {
      return message(
        [
          {
            type: "toolCall",
            id: "call:private-submit",
            name: "factory_submit_input",
            arguments: {
              threadId:
                options.factoryThreadId ?? "thread:private-assistant-proof",
              text: options.factoryInputText ?? "BOUNDED-WORK-EFFECT",
            },
          },
        ],
        "toolUse",
      );
    }
    return message(
      [
        {
          type: "toolCall",
          id: "call:private-list-projects",
          name: "factory_list_projects",
          arguments: { limit: 20 },
        },
      ],
      "toolUse",
    );
  }
  if (workConversation) {
    if (history.includes("remote_write_file")) {
      return message(
        [{ type: "text", text: "Workspace effect completed." }],
        "stop",
      );
    }
    return message(
      [
        {
          type: "toolCall",
          id: "call:work-write-file",
          name: "remote_write_file",
          arguments: {
            path: "private-assistant-result.txt",
            content: "effect from the assigned workspace",
          },
        },
      ],
      "toolUse",
    );
  }
  return message([{ type: "text", text: "No action required." }], "stop");
}

function findUncertainMutation(
  value: unknown,
): { requestId: string; threadId: string } | undefined {
  if (typeof value === "string") {
    try {
      return findUncertainMutation(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findUncertainMutation(item);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.status === "uncertain" &&
    typeof record.requestId === "string" &&
    typeof record.threadId === "string"
  ) {
    return { requestId: record.requestId, threadId: record.threadId };
  }
  for (const item of Object.values(record)) {
    const result = findUncertainMutation(item);
    if (result) return result;
  }
  return undefined;
}

function message(
  content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: JsonObject }
  >,
  stopReason: "stop" | "toolUse",
) {
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant",
    content,
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
    stopReason,
    timestamp: Date.now(),
  });
  return stream;
}
