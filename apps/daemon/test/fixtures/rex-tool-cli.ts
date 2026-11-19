// Only the external Rex CLI is substituted. Commands still execute in a real
// temporary workspace; SQLite, the operation host, MCP SDK and stdio are real.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.UZINA_REX_FIXTURE_STATE!;
const args = process.argv.slice(2);
if (
  args[0] !== "--autostart=false" ||
  args[1] !== "--server" ||
  args[2] !== "unix:///rex-test.sock"
)
  process.exit(4);
const [command, ...rest] = args.slice(3);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const persist = () => writeFileSync(statePath, JSON.stringify(state));
if (command === "whoami") {
  if (state.identityPausePath) {
    writeFileSync(`${state.identityPausePath}.entered`, "entered");
    const deadline = Date.now() + 5000;
    while (
      !existsSync(`${state.identityPausePath}.release`) &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
  }
  console.log(
    JSON.stringify({ endpoint: args[2], instance_id: state.instanceId }),
  );
} else if (command === "new") {
  state.launchCount = (state.launchCount ?? 0) + 1;
  // Let concurrent duplicate admissions overlap before the first response.
  await Bun.sleep(100);
  const separator = rest.indexOf("--");
  const cmd = rest.slice(separator + 1);
  let pid: number | undefined;
  let exitCode = 0;
  let output = "";
  const substituteNative =
    state.nativeClientEntry &&
    /(?:^|\/)native-agent\.(?:ts|js)$/.test(cmd[2] ?? "");
  if (
    substituteNative ||
    (state.backgroundEntry && cmd.includes(state.backgroundEntry))
  ) {
    const child = Bun.spawn({
      cmd: substituteNative
        ? cmd.map((part, index) =>
            index === 2 ? state.nativeClientEntry : part,
          )
        : cmd,
      env: substituteNative
        ? { ...process.env, NATIVE_TEST_DRIVER: state.nativeClientDirectory }
        : undefined,
      cwd: rest[rest.indexOf("--cwd") + 1],
      stdout: "ignore",
      stderr: "ignore",
    });
    pid = child.pid;
    child.unref();
  } else {
    const child = Bun.spawnSync({
      cmd,
      cwd: rest[rest.indexOf("--cwd") + 1],
      stdout: "pipe",
      stderr: "pipe",
    });
    exitCode = child.exitCode;
    output = Buffer.concat([child.stdout, child.stderr]).toString("utf8");
  }
  const sessionId = `session:${rest[0]}`;
  const blockId = `block:${rest[0]}`;
  state.jobs[sessionId] = {
    blockId,
    exitCode,
    output,
    ...(pid ? { pid } : {}),
  };
  const lose = state.loseNext;
  state.loseNext = false;
  persist();
  await Bun.sleep(state.replyDelayMs ?? 100);
  if (lose) process.exit(3);
  console.log(
    JSON.stringify({
      session_id: sessionId,
      initial_windows: [{ block_ids: [blockId] }],
    }),
  );
} else if (command === "session" && rest[0] === "inspect") {
  if (!state.jobs[rest[1]!]) process.exit(3);
  console.log(JSON.stringify({ session_id: rest[1] }));
} else if (command === "block" && rest[0] === "call") {
  const job = state.jobs[rest[rest.indexOf("--session") + 1]!];
  if (!job || job.blockId !== rest[rest.indexOf("--block") + 1])
    process.exit(3);
  let running = false;
  if (job.pid) {
    try {
      process.kill(job.pid, 0);
      running = true;
    } catch {}
  }
  console.log(
    JSON.stringify(
      running ? { running: true } : { last_exit: { exit_code: job.exitCode } },
    ),
  );
} else if (command === "capture") {
  const job = state.jobs[rest[rest.indexOf("--session") + 1]!];
  if (
    !job ||
    job.blockId !== rest[rest.indexOf("--block") + 1] ||
    state.captureFail
  ) {
    console.error("private-cli-stderr-must-not-leak");
    process.exit(3);
  }
  process.stdout.write(state.outputOverride ?? job.output);
} else process.exit(4);
