# Initial parallel-lane integration agreements

These agreements keep the first parallel implementation independently testable. They are not a substitute for validating behavior in slice 4. Read SPEC.md and GLOSSARY.md for product scope.

## Source ownership

- Runtime lane: `packages/pi-runtime`, a separate Cloudflare managed-work Durable Object, local runtime adapters, runtime tests.
- Execution lane: `apps/daemon/src/execution`, execution tests, and `packages/contracts/src/execution.ts`.
- Factory lane: `packages/core`, `packages/contracts/src/factory.ts`, a separate Cloudflare Factory Durable Object, and local Factory storage/composition modules.
- Workspace checkpoint lane: `packages/checkpoints`, its tests and workspace capture/restore implementation. Managed Pi serialization belongs to the runtime lane until integration.
- The parent/integrator owns root entrypoint composition, root scripts/configuration, shared export reconciliation, lockfile reconciliation, and the slice ledger. Leaf package manifests may introduce their own necessary dependencies. Report root changes needed rather than opportunistically changing shared files.

## Authentication and node connection

- Human owner access and node credentials are distinct. HTTP identity is derived from credentials, not trusted from a JSON actor field.
- The owner provisions a node identity and one-time-visible node credential. Nodes do not enroll themselves with an arbitrary identity and no credential.
- A connected node initiates outbound authenticated HTTP requests to the controller. Cloudflare does not need an inbound route to a private laptop.
- Use `Authorization: Bearer <credential>`. The node identity in the path or body must match the authenticated credential.
- Reserve these operation routes: owner `POST /v1/nodes` for provisioning; node `POST /v1/nodes/:nodeId/register`, `POST /v1/nodes/:nodeId/heartbeat`, `POST /v1/nodes/:nodeId/jobs/claim`, and `POST /v1/nodes/:nodeId/jobs/:jobId/report`.
- Claim returns either no job or one job assigned to that authenticated node. A report must match the assigned job, node, workspace, and ownership generation. Repeated reports reconcile the same job and never create a fresh effect.
- The execution lane defines and documents the exact validated register/heartbeat/job/report payloads in its contract submodule. The Factory lane initially accepts these through a narrow execution-queue adapter if final schemas are not yet integrated; the integrator connects the concrete modules in slice 4.

## Execution guarantees

- Every effect has a stable `jobId`, explicit node/workspace target, and ownership generation. Reusing an ID for a different payload is a conflict, not a retry.
- Workspaces are locally configured identifier-to-directory mappings. Untrusted requests do not select arbitrary absolute working directories. File operations reject path traversal and symlink escapes.
- Minimum operations: bounded file read, file write, and argv-based command execution. Set output/size limits. Shell-capable access is powerful and is not an OS sandbox.
- Nodes persist enough receipt evidence to distinguish never started, running/uncertain after interruption, completed, and failed. Reconnect does not replay an uncertain command.
- Rex process hosting is separate from authoritative job records. Production operations and opt-in real Rex checks target only resources created by Uzina and recorded by exact ID.
- A source must acknowledge durable quiescence/fencing before transfer activation. An unavailable or uncertain source blocks a move; ownership generations do not stop isolated running processes by themselves.

## Runtime and Factory seam

- Core owns authorization, accepted commands, durable dispatch intent, placement, and receipts. Pi Durable owns conversation/task execution. Core does not implement a second model/task scheduler.
- Core receives a small runtime adapter rather than importing Bun, Cloudflare, or Pi implementation internals into its portable entry point.
- Runtime lane must document the concrete production interface for opening managed work, submitting deduplicated input, reading canonical context/status, observing completion, and closing/reopening.
- Local and cloud storage compose the same behavior. Actual Cloudflare transaction and alarm proof must run in workerd/Miniflare or equivalent; Bun mocks do not establish cloud-runtime compatibility.
- Automated local tests may use a deterministic adapter at the external-model seam. The production-shaped Cloudflare workerd test uses the real Pi AI OpenAI provider/Responses parser with a bounded mocked outbound HTTP response and a dummy API key; it performs no external/paid inference. Production provider secrets are not required.

