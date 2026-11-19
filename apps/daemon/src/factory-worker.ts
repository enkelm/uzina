import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { factoryWorkerToolInputSchema } from "@uzina/contracts/native-provisioning";
import { FactoryClientError } from "@uzina/client";
import { ExecutionError } from "./execution/errors";
import { readNativeBootstrapFile } from "./execution/native-agent-bootstrap";
import { CatalogRecordingStdioTransport } from "./execution/mcp-readiness";
import {
  FactoryWorkerHost,
  FACTORY_WORKER_POLICY,
} from "./execution/factory-worker";
const coreErrorCodes = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
  "worker_not_ready",
  "native_assignment_blocked",
  "coordination_item_conflict",
  "ownership_fenced",
  "workspace_capture_in_progress",
  "network_error",
  "invalid_response",
  "response_too_large",
  "cross_origin_redirect_refused",
]);
function safeCode(error: unknown) {
  if (error instanceof FactoryClientError && !coreErrorCodes.has(error.code))
    return "factory_worker_operation_failed";
  if (
    (error instanceof ExecutionError || error instanceof FactoryClientError) &&
    /^[a-z][a-z0-9_]{0,99}$/.test(error.code)
  )
    return error.code;
  return "factory_worker_operation_failed";
}
export function createFactoryWorkerMcpServer(
  host: FactoryWorkerHost,
): McpServer {
  const server = new McpServer(
    { name: "Uzina Factory worker", version: "1.0.0" },
    { instructions: FACTORY_WORKER_POLICY, maxToolInputElements: 32 },
  );
  server.server.oninitialized = () =>
    host.recordInitialized(server.server.getClientVersion());
  server.registerTool(
    "factory",
    {
      description:
        "Dedicated worker coordination: status, ask, report, inbox and acknowledge. Stable itemId is required for ask/report retries. No credentials, worker ID, project or target arguments are accepted. Acknowledgement is receipt only; automatic wake-up is unsupported.",
      inputSchema: factoryWorkerToolInputSchema,
    },
    async (input, extra) => {
      try {
        let value = await host.execute(input, extra.signal);
        const output = () => {
          const result = { result: value };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        };
        // Presentation bounding only: omitted mailbox rows remain unacknowledged in Core.
        if (
          input.op === "inbox" &&
          value &&
          typeof value === "object" &&
          "messages" in value &&
          Array.isArray(value.messages)
        ) {
          const mailbox = {
            ...value,
            messages: [...value.messages],
            truncated: false,
          };
          value = mailbox;
          while (
            Buffer.byteLength(JSON.stringify(output())) > 250_000 &&
            mailbox.messages.length > 1
          ) {
            mailbox.messages.pop();
            mailbox.truncated = true;
          }
        }
        const result = output();
        if (Buffer.byteLength(JSON.stringify(result)) > 250_000)
          throw new ExecutionError("factory_worker_result_limit");
        return result;
      } catch (error) {
        const result = { error: safeCode(error) };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    },
  );
  return server;
}
async function main() {
  const [option, path, ...extra] = process.argv.slice(2);
  if (option !== "--config" || !path || extra.length)
    throw new ExecutionError("factory_worker_invalid_arguments");
  let config: unknown;
  try {
    config = JSON.parse(readNativeBootstrapFile(path));
  } catch {
    throw new ExecutionError("factory_worker_invalid_configuration");
  }
  const host = await FactoryWorkerHost.open(config);
  const server = createFactoryWorkerMcpServer(host);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      await server.close();
      await host.close();
    }));
  server.server.onclose = () => {
    void close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  process.stdin.once("end", () => {
    void close();
  });
  try {
    await server.connect(
      new CatalogRecordingStdioTransport("factory", () =>
        host.recordCatalogServed(),
      ),
    );
  } catch (error) {
    await close();
    throw error;
  }
}
if (import.meta.main)
  void main().catch((error: unknown) => {
    console.error(safeCode(error));
    process.exitCode = 1;
  });
