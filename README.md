# Uzina

Uzina is a single-Factory Bun workspace with portable Factory Core, managed Pi Durable runtime, an authenticated execution daemon, scoped collaboration, a first operational web UI, MCP/client access, and an owner-private Factory assistant. Accepted work runs through bounded remote tools and authenticated HTTP execution into a selected workspace, with durable Core receipts/events/context. Remote coherent checkpoints and authenticated workspace execution cutover are implemented; the managed Pi runtime remains in its original controller. A standalone Owner can also prepare an explicitly supplied offline bundle in private inactive storage. That data import does not authenticate a source transfer, retire the source, or activate a local runtime.

This is not evidence of a production deployment. No Cloudflare production credentials were supplied, no paid model call or deployment was made, and second-laptop availability is unconfirmed. The workerd suite uses real Durable Object storage/runtime. Its production-composition scenario runs Pi AI's real OpenAI Responses provider, SDK, and parser against bounded mocked HTTP with dummy credentials; separate recovery tests substitute the external-model seam. Local tests use actual SQLite and temporary workspaces.

## Run the standalone local Factory

Follow [local setup](docs/local-setup.md) for the optional environment examples, owner sign-in link, and Execution node provisioning. The example files are `.env.example` (Factory), `apps/web/.env.example` (web proxy, no secrets), and `apps/daemon/.env.example` (Execution node).

Use Bun 1.4.4. Local mode is the default and runs Pi Durable on Bun SQLite, listening on loopback (`127.0.0.1:8788`). No Factory bootstrap secret or separate model key is required. Existing Pi credentials, provider environment variables, custom `models.json`, and settings are reused:

```sh
cp -n .env.example .env.factory.local
chmod 600 .env.factory.local
bun --no-env-file --env-file=.env.factory.local --watch apps/daemon/src/index.ts
```

The Factory SQLite path defaults to `~/.local/share/uzina/factory.sqlite`, and per-thread Pi Durable stores to `~/.local/share/uzina/managed-work`. Set `UZINA_FACTORY_DATABASE_PATH` and `UZINA_MANAGED_WORK_DIRECTORY` to change them. The local host uses Pi's native model/credential resolver. Optional `UZINA_MODEL_PROVIDER` and `UZINA_MODEL_ID` override model selection; otherwise it prefers Pi's available default, then another available authenticated model. No production dummy/deterministic model is available.

Local startup creates a private owner sign-in link and a separate revocable private-assistant identity, persisted in mode-0600 files beside the Factory database. Open the printed link after starting the web UI; no Factory token field is needed. Provision execution nodes and workspace IDs with owner-authenticated routes, create a thread with the explicit node/workspace target, then submit input. Inputs cannot select execution placement. `GET /v1/commands/:requestId` reconciles accepted inputs and their effect receipts; `GET /v1/threads/:threadId/context` and `/status` are authenticated canonical managed-Pi queries. `GET /v1/events` returns committed receipt transitions.

## Use the web UI

With the Factory running on `127.0.0.1:8788`, start the loopback development UI in a second terminal:

```sh
bun run dev:web
```

Open the private owner link printed by the Factory and confirm sign-in. Browser authentication uses HttpOnly, SameSite cookies (Secure over HTTPS), adapted from pi-coop. The Owner's **Sharing** page creates expiring, single-use project/Work item invitations and revokes access. Keep sign-in links private; bearer values never enter React state or Web Storage. The Owner can create projects and Work items, choosing an existing Execution node and Workspace explicitly. Guests can steer work within their grants; Viewers are read-only. The UI shows conversation text, durable command receipts, and history. A receipt means admission, not assistant output or completion.

Uncertain input retains its original Work item, request ID, and exact text. Use **Reconcile request** on that item, not a new Send. Temporary connection loss hides private work and exposes a retry; sign-out clears all local private state. Reloading the tab loses its memory-only drafts and unresolved inputs. Bounded lists, runtime-less catalog behavior, installed-browser checks, and proxy configuration are documented in [the web UI README](apps/web/README.md).

This is a development UI, not production serving or private ingress. It adds no transfer, ownership, activation, terminal, offline queue, or PWA-cache controls. Keep human ingress private as described below.

## Cloudflare composition

`apps/cloudflare/wrangler.toml` declares the `FactoryObject`, `ManagedWorkObject`, and separate `PrivateAssistantObject` SQLite Durable Object bindings/migrations, plus the `CHECKPOINTS` R2 bucket binding. The operator must provision the bucket; the binding declaration does not create it. The Worker defaults to no `workers.dev` endpoint (`workers_dev = false`); deployment requires an operator-owned custom Worker route. Protect human business traffic with Cloudflare Access/tailnet-oriented ingress. If using an Access policy, permit authenticated node-only protocol paths to reach the Worker because node daemons use distinct owner-provisioned Bearer credentials and do not hold a human Access session. All application routes still enforce their Factory/node identities; owner sign-in and model credentials remain separate.