## Early portability proof

The inspected Pi Durable/chord version is 1.4.0. Pin compatible runtime packages exactly. The portable `SqliteStorage.open` accepts a chord `SqliteDatabase`; a Bun facade must serialize operations and correctly scope/rollback asynchronous transactions. Cloudflare already has `openDurableObjectSqliteStorage` and `onWake` recovery hooks, but the host must pre-arm recovery alarms.

Pi Durable exposes record scans and `commit` rather than a complete export/import operation. Public records include conversation/task/entry/submission/document state; document historical semantics and global IDs are important limitations. First prove a versioned supported checkpoint profile into an empty inactive store, including canonical model context and request deduplication. Explicitly refuse unsupported histories, active tasks, unknown definitions, or conflicting destination IDs rather than claiming that transcript copying is a move. Preserve owned descendants and supported task checkpoints where the public storage contract can prove correctness. Report an upstream blocker if required history cannot be represented safely.

## Slice 4a/4b integration status (initial agreements; current code paths documented in slice plan)

The controller now implements the concrete `@uzina/contracts/execution` schemas on the reserved node routes. Owner-provisioned node credentials bind authenticated sessions to the node ID; registration reports must name only owner-provisioned workspaces at the current generation. Capabilities and workspace reports are persisted. Claims persist claim evidence and retry the same immutable node/workspace/generation/payload-hash assignment. Reports are checked against that durable assignment and persisted idempotently. The connector no longer requires an in-memory claim to report after node restart.

Managed inputs remain in `dispatch_intents` as `{ kind: "managed-input", text }` and go only through `ManagedRuntimeDispatch`. Bounded `read-file`, `write-file`, and `argv-command` effects use a separate durable `execution_jobs` queue. The trusted Core seams `FactoryService.enqueueRemoteExecution(job)` and `FactoryService.getRemoteExecutionReceipt(jobId)` remain in-process only. The managed Pi bridge is `FactoryService.enqueueManagedRemoteExecution(threadId, piTaskId, piCallId, operation)`; it derives actor, node, workspace, and generation from accepted work. No HTTP route exposes job admission. A pending/running node effect is not reassigned or replayed after uncertainty.

The slice 4a local host and Miniflare/workerd tests prove duplicate claims/reports, lost acknowledgements, reopen reconciliation, credential/path identity checks, revocation, offline admission, unsupported capability rejection, and stale workspace generation rejection. The current slice 4b tests additionally connect accepted input through a real Pi Durable conversation/tool transcript to a separately authenticated HTTP execution daemon, a temporary workspace effect, settled Core receipt/event, and authorized context/status. See `plans/slice-4-integration.md` and the package READMEs for exact current test evidence and interfaces.

The root Cloudflare Durable Object composition and actual Worker bindings are implemented and compiled; Miniflare/workerd is the only Cloudflare runtime evidence. This checkpoint is not evidence of deployment, production Cloudflare credentials/routing, tailnet configuration, or cloud-to-laptop/second-laptop completion. See `packages/core/README.md`, `packages/pi-runtime/README.md`, `apps/daemon/README.md`, and `apps/cloudflare/README.md` for production setup and limitations.

## Validation and handoff

- Each lane runs its focused tests and typechecking with actual storage/platform adapters where applicable.
- Root `bun run test` uses Bun discovery; keep runner-specific test files from being accidentally discovered by the wrong runner and document additional commands.
- Do not modify the shared progress ledger in isolated lanes. Return commands, test outcomes, remaining limitations, exact exported interfaces, and files needing composition.
- Do not push, deploy, read credential values, or mutate existing agent/Rex sessions. Actual second-laptop and production Cloudflare evidence remain separate operator gates.
