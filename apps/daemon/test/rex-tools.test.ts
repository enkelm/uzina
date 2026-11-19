import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RexToolHost, readRexMcpReadiness } from "../src/execution/rex-tools";

const entry = resolve(import.meta.dir, "../src/rex-tools.ts");
const fixtureEntry = resolve(import.meta.dir, "fixtures/rex-tool-cli.ts");
const roots: string[] = [];
const clients: Client[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "uzina-rex-tools-"));
  roots.push(root);
  const workspace = join(root, "workspace with spaces");
  const privateDirectory = join(root, "private");
  mkdirSync(workspace);
  mkdirSync(privateDirectory, { mode: 0o700 });
  const statePath = join(root, "rex-state.json");
  const initialState = {
    instanceId: "server:test-instance",
    jobs: {},
    loseNext: false,
    replyDelayMs: 100,
    captureFail: false,
  };
  writeFileSync(statePath, JSON.stringify(initialState));
  const executable = join(root, "rex-fixture");
  writeFileSync(
    executable,
    `#!/usr/bin/env bun\nprocess.env.UZINA_REX_FIXTURE_STATE = ${JSON.stringify(statePath)};\nawait import(${JSON.stringify(fixtureEntry)});\n`,
    { mode: 0o700 },
  );
  const config = {
    workspaceDirectory: workspace,
    journalPath: join(privateDirectory, "rex.sqlite"),
    server: "unix:///rex-test.sock",
    rexExecutable: executable,
  };
  const configPath = join(root, "rex.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const marker = join(workspace, "effects.txt");
  const argv = [
    process.execPath,
    "-e",
    'require("node:fs").appendFileSync("effects.txt", "effect\\n"); console.log("hello from the child");',
  ];
  const changeState = (patch: object) => {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, ...patch }));
  };
  return { root, workspace, config, configPath, marker, argv, changeState };
}

async function connect(configPath: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-env-file", entry, "mcp", "--config", configPath],
    stderr: "pipe",
  });
  const client = new Client({
    name: "agent-neutral-rex-client",
    version: "1.0.0",
  });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}

