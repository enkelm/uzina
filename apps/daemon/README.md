# Uzina daemon modes

The daemon defaults to `UZINA_MODE=local`, which composes the standalone persistent Factory, managed Pi Durable runtime, and loopback HTTP application. Factory startup accepts only `127.0.0.1`, `::1`, or `localhost` and fails closed for non-loopback `HOST` values; there is no public-listener override. A separately operated private gateway/tailnet route is outside this host and must not turn an anonymous Factory/MCP endpoint into a public service. The separate `connected-executor` mode supplies an explicitly provisioned execution node and does not create a competing Factory catalog.

## Standalone local Factory

Use Bun 1.4.4. Configure a real Pi AI provider/model and a private bootstrap secret, then run:

```sh
UZINA_MODE=local \
UZINA_BOOTSTRAP_SECRET='<private-local-bootstrap-secret>' \
UZINA_MODEL_PROVIDER=openai \
UZINA_MODEL_ID=gpt-4o-mini \
UZINA_MODEL_API_KEY='<provider-api-key>' \
bun run dev:daemon
```

`UZINA_FACTORY_DATABASE_PATH` defaults to `~/.local/share/uzina/factory.sqlite`; `UZINA_MANAGED_WORK_DIRECTORY` defaults to `~/.local/share/uzina/managed-work`. Both can be set to isolated paths for tests or an operator-selected data location. The service defaults to `http://127.0.0.1:8788`. `POST /v1/bootstrap` uses the configured `Bootstrap` bearer secret once; the returned human bearer is distinct from all execution-node credentials.

Model provider, model ID, and API key are required. Startup validates them against the actual Pi AI provider/model catalog and credential resolver. Missing or unsupported configuration fails closed; production does not install a dummy response model. Secret values are not printed or placed in Factory events. The deterministic model adapters are test-only.

A thread is created with an owner-selected node/workspace placement. Inputs do not repeat the placement. Core persists each accepted input, then dispatches it to one stable per-thread managed Pi store. Pi Durable makes submissions idempotent by accepted request ID. `GET /v1/threads/:threadId/context` returns canonical model context and `GET /v1/threads/:threadId/status` returns runtime inspection/status; both require an authenticated Factory credential. `GET /v1/commands/:requestId` returns the managed completion/failure/uncertainty receipt and remote execution receipts. `GET /v1/events` exposes committed receipt transitions. The loopback-only Factory also exposes authenticated stateless MCP at `POST /v1/mcp`; see `packages/core/README.md` for tool names and bearer/Origin/resource behavior.

## Managed-work checkpoint capture and inactive restore

A trusted local composition can call `StandaloneFactoryServer.captureManagedWorkCheckpoint({ credential, threadId, transport })`. The host resolves the selected workspace only through its configured `workspaceDirectories` mapping, asks Core to durably fence admissions, then requires a `workspaceCaptureQuiescence` adapter to acquire the selected executor's local durable writer/Rex fence. The checked-in `ExecutionDaemon.beginWorkspaceCapture()` checks its persisted job and Rex receipts, refuses capture when any persisted local workspace root canonically overlaps the selected root (including ancestor/descendant and symlink aliases), and blocks later direct job/Rex admission. Ordinary nested-workspace execution remains available when no capture is admitted. The host exports `ManagedPiWork.exportCheckpoint()`, adds owner-authorized Core command/effect receipts as `factory-provenance.json`, and uses `@uzina/checkpoints` to create one content-addressed version-1 bundle. The only supported Pi profile is `quiescent-current-documents-no-forks-v1`: reserved root ID 1, terminal tasks, settled submissions, current documents, and no forks/session documents. The workspace must be exclusive to that thread, and the host refuses active, pending, or uncertain Factory work/effects. A capture checkpoint does not transfer authority.

`restoreManagedWorkBundle()` validates the complete bundle and destination compatibility before final placement, stages both the workspace checkout and fresh Pi SQLite store, and records a stable `prepared-inactive` receipt. It does not resume the Pi runtime. The caller supplies explicit `supportedRuntimeRequirements` including the destination-local `model:<provider>/<modelId>` and each supported `tool:<name>:v1`, plus an `openStorage(path)` adapter. Credentials/provider settings are resolved locally and never transferred. The restore root contains `workspace/`, `managed-work.sqlite`, `.uzina/attachments/`, and `.uzina/prepared-restore.json`; activating the prepared runtime remains an explicit separate step.

