# Daemon foundation modules

The local daemon currently has separate foundation modules; the root daemon entry point still serves only the slice-0 health and identity routes.

- `src/runtime/managed-work.ts` exports `openLocalManagedPiWork()`, backed by `src/runtime/sqlite.ts` (`BunSqliteDatabase` and `openBunSqliteStorage()`). The facade is `@uzina/pi-runtime`; managed-work checkpoint support is `@uzina/pi-runtime/checkpoint`.
- `src/execution/daemon.ts` exports `ExecutionDaemon`; `src/execution/connector.ts` exports `HttpExecutionControllerConnector`. Execution protocol schemas are available at `@uzina/contracts/execution`.
- `src/factory/server.ts` exports `createLocalFactoryServer()` and `src/factory/sqlite.ts` exports `BunFactoryDatabase`. Factory operations are `@uzina/core`, with HTTP and database subpaths `@uzina/core/http` and `@uzina/core/database`.

These modules are not composed into daemon startup. In particular, the Factory queue and execution-node HTTP protocols are separate prototypes and must be reconciled explicitly in slice 4; no command is currently bridged from Factory through Pi Durable to an execution node.
