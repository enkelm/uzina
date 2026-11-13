# Daemon modules and modes

The Bun daemon supports the default local health/identity service and an explicit connected-executor mode. The connected executor is node-owned and runs independently of browser connections; it does not instantiate a competing Factory controller.

## Authenticated executor

- `src/execution/daemon.ts` exports `ExecutionDaemon`, which stores durable local job receipts and reports interrupted effects as uncertain rather than replaying them.
- `src/execution/connector.ts` exports `HttpExecutionControllerConnector`, an outbound Bearer-authenticated client for the schemas in `@uzina/contracts/execution`. Report reconciliation is controller-receipt based, not dependent on in-memory claims.
- `src/execution/loop.ts` exports `ExecutionLoop`, a bounded/cancellable register-heartbeat-claim-execute-report loop. Each protocol request is bounded; file and argv operations use the execution contract's size and timeout limits. Credentials are never logged.
- `src/factory/server.ts` exports `createLocalFactoryServer()` and `src/factory/sqlite.ts` exports `BunFactoryDatabase`. Its actual HTTP host can be run with the execution connector in tests.

Start connected mode explicitly and provide a node credential created by the owner through `POST /v1/nodes`:

```sh
UZINA_MODE=connected-executor \
UZINA_CONTROLLER_URL=https://controller.example \
UZINA_NODE_ID=node:laptop-a \
UZINA_NODE_CREDENTIAL='<owner-provisioned-node-credential>' \
UZINA_EXECUTION_DATABASE_PATH="$HOME/.local/share/uzina/executor.sqlite" \
UZINA_EXECUTION_WORKSPACES='[{"workspaceId":"workspace:repo","directory":"/absolute/path/to/checkout"}]' \
bun run dev:daemon
```

The daemon defaults to `HOST=127.0.0.1`; no credential or connected-mode configuration is inferred. Connected mode fails closed if controller URL, node ID, credential, SQLite path, or an explicit workspace mapping is missing. The local workspace mapping, not a controller payload, selects host directories.

## Slice boundary

`FactoryService.enqueueRemoteExecution` / `getRemoteExecutionReceipt` are trusted in-process seams for the later managed-Pi tool bridge; there is no public job-injection HTTP route. Factory managed-input dispatch remains a separate managed-runtime queue and is never returned to executor nodes. Slice 4a proves the authenticated controller/executor protocol and local HTTP workspace mutation, but does not bridge managed Pi, bind the production Cloudflare Worker Durable Objects, or claim cloud-to-laptop production execution.
