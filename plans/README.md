# Uzina implementation progress

Implement the scope in `SPEC.md` through the slices below. A slice is complete only when its observable acceptance behavior has been reviewed and its checks have run. Emulator coverage, local coverage, and actual deployments are separate evidence.

## Slice ledger

| Slice | Outcome                                                                                    | Dependencies                           | Status                                                                                |
| ----- | ------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------- |
| 0     | Bun workspace foundation, initial validated contracts, repeatable checks                   | None                                   | Complete                                                                              |
| 1     | Persistent Pi Durable under Bun and Cloudflare; early managed-checkpoint feasibility proof | 0                                      | Supported persistence/profile reviewed; actual deployment unverified                  |
| 2     | Authenticated execution daemon, explicit workspace jobs, Rex lifecycle                     | 0                                      | HTTP execution and real local Rex reviewed; laptop B unverified                       |
| 3     | Authorized Factory commands, durable receipts, committed events                            | 0                                      | Admission/protocol and scoped access reviewed                                         |
| 4     | Cloud-managed Pi executes a bounded tool on a selected laptop                              | 1, 2, 3                                | Bridge and provider-error/retry corrections reviewed; production/two-laptop gate open |
| 5     | Minimal operational PWA with retained request identities and reconnect handling            | 3, 4                                   | Held pending workforce direction                                                      |
| 6     | Persistent invitations, scoped roles, revocation, subscription enforcement                 | 3                                      | Local/workerd scoped access accepted; browser UI not implemented                      |
| 7     | MCP tools and private Factory assistant using ordinary authorized operations               | 1, 3, 4                                | MCP/client/private assistant reviewed; production setup unverified                    |
| 8     | Coherent workspace and managed-runtime checkpoints; validated inactive restore             | 1, 2; workspace work can start after 0 | Worker coherent capture/inactive restore reviewed; production unverified              |
| 9     | Safely relocate workspace execution between nodes                                          | 4, 8                                   | Inactive destination preparation reviewed; activation/cutover unfinished              |
| 10    | Transfer supported managed work from cloud to standalone local execution                   | 8, 9                                   | Not started                                                                           |

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

At that checkpoint independent review remained pending. The subsequent review accepted `af15f23` with no remaining findings: both reported P2s were fixed, late-node and startup wakes were covered, and the narrow Rex parser/lifecycle changes were accepted. Production Cloudflare and actual two-laptop execution remain unverified.

### Scoped-access and coherent-checkpoint integration

The isolated slice 6 and local slice 8 increments are now combined for independent review. Scoped access adds persistent Guest/Viewer identities, hashed single-use expiring invitations, current project/thread grants, revocation, owner-private threads, filtered reads/events/context, and discussion that never starts Pi work. Coherent checkpoints combine the supported public Pi profile, exact workspace/Git state, attachments and provenance; source capture uses durable Core and executor admission fences, and destination restore is staged and `prepared-inactive`, never activated.

The integration retained both claim-time access revocation and capture guards, and included the owner-private column when reading capture metadata. Root workspace dependency changes were reconciled in `bun.lock`. Parent validation passed: frozen install, formatting check, typecheck, **103 tests passed / 1 opt-in Rex test skipped / 772 assertions**, daemon build, production-shaped Worker compatibility build/Wrangler dry-run, and staged/unstaged diff checks. Real Miniflare R2 proves the immutable blob adapter, not a production R2 deployment. The separately completed real Rex check on Baldur created and removed only its disposable session; it is not rerun by the ordinary suite.

Remaining checkpoint wiring is explicit: the production local entry point has no configured trusted workspace/quiescence adapters or capture HTTP route; the Worker has no R2 binding or remote executor capture protocol. No ownership transition, destination activation, cloud-to-laptop capture or cloud-to-standalone continuation is claimed by this increment. Those are not satisfied by the inactive-restore test. The access review subsequently accepted `0d61b05` with no confirmed findings and reran the Cloud Factory workerd tests and dry-run build. The checkpoint review found three P2s: prepared-restore retries trusted a marker without verifying actual destination content; canonical ancestor/descendant workspace mappings could bypass per-ID capture isolation; and the outer bundle manifest was not bounded to 16 MiB before parsing. The first corrections were integrated as `bee1183`; their subsequent resource-bound review is recorded below. Prepared retries now verify actual workspace/Git/index, Pi logical records, attachments and compatibility; capture checks canonical nested as well as equal workspace roots; outer and referenced manifests are bounded before parsing, and unknown version-1 fields are rejected.

