# Factory Core

`@uzina/core` provides owner-authenticated Factory operations over the portable `FactoryDatabase` interface. The local Bun SQLite and Cloudflare Durable Object adapters use the same service behavior.

## Separate durable queues

Factory managed-input intents remain in `dispatch_intents`; they contain `{ kind: "managed-input", text }` and are consumed only by `ManagedRuntimeDispatch` (`FactoryService.dispatchNext`). They are never returned to execution nodes.

Bounded remote effects live separately in `execution_jobs`. The trusted in-process bridge is `FactoryService.enqueueManagedRemoteExecution(threadId, piTaskId, piCallId, operation)`. It looks up the active accepted input and derives request ID, actor, node, workspace, and ownership generation from persisted Factory rows. The model supplies only the bounded operation arguments. There is no public or owner-facing job-injection route.

Each managed effect ID is deterministic from the accepted request and durable Pi conversation/task/tool-call evidence. Pi Durable records that evidence in the tool task memo before dispatch. Reusing a Pi call returns the existing remote receipt; reusing an effect ID for another payload or Pi evidence is a conflict. The Core receipt correlates remote effect receipts in optional `executionEffects`, and committed events correlate request ID, Pi task/call, job ID, destination, and generation.

`dispatchStatus: "dispatched"` means Pi Durable accepted the submission, not that its model run or workspace effect completed. Hosts settle command receipts only from Pi's durable submission record. Interrupted controller work is `uncertain`; a reported uncertain remote effect also fences its parent receipt as uncertain. A managed-tool wait timeout cancels a definitely unclaimed effect or fences a claimed effect from future node claims. One late report from the same persisted node assignment may reconcile the effect receipt, but it does not rewrite the already-uncertain parent Pi command. Duplicate dispatch or a later blind retry never completes these receipts.

## Authenticated execution-node protocol

The owner provisions a node with `POST /v1/nodes` and creates each allowed workspace with `POST /v1/workspaces`. The one-time-visible node bearer credential is bound to the provisioned node actor. Node routes derive identity from that credential and match it to the path and schema body:

- `POST /v1/nodes/:nodeId/register`
- `POST /v1/nodes/:nodeId/heartbeat`
- `POST /v1/nodes/:nodeId/jobs/claim`
- `POST /v1/nodes/:nodeId/jobs/:jobId/report`

All four requests and responses use `@uzina/contracts/execution`. Registration persists the node's capability report and owner-permitted workspace/generation/state reports. Claims persist claim evidence and return the same assigned job on retry after a lost acknowledgement; reports are checked against the persisted assignment and payload digest and exact duplicates reconcile the original report. Neither lost acknowledgements nor controller/node reopen require an in-memory prior claim. Interrupted node effects remain uncertain and are not replayed.

Remote-effect admission validates the persisted node, active selected workspace, online heartbeat, current ownership generation, and capability. Effects use immutable stable IDs and payload hashes. A controller report stores its full correlated receipt and event. A failed model or unavailable destination does not create a remote job.

## Managed-work capture quiescence

The local host's `captureManagedWorkCheckpoint({ credential, threadId, transport })` first authenticates the supplied owner credential, then uses Core `beginManagedWorkCapture()` to acquire a durable thread/workspace admission fence and a trusted `workspaceCaptureQuiescence` adapter before reading Pi or the workspace. The local `ExecutionDaemon` adapter persists the same capture ID, rejects queued/running/uncertain local effects and blocking Rex processes, and blocks subsequent direct job/Rex admission. Core reuses its existing owner authorization checks. Capture refuses a workspace assigned to multiple threads and rejects queued, unavailable, running, dispatched, or uncertain managed inputs plus queued, claimed, or uncertain workspace effects. It does not pause unrelated work. While the fence exists, Core rejects new input/thread/effect admissions and prevents queued claims or unavailable-input requeue for the selected resources. The local host releases the fence after a known success/failure; a process crash leaves the durable lock in place.

An owner can inspect restart-surviving locks with `FactoryService.listManagedWorkCaptures(session)`. After verifying the node state, clear both durable halves using `ExecutionDaemon.endWorkspaceCapture(captureId)` and `FactoryService.endManagedWorkCapture(session, captureId)`; neither is auto-expired. The local host waits for in-flight captures before shutdown. The in-process provenance seam `getManagedWorkCaptureProvenance(session, threadId, captureId)` is available only under the active owner-authorized fence and returns the selected command/effect receipts for the bundle attachment. These are evidence, not imported users, credentials, permissions, or execution authority. Capture does not transfer ownership or fence a different machine.

The source requires a trusted local workspace-ID-to-directory mapping supplied as `workspaceDirectories` and an executor/Rex quiescence adapter supplied as `workspaceCaptureQuiescence` to `createStandaloneFactoryServer`; without either capture refuses. It also refuses two configured workspace IDs that resolve to the same local directory. No public HTTP capture route is added. The daemon's current `startLocalFactory` does not yet supply either adapter, so production local CLI/workspace setup remains host wiring. Remote executor quiescence/acknowledgement is not implemented; never treat a controller-side workspace report as proof that an offline remote executor or Rex process is stopped.

