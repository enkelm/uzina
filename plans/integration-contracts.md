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
- Use a deterministic external model adapter in automated tests. No actual provider calls or credentials are required.

## Early portability proof

The inspected Pi Durable/chord version is 1.4.0. Pin compatible runtime packages exactly. The portable `SqliteStorage.open` accepts a chord `SqliteDatabase`; a Bun facade must serialize operations and correctly scope/rollback asynchronous transactions. Cloudflare already has `openDurableObjectSqliteStorage` and `onWake` recovery hooks, but the host must pre-arm recovery alarms.

Pi Durable exposes record scans and `commit` rather than a complete export/import operation. Public records include conversation/task/entry/submission/document state; document historical semantics and global IDs are important limitations. First prove a versioned supported checkpoint profile into an empty inactive store, including canonical model context and request deduplication. Explicitly refuse unsupported histories, active tasks, unknown definitions, or conflicting destination IDs rather than claiming that transcript copying is a move. Preserve owned descendants and supported task checkpoints where the public storage contract can prove correctness. Report an upstream blocker if required history cannot be represented safely.

## Integrated foundations: slice 4 remains unconnected

The initial four foundations are now composed into the Bun workspace without composing their business paths into the root Worker/daemon. They expose independent package seams; their implementation status is pending review. In particular, the Factory and execution lanes use incompatible protocols on the same reserved node routes:

| Operation | Factory Core route payload | Execution connector payload |
| --- | --- | --- |
| register | `{}` | version, authenticated node ID, daemon version, workspace generation/state reports, capability set |
| heartbeat | `{}` | version, node ID, timestamp, workspace reports, capability set |
| claim | `{}` -> `FactoryQueueJob \| null` | version/node ID -> `ExecutionJob \| null` |
| report | workspace ID, generation, terminal status, optional detail | job/node/target/generation, status, payload SHA-256, completion time, and result/error/reconciliation evidence |

`FactoryQueueJob.input` is `{ kind: "managed-input", text }`; it is not an execution operation. Execution jobs are `read-file`, `write-file`, or bounded `argv-command`. They happen to use `contractVersion: 1` but are not wire-compatible. `HttpExecutionControllerConnector` validates against `@uzina/contracts/execution`; Factory's own node routes validate the Factory shapes. Do not silently make the connector call Factory routes or treat Factory queue claims as executable tool jobs.

Slice 4 must explicitly implement the controller-side node API matching the execution schemas and authenticate node credentials before any report/claim effects; bridge managed Pi's remote tool executor to the execution connector with bounded, explicit node/workspace targets; and separately connect Factory `ManagedRuntimeDispatch` to managed Pi's stable submission IDs, receipts, and status. Add end-to-end proof of that wiring and its authorization/generation checks before claiming connected execution. Root startup currently remains slice 0, and neither root entry point activates these modules. See `packages/core/README.md` for public path names and per-route detail.

## Validation and handoff

- Each lane runs its focused tests and typechecking with actual storage/platform adapters where applicable.
- Root `bun run test` uses Bun discovery; keep runner-specific test files from being accidentally discovered by the wrong runner and document additional commands.
- Do not modify the shared progress ledger in isolated lanes. Return commands, test outcomes, remaining limitations, exact exported interfaces, and files needing composition.
- Do not push, deploy, read credential values, or mutate existing agent/Rex sessions. Actual second-laptop and production Cloudflare evidence remain separate operator gates.