The additional real-provider HTTP-error test exposed a likely Worker retry deadlock: submission settlement waited inside the serialized operation chain while the alarm required to resume a sleeping Pi retry waited behind it. The focused Worker-adapter correction releases the serialized mutation chain before waiting for eventual settlement, so Pi's retry alarms can run without changing its retry policy. The negative-response proof also exposed an upstream echoed-key disclosure in both configured host profiles; shared provider-boundary redaction now protects events and resolved messages while retaining the real catalog, SDK/parser, retries and abort signals. Independent review accepted the combined provider corrections (`4f2eb16`) with no actionable findings. Mocked real-provider tests cover 401, transient 503→200, permanent 503, iterator failure, abort and eviction/reopen; no live provider was contacted. Parent validation of the combined provider/checkpoint correction tree passed frozen install, formatting, typecheck, **111 tests / 1 opt-in Rex test skipped / 892 assertions**, both builds, and diff checks. The MCP/client increment proceeded from accepted access policy in isolation; custom-tool assembly and the persistent private assistant remain deferred to 7b. Production capture/transfer composition follows the safety corrections. Broader UI remains held pending workforce direction.

### Checkpoint resource review accepted

The next checkpoint review found that an unexpected oversized root file could be omitted during prepared verification, an oversized attachment could be read before its size check, and Git validation could extract omitted HEAD files while reconstructing the index. These are now corrected: verification refuses any omission, attachment data is size-checked before access and hashed with bounded reads, and all three Git validation/restoration sites initialize only HEAD and the index before materializing selected manifest entries. Nested version-1 record fields are closed as well. The independent re-review accepted these corrections with no remaining findings.

Parent integration verified that the three conflicting files contained exactly the previously integrated baseline, then took the reviewed successor files without losing other changes. Validation passed frozen install, formatting, typecheck, **112 tests / 1 opt-in Rex test skipped / 925 assertions**, daemon build, Worker compatibility build/Wrangler dry-run, and diff checks. The oversized attachment permission test ran on this unprivileged POSIX host; the Git regression enforces a file-size limit in its disposable child only, with core dumps disabled. Git's own CPU/memory remains unbounded. Local coherent capture and verified inactive restore are accepted; production remote capture wiring and ownership transfer remain unfinished.

MCP authority and transport reviews have also accepted the isolated 7a increment after bounded response streaming, body-cancellation preservation, and same-request reconciliation were verified. Custom-tool code without a production assistant consumer is deliberately not shipped in 7a; its implementation is preserved under `.git/uzina-recovery/factory-custom-tools-deferred-to-7b.patch` for the real 7b composition. The isolated normal test command passed, not only the earlier serialized workaround.

### MCP, typed client, and assistant grants integrated

The reviewed 7a increment is integrated with the newer provider and checkpoint corrections. Bun and Worker expose authenticated, stateless official-SDK MCP over the same authorized Core operations as HTTP. Stored assistant credential grants replace implicit owner breadth with explicit factory/project/thread scopes; existing grantless assistant credentials migrate explicitly to factory-wide scope, while an intentionally empty grant set stays empty. Administration remains owner-only, each request checks current authority, and mutations retain explicit application request identities independently of JSON-RPC correlation IDs.

The public `@uzina/client` binds credentials to one resource, refuses credentialed redirects, validates response schemas, reads at most 256 KiB before parsing, and preserves cancellation during body reads. A lost acknowledgement of already accepted input remains uncertain and reconciles under the same request ID. No Pi custom tools or persistent private assistant are installed by this increment. Source for the deferred tools remains in the recovery patch noted above.