async function call(client: Client, input: Record<string, unknown>) {
  const response = await client.callTool({ name: "rex", arguments: input });
  return {
    response,
    data: response.structuredContent as Record<string, any> | undefined,
  };
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("stdio MCP exposes one reusable Rex tool, CLI fallback policy, bounded output and duplicate-safe command jobs", async () => {
  const f = fixture();
  const { client } = await connect(f.configPath);
  // Initialization alone is not a served tool catalogue, and neither is a model turn.
  const initializedDeadline = Date.now() + 1000;
  while (
    readRexMcpReadiness(f.config.journalPath).status === "pending" &&
    Date.now() < initializedDeadline
  )
    await Bun.sleep(10);
  expect(readRexMcpReadiness(f.config.journalPath).status).toBe("initialized");
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "rex",
  ]);
  const catalogDeadline = Date.now() + 1000;
  while (
    readRexMcpReadiness(f.config.journalPath).status !== "ready" &&
    Date.now() < catalogDeadline
  )
    await Bun.sleep(10);
  expect(readRexMcpReadiness(f.config.journalPath)).toMatchObject({
    status: "ready",
    client: { name: "agent-neutral-rex-client" },
  });
  expect(client.getInstructions()).toContain("Tool-first, not tool-only");
  expect(client.getInstructions()).toContain("rex COMMAND --help");
  expect(client.getInstructions()).toContain(
    "not denied authority or uncertain mutations",
  );
  const context = await call(client, { op: "context" });
  expect(context.data?.result).toMatchObject({
    authority: "local-os-user",
    presentation: "dedicated-session",
    server: f.config.server,
  });

  const input = { op: "run", requestId: "verify:one", argv: f.argv };
  const [first, concurrent] = await Promise.all([
    call(client, input),
    call(client, input),
  ]);
  expect(first.response.isError).not.toBe(true);
  expect(concurrent.response.isError).not.toBe(true);
  expect(readFileSync(f.marker, "utf8")).toBe("effect\n");
  const completed = [first, concurrent].find(
    (result) => result.data?.result.receipt.status === "exited",
  );
  expect(completed?.data?.result.receipt).toMatchObject({
    status: "exited",
    exitCode: 0,
  });
  expect(concurrent.data?.result.receipt.processId).toBe(
    first.data?.result.receipt.processId,
  );
  expect(completed?.data?.result.output).toMatchObject({
    kind: "terminal_snapshot",
    text: "hello from the child",
    truncated: false,
  });
  const retry = await call(client, { ...input, waitMs: 1, maxBytes: 256 });
  expect(retry.data?.result.receipt.sessionId).toBe(
    completed?.data?.result.receipt.sessionId,
  );
  expect(readFileSync(f.marker, "utf8")).toBe("effect\n");
  const conflict = await call(client, {
    ...input,
    argv: [...f.argv, "changed"],
  });
  expect(conflict.data).toEqual({ error: "process_id_payload_conflict" });

  f.changeState({
    outputOverride:
      "old\n".repeat(100_000) + "\u001b[31mlast é\u001b[0m\nfinal\n",
  });
  const output = await call(client, {
    op: "output",
    requestId: "verify:one",
    tailLines: 2,
    maxBytes: 256,
  });
  expect(output.data?.result).toMatchObject({
    kind: "terminal_snapshot",
    text: "last é\nfinal",
    truncated: true,
  });
  expect(Buffer.byteLength(output.data?.result.text)).toBeLessThanOrEqual(256);
  const foreign = await call(client, {
    op: "output",
    requestId: "not-this-hosts-job",
  });
  expect(foreign.data).toEqual({ error: "rex_process_not_found" });
  const invalid = await call(client, {
    op: "inspect",
    requestId: "verify:one",
    sessionId: "some-other-session",
  });
  expect(invalid.response.isError).toBe(true);

  f.changeState({ captureFail: true });
  const admitted = await call(client, { ...input, requestId: "verify:two" });
  expect(admitted.response.isError).not.toBe(true);
  expect(admitted.data?.result).toMatchObject({
    receipt: { status: "exited", exitCode: 0 },
    outputError: "rex_output_unavailable",
  });
  expect(JSON.stringify(admitted.response)).not.toContain("private-cli-stderr");
  // Closing a presentation through raw CLI must not erase committed exit evidence.
  f.changeState({ jobs: {} });
  const retained = await call(client, {
    op: "inspect",
    requestId: input.requestId,
  });
  expect(retained.data?.result.receipt).toMatchObject({
    status: "exited",
    exitCode: 0,
  });
  await client.close();
  const closeDeadline = Date.now() + 1000;
  while (
    readRexMcpReadiness(f.config.journalPath).status === "ready" &&
    Date.now() < closeDeadline
  )
    await Bun.sleep(10);
  expect(readRexMcpReadiness(f.config.journalPath).status).toBe("disconnected");
}, 15_000);

test("a lost Rex launch response survives reopen without another external effect", async () => {
  const f = fixture();
  f.changeState({ loseNext: true });
  const first = await connect(f.configPath);
  const input = { op: "run", requestId: "verify:lost-response", argv: f.argv };
  const lost = await call(first.client, input);
  expect(lost.response.isError).not.toBe(true);
  expect(lost.data?.result.receipt).toMatchObject({ status: "uncertain" });
  expect(readFileSync(f.marker, "utf8")).toBe("effect\n");
  await first.client.close();
  const reopened = await connect(f.configPath);
  const retry = await call(reopened.client, input);
  expect(retry.data?.result.receipt).toMatchObject({ status: "uncertain" });
  expect(retry.data?.result.receipt.processId).toBe(
    lost.data?.result.receipt.processId,
  );
  expect(readFileSync(f.marker, "utf8")).toBe("effect\n");
  f.changeState({ instanceId: "server:replaced-after-admission" });
  const stale = await call(reopened.client, input);
  expect(stale.response.isError).not.toBe(true);
  expect(stale.data?.result).toMatchObject({
    receipt: { status: "uncertain" },
    observationError: "rex_observation_unavailable",
  });
  const inspect = await call(reopened.client, {
    op: "inspect",
    requestId: input.requestId,
  });
  expect(inspect.data?.result).toMatchObject({
    receipt: { status: "uncertain" },
    observationError: "rex_observation_unavailable",
  });
  expect(readFileSync(f.marker, "utf8")).toBe("effect\n");
}, 15_000);

