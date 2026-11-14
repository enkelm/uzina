import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { FactoryError, FactoryService, type FactorySession } from "./factory";
import type { ManagedWorkQueries } from "./http";

const MAX_RESULT_BYTES = 256 * 1024;
const MAX_TOOL_INPUT_ELEMENTS = 64;
const limitSchema = z.number().int().min(1).max(100).optional();

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token, ...extra] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token && extra.length === 0
    ? token
    : null;
}

function json(
  body: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof FactoryError)) return "operation_failed";
  if (
    error.code === "unsupported_capability" ||
    error.code === "unsupported_operation"
  )
    return "unsupported_operation";
  if (error.code === "invalid_limit" || error.code === "invalid_cursor") {
    return "invalid_request";
  }
  if (error.status === 401) return "unauthorized";
  if (error.status === 403) return "access_denied";
  if (error.status === 404) return "not_found";
  if (error.status === 409) return error.code;
  if (error.status === 400) return error.code;
  if (error.status >= 500) return "unavailable";
  return "operation_failed";
}

function boundedJson(value: unknown): { value: unknown; text: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new FactoryError(500, "result_not_json");
  }
  if (
    text === undefined ||
    new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES
  ) {
    throw new FactoryError(413, "result_too_large");
  }
  return { value: JSON.parse(text) as unknown, text };
}