Parent validation of the integrated tree passed frozen install, formatting, typecheck, the normal **129 tests / 1 opt-in Rex test skipped / 1,015 assertions**, both builds, and staged/unstaged diff checks. No ephemeral-port error recurred. Official-SDK transport interoperability was tested against local HTTP and the production-shaped Worker in workerd. The build and emulator do not establish production Access/route protection, a deployed R2 bucket, or actual second-laptop behavior. The next bounded implementation is authenticated remote capture/control composition; destination activation and runtime ownership transfer remain separate gated work.

### Remote source-capture control phase 1 accepted

The accepted phase-1 increment adds stable owner-authenticated capture requests and receipts, a separate durable CONTROL queue, and node-authenticated claim/report routes. The real execution loop persists the selected workspace's capture fence and correlated node receipt before reporting `source-capture-fenced`. Lost acceptance, claim, and report acknowledgements retain the original identity; Core, node, and Factory DO reopen retain the held state. Wrong-node/capture/payload/generation reports fail closed, uncertain/running source work cannot establish quiescence, and unrelated workspace execution remains admitted. No node-global generation is advanced.

CONTROL-owned fences cannot be cleared accidentally by the existing local snapshot cleanup helpers. Ordinary in-process local snapshot capture retains its separate releasable lifecycle. No automatic unfence is implemented. The guarantee covers Uzina-managed admissions and persisted execution/Rex evidence, not arbitrary unmanaged OS writers or an OS sandbox.

Independent review accepted phase 1 with no actionable P0/P1/P2 findings. Parent integration passed frozen install, formatting, typecheck, the normal **134 tests / 1 opt-in Rex test skipped / 1,103 assertions**, both builds, and diff checks. These include actual HTTP node execution and Miniflare/workerd persistence, not fabricated success receipts. `source-capture-fenced` is not a snapshot, coherent checkpoint, transfer, or activation; source snapshot production, scoped blob transport/R2 composition, controller Pi/provenance assembly, destination preparation and ownership changes remain separate work.

At the phase-1 checkpoint the private assistant was isolated and unaccepted. Subsequent corrections closed the transient identity latch, pending-task recovery, mutation uncertainty, and later Worker alarm-wake findings, as recorded below.

### Private assistant and workspace snapshot integration

Independent re-review accepted the separate owner-private Pi Durable assistant after real Bun process interruption/reopen proved that a pending safe Factory mutation reuses its persisted request ID and creates one Core work item/effect. Same-host identity recovery resumes existing work through an authorized status request without a new input. The Worker regression separately proves that a later real Durable alarm wakes a sleeping provider-retry task without status-driven resume, new input, or eviction. Identity, current grants and revocation remain Core-authenticated; the host supplies a named assistant bearer and exact credential/assistant/owner identity. Ordinary coding workers do not receive its Factory tools or credential. This is API/runtime composition, not the held PWA/workforce UI.

The workspace-only snapshot transport also passed independent review. After a confirmed held source CONTROL fence, the owner admits a stable snapshot request. The node captures Git/files into a private cache outside workspace roots, uploads hash-verified immutable objects through its capture-scoped channel, and reports the original identity. Core verifies the manifest and exact object closure before `workspace-checkpoint-available`; owner retrieval and local inactive workspace restore are covered through real HTTP and Miniflare/workerd R2. Interrupted production and corrupt/missing cache stay uncertain rather than silently recapturing. The source fence stays held; no activation, ownership move, controller Pi export or coherent remote bundle is added.

Publication now enforces mandatory exporter exclusions independently of a producer's policy, including nested private paths, and applies declared include/exclude scope to selected and staged paths. A shared non-backtracking NFA and one 64,000,000-unit publication policy-work budget replace the unsafe dynamic regex matcher. The hostile small-pattern Workerd reproduction is red before correction and prompt afterward. Independent review also accepted a bounded synthetic 100,000-entry/100,000-staged-path manifest; that is matcher evidence, not a 100,000-file disk capture or upload. Excluded omission records and retained Git history keep their distinct meaning. Neither path filtering nor managed admissions are a secret scanner or OS sandbox; rejected uploads may remain in private staging.

