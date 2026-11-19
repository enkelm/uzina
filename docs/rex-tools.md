# Reusable local Rex tools

Uzina supplies an agent-neutral stdio MCP server with one `rex` tool and a JSON CLI over the same local operation host. Any agent with a compatible stdio MCP client can use it; a Pi extension is not required. This slice does not install itself into agent configurations, launch coding agents, deliver assignments, wake idle models, or ingest their conversations.

The separate [local Pi/Codex launcher](native-agent-launch.md) can prepare this server's per-launch client configuration and verify MCP transport/catalogue readiness. It is not part of the `rex` tool and does not turn local command jobs into Factory-authorized assignments.

The policy is **tool-first, not tool-only**. Use the structured tool for common command jobs. For uncovered Rex operations, discover the installed CLI with `rex --help`, `rex COMMAND --help`, and `rex api describe`, then use the agent's shell tool. The server includes that policy in MCP initialization instructions.

## Authority and scope

This is a trusted **local OS-user service**, not the authenticated Factory MCP endpoint. It needs no Factory, Owner, worker, node, or model credentials. It is not an OS sandbox: commands and direct Rex CLI access retain the user's ordinary execution permissions. The workspace binding selects a working directory; it does not confine arbitrary commands to that directory.

Structured operations target only jobs admitted in this host's private journal. Callers cannot choose another node, workspace, pane, session, or process ID. Each job gets a dedicated Rex session and a `--shell=none` child argument array. Sessions are not automatically selected in the desktop app. Tabs/splits, review presentation, stopping and arbitrary Rex methods are outside this initial tool surface; use the CLI when otherwise authorized.

Factory project grants, placement generations, capture fences, worker revocation and command admission are **not** enforced by this standalone local service. Do not present a local MCP or raw CLI action as a scoped Factory command or attach this server to an untrusted remote client. Factory-owned lifecycle operations still need their authorized Core path. Raw CLI actions are not automatically imported into the local journal or Factory receipts.

CLI fallback is for missing coverage, not denied authority or an uncertain mutation. A lost/timed-out launch might have succeeded: reconcile its original `requestId`, rather than launching through another path. Never type instructions into an agent terminal as a substitute for a supported delivery adapter.

## Configure a client

Requirements: Bun 1.4.4, an existing local Unix-socket Rex server, and a CLI available as `rex` (or an operator-supplied executable). Native Windows and remote Rex endpoints are not supported by this slice.

Read the exact endpoint from:

```sh
rex --autostart=false whoami --json
```

Create a separate private state directory for each MCP server binding. Keep it outside the selected workspace; do not use a Factory or connected-executor database. Its directory must be owned by the current user and mode 0700; the journal is created mode 0600. Existing permissive or symlinked journal files are refused rather than silently repaired.

Create an owner-controlled, non-group/world-writable configuration file (mode 0600 recommended):

```json
{
  "workspaceDirectory": "/absolute/path/to/project",
  "journalPath": "/absolute/path/to/private-rex-state/worker-one.sqlite",
  "server": "unix:///absolute/path/to/rex/server.sock",
  "rexExecutable": "rex"
}
```

Use the exact `endpoint` string returned by `whoami`, including URL escaping. The host passes that endpoint explicitly and disables server autostart; it also checks the Rex instance identity. It does not follow an ambient focused pane or silently choose another host.

Build with `bun run build:daemon`. For clients using the `mcpServers` configuration shape, the entry is:

```json
{
  "mcpServers": {
    "rex": {
      "command": "/absolute/path/to/bun",
      "args": [
        "--no-env-file",
        "/absolute/path/to/uzina/build/daemon/rex-tools.js",
        "mcp",
        "--config",
        "/absolute/path/to/rex-tools.json"
      ]
    }
  }
}
```

Use that client's documented format if it differs; the executable and arguments stay the same. During development, substitute `apps/daemon/src/rex-tools.ts` for the bundled JavaScript path. No global agent settings or Rex configuration are rewritten. Tool compatibility is tested with the official MCP SDK; this is not a claim that every agent/version has been exercised.

## Tool operations

All requests use the single `rex` tool. Unknown fields and invalid combinations are rejected before effects.

- `context`: no other fields. Returns the workspace/server binding, available operations and CLI-fallback explanation.
- `run`: requires a stable `requestId` and nonempty `argv`. Optional `waitMs` defaults to 0, `tailLines` to 30, and `maxBytes` to 8192. Returns a local process receipt and a bounded terminal snapshot when available.
- `inspect`: requires the original `requestId`. Refreshes structured process evidence, not terminal-derived agent status.
- `wait`: requires the original `requestId`; optional `waitMs` defaults to 1000. Polls inside the host for a bounded interval without extra model turns. A wait deadline is not a failed command or completion.
- `output`: requires the original `requestId`; accepts `tailLines` and `maxBytes`. Returns a labelled `terminal_snapshot`, not a complete stdout/stderr log or stable log cursor.

