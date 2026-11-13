# Factory Core

`@uzina/core` provides owner-authenticated Factory operations over the portable `FactoryDatabase` interface. The local Bun SQLite and Cloudflare Durable Object adapters use the same service behavior.

## Separate durable queues

Factory managed-input intents remain in `dispatch_intents`; they contain `{ kind: "managed-input", text }` and are consumed only by the injected `ManagedRuntimeDispatch` boundary (`FactoryService.dispatchNext`). They are not node jobs.

Remote effects are persisted separately in `execution_jobs`. The trusted in-process slice-4b bridge seam is `FactoryService.enqueueRemoteExecution(job)` with `FactoryService.getRemoteExecutionReceipt(jobId)` for reconciliation. Admission validates the concrete `@uzina/contracts/execution` job schema, stable job ID/payload hash, provisioned node/workspace assignment, online heartbeat, current ownership generation, and active workspace report. There is deliberately no public HTTP job-injection route.

## Authenticated execution-node protocol

The owner provisions a node with `POST /v1/nodes` and creates each allowed workspace with `POST /v1/workspaces`. The one-time-visible node bearer credential is bound to the provisioned node actor. Node routes derive identity from this credential and match it to the path and schema body:

- `POST /v1/nodes/:nodeId/register`
- `POST /v1/nodes/:nodeId/heartbeat`
- `POST /v1/nodes/:nodeId/jobs/claim`
- `POST /v1/nodes/:nodeId/jobs/:jobId/report`

All four requests and responses use `@uzina/contracts/execution`. Registration persists the node's capability report and owner-permitted workspace/generation/state reports. Claims persist claim evidence and return the same assigned job on retry after a lost acknowledgement; reports are checked against the persisted assignment and payload digest and exact duplicates reconcile the original report. Neither lost acknowledgements nor controller/node reopen require an in-memory prior claim. Interrupted node effects remain uncertain and are not replayed.

## Production seams and limits

- `FactoryService.registerExecutionNode`, `heartbeatExecutionNode`, `claimExecutionJob`, and `reportExecutionJob` implement the node-facing Core operations.
- `FactoryService.enqueueRemoteExecution` / `getRemoteExecutionReceipt` are trusted in-process bridge seams for slice 4b. They must not be exposed as an anonymous or owner-facing job injection API.
- `@uzina/contracts/execution` remains the wire contract. The legacy empty Factory register/heartbeat/claim/report schemas and the managed-input node claim/report methods have been removed.
- `FactoryObject` now calls `state.storage.transactionSync` (not `state.storage.sql.transactionSync`). The workerd-compatible adapter is exercised by `apps/cloudflare/test/factory-object.workerd.test.ts`.
- This implements slice 4a controller-to-executor protocol only. It does not connect managed Pi tools to the remote-job admission seam, dispatch managed submissions through Pi Durable, bind Factory/ManagedWork Durable Objects in the production Worker, or prove production Cloudflare/laptop operation. Those are slice 4b/operator gates.