Parent integration preserved both optional HTTP adapters, the private SQLite DO migration and the R2 binding across three shared-file conflicts. Root lockfile reconciliation changed only workspace dependency metadata; the daemon's actual client import is now a production dependency. After restoring the newly linked workspace dependencies, parent frozen install, formatting, typecheck, the normal **149 tests / 1 opt-in Rex skip / 1,333 assertions**, both builds and diff checks passed. Wrangler dry-run recognizes Factory, ManagedWork, PrivateAssistant and CHECKPOINTS; it does not provision/deploy them.

Parent integration also found a bound-after-read defect in the private Worker's internal Factory HTTP RPC. That hop now reads into a fixed 256 KiB buffer and cancels overflow before string/RPC serialization; the downstream client alone could not protect this earlier allocation. Independent re-review accepted the focused correction. Its real Workerd regression fails before the fix after consuming the full 1,310,721-byte source; afterward it stops at 262,145 bytes, cancels and releases the reader, and preserves empty, split-UTF-8 and exactly-at-limit responses.

Final parent validation with that reviewed delta passed `bun install --frozen-lockfile`, formatting, typecheck, the normal **150 tests / 1 opt-in Rex skip / 1,361 assertions across 33 files**, daemon and Worker builds, and staged/unstaged diff checks. The RPC delta was integrated from saved complete candidate trees, including new test files, without replaying the older cumulative assistant patch or losing the newer snapshot/R2 composition. This is the local reviewed integration checkpoint, not a production deployment.

Production Cloudflare login, protected ingress, storage/secrets and actual second-laptop proof remain operator gates. Two idle orphan Workerd processes with unconfirmed provenance were left untouched; they are not evidence that the owned glob probe leaked. The separate-adapter R2 cleanup race is a disclosed future-composition risk, not a reachable finding in the current single-adapter Factory DO. Controller Pi/provenance assembly is the next implementation increment after this checkpoint; prepared-inactive restore still does not authorize activation or transfer.

### Portable coherent-bundle composition prerequisite accepted

The existing local `captureManagedWorkBundle` now delegates to a shared Worker-compatible composer after capturing workspace state once. The composer takes the exact previously captured workspace manifest bytes/reference and prepared supported Pi artifacts; it preserves the existing v1 profile, checksums and file/Git references without reading workspace blobs, running Git, restoring files, or opening a Harness. The source objects must already have been verified by the caller; this metadata/composition seam does not renew their byte or Git validation. Source-node manifests remain workspace-only and cannot provide Pi artifacts or attachments.

Preparation validates Pi/profile/requirements before workspace I/O and enforces the stricter runtime/total cap while serializing. Independent review found attachment copies preceded the aggregate check; the correction now counts runtime plus every named attachment before copying any attachment bytes, including multiple names sharing one buffer. The existing public capture preflight regression failed before correction by reaching `realpath` on a nonexistent workspace instead of rejecting its impossible aggregate budget. It passes afterward and retains an exact preparation-budget boundary check without allocating hundreds of MiB or adding constructor spies/testing hooks.

The production local capture/validate/restore test still verifies an intact `prepared-inactive` destination. A distinct Miniflare/workerd test runs the shared composer against content-addressed R2 writes, rejects source-object reads, and validates/restores the result locally. Independent re-review accepted the complete candidate with no actionable findings. Parent integrated the staged candidate and working-tree-only corrections through a separate temporary index, preserving the retained checkout's original index.

Final parent validation passed frozen install, formatting, root and checkpoint-package typechecks, the normal **155 tests / 1 opt-in Rex skip / 1,415 assertions across 35 files**, both builds, and staged/unstaged diff checks. A previously disclosed timeout in the existing provider-retry test did not recur in the parent or latest reviewer normal suite; it remains a timing-sensitive test risk, not erased evidence.

This is a module-only prerequisite, not remote coherent-capture availability. The next bounded increment is capture-aware, storage-only export from the normal managed-work Durable Object, without constructor/alarm-driven Harness or tool execution under a held capture. Controller admission/assembly receipts, private artifact storage, final closure verification and authenticated coherent retrieval remain unfinished. The private assistant stays separate; source fences stay held, and no ownership transfer, activation, deployment or actual second-laptop behavior is claimed.

### Capture-aware normal-runtime export prerequisite accepted

