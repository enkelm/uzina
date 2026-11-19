import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FactoryClient } from "@uzina/client";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { createFactoryBotExtension } from "@uzina/pi-runtime";
import { openBunSqliteStorage } from "../src/runtime/sqlite";
import { factoryBotTestModels } from "../../../packages/pi-runtime/test-support/factory-bot-model";
import { nativeDeliveryText } from "@uzina/contracts/assignments";
import type { Goal } from "../../../packages/pi-runtime/src/factory-bot-state";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(
        "Default startup did not reach the expected observable state",
      );
    await Bun.sleep(25);
  }
}

test("built default CLI needs no Factory configuration: local placement, delegated provisioning, recovery and fail-closed setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "uzina-default-startup-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  const artifact = join(root, "artifact");
  const driver = join(root, "driver");
  for (const path of [
    home,
    workspace,
    bin,
    driver,
    join(driver, "requests"),
    join(driver, "responses"),
    join(workspace, "bin"),
    join(home, ".pi/agent"),
  ])
    mkdirSync(path, { recursive: true });
  // Existing native Pi sign-in, not Factory feature configuration. Native turns use controlled responses only.
  writeFileSync(
    join(driver, "plan.json"),
    JSON.stringify({
      forbiddenArgv: [
        process.execPath,
        "--eval",
        "require('node:fs').writeFileSync('forbidden.txt','unsafe')",
      ],
      effectArgv: [
        process.execPath,
        "--eval",
        "require('node:fs').appendFileSync('result.txt','verified\\n')",
      ],
    }),
  );
  writeFileSync(
    join(home, ".pi/agent/auth.json"),
    JSON.stringify({
      openai: { type: "api_key", key: "startup-test-not-a-real-key" },
    }),
  );
  const built = Bun.spawnSync(
    [process.execPath, "run", "build:daemon", "--outdir", artifact],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(built.exitCode).toBe(0);
  symlinkSync(process.execPath, join(bin, "bun"));
  const statePath = join(root, "rex.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      instanceId: "server:startup",
      jobs: {},
      nativeClientEntry: resolve(
        import.meta.dir,
        "fixtures/native-session-client.ts",
      ),
      nativeClientDirectory: driver,
    }),
  );
  const rex = join(bin, "rex");
  writeFileSync(
    rex,
    `#!${process.execPath}\nprocess.env.UZINA_REX_FIXTURE_STATE = ${JSON.stringify(statePath)};\nif (process.argv[2] === "whoami") process.argv.splice(2, 0, "--autostart=false", "--server", "unix:///rex-test.sock");\nawait import(${JSON.stringify(resolve(import.meta.dir, "fixtures/rex-tool-cli.ts"))});\n`,
    { mode: 0o700 },
  );
  for (const agent of ["pi", "codex"]) {
    writeFileSync(
      join(bin, agent),
      '#!/bin/sh\nprintf "%s\\n" "--extension --session-id --session-dir --config --cd --no-daemon"\n',
      { mode: 0o700 },
    );
    // A checkout must not get to supply the trusted executable allowlist.
    writeFileSync(
      join(workspace, "bin", agent),
      `#!/bin/sh\ntouch ${JSON.stringify(join(workspace, "untrusted-executable-ran"))}\n`,
      { mode: 0o700 },
    );
  }
  const env = {
    HOME: home,
    PATH: `${join(workspace, "bin")}:${bin}:/usr/bin:/bin`,
    LANG: "en_US.UTF-8",
    TMPDIR: tmpdir(),
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output = "";
  const start = async () => {
    output = "";
    // No application arguments, UZINA_* variables, PORT override, or operator JSON.
    child = Bun.spawn([process.execPath, join(artifact, "index.js")], {
      cwd: workspace,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (stream && typeof stream !== "number")
        void stream.pipeTo(
          new WritableStream({
            write(chunk) {
              output = (output + new TextDecoder().decode(chunk)).slice(
                -16_000,
              );
            },
          }),
        );
    }
    await until(() => {
      if (child!.exitCode !== null)
        throw new Error(
          `Default CLI exited before listening: ${output.replace(/token=[^\s]+/g, "token=[redacted]")}`,
        );
      return output.includes("Uzina standalone Factory listening at");
    });
  };
  const stop = async () => {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (child) expect(await child.exited).toBe(0);
    child = undefined;
  };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const baseUrl = "http://127.0.0.1:8788";
  const data = join(home, ".local/share/uzina");
  const database = join(data, "factory.sqlite");
  try {
    await start();
    const ownerBearer = readFileSync(`${database}.owner-token`, "utf8").trim();
    const owner = new FactoryClient({ baseUrl, credential: ownerBearer });
    const assistant = JSON.parse(
      readFileSync(`${database}.assistant-identity`, "utf8"),
    );
    const client = new FactoryClient({ baseUrl, credential: assistant.bearer });
    const project = await owner.createProject("Default project");
    const another = await owner.createProject("Created after startup");
    const nodes = await owner.listNodes();
    const workspaces = await owner.listWorkspaces();
    expect(nodes.nodes).toHaveLength(1);
    expect(nodes.nodes[0]!.availability).toBe("online");
    expect(workspaces.workspaces).toHaveLength(1);
    const targets = await client.listNativeWorkerTargets(project.projectId);
    expect(targets.targets).toHaveLength(1);
    expect(targets.targets[0]).toMatchObject({
      targetId: "local",
      profileIds: ["pi", "codex"],
      allowAssistant: true,
      target: {
        nodeId: nodes.nodes[0]!.nodeId,
        workspaceId: workspaces.workspaces[0]!.workspaceId,
      },
    });
    expect(
      (await client.listNativeWorkerTargets(another.projectId)).targets[0]!
        .projectId,
    ).toBe(another.projectId);
    const request = {
      requestId: "default:worker",
      projectId: project.projectId,
      targetId: "local",
      profileId: "pi",
      name: "Default worker",
    };
    await client.provisionNativeWorker(request);
    let ready = await client.getNativeWorkerProvisioning(request.requestId);
    await until(async () => {
      if (existsSync(join(driver, "failure")))
        throw new Error(readFileSync(join(driver, "failure"), "utf8"));
      ready = await client.getNativeWorkerProvisioning(request.requestId);
      return ready.status === "ready";
    });
    expect(ready.mcp?.rex.status).toBe("ready");
    expect(ready.mcp?.factory.verifiedAt).toBeString();
    expect(state().launchCount).toBe(1);
    expect(readdirSync(workspace)).toEqual(["bin"]);
    const localRoot = join(
      `${database}.local-execution`,
      readdirSync(`${database}.local-execution`)[0]!,
    );
    const identityPath = join(localRoot, "identity.json");
    const identity = readFileSync(identityPath, "utf8");
    expect(statSync(identityPath).mode & 0o777).toBe(0o600);
    expect(statSync(localRoot).mode & 0o777).toBe(0o700);
    const publicResult = JSON.stringify({ ready, targets });
    for (const secret of [
      ownerBearer,
      assistant.bearer,
      JSON.parse(identity).credential,
    ])
      expect(publicResult).not.toContain(secret);

    // Real Pi session engine + generated extension, from default startup. Only the model and external Rex PTY are substituted.
    const scope = readdirSync(
      join(localRoot, "native-agents", "factory-workers"),
    )[0]!;
    const workerDirectory = join(
      localRoot,
      "native-agents",
      "factory-workers",
      scope,
      createHash("sha256").update(request.requestId).digest("hex"),
    );
    const privateConfig = JSON.parse(
      readFileSync(join(workerDirectory, "server.json"), "utf8"),
    );
    const worker = new FactoryClient({
      baseUrl,
      credential: privateConfig.credential,
    });
    await until(async () => {
      if (existsSync(join(driver, "failure")))
        throw new Error(readFileSync(join(driver, "failure"), "utf8"));
      return (
        (await worker.getWorkerRuntime()).worker.activity?.state === "armed"
      );
    });
    expect(
      (await client.getNativeWorkerProvisioning(request.requestId)).capabilities
        .automaticDelivery,
    ).toBe(true);
    const registry = createRegistry();
    registry.install(
      createFactoryBotExtension(client, {
        credentialToRedact: assistant.bearer,
      }),
    );
    let clock = Date.now(),
      command = 0;
    const bot = await Harness.open(
      await openBunSqliteStorage(join(root, "bot.sqlite")),
      { registry, models: factoryBotTestModels().models, now: () => clock },
      context,
    );
    const conversation = await bot.root(context, {
      agent: { model: { provider: "uzina-test", modelId: "fixed-model" } },
    });
    bot.resume();
    async function board(args: JsonObject) {
      const submission = await conversation.submit(
        {
          type: "input",
          requestId: `native-board:${++command}`,
          content: JSON.stringify({ tool: "factory_board", args }),
        },
        context,
      );
      const done = await submission.wait(context);
      if (done.type === "write" || done.status !== "done")
        throw new Error("Native board command did not settle");
      const view = await conversation.context(context, { at: done.answer });
      const answer = view.messages.at(-1);
      if (answer?.role !== "assistant" || answer.content[0]?.type !== "text")
        throw new Error("No native board result");
      const result = JSON.parse(answer.content[0].text);
      if (result.error)
        throw new Error(`Board ${args.op}: ${JSON.stringify(result.value)}`);
      return result.value;
    }
    async function control(op: string, extra: Record<string, string> = {}) {
      const id = `control-${++command}`;
      const temporary = join(driver, "control.tmp");
      writeFileSync(temporary, JSON.stringify({ id, op, ...extra }));
      renameSync(temporary, join(driver, "control.json"));
      await until(() => {
        if (existsSync(join(driver, "failure")))
          throw new Error(readFileSync(join(driver, "failure"), "utf8"));
        return existsSync(join(driver, `control-${id}.json`));
      });
    }
    let completedNativeRequest = "";
    try {
      // Older unrelated instructions must not hide the one assignment or its blocking answer behind a bounded inbox page.
      for (let index = 0; index < 25; index++)
        await client.messageNativeWorker(ready.workerId, {
          requestId: `unrelated:${index}`,
          text: "Unrelated manual instruction; do not automatically execute.",
        });
      const capture = await board({
        op: "capture",
        projectId: project.projectId,
        title: "Native loop",
        brief: {
          objective: "Write the Owner-authorized text once",
          inputs: [],
          deliverables: ["result.txt"],
          acceptance: ["result.txt contains verified text exactly once"],
          constraints: ["Ask the blocking question first"],
        },
      });
      let goal = capture.card as Goal;
      await board({
        op: "dispatch",
        cardId: goal.cardId,
        expectedRevision: goal.revision,
        target: { kind: "native", workerId: ready.workerId },
      });
      await until(async () => {
        const status = await worker.getWorkerRuntime();
        if (status.worker.activity?.state === "paused")
          throw new Error(
            `Native loop paused: ${JSON.stringify({ activity: status.worker.activity, assignment: status.assignment?.status, model: existsSync(join(driver, "model-requests.json")) ? readFileSync(join(driver, "model-requests.json"), "utf8") : "none", error: existsSync(join(driver, "extension-error")) ? readFileSync(join(driver, "extension-error"), "utf8") : "none" })}`,
          );
        return (
          await client.listCoordinationItems(project.projectId)
        ).items.some((item) => item.itemId === "question:native-loop");
      });
      const started = await worker.getWorkerRuntime();
      expect(started.assignment?.status).toBe("started");
      expect(started.assignment?.admission?.entryId).toBeString();
      const competing = {
        ...started.assignment!.assignment,
        cardId: "competing:card",
        report: {
          ...started.assignment!.assignment.report,
          itemId: "report:competing",
        },
      };
      await expect(
        client.messageNativeWorker(ready.workerId, {
          requestId: "competing:assignment",
          text: JSON.stringify(competing),
          assignment: competing,
        }),
      ).rejects.toMatchObject({ code: "native_assignment_active" });
      await expect(
        worker.postWorkerItem({
          itemId: started.assignment!.assignment.report.itemId,
          kind: "report",
          title: "Premature report",
          text: "The blocking question has not been answered.",
          blocking: false,
        }),
      ).rejects.toMatchObject({ code: "native_assignment_blocked" });
      expect(existsSync(join(workspace, "forbidden.txt"))).toBe(false);
      expect(existsSync(join(workspace, "result.txt"))).toBe(false);
      const beforeAnswer = JSON.parse(
        readFileSync(join(driver, "model-requests.json"), "utf8"),
      );
      expect(beforeAnswer.requests).toBe(1);
      await client.decideCoordinationItem("question:native-loop", {
        requestId: "native:escalate",
        action: "escalate",
        text: "Owner must select the result",
      });
      await owner.decideCoordinationItem("question:native-loop", {
        requestId: "native:answer",
        action: "answer",
        text: "Write verified followed by one newline.",
      });
      await until(async () => {
        const status = await worker.getWorkerRuntime();
        if (status.worker.activity?.state !== "armed")
          throw new Error(
            `Native continuation stopped: ${JSON.stringify({ activity: status.worker.activity, blocking: status.blockingItems, model: readFileSync(join(driver, "model-requests.json"), "utf8"), error: existsSync(join(driver, "extension-error")) ? readFileSync(join(driver, "extension-error"), "utf8") : "none" })}`,
          );
        return (
          await client.listCoordinationItems(project.projectId)
        ).items.some((item) => item.kind === "report");
      });
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe(
        "verified\n",
      );
      expect(existsSync(join(workspace, "forbidden.txt"))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(driver, "model-requests.json"), "utf8"))
          .requests,
      ).toBe(3);
      clock += 31_000;
      bot.resume();
      await until(async () => {
        goal = (await board({ op: "view", cardId: goal.cardId })).card;
        return goal.state === "review";
      });
      await board({
        op: "accept",
        cardId: goal.cardId,
        expectedRevision: goal.revision,
        review: [
          {
            criterion: "result.txt contains verified text exactly once",
            evidence: `coordination:${goal.attempt!.resultItemId}`,
            note: "Read the produced file and verified a single line.",
          },
        ],
      });
      const accepted = await board({ op: "view", cardId: goal.cardId });
      expect(accepted.card.state).toBe("complete");
      expect(accepted.nativeReceipt).toMatchObject({
        status: "reported",
        admission: { entryId: started.assignment!.admission!.entryId },
      });
      completedNativeRequest = goal.attempt!.requestId;
      const runtime = await worker.getWorkerRuntime();
      expect(runtime.assignment).toBeNull();
      const sessionFile = JSON.parse(
        readFileSync(join(driver, "started"), "utf8"),
      ).sessionFile;
      const transcript = readFileSync(sessionFile, "utf8");
      expect(transcript.split("uzina.assignment.v1").length - 1).toBe(1);
      expect(transcript).not.toContain(privateConfig.credential);
      // Escape/manual stop, reload and different conversations cannot silently restart queued work.
      await control("escape");
      expect(
        (await client.getNativeWorkerProvisioning(request.requestId))
          .capabilities,
      ).toMatchObject({ automaticDelivery: false, nativeActivity: true });
      const queued = await board({
        op: "capture",
        projectId: project.projectId,
        title: "Queued after pause",
        brief: {
          objective: "Wait for explicit resume",
          inputs: [],
          deliverables: ["No automatic effect"],
          acceptance: ["Manual stop is respected"],
          constraints: [],
        },
      });
      await board({
        op: "dispatch",
        cardId: queued.card.cardId,
        expectedRevision: queued.card.revision,
        target: { kind: "native", workerId: ready.workerId },
      });
      await until(
        async () =>
          (await worker.getWorkerRuntime()).assignment?.status === "queued",
      );
      await control("reload");
      await Bun.sleep(750);
      expect((await worker.getWorkerRuntime()).worker.activity?.state).toBe(
        "paused",
      );
      expect(
        (await worker.getWorkerRuntime()).assignment?.admission,
      ).toBeNull();
      expect(
        JSON.parse(readFileSync(join(driver, "model-requests.json"), "utf8"))
          .requests,
      ).toBe(3);
      // A private journal cannot invent admission: the executor independently verifies the actual native JSONL bytes.
      const activityPath = privateConfig.nativeDelivery.statePath;
      const originalActivity = readFileSync(activityPath, "utf8");
      const forgedActivity = JSON.parse(originalActivity);
      const pendingMessage = (await worker.getWorkerRuntime()).mailbox
        .messages[0]!;
      forgedActivity.deliveries.push({
        messageId: pendingMessage.messageId,
        payloadSha256: createHash("sha256")
          .update(nativeDeliveryText(pendingMessage))
          .digest("hex"),
        entryId: started.assignment!.admission!.entryId,
        admittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });
      writeFileSync(activityPath, JSON.stringify(forgedActivity));
      const refusedEvidence = await worker.getWorkerRuntime();
      expect(refusedEvidence.assignment?.status).toBe("queued");
      expect(refusedEvidence.assignment?.admission).toBeNull();
      expect(
        refusedEvidence.mailbox.messages.map((message) => message.messageId),
      ).toContain(pendingMessage.messageId);
      writeFileSync(activityPath, originalActivity); // Restore the adversarial fixture, not production repair.
      await control("fork", {
        entryId: started.assignment!.admission!.entryId,
      });
      expect((await worker.getWorkerRuntime()).worker.activity?.state).toBe(
        "detached",
      );
      await control("switch", { path: sessionFile });
      expect((await worker.getWorkerRuntime()).worker.activity?.state).toBe(
        "paused",
      );
      await control("new");
      expect((await worker.getWorkerRuntime()).worker.activity?.state).toBe(
        "detached",
      );
      await control("switch", { path: sessionFile });
      expect((await worker.getWorkerRuntime()).worker.activity?.state).toBe(
        "paused",
      );
      expect(
        JSON.parse(readFileSync(join(driver, "model-requests.json"), "utf8"))
          .requests,
      ).toBe(3);
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe(
        "verified\n",
      );
      await control("resume");
      await until(
        async () =>
          (await worker.getWorkerRuntime()).worker.activity?.reason ===
          "native_report_missing",
      );
      expect((await worker.getWorkerRuntime()).assignment?.status).toBe(
        "started",
      );
      await Bun.sleep(750);
      expect(
        JSON.parse(readFileSync(join(driver, "model-requests.json"), "utf8"))
          .requests,
      ).toBe(4);
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe(
        "verified\n",
      );
    } finally {
      await bot.close(context);
    }
    expect(state().launchCount).toBe(2); // Native worker + the one admitted workspace command.

    // A removed profile is not permission to replace an admitted process.
    await stop();
    for (const agent of ["pi", "codex"])
      renameSync(join(bin, agent), join(bin, `${agent}.removed`));
    await start();
    expect((await client.provisionNativeWorker(request)).workerId).toBe(
      ready.workerId,
    );
    expect(state().launchCount).toBe(2);
    expect(
      (await client.getCoordinationReceipt(completedNativeRequest)).message
        ?.native,
    ).toMatchObject({ status: "reported", startedAt: expect.any(String) });
    expect(readFileSync(identityPath, "utf8")).toBe(identity);
    expect((await owner.listNodes()).nodes).toHaveLength(1);
    expect(
      (await client.listNativeWorkerTargets(project.projectId)).targets[0]!
        .profileIds,
    ).toEqual([]);

    // Missing dependencies are diagnosed, not a disabled feature or a new config prerequisite.
    await stop();
    renameSync(rex, `${rex}.removed`);
    await start();
    await expect(
      client.listNativeWorkerTargets(project.projectId),
    ).rejects.toMatchObject({ status: 503, code: "native_rex_not_installed" });
    const retained = await client.getNativeWorkerProvisioning(
      request.requestId,
    );
    expect(retained.workerId).toBe(ready.workerId);
    expect(retained.errorCode).toBe("native_rex_not_installed");
    expect(state().launchCount).toBe(2);
    const credentialsResponse = await fetch(`${baseUrl}/v1/credentials`, {
      headers: { authorization: `Bearer ${ownerBearer}` },
    });
    const credentials = (await credentialsResponse.json()) as {
      credentials: Array<{ credentialId: string; actor: { kind: string } }>;
    };
    const nodeCredentialId = credentials.credentials.find(
      (row) => row.actor.kind === "node",
    )!.credentialId;
    expect(
      (
        await fetch(`${baseUrl}/v1/credentials/${nodeCredentialId}/revoke`, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerBearer}` },
        })
      ).ok,
    ).toBe(true);
    await stop();
    child = Bun.spawn([process.execPath, join(artifact, "index.js")], {
      cwd: workspace,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(1);
    expect(readFileSync(identityPath, "utf8")).toBe(identity);
    expect(state().launchCount).toBe(2);
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    for (const job of Object.values(state().jobs) as Array<{ pid?: number }>) {
      if (job.pid) {
        try {
          process.kill(job.pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
      }
    }
    await until(() =>
      Object.values(state().jobs).every((job: any) => {
        try {
          process.kill(job.pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
    );
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