Cloudflare supports OpenAI, Anthropic, and Google API-key profiles; `wrangler.toml` defaults to OpenAI / `gpt-4o-mini`. Store only the credentials needed by the Worker in the encrypted `UZINA_PROVIDER_CREDENTIALS` Worker secret (a Pi-style provider map). Set `UZINA_OWNER_TOKEN` to a random private token of at least 32 characters and open `/login?token=<token>` on the protected origin; no bootstrap request is required. Worker OAuth and machine credential discovery remain unsupported. The standalone host uses the full native Pi resolver. These commands stage secret versions; deploying them is a separate operator action:

```sh
cd apps/cloudflare
wrangler versions secret put UZINA_OWNER_TOKEN
wrangler versions secret put UZINA_PROVIDER_CREDENTIALS
```

`bun run build:cloudflare` creates the pinned Pi AI 1.5.2 compatibility bundle that replaces unsupported Worker host-auth/OAuth/native-environment helper modules; Miniflare and Wrangler consume the same generated entry. Wrangler's dry-run validates the artifact and prints the bound Durable Object classes. This is not a deployment. Do not enable a public `workers.dev` human interface as a substitute for protected ingress. Slice 6 adds persistent Owner, Guest, and Viewer access through scoped project/thread grants, invitations, participant administration, and separate thread discussion. Those scoped-access APIs remain inside one Factory and do not add workforce roles/assignments, email/password login, or federation. The separate web UI above uses those same access checks.

## Scoped collaboration and access (slice 6)

The shared Core HTTP handler implements these authenticated routes; the standalone daemon and Cloudflare Factory Durable Object both use that handler. Owner identity and all participant roles/grants are loaded from SQLite on each operation. A previously issued bearer credential therefore observes role/grant changes on its next request, and participant revocation disables all of that participant's credentials.

### Endpoints

- `POST /v1/bootstrap` remains the one-time private owner bootstrap (`Authorization: Bootstrap ...`). It creates the owner participant and the original owner credential.
- `POST /v1/invitations` (Owner) accepts `{ "role": "guest" | "viewer", "grants": [...], "expiresAt": "ISO-8601" }`. It returns an opaque invitation ID, expiry, and a 256-bit random code once. `GET /v1/invitations` lists invitation state without codes; `POST /v1/invitations/:id/revoke` revokes an unused code.
- `POST /v1/invitations/redeem` requires no prior bearer credential and accepts `{ "code": "...", "displayName": "..." }`. It atomically redeems the code and returns a newly minted one-time-visible credential. The invite can be redeemed only once, including across SQLite/workerd restart or simultaneous attempts.
- `GET /v1/people` (Owner) lists stored display names, roles, and grants. `PUT /v1/people/:userId/access` accepts `{ "role": "guest" | "viewer", "grants": [...] }` to replace access. `POST /v1/people/:userId/revoke` revokes the participant and all credentials.
- Grants are strict objects of exactly `{ "type": "project", "resourceId": "project-id" }` or `{ "type": "thread", "resourceId": "thread-id" }`. Unknown grant kinds, missing resources, duplicate grants, and direct grants to owner-private threads are rejected; there is no implicit/global guest grant.
- Scoped participants use `GET /v1/projects`, `GET /v1/threads[?projectId=...]`, permitted context/status, `GET /v1/commands/:requestId`, and `GET /v1/events?after=<cursor>&limit=1..500`. Out-of-scope thread/receipt queries return not-found, and event rows are filtered by current scopes. Participant event cursors are contiguous, participant-local stream positions; an access change advances the stream generation and a stale cursor restarts within the newly authorized view rather than exposing gaps from another project. Owner event cursors preserve the existing global sequence. Node/workspace inventories are available to the Owner and to assistant credentials within their stored scope; people/invitation/credential/grant administration remains human-Owner-only.
- `POST /v1/threads/:threadId/inputs` is available to an Owner or a scoped Guest, never a Viewer. `GET` and `POST /v1/threads/:threadId/discussion` are separately persisted non-agent discussion operations for any participant who can read the thread. They do not enqueue managed input or start Pi work. Each discussion item has its own ID, text, timestamp, authenticated actor attribution, and the stored display name.
- `POST /v1/threads` accepts optional `ownerPrivate: true` for owner-private work-thread content. Such threads are readable by the Owner and a factory-wide assistant only, are excluded from scoped listing/event queries, and cannot be granted directly. Project grants do not override owner privacy.
- `POST /v1/credentials` provisions a human Owner credential or separately revocable, owner-attributed assistant credential. Assistant authority is a stored grant administered only by the human Owner; omitted grants preserve the previous assistant breadth as an explicit factory-wide grant. See `packages/core/README.md` for the credential grant API and migration profile.

