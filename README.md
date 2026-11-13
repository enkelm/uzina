# Uzina

The Bun workspace has integrated the initial managed Pi runtime, execution-daemon, Factory Core, and workspace-checkpoint foundations. These are pending review and remain separate modules; the root daemon and Cloudflare entry points are still the slice-0 health/identity applications. `GET /health` and `POST /identity` do not provide authentication or prove caller identity.

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

## Integrated foundation seams (not yet composed)

- `@uzina/pi-runtime` and `@uzina/pi-runtime/checkpoint` provide a Bun-compatible Pi Durable facade and the supported `quiescent-current-documents-no-forks-v1` managed-work checkpoint profile. Cloudflare Miniflare/workerd coverage exercises its Durable Object alarm/recovery adapter.
- `@uzina/core` and `@uzina/contracts/factory` provide owner-authenticated Factory operations, persistent receipts/events, and an injected managed-runtime dispatch seam. Local Bun SQLite and a Cloudflare Durable Object adapter exist.
- `@uzina/contracts/execution` and `apps/daemon/src/execution` provide explicit node/workspace job schemas, a persistent local execution daemon, an outbound HTTP connector, and Rex process lifecycle handling.
- `@uzina/checkpoints` captures and validates workspace Git/filesystem state and restores an inactive checkout.

The package READMEs describe public seams and restrictions. These modules are not yet composed into root application entry points. Factory node routes and the execution connector currently use incompatible register/heartbeat/claim/report payloads; the Factory queue also carries managed Pi input rather than executor operations. Bridging those is an explicit slice 4 integration task, not a completed feature. The Worker dry-run does not bind or deploy models or Factory/ManagedWork Durable Objects. Wrangler local-compatible runtime and Miniflare coverage do not establish production deployment, and no second-laptop proof is claimed.

## Constraints not implemented yet

The integrated foundations do not make authentication, authorization, durable behavior, dispatch, effect completion, node registration, workspace access, or ownership fencing available through the root applications. Health and identity do not imply those behaviors. The root Worker test exercises the slice-0 entrypoint directly. Actual Cloudflare Durable Object deployment, managed execution across nodes, checkpoint transfer ownership, and actual cloud/laptop deployment remain later work.
