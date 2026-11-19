import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const optIn = process.env.UZINA_REX_LIFECYCLE_INTEGRATION === "1";

test.skipIf(!optIn)(
  "installed Rex executes an isolated MCP job, preserves its receipt and exposes bounded terminal output",
  async () => {
    const identity = JSON.parse(
      execFileSync("rex", ["--autostart=false", "whoami", "--json"], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    );
    if (
      typeof identity.endpoint !== "string" ||
      !identity.endpoint.startsWith("unix://")
    )
      throw new Error("An existing local Unix-socket Rex server is required");
    const root = mkdtempSync(join(tmpdir(), "uzina-rex-mcp-live-"));
    const workspace = join(root, "workspace");
    const privateDirectory = join(root, "private");
    mkdirSync(workspace);
    mkdirSync(privateDirectory, { mode: 0o700 });
    const journalPath = join(privateDirectory, "rex.sqlite");
    const configPath = join(root, "rex.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        workspaceDirectory: workspace,
        journalPath,
        server: identity.endpoint,
      }),
      { mode: 0o600 },
    );
    const client = new Client({
      name: "uzina-live-rex-check",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--no-env-file",
        resolve(import.meta.dir, "../src/rex-tools.ts"),
        "mcp",
        "--config",
        configPath,
      ],
      stderr: "inherit",
    });
    const rex = (...args: string[]) =>
      JSON.parse(
        execFileSync(
          "rex",
          ["--autostart=false", "--server", identity.endpoint, ...args],
          { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 },
        ),
      );
    let cleanupFailure: unknown;
    let failure: unknown;
    try {
      await client.connect(transport);
      const input = {
        op: "run",
        requestId: "verify:live-rex",
        argv: [
          process.execPath,
          "-e",
          'require("node:fs").appendFileSync("effect.txt", "once\\n"); console.log("rex-mcp-live-output"); await Bun.sleep(2000); process.exit(7);',
        ],
        waitMs: 0,
      };
      const first = await client.callTool({ name: "rex", arguments: input });
      expect(first.isError).not.toBe(true);
      const result = (first.structuredContent as any).result;
      expect(result.receipt).toMatchObject({
        status: "running",
        exitCode: null,
      });
      const bounded = await client.callTool({
        name: "rex",
        arguments: { op: "wait", requestId: input.requestId, waitMs: 0 },
      });
      expect((bounded.structuredContent as any).result.receipt.status).toBe(
        "running",
      );
      const settled = await client.callTool({
        name: "rex",
        arguments: { op: "wait", requestId: input.requestId, waitMs: 3000 },
      });
      expect((settled.structuredContent as any).result.receipt).toMatchObject({
        status: "exited",
        exitCode: 7,
      });
      expect(result.output).toMatchObject({ kind: "terminal_snapshot" });
      expect(result.output.text).toContain("rex-mcp-live-output");
      expect(
        rex("session", "inspect", result.receipt.sessionId, "--json").label,
      ).toBe(`uzina-${result.receipt.processId}`);
      const retry = await client.callTool({ name: "rex", arguments: input });
      expect((retry.structuredContent as any).result.receipt.sessionId).toBe(
        result.receipt.sessionId,
      );
      expect(readFileSync(join(workspace, "effect.txt"), "utf8")).toBe(
        "once\n",
      );
    } catch (error) {
      failure = error;
    } finally {
      await client.close();
      // Use only the exact cryptographically scoped labels from this new journal;
      // even a lost launch response must not leave an unreported test resource.
      try {
        const labels: string[] = [];
        if (existsSync(journalPath)) {
          const db = new Database(journalPath, { readonly: true });
          try {
            for (const row of db
              .query<{ process_id: string }, []>(
                "SELECT process_id FROM execution_rex_processes",
              )
              .all())
              labels.push(`uzina-${row.process_id}`);
          } finally {
            db.close();
          }
        }
        const owned = rex("ls", "--json").sessions.filter(
          (session: { label: string }) => labels.includes(session.label),
        );
        for (const session of owned) {
          execFileSync(
            "rex",
            [
              "--autostart=false",
              "--server",
              identity.endpoint,
              "kill",
              session.session_id,
            ],
            { timeout: 10_000 },
          );
        }
        const remaining = rex("ls", "--json").sessions.filter(
          (session: { label: string }) => labels.includes(session.label),
        );
        if (remaining.length)
          cleanupFailure = new Error("An owned integration session remains");
      } catch (error) {
        cleanupFailure = error;
        console.error(`Preserving Rex MCP integration evidence at ${root}`);
      }
      if (!cleanupFailure) rmSync(root, { recursive: true, force: true });
    }
    if (failure && cleanupFailure)
      throw new AggregateError(
        [failure, cleanupFailure],
        `Rex check and cleanup failed; evidence at ${root}`,
      );
    if (cleanupFailure) throw cleanupFailure;
    if (failure) throw failure;
  },
  30_000,
);
