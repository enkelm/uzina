import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionDaemon } from "../src/execution/daemon";

const optIn = process.env.UZINA_REX_LIFECYCLE_INTEGRATION === "1";

type RexSession = { session_id: string; label: string };

function rexJson<T>(args: string[]): T {
  const output = execFileSync("rex", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 10_000,
  });
  return JSON.parse(output) as T;
}

function rexSessions(): RexSession[] {
  const response = rexJson<{ sessions: RexSession[] }>(["ls", "--json"]);
  if (!Array.isArray(response.sessions)) {
    throw new Error("Rex returned an invalid session listing");
  }
  return response.sessions;
}

function verifyInactive(
  daemon: ExecutionDaemon,
  sessionId: string,
  processId: string,
): Promise<"session-absent" | "process-exited"> {
  if (!rexSessions().some((session) => session.session_id === sessionId)) {
    return Promise.resolve("session-absent");
  }
  return daemon.rex.inspect(processId).then((inspection) => {
    if (inspection.status !== "exited") {
      throw new Error(
        `Rex process ${processId} remained ${inspection.status} after stop`,
      );
    }
    return "process-exited";
  });
}

test.skipIf(!optIn)(
  "uses the installed local Rex server for an isolated create, inspect, and stop lifecycle",
  async () => {
    const identity = crypto.randomUUID();
    const processId = `rex-integration-${identity}`;
    const label = `uzina-${processId}`;
    const root = mkdtempSync(join(tmpdir(), "uzina-rex-lifecycle-"));
    const workspace = join(root, "workspace");
    const databasePath = join(root, "node.sqlite");
    mkdirSync(workspace);

    let daemon: ExecutionDaemon | undefined;
    let sessionId: string | undefined;
    let blockId: string | undefined;
    let inactiveVerified = false;
    let possibleOrphan: string | undefined;
    let failure: unknown;

    try {
      const whoami = rexJson<{
        endpoint?: unknown;
        rex_version?: unknown;
      }>(["whoami", "--json"]);
      if (
        typeof whoami.endpoint !== "string" ||
        !whoami.endpoint.startsWith("unix://")
      ) {
        throw new Error(
          `Refusing non-local Rex endpoint: ${String(whoami.endpoint)}`,
        );
      }
      expect(typeof whoami.rex_version).toBe("string");
      if (rexSessions().some((session) => session.label === label)) {
        throw new Error(`Refusing to reuse an existing Rex label: ${label}`);
      }

      const workspaceId = `workspace:rex-integration-${identity}`;
      daemon = new ExecutionDaemon({
        databasePath,
        nodeId: `node:rex-integration-${identity}`,
        nodeCredential: `ephemeral-${identity}`,
        workspaces: [{ workspaceId, directory: workspace }],
      });
      const markerPath = join(workspace, "rex-lifecycle-marker.txt");
      const markerContent = `created by ${processId}`;
      const program = `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(markerContent)}); setInterval(() => {}, 1000);`;
      const launch = await daemon.rex.launch({
        contractVersion: 1,
        processId,
        nodeId: daemon.nodeId,
        target: { nodeId: daemon.nodeId, workspaceId },
        ownershipGeneration: 0,
        argv: [process.execPath, "-e", program],
      });
      sessionId = launch.sessionId;
      blockId = launch.blockId;
      if (!sessionId || !blockId) {
        const matching = rexSessions().filter(
          (session) => session.label === label,
        );
        if (matching.length === 1) {
          sessionId = matching[0]!.session_id;
          possibleOrphan = `label=${label} session_id=${sessionId}`;
        }
        throw new Error(
          `Rex launch did not persist its returned session and block IDs (status=${launch.status}, label=${label})`,
        );
      }
      expect(launch.status).toBe("running");
      expect(
        rexSessions().find((session) => session.session_id === sessionId)
          ?.label,
      ).toBe(label);

      const persistedDb = new Database(databasePath);
      let persisted: {
        session_id: string | null;
        block_id: string | null;
      } | null;
      try {
        persisted =
          persistedDb
            .query<
              { session_id: string | null; block_id: string | null },
              [string]
            >(
              "SELECT session_id, block_id FROM execution_rex_processes WHERE process_id = ?",
            )
            .get(processId) ?? null;
      } finally {
        persistedDb.close();
      }
      expect(persisted).toEqual({ session_id: sessionId, block_id: blockId });

      const deadline = Date.now() + 10_000;
      let marker: string | undefined;
      while (Date.now() < deadline) {
        try {
          marker = readFileSync(markerPath, "utf8");
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
      expect(marker).toBe(markerContent);
      expect((await daemon.rex.inspect(processId)).status).toBe("running");

      const stopped = await daemon.rex.stop(processId);
      expect(stopped.status).toBe("exited");
      const inactiveEvidence = await verifyInactive(
        daemon,
        sessionId,
        processId,
      );
      inactiveVerified = true;
      console.info("Rex lifecycle integration cleanup verified", {
        processId,
        label,
        sessionId,
        blockId,
        inactiveEvidence,
      });
    } catch (error) {
      failure = error;
    } finally {
      if (daemon && sessionId && blockId && !inactiveVerified) {
        try {
          const stopped = await daemon.rex.stop(processId);
          if (stopped.status === "exited") {
            await verifyInactive(daemon, sessionId, processId);
            inactiveVerified = true;
          }
        } catch (cleanupError) {
          possibleOrphan = `label=${label} session_id=${sessionId} block_id=${blockId}; cleanup=${String(cleanupError)}`;
        }
      }

      if (!sessionId) {
        try {
          const matching = rexSessions().filter(
            (session) => session.label === label,
          );
          if (matching.length === 1) {
            possibleOrphan = `label=${label} session_id=${matching[0]!.session_id}`;
          } else if (matching.length > 1) {
            possibleOrphan = `label=${label} matching_session_ids=${matching
              .map((session) => session.session_id)
              .join(",")}`;
          }
        } catch (lookupError) {
          possibleOrphan = `label=${label} session_id=unknown; lookup=${String(lookupError)}`;
        }
      }

      daemon?.close();
      if (inactiveVerified || !possibleOrphan) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(
          `Rex integration resource may remain; preserving workspace/database ${root}: ${possibleOrphan}`,
        );
      }
    }

    if (failure) {
      if (possibleOrphan) {
        throw new Error(
          `${String(failure)}; possible owned resource: ${possibleOrphan}`,
        );
      }
      throw failure;
    }
    if (possibleOrphan) {
      throw new Error(`Possible owned resource remains: ${possibleOrphan}`);
    }
    expect(inactiveVerified).toBe(true);
  },
);
