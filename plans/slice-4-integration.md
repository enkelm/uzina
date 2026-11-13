# Slice 4: connect the foundations without conflating two queues

## Slice 4a implemented

The main checkout now implements the authenticated controller-to-executor protocol using the concrete `@uzina/contracts/execution` schemas. The Factory's managed-input `dispatch_intents` and remote-effect `execution_jobs` are distinct durable queues. Nodes cannot claim managed Pi model input.

The owner provisions node identities/credentials through `POST /v1/nodes` and owner-selected workspace mappings through `POST /v1/workspaces`. Register/heartbeat records are bound to the provisioned credential identity and validate owner-authorized workspace reports at the current generation. The execution queue stores stable job payload hashes, explicit target/generation, repeated claim evidence, and the immutable correlated report. Duplicate claim/report delivery and lost acknowledgements reconcile against controller and node SQLite evidence. Uncertain node effects remain uncertain and are never replayed.

The trusted in-process `FactoryService.enqueueRemoteExecution(job)` / `getRemoteExecutionReceipt(jobId)` seam is reserved for the next managed-Pi bridge; there is no public or anonymous job-injection route. `apps/daemon/src/execution/loop.ts` provides bounded register/heartbeat/claim/execute/report polling with cancellation, independent of browser lifetime. Heartbeats run concurrently with bounded effects; shutdown waits for a running effect before returning, and credential refusal stops subsequent claims. Deterministic local preflight failures now produce durable failed receipts and reports, releasing the node for later queued work without executing unsafe effects. `UZINA_MODE=connected-executor` is explicit and fails closed when controller, owner-provisioned node credentials, local receipt storage, or workspace mappings are absent. Credentials are not logged.

Behavior evidence:

- `apps/daemon/test/execution-controller.test.ts` starts the real local Factory HTTP host and `ExecutionDaemon`, persists and reports a deterministic missing-file failure before completing the next queued workspace mutation, drops real HTTP claim/report acknowledgements, verifies repeated claims/reports, closes/reopens controller and node SQLite, and confirms failed/completed receipts and claim/report evidence. A bounded argv job observes multiple HTTP heartbeats before completion; cancellation waits for that effect, duplicate loops are refused, post-shutdown heartbeat timers stop, and revoked credentials stop future claims.
- `apps/daemon/test/execution.test.ts` verifies deterministic preflight failures (oversized file content, traversal, and symlink escape) become durable failed reports while invalid identity, unsupported operations, stale ownership, and payload conflicts remain hard rejections; outside paths remain unchanged.
- The same protocol test proves offline admission refusal, unsupported capability schema rejection, owner-unprovisioned workspace rejection, stale-generation rejection, path/credential node identity mismatch, revoked credential rejection, and absence of a public job-injection endpoint.
- `apps/daemon/test/factory.test.ts` proves managed-input dispatch stays on the injected runtime queue and never appears in executor claims; interrupted managed dispatch remains uncertain on reopen.
- `apps/cloudflare/test/factory-object.workerd.test.ts` runs a real Miniflare/workerd Durable Object through owner bootstrap, Factory command admission, Durable Object eviction, receipt reopen, and duplicate submission. The Factory SQL adapter was corrected to call the production receiver `state.storage.transactionSync`, not `state.storage.sql.transactionSync`.

Slice 4a does **not** complete slice 4. No production Worker binding, managed-Pi `RemoteToolExecutor` bridge, managed runtime dispatch/completion integration, Cloudflare-to-laptop flow, or production/second-laptop execution is claimed.

## Slice 4b pending

- Dispatch an accepted Factory input to stable per-thread Pi managed work, then dispatch managed completion/failure/uncertainty to Factory receipts/events.
- Bind `RemoteToolExecutor` to the exact authorized node/workspace/generation, using a durable effect identity tied to runtime execution evidence. Read-only replay and unsafe effect replay remain distinct.
- Connect the remote-tool seam to stable admission/result reconciliation. Runtime recovery must find prior job evidence or retain uncertainty, not allocate a new effect after a lost reply.
- Compose local standalone behavior and root Cloudflare Factory/ManagedWork Durable Objects with Wrangler bindings/migrations. Require real model/provider configuration and keep deterministic providers test-only.
- Validate the composed application behavior and managed runtime recovery under real workerd. Deployment to Cloudflare and the actual second laptop remain separate operator gates.

## Full-slice acceptance gates (4b)

1. A deterministic external model selects a remote bounded file or command tool in a managed conversation.
2. A separately authenticated execution daemon performs that effect in its explicitly selected temporary workspace.
3. The accepted Factory command becomes observably completed with resulting model context and committed events available through authorized requests.
4. Lost browser acceptance, duplicate node delivery/report, connection loss, and reopen retain identities without duplicating effects.
5. Unavailable nodes, unsupported capabilities, stale ownership, and uncertain outcomes are explicit and never silently fall back.
6. The composed scenario runs locally and through the Cloudflare-compatible runtime. Production deployment and actual second-laptop evidence are separately recorded.

## Scope discipline

Do not add invitations, rich UI, native CLI-provider adapters, checkpoint ownership transfer, or a second model scheduler to finish slice 4. Each implementation increment includes behavior-focused tests and a clean local checkpoint before dependent work branches.
