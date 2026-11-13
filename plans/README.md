# Uzina implementation progress

Implement the scope in `SPEC.md` through the slices below. A slice is complete only when its observable acceptance behavior has been reviewed and its checks have run. Emulator coverage, local coverage, and actual deployments are separate evidence.

## Slice ledger

| Slice | Outcome                                                                                    | Dependencies                           | Status                                           |
| ----- | ------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------ |
| 0     | Bun workspace foundation, initial validated contracts, repeatable checks                   | None                                   | Complete                                         |
| 1     | Persistent Pi Durable under Bun and Cloudflare; early managed-checkpoint feasibility proof | 0                                      | Integrated; pending review                       |
| 2     | Authenticated execution daemon, explicit workspace jobs, Rex lifecycle                     | 0                                      | Integrated; pending review                       |
| 3     | Owner-authenticated Factory commands, durable receipts, committed events                   | 0                                      | Integrated; pending review                       |
| 4     | Cloud-managed Pi executes a bounded tool on a selected laptop                              | 1, 2, 3                                | Slice 4a implemented; review pending; 4b pending |
| 5     | Minimal operational PWA with retained request identities and reconnect handling            | 3, 4                                   | Not started                                      |
| 6     | Persistent invitations, scoped roles, revocation, subscription enforcement                 | 3                                      | Not started                                      |
| 7     | MCP tools and private Factory assistant using ordinary authorized operations               | 1, 3, 4                                | Not started                                      |
| 8     | Coherent workspace and managed-runtime checkpoints; validated inactive restore             | 1, 2; workspace work can start after 0 | Workspace foundation integrated; pending review  |
| 9     | Safely relocate workspace execution between nodes                                          | 4, 8                                   | Not started                                      |
| 10    | Transfer supported managed work from cloud to standalone local execution                   | 8, 9                                   | Not started                                      |

## Execution rules

- One writer per checkout. Independent implementation lanes use isolated Git worktrees from a clean reviewed baseline.
- Keep local Git checkpoints for isolation and review; do not push or publish issues without an explicitly configured destination.
- One integrator owns shared contracts, root workspace configuration, lockfile reconciliation, and final composition.
- Each slice includes behavior-focused tests; recovery is not postponed to a final testing slice.
- Probe actual Pi Durable checkpoint portability early. Storage compatibility alone does not prove safe export/import.
- Keep command acceptance, effect completion, and uncertain outcomes distinguishable. Do not blindly replay uncertain external effects.
- Source execution must reach a confirmed safe inactive state before a move. Ownership numbers alone do not stop disconnected running processes.
- The controller remains authoritative; connected nodes are not independent mutable copies of the factory.
- Owner authentication is required before remote operations. Human access remains private; node connections need explicit application credentials.
- No live model calls, existing Rex-session mutation, credential export, or real cloud deployment as a side effect of tests.
- Record missing credentials, machine access, and unavailable runtime checks as blockers rather than claiming completion.

## Verification evidence

Slice 0 adds a Bun 1.4.4 workspace, frozen lockfile, validated shared schemas, HTTP behavior tests, and Wrangler local-compatible tooling. Passed: `bun install --frozen-lockfile`, `bun run format`, `bun run check`, `bun run typecheck`, `bun run test` (8 tests), and `bun run build` (Bun bundle plus Wrangler dry run). Also started the local daemon with `PORT=18788 bun run dev:daemon` and Wrangler with `bun run dev:cloudflare --port 18787`; both returned versioned health and validated identity responses, and Wrangler returned HTTP 400 for an invalid identity. No production Cloudflare deployment or Durable Object behavior is claimed.

Foundation review: the parent independently reran frozen install, formatting check, typecheck, all 8 tests, and both builds successfully. Parallel implementation agreements are recorded in `plans/integration-contracts.md`.

Early feasibility: Pi Durable/chord 1.4.0 supplies public storage records and a Cloudflare SQLite adapter, but no first-party Bun driver or complete managed-work checkpoint exporter. Runtime and checkpoint lanes must prove these missing pieces or explicitly report unsupported states.

## Integration checkpoint

Slices 1, 2, 3, and the workspace portion of 8 have been copied into the main workspace for review. Slice 4a now implements the authenticated Factory-to-execution-node protocol, separate durable managed-input and remote-effect queues, the connected daemon loop, and a real local HTTP/workerd test seam. Slice 4b has not connected managed Pi tools or Factory dispatch to those seams. No ownership transfer is implemented. See `plans/integration-contracts.md`, `plans/slice-4-integration.md`, and the package READMEs for exact interfaces and remaining gates.

### Reviewed correction integration

Three isolated correction sets have been integrated without taking their plan-document deletions: command timeout process-group cleanup, checkpoint wildcard traversal and bounded Git output generation, and managed-runtime checkpoint root/fresh-store validation. Behavior-focused regression coverage now exercises descendant termination, wildcard directory matches, bundle and staged-patch size bounds, non-reserved checkpoint roots, and orphan scoped documents in an import destination. These corrections are integrated evidence, not acceptance of their parent slices; independent review remains pending, slices 1, 2, and 8 remain pending review, and slice 4 remains not started.

The supported managed-runtime checkpoint profile remains `quiescent-current-documents-no-forks-v1`: export is limited to the unowned, parentless reserved `ROOT_CONVERSATION_ID` (1); tasks must be terminal and receipts settled; fork/history-dependent conversations and session-scoped documents are unsupported; document export preserves current values, not revision history. Import requires a genuinely fresh, exclusively held destination. The public-storage freshness guard requires the first `mintId()` result to be 2 and checks all record kinds at reserved ID 1; it rejects stores that cannot prove freshness, including stores with orphan allocated IDs. Storage exposes no public atomic transaction combining this proof with import, so no concurrent writer is permitted during the operation. The guard consumes the initial minted ID, so do not retry on the same storage instance after the guard has run, including after a later import failure. See `packages/pi-runtime/README.md` for the complete limits and behavior.

