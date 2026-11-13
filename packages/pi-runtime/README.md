# Managed Pi Durable runtime

`@uzina/pi-runtime` is the narrow managed-work facade over pinned Pi Durable and chord `1.4.0` APIs. It deliberately exposes one root conversation per managed work item and does not add another scheduler.

## Public facade

```ts
import { ManagedPiWork } from "@uzina/pi-runtime";

const work = await ManagedPiWork.open({
  storage,
  models, // configured Pi AI Models implementation
  agent: { model: { provider: "openai", modelId: "gpt-4o-mini" } },
  toolExecutor, // bounded remote file/argv bridge
  beforeWork: armHostRecovery,
});

const conversationId = await work.create();
const accepted = await work.submit("stable-request-id", "user request");
const settled = await work.waitForSubmission("stable-request-id");
const canonicalContext = await work.context();
const status = await work.status();
await work.resume();
await work.close();
```

`create()` is idempotent; `openRoot()` only opens an existing root. `submit()` uses the stable request ID in Pi Durable's submission record, so callers can look up the same receipt with `submission()` after a lost response. `status()` returns canonical model context, Pi Durable inspection, and wake state. `ManagedPiWork` does not expose conversation forks or alternate history views.

## Provider configuration

`createConfiguredModels()` resolves a real Pi AI built-in provider/model from explicit `{ provider, modelId, apiKey }` configuration and fails closed for missing credentials, providers, or catalog models. The local standalone runtime reads `UZINA_MODEL_PROVIDER`, `UZINA_MODEL_ID`, and `UZINA_MODEL_API_KEY`; the Cloudflare ManagedWork binding reads the same values from Worker environment/secrets. The API key is held by the configured Pi AI credential store in memory and is never logged or included in Factory events. The local Bun host uses the full built-in Pi AI provider catalog. Cloudflare is deliberately narrower: its production Worker profile allows only OpenAI API-key authentication with the Responses API; other providers, OAuth login/refresh, process environment discovery, and filesystem credential discovery are unsupported and fail closed. A Worker-safe auth context is supplied; it never reads ambient variables or files.

The production composition has no deterministic or dummy model fallback. Tests use deterministic adapters only at the external model-provider seam; all managed task, Factory receipt, Durable Object, and execution behavior remains real. Automated validation does not make paid requests.

## Managed remote-tool bridge

The remote Pi tools are limited to bounded file read, file write, and argv command operations. `RemoteToolExecutor` receives durable Pi `conversationId`, `taskId`, and tool `callId`; the tool first memoizes this evidence. Core derives the target node/workspace/generation from the accepted persisted Factory input and creates a stable job ID. Model-supplied tool arguments cannot choose a node, workspace, actor, or generation.

Tool results are correlated from the immutable node receipt into the Pi tool-result transcript, canonical model context, Core execution receipt, and committed event. The unsafe file-write and command tools are not replayed after uncertain Pi task recovery. Core/node receipt lookups reuse the same job identity after lost replies; uncertain external writes/commands remain uncertain until reconciled. `remote_run_command.cwd`, if supplied, is relative to the selected workspace and is rejected for traversal, absolute paths, missing directories, non-directories, and symlink escapes. `.` selects the workspace root.

## Host composition and recovery

- `openLocalManagedPiWork()` composes `ManagedPiWork` with the serialized Bun SQLite facade. The standalone daemon persists one Pi Durable database per stable thread identity.
- `ManagedWorkRpcObject` is the workerd Durable Object wrapper. The production `ManagedWorkObject` configures the real OpenAI provider/model from Worker bindings. The Wrangler build uses `apps/cloudflare/scripts/build-worker.ts` to replace only Pi AI 1.4.0's host-auth context and OAuth loader modules with checked-in Workers-compatible shims; the build rejects unexpected package versions/module shapes. Wrangler and Miniflare consume the same built entry. A fallback alarm is armed before Pi Durable opens/recovery resumes; pending wake deadlines are armed before execution.
- `FactoryObject` is the singleton Factory Durable Object. It routes an accepted persisted input by its stable thread ID to `MANAGED_WORK`; the work Durable Object is per thread. There are no bindings embedded in the portable Core or Pi Runtime packages.

## Logical checkpoint support

`@uzina/pi-runtime/checkpoint` exports `exportManagedWorkCheckpoint()` and `importManagedWorkCheckpoint()` for the versioned profile `quiescent-current-documents-no-forks-v1`:

- Export is limited to the upstream reserved `ROOT_CONVERSATION_ID` (1), which is unowned and has no parent, and its owned conversation/task closure. Other ownerless conversations are not managed roots. Task records must be terminal, submission receipts settled, and no session-scoped document may be present.
- Export refuses active, sleeping, parked, or otherwise uncertain tasks and rejects conversations that are forked or have parent-history dependencies.
- The profile copies canonical conversation entries, settled request receipts, terminal task records, and current values of conversation/task documents through Pi Durable's public storage API. It is not a byte-for-byte database export and does not preserve prior document revisions or provide arbitrary historical `asOf` reconstruction.
- Import verifies the version/checksum and rejects checkpoints whose root is not the reserved ID. It requires an exclusively held, genuinely fresh destination; no concurrent writer may use it between validation and import. Import does not activate work or transfer ownership. Workspace files, credentials, deployment bindings, and execution authority are not included.

Pi Durable `1.4.0` has no full public storage exporter/importer, so broader checkpoint semantics remain unsupported until upstream exposes the needed logical history/fork records. Keep broader profiles fail-closed rather than copying SQLite internals.

## Validation and unverified operation

- Bun SQLite facade and managed facade: `bun test apps/daemon/test/runtime-sqlite.test.ts apps/daemon/test/runtime-storage-conformance.test.ts apps/daemon/test/managed-runtime.test.ts`
- Cloudflare Durable Object behavior in real workerd via Miniflare: `bun test apps/cloudflare/test/composed-workerd.test.ts apps/cloudflare/test/work-object.workerd.test.ts`
- TypeScript: `bun run typecheck`

The composed workerd test uses a deterministic model adapter and actual Miniflare SQLite Durable Objects plus an authenticated HTTP execution loop. It is emulator evidence, not production Cloudflare deployment evidence. Actual Cloudflare credentials, tailnet ingress, and second-laptop operation remain operator gates.
