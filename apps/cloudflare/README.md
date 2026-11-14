# Cloudflare Factory Worker

This composition binds one SQLite-backed `FactoryObject` and one SQLite-backed `ManagedWorkObject` per stable thread identity. `FactoryObject` runs the portable Core on `state.storage.transactionSync()`, persists Factory inputs/effects/events, routes a managed input to the thread Durable Object, and schedules recovery with alarms. `ManagedWorkObject` opens the same Pi Durable facade using that object's persistent storage and schedules Pi wake/recovery alarms. The Worker router does not contain a public remote-job injection route.

## Configure a protected deployment

`wrangler.toml` sets `workers_dev = false`, declares the Durable Object classes/migration, and selects Pi AI's real `openai` / `gpt-4o-mini` model. Use a custom operator-owned route and protect human Factory traffic with Cloudflare Access or a private gateway. A Tailscale client does not make a public Worker endpoint private. Keep bootstrap, API key, and execution-node credentials distinct.

From this directory, configure secrets without printing them:

```sh
wrangler secret put UZINA_BOOTSTRAP_SECRET
wrangler secret put UZINA_MODEL_API_KEY
```

For local workerd development, provide `UZINA_BOOTSTRAP_SECRET` and `UZINA_MODEL_API_KEY` through Wrangler's local secrets mechanism (`.dev.vars`, excluded from source control). This Worker profile supports only the real Pi AI OpenAI API-key provider using Responses; provider and model ID can be set as Worker variables. `createWorkerConfiguredModels()` validates the supported provider, actual catalog model, and stored API-key credential; missing credentials and unsupported providers fail closed. OAuth login/refresh, process environment discovery, and filesystem credential discovery are explicitly unsupported in this Worker. The configured API key is stored in Pi AI's in-memory credential store, not emitted in events/log output. The standalone local Bun host retains the full Pi AI catalog and its separate configured-provider behavior.

`bun run build:cloudflare` creates `build/index.js` with the pinned Worker-only Pi AI compatibility plugin and then invokes Wrangler's dry-run build. The same `build/index.js` artifact is used by Miniflare/workerd integration tests. The build checks Pi AI's exact `1.4.0` package version and expected auth-module exports, and fails if either replacement seam is missing. Use `wrangler deploy --dry-run --config wrangler.toml` to inspect the actual class bindings; a dry run does not deploy, create a production namespace, set secrets, configure Access, or prove cloud operation.

## Private routes and node setup

`workers_dev = false`; this repository defines no Worker route and does not configure Cloudflare Access. An operator must select a protected custom route/gateway before deployment and verify the actual ingress policy. Do not infer that a Worker URL is tailnet-private or claim that Access is configured. The daemon Factory binds only to loopback; Workers use the externally selected protected route.

The Worker applies Factory bearer credentials to owner operations/context/events/status. Connected execution daemons use separately provisioned node bearer credentials and initiate outbound registration, heartbeat, claim, and report requests. If Cloudflare Access is fronting the Worker, its policy must allow those node protocol paths without a human Access cookie (for example via a narrowly scoped bypass) while keeping them protected by the route's node credential and rate limits. The node credential is not an owner or model API key. No HTTP path accepts caller-selected execution jobs.

Owner workflow: bootstrap an owner, provision node identities, provision mapped workspaces, and create threads with an explicit target. Submit input only to the assigned thread. `GET /v1/commands/:requestId`, `/v1/events`, and authorized `/context` and `/status` routes surface receipts and canonical model state.

`POST /v1/mcp` uses the same `FactoryObject` and Core operations as REST. It is the official SDK 1.32.2 Web Standard stateless Streamable HTTP/JSON profile with `Authorization: Bearer <active Factory credential>` on every POST. The stateless server stores no MCP session/auth snapshot; revocation/grant changes apply on subsequent requests. Query-string tokens and cross-origin `Origin` values are rejected; there are no wildcard CORS headers. Tokens are isolated by the single Factory Durable Object credential store and rejected by another Factory. See `packages/core/README.md` for the complete tool list, resource profile, and unsupported lifecycle operations. No execution-node or model-provider request receives this caller credential.

## Workerd integration evidence

`bun test apps/cloudflare/test` exercises the production compatibility-built `cloudflare:workers` Durable Object classes under Miniflare/workerd, with SQLite storage, transaction receiver, RPC, alarms/eviction, and the root Worker route. Its composed test drives the real Pi AI OpenAI Responses provider using a bounded mocked outbound HTTP service and a dummy API-key value; the mock selects the remote tool and returns its final response without reaching the Internet or making a paid request. A separately authenticated local execution daemon performs the actual workspace effect. Provider auth-failure and compatibility-shim tests also run under the workerd-compatible build contract.

This emulator result is not a production Cloudflare deployment. Production credentials, custom route, Access configuration, a real remote API provider request, tailnet/client setup, and a second-laptop connection were not tested. A deterministic adapter is confined to test-support and is not a Workers fallback.