Example:

```json
{
  "op": "run",
  "requestId": "verify:tests-1",
  "argv": ["bun", "run", "test"],
  "waitMs": 1000,
  "tailLines": 30,
  "maxBytes": 8192
}
```

Reusing the same request ID and argument array returns the original process identity, including during an overlapping launch. Different arguments conflict. Observation options are not launch identity and can change on retry. A new request ID represents a deliberate new command, not recovery of the previous one.

Receipts distinguish `starting`, `running`, `stopping`, `exited`, and `uncertain`. A successful tool response can contain a starting or uncertain receipt; it is not a success claim about the child command. An exited process has its reported exit code, which may be nonzero or unknown. Terminal creation is not agent readiness, execution acceptance, or review.

Output/observation failures after launch preserve the admitted receipt and report `outputError`/`observationError`; they do not turn it into an apparently rejected launch. Replaying an admitted `run`, or inspecting/waiting on its request ID, can return the last committed receipt even when refresh fails; `observationError` means that receipt is not fresh process evidence. Output contains untrusted task data. Terminal controls are stripped. Rex capture may be an alternate-screen snapshot; its finite scrollback is not a durable log.

Bounds: request IDs 128 characters; argv up to 128 arguments of 4096 characters; waits up to 30 seconds plus bounded CLI observation latency; output up to 500 lines and 32 KiB of retained terminal bytes; requests up to 64 KiB; at most 4096 jobs per journal, with no automatic pruning. Rex CLI calls time out after 15 seconds. Stop waiting or close the MCP connection to end observation, not the child process. Commands run independently of the MCP connection.

## JSON CLI and raw Rex fallback

The JSON CLI invokes the same operation host, validation, identity checks and receipts:

```sh
printf '%s\n' '{"op":"inspect","requestId":"verify:tests-1"}' |
  bun --no-env-file build/daemon/rex-tools.js call --config /absolute/path/to/rex-tools.json
```

Only one live host may own a journal, so close its MCP connection before using this JSON CLI against that journal. Concurrent clients should use separate configured journals. A dead host's journal can be reclaimed on restart; a live PID is conservatively refused, including PID reuse.

For features the tool does not cover, use **raw Rex CLI**, not arbitrary method forwarding through MCP. Pass the explicit endpoint and exact IDs from `context` and the job receipt, for example:

```sh
rex --autostart=false --server 'unix:///absolute/path/to/rex/server.sock' \
  session inspect 'session:exact-id-from-receipt' --json
```

Look up the installed command's help before using version-specific behavior. Inspect before retrying a timed-out mutation. Closing or killing resources can terminate work and does not undo filesystem or external effects; target only the intended, authorized resources. The MCP server neither tracks nor constrains subsequent raw CLI actions.

## Recovery and limits

The local host reuses `RexProcessManager` and its SQLite receipts, not a second process implementation. Accepted launch intent is committed before invoking Rex. Only the admission that inserted that intent may launch it. Interrupted `starting`/`stopping` transitions become uncertain on reopen and are never automatically replayed. A lost Rex response may leave a real session without persisted returned IDs; inspect the exact `uzina-<processId>` label from the retained receipt before taking any deliberate recovery action.

Recorded exit evidence survives closing the Rex presentation; later raw CLI activity does not reopen a completed journal job.

A journal is permanently bound to its canonical workspace, configured endpoint/executable and first observed Rex instance. Rebinding or a Rex instance change refuses. Inspect old resources/evidence before deliberately configuring a new journal; a new journal does not resolve or retire earlier uncertain work. No automatic replacement, process stop, native-session portability or exactly-once arbitrary command execution is promised.

The state directory and local journal are private transport/process evidence, not another Factory work catalogue. No model loop or scheduler is introduced. These tools do not implement the worker mailbox bridge, automatic wake-up, agent-specific session binding, native admission receipts, or multi-agent provisioning.

## Verification

```sh
bun test apps/daemon/test/rex-tools.test.ts apps/daemon/test/execution.test.ts
bun run check
bun run typecheck
bun run test
bun run build
```

The regular tests use real stdio MCP, SQLite, subprocesses and temporary command effects, substituting only the external Rex CLI. They cover overlapping launch admission, lost responses, abrupt host loss, bounded capture, binding/ownership refusal, server replacement and JSON CLI interoperability.

For an installed local Rex server, explicitly opt into:

```sh
UZINA_REX_LIFECYCLE_INTEGRATION=1 bun test apps/daemon/test/rex-tools.integration.test.ts
```

This creates a fresh isolated session, checks a real command effect/exit/output and retry identity, then closes only its verified test resources. It makes no model call and does not launch a coding agent. Failed cleanup retains its temporary journal/workspace for inspection. The existing `rex-lifecycle.integration.test.ts` remains a separate create/inspect/stop acceptance test.
