import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

type StreamResult =
  | { kind: "result"; message: AssistantMessage }
  | { kind: "failure"; error: unknown };

/** Keep a configured provider's assistant events and result free of its API key. */
export function redactProviderErrors<TApi extends Api>(
  provider: Provider<TApi>,
  apiKey: string,
): Provider<TApi> {
  const stream = provider.stream.bind(provider);
  const streamSimple = provider.streamSimple.bind(provider);
  provider.stream = (model, context, options) =>
    redactProviderErrorStream(
      stream(model, context, options),
      model,
      apiKey,
      options?.signal,
    );
  provider.streamSimple = (model, context, options) =>
    redactProviderErrorStream(
      streamSimple(model, context, options),
      model,
      apiKey,
      options?.signal,
    );
  return provider;
}

function redactProviderErrorStream<TApi extends Api>(
  source: AssistantMessageEventStream,
  model: Model<TApi>,
  apiKey: string,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const safe = new AssistantMessageEventStream();
  let finalEventSeen = false;
  let lastPartial: AssistantMessage | undefined;
  const sourceResult: Promise<StreamResult> = Promise.resolve()
    .then(() => source.result())
    .then(
      (message) => ({ kind: "result", message }) as const,
      (error: unknown) => ({ kind: "failure", error }) as const,
    );

  const emitFailure = (error: unknown) => {
    if (finalEventSeen) return;
    const message = failedMessage(model, lastPartial, error, apiKey, signal);
    safe.push({
      type: "error",
      reason: message.stopReason === "aborted" ? "aborted" : "error",
      error: message,
    });
    finalEventSeen = true;
    safe.end();
  };

  const forward = async () => {
    try {
      for await (const event of source) {
        const protectedEvent = redactEvent(event, apiKey);
        const partial = partialMessage(protectedEvent);
        if (partial) lastPartial = partial;
        safe.push(protectedEvent);
        if (protectedEvent.type === "done" || protectedEvent.type === "error") {
          finalEventSeen = true;
        }
      }

      if (finalEventSeen) return;
      const result = await new Promise<StreamResult | { kind: "ended" }>(
        (resolve) => {
          const timeout = setTimeout(() => resolve({ kind: "ended" }), 0);
          void sourceResult.then((settled) => {
            clearTimeout(timeout);
            resolve(settled);
          });
        },
      );
      if (result.kind === "result") {
        safe.end(redactMessage(result.message, apiKey));
      } else if (result.kind === "failure") {
        emitFailure(result.error);
      } else {
        emitFailure(
          new Error("Provider stream ended without a final response"),
        );
      }
    } catch (error) {
      emitFailure(error);
    }
  };

  void forward().catch(emitFailure);
  return safe;
}

function redactEvent(
  event: AssistantMessageEvent,
  apiKey: string,
): AssistantMessageEvent {
  return redactValue(structuredClone(event), apiKey) as AssistantMessageEvent;
}

function partialMessage(
  event: AssistantMessageEvent,
): AssistantMessage | undefined {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return "partial" in event ? event.partial : undefined;
}

function failedMessage<TApi extends Api>(
  model: Model<TApi>,
  partial: AssistantMessage | undefined,
  error: unknown,
  apiKey: string,
  signal: AbortSignal | undefined,
): AssistantMessage {
  const aborted = signal?.aborted || isAbortError(error);
  const base = partial
    ? structuredClone(partial)
    : {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
  const failed = {
    ...base,
    stopReason: aborted ? ("aborted" as const) : ("error" as const),
    errorMessage: aborted ? "Request was aborted" : errorText(error),
  };
  return redactValue(failed, apiKey) as AssistantMessage;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function redactMessage(
  message: AssistantMessage,
  apiKey: string,
): AssistantMessage {
  return redactValue(structuredClone(message), apiKey) as AssistantMessage;
}

function redactValue(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(`Bearer ${apiKey}`, "[redacted provider authorization]")
      .replaceAll(apiKey, "[redacted provider credential]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, apiKey));
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      (value as Record<string, unknown>)[key] = redactValue(item, apiKey);
    }
  }
  return value;
}
