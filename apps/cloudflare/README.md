# Cloudflare Factory Worker

This composition binds one SQLite-backed `FactoryObject`, one SQLite-backed `ManagedWorkObject` per stable thread identity, and a separate SQLite-backed `PrivateAssistantObject` for the owner-private Pi Durable conversation. `FactoryObject` runs the portable Core on `state.storage.transactionSync()`, persists Factory inputs/effects/events, routes a managed input to the thread Durable Object, and schedules recovery with alarms. `ManagedWorkObject` opens the same Pi Durable facade using that object's persistent storage and schedules Pi wake/recovery alarms. `PrivateAssistantObject` has its own SQLite Pi Durable/admission store and recovery alarm; its history is not part of a work-thread checkpoint. The Worker router does not contain a public remote-job injection route.

## Configure a protected deployment

`wrangler.toml` sets `workers_dev = false`, declares the Durable Object classes/migration, and selects Pi AI's real `openai` / `gpt-4o-mini` model. Use a custom operator-owned route and protect human Factory traffic with Cloudflare Access or a private gateway. A Tailscale client does not make a public Worker endpoint private. Keep bootstrap, API key, and execution-node credentials distinct.

From this directory, configure secrets without printing them:

```sh
wrangler secret put UZINA_BOOTSTRAP_SECRET
wrangler secret put UZINA_MODEL_API_KEY
wrangler secret put UZINA_PRIVATE_ASSISTANT_BEARER
wrangler secret put UZINA_PRIVATE_ASSISTANT_CREDENTIAL_ID
wrangler secret put UZINA_PRIVATE_ASSISTANT_ASSISTANT_ID
wrangler secret put UZINA_PRIVATE_ASSISTANT_OWNER_ID
```

For local workerd development, provide `UZINA_BOOTSTRAP_SECRET` and `UZINA_MODEL_API_KEY` through Wrangler's local secrets mechanism (`.dev.vars`, excluded from source control). This Worker profile supports only the real Pi AI OpenAI API-key provider using Responses; provider and model ID can be set as Worker variables. `createWorkerConfiguredModels()` validates the supported provider, actual catalog model, and stored API-key credential; missing credentials and unsupported providers fail closed. OAuth login/refresh, process environment discovery, and filesystem credential discovery are explicitly unsupported in this Worker. The configured API key is stored in Pi AI's in-memory credential store, not emitted in events/log output. The standalone local Bun host retains the full Pi AI catalog and its separate configured-provider behavior.

`bun run build:cloudflare` creates `build/index.js` with the pinned Worker-only Pi AI compatibility plugin and then invokes Wrangler's dry-run build. The same `build/index.js` artifact is used by Miniflare/workerd integration tests. The build checks Pi AI's exact `1.4.0` package version and expected auth-module exports, and fails if either replacement seam is missing. Use `wrangler deploy --dry-run --config wrangler.toml` to inspect the actual class bindings; a dry run does not deploy, create a production namespace, set secrets, configure Access, or prove cloud operation.

## Private routes and node setup

`workers_dev = false`; this repository defines no Worker route and does not configure Cloudflare Access. An operator must select a protected custom route/gateway before deployment and verify the actual ingress policy. Do not infer that a Worker URL is tailnet-private or claim that Access is configured. The daemon Factory binds only to loopback; Workers use the externally selected protected route.

## Owner-private Factory assistant

The owner provisions a named assistant credential through the existing Core owner operation and selects explicit factory-wide or narrower project/thread grants. The host never provisions a token or broadens grants. Keep the returned bearer only in `UZINA_PRIVATE_ASSISTANT_BEARER`; configure the matching non-secret `credentialId`, immutable `assistantId`, and accountable `ownerId` in the protected Worker configuration as shown above. Use dummy values only in local workerd tests. This is independent of owner/browser, node, and model API credentials.

The dedicated Durable Object validates that exact identity through the ordinary authenticated Factory HTTP handler using `FactoryClient.me()`. Its custom `factory_*` tools are installed only in the private root; work-thread registries retain their existing remote execution tools and never receive this bearer. The assistant has no native filesystem/argv tools. Tool requests authenticate through Core each time, so current grant changes and revocation apply to subsequent calls. A missing, revoked, mismatched, or temporarily uncheckable assistant credential parks the assistant without affecting unrelated Factory work. The owner can still inspect the existing private history/status/receipts after assistant revocation. The owner-only routes are `/v1/private-assistant/status`, `/context`, `/receipts/:inputId`, and `POST /inputs` with stable `{ inputId, text }`; changed text for a reused ID conflicts.

