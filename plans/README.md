# Uzina implementation progress

Implement the scope in `SPEC.md` through the slices below. A slice is complete only when its observable acceptance behavior has been reviewed and its checks have run. Emulator coverage, local coverage, and actual deployments are separate evidence.

## Slice ledger

| Slice | Outcome                                                                                    | Dependencies                           | Status                                                                                       |
| ----- | ------------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0     | Bun workspace foundation, initial validated contracts, repeatable checks                   | None                                   | Complete                                                                                     |
| 1     | Persistent Pi Durable under Bun and Cloudflare; early managed-checkpoint feasibility proof | 0                                      | Integrated; pending review                                                                   |
| 2     | Authenticated execution daemon, explicit workspace jobs, Rex lifecycle                     | 0                                      | Integrated; pending review                                                                   |
| 3     | Owner-authenticated Factory commands, durable receipts, committed events                   | 0                                      | Integrated; pending review                                                                   |
| 4     | Cloud-managed Pi executes a bounded tool on a selected laptop                              | 1, 2, 3                                | 4a/4b integrated locally and in workerd; reviewer gate pending; production/laptop unverified |
| 5     | Minimal operational PWA with retained request identities and reconnect handling            | 3, 4                                   | Not started                                                                                  |
| 6     | Persistent invitations, scoped roles, revocation, subscription enforcement                 | 3                                      | Not started                                                                                  |
| 7     | MCP tools and private Factory assistant using ordinary authorized operations               | 1, 3, 4                                | Not started                                                                                  |
| 8     | Coherent workspace and managed-runtime checkpoints; validated inactive restore             | 1, 2; workspace work can start after 0 | Workspace foundation integrated; pending review                                              |
| 9     | Safely relocate workspace execution between nodes                                          | 4, 8                                   | Not started                                                                                  |
| 10    | Transfer supported managed work from cloud to standalone local execution                   | 8, 9                                   | Not started                                                                                  |

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

Slices 1, 2, 3, and the workspace portion of 8 have been copied into the main workspace for review. Slice 4a implemented the authenticated Factory-to-execution-node protocol and separate durable managed-input/remote-effect queues; slice 4b now connects accepted inputs through managed Pi tools to local and workerd execution, receipts/events, and model context. Code/test evidence is local and Miniflare/workerd only; production Cloudflare configuration and a second laptop remain unverified. No ownership transfer is implemented. See `plans/integration-contracts.md`, `plans/slice-4-integration.md`, and the package READMEs for exact interfaces and remaining gates.

### Historical reviewed-correction integration (before slice 4b)

Three isolated correction sets have been integrated without taking their plan-document deletions: command timeout process-group cleanup, checkpoint wildcard traversal and bounded Git output generation, and managed-runtime checkpoint root/fresh-store validation. Behavior-focused regression coverage now exercises descendant termination, wildcard directory matches, bundle and staged-patch size bounds, non-reserved checkpoint roots, and orphan scoped documents in an import destination. These corrections were integrated evidence, not acceptance of their parent slices. At that earlier checkpoint independent review remained pending, slices 1, 2, and 8 remained pending review, and slice 4 had not started; the later 4b evidence is recorded below.

The supported managed-runtime checkpoint profile remains `quiescent-current-documents-no-forks-v1`: export is limited to the unowned, parentless reserved `ROOT_CONVERSATION_ID` (1); tasks must be terminal and receipts settled; fork/history-dependent conversations and session-scoped documents are unsupported; document export preserves current values, not revision history. Import requires a genuinely fresh, exclusively held destination. The public-storage freshness guard requires the first `mintId()` result to be 2 and checks all record kinds at reserved ID 1; it rejects stores that cannot prove freshness, including stores with orphan allocated IDs. Storage exposes no public atomic transaction combining this proof with import, so no concurrent writer is permitted during the operation. The guard consumes the initial minted ID, so do not retry on the same storage instance after the guard has run, including after a later import failure. See `packages/pi-runtime/README.md` for the complete limits and behavior.

Historical operator blockers at that checkpoint: `bunx wrangler whoami` reported `You are not authenticated` (exit 0); laptop B was not established; and production deployment, live inference, and node-to-controller execution were not proven. The current 4b code/workerd evidence below adds root Durable Object bindings and HTTP node execution, but still does not claim production deployment, paid inference, or second-laptop operation.

