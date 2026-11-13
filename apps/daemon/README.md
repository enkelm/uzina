# Uzina daemon modes

The daemon defaults to `UZINA_MODE=local`, which composes the standalone persistent Factory, managed Pi Durable runtime, and loopback HTTP application. The default hostname is `127.0.0.1`; opening a public listener requires an explicit `HOST` override and a private tailnet-facing firewall/gateway. The separate `connected-executor` mode supplies an explicitly provisioned execution node and does not create a competing Factory catalog.

## Standalone local Factory

Use Bun 1.4.4. Configure a real Pi AI provider/model and a private bootstrap secret, then run:

```sh
UZINA_MODE=local \
UZINA_BOOTSTRAP_SECRET='<private-local-bootstrap-secret>' \
UZINA_MODEL_PROVIDER=openai \
UZINA_MODEL_ID=gpt-4o-mini \
UZINA_MODEL_API_KEY='<provider-api-key>' \
bun run dev:daemon
```

`UZINA_FACTORY_DATABASE_PATH` defaults to `~/.local/share/uzina/factory.sqlite`; `UZINA_MANAGED_WORK_DIRECTORY` defaults to `~/.local/share/uzina/managed-work`. Both can be set to isolated paths for tests or an operator-selected data location. The service defaults to `http://127.0.0.1:8788`. `POST /v1/bootstrap` uses the configured `Bootstrap` bearer secret once; the returned human bearer is distinct from all execution-node credentials.

Model provider, model ID, and API key are required. Startup validates them against the actual Pi AI provider/model catalog and credential resolver. Missing or unsupported configuration fails closed; production does not install a dummy response model. Secret values are not printed or placed in Factory events. The deterministic model adapters are test-only.

A thread is created with an owner-selected node/workspace placement. Inputs do not repeat the placement. Core persists each accepted input, then dispatches it to one stable per-thread managed Pi store. Pi Durable makes submissions idempotent by accepted request ID. `GET /v1/threads/:threadId/context` returns canonical model context and `GET /v1/threads/:threadId/status` returns runtime inspection/status; both require an authenticated Factory credential. `GET /v1/commands/:requestId` returns the managed completion/failure/uncertainty receipt and remote execution receipts. `GET /v1/events` exposes committed receipt transitions.

## Authenticated connected executor

To use a node provisioned by the Factory owner, start connected mode explicitly:

```sh
UZINA_MODE=connected-executor \
UZINA_CONTROLLER_URL=https://factory.example \
UZINA_NODE_ID=node:laptop-a \
UZINA_NODE_CREDENTIAL='<owner-provisioned-node-credential>' \
UZINA_EXECUTION_DATABASE_PATH="$HOME/.local/share/uzina/executor.sqlite" \
UZINA_EXECUTION_WORKSPACES='[{"workspaceId":"workspace:repo","directory":"/absolute/path/to/checkout"}]' \
bun run dev:daemon
```

The node credential is separate from human/bootstrap/model credentials. The node initiates authenticated outbound HTTP requests and must not use a human token. Owner provisioning through `POST /v1/nodes` and `POST /v1/workspaces` binds the node and workspace IDs. The controller payload does not select an arbitrary host directory. The default host remains loopback; connected mode is not a human Factory UI/gateway.

- `src/execution/daemon.ts` persists job receipts and reports interrupted effects as uncertain rather than replaying them.
- `src/execution/connector.ts` is an outbound Bearer-authenticated client for the schemas in `@uzina/contracts/execution`.
- `src/execution/loop.ts` is a bounded/cancellable register-heartbeat-claim-execute-report loop. Heartbeats continue independently while an argv or file effect is awaited; shutdown waits for an in-flight effect. Credential refusal stops future claims. Local storage/protocol errors fail closed; only classified transport failures/transient HTTP statuses are retried.
- Workspace files are bounded and traversal/symlink escapes are rejected. `argv-command` does not shell-parse its argument array. An optional command `cwd` is interpreted relative to the selected workspace (`.` means root); absolute paths, traversal, missing/non-directory paths, and symlink escapes produce failed receipts before process start.

## Local verification and evidence limits

`bun run test` includes a full local scenario using the actual Factory HTTP host, persistent Factory SQLite, Pi Durable over Bun SQLite, a deterministic model at the provider seam, `ExecutionDaemon` with its own SQLite, the real outbound HTTP loop, and a temporary workspace write/command. It covers deduplicated input, tool-result correlation, provider failure, command timeout uncertainty with a real partial effect, relative `cwd`, invalid `cwd`, and reopened receipts/context.

The Cloudflare-compatible end-to-end scenario is in `apps/cloudflare/test/composed-workerd.test.ts`; it runs actual Miniflare/workerd Durable Objects and the same HTTP executor protocol. It is emulator evidence only. No production cloud deployment, paid provider request, production credential check, second-laptop operation, or mutation of an existing Rex session is claimed.