test("process loss after the command effect retains uncertain admission instead of replaying it", async () => {
  const f = fixture();
  f.changeState({ replyDelayMs: 700 });
  const { client, transport } = await connect(f.configPath);
  const input = { op: "run", requestId: "verify:crash", argv: f.argv };
  const pending = call(client, input).catch(() => undefined);
  const deadline = Date.now() + 5000;
  while (!existsSync(f.marker) && Date.now() < deadline) await Bun.sleep(10);
  expect(readFileSync(f.marker, "utf8")).toBe("effect\n");
  const ownedPid = transport.pid;
  expect(ownedPid).not.toBeNull();
  process.kill(ownedPid!, "SIGKILL");
  await pending;
  await client.close();
  const reopened = await connect(f.configPath);
  const retry = await call(reopened.client, input);
  expect(retry.data?.result.receipt).toMatchObject({
    status: "uncertain",
    errorCode: "interrupted_during_lifecycle",
  });
  expect(readFileSync(f.marker, "utf8")).toBe("effect\n");
  // Let the isolated external-CLI fixture finish its delayed, now-lost reply.
  await Bun.sleep(750);
}, 15_000);

test("local bindings refuse journal sharing, server replacement and workspace rebinding; JSON CLI uses the same journal", async () => {
  const f = fixture();
  const { client } = await connect(f.configPath);
  await expect(RexToolHost.open(f.config)).rejects.toThrow(
    "rex_journal_in_use",
  );
  await expect(
    RexToolHost.open({ ...f.config, workspaceDirectory: f.root }),
  ).rejects.toThrow("rex_journal_inside_workspace");
  await expect(
    RexToolHost.open({
      ...f.config,
      server: "https://not-a-local-rex.example",
    }),
  ).rejects.toThrow("invalid_rex_configuration");
  const otherWorkspace = join(f.root, "other");
  mkdirSync(otherWorkspace);
  await expect(
    RexToolHost.open({ ...f.config, workspaceDirectory: otherWorkspace }),
  ).rejects.toThrow("rex_journal_binding_conflict");
  f.changeState({ instanceId: "server:replacement" });
  const changed = await call(client, {
    op: "run",
    requestId: "must-not-run",
    argv: f.argv,
  });
  expect(changed.data).toEqual({ error: "rex_server_identity_changed" });
  expect(existsSync(f.marker)).toBe(false);
  await client.close();
  f.changeState({ instanceId: "server:test-instance" });

  const command = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      entry,
      "call",
      "--config",
      f.configPath,
    ],
    stdin: new Blob([
      JSON.stringify({ op: "run", requestId: "cli:one", argv: f.argv }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(command.stdout).text();
  expect(await command.exited).toBe(0);
  expect(JSON.parse(text).result.receipt).toMatchObject({
    status: "exited",
    exitCode: 0,
  });
  const reopened = await connect(f.configPath);
  const receipt = await call(reopened.client, {
    op: "inspect",
    requestId: "cli:one",
  });
  expect(receipt.data?.result.receipt.sessionId).toBe(
    JSON.parse(text).result.receipt.sessionId,
  );
  expect(readFileSync(f.marker, "utf8")).toBe("effect\n");
  await reopened.client.close();
  chmodSync(f.config.journalPath, 0o644);
  await expect(RexToolHost.open(f.config)).rejects.toThrow(
    "rex_journal_not_private",
  );
}, 15_000);
