# Slice 4: connect the foundations without conflating two queues

## Current baseline

The integrated foundations at `71fcccd` pass 61 tests, including real Miniflare/workerd managed-task recovery. Root app entrypoints are still health/identity demonstrations; neither Cloudflare Durable Object is yet bound by the production Worker configuration. Independent review found five P2 defects now assigned to isolated correction lanes: descendant process timeout cleanup, wildcard include pruning, non-reserved runtime roots, incomplete empty-store validation, and limits checked after Git payload materialization.

An additional integration risk is visible in `apps/cloudflare/src/factory-object.ts`: its SQL adapter currently calls `transactionSync` on `storage.sql`, whereas the production Durable Object transaction belongs to `storage`. Validate and correct this against actual workerd behavior before claiming the Factory host works.

## Step 4a: authenticated controller-to-executor protocol

- Make the controller implement the concrete `@uzina/contracts/execution` register, heartbeat, claim, and report schemas used by `HttpExecutionControllerConnector`.
- Keep managed-input dispatch intent separate from remote-tool execution jobs. A node must never claim a `FactoryQueueJob` containing model input as though it were a shell/file job.
- Introduce a persistent remote-tool job queue with explicit node/workspace/generation, stable identity, immutable payload digest, claim/reclaim evidence, and correlated final reports.
- Derive node identity from the provisioned credential and validate path/body/target consistency. Register only workspace mappings permitted by the owner; never let a body choose arbitrary host directories.
- Preserve a retry path for lost claim and report acknowledgements. Node restart must reconcile the existing persistent receipt without requiring an in-memory connector assignment that was lost. An uncertain effect is not replayed.
- Add a bounded executor loop that registers, heartbeats, claims, executes, and reports. Give it explicit startup/shutdown lifecycle independent of browser connections. Keep node credentials out of logs.
- Verify the protocol over real HTTP with a temporary persistent controller and temporary workspace. Prove one concrete file mutation, duplicate delivery, lost acknowledgement, stale generation, and revoked/wrong-node credentials.
- Keep Core-to-Pi dispatch injectable. This step may be completed before managed tool integration, but does not by itself complete slice 4.

## Step 4b: managed conversation uses the selected executor

- Dispatch an accepted Factory input to its stable per-thread Pi managed-work storage unit. Thread identity is stable across host restart; do not create another conversation on retry.
- Bind `RemoteToolExecutor` to the exact authorized placement and ownership generation. Give each remote effect a durable identity tied to runtime execution evidence. Do not allocate a new effect merely because the network reply was lost.
- Read-only tool replay and unsafe write/command replay remain distinct. Runtime recovery must reconcile known job evidence or retain uncertainty, not rerun arbitrary effects.
- Connect managed completion/failure/uncertainty back to the existing Factory receipt and committed event stream. A runtime accepting input is not the same as completing it.
- Wire local standalone composition and the cloud Factory/ManagedWork Durable Objects into root entrypoints and Wrangler bindings/migrations. Fail closed when real model/provider configuration is missing; the deterministic provider belongs to test composition, not an apparently functioning production default.
- Configure authenticated business requests, private human-facing access, explicit node credentials, and bounded output. A public Worker endpoint is not automatically protected by Tailscale.
- Preserve the managed runtime's pre-armed recovery alarms. Validate Factory SQL transactions, managed-work recovery, and the composed controller in actual workerd rather than only Bun adapters.

## Acceptance gates

1. A deterministic external model selects a remote bounded file or command tool in a managed conversation.
2. A separately authenticated execution daemon, connected outbound through the real controller protocol, performs the effect in its selected temporary workspace.
3. The original accepted command becomes observably completed, with the resulting model context and committed Factory events queryable through authorized requests.
4. Lost browser acceptance, duplicate node delivery/report, connection loss, and host reopen retain identities and do not duplicate effects.
5. Node unavailability, unsupported capabilities, stale ownership, and uncertain outcomes are explicit and do not silently move execution.
6. The composed scenario runs locally and through the real Cloudflare-compatible runtime. Production deployment and the actual second laptop are recorded separately; Wrangler is currently unauthenticated and laptop B has not been identified.

## Scope discipline

Do not add invitations, rich UI, native CLI-provider adapters, checkpoint ownership transfer, or a second model scheduler to finish this slice. Those are separately reviewed slices. Each implementation increment includes its own behavior-focused tests and a clean local Git checkpoint before dependent work branches.
