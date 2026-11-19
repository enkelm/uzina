# Provisioning connected native Factory workers

The local Factory can now provision a dedicated worker, launch ordinary **Pi or Codex** in Rex, and attach two private stdio MCP connections:

- **`rex`**: local command mechanics under the OS user's authority.
- **`factory`**: questions, reports, inbox and acknowledgements under one dedicated worker credential.

The private Pi Durable coordinator uses **`factory_board`**, not another scheduler or a wider tool menu. Provisioning creates no managed Work conversation and imports no native transcript. This is local standalone composition; the Cloudflare/connected-executor compositions do not implement remote provisioning claims.

## Default local startup

Run the normal daemon from the checkout you want to use as its local workspace:

```sh
bun run dev:daemon
```

Or, after `bun run build`, run `bun build/daemon/index.js`. No application arguments, native-worker environment variable, operator JSON, manual node provisioning or copied node credential are required. The usual Pi sign-in/model resolution still applies; startup makes no model request.

Startup creates and reuses a dedicated local Execution node and canonical cwd-bound workspace. Its private identity is retained _before_ Core admission, so interrupted setup can recover without losing its credential. Core setup is idempotent and refuses a revoked node credential, mismatched identity or transferred/fenced workspace instead of regranting or reclaiming it. The existing execution loop registers, heartbeats and services that node; there is no new scheduler.

Installed `pi`, `codex` and `rex` are resolved from the host PATH at startup, excluding relative PATH entries and executables inside the selected checkout. These become trusted fixed launch profiles; model/HTTP requests still cannot select executables, paths, argv, credentials or MCP URLs. CLI compatibility is checked at launch. Rex's official discovery/autostart finds its endpoint, which the executor then pins; startup does not create any native worker/session. Missing Rex returns `native_rex_not_installed`, failed discovery returns `native_rex_discovery_failed`, and absent native CLIs are omitted from available profile IDs. The Factory UI and local node still start. Install/sign in to the desired CLI and restart; no capability-specific configuration is needed.

Each project visible to the caller gets a `local` target with the installed profile IDs, eight-worker capacity and assistant delegation. Core's current project write grants, placement generation, revocation and capture fences remain authoritative. Discovery itself requires current project access. Starting the Factory is not authorization to launch a worker; the Owner must commit to provisioning through the coordinator or authenticated API.

Private setup lives under `<factory database>.local-execution/<Factory-and-cwd hash>/`: a mode-0600 immutable `identity.json`, executor SQLite, and private native-agent/MCP state under mode-0700 directories. It stays outside the selected checkout. Unsafe, partial, symlinked, permissive or conflicting identity files are refused, not repaired. A different startup directory gets a different local placement and executor state; it does not adopt workers from another checkout. Restart from the original directory to reconcile those launches. A workspace containing the Factory's private state is refused.

Use a stable Factory origin/port across restarts. Private per-launch MCP bindings are immutable. A changed origin produces `factory_origin_changed`, not a silently redirected worker or a replacement process. Restore the original origin or use a separately authorized lifecycle/reprovisioning procedure; do not edit a live worker's private files.

Programmatic compositions can still supply explicit trusted profiles, mappings and delegation instead of the CLI's automatic setup:

```ts
createStandaloneFactoryServer({
  // ...ordinary Factory/model/runtime options...
  nativeWorkerProvisioning: {
    launcher: executor.nativeAgents,
    factoryWorkerEntry: "/absolute/path/to/build/daemon/factory-worker.js",
    targets: configuredTargets,
  },
});
```

The standalone host supplies its actual loopback origin and persisted Core provisioning namespace. It drains its finite provisioning operations on close; a programmatic caller still owns the supplied executor and must drain `executor.nativeAgents.close()` before `executor.close()`. The default CLI composition does this itself. Closing either host does not stop Rex sessions or command jobs.

## Coordinator workflow and authority

1. `factory_board` with `op: "view"`, `projectId`, `section: "targets"` discovers configured target/profile IDs. Reads require current project access.
2. After the Owner commits to provisioning, `op: "provision"` takes only `projectId`, `targetId`, `profileId`, and `name`. It atomically commits a stable request, retained command result and bounded background Pi Durable task, then returns promptly.
3. The task reconciles the original Core request before retrying. It reserves a dedicated credential/worker, prepares the existing launcher and observes process/MCP evidence.
4. View with `provisioningRequestId` to refresh the original Core/process/MCP receipt. The project `provisioning` section lists **retained task outcomes**, not continuous liveness.
5. Only after current readiness, use the returned `workerId` as a native dispatch target on a captured goal.