The normal managed-work Durable Object now exports the supported Pi checkpoint through a trusted internal RPC only after Core validates the exact held `source-capture-fenced` binding. It opens the public SQLite Storage adapter directly, without a Harness, provider configuration, root creation, task resume, or tool execution. The private assistant and Factory database are excluded. Returned `checkpointSha256` is explicitly the v1 logical-body checksum, not the digest of the complete returned artifact bytes.

Independent review exposed a cross-DO race in checking capture state before awaited initialization. Core now transactionally excludes capture admission and runtime lifecycle admission through durable, non-expiring per-thread runtime permits. Lost acknowledgements and Core reopen retain the same permit identity; a missed heartbeat, disconnect, or eviction does not establish quiescence. Normal operations, cold initialization and recovery alarms acquire permission before opening or resuming Pi. Release follows actual Pi task/wake quiescence and Harness close, and never releases a source capture fence. Submission waits stay outside the serialized operation chain so later retry alarms can progress; live settlement waiters pin the Harness until they observe their result. Explicit close uses that same quiescence path and refuses while work, waiters, storage or permission remains uncertain.

The constructor schedules only a one-shot host bootstrap, retaining the ordinary 60-second active heartbeat. A captured wake is consumed without a resume/rearm loop; unlocked cold construction recovers through the production bootstrap rather than an accelerated fixture alarm. This does not promise prompt recovery of an idle, unconstructed object with no incoming event.

Export scans and canonical serialization have hard 100,000-record and 32 MiB limits, with stricter caller quotas supported. Globally enumerable conversations, tasks and submissions outside the root/owned closure now refuse rather than disappear; the v1 terminal-task, settled-receipt, no-forks/current-documents profile is unchanged. A materialized document is charged bounded value bytes, not a second logical record. Public document scans require exact known scopes and expose no global orphan-document catalog. Upstream Storage materializes a page or document before these local quotas can account it; those allocations remain outside the local bounds.

Behavioral baselines reproduced capture returning 202 instead of 409 while cold runtime initialization was held, alternate-root active work being silently omitted, and explicit close returning success while a real submission was pending. The corrected workerd owner uses real authenticated Core input and node CONTROL fencing, refuses close and capture while work remains active, and completes the same input after releasing the external model response. Cold captured export succeeds with unusable configuration through the production provider-options seam, without an options-call spy. Exact public source conversations, canonical entries, task results, submission receipts and document records/versions/values match the artifact and remain unchanged across export and the held alarm. Inactive import verification remains a separate destination proof.

Independent re-review accepted the complete candidate with no remaining findings. Parent integrated its exact complete tree through a separate temporary index, preserving the retained checkout's original staged intermediate and its working-tree corrections. Final main validation passed frozen install, formatting, root and checkpoint-package typechecks, the normal **160 tests / 1 opt-in Rex skip / 1,510 assertions across 36 files**, both builds and staged/unstaged diff checks. Worker build remains a Wrangler dry run, not deployment.

This completes the bounded raw-runtime export prerequisite, not remote coherent-bundle availability. Controller-owned capture/assembly receipts, provenance/effect attachment assembly, private coherent artifact storage, final object-closure verification and authenticated coherent retrieval remain the next increment. Source fences stay held; no unfence, activation, relocation, ownership transfer, production deployment or actual second-laptop proof is claimed. The broader workforce/PWA hold remains unchanged.

### Controller-owned coherent capture accepted

The Worker now composes a coherent managed-work checkpoint from an existing held source CONTROL capture and its already-available verified workspace snapshot. Owner admission at `POST /v1/threads/:threadId/managed-work-checkpoints` binds the original actor, request, thread, capture, snapshot, node, workspace and ownership generation. Identical retries preserve that identity; conflicting requests or stale prerequisites refuse. The initial receipt is `assembling`, not available. Bun hosts without the Worker private-assembly adapters reject admission before recording an undriven request.