Operator blockers: `bunx wrangler whoami` reported `You are not authenticated` (exit 0); laptop B is not established. There is no production Cloudflare binding/deployment evidence, no live model call, and no node-to-controller execution proof.

Integration validation in the main checkout:

- `bun install` — passed; reconciled workspace dependencies and saved `bun.lock` (96 packages installed).
- `bun install --frozen-lockfile` — passed; checked 149 installs across 228 packages with no changes.
- `bun run format` — passed; formatted the integrated sources and docs.
- `bun run check` — passed; all selected TypeScript, JSON, and README files conform to Prettier.
- `bun run typecheck` — passed (`tsc --noEmit`).
- `bun run test` — passed after correction integration: 68 tests across 11 files, 432 assertions, including descendant process-group termination, bounded Git output and wildcard traversal, managed-checkpoint root/fresh-store validation, Bun SQLite persistence/execution/Factory/workspace checkpoint tests, and the Miniflare workerd Durable Object eviction/recovery test.
- `bun run build` — passed: Bun daemon bundle (13 modules, 115.68 KiB) and Wrangler dry-run Worker bundle (126.46 KiB upload, 21.00 KiB gzip). Wrangler printed `No bindings found`; this does not validate ManagedWork or Factory Durable Object bindings or deployment.
- `git diff --check` — passed.

### Slice 4a checkpoint validation

In the main checkout after implementing slice 4a:

- `bun run format` — passed.
- `bun run check` — passed.
- `bun run typecheck` — passed.
- `bun run test` — passed: 70 tests across 13 files, 460 assertions. This includes real local HTTP Factory-to-ExecutionDaemon file mutation/lost-ack/reopen coverage and a real Miniflare/workerd Factory Durable Object bootstrap/admission/eviction/reopen test.
- `bun run build` — passed: daemon bundled (20 modules, 171.71 KiB) and Wrangler dry-run completed (126.46 KiB upload estimate, 21.00 KiB gzip). Wrangler reported `No bindings found`; no Worker Durable Object binding/deployment is claimed.
- `git diff --check` — passed.

Production seams added: concrete authenticated node routes in `@uzina/core/http`; `FactoryService.registerExecutionNode`, `heartbeatExecutionNode`, `claimExecutionJob`, `reportExecutionJob`; trusted in-process `enqueueRemoteExecution` / `getRemoteExecutionReceipt`; local durable `ExecutionDaemon.pendingReports` / `markReported`; `ExecutionLoop`; and explicit `UZINA_MODE=connected-executor` startup. The managed Pi bridge and production Worker bindings remain slice 4b.

### Slice 4a independent-review blocker follow-up

The independent review of `e105be2` found two P2 defects. Before the fixes, `bun test apps/daemon/test/execution.test.ts apps/daemon/test/execution-controller.test.ts` failed four new regressions: a missing-file job stayed claimed and prevented a later job from reporting; a long argv effect had no intervening heartbeat; and deterministic oversized-write/traversal preflight failures threw without durable receipts.

Implemented only those fixes:

- Valid assigned jobs whose deterministic preflight fails now persist a terminal `failed` receipt and report. Invalid schemas, target identity, ownership generation, and conflicting job IDs still hard-fail before effects. The real HTTP regression reports a missing-file read as failed, then completes the next queued write, and verifies reopen/retry does not resurrect the failed job.
- `ExecutionLoop` has a single background heartbeat task concurrent with effects. Cancellation stops its timer, waits for the bounded in-flight effect before returning/closing node storage, then reconciles a completed effect. Credential rejection stops later claims and propagates to startup. The loop rejects a second concurrent `run`; the bounded long-job test injects a short interval through the existing loop options, leaving production defaults unchanged.
- A separate Miniflare execution claim/report round-trip across eviction was not added: the cloud Factory composition intentionally has no trusted job-admission binding yet, and providing one solely to seed the test would add a test-only/public admission path before slice 4b. The existing workerd proof still covers Factory bootstrap, managed-input admission, transaction receiver, eviction, and receipt deduplication; execution queue persistence/recovery remains covered against the actual local HTTP/SQLite host.

Post-fix validation in the main checkout:

- `bun test apps/daemon/test/execution.test.ts apps/daemon/test/execution-controller.test.ts` — passed: 14 tests, 107 assertions.
- `bun run format` — passed.
- `bun run check` — passed.
- `bun run typecheck` — passed.
- `bun run test` — passed: 72 tests across 13 files, 485 assertions, including the existing Miniflare/workerd tests.
- `bun run build` — passed: daemon bundle 20 modules / 174.51 KiB; Wrangler dry-run 126.46 KiB estimated upload / 21.00 KiB gzip. Wrangler reported `No bindings found`; no deployment or production Worker claim.
- `git diff --check` — passed.

Independent reviewer approval remains pending. Slice 4b, production Cloudflare bindings, managed-Pi tool integration, and cloud-to-laptop operation remain unclaimed.

## Workflow

1. Scaffold and review slice 0.
2. Run parallel lanes for managed runtime, execution, Factory operations, and workspace checkpoints.
3. Integrate and review the cloud-to-laptop scenario.
4. Complete PWA, invitations, MCP/assistant, and full checkpoint behavior in parallel.
5. Implement and review execution relocation, then managed-runtime relocation.
6. Run the full supported verification suite and document actual-machine deployment evidence or remaining operator blockers.
