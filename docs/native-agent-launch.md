# Local Pi and Codex launch profiles

The trusted standalone host can now start a **new interactive Pi or Codex session in Rex**, preparing its local Rex MCP configuration before process creation. It does not edit global agent settings, adopt an existing terminal, send keystrokes, or start an LLM turn.

This page describes the lower-level programmatic launch API. For coordinator-driven provisioning, dedicated worker credentials, both MCP connections, HTTP/client operations and the default local daemon composition, see [connected native worker provisioning](native-worker-provisioning.md). Neither path implements remote connected-executor provisioning claims. The raw host API supplies an already configured `ExecutionDaemon.nativeAgents` to `createStandaloneFactoryServer({ nativeAgentLauncher })`. The Factory's `launchNativeAgent` method authenticates the current human Owner and checks the project, selected workspace generation, and Core capture/relocation fences. The executor applies its own current workspace and capture fences immediately before Rex admission.

Core authorization is rechecked after asynchronous Rex connection discovery, immediately before the executor's synchronous intent admission. Revocation during preflight therefore cannot authorize a later process effect.

The lower-level executor launcher is trusted host code, like `executor.rex`; calling it directly is **not** a Factory authorization path. Process receipts are executor-local evidence, not authoritative Factory assignment/admission receipts. The raw launch method does not register a native worker or provision its Factory credential; the connected-worker provisioning workflow adds those steps over the same launcher.

## Configure the host

Use Bun 1.4.4, an existing local Unix-socket Rex server, and installed Pi or Codex executables. The live bootstrap check has exercised **Pi 1.5.2 and Codex 0.169.0**. Other versions are not an acceptance claim. Launch checks required CLI help flags; unsupported configuration, trust prompts, disabled MCP support, or failed authentication must not be reported as ready.

Read the exact escaped Rex endpoint from `rex --autostart=false whoami --json`. Configure absolute executable and entry-point paths. Build the daemon entry points with `bun run build:daemon`.

A trusted local composition constructs its executor with:

```ts
const executor = new ExecutionDaemon({
  databasePath: "/private/uzina/executor.sqlite",
  nodeId: "node:local",
  nodeCredential, // operator-held; never copied into the native agent bootstrap
  workspaces: [
    { workspaceId: "workspace:project", directory: "/work/project" },
  ],
  rexExecutable: "/absolute/path/to/rex",
  rexServer: "unix:///absolute/path/to/rex/server.sock",
  nativeAgents: {
    stateDirectory: "/private/uzina/native-agents",
    bunExecutable: "/absolute/path/to/bun",
    runnerEntry: "/absolute/path/to/uzina/build/daemon/native-agent.js",
    rexToolsEntry: "/absolute/path/to/uzina/build/daemon/rex-tools.js",
    profiles: {
      pi: { agent: "pi", executable: "/absolute/path/to/pi" },
      codex: { agent: "codex", executable: "/absolute/path/to/codex" },
    },
  },
});
```

For development, the entry points are `apps/daemon/src/native-agent.ts` and `apps/daemon/src/rex-tools.ts`. The host configures/provisions its Core project, node, workspace, models and owner identity as usual, and passes `nativeAgentLauncher: executor.nativeAgents` to its standalone Factory options. Merely starting `dev:daemon` without the opt-in native Factory configuration does **not** enable launch profiles.

Then call the authenticated host method:

```ts
const request = {
  requestId: "launch:worker-one",
  projectId: "project:one",
  profileId: "pi",
  target: { nodeId: "node:local", workspaceId: "workspace:project" },
  ownershipGeneration: 0,
};
const receipt = await factoryHost.launchNativeAgent({
  credential: ownerCredential, // only the trusted host handles this argument
  request,
  waitMs: 1000,
});
const refreshed = await factoryHost.inspectNativeAgent({
  credential: ownerCredential,
  request,
});
```

These are host function calls, **not** model tool arguments, shell commands, or public routes. Never put the Owner bearer in a worker prompt or MCP configuration. Launch requests contain only stable identity, a configured profile ID, project, target and generation. They cannot supply arbitrary executable paths, environment, argv, MCP URLs or credentials. A changed request under the same ID conflicts.

