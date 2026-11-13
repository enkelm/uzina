# Uzina

Uzina is a single-factory Bun workspace with portable Factory Core, managed Pi Durable runtime, authenticated execution daemon, and workspace checkpoint modules. Slice 4b now composes an accepted Factory input through managed Pi, bounded remote tools, the real authenticated HTTP execution loop, a selected workspace effect, and settled Core receipts/events/context on both the local host and Miniflare/workerd.

This is not evidence of a production deployment. No Cloudflare production credentials were supplied, no paid model call or deployment was made, and second-laptop availability is unconfirmed. The workerd test uses real Durable Object storage/runtime with a deterministic external-model test adapter; local tests use actual SQLite and temporary workspaces.

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

`bun run build:cloudflare` creates the pinned Pi AI 1.4.0 compatibility bundle that replaces only the unsupported Worker host-auth/OAuth helper modules; Miniflare and Wrangler consume the same generated entry. Wrangler's dry-run validates the artifact and prints the bound Durable Object classes. This is not a deployment. Do not enable a public `workers.dev` human interface as a substitute for protected ingress. The app currently has only owner/assistant access and does not implement invitations or workforce roles.

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
- This does not add invitations, workforce roles/features, PWA/chat UI, MCP, ownership transfer, or native CLI adapters. No push, real Cloudflare deployment, credential-value readout, paid model request, second-laptop proof, or existing Rex session mutation is claimed.