### Persistence and composition

Core migration adds `factory_users`, `access_grants`, `invitations`, and `thread_discussion`, and adds `threads.owner_private` with a false default for existing threads. A pre-existing bootstrapped database gets its Owner participant from `factory_meta.owner_id`; its display name is taken from the earliest existing credential belonging to that owner, falling back to `Owner`. Existing credential hashes and owner bootstrap remain valid. Invitation code hashes and credential hashes are the only values persisted; event payloads contain IDs and scope metadata, never invitation codes or bearer credentials. Expired/redeemed/revoked invitation state is durable. Any future ISO expiry later than the current time is accepted; this slice does not impose a maximum invitation lifetime.

`apps/daemon` and `apps/cloudflare` compose `FactoryService` through `createFactoryHttpHandler`, including the authenticated stateless MCP route, so REST and MCP share Core authorization and operations. `@uzina/client` provides the public authenticated Factory HTTP SDK. The private assistant uses its own Pi Durable runtime and named credential to call those same Core operations; its `factory_*` tools are not installed in ordinary coding workers. Exact MCP auth/tools, assistant grants, client limits and runtime boundaries are documented in the Core, client and Pi Runtime package READMEs. No Cloudflare Access policy or route is configured here. The Miniflare workerd suite exercises the production-bundled MCP and private-assistant paths alongside durable Factory integration.

Request bounds are explicit: display names are 1–120 characters, grant identifiers are at most 128 characters, discussion text is 1–20,000 characters, managed input text is at most 100,000 characters, and invitation codes are at most 256 characters on redemption. An invitation expiry must parse as an ISO date later than now; no maximum lifetime is imposed. Expired, revoked, and redeemed codes are not accepted.

Access scopes are application-level visibility and admission rules, not OS sandboxing. A Guest allowed to steer a shell-capable agent has substantial execution power. Already claimed/external effects may remain uncertain or complete after access changes; Core prevents later admissions where it can but cannot undo an external effect. Human ingress must remain loopback/tailnet/Access protected; invitations do not add a public unauthenticated Factory or MCP deployment.

## Private assistant and workspace snapshots