After restoring access/configuration, explicitly resume a blocked/uncertain provisioning task with `op: "provision"`, its **original `requestId`**, and unchanged `projectId`, `targetId`, `profileId` and `name`. The coordinator requires its retained matching record and reuses the same Core worker/launch identities. An already-active task is returned rather than duplicated. This is not a replacement-worker operation; even an explicit resume only observes a committed/uncertain process receipt, never replays its Rex creation.

`allowAssistant: true` delegates provisioning for that project, placement and listed profiles. It is the normal local-startup policy; programmatic hosts may configure a narrower policy. Core still checks the assistant's current project write grant. With `false`, only the human Owner can provision through the HTTP/client operation; the coordinator refuses to queue it. A brief or worker message cannot confer delegation. No additional approval screen is required.

Core rechecks current authority, placement generation and capture fences directly before the executor's synchronous process-intent admission, after asynchronous Rex discovery. Revocation during discovery cannot launch a process. The ordinary Owner-only raw `launchNativeAgent` API remains available and does **not** itself register/connect a Factory worker.

## Durable records and recovery

Core retains a provisioning request/receipt bound to its issuing credential, a dedicated native-worker record, and the existing coordination items/messages. It stores only the worker credential's SHA-256 hash. The trusted local host keeps the private plaintext credential before Core admission so a lost response cannot lose the only copy. Repeated requests preserve the same credential, worker ID, native launch identity and Rex process intent; changed payloads under an existing request ID conflict.

The executor's native provisioning state is bound to one persisted Core namespace. A different Factory database cannot adopt it simply by reusing request/project IDs or the same local endpoint. Copies of a whole Factory database are not a supported federation or multi-writer deployment.

A reserved worker is `preparing`, with `rex: null`. It cannot receive assignments or submit new questions/reports. Its bridge can authenticate and inspect status while it connects. Once the executor supplies exact Rex identities and both catalogues are independently observed, Core binds the worker to that launch and permits coordination. Manual Owner registrations keep their existing metadata-only semantics and return `provisioningStatus: null`; registration alone never claims connected-launch readiness.

Public provisioning states are:

| State       | Meaning                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admitted`  | Core reserved the worker and dedicated credential identity; no process receipt yet.                                                                  |
| `starting`  | A process receipt exists, but combined readiness is not currently observed.                                                                          |
| `ready`     | The process is observed running; Rex and Factory MCP initialization/catalogues are served; the Factory bridge verified its dedicated worker binding. |
| `uncertain` | Process/observation error, revoked worker, origin mismatch or another ambiguous outcome; reconcile the original request.                             |
| `stopped`   | The executor observed the native process exit; independent Rex jobs may still exist.                                                                 |

Each MCP field separately reports `pending`, `initialized`, `ready`, `disconnected` or `unavailable`. Factory MCP also reports `verifiedAt`. These are local diagnostic observations, not signed native identity attestations or continuous HTTP health checks. The bridge reauthenticates its dedicated binding on every tool call; failed verification clears that evidence. Core also rechecks revocation/placement before recording readiness. Historical timestamps never keep a disconnected local host ready.

GET refresh never prepares files, admits a worker or launches a process. Committed/uncertain process receipts win over removed profiles and mutable preparation settings. Missing/uncertain external evidence never licenses another Rex launch. The provisioning task ends at readiness, uncertainty, refusal or its two-minute deadline; it does not supervise workers forever. A task abort stops observation, not a native process or an already-admitted effect.

There are at most 1,000 retained provisioning jobs and eight active provisioning tasks per coordinator conversation, up to 100 task identities per job, eight concurrent finite host operations, and 4,096 retained Core provisioning identities. Host congestion returns retryable `native_provisioning_busy`; task retries preserve identity and remain deadline-bounded. A configured target allows 1–32 non-stopped provisioning receipts (`maxWorkers`, default eight). Uncertain or revoked-but-not-observed-stopped processes continue consuming capacity: revocation is not process termination. Core preflights capacity before private credential preparation and checks it again transactionally at admission. No pruning, force-clear, adoption or automatic replacement API is added.

## Worker tools

The launch supplies the worker credential through a private mode-0600 configuration file under the launcher's private state, outside every configured workspace. Neither the agent CLI argv, MCP registration arguments, prompt nor model-facing tool result contains the credential. Pi explicitly loads its private MCP bootstrap; Codex receives invocation-local configuration for both servers and retains `--no-daemon`. Global trust, approvals and sandbox settings remain unchanged.

The native model sees one coordination tool, `factory`:

- `status`: this worker's public identity, placement, launch metadata and provisioning state.
- `ask`: `itemId`, `title`, `text`, optional `blocking` (default true).
- `report`: the same fields; `blocking` defaults false. Use the assignment's predetermined report ID.
- `inbox`: bounded unacknowledged messages, optional `limit` (1–100, default 20).
- `acknowledge`: exact `messageId`, acknowledging **receipt only**.

No operation accepts a credential, worker ID, project ID or alternate placement. Core enforces current worker revocation and generation on every operation. Stable `itemId` plus unchanged payload reconciles a lost ask/report response. Conflicting IDs fail rather than creating competing inbox copies.

MCP results are capped below 256 KiB including their text/structured duplication. Mailbox bounding omits whole trailing rows, marks `truncated`, and leaves those rows unacknowledged in Core. Acknowledge only messages actually received, then check again. An oversized/error response to a mutation does not prove rejection; preserve the original item identity. Output and mailbox text are untrusted task data.

## HTTP/client surface

All use the existing Factory authentication boundary:

- `GET /v1/native-worker-targets?projectId=...` — authorized configured targets.
- `POST /v1/native-worker-provisionings` — strict `{ requestId, projectId, targetId, profileId, name }`.
- `GET /v1/native-worker-provisionings/:requestId` — issuing-credential-scoped, currently project-authorized read/refresh.
- `GET /v1/worker/status` — restricted dedicated-worker authentication.
- `GET /v1/worker/runtime` — the same worker's active typed assignment, compact blocking references, existing mailbox and independently observed native evidence; no input delivery or launch side effects.

`FactoryClient` supplies `listNativeWorkerTargets`, `provisionNativeWorker`, `getNativeWorkerProvisioning`, `getWorkerStatus`, and `getWorkerRuntime`. The HTTP adapter delegates launch mechanics to the daemon host; Core owns admission/authorization, worker registration and public receipts. On a composition without the local provisioning host, new provisioning is unsupported; an authorized retained receipt remains readable.

## Proof and limits

A built-CLI regression starts without application arguments or Factory environment configuration and proves local placement, project discovery, delegated provisioning and both MCP connections. Through Pi's actual session engine with controlled model responses, it completes assignment → blocking question → Owner answer → file effect → report → coordinator acceptance. It also protects backlog priority, one active assignment, native JSONL admission verification, Escape/reload/fork/new/switch fencing, forged evidence rejection, restart/removed-profile identity reuse, missing-Rex diagnostics and revoked-node refusal. External Rex/PTY and model responses are substituted; no paid inference is used.

The coordination regression scenario crosses the real coordinator registry/documents/tasks, Core/HTTP, SQLite, generated configurations, stdio MCP servers and real subprocess file effects. Only the external Rex/native CLI boundary is substituted. It covers lost provisioning response plus task restart, separate Pi/Codex-style clients, acknowledgement versus report/review, blocking question → Owner answer → acknowledgement → bounded effect → correlated report, project revocation during discovery, premature coordination refusal, capacity, foreign Factory binding, removed-profile recovery, secret omission and bounded inbox draining.

The opt-in acceptance uses **installed Pi and Codex ordinary TUIs and built bundles** in isolated Rex sessions. Pi's private controlled provider completes the native assignment/question/answer/effect/report loop; Codex initializes both MCP catalogues without inference. The check also protects dedicated authentication, retries, reopen identity, capture refusal and exact-scoped cleanup. No terminal input, paid provider authentication or global native setting mutation is used.

New connected Pi workers use the [native Pi delivery adapter](native-pi-delivery.md): a pinned original conversation, persisted native admission, native-turn evidence, one active assignment and safe-boundary answer delivery. `automaticDelivery`/`nativeActivity` are observed capabilities, not inferred from MCP readiness; paused, detached or unavailable adapters cannot claim automatic delivery. Codex and raw Owner launches remain manual. Native binding is an OS-user observation, not a signed native identity or universal CLI capability. Remote provisioning/delivery, arbitrary existing-session adoption, supervision/reassignment, full capture quiescence and transcript synchronization remain unsupported. A queued instruction, catalogue, acknowledgement, native turn, tool effect and accepted result remain different events.

This runs with the local OS user's permissions. Environment filtering and private file modes are **not OS credential isolation**: same-user agents can read accessible files, and a CLI's shell sandbox does not sandbox the external Rex MCP server. Independent Rex MCP jobs/raw writers are not imported into executor capture receipts; stopping the native CLI is not workspace quiescence. Use OS isolation and separately verified lifecycle adapters where those guarantees are required.