The runtime pins its persisted assistant identity. Changing bearer identity does not adopt the old transcript; credential rotation/adoption, transcript export/deletion, and automatic token provisioning are unsupported. Preserve the private store and configure a newly reviewed runtime if identity replacement is needed. The `PrivateAssistantObject` class is additive SQLite migration `v2`; dry-run builds do not deploy the class, set Worker secrets, or configure Access.

The Worker applies Factory bearer credentials to owner operations/context/events/status. Connected execution daemons use separately provisioned node bearer credentials and initiate outbound registration, heartbeat, claim, and report requests. If Cloudflare Access is fronting the Worker, its policy must allow those node protocol paths without a human Access cookie (for example via a narrowly scoped bypass) while keeping them protected by the route's node credential and rate limits. The node credential is not an owner or model API key. No HTTP path accepts caller-selected execution jobs.

Owner workflow: bootstrap an owner, provision node identities, provision mapped workspaces, and create threads with an explicit target. Submit input only to the assigned thread. `GET /v1/commands/:requestId`, `/v1/events`, and authorized `/context` and `/status` routes surface receipts and canonical model state.

`POST /v1/mcp` uses the same `FactoryObject` and Core operations as REST. It is the official SDK 1.32.2 Web Standard stateless Streamable HTTP/JSON profile with `Authorization: Bearer <active Factory credential>` on every POST. The stateless server stores no MCP session/auth snapshot; revocation/grant changes apply on subsequent requests. Query-string tokens and cross-origin `Origin` values are rejected; there are no wildcard CORS headers. Tokens are isolated by the single Factory Durable Object credential store and rejected by another Factory. See `packages/core/README.md` for the complete tool list, resource profile, and unsupported lifecycle operations. No execution-node or model-provider request receives this caller credential.

## Workspace-only checkpoint storage

`wrangler.toml` declares the `CHECKPOINTS` R2 binding with the operator-owned bucket name `uzina-workspace-checkpoints`; a dry-run does not create that bucket. The Factory DO constructs one capture-scoped streaming storage adapter. Missing storage fails closed. After an authenticated held source fence, an owner can admit `POST /v1/workspace-snapshots`, inspect its stable receipt, and retrieve only published references through the owner-authenticated blob route. The registered source node performs Git/filesystem capture and has capture-bound upload authority only; it cannot download arbitrary bucket hashes or access controller-private Pi artifacts.

The Worker verifies bounded metadata and streamed object digests before accepting `workspace-checkpoint-available`. It neither runs Git nor buffers an entire workspace. Full Git/workspace equivalence is checked during local inactive restore. Mandatory path exclusions and declared scope use the same non-backtracking matcher as the exporter, with an aggregate publication work limit. Rejected uploads can remain in private staging, and selected files or Git history may contain secrets; this is not a secret scanner or OS sandbox.

This is a workspace-only artifact, not a coherent managed-work bundle. Source fences remain held. Controller Pi/provenance assembly, destination activation, ownership transfer and actual cloud-to-laptop deployment remain separate work.

## Workerd integration evidence

`bun test apps/cloudflare/test` exercises the production compatibility-built `cloudflare:workers` Durable Object classes under Miniflare/workerd, with SQLite storage, transaction receiver, RPC, alarms/eviction, and the root Worker route. Its composed test drives the real Pi AI OpenAI Responses provider using a bounded mocked outbound HTTP service and a dummy API-key value; the mock selects the remote tool and returns its final response without reaching the Internet or making a paid request. A separately authenticated local execution daemon performs the actual workspace effect. Provider auth-failure and compatibility-shim tests also run under the workerd-compatible build contract.

This emulator result is not a production Cloudflare deployment. Production credentials, custom route, Access configuration, a real remote API provider request, tailnet/client setup, and a second-laptop connection were not tested. A deterministic adapter is confined to test-support and is not a Workers fallback.