The private assistant is a separate owner-private conversation/store, not a project or work thread with fake execution placement. Local startup provisions a separate named assistant identity automatically; Worker operators still install its bearer and expected identity. No human owner bearer is inherited. Core applies current grants and revocation on tool requests. Missing or mismatched identity parks execution while owner history remains readable. Bun recovery after a transient identity failure is triggered by an authorized status request; Worker alarms also resume due persisted work. See [daemon setup](apps/daemon/README.md#owner-private-factory-assistant) and [Worker setup](apps/cloudflare/README.md#owner-private-factory-assistant).

After a confirmed source CONTROL fence, an owner can request a workspace-only snapshot. The assigned node captures Git/index/selected files into a private immutable cache, then streams verified objects into configured Bun storage or Cloudflare R2. Core reports `workspace-checkpoint-available` only after manifest/reference verification; owner retrieval is allowlisted. Interrupted or corrupt cached production stays uncertain, not silently recaptured. Mandatory path exclusions and declared scope are checked with a bounded non-backtracking matcher, but selected files and Git history may still contain secrets.

A workspace-only snapshot does not include controller Pi/provenance state or private assistant history. The separate coherent-checkpoint protocol combines that verified workspace with supported public Pi state and archived provenance under the held source fence. Authenticated workspace relocation can change execution placement while keeping the cloud Pi thread and permanently fencing its old executor. Neither snapshot retrieval nor inactive restore alone grants that authority. See [checkpoint storage](apps/cloudflare/README.md#workspace-only-checkpoint-storage), [workspace cutover](apps/daemon/README.md#workspace-relocation-activation-and-executor-recovery), and [capture/restore limits](packages/checkpoints/README.md).

## Offline inactive preparation in standalone mode

The optional local `POST /v1/managed-work-imports` operation accepts only a stable request ID, configured offline catalog/destination IDs, and an exact v1 coherent-manifest digest. The current local human Owner authorizes the import. The native host validates bounded, no-follow file reads and exact model/tool compatibility, then restores the selected workspace and raw Pi SQLite into a private `prepared-inactive` root outside normal runtime and workspace paths. It creates no runnable imported thread, placement, account, grant, or credential authority. Imported Pi state is never opened with a Harness.

The source Owner must separately gather the authorized bundle files and supply them through an operator-controlled offline handoff. This importer has no online downloader or source-bearer field. A digest verifies integrity, not source-controller authorization or retirement; archived identities/provenance remain data. Bundles and Git history may still contain sensitive information. See [configuration, request, recovery and permissions](apps/daemon/README.md#standalone-offline-managed-work-import).

Same-ID retries verify existing prepared output and retain the original receipt; changed output becomes uncertain without repair or renewed proof. Status GET reports last committed evidence, not a continuous filesystem audit. Durable destination reservations survive disabled/changed import configuration, and shutdown joins finite in-flight imports. These are managed-host safeguards, not an OS sandbox. Source-trust/retirement and local activation remain separate, unimplemented checkpoints.

## Verification

The workspace uses TypeScript 7.0.2, Pi/Durable/Chord 1.5.2, Oxlint for correctness checks, and Oxfmt instead of Prettier. `bun run check` runs lint and format checks; `bun run format` applies formatting. The web app uses React 19 with TanStack Start and Router, with ui-sdk installed for new UI work. Dependency versions and the Bun lockfile are committed together.

```sh
bun install --frozen-lockfile
bun run format
bun run check
bun run typecheck
bun run test
bun run build
```

The integrated local scenario uses persistent SQLite and real HTTP between Core, Pi Durable, and an `ExecutionDaemon` whose resulting file/command effects are inspected in a temporary workspace. The Miniflare scenario drives the same production compatibility-built Worker through actual workerd Durable Objects, calls the real Pi AI OpenAI Responses provider through bounded mocked HTTP with a dummy key, and connects a separately authenticated `ExecutionDaemon` through real HTTP. Tests cover accepted-input deduplication, tool evidence/result correlation, provider failure, unavailable/revoked/stale node controls, unsafe cwd rejection, partial command effects with uncertainty, status/context/events, Durable Object eviction/reopen, and no automatic replay.

## Architectural boundaries

- `dispatch_intents` are managed Pi inputs; `execution_jobs` are separately persisted remote effects. Node claims never return managed model input.
- Pi Durable owns managed conversations/task execution. Core owns admission, authorization, selected placement, separate durable receipts, and committed Factory events.
- Remote effect identities are stable from persisted accepted work and Pi Durable task/tool-call evidence. A model cannot choose actor, node, workspace, or ownership generation. Uncertain external writes/commands are not blindly replayed: a timed-out queued job is stopped before claim, a claimed job is fenced from re-claim, and one correlated late report may resolve the effect receipt without changing the uncertain parent Pi command. Arbitrary external effects are not exactly-once.
- An optional command `cwd` must remain relative to the selected workspace; traversal, absolute paths, symlinks, missing paths and non-directories fail explicitly.
- The human Factory API is not an OS sandbox. Keep it loopback/tailnet/Access protected. Ordinary public Workers are not protected by Tailscale simply because the operator uses Tailscale elsewhere.
- The private assistant is isolated from normal work-thread Pi stores and checkpoint exports. Its host-held credential is not given to coding workers, nodes or model context; its coordination tools use ordinary authorized Core operations. Stable admission/mutation IDs survive lost acknowledgements and pending-task recovery without claiming cancellation or exactly-once arbitrary effects.
- Workspace snapshot CONTROL/production is separate from managed inputs and execution jobs. Upload authority is capture/node-bound; controller-private runtime artifacts are outside that channel. Coherent assembly and authenticated workspace cutover require their own verified bindings; an available artifact or inactive receipt alone is not a move.
- Offline standalone import reserves private inactive data only. It does not migrate a Factory database, synchronize accounts, authenticate cross-controller source authority, activate a copied Pi root, or retire/unfence a source. Cloud-controlled and standalone remain alternative single-Factory compositions, not federated controllers.
- Rex provides persisted process launch/inspect/stop/reconciliation, not structured agent orchestration. Native Pi CLI/RPC adapters, turn/event ingestion and TUI-agent coordination are not implemented; terminal text is not authoritative agent state.
- Scoped invitations, discussion, MCP/client access and the private assistant are implemented; this is still execution infrastructure, not a workforce manager. The first Work item web UI is implemented, but worker definitions, assignments, delivery workflows, PWA/offline behavior, managed-runtime ownership transfer and native CLI adapters are not. The broader workforce direction remains held; the first UI does not depend on it. No push, real Cloudflare deployment, Cloudflare Access configuration, credential-value readout, paid model request, second-laptop proof or existing Rex session mutation is claimed.
