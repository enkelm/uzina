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

## Owner-private Factory assistant

The standalone host always keeps the private assistant in a dedicated `private-assistant/` directory (mode `0700`) beneath `UZINA_MANAGED_WORK_DIRECTORY`, separate from each per-thread Pi database. Its SQLite files and WAL remain inside this owner-only directory. It is not a Factory work thread, has no project/node/workspace placement, and is not included in managed-work checkpoint bundles.

The owner first provisions a named `assistant` credential and an explicit grant set through the existing owner credential/grant operations. The assistant's grants—not the human owner's authority—control its Factory tools. Install the returned bearer into the protected local process environment and configure all expected non-secret identity fields:

```sh
UZINA_PRIVATE_ASSISTANT_BEARER='<operator-installed-assistant-bearer>' \
UZINA_PRIVATE_ASSISTANT_CREDENTIAL_ID='credential:...' \
UZINA_PRIVATE_ASSISTANT_ASSISTANT_ID='assistant:...' \
UZINA_PRIVATE_ASSISTANT_OWNER_ID='user:...' \
bun run dev:daemon
```

Do not put that bearer in a browser, node, model/provider, database, transcript, Pi memo, event, checkpoint, or command line visible to other users. The service reads it only from the protected host environment. The assistant validates the active bearer through authenticated Factory `GET /v1/me`, pins the exact credential/assistant/owner identity in its private metadata store, and calls Factory only through the same-origin authenticated client. Each Core tool request checks current revocation and grants. If configuration is incomplete, revoked, mismatched, or temporarily uncheckable, status reports `parked` and the assistant does not start/resume tool-capable tasks; ordinary Factory work remains available. Owner-private context and receipt reads remain available after assistant revocation. Changing credential identity parks the existing transcript; transcript adoption and credential rotation are unsupported and never inferred. Preserve the store and do not silently point a different assistant bearer at it.

Owner-only ingress is `POST /v1/private-assistant/inputs` with stable `{ inputId, text }`, `GET /v1/private-assistant/status`, `GET /v1/private-assistant/context`, and `GET /v1/private-assistant/receipts/:inputId`. Identical IDs/text reuse the durable Pi submission; changed text conflicts. The assistant uses explicit-target `factory_*` coordination tools only in this private registry. Ordinary managed coding threads retain their existing remote file/argv tools and do not receive Factory control-plane tools or the assistant credential. Stop, native resume/CLI, and transfer remain unsupported.

A thread is created with an owner-selected node/workspace placement. Inputs do not repeat the placement. Core persists each accepted input, then dispatches it to one stable per-thread managed Pi store. Pi Durable makes submissions idempotent by accepted request ID. `GET /v1/threads/:threadId/context` returns canonical model context and `GET /v1/threads/:threadId/status` returns runtime inspection/status; both require an authenticated Factory credential. `GET /v1/commands/:requestId` returns the managed completion/failure/uncertainty receipt and remote execution receipts. `GET /v1/events` exposes committed receipt transitions. The separate owner-private assistant routes and host-only named credential are described below. The loopback-only Factory also exposes authenticated stateless MCP at `POST /v1/mcp`; see `packages/core/README.md` for tool names and bearer/Origin/resource behavior.

## Managed-work checkpoint capture and inactive restore

A trusted local composition can call `StandaloneFactoryServer.captureManagedWorkCheckpoint({ credential, threadId, transport })`. The host resolves the selected workspace only through its configured `workspaceDirectories` mapping, asks Core to durably fence admissions, then requires a `workspaceCaptureQuiescence` adapter to acquire the selected executor's local durable writer/Rex fence. The checked-in `ExecutionDaemon.beginWorkspaceCapture()` checks its persisted job and Rex receipts, refuses capture when any persisted local workspace root canonically overlaps the selected root (including ancestor/descendant and symlink aliases), and blocks later direct job/Rex admission. Ordinary nested-workspace execution remains available when no capture is admitted. The host exports `ManagedPiWork.exportCheckpoint()`, adds owner-authorized Core command/effect receipts as `factory-provenance.json`, and uses `@uzina/checkpoints` to create one content-addressed version-1 bundle. The only supported Pi profile is `quiescent-current-documents-no-forks-v1`: reserved root ID 1, terminal tasks, settled submissions, current documents, and no forks/session documents. The workspace must be exclusive to that thread, and the host refuses active, pending, or uncertain Factory work/effects. A capture checkpoint does not transfer authority.

`restoreManagedWorkBundle()` validates the complete bundle and destination compatibility before final placement, stages both the workspace checkout and fresh Pi SQLite store, and records a stable `prepared-inactive` receipt. It does not resume the Pi runtime. The caller supplies explicit `supportedRuntimeRequirements` including the destination-local `model:<provider>/<modelId>` and each supported `tool:<name>:v1`, plus an `openStorage(path)` adapter. Credentials/provider settings are resolved locally and never transferred. The restore root contains `workspace/`, `managed-work.sqlite`, `.uzina/attachments/`, and `.uzina/prepared-restore.json`; restore alone neither starts nor authorizes that local runtime. The authenticated Cloudflare workspace-cutover protocol below moves workspace execution authority while retaining the already-running cloud Pi thread; it does not transfer or restore a controller/runtime.