function success(value: unknown) {
  const result = boundedJson(value);
  const structuredContent = { result: result.value };
  return {
    content: [{ type: "text" as const, text: result.text }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const code = safeErrorCode(error);
  const value = { error: code };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

type ToolHandler<T> = (input: T) => unknown | Promise<unknown>;

function register<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodObject<T>,
  handler: ToolHandler<z.infer<z.ZodObject<T>>>,
): void {
  server.registerTool(name, { description, inputSchema }, async (input) => {
    try {
      return success(await handler(input));
    } catch (error) {
      return failure(error);
    }
  });
}

function addFactoryTools(
  server: McpServer,
  factory: FactoryService,
  session: FactorySession,
  managedWork?: ManagedWorkQueries,
): void {
  register(
    server,
    "list_projects",
    "List permitted projects. Results are bounded to at most 100 projects.",
    z.object({ limit: limitSchema }).strict(),
    ({ limit }) => factory.listProjects(session, limit),
  );
  register(
    server,
    "list_threads",
    "List permitted threads, optionally filtered by an explicit project ID.",
    z
      .object({
        projectId: z.string().min(1).max(128).optional(),
        limit: limitSchema,
      })
      .strict(),
    ({ projectId, limit }) => factory.listThreads(session, projectId, limit),
  );
  register(
    server,
    "list_runs",
    "List accepted Factory input runs for an explicit thread. Each run is represented by its durable command receipt; there is no separate run database.",
    z
      .object({ threadId: z.string().min(1).max(128), limit: limitSchema })
      .strict(),
    ({ threadId, limit }) => ({
      threadId,
      runs: factory.listThreadReceipts(session, threadId, limit),
    }),
  );
  register(
    server,
    "get_receipt",
    "Get the current durable receipt for an application request ID.",
    z.object({ requestId: z.string().min(1).max(128) }).strict(),
    ({ requestId }) => factory.getReceipt(session, requestId),
  );
  register(
    server,
    "get_context",
    "Read canonical managed Pi context for an explicit permitted thread.",
    z.object({ threadId: z.string().min(1).max(128) }).strict(),
    async ({ threadId }) => {
      factory.getAuthorizedThread(session, threadId);
      if (!managedWork)
        throw new FactoryError(503, "managed_runtime_unavailable");
      const runtime = await managedWork.context(threadId);
      return {
        thread: factory.getAuthorizedThread(session, threadId),
        runtime,
      };
    },
  );
  register(
    server,
    "get_status",
    "Read managed runtime status for an explicit permitted thread.",
    z.object({ threadId: z.string().min(1).max(128) }).strict(),
    async ({ threadId }) => {
      factory.getAuthorizedThread(session, threadId);
      if (!managedWork)
        throw new FactoryError(503, "managed_runtime_unavailable");
      const runtime = await managedWork.status(threadId);
      return {
        thread: factory.getAuthorizedThread(session, threadId),
        runtime,
      };
    },
  );
  register(
    server,
    "list_nodes",
    "List nodes used by the permitted scope. Results are bounded to at most 100 nodes.",
    z.object({ limit: limitSchema }).strict(),
    ({ limit }) => factory.listNodes(session, limit),
  );
  register(
    server,
    "list_workspaces",
    "List workspaces used by the permitted scope. Results are bounded to at most 100 workspaces.",
    z.object({ limit: limitSchema }).strict(),
    ({ limit }) => factory.listWorkspaces(session, limit),
  );
  register(
    server,
    "submit_input",
    "Submit text to an explicitly targeted thread. requestId is a stable application request identity, not the MCP JSON-RPC ID; retain and reuse it to reconcile a lost acknowledgement.",
    z
      .object({
        threadId: z.string().min(1).max(128),
        requestId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        text: z.string().min(1).max(100_000),
      })
      .strict(),
    ({ threadId, requestId, text }) =>
      factory.submitInput(session, threadId, requestId, text),
  );
  register(
    server,
    "get_events",
    "Read committed, authorized Factory events from a bounded cursor page. This is a query, not a live subscription.",
    z
      .object({
        after: z.number().int().nonnegative().safe().optional(),
        limit: limitSchema,
      })
      .strict(),
    ({ after, limit }) => factory.events(session, after ?? 0, limit ?? 100),
  );
  register(
    server,
    "get_lifecycle_capabilities",
    "Inspect lifecycle capabilities for an explicit permitted thread. Unsupported operations remain unsupported and are never simulated.",
    z.object({ threadId: z.string().min(1).max(128) }).strict(),
    ({ threadId }) => factory.getLifecycleCapabilities(session, threadId),
  );
  register(
    server,
    "request_lifecycle_operation",
    "Request a lifecycle capability. stop, native-cli, and transfer currently refuse before performing any effect.",
    z
      .object({
        threadId: z.string().min(1).max(128),
        operation: z.enum(["stop", "native-cli", "transfer"]),
      })
      .strict(),
    ({ threadId, operation }) => {
      factory.getAuthorizedThread(session, threadId);
      throw new FactoryError(
        501,
        "unsupported_operation",
        `${operation} is unsupported`,
      );
    },
  );
}

/** Creates a stateless official-SDK MCP handler; callers authenticate again on every HTTP request. */
export function createFactoryMcpHandler(
  factory: FactoryService,
  managedWork?: ManagedWorkQueries,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (host !== null && host.toLowerCase() !== url.host.toLowerCase()) {
      return json({ error: "resource_audience_mismatch" }, 403);
    }
    if (origin !== null && origin !== url.origin) {
      return json({ error: "origin_not_allowed" }, 403);
    }
    if (url.search !== "") {
      return json({ error: "query_parameters_not_allowed" }, 400);
    }
    const credential = bearer(request);
    if (!credential) {
      return json({ error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    }
    let session: FactorySession;
    try {
      session = await factory.authenticate(credential);
    } catch {
      return json({ error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    }
    if (request.method === "GET") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }

    const server = new McpServer(
      { name: "Uzina Factory", version: "1.0.0" },
      {
        instructions:
          "This endpoint represents one authenticated Uzina Factory. Every HTTP request must provide a currently active credential for that Factory. Use explicit thread/project/request IDs; requestId on submit_input is the durable application identity. No caller credential is forwarded to nodes or model providers.",
        maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 256 * 1024,
    });
    addFactoryTools(server, factory, session, managedWork);
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch {
      return json({ error: "mcp_protocol_error" }, 400);
    } finally {
      await server.close().catch(() => {});
    }
  };
}
