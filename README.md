# Uzina

Uzina is a single-factory Bun workspace with portable Factory Core, managed Pi runtime, execution daemon, and workspace checkpoint modules. Slice 4a now connects the owner-authenticated Factory controller to outbound authenticated execution nodes over the concrete `@uzina/contracts/execution` protocol. Slice 4b remains pending: no managed Pi tool bridge, production Cloudflare binding, or production cloud-to-laptop completion is claimed.

## Local verification

Use Bun 1.4.4 and Node 24.20.0. Install from the checked-in lockfile and run:

```sh
bun install --frozen-lockfile
bun run format
bun run check
bun run typecheck
bun run test
bun run build
```

`bun run build` bundles the daemon and performs a Wrangler dry-run build; it does not deploy. `bun run dev:daemon` defaults to `http://127.0.0.1:8788` and serves health/identity routes. The daemon can instead run as a connected executor only when `UZINA_MODE=connected-executor` and all explicit controller, owner-provisioned node credential, SQLite path, and workspace mapping configuration is supplied. See `apps/daemon/README.md`.

`POST /v1/nodes` provisions a node identity and one-time-visible bearer credential. The owner separately provisions its workspaces. Node register/heartbeat/claim/report requests use the validated execution contracts. Factory managed-input intents and remote effect jobs have separate durable queues; only the trusted in-process `FactoryService.enqueueRemoteExecution` seam admits remote effects, and no public job-injection route exists.

The local Factory host is exercised over real HTTP with a persistent SQLite controller and an `ExecutionDaemon` mutating a temporary workspace. A separate Miniflare/workerd test proves Factory bootstrap, managed-input admission, and receipt reconciliation after Durable Object eviction. The Cloudflare Factory Durable Object uses `state.storage.transactionSync()`; this workerd test specifically validates the production transaction receiver.

## Integrated foundation seams

- `@uzina/pi-runtime` and `@uzina/pi-runtime/checkpoint` provide the Bun-compatible Pi Durable facade and supported `quiescent-current-documents-no-forks-v1` checkpoint profile.
- `@uzina/core` provides owner-authenticated Factory operations, durable managed-input receipts/events, and the separate authenticated remote execution queue.
- `@uzina/contracts/execution` and `apps/daemon/src/execution` provide workspace-bounded jobs, local receipts, outbound controller HTTP, and a cancellable node-owned executor loop.
- `@uzina/checkpoints` captures and validates workspace Git/filesystem state and restores an inactive checkout.

The PWA, invitation/assistant flows, managed Pi-to-node tool bridge, root Worker Durable Object bindings, and checkpoint ownership transfer remain unimplemented. Wrangler dry-run and Miniflare evidence are not production deployment evidence; no production Cloudflare credentials or second-laptop operation are claimed.
