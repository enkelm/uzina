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

## Authorized thread queries

Authenticated owner/assistant clients may query `GET /v1/threads/:threadId/context` for canonical Pi model context and `GET /v1/threads/:threadId/status` for Pi Durable inspection/status. Core first resolves and authorizes the persisted thread. `GET /v1/commands/:requestId` returns the managed command receipt and any admitted remote execution receipts, including queued/running/completed/failed/uncertain outcomes. `/v1/events` exposes committed receipt transitions in cursor order.

These current permissions are intentionally limited: there are no invitations, workforce roles, guest grants, or project/thread ACLs in this slice. The application is not a host OS sandbox.

## Production seams and limits

- `FactoryService.registerExecutionNode`, `heartbeatExecutionNode`, `claimExecutionJob`, and `reportExecutionJob` implement the node-facing Core operations.
- `FactoryService.enqueueRemoteExecution` / `getRemoteExecutionReceipt` are trusted in-process bridge seams; they must not be exposed as an anonymous or owner-facing job injection API.
- `enqueueManagedRemoteExecution` is the managed-Pi bridge and does not accept actor, node, workspace, or generation supplied by the model.
- `@uzina/contracts/execution` remains the wire contract. Optional command `cwd` is interpreted as a relative path within the selected workspace; the daemon rejects traversal, absolute paths, missing/non-directory paths, and symlink escapes.
- `FactoryObject` runs Core over `state.storage.transactionSync`; the actual workerd class binding and local SQLite adapter are both covered by composed tests.
- This slice proves a local standalone execution path and a Miniflare/workerd composition. It does not claim a production Cloudflare deployment, Tailscale ingress configuration, or a second-laptop operation. Arbitrary external writes and commands cannot be made exactly-once; uncertain receipts require reconciliation.
