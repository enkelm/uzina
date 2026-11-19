// External native-client substitute for the mandatory suite (no installed Rex/PTY).
// Real Pi/Codex + the production PTY bootstrap are covered by the opt-in acceptance.
// This client really initializes both generated MCP subprocesses and invokes their
// tools; it never writes readiness rows, Core receipts or coordination items itself.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
const launch = JSON.parse(
  readFileSync(process.argv[process.argv.indexOf("--config") + 1]!, "utf8"),
);
const directory =
  launch.environment.NATIVE_TEST_DRIVER ?? process.env.NATIVE_TEST_DRIVER;
const metadata = JSON.parse(
  readFileSync(
    join(
      dirname(process.argv[process.argv.indexOf("--config") + 1]!),
      "client.json",
    ),
    "utf8",
  ),
);
const clients = new Map<string, Client>();
const catalogues: Record<string, string[]> = {};
let stopping = false;
process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});
try {
  for (const entry of metadata.servers) {
    const client = new Client({
      name: `test-native-${metadata.agent}`,
      version: "1",
    });
    clients.set(
      entry.name.startsWith("uzina_factory_") ? "factory" : "rex",
      client,
    );
    await client.connect(
      new StdioClientTransport({
        command: entry.server.command,
        args: entry.server.args,
        cwd: entry.server.cwd,
        env: launch.environment,
        stderr: "ignore",
      }),
    );
    catalogues[entry.name.startsWith("uzina_factory_") ? "factory" : "rex"] = (
      await client.listTools()
    ).tools.map((tool) => tool.name);
  }
  writeFileSync(
    join(directory, "started"),
    JSON.stringify({ pid: process.pid, catalogues }),
  );
  while (!stopping) {
    for (const file of readdirSync(join(directory, "requests")).filter((file) =>
      file.endsWith(".json"),
    )) {
      const resultPath = join(directory, "responses", file);
      if (existsSync(resultPath)) continue;
      const request = JSON.parse(
        readFileSync(join(directory, "requests", file), "utf8"),
      );
      const result = await clients
        .get(request.server)!
        .callTool({ name: request.server, arguments: request.input });
      writeFileSync(resultPath, JSON.stringify(result));
    }
    await Bun.sleep(10);
  }
} catch (error) {
  writeFileSync(join(directory, "failure"), String(error));
} finally {
  await Promise.all([...clients.values()].map((client) => client.close()));
}