The executable local capture integration is covered by `apps/daemon/test/standalone-factory.test.ts` using a real standalone Factory, managed Pi on Bun SQLite, a Git workspace, and `FileBlobTransport`. For production local snapshot capture, the daemon CLI still needs trusted workspace-ID/directory and `ExecutionDaemon` quiescence adapter wiring into `createStandaloneFactoryServer`. Remote source CONTROL is a separate authenticated protocol and never treats an offline or uncertain node as fenced. No Cloudflare R2 binding/remote snapshot orchestration, cloud-to-laptop checkpoint, or ownership move is implemented. The R2 transport adapter is independently exercised against an actual Miniflare R2 bucket.

### Remote source capture control (phase 1 only)

The connected `ExecutionLoop` polls an authenticated capture-control route separately from the managed effect-job queue. Its idempotent operation persists a correlated control receipt and selected-workspace fence atomically in node SQLite before constructing a `source-capture-fenced` report. Lost acknowledgements and daemon reopen reconcile the same identity and receipt. The remote fence is owned by CONTROL; ordinary `endWorkspaceCapture()` cleanup refuses to clear it. Controls do not execute argv, Git, checkpoint code, Pi, Harness, scheduler, model, or tools.

The node confirms only that Uzina-managed admissions are fenced and current persisted Uzina execution/Rex evidence is quiescent. Canonical overlapping configured roots, queued/running/uncertain execution receipts, and persisted Rex `starting`/`running`/`stopping`/`uncertain` states block a positive report. A refusal is durably reported as `blocked`; the controller lock remains held. There is no automatic retry-to-success, generation bump, or unfence in phase 1. Unmanaged operating-system writers are outside this guarantee; this is not an OS sandbox or physical filesystem lock.

Phase 1 creates **no workspace snapshot/checkpoint or transferable bundle** and does not prepare/activate destinations, transfer ownership, or move runtime state. The separate local snapshot capture lifecycle remains unchanged.

## Authenticated connected executor

To use a node provisioned by the Factory owner, start connected mode explicitly:

```sh
UZINA_MODE=connected-executor \
UZINA_CONTROLLER_URL=https://factory.example \
UZINA_NODE_ID=node:laptop-a \
UZINA_NODE_CREDENTIAL='<owner-provisioned-node-credential>' \
UZINA_EXECUTION_DATABASE_PATH="$HOME/.local/share/uzina/executor.sqlite" \
UZINA_EXECUTION_WORKSPACES='[{"workspaceId":"workspace:repo","directory":"/absolute/path/to/checkout"}]' \
bun run dev:daemon
```

The node credential is separate from human/bootstrap/model credentials. The node initiates authenticated outbound HTTP requests and must not use a human token. Owner provisioning through `POST /v1/nodes` and `POST /v1/workspaces` binds the node and workspace IDs. The controller payload does not select an arbitrary host directory. Connected mode is not a human Factory UI/gateway and its execution-daemon listener remains loopback.

- `src/execution/daemon.ts` persists job receipts and reports interrupted effects as uncertain rather than replaying them.
- `src/execution/connector.ts` is an outbound Bearer-authenticated client for the schemas in `@uzina/contracts/execution`.
- `src/execution/loop.ts` is a bounded/cancellable register-heartbeat-claim-execute-report loop. Heartbeats continue independently while an argv or file effect is awaited; shutdown waits for an in-flight effect. Credential refusal stops future claims. Local storage/protocol errors fail closed; only classified transport failures/transient HTTP statuses are retried.
- Workspace files are bounded and traversal/symlink escapes are rejected. `argv-command` does not shell-parse its argument array. An optional command `cwd` is interpreted relative to the selected workspace (`.` means root); absolute paths, traversal, missing/non-directory paths, and symlink escapes produce failed receipts before process start.

## Local verification and evidence limits

`bun run test` includes a full local scenario using the actual Factory HTTP host, persistent Factory SQLite, Pi Durable over Bun SQLite, a deterministic model at the provider seam, `ExecutionDaemon` with its own SQLite, the real outbound HTTP loop, and a temporary workspace write/command. It covers deduplicated input, tool-result correlation, provider failure, command timeout uncertainty with a real partial effect, relative `cwd`, invalid `cwd`, and reopened receipts/context.

The Cloudflare-compatible end-to-end scenario is in `apps/cloudflare/test/composed-workerd.test.ts`; it runs actual Miniflare/workerd Durable Objects and the same HTTP executor protocol. It is emulator evidence only. No production cloud deployment, paid provider request, production credential check, second-laptop operation, or mutation of an existing Rex session is claimed.
