import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  Context,
  AssistantMessage,
  ToolCall,
  JsonObject,
} from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Controlled model responses only. Production Pi sessions, tools, HTTP and journals still execute. */
export function nativeWorkerModel(directory: string) {
  let requests = 0;
  const respond = (_model: unknown, context: Context) => {
    const stream = createAssistantMessageEventStream();
    const plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
    const index = requests++;
    const names = [
      ...(context.tools ?? []),
      ...context.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []) : [],
      ),
    ].map((tool) => tool.name);
    writeFileSync(
      join(directory, "model-requests.json"),
      JSON.stringify({ requests, names }),
    );
    const find = (suffix: string) =>
      names.find(
        (name) =>
          name === suffix ||
          name.endsWith(`_${suffix}`) ||
          name.endsWith(`/${suffix}`),
      ) ?? suffix;
    const assignments = context.messages.flatMap((message) => {
      if (message.role !== "user") return [];
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      try {
        const envelope = JSON.parse(text.slice(text.indexOf("\n") + 1));
        return envelope.kind === "instruction"
          ? [JSON.parse(envelope.text)]
          : [];
      } catch {
        return [];
      }
    });
    const assignment = assignments.at(-1);
    const call = (name: string, args: JsonObject, ordinal = 0): ToolCall => ({
      type: "toolCall",
      id: `native-proof-${index}-${ordinal}`,
      name: find(name),
      arguments: args,
    });
    let content: AssistantMessage["content"];
    if (!assignment)
      content = [
        { type: "text", text: "No Factory assignment was delivered." },
      ];
    else if (index === 0)
      content = [
        call("factory", {
          op: "ask",
          itemId: "question:native-loop",
          title: "Authorize result?",
          text: "Which exact result should I write?",
          blocking: true,
        }),
        call(
          "rex",
          {
            op: "run",
            requestId: "must-not-run-before-answer",
            argv: plan.forbiddenArgv,
          },
          1,
        ),
      ];
    else if (index === 1)
      content = [
        call("rex", {
          op: "run",
          requestId: "native-loop-effect",
          argv: plan.effectArgv,
          waitMs: 1000,
        }),
      ];
    else if (index === 2)
      content = [
        call("factory", {
          op: "report",
          itemId: assignment.report.itemId,
          title: "Native result",
          text: "result.txt contains verified text; command completed once.",
          blocking: false,
        }),
      ];
    else
      content = [{ type: "text", text: "No report in this controlled turn." }];
    const response: AssistantMessage = {
      role: "assistant",
      content,
      api: "uzina-native-proof-api",
      provider: "uzina-native-proof",
      model: "controlled",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: content.some((block) => block.type === "toolCall")
        ? "toolUse"
        : "stop",
      timestamp: Date.now(),
    };
    stream.end(response);
    return stream;
  };
  return createProvider({
    id: "uzina-native-proof",
    name: "Controlled native lifecycle proof",
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
        id: "controlled",
        name: "Controlled",
        provider: "uzina-native-proof",
        api: "uzina-native-proof-api",
        baseUrl: "https://test.invalid",
        input: ["text"],
        reasoning: false,
        contextWindow: 32000,
        maxTokens: 2048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api: { stream: respond, streamSimple: respond },
  });
}
