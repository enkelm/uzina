# Uzina

Slice 0 establishes a Bun workspace, validated shared contracts, and minimal Bun and Cloudflare HTTP entrypoints. The entrypoints expose `GET /health` and `POST /identity`; the identity route validates a versioned actor declaration and is not authentication or proof of caller identity.

## Local verification

Use Bun 1.4.4 and Node 24.20.0. Install from the checked-in lockfile and run the root checks:

```sh
bun install --frozen-lockfile
bun run format
bun run check
bun run typecheck
bun run test
bun run build
```

`bun run build` bundles the Bun daemon and performs a Wrangler dry-run build of the Worker; it does not deploy. Run the local-compatible Cloudflare emulator with `bun run dev:cloudflare` (default `http://127.0.0.1:8787`) or the daemon with `bun run dev:daemon` (default `http://127.0.0.1:8788`). Both provide `GET /health`; send a versioned actor document to `POST /identity`.

## Agreed slice-0 contracts

- Actors are versioned `human`, `assistant` (including its accountable owner), or `node` identities.
- Callers supply stable command and job IDs. The contract distinguishes an `accepted` command acknowledgement from `completed`, `failed`, and `uncertain` execution outcomes.
- Execution targets name both a node and workspace; admissions and outcomes carry an ownership generation.
- Capability descriptions state whether reattachment, native resume, managed checkpoint recovery, steering, or stopping is supported.

## Constraints not implemented yet

Authentication, authorization, persistence, command deduplication, dispatch, effect completion, node registration, workspace access, and ownership fencing remain unwritten. Health and identity do not imply those behaviors. The automated Worker test exercises the entrypoint directly; Wrangler's local-compatible runtime is a development tool, not evidence of production Cloudflare Durable Object behavior or deployment. Pi Durable compatibility, managed execution, transfer, and actual cloud/laptop deployment remain later work.