Historical integration validation for the initial foundation (superseded by the current final run below):

- `bun install` — passed; reconciled workspace dependencies and saved `bun.lock` (96 packages installed).
- `bun install --frozen-lockfile` — passed; checked 149 installs across 228 packages with no changes.
- `bun run format` — passed; formatted the integrated sources and docs.
- `bun run check` — passed; all selected TypeScript, JSON, and README files conform to Prettier.
- `bun run typecheck` — passed (`tsc --noEmit`).
- `bun run test` — passed after correction integration: 68 tests across 11 files, 432 assertions, including descendant process-group termination, bounded Git output and wildcard traversal, managed-checkpoint root/fresh-store validation, Bun SQLite persistence/execution/Factory/workspace checkpoint tests, and the Miniflare workerd Durable Object eviction/recovery test.
- `bun run build` — passed: Bun daemon bundle (13 modules, 115.68 KiB) and Wrangler dry-run Worker bundle (126.46 KiB upload, 21.00 KiB gzip). Wrangler printed `No bindings found`; this does not validate ManagedWork or Factory Durable Object bindings or deployment.
- `git diff --check` — passed.

### Slice 4a checkpoint validation (historical before 4b)

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

Independent reviewer approval remains pending. This checkpoint predates slice 4b. Production Cloudflare deployment and cloud-to-laptop operation remain unverified.

### Re-review correction: filesystem failures and retry classification

A subsequent read-only review found that the first preflight fix handled typed `ExecutionError`s but missed native filesystem errors. The repro was a valid read job for `plain-file/child.txt` when `plain-file` was a regular file: `lstat` raised `ENOTDIR`, leaving the node receipt absent and the Factory job claimed. It also identified that `ExecutionLoop` swallowed local and protocol errors in broad retry catches.

The correction now maps an explicit allowlist of expected path errors (`ENOENT`, `ENOTDIR`, `EACCES`, `EPERM`, `ELOOP`, `EISDIR`, `ENAMETOOLONG`) to safe reportable execution failures. The mapping is confined to filesystem preflight/effect handling; receipt persistence errors and unrecognized/programming errors propagate instead of becoming filesystem receipts. The loop retries only connector-classified transport loss and transient HTTP responses (408, 425, 429, and 5xx); credential refusal remains terminal, and local storage/protocol/other HTTP failures fail closed. Existing 502 lost-ack reconciliation remains exercised by the real HTTP integration test.

The real HTTP queue-progress regression now queues a missing leaf, an intermediate regular-file path (`ENOTDIR`), an overlong path component, and then a valid workspace write. It verifies all failure reports, the later successful mutation, and failed-receipt persistence/reconciliation after controller and executor reopen. Additional regressions verify that failed receipt persistence surfaces a SQLite trigger error and that local-storage and protocol failures terminate the loop instead of retrying indefinitely.

Post-correction validation in the main checkout:

- `bun test apps/daemon/test/execution.test.ts apps/daemon/test/execution-connector.test.ts apps/daemon/test/execution-controller.test.ts` — passed: 20 tests, 146 assertions.
- `bun run format` — passed.
- `bun run check` — passed.
- `bun run typecheck` — passed.
- `bun run test` — passed: 75 tests across 13 files, 510 assertions.
- `bun run build` — passed: daemon bundle 20 modules / 176.12 KiB; Wrangler dry-run 126.46 KiB estimated upload / 21.00 KiB gzip. Wrangler printed `No bindings found`; no deployment or production Worker binding is claimed.
- `git diff --check` — passed.

At that checkpoint independent reviewer approval of the correction remained required and slice 4b had not started. The current slice 4b evidence and still-unverified production/cloud-to-laptop gates are recorded below.

### Slice 4b local/workerd integration checkpoint

The implementation follows the slice 4b status recorded in `plans/slice-4-integration.md`: Factory input dispatch, Pi Durable bounded tools, the stable execution bridge, receipt/event settlement, authorized context/status queries, and real provider configuration are composed in standalone local SQLite and production-shaped workerd Durable Objects. Managed inputs and remote execution effects remain separate queues. The root ledger is explicit that independent review is pending and actual production/laptop operation has not occurred.

Final integration validation in this checkout:

- `bun install --frozen-lockfile` — passed; checked 149 installs across 228 packages with no changes.
- `bun run format` — passed; formatted changed sources and docs.
- `bun run check` — passed; Prettier check covers all changed READMEs and plan Markdown.
- `bun run typecheck` — passed (`tsc --noEmit`).
- `bun run test` — passed: 89 tests across 17 files, 605 assertions. This includes the standalone Factory/Pi/HTTP executor flow, actual workerd Worker compatibility bundle with real Pi AI OpenAI Responses calls through mocked HTTP, persistent Factory/Durable Object reopen, and uncertainty/reconciliation tests.
- `bun run build` — passed: Bun daemon bundle (1,382 modules, 4.93 MB); compatibility-built Wrangler Worker (1,851.81 KiB upload, 332.24 KiB gzip). Wrangler prints `env.FACTORY (FactoryObject)` and `env.MANAGED_WORK (ManagedWorkObject)` plus the configured provider/model vars. The Wrangler dry run compiles/binds but does not deploy.
- `git diff --check` — passed.

No production secrets were read, no paid provider request or deployment/push was made, no actual second laptop was tested, and no existing Rex session was changed. The Cloudflare model profile is intentionally OpenAI API-key/Responses only; Worker OAuth and ambient file/environment discovery are unsupported. Independent reviewer approval remains pending.

### Slice 4b review follow-up

The slice4b review identified two P2 defects, both now corrected. The node execution receipt's `outputTruncated` bit is carried through `RemoteCommandResult` into the `remote_run_command` structured `truncated` result; the regression uses the real local Factory/Pi/HTTP executor path and an argv process whose captured stdout is exactly the output limit while the daemon receipt confirms additional output was truncated. The standalone host now requests a managed-input drain on startup and after successful node registration/heartbeat. It requeues only previously unavailable inputs whose persisted placement generation remains current and whose assigned node is live. Drain wakes are coalesced across an active/finalizing drain; unexpected drain errors are logged and accepted queued/running intents are durably settled as failed/uncertain rather than silently abandoned. Reopen coverage commits an accepted input directly through the real persistent Core service, observes startup dispatch before any new input or node liveness request, finishes it through a bounded real executor, then reopens and reads persisted Pi context. A separate local HTTP test accepts work while its node is offline and verifies node registration wakes and completes it. Core tests verify queued failures and active uncertain outcomes remain explicit. Before the repairs were restored, the truncation regression failed with the real execution receipt at `stdout: "ABCDEFGH", outputTruncated: true` but Pi structured output at `truncated: false`; disabling the startup drain left the reopened receipt `queued` instead of the expected `running`. Both regressions pass with the fixes enabled.

The narrow Rex integration from the separately verified worktree was copied unchanged in its two approved files: inspection recognizes Rex's structured `child` field, and `rex-lifecycle.integration.test.ts` is gated by `UZINA_REX_LIFECYCLE_INTEGRATION=1` with random owned IDs and cleanup verification. The normal suite skips it. This run did not opt in or contact the Rex server; the supplied handoff reports the prior opt-in completed on Baldur with its created resource cleaned up.

Post-correction validation in this checkout:

- `bun install --frozen-lockfile` — passed; checked 149 installs across 228 packages with no changes.
- `bun run format` — passed.
- `bun run check` — passed.
- `bun run typecheck` — passed (`tsc --noEmit`).
- `bun run test` — passed: 93 tests, 1 opt-in Rex test skipped, 622 assertions across 18 files. Local standalone recovery, node-liveness, output-truncation, and drain-failure regressions passed; existing workerd tests passed.
- `bun run build` — passed: daemon bundle (1,382 modules, 4.93 MB) and Wrangler dry-run (1,854.29 KiB upload, 332.63 KiB gzip), with the Factory and ManagedWork bindings. This validates the build only, not deployment.
- `git diff --check` — passed.

Independent reviewer approval remains pending. This evidence does not claim all slices complete, production Cloudflare behavior, paid inference, or actual second-laptop operation; no deployment, push, or paid call was made.

## Workflow

1. Scaffold and review slice 0.
2. Run parallel lanes for managed runtime, execution, Factory operations, and workspace checkpoints.
3. Integrate and review the cloud-to-laptop scenario.
4. Complete PWA, invitations, MCP/assistant, and full checkpoint behavior in parallel.
5. Implement and review execution relocation, then managed-runtime relocation.
6. Run the full supported verification suite and document actual-machine deployment evidence or remaining operator blockers.