FactoryController drives a finite persisted assembly journal, separate from Pi's task scheduler. It exports the named normal-work root, prepares selected versioned provenance, composes the existing v1 bundle using the exact original workspace manifest bytes and references, and stores only the runtime, provenance, inner manifest and outer manifest in a distinct request-private R2 namespace. Source-node uploads remain strictly workspace-only; node credentials cannot read or inject controller artifacts. Source workspace blobs are streamed for final digest/size verification, not recaptured, reuploaded, or materialized as one large body. No Git, filesystem restore, or Node-only restore machinery runs in the Worker.

Provenance contains the complete selected settled command/effect metadata, payload hashes, targets/generations, timestamps and allowlisted normalized failure codes. SQL discovery and serialization enforce bounds rather than silently truncating records. Raw inputs/arguments, outcomes, stdout/stderr, diagnostic strings, auth/grant/session data, credentials and private-assistant history are excluded from this attachment. Pi logical state, selected files and Git history retain their separate content policies; this is neither a secret scanner nor an OS sandbox.

Compatibility includes the actual source model and installed managed remote-tool requirements, not just the Pi/profile baseline. An existing root's model comes from its committed `pi.agent` document under the Core lifecycle permit, not a changed host creation default. Cold raw export checks the recorded profile against the actual exported root without resolving options, constructing a Harness, contacting a provider or reading runtime status. Missing, stale or unsupported profile metadata cannot advertise coherent compatibility; raw export remains available. Exact requirements are recorded with the runtime artifact and reused after restart. Destination validation requires explicit support for them and restore remains `prepared-inactive`.

Only complete verified source/private closure can publish `available`. The verifier checks strict v1 metadata, inner/outer equality, exact persisted references, requirements, evidence, bytes/digests, counts and aggregate quotas. Core requires an immutable in-process verifier-issued proof, rejects copied or reconstructed summaries, and rechecks current source authority and persisted references before publication. Owner retrieval at `GET /v1/managed-work-checkpoints/:requestId/blobs/:sha256` is publication-allowlisted binary streaming; it does not pass through the 256 KiB JSON Factory RPC channel. Runtime/attachment, manifest, file/count and total bounds remain in force; the Worker never buffers a whole 512 MiB workspace/blob.

Recovery reuses only recorded hash-verified outputs. An export/write/compose stage that started without a durably recorded output remains uncertain, never silently re-exported or recaptured. The strongest workerd owner now interrupts the real pipeline at `evidence-recorded`, disposes and recreates its owned Miniflare with persisted SQLite/R2, retries the same request, verifies the same references, requirements, source fence and execution receipt, forbids replacement export, and finishes genuine verification/publication. It also preserves terminal uncertainty after a lost export response, checks copied-proof refusal, exercises an actual failed Pi remote read through the HTTP executor, retrieves the coherent bundle, and validates/restores it locally. A configuration-change regression failed before correction with model B in the journal despite the root retaining model A; the corrected source and exact destination compatibility use A throughout recovery and restore.

Independent re-review closed all four original findings and the later existing-root model-binding defect with no remaining actionable findings. Parent integrated the exact reviewed complete tree `68bff3a0190507e257f8fe3368f15b61e9b5476d` from base `77452cb`, using a separate temporary index and preserving the retained candidate's original staged index. Main validation passed frozen install, formatting, root and checkpoint-package typechecks, the normal **164 tests / 1 opt-in Rex skip / 0 failures / 1,670 assertions across 37 files**, both builds, and staged/unstaged diff checks. Wrangler remains a dry run; no deployment, live inference, remote installation or existing Rex-session mutation occurred.

This completes the reviewed Worker coherent-capture and inactive-restore increment, not relocation or runtime ownership transfer. Source fences stay held. Production Cloudflare login, protected ingress, secrets/bucket provisioning and actual second-machine operation remain operator gates. Destination preparation/activation, source unfence and execution/runtime ownership transitions remain separately gated implementation work; the broader workforce/PWA hold is unchanged.

### Inactive destination workspace preparation accepted

Owner admission at `POST /v1/threads/:threadId/workspace-relocations` now binds a stable request to an already-published available coherent checkpoint and a distinct provisioned destination. Core derives the original source capture, snapshot, workspace-manifest reference, actor, thread and generation; it atomically reserves the unassigned destination against new thread/input/effect/capture use. Offline destinations remain queued under the same identity, never silently reassigned. The authenticated destination claim permits streaming only the exact verified workspace snapshot hash/size closure. Private Pi, provenance, coherent artifacts and owner credentials are not available to the node.