## Two configuration layers

Each launch has an owner-only directory outside every configured workspace, with immutable mode-0600 files and mode-0700 subdirectories:

- `rex/server.json` selects the canonical workspace, exact local Rex endpoint/executable, and a unique `rex/journal.sqlite` for this agent's local MCP host.
- `client.json` describes the generated client-side MCP binding for operator inspection.
- `launch.json` contains the native CLI argv and explicit environment. Treat it as secret when a profile supplies dedicated model credentials.
- Pi also gets `rex-mcp.ts` and a private `sessions/` directory. The small extension only calls `pi.registerMcpServer()`; it does not implement Rex operations or require other clients to use Pi libraries.

Pi runs its ordinary TUI with an initial pinned `--session-id`, private `--session-dir`, and explicit `--extension`. MCP tools use direct exposure. The standard Pi trust and permission behavior remains; a user/global `mcp.json` override or replacement MCP extension can prevent the server from connecting. The launcher does not override those choices. `offline: true` is an optional Pi-only profile setting.

Codex runs its ordinary TUI with `--no-daemon`, `--cd`, and invocation-local `--config mcp_servers.<unique-name>=...` overrides. The generated values contain only MCP executable/arguments/cwd and connection requirements, not bearer values. A live connection is required instead of a cached catalogue. There are no writes to `~/.codex/config.toml`, shared-server configuration, project trust, approval policy or sandbox settings.

The native agent itself starts the stdio MCP subprocess. There is no public local Rex HTTP service and no assumption that co-location discovers MCP automatically.

## Environment and authority

The Rex-launched Bun bootstrap replaces itself with the native CLI using `process.execve`, preserving the PTY and working directory. It refuses redirected/non-terminal streams rather than accidentally starting Pi print mode. No shell command string is constructed. Bun entry points run with `--no-env-file`.

Only basic user/path/locale/terminal/XDG environment values are inherited from the trusted launcher process. Provider keys, Factory/node credentials, parent native-session IDs and runtime preload options are not implicitly forwarded. The runner retains the **new Rex terminal's** `REX_SESSION`/`REX_BLOCK`, not the provisioner's ambient pane IDs. A profile may explicitly supply `environment` values such as `PI_CODING_AGENT_DIR`, `CODEX_HOME`, or a dedicated worker/model key. Factory/Uzina, Rex, parent Pi-session, and Node/Bun preload variables are reserved and refused. Do not configure an Owner, node, or coordinator credential under another name.

This is **not credential isolation or an OS sandbox**. Agents run as the local user, normally retain their native user configuration/authentication, and can access whatever that user can access. The Rex MCP server can execute commands with local OS-user authority; a native CLI's shell sandbox does not sandbox an external MCP server. Default trust/approval behavior is preserved, but loading the Rex server grants a substantial local capability. Use OS isolation if workers must not be able to read other local state.

Each live local Rex MCP host has its own journal. Do not reuse an execution/Factory database, share one journal between agents, or open the JSON CLI on a live MCP journal. See [local Rex authority and tool behavior](rex-tools.md).

The executor's capture fence sees the native CLI process it launched. Independent command jobs created through the local Rex MCP journal are **not** imported into that executor or made subject to Factory capture/placement fences. A stopped native CLI alone therefore does not prove workspace quiescence: its command jobs may continue independently. Reconcile/quiesce those jobs and any raw CLI writers before snapshotting; this launcher is not a complete native-worker capture adapter.

## What readiness proves

A process receipt and MCP observation are returned separately:

- `process` retains Rex's starting/running/exited/uncertain evidence. It does not claim native assignment admission or execution start.
- `mcp.status: pending` means there is no observed initialized MCP connection yet. Login/trust UI may still need the user's attention in Rex.
- `initialized` means the actual client completed the MCP initialization notification, but the Rex tool catalogue has not yet been served.
- `ready` means the server successfully wrote a catalogue containing `rex` to that initialized client, its local host is still observable, and fresh Rex process/server evidence is consistent.
- `disconnected` retains historical initialization/catalogue timestamps without treating them as a live connection. `unavailable` means observation failed; retain the process receipt and reconcile.

