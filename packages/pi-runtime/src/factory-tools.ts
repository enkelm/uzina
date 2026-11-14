import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { FactoryClient, FactoryClientError } from "@uzina/client";

export const FACTORY_INPUT_REQUEST_MEMO = "uzina.factory-input-request.v1";
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const structuredSchema = Type.Object(
  { result: Type.Any() },
  { additionalProperties: false },
);
const mutationResultSchema = Type.Union([
  Type.Object(
    {
      requestId: Type.String({ minLength: 1, maxLength: 128 }),
      threadId: Type.String({ minLength: 1, maxLength: 128 }),
      status: Type.Literal("accepted"),
      dispatchStatus: Type.String({ minLength: 1, maxLength: 32 }),
      acceptedAt: Type.String({ minLength: 1, maxLength: 64 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      requestId: Type.String({ minLength: 1, maxLength: 128 }),
      threadId: Type.String({ minLength: 1, maxLength: 128 }),
      status: Type.Literal("uncertain"),
      reconciliationTool: Type.Literal("factory_get_receipt"),
    },
    { additionalProperties: false },
  ),
]);

function redact(value: unknown, secret: string): unknown {
  if (typeof value === "string")
    return secret ? value.split(secret).join("[redacted]") : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        secret ? key.split(secret).join("[redacted]") : key,
        redact(item, secret),
      ]),
    );
  }
  return value;
}

function resultValue(value: unknown, secret: string): JsonValue {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(redact(value, secret));
  } catch {
    throw new Error("Factory tool result was not JSON data");
  }
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > MAX_TOOL_RESULT_BYTES
  ) {
    throw new Error("Factory tool result exceeded the bounded response size");
  }
  return JSON.parse(encoded) as JsonValue;
}

function formatSuccess(value: unknown, secret: string) {
  const result = resultValue(value, secret);
  return {
    output: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredOutput: { result },
  };
}

function formatFailure(error: unknown, secret: string): Error {
  if (error instanceof Error && error.name === "AbortError") {
    const aborted = new Error("Factory request aborted");
    aborted.name = "AbortError";
    return aborted;
  }
  if (error instanceof FactoryClientError) {
    const code =
      secret && error.code.includes(secret) ? "request_failed" : error.code;
    return new Error(`Factory operation failed (${error.status}): ${code}`);
  }
  return new Error(
    "Factory operation failed; no credential or request details are exposed",
  );
}

function mutationOutcomeIsUncertain(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof FactoryClientError &&
      (error.status === 0 || error.status === 408 || error.status >= 500))
  );
}

function uncertainMutationResult(requestId: string, threadId: string) {
  const value = {
    requestId,
    threadId,
    status: "uncertain" as const,
    reconciliationTool: "factory_get_receipt" as const,
  };
  return {
    output: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredOutput: value,
  };
}

