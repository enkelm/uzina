# Uzina

Uzina is a single-factory Bun workspace with portable Factory Core, managed Pi Durable runtime, authenticated execution daemon, and workspace checkpoint modules. Slice 4b now composes an accepted Factory input through managed Pi, bounded remote tools, the real authenticated HTTP execution loop, a selected workspace effect, and settled Core receipts/events/context on both the local host and Miniflare/workerd.

This is not evidence of a production deployment. No Cloudflare production credentials were supplied, no paid model call or deployment was made, and second-laptop availability is unconfirmed. The workerd suite uses real Durable Object storage/runtime. Its production-composition scenario runs Pi AI's real OpenAI Responses provider, SDK, and parser against bounded mocked HTTP with dummy credentials; separate recovery tests substitute the external-model seam. Local tests use actual SQLite and temporary workspaces.

## Run the standalone local Factory

Use Bun 1.4.4. Local mode is the default and listens on loopback (`127.0.0.1:8788`). A real Pi AI provider/model, its API key, and a private bootstrap secret are required:

```sh
UZINA_MODE=local \
UZINA_BOOTSTRAP_SECRET='<private-bootstrap-secret>' \
UZINA_MODEL_PROVIDER=openai \
UZINA_MODEL_ID=gpt-4o-mini \
UZINA_MODEL_API_KEY='<provider-api-key>' \
bun run dev:daemon
```

The Factory SQLite path defaults to `~/.local/share/uzina/factory.sqlite`, and per-thread Pi Durable stores to `~/.local/share/uzina/managed-work`. Set `UZINA_FACTORY_DATABASE_PATH` and `UZINA_MANAGED_WORK_DIRECTORY` to change them. Model configuration is resolved against Pi AI's real catalog and auth resolver; missing configuration fails closed. No production dummy/deterministic model is available.

Bootstrap once through `POST /v1/bootstrap` with `Authorization: Bootstrap <UZINA_BOOTSTRAP_SECRET>`. Provision execution nodes and workspace IDs with owner-authenticated routes, create a thread with the explicit node/workspace target, then submit input. Inputs cannot select execution placement. `GET /v1/commands/:requestId` reconciles accepted inputs and their effect receipts; `GET /v1/threads/:threadId/context` and `/status` are authenticated canonical managed-Pi queries. `GET /v1/events` returns committed receipt transitions.

## Cloudflare composition

`apps/cloudflare/wrangler.toml` declares the actual `FactoryObject` and `ManagedWorkObject` SQLite Durable Object bindings/migration. The Worker defaults to no `workers.dev` endpoint (`workers_dev = false`); deployment requires an operator-owned custom Worker route. Protect human business traffic with Cloudflare Access/tailnet-oriented ingress. If using an Access policy, permit authenticated node-only protocol paths to reach the Worker because node daemons use distinct owner-provisioned Bearer credentials and do not hold a human Access session. All application routes still enforce their Factory/node credentials; bootstrap and model API keys are independent secrets.

The checked-in Cloudflare profile supports only Pi AI's real OpenAI API-key Responses provider and `gpt-4o-mini`; unsupported Worker providers, OAuth, environment discovery, and filesystem credential discovery fail closed. The standalone Bun host retains the broader Pi AI catalog. Set secrets without exposing their values:

```sh
cd apps/cloudflare
wrangler secret put UZINA_BOOTSTRAP_SECRET
wrangler secret put UZINA_MODEL_API_KEY
```

`bun run build:cloudflare` creates the pinned Pi AI 1.4.0 compatibility bundle that replaces only the unsupported Worker host-auth/OAuth helper modules; Miniflare and Wrangler consume the same generated entry. Wrangler's dry-run validates the artifact and prints the bound Durable Object classes. This is not a deployment. Do not enable a public `workers.dev` human interface as a substitute for protected ingress. Slice 6 adds persistent Owner, Guest, and Viewer access through scoped project/thread grants, invitations, participant administration, and separate thread discussion. It remains a single factory; it does not add UI, workforce roles/assignments, email/password login, or federation.

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
- `POST /v1/threads` accepts optional `ownerPrivate: true` for owner-private assistant context. Such threads are readable by the Owner and a factory-wide assistant only, are excluded from scoped listing/event queries, and cannot be granted directly. Project grants do not override owner privacy.
- `POST /v1/credentials` provisions a human Owner credential or separately revocable, owner-attributed assistant credential. Assistant authority is a stored grant administered only by the human Owner; omitted grants preserve the previous assistant breadth as an explicit factory-wide grant. See `packages/core/README.md` for the credential grant API and migration profile.

### Persistence and composition

Core migration adds `factory_users`, `access_grants`, `invitations`, and `thread_discussion`, and adds `threads.owner_private` with a false default for existing threads. A pre-existing bootstrapped database gets its Owner participant from `factory_meta.owner_id`; its display name is taken from the earliest existing credential belonging to that owner, falling back to `Owner`. Existing credential hashes and owner bootstrap remain valid. Invitation code hashes and credential hashes are the only values persisted; event payloads contain IDs and scope metadata, never invitation codes or bearer credentials. Expired/redeemed/revoked invitation state is durable. Any future ISO expiry later than the current time is accepted; this slice does not impose a maximum invitation lifetime.

`apps/daemon` and `apps/cloudflare` compose `FactoryService` through `createFactoryHttpHandler`, including the authenticated stateless MCP route, so REST and MCP share Core authorization and operations. Slice 7a also provides `@uzina/client` as a public authenticated Factory HTTP SDK. It does not install Pi Durable custom tools or a private assistant runtime; those are deferred to slice 7b. Exact MCP auth/tools, assistant-grant API, client limits, and the 7a/7b boundary are documented in the Core, client, and Pi Runtime package READMEs. No Cloudflare Access policy or route is configured here. The Miniflare workerd suite exercises the production-bundled MCP path alongside the durable Factory integration.

Request bounds are explicit: display names are 1–120 characters, grant identifiers are at most 128 characters, discussion text is 1–20,000 characters, managed input text is at most 100,000 characters, and invitation codes are at most 256 characters on redemption. An invitation expiry must parse as an ISO date later than now; no maximum lifetime is imposed. Expired, revoked, and redeemed codes are not accepted.

Access scopes are application-level visibility and admission rules, not OS sandboxing. A Guest allowed to steer a shell-capable agent has substantial execution power. Already claimed/external effects may remain uncertain or complete after access changes; Core prevents later admissions where it can but cannot undo an external effect. Human ingress must remain loopback/tailnet/Access protected; invitations do not add a public unauthenticated Factory or MCP deployment.

## Verification

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
- Scoped invitations and discussion are implemented; this is still execution infrastructure, not a workforce manager. Slice 7a adds authenticated stateless MCP and the public authenticated Factory client. Pi Durable custom-tool assembly and a private persistent assistant conversation/runtime composition are deferred to slice 7b. Worker definitions, assignments, delivery workflows, PWA/chat UI, ownership transfer, and native CLI adapters are not implemented. Broader UI work is held pending the workforce direction. No push, real Cloudflare deployment, Cloudflare Access configuration, credential-value readout, paid model request, second-laptop proof, or existing Rex session mutation is claimed.