The executable local capture integration is covered by `apps/daemon/test/standalone-factory.test.ts` using a real standalone Factory, managed Pi on Bun SQLite, a Git workspace, and `FileBlobTransport`. For production local snapshot capture, the daemon CLI still needs trusted workspace-ID/directory and `ExecutionDaemon` quiescence adapter wiring into `createStandaloneFactoryServer`. Remote source CONTROL is a separate authenticated protocol and never treats an offline or uncertain node as fenced. The Cloudflare Factory composes the remote coherent checkpoint and executes the authenticated workspace-relocation protocol described below. The standalone Bun Factory does not provide that Worker/R2 composition path. Local trusted capture and remote held-fence capture have different release lifecycles.

### Remote source capture control

The connected `ExecutionLoop` polls an authenticated capture-control route separately from the managed effect-job queue. Its idempotent operation persists a correlated control receipt and selected-workspace fence atomically in node SQLite before constructing a `source-capture-fenced` report. Lost acknowledgements and daemon reopen reconcile the same identity and receipt. The remote fence is owned by CONTROL; ordinary `endWorkspaceCapture()` cleanup refuses to clear it. Controls do not execute argv, Git, checkpoint code, Pi, Harness, scheduler, model, or tools.

The node confirms only that Uzina-managed admissions are fenced and current persisted Uzina execution/Rex evidence is quiescent. Canonical overlapping configured roots, queued/running/uncertain execution receipts, and persisted Rex `starting`/`running`/`stopping`/`uncertain` states block a positive report. A refusal is durably reported as `blocked`; the controller lock remains held. CONTROL itself has no automatic retry-to-success, generation bump, or unfence operation. Unmanaged operating-system writers are outside this guarantee; this is not an OS sandbox or physical filesystem lock.

CONTROL itself creates **no workspace snapshot/checkpoint or transferable bundle** and does not prepare/activate destinations, transfer ownership, or move runtime state. The subsequent snapshot, coherent-checkpoint, and relocation protocols consume this original held fence without releasing it.

### Remote workspace snapshots (workspace-only)

After the source reports `source-capture-fenced`, the owner submits a stable request to `POST /v1/workspace-snapshots` referencing that capture request. `GET /v1/workspace-snapshots/:requestId` exposes its durable outcome. The connected node claims the separate snapshot queue, captures the actual Git/index/selected files into an immutable cache outside configured workspace roots, and streams digest-verified objects to its assigned capture namespace. Retries reuse the original artifact; interrupted production or missing/corrupt cache stays uncertain rather than recapturing changed source state.

Bun Factory hosts use `FileWorkspaceSnapshotStorage`; the standalone option `snapshotStorageDirectory` defaults to `<factory-database-path>.workspace-checkpoints`. The Worker uses its configured `CHECKPOINTS` R2 binding and fails closed when storage is missing. Node authority is upload-only for its assigned claimed capture; it grants no arbitrary hash downloads or controller-private runtime access. Once Core verifies the manifest and exact referenced objects, status becomes `workspace-checkpoint-available`. Owner-authorized `GET /v1/workspace-snapshots/:requestId/blobs/:sha256` streams only the published allowlist, suitable for local inactive workspace restore.

Workspace publication enforces mandatory exporter exclusions and declared path scope through a shared bounded non-backtracking matcher. It does not scrub Git history or detect secrets hidden under permitted names. Rejected objects may remain in private staging. This protocol leaves source fences held and exports no Pi state, private assistant history, coherent managed-work bundle, activation or ownership change. Local HTTP and Miniflare/workerd R2 tests prove capture/retrieval/inactive restore, not a production deployment or second-laptop transfer.

### Destination workspace relocation preparation (inactive)

The connected `ExecutionLoop` also consumes only the authenticated claim assigned to its own node. `ExecutionDaemon` durably binds that relocation ID to the full source/checkpoint/snapshot/manifest identity and configured destination workspace, reserves that local workspace as inactive before transfer, and refuses ordinary job, capture, and Rex admission for the reserved destination or any configured workspace root that aliases or overlaps it. Only the exact Core-authorized activation command may activate that reservation. The controller-supplied claim never supplies a filesystem path. A missing local workspace mapping, unsafe/non-empty/overlapping canonical root, or conflicting local activity produces a durable blocked receipt without restoring over existing files.

