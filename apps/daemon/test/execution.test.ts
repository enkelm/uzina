import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionDaemon } from "../src/execution/daemon";

const fixtures: Array<{ root: string; daemon?: ExecutionDaemon }> = [];

function fixture(options: { rexExecutable?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "uzina-execution-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const daemon = new ExecutionDaemon({
    databasePath: join(root, "node.sqlite"),
    nodeId: "node:test",
    nodeCredential: "node-secret-fixture",
    workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    rexExecutable: options.rexExecutable,
  });
  fixtures.push({ root, daemon });
  return { root, workspace, daemon };
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    contractVersion: 1,
    jobId: "job:one",
    nodeId: "node:test",
    target: { nodeId: "node:test", workspaceId: "workspace:test" },
    ownershipGeneration: 0,
    operation: "write-file",
    path: "artifact.txt",
    contentBase64: Buffer.from("sample bytes").toString("base64"),
    ...overrides,
  };
  if (result.operation === "argv-command") {
    delete result.path;
    delete result.contentBase64;
    delete result.maxBytes;
  } else if (result.operation === "read-file") {
    delete result.contentBase64;
    delete result.argv;
    delete result.timeoutMs;
    delete result.maxOutputBytes;
  } else {
    delete result.maxBytes;
    delete result.argv;
    delete result.timeoutMs;
    delete result.maxOutputBytes;
  }
  return result;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) {
    item.daemon?.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

describe("persistent execution daemon", () => {
  test("performs bounded file effects and deduplicates stable job identities", async () => {
    const { workspace, daemon } = fixture();
    const first = await daemon.executeJob(job());

    expect(first.status).toBe("completed");
    expect(first.result).toMatchObject({
      operation: "write-file",
      bytes: Buffer.byteLength("sample bytes"),
    });
    expect(readFileSync(join(workspace, "artifact.txt"), "utf8")).toBe(
      "sample bytes",
    );
    expect(await daemon.executeJob(job())).toEqual(first);

    await expect(
      daemon.executeJob(
        job({ contentBase64: Buffer.from("different").toString("base64") }),
      ),
    ).rejects.toThrow("job_id_payload_conflict");

    const read = await daemon.executeJob(
      job({
        jobId: "job:read",
        operation: "read-file",
        path: "artifact.txt",
        maxBytes: 64,
        contentBase64: undefined,
      }),
    );
    expect(read.status).toBe("completed");
    expect(read.result).toMatchObject({
      operation: "read-file",
      contentBase64: Buffer.from("sample bytes").toString("base64"),
      bytes: 12,
    });
  });

  test("executes argv directly with bounded output and stops timed-out jobs", async () => {
    const { daemon } = fixture();
    const result = await daemon.executeJob(
      job({
        jobId: "job:command",
        operation: "argv-command",
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('123456'); process.stderr.write('abcdef')",
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 7,
        path: undefined,
        contentBase64: undefined,
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.result?.operation).toBe("argv-command");
    if (result.result?.operation === "argv-command") {
      expect(result.result.stdout.length + result.result.stderr.length).toBe(7);
      expect(result.result.outputTruncated).toBe(true);
    }

    const timedOut = await daemon.executeJob(
      job({
        jobId: "job:timeout",
        operation: "argv-command",
        argv: [process.execPath, "-e", "await Bun.sleep(1000)"],
        timeoutMs: 50,
        maxOutputBytes: 64,
      }),
    );
    expect(timedOut.status).toBe("uncertain");
    expect(timedOut.errorCode).toBe("command_timed_out");
    expect(timedOut.result).toMatchObject({
      operation: "argv-command",
      timedOut: true,
    });
  });

  test.skipIf(process.platform === "win32")(
    "kills a timed-out command's child process group before a descendant can mutate the workspace",
    async () => {
      const { workspace, daemon } = fixture();
      const marker = join(workspace, "late-child-marker.txt");
      const child = `await Bun.sleep(150); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late')`;
      const result = await daemon.executeJob(
        job({
          jobId: "job:timeout-descendant",
          operation: "argv-command",
          argv: [
            process.execPath,
            "-e",
            `Bun.spawn({ cmd: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(child)}], stdin: "ignore", stdout: "ignore", stderr: "ignore" }); await Bun.sleep(10000)`,
          ],
          timeoutMs: 50,
          maxOutputBytes: 64,
        }),
      );

      expect(result.status).toBe("uncertain");
      expect(result.errorCode).toBe("command_timed_out");
      await Bun.sleep(250);
      expect(() => readFileSync(marker, "utf8")).toThrow();
    },
  );

  test("bounds file effects and persists deterministic preflight failures", async () => {
    const { workspace, daemon } = fixture();
    writeFileSync(join(workspace, "large.bin"), Buffer.alloc(8, 65));
    const read = await daemon.executeJob(
      job({
        jobId: "job:read-limit",
        operation: "read-file",
        path: "large.bin",
        maxBytes: 4,
      }),
    );
    expect(read.status).toBe("failed");
    expect(read.errorCode).toBe("file_size_limit_exceeded");

    const oversized = Buffer.alloc(1_048_577).toString("base64");
    const rejectedWrite = await daemon.executeJob(
      job({ jobId: "job:write-limit", contentBase64: oversized }),
    );
    expect(rejectedWrite).toMatchObject({
      status: "failed",
      errorCode: "invalid_file_content",
    });
    expect(daemon.reportFor("job:write-limit")).toMatchObject({
      status: "failed",
      errorCode: "invalid_file_content",
    });
    expect(() =>
      readFileSync(join(workspace, "artifact.txt"), "utf8"),
    ).toThrow();
    expect(
      await daemon.executeJob(
        job({
          jobId: "job:write-limit",
          contentBase64: oversized,
        }),
      ),
    ).toEqual(rejectedWrite);
  });

  test("rejects wrong targets, generations, unsupported operations, and bounded-size violations", async () => {
    const { daemon } = fixture();

    await expect(
      daemon.executeJob(
        job({
          nodeId: "node:other",
          target: { nodeId: "node:other", workspaceId: "workspace:test" },
        }),
      ),
    ).rejects.toThrow("target_node_mismatch");
    expect(daemon.getReceipt("job:one")).toBeUndefined();
    await expect(
      daemon.executeJob(job({ ownershipGeneration: 3 })),
    ).rejects.toThrow("stale_ownership_generation");
    await expect(
      daemon.executeJob(
        job({
          jobId: "job:unconfigured-workspace",
          target: { nodeId: "node:test", workspaceId: "workspace:other" },
        }),
      ),
    ).rejects.toThrow("workspace_not_configured");
    await expect(
      daemon.executeJob(job({ operation: "shell" })),
    ).rejects.toThrow("unsupported_operation");
    await expect(
      daemon.executeJob(
        job({ operation: "read-file", path: "x", maxBytes: 1_048_577 }),
      ),
    ).rejects.toThrow("invalid_job");
  });

  test("rejects traversal and symlink escapes without reading or writing outside the workspace", async () => {
    const { root, workspace, daemon } = fixture();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside original");
    symlinkSync(outside, join(workspace, "outside-link.txt"));
    mkdirSync(join(root, "outside-dir"));
    writeFileSync(join(root, "outside-dir", "secret.txt"), "secret");
    symlinkSync(join(root, "outside-dir"), join(workspace, "outside-link-dir"));

    const traversal = await daemon.executeJob(
      job({ jobId: "job:traversal", path: "../outside.txt" }),
    );
    expect(traversal).toMatchObject({
      status: "failed",
      errorCode: "unsafe_workspace_path",
    });
    const linkWrite = await daemon.executeJob(
      job({ jobId: "job:link", path: "outside-link.txt" }),
    );
    expect(linkWrite).toMatchObject({
      status: "failed",
      errorCode: "workspace_symlink_rejected",
    });
    const linkRead = await daemon.executeJob(
      job({
        jobId: "job:link-dir",
        operation: "read-file",
        path: "outside-link-dir/secret.txt",
        maxBytes: 32,
        contentBase64: undefined,
      }),
    );
    expect(linkRead).toMatchObject({
      status: "failed",
      errorCode: "workspace_symlink_rejected",
    });
    expect(daemon.reportFor("job:traversal")).toMatchObject({
      status: "failed",
      errorCode: "unsafe_workspace_path",
    });
    expect(readFileSync(outside, "utf8")).toBe("outside original");
  });

  test("persists identity, workspace mappings, receipts, and fenced generations across reopen", async () => {
    const { root, workspace, daemon } = fixture();
    const done = await daemon.executeJob(job());
    const fence = daemon.fenceWorkspace("workspace:test", 0, 1);
    expect(fence).toMatchObject({ ownershipGeneration: 1, state: "fenced" });
    daemon.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;

    const reopened = new ExecutionDaemon({
      databasePath: join(root, "node.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    });
    fixtures.push({ root, daemon: reopened });
    expect(reopened.getReceipt("job:one")).toEqual(done);
    expect(await reopened.executeJob(job())).toEqual(done);
    expect(reopened.registerRequest().workspaces).toMatchObject([
      {
        workspaceId: "workspace:test",
        ownershipGeneration: 1,
        state: "fenced",
      },
    ]);
    await expect(
      reopened.executeJob(
        job({ jobId: "job:old-generation", ownershipGeneration: 0 }),
      ),
    ).rejects.toThrow("stale_ownership_generation");
    reopened.activateWorkspace("workspace:test", 1);
    expect(reopened.heartbeatRequest().workspaces[0]?.ownershipGeneration).toBe(
      1,
    );
  });

  test("rejects credential and workspace remapping changes on reopen", async () => {
    const { root, workspace, daemon } = fixture();
    daemon.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;
    const otherWorkspace = join(root, "other-workspace");
    mkdirSync(otherWorkspace);

    expect(
      () =>
        new ExecutionDaemon({
          databasePath: join(root, "node.sqlite"),
          nodeId: "node:test",
          nodeCredential: "different-secret",
          workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
        }),
    ).toThrow("node_credential_conflict");
    expect(
      () =>
        new ExecutionDaemon({
          databasePath: join(root, "node.sqlite"),
          nodeId: "node:test",
          nodeCredential: "node-secret-fixture",
          workspaces: [
            { workspaceId: "workspace:test", directory: otherWorkspace },
          ],
        }),
    ).toThrow("workspace_mapping_conflict");
  });

  test("does not replay an interrupted uncertain command after restart", async () => {
    const { root, workspace, daemon } = fixture();
    const marker = join(workspace, "command-runs.txt");
    const uncertainJob = job({
      jobId: "job:uncertain-command",
      operation: "argv-command",
      argv: [
        process.execPath,
        "-e",
        `await Bun.sleep(150); require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`,
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 64,
      path: undefined,
      contentBase64: undefined,
    });
    const originalExecution = daemon
      .executeJob(uncertainJob)
      .catch(() => undefined);
    expect(daemon.getReceipt("job:uncertain-command")?.status).toBe("running");
    daemon.close();
    fixtures[fixtures.length - 1]!.daemon = undefined;

    const reopened = new ExecutionDaemon({
      databasePath: join(root, "node.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
    });
    fixtures.push({ root, daemon: reopened });
    const retry = await reopened.executeJob(uncertainJob);
    expect(retry.status).toBe("uncertain");
    expect(retry.errorCode).toBe("interrupted_after_start");
    await Bun.sleep(300);
    await originalExecution;
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(() => reopened.fenceWorkspace("workspace:test", 0, 1)).toThrow(
      "workspace_has_uncertain_effects",
    );

    const resolved = reopened.reconcileUncertainJob(
      "job:uncertain-command",
      "confirmed-completed",
      "operator verified the command marker and process exit",
    );
    expect(resolved.status).toBe("completed");
    expect(() => reopened.fenceWorkspace("workspace:test", 0, 1)).not.toThrow();
  });

  test("refuses quiescence while an argv effect is running and admits only the advanced generation after fencing", async () => {
    const { daemon } = fixture();
    const running = daemon.executeJob(
      job({
        jobId: "job:running",
        operation: "argv-command",
        argv: [process.execPath, "-e", "await Bun.sleep(100)"],
        timeoutMs: 5_000,
        maxOutputBytes: 64,
        path: undefined,
        contentBase64: undefined,
      }),
    );
    expect(() => daemon.fenceWorkspace("workspace:test", 0, 1)).toThrow(
      "workspace_has_uncertain_effects",
    );
    expect((await running).status).toBe("completed");
    daemon.fenceWorkspace("workspace:test", 0, 1);
    await expect(
      daemon.executeJob(job({ jobId: "job:stale", ownershipGeneration: 0 })),
    ).rejects.toThrow("stale_ownership_generation");
    daemon.activateWorkspace("workspace:test", 1);
    const generationOne = await daemon.executeJob(
      job({ jobId: "job:generation-one", ownershipGeneration: 1 }),
    );
    expect(generationOne.status).toBe("completed");
  });

  test("creates and stops only persisted Rex resources using structured inspection", async () => {
    const root = mkdtempSync(join(tmpdir(), "uzina-rex-fixture-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const statePath = join(root, "rex-state.json");
    writeFileSync(statePath, "{}", "utf8");
    const executable = join(root, "rex-fixture");
    writeFileSync(
      executable,
      `#!/usr/bin/env bun\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst stateFile = ${JSON.stringify(statePath)};\nconst state = JSON.parse(readFileSync(stateFile, 'utf8'));\nconst [command, ...args] = process.argv.slice(2);\nconst persist = () => writeFileSync(stateFile, JSON.stringify(state));\nif (command === 'new') { const label = args[0]; const session_id = 'session-' + label; const block_id = 'block-' + label; state[session_id] = { block_id, running: true, last_exit: null }; persist(); console.log(JSON.stringify({ session_id, initial_windows: [{ block_ids: [block_id] }] })); }\nelse if (command === 'session' && args[0] === 'inspect') { const s = state[args[1]]; if (!s) process.exit(3); console.log(JSON.stringify({ session_id: args[1], windows: [{ window_id: 'window-' + args[1], focused_block_id: s.block_id }] })); }\nelse if (command === 'block' && args[0] === 'call') { const session = args[args.indexOf('--session') + 1]; const s = state[session]; if (!s) process.exit(3); console.log(JSON.stringify({ running: s.running, last_exit: s.last_exit })); }\nelse if (command === 'kill') { const s = state[args[0]]; if (!s) process.exit(3); s.running = false; s.last_exit = 143; persist(); console.log('{}'); }\nelse process.exit(4);\n`,
    );
    chmodSync(executable, 0o700);
    const daemon = new ExecutionDaemon({
      databasePath: join(root, "node.sqlite"),
      nodeId: "node:test",
      nodeCredential: "node-secret-fixture",
      workspaces: [{ workspaceId: "workspace:test", directory: workspace }],
      rexExecutable: executable,
    });
    fixtures.push({ root, daemon });

    const request = {
      contractVersion: 1,
      processId: "process:isolated",
      nodeId: "node:test",
      target: { nodeId: "node:test", workspaceId: "workspace:test" },
      ownershipGeneration: 0,
      argv: [process.execPath, "-e", "await Bun.sleep(10000)"],
    };
    const launched = await daemon.rex.launch(request);
    expect(launched.status).toBe("running");
    expect(launched.sessionId).toBe("session-uzina-process:isolated");
    expect(launched.blockId).toBe("block-uzina-process:isolated");
    expect(await daemon.rex.inspect("process:isolated")).toMatchObject({
      status: "running",
    });
    expect(() => daemon.fenceWorkspace("workspace:test", 0, 1)).toThrow(
      "workspace_has_running_rex_processes",
    );
    const stopped = await daemon.rex.stop("process:isolated");
    expect(stopped.status).toBe("exited");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      "session-uzina-process:isolated": {
        block_id: "block-uzina-process:isolated",
        running: false,
        last_exit: 143,
      },
    });
    expect(() => daemon.fenceWorkspace("workspace:test", 0, 1)).not.toThrow();
  });
});
