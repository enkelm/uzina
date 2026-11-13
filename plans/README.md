# Uzina implementation progress

Implement the scope in `SPEC.md` through the slices below. A slice is complete only when its observable acceptance behavior has been reviewed and its checks have run. Emulator coverage, local coverage, and actual deployments are separate evidence.

## Slice ledger

| Slice | Outcome                                                                                    | Dependencies                           | Status                                          |
| ----- | ------------------------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------- |
| 0     | Bun workspace foundation, initial validated contracts, repeatable checks                   | None                                   | Complete                                        |
| 1     | Persistent Pi Durable under Bun and Cloudflare; early managed-checkpoint feasibility proof | 0                                      | Integrated; pending review                      |
| 2     | Authenticated execution daemon, explicit workspace jobs, Rex lifecycle                     | 0                                      | Integrated; pending review                      |
| 3     | Owner-authenticated Factory commands, durable receipts, committed events                   | 0                                      | Integrated; pending review                      |
| 4     | Cloud-managed Pi executes a bounded tool on a selected laptop                              | 1, 2, 3                                | Not started                                     |
| 5     | Minimal operational PWA with retained request identities and reconnect handling            | 3, 4                                   | Not started                                     |
| 6     | Persistent invitations, scoped roles, revocation, subscription enforcement                 | 3                                      | Not started                                     |
| 7     | MCP tools and private Factory assistant using ordinary authorized operations               | 1, 3, 4                                | Not started                                     |
| 8     | Coherent workspace and managed-runtime checkpoints; validated inactive restore             | 1, 2; workspace work can start after 0 | Workspace foundation integrated; pending review |
| 9     | Safely relocate workspace execution between nodes                                          | 4, 8                                   | Not started                                     |
| 10    | Transfer supported managed work from cloud to standalone local execution                   | 8, 9                                   | Not started                                     |

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

Slices 1, 2, 3, and the workspace portion of 8 have been copied into the main workspace for review. These are foundation modules, not completed user-facing slices. No slice-4 Factory-to-Pi-to-node execution bridge or ownership transfer is implemented. See `plans/integration-contracts.md`, `packages/pi-runtime/README.md`, `packages/checkpoints/README.md`, and `packages/core/README.md` for public interfaces, profiles, and remaining integration boundaries.

Operator blockers: `bunx wrangler whoami` reported `You are not authenticated` (exit 0); laptop B is not established. There is no production Cloudflare binding/deployment evidence, no live model call, and no node-to-controller execution proof.

Integration validation in the main checkout:

- `bun install` — passed; reconciled workspace dependencies and saved `bun.lock` (96 packages installed).
- `bun install --frozen-lockfile` — passed; checked 149 installs across 228 packages with no changes.
- `bun run format` — passed; formatted the integrated sources and docs.
- `bun run check` — passed; all selected TypeScript, JSON, and README files conform to Prettier.
- `bun run typecheck` — passed (`tsc --noEmit`).
- `bun run test` — passed: 61 tests across 11 files, 420 assertions, including Bun SQLite persistence/execution/Factory/workspace checkpoint tests and the Miniflare workerd Durable Object eviction/recovery test.
- `bun run build` — passed: Bun daemon bundle (13 modules, 115.68 KiB) and Wrangler dry-run Worker bundle (126.46 KiB upload, 21.00 KiB gzip). Wrangler printed `No bindings found`; this does not validate ManagedWork or Factory Durable Object bindings or deployment.
- `git diff --check` — passed.

## Workflow

1. Scaffold and review slice 0.
2. Run parallel lanes for managed runtime, execution, Factory operations, and workspace checkpoints.
3. Integrate and review the cloud-to-laptop scenario.
4. Complete PWA, invitations, MCP/assistant, and full checkpoint behavior in parallel.
5. Implement and review execution relocation, then managed-runtime relocation.
6. Run the full supported verification suite and document actual-machine deployment evidence or remaining operator blockers.
