import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { nativeAgentBootstrapSchema } from "@uzina/contracts/native-agents";
import { readNativeBootstrapFile } from "./execution/native-agent-bootstrap";

// This replaces itself with the ordinary CLI on Rex's PTY. No RPC/print mode,
// shell interpolation, inherited host secrets, or terminal-input delivery.
if (import.meta.main) {
  try {
    const [option, path, ...extra] = process.argv.slice(2);
    if (
      option !== "--config" ||
      !path ||
      extra.length ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY
    )
      throw new Error("native_agent_requires_rex_terminal");
    const config = nativeAgentBootstrapSchema.parse(
      JSON.parse(readNativeBootstrapFile(path)),
    );
    if (
      !isAbsolute(config.executable) ||
      realpathSync(process.cwd()) !== config.workspaceDirectory
    )
      throw new Error("native_agent_workspace_mismatch");
    if (!process.execve) throw new Error("native_agent_execve_unavailable");
    const environment = { ...config.environment };
    // These are this newly created Rex PTY's resource IDs, not the launcher's
    // ambient session. Keep native Rex integrations working without host secrets.
    for (const name of ["REX_SESSION", "REX_BLOCK"]) {
      if (process.env[name]) environment[name] = process.env[name]!;
    }
    process.execve(
      config.executable,
      [config.executable, ...config.argv],
      environment,
    );
  } catch {
    // Configuration may contain dedicated model credentials. Never print it.
    console.error("native_agent_bootstrap_failed");
    process.exitCode = 1;
  }
}
