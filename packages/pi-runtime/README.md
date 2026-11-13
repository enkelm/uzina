# Managed Pi Durable runtime

`@uzina/pi-runtime` is the narrow managed-work facade over the pinned Pi Durable and chord `1.4.0` APIs. It deliberately exposes one root conversation per managed work item and does not add another scheduler.

## Public facade

```ts
import { ManagedPiWork } from "@uzina/pi-runtime";

const work = await ManagedPiWork.open({
  storage,
  models, // injected Pi AI Models implementation
  agent: { model: { provider: "provider-id", modelId: "model-id" } },
  toolExecutor, // optional bounded remote file/argv seam
  beforeWork: armHostRecovery, // host-specific alarm/lease callback
});

const conversationId = await work.create();
const accepted = await work.submit("stable-request-id", "user request");
const receipt = await work.submission("stable-request-id");
const settled = await work.waitForSubmission("stable-request-id");
const canonicalContext = await work.context();
const status = await work.status();
await work.resume();
await work.close();
```

`create()` is idempotent; `openRoot()` only opens an existing root. `submit()` uses the stable request ID in Pi Durable's submission record, so callers can look up the same receipt with `submission()` after a lost response. `status()` returns the canonical model context, Pi Durable inspection, and wake state. `ManagedPiWork` does not expose conversation forks or alternate history views.

The managed facade is host-agnostic. `openLocalManagedPiWork()` in `apps/daemon/src/runtime/managed-work.ts` composes it with the serialized Bun SQLite facade from `apps/daemon/src/runtime/sqlite.ts`. `ManagedWork` in `apps/cloudflare/src/work-object.ts` is a separate Cloudflare Durable Object adapter that arms an alarm before recovery or other work. Neither host adapter is wired into the root application composition yet.

## Logical checkpoint support

`@uzina/pi-runtime/checkpoint` exports `exportManagedWorkCheckpoint()` and `importManagedWorkCheckpoint()` for the versioned profile `quiescent-current-documents-no-forks-v1`:

- Export is limited to the upstream reserved `ROOT_CONVERSATION_ID` (1), which is unowned and has no parent, and its owned conversation/task closure. Other ownerless conversations are not managed roots. Task records must be terminal, submission receipts settled, and no session-scoped document may be present.
- Export refuses active, sleeping, parked, or otherwise uncertain tasks and rejects conversations that are forked or have parent-history dependencies.
- The profile copies canonical conversation entries, settled request receipts, terminal task records, and **current values** of conversation/task documents through Pi Durable's public storage API. It is not a byte-for-byte database export and does not preserve prior document revisions or provide arbitrary historical `asOf` reconstruction. Do not use it for work whose continuation depends on document history or forks; those states are outside the supported profile.
- Import verifies the version/checksum and rejects checkpoints whose root is not the reserved `ROOT_CONVERSATION_ID`. Its public-contract fresh-store proof calls `Storage.mintId()` and requires the first candidate to be 2 (the root ID is reserved as 1), then looks up every record kind at ID 1 to rule out an occupied reserved ID. The allocator contract makes any stored or previously minted ID above 1 advance that candidate, including orphan scoped documents that exact-scope document scans could miss. Stores that do not prove this state are rejected rather than treated as empty.
- Import requires an exclusively held, genuinely fresh destination: `Storage` has no public transaction combining the fresh-store proof with the commit, so no concurrent writer may use it between validation and import. The logical records are written in one atomic `commit`. If an import reaches the guard, it consumes the storage instance's initial minted candidate; do not retry on that instance after the guard runs, including after a later failure—provision a new fresh destination instead. Import does not activate work or transfer ownership. Workspace files, credentials, deployment bindings, and execution authority are not included.

Pi Durable `1.4.0` has no full public storage exporter/importer, so broader checkpoint semantics are unsupported until upstream exposes the needed logical history/fork records. Keep broader profiles fail-closed rather than copying SQLite internals.

## Root composition still required

The later integrator must:

1. Export and bind a concrete subclass of `apps/cloudflare/src/work-object.ts` from the Cloudflare Worker entry point and Wrangler `durable_objects`/migration configuration, or instantiate `openLocalManagedPiWork()` from the daemon runtime composition.
2. Supply an injected `Models` implementation and select a model from validated application configuration; provide credentials through existing host secret handling only.
3. Supply a least-privilege `RemoteToolExecutor` for tools the chosen agent is allowed to use; do not treat the remote tool seam as a new scheduler or give it unrestricted host access.
4. Route service requests through the managed facade's stable request IDs and receipts, and connect the daemon/Worker lifecycle to `resume()`/host recovery.
5. Coordinate checkpoint import with workspace ownership and application state outside this package. This checkpoint utility does not perform an ownership transfer.

## Validation

- Bun SQLite facade and managed facade tests: `bun test apps/daemon/test/runtime-sqlite.test.ts apps/daemon/test/runtime-storage-conformance.test.ts apps/daemon/test/managed-runtime.test.ts`
- Cloudflare Durable Object behavior in real workerd via Miniflare: `bun test apps/cloudflare/test/work-object.workerd.test.ts`
- TypeScript: `bun run typecheck`