The node requests only manifest-listed objects from the destination-scoped node route and streams each into a mode-`0600` content-addressed cache under the existing private snapshot-cache root, outside configured workspaces and the daemon database. It verifies response metadata, byte limits, hashes, the workspace-only manifest/profile and every selected object before calling `restoreWorkspaceCheckpoint()` and `verifyRestoredWorkspaceCheckpoint()`. It writes a durable restore-started marker before filesystem effects; after interruption, the same tree is verified and finalized or retained as uncertain, never automatically restored over again. A later change to a prepared tree degrades monotonically to `uncertain`, binds that report to the previous receipt digest, and preserves the original prepared report; a different or unbound report mutation remains a conflict. Lost admission, claim, and report acknowledgements are safe to retry across controller/destination reopen. This ends only at `prepared-inactive`; it does not change the Factory thread target or generation, activate either workspace, unfence the source, transfer managed Pi state or authorize runnable execution.

The C1/C2 Miniflare/workerd R2 owner scenario exercises partial real blob-stream interruption while an owned `.part` exists, cleanup of that incomplete attempt, retry of the same claimed relocation and manifest reference, and real destination child-process terminations at both partial-staging and completed-tree `restore-started` boundaries. On daemon and Worker reopen, only a complete tree passing the normal checkpoint and restored-workspace verifiers becomes `prepared-inactive`; missing/unknown or changed filesystem state remains uncertain without overwrite, and interrupted staging evidence is not automatically removed. The same authenticated claim is also used for fail-closed local missing-mapping, non-empty, symlink-swapped, nested/aliased, cache-overlap and database/cache-overlap guards. It exercises a pre-change Factory Durable Object schema reopen/migration without relocation business rows. These are local emulator/test-fixture proofs, not production deployment or second-laptop evidence.

A short/interrupted pre-restore transfer removes only its owned incomplete `.part` and may fetch the same immutable reference again while the destination remains empty and reserved. A completed cache file with incorrect hash/size, a corrupt manifest, or incomplete/unknown state after `restore-started` is fail-closed; existing completed objects are not automatically deleted or replaced, and any resulting blocked/uncertain receipt is retained for operator review. This deliberately does not add corrupt-cache repair or overwrite/refetch semantics.

### Workspace relocation activation and executor recovery

Preparation ends at `prepared-inactive`; that receipt alone is not activation authority. An owner with current authorization starts the original prepared relocation with strict `{ contractVersion: 1 }` at `POST /v1/workspace-relocations/:requestId/activation-intent`. The authenticated destination claims its own assignment at `POST /v1/nodes/:nodeId/workspace-relocation-activations/claim`, freshly verifies the selected Git/index/files/cache/root against that immutable preparation, and reports readiness at `POST /v1/nodes/:nodeId/workspace-relocations/:relocationId/readiness`. Core rechecks the original source CONTROL/checkpoint/snapshot and prepared-receipt bindings, current owner and node authority, destination reservation, absence of active permits/effects, and safe epoch arithmetic before one transaction retires the source, changes the same thread target, and persists the exact activation command.

The new destination epoch is `max(sourceOwnershipGeneration, destinationOwnershipGeneration) + 1`; source/checkpoint receipts keep their original epoch and the destination's prior provisioned epoch remains separately bound. A new v1 preparation includes that destination epoch. Legacy v1 preparations without it keep their original binding and local-generation rule; they are not silently rewritten. Repeated intent/claim/readiness operations return or reconcile the same relocation IDs, command, and receipts. The destination applies the committed command locally without restoring again and reports its exact activation receipt at `POST /v1/nodes/:nodeId/workspace-relocations/:relocationId/activation-report`.

Core does not release the thread-admission lock or destination reservation until the authenticated activation report matches the committed command. The phases are `intent` / `preflight-claimed`, `ownership-committed`, `activated`, and `uncertain`: `ownership-committed` means Core has already moved the thread epoch but is still holding admission; `activated` follows the exact destination receipt; `uncertain` never authorizes fallback. If the prepared destination changes while readiness/commit is awaited, the node refuses local activation and retains a prior-receipt-bound uncertainty report; changed files are not restored or overwritten. Credential revocation around an awaited authenticated step denies later operations, but does not undo bytes or a Core transaction already consumed. There is no timeout takeover, rollback, source-unfence, or source fallback. The original A CONTROL/local fence remains permanent, including across daemon reopen, alias mappings, and finalization. A genuinely new capture and move after a completed relocation receives new request/CONTROL/snapshot/checkpoint/relocation IDs; replaying the prior request is only a retry of that old transfer.

Authorized owner reads of historical CONTROL, snapshot, checkpoint, and relocation evidence still require current owner authorization and scope; a revoked credential cannot read it. Historical evidence retains its original bindings and cannot authorize new work or node reads. The cloud Pi thread, Durable Object, profile, and scheduler remain in place; only workspace execution placement/epoch moves. Local test proof is not a managed-runtime/controller transfer, OS sandbox, two-laptop operation, protected production ingress/secrets/R2, or deployed cutover.

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