A connected-worker launch also returns separate `factoryMcp` evidence, the pinned `factoryOrigin`, and `factoryCoordination: true`; raw launches retain `factoryCoordination: false`. The Factory bridge verifies its dedicated worker identity before connecting. Raw process receipts still do not claim native activity. Connected Pi provisioning can additionally attach the [Pi delivery adapter](native-pi-delivery.md); its persisted admission and native-turn evidence are separately observed by Core. Codex stays manual.

Readiness is **MCP transport/catalogue evidence**, not proof that the model called a tool, that every tool is authorized/declared, that a task was accepted, or that the agent can continue unattended. Client names/versions are self-reported diagnostics. PID liveness and terminal presentation are not security attestations. No transcript or screen scraping is used to establish readiness.

The MCP journal stores the current connection epoch, bounded client identity, initialization time and successfully served catalogue time. Reconnecting must initialize and list tools again. Clean close/dead-host detection prevents a retained timestamp from becoming perpetual readiness. Observation uses read-only SQLite and does not open a second operation host.

## Recovery and shutdown

Private preparation is pinned before any Rex process effect. A restart can fill missing immutable files with the same bytes; conflicting, partial, symlinked or permissive files are refused, never repaired or overwritten. There are at most 4096 retained launch identities per executor, with no automatic pruning.

`RexProcessManager` in the **existing executor database** owns process intent and receipts, including single-effect admission. Overlapping retries reuse the same process ID. A lost response or interrupted launch stays uncertain; retrying does not regenerate a new session, replace bootstrap files, or invoke Rex again. A committed process receipt is replayed even if the configured launch profile was subsequently removed. The original Rex endpoint/instance is pinned; replacement or unavailable servers cannot refresh old evidence. Historical inspection is Owner/project-authorized without requiring the old generation to still be current; a new launch admission still requires current placement.

Waits are bounded to 30 seconds plus bounded Rex CLI observation latency. No permanent poller, supervisor, scheduler or model loop is added. The standalone host joins its finite launch/inspection calls on shutdown but does not own the supplied executor. Before closing that executor, await `executor.nativeAgents.close()` to drain observations. `executor.close()` refuses while native operations remain active. Neither closing the host nor ending an MCP connection stops native work or undoes effects. Stop/cleanup requires the separately authorized existing Rex lifecycle path and exact resource identities.

## Validation and remaining integration

The normal suite covers the Owner gate, placement/capture fences, immutable private preparation, credential omission, unsafe configurations, original-request conflicts, and lost-response recovery through real Core/standalone/SQLite/subprocess boundaries. The external Rex CLI is the substitute in that suite; the native runner correctly refuses its non-PTY streams. Real stdio MCP tests separately protect initialize/catalogue/close distinctions.

Run the installed-agent acceptance check explicitly:

```sh
UZINA_NATIVE_AGENT_INTEGRATION=1 bun test \
  apps/daemon/test/native-agents.integration.test.ts
```

To exercise the built runner and MCP bundle instead of source entry points, additionally set `UZINA_NATIVE_AGENT_ARTIFACT_DIRECTORY="$PWD/build/daemon"` after building.

It provisions through the real Factory and starts Pi and Codex TUIs in fresh Rex sessions with isolated agent homes, verifies both Rex and dedicated-worker-authenticated Factory MCP initialization/catalogue serving, verifies retry/reopen identity and capture refusal, then removes only its own exact scoped sessions and verifies MCP disconnection. Pi uses a private controlled provider extension to complete assignment → blocking question → Owner answer → file effect → report through its ordinary TUI; Codex uses a test-only loopback endpoint without inference. The test sends no terminal input, uses no paid provider authentication and does not modify the user's native settings.

[Connected worker provisioning](native-worker-provisioning.md) supplies the dedicated credential/bootstrap, coordination bridge and coordinator operation. Its Pi adapter adds safe delivery and original-conversation lifecycle fencing over the same records; raw launches and Codex still have no automatic-delivery adapter. Remote launch claims, arbitrary existing-session adoption, supervision and complete native capture quiescence remain separate. See [Pi evidence and recovery](native-pi-delivery.md) and [worker coordination](native-worker-coordination.md).
