import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { NativeAgentMcpReadiness } from "@uzina/contracts/native-agents";

import { localProcessAlive } from "./local-process";
export { localProcessAlive } from "./local-process";
/** Local diagnostic evidence, not a security attestation or native task admission. */
export function readLocalMcpReadiness(
  journalPath: string,
  kind: "rex" | "factory",
): NativeAgentMcpReadiness {
  let db: Database | undefined;
  try {
    try {
      const stat = lstatSync(journalPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("not_private");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "pending" };
      throw error;
    }
    db = new Database(journalPath, { readonly: true });
    const host = db
      .query<
        {
          owner_pid: number | null;
          owner_id: string | null;
          verified_at?: string | null;
        },
        []
      >(
        kind === "rex"
          ? "SELECT * FROM rex_tool_host WHERE id = 1"
          : "SELECT * FROM factory_worker_host WHERE id = 1",
      )
      .get();
    const row = db
      .query<
        {
          owner_id: string;
          initialized_at: string | null;
          catalog_served_at: string | null;
          client_json: string | null;
        },
        []
      >(
        kind === "rex"
          ? "SELECT * FROM rex_tool_mcp WHERE id = 1"
          : "SELECT * FROM factory_worker_mcp WHERE id = 1",
      )
      .get();
    if (!row) return { status: "pending" };
    const evidence = {
      ...(row.initialized_at ? { initializedAt: row.initialized_at } : {}),
      ...(row.catalog_served_at
        ? { catalogServedAt: row.catalog_served_at }
        : {}),
      ...(host?.verified_at ? { verifiedAt: host.verified_at } : {}),
      ...(row.client_json
        ? {
            client: JSON.parse(row.client_json) as {
              name: string;
              version: string;
            },
          }
        : {}),
    };
    if (
      !host?.owner_pid ||
      host.owner_id !== row.owner_id ||
      !localProcessAlive(host.owner_pid)
    )
      return { ...evidence, status: "disconnected" };
    return {
      ...evidence,
      status:
        row.initialized_at &&
        row.catalog_served_at &&
        (kind === "rex" || !!host.verified_at)
          ? "ready"
          : row.initialized_at
            ? "initialized"
            : "pending",
    };
  } catch {
    return {
      status: "unavailable",
      errorCode: `${kind}_mcp_observation_unavailable`,
    };
  } finally {
    db?.close();
  }
}

export class CatalogRecordingStdioTransport extends StdioServerTransport {
  constructor(
    private readonly toolName: string,
    private readonly record: () => void,
  ) {
    super(undefined, undefined, { maxBufferSize: 65_536 });
  }
  override async send(message: JSONRPCMessage): Promise<void> {
    await super.send(message);
    if (
      "result" in message &&
      Array.isArray(message.result.tools) &&
      message.result.tools.some(
        (tool: unknown) =>
          tool !== null &&
          typeof tool === "object" &&
          "name" in tool &&
          tool.name === this.toolName,
      )
    )
      this.record();
  }
}