The connected `ExecutionLoop` and `ExecutionDaemon` consume that assignment. They resolve only a trusted configured, empty canonical workspace mapping, refuse aliases/nested roots and database/cache overlaps, and persist the local inactive reservation before filesystem effects. Objects stream into a private external cache with actual size/hash validation; existing workspace checkpoint restore and verification preserve Git history, refs/index, staged/unstaged/untracked files, binaries and modes. A durable `restore-started` marker prevents blind re-restore after interruption. Only a complete verified tree produces the local receipt and authenticated Core `prepared-inactive` report. Direct job, capture, activation and Rex admission remain blocked for the destination and overlapping aliases, including mappings added after reopen; unrelated workspaces remain usable.

Lost admission, claim and report acknowledgements retain the original IDs and evidence across controller and daemon reopen. A safely interrupted pre-restore download removes only its owned incomplete `.part` and may retry the same immutable reference while the destination remains empty and fenced. Existing corrupt completed cache/manifest objects are refused with evidence retained, not automatically deleted/refetched. Partial or unknown `restore-started` state remains uncertain without overwrite or replacement allocation. If a prepared tree later fails verification, an authenticated monotonic `prepared-inactive` to `uncertain` report must bind the exact prior receipt digest; Core preserves the original report and receipt evidence. Arbitrary conflicting reports still refuse.

The strongest existing workerd/R2 owner now covers the real source Pi/effect, held CONTROL fence, workspace and coherent publication, destination HTTP claim/stream/restore/report, lost acknowledgements and persistence reopen. Owned Bun destination children and Git barriers exercise actual process-group termination at both partial-staging and completed-tree `restore-started` boundaries. Reconciliation refuses the partial case without changing its destination or staging evidence, and finalizes the intact case only after normal verification. Corrupt-cache and canonical-root guards, previous-schema migration, changed prepared-tree degradation, direct execution/Rex denial, alias fencing and unrelated execution are also covered. These are local Bun/SQLite and Miniflare/workerd/emulated-R2 proofs, not actual laptop B or production evidence.

Independent review found one stale Core README paragraph and no confirmed runtime defect; re-review accepted the corrected complete candidate with no remaining findings. Parent integrated exact reviewed tree `c2eb1ce6bc2f7d3d534dd53fade71b428ceb0193` from `0e030ae2`, including the recovery child fixture, through a separate temporary index. The retained candidate's original index `93204f261f837d229903c58ad1611c7516ca8e8a` stayed unchanged. Main validation passed frozen install, formatting, root and checkpoint-package typechecks, the normal **164 tests / 1 opt-in Rex skip / 0 failures / 1,823 assertions across 37 files**, both builds, and staged/unstaged diff checks. The daemon bundle is 5.95 MB; the Worker dry-run estimates 2,809.24 KiB upload / 509.27 KiB gzip with the existing Durable Object and R2 bindings. No push, deployment, live inference, remote installation or pre-existing Rex mutation occurred.

This increment does not move execution ownership: the source stays fenced, the thread stays assigned to source A, and cloud Pi identity/state and the current singleton generation remain unchanged. Scoped ownership/generation migration, activation/cutover, source unfence, lost-activation reconciliation and standalone runtime transfer require separate reviewed implementation. Managed admission fences are not an OS sandbox or a secret scanner. Production login, protected ingress, secrets/storage provisioning and actual two-laptop acceptance remain operator gates. The workforce definitions and broader PWA hold remain unchanged.

## Workflow

1. Scaffold and review slice 0.
2. Run parallel lanes for managed runtime, execution, Factory operations, and workspace checkpoints.
3. Integrate and review the cloud-to-laptop scenario.
4. Complete PWA, invitations, MCP/assistant, and full checkpoint behavior in parallel.
5. Implement and review execution relocation, then managed-runtime relocation.
6. Run the full supported verification suite and document actual-machine deployment evidence or remaining operator blockers.