function requestOptions(context: Context) {
  return context.abortSignal ? { signal: context.abortSignal } : {};
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function memoizedInputIdentity(
  api: ToolExecutionApi,
  context: Context,
  input: { threadId: string; text: string },
): Promise<{ requestId: string }> {
  const identity = {
    conversationId: Number(api.conversationId),
    taskId: String(api.taskId),
    callId: api.callId,
  };
  const requestHash = await sha256(
    JSON.stringify([identity.conversationId, identity.taskId, identity.callId]),
  );
  const candidate = {
    version: 1,
    ...identity,
    threadId: input.threadId,
    textSha256: await sha256(input.text),
    requestId: `pi-input:${requestHash}`,
  };
  const stored = await api.memo(FACTORY_INPUT_REQUEST_MEMO, candidate, context);
  if (
    stored.version !== candidate.version ||
    stored.conversationId !== identity.conversationId ||
    stored.taskId !== identity.taskId ||
    stored.callId !== identity.callId ||
    stored.threadId !== input.threadId ||
    stored.textSha256 !== candidate.textSha256 ||
    stored.requestId !== candidate.requestId
  ) {
    throw new Error(
      "Persisted Factory input identity does not match this Pi tool call",
    );
  }
  return { requestId: stored.requestId };
}

function createTools(
  client: FactoryClient,
  secret: string,
): ToolRegistration[] {
  const success = (value: unknown) => formatSuccess(value, secret);
  const safeFailure = (error: unknown) => formatFailure(error, secret);
  const listProjects = defineTool({
    name: "factory_list_projects",
    description: "List permitted projects, with an optional limit up to 100.",
    parameters: Type.Object(
      { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.listProjects({
            limit: args.limit,
            ...requestOptions(context),
          }),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const listThreads = defineTool({
    name: "factory_list_threads",
    description:
      "List permitted threads, optionally filtered by explicit project ID.",
    parameters: Type.Object(
      {
        projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.listThreads({
            projectId: args.projectId,
            limit: args.limit,
            ...requestOptions(context),
          }),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const getRuns = defineTool({
    name: "factory_list_runs",
    description: "List durable Factory input receipts for an explicit thread.",
    parameters: Type.Object(
      {
        threadId: Type.String({ minLength: 1, maxLength: 128 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.listRuns(args.threadId, {
            limit: args.limit,
            ...requestOptions(context),
          }),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const getReceipt = defineTool({
    name: "factory_get_receipt",
    description:
      "Reconcile an accepted Factory command by its stable request ID.",
    parameters: Type.Object(
      { requestId: Type.String({ minLength: 1, maxLength: 128 }) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.getReceipt(args.requestId, requestOptions(context)),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const getContext = defineTool({
    name: "factory_get_context",
    description:
      "Read canonical managed context for an explicit permitted thread.",
    parameters: Type.Object(
      { threadId: Type.String({ minLength: 1, maxLength: 128 }) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.getContext(args.threadId, requestOptions(context)),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const getStatus = defineTool({
    name: "factory_get_status",
    description:
      "Read managed runtime status for an explicit permitted thread.",
    parameters: Type.Object(
      { threadId: Type.String({ minLength: 1, maxLength: 128 }) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.getStatus(args.threadId, requestOptions(context)),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const listNodes = defineTool({
    name: "factory_list_nodes",
    description: "List nodes in the credential's permitted scope.",
    parameters: Type.Object(
      { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.listNodes({
            limit: args.limit,
            ...requestOptions(context),
          }),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const listWorkspaces = defineTool({
    name: "factory_list_workspaces",
    description: "List workspaces in the credential's permitted scope.",
    parameters: Type.Object(
      { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.listWorkspaces({
            limit: args.limit,
            ...requestOptions(context),
          }),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const submitInput = defineTool({
    name: "factory_submit_input",
    description:
      "Submit text to an explicit thread. A stable application request ID is derived from and memoized for this Pi tool call before HTTP mutation; do not invent an actor, placement, generation, or request identity. If the acknowledgement is uncertain, reconcile the returned requestId with factory_get_receipt before making any new submission.",
    parameters: Type.Object(
      {
        threadId: Type.String({ minLength: 1, maxLength: 128 }),
        text: Type.String({ minLength: 1, maxLength: 100_000 }),
      },
      { additionalProperties: false },
    ),
    structuredOutputSchema: mutationResultSchema,
    replay: "safe",
    async execute(args, api, context) {
      let requestId: string | undefined;
      try {
        ({ requestId } = await memoizedInputIdentity(api, context, args));
        const receipt = await client.submitInput(
          args.threadId,
          requestId,
          args.text,
          requestOptions(context),
        );
        const value = resultValue(
          {
            requestId: receipt.requestId,
            threadId: receipt.threadId,
            status: receipt.status,
            dispatchStatus: receipt.dispatchStatus,
            acceptedAt: receipt.acceptedAt,
          },
          secret,
        );
        return {
          output: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredOutput: value,
        };
      } catch (error) {
        if (requestId && mutationOutcomeIsUncertain(error)) {
          return uncertainMutationResult(requestId, args.threadId);
        }
        throw safeFailure(error);
      }
    },
  });
  const getEvents = defineTool({
    name: "factory_get_events",
    description:
      "Read a bounded page of committed events from an explicit cursor.",
    parameters: Type.Object(
      {
        after: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.getEvents(args.after, {
            limit: args.limit,
            ...requestOptions(context),
          }),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const lifecycleCapabilities = defineTool({
    name: "factory_lifecycle_capabilities",
    description: "Inspect the supported lifecycle capabilities for a thread.",
    parameters: Type.Object(
      { threadId: Type.String({ minLength: 1, maxLength: 128 }) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        return success(
          await client.getLifecycleCapabilities(
            args.threadId,
            requestOptions(context),
          ),
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  const unsupportedLifecycle = defineTool({
    name: "factory_request_lifecycle_operation",
    description:
      "Explicitly refuses stop, native CLI, and transfer operations before any effect; these operations are unsupported.",
    parameters: Type.Object(
      {
        threadId: Type.String({ minLength: 1, maxLength: 128 }),
        operation: Type.Union([
          Type.Literal("stop"),
          Type.Literal("native-cli"),
          Type.Literal("transfer"),
        ]),
      },
      { additionalProperties: false },
    ),
    structuredOutputSchema: structuredSchema,
    replay: "safe",
    async execute(args, _api, context) {
      try {
        await client.getLifecycleCapabilities(
          args.threadId,
          requestOptions(context),
        );
        const value = {
          error: "unsupported_operation",
          operation: args.operation,
        };
        return {
          output: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredOutput: { result: value },
          isError: true,
        };
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
  return [
    listProjects,
    listThreads,
    getRuns,
    getReceipt,
    getContext,
    getStatus,
    listNodes,
    listWorkspaces,
    submitInput,
    getEvents,
    lifecycleCapabilities,
    unsupportedLifecycle,
  ];
}

/** Custom tools bound to one named assistant Factory credential; the model cannot choose its actor or placement. */
export function createFactoryToolExtension(
  client: FactoryClient,
  options: { credentialToRedact: string },
): Extension {
  return defineExtension({
    name: "uzina.factory-client-tools",
    tools: createTools(client, options.credentialToRedact),
  });
}
