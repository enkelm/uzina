import { lstatSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CatalogRecordingStdioTransport } from "./execution/mcp-readiness";
import { rexToolInputSchema } from "@uzina/contracts/rex-tools";
import { ExecutionError } from "./execution/errors";
import { RexToolHost, REX_TOOL_POLICY } from "./execution/rex-tools";

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^(rex_|invalid_rex_|process_id_payload_conflict$|workspace_|ownership_fenced$)/.test(
      error.code,
    )
  )
    return error.code;
  return "rex_operation_failed";
}

export function createRexMcpServer(host: RexToolHost): McpServer {
  const server = new McpServer(
    { name: "Uzina local Rex tools", version: "1.0.0" },
    { instructions: REX_TOOL_POLICY, maxToolInputElements: 160 },
  );
  server.server.oninitialized = () => {
    host.recordMcpInitialized(server.server.getClientVersion());
  };
  server.registerTool(
    "rex",
    {
      description:
        "Local Rex command jobs. context shows binding and CLI fallback. run requires stable requestId and argv; inspect/wait/output require the original requestId. Other operations belong in the installed Rex CLI. No agent delivery, arbitrary pane capture, or Factory authorization is implied.",
      inputSchema: rexToolInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        const value = await host.execute(input, extra.signal);
        const result = { result: value };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = { error: errorCode(error) };
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

async function main(): Promise<void> {
  const [mode, option, configPath, ...extra] = process.argv.slice(2);
  if (
    !["mcp", "call"].includes(mode ?? "") ||
    option !== "--config" ||
    !configPath ||
    extra.length
  ) {
    throw new ExecutionError("invalid_rex_arguments");
  }
  const configStat = lstatSync(configPath);
  if (
    !configStat.isFile() ||
    configStat.isSymbolicLink() ||
    configStat.size > 16_384 ||
    configStat.uid !== process.getuid?.() ||
    (configStat.mode & 0o022) !== 0
  ) {
    throw new ExecutionError("invalid_rex_configuration_permissions");
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new ExecutionError("invalid_rex_configuration");
  }
  const host = await RexToolHost.open(config);
  if (mode === "call") {
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of Bun.stdin.stream()) {
        bytes += chunk.byteLength;
        if (bytes > 65_536) throw new ExecutionError("invalid_rex_request");
        chunks.push(chunk);
      }
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new ExecutionError("invalid_rex_request");
      }
      console.log(JSON.stringify({ result: await host.execute(input) }));
    } finally {
      await host.close();
    }
    return;
  }
  const server = createRexMcpServer(host);
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
      new CatalogRecordingStdioTransport("rex", () =>
        host.recordMcpCatalogServed(),
      ),
    );
  } catch (error) {
    await close();
    throw error;
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    // stdout is exclusively MCP/JSON. Never echo command arguments, config, or CLI stderr.
    console.error(errorCode(error));
    process.exitCode = 1;
  });
}
