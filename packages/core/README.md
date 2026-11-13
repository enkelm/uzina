# Factory Core foundation

`@uzina/core` provides the owner-authenticated Factory service and durable queue seam. The public exports are `FactoryService`, `FactoryError`, `createFactoryHttpHandler`, `FactoryDatabase`, `RuntimeDispatchAdapter`, and related types; `@uzina/core/http` and `@uzina/core/database` are independently importable subpaths. The validated Factory API and queue types are at `@uzina/contracts/factory`.

The local `BunFactoryDatabase` and Cloudflare `FactoryObject` adapters are present but neither is wired into the root daemon or Worker entry point. The injected `RuntimeDispatchAdapter` is an explicit managed-runtime seam and accepts a `FactoryQueueJob`; it is not the executor node protocol.

## Slice 4 integration boundary

Factory routes currently reserve `/v1/nodes/:nodeId/register`, `/heartbeat`, `/jobs/claim`, and `/jobs/:jobId/report`, but their payloads do not match `@uzina/contracts/execution` or `HttpExecutionControllerConnector`:

- Factory register/heartbeat requests are empty objects; execution requests include version, daemon version or timestamp, workspace generation/state reports, and capabilities.
- Factory claim returns a `FactoryQueueJob` whose input is `{ kind: "managed-input", text }`; execution claim returns one `ExecutionJob` with a `read-file`, `write-file`, or `argv-command` operation.
- Factory reports carry workspace, generation, status, and optional detail; execution reports additionally bind the job/node/target, payload digest, finish time, and optional result/error/reconciliation evidence.

Do not route one schema through the other or claim these protocols are connected. Slice 4 must define and implement the authorized controller-side node API for the execution contract, connect its queued bounded tool operations to the managed Pi remote-tool executor, and separately dispatch `FactoryQueueJob` through the stable managed-work submission/receipt API. Keep the actor, workspace/node identity, and ownership-generation checks explicit at each boundary.