## Authorized queries and MCP transport

Authenticated clients may query `GET /v1/threads/:threadId/context` for canonical Pi model context, `GET /v1/threads/:threadId/status` for Pi Durable inspection/status, and `GET /v1/commands/:requestId` for the durable input receipt and admitted effect receipts. `GET /v1/threads/:threadId/runs?limit=1..100` lists accepted input command receipts for that thread; the current application has no separate persisted Run resource. `GET /v1/threads/:threadId/lifecycle-capabilities` reports the supported lifecycle profile. `GET /v1/events` returns committed events in an authorized bounded cursor page.

`POST /v1/mcp` is a separately importable `@uzina/core/mcp` adapter built on the official `@modelcontextprotocol/sdk` `1.32.2` Web Standard Streamable HTTP transport. It uses stateless JSON responses: the SDK server/transport is created per HTTP request with session generation disabled. Each request must carry `Authorization: Bearer <active Factory credential>`; each request authenticates against the current Factory credential store, and Core rechecks active credentials and current grants for data and mutations. MCP `GET` SSE is not supported (authenticated requests receive `405 Allow: POST`). Query parameters, including `access_token`, are refused. There is no CORS response or wildcard origin; if `Origin` is present it must exactly match the request URL origin, and a mismatched `Host` is refused. The official SDK client has been tested through initialize, tool listing, and tool calls.

The MCP tools are `list_projects`, `list_threads`, `list_runs`, `get_receipt`, `get_context`, `get_status`, `list_nodes`, `list_workspaces`, `submit_input`, `get_events`, `get_lifecycle_capabilities`, and `request_lifecycle_operation`. Each work target is an explicit project/thread/request ID. Lists/events have a maximum page size of 100; serialized tool results are limited to 256 KiB. `submit_input` requires a stable application `requestId`, independent of MCP JSON-RPC correlation IDs, so lost acknowledgements reconcile with `get_receipt` or a repeated identical call. `stop`, `native-cli`, and `transfer` are explicitly refused before effects; no corresponding operation is simulated.

The token's resource audience is the single Factory represented by the authenticated Core database: token hashes are looked up only there, so a credential issued by one Factory is rejected by another. The endpoint additionally checks exact request Host/Origin binding. This is not an OAuth/resource-indicator issuer and does not make deployment ingress private; a Worker route or Access policy is not configured by this package. MCP never forwards the caller's credential to an execution node or model provider.

## Owner-administered assistant access

Assistant credentials are normal authenticated Core actors with an immutable assistant ID and accountable `ownerId`; that attribution does not grant human owner administration. `POST /v1/credentials` may specify `assistantGrants` as exactly one `{ "type": "factory" }` grant or a strict set of existing project/thread grants. Thread grants to owner-private threads are rejected. `PUT /v1/credentials/:credentialId/grants` replaces the stored scope and increments its access generation; only the human owner may provision, change, or revoke assistant grant authority. Revoke or replace the credential when removing its authority. Human browser credentials are not used in assistant tools.

For backwards compatibility, owner-provisioned assistant credentials created through the legacy request with no `assistantGrants` receive an explicit persisted factory-wide grant. Database initialization migrates pre-existing grantless assistant credentials to that same explicit row; there is no implicit assistant `isOwner` bypass. Scoped assistant grants apply through the same `FactoryAccessPolicy` for REST and MCP and are rechecked before dispatching queued input and authorizing new remote effects. A factory-wide assistant retains the previous access to owner-private context; human Guests/Viewers cannot access owner-private threads. Grant scope is not an OS sandbox, and revocation cannot undo external effects already admitted or dispatched.

## Production seams and limits

- `FactoryService.registerExecutionNode`, `heartbeatExecutionNode`, `claimExecutionJob`, and `reportExecutionJob` implement the node-facing Core operations.
- `FactoryService.enqueueRemoteExecution` / `getRemoteExecutionReceipt` are trusted in-process bridge seams; they must not be exposed as an anonymous or owner-facing job injection API.
- `enqueueManagedRemoteExecution` is the managed-Pi bridge and does not accept actor, node, workspace, or generation supplied by the model.
- `@uzina/contracts/execution` remains the wire contract. Optional command `cwd` is interpreted as a relative path within the selected workspace; the daemon rejects traversal, absolute paths, missing/non-directory paths, and symlink escapes.
- `FactoryObject` runs Core over `state.storage.transactionSync`; the actual workerd class binding and local SQLite adapter are both covered by composed tests.
- This slice proves a local standalone execution path and a Miniflare/workerd composition. It does not claim a production Cloudflare deployment, Tailscale ingress configuration, or a second-laptop operation. Arbitrary external writes and commands cannot be made exactly-once; uncertain receipts require reconciliation.
