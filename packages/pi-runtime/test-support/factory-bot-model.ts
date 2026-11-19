import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

type Content =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: JsonObject };
/** Model transport only: commands cross the real tool registry, documents, tasks, HTTP, and Core storage. */
export function factoryBotTestModels() {
  const requests: {
    tools: string[];
    messages: Message[];
    discussion: boolean;
  }[] = [];
  let calls = 0;
  function stream(messages: Message[]) {
    const tools = new Set<string>();
    for (const message of messages)
      if (message.role === "system") {
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      }
    const discussion = JSON.stringify(
      messages.filter((message) => message.role === "system"),
    ).includes("focused Factory planning/review discussion");
    requests.push({ tools: [...tools].sort(), messages, discussion });
    const last = messages.filter((message) => message.role !== "system").at(-1);
    let content: Content[],
      stopReason: "stop" | "toolUse" = "stop";
    if (discussion)
      content = [
        {
          type: "text",
          text: "Review findings: verify the correlated report; acknowledgement is not execution. Evidence remains in Core.",
        },
      ];
    else if (last?.role === "toolResult") {
      const text = last.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        /* Error text is deliberately not JSON. */
      }
      content = [
        {
          type: "text",
          text: JSON.stringify({ error: last.isError ?? false, value }),
        },
      ];
    } else {
      let command: { tool?: string; args?: JsonObject } = {};
      if (last?.role === "user" && typeof last.content === "string") {
        try {
          command = JSON.parse(last.content);
        } catch {
          /* Reference-only workflow notification. */
        }
      }
      if (command.tool && command.args) {
        content = [
          {
            type: "toolCall",
            id: `call:${++calls}`,
            name: command.tool,
            arguments: command.args,
          },
        ];
        stopReason = "toolUse";
      } else
        content = [
          { type: "text", text: "Reference-only follow-up received." },
        ];
    }
    const result = createAssistantMessageEventStream();
    result.end({
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
    return result;
  }
  const provider = createProvider({
    id: "uzina-test",
    name: "Factory bot test transport",
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
        contextWindow: 100_000,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api: {
      stream(_model, context) {
        return stream(context.messages);
      },
      streamSimple(_model, context) {
        return stream(context.messages);
      },
    },
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, requests };
}
