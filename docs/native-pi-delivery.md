# Native Pi assignment delivery

Normal local startup enables the Pi adapter for **newly provisioned, connected Pi workers**. It uses an ordinary interactive Pi TUI in Rex, its invocation-local extension, and the existing Factory mailbox. It does not use RPC/print mode, terminal keystrokes, transcript synchronization, a new workforce scheduler, or an always-running model conversation. Codex provisioning and MCP remain supported, but Codex delivery is manual. The installed lifecycle proof uses Pi 1.5.2. Programmatic hosts supply `nativePiEntry` in their trusted native-agent configuration to attach this adapter; omitting it preserves manual provisioning. Normal local startup supplies the built `native-pi.js` entry automatically.

```text
Pi Durable goal → Core assignment/mailbox → Pi extension
                                           ↓
                         native user entry saved in Pi JSONL
                                           ↓
                         private admission journal + fsync
                                           ↓
                    executor independently verifies entry bytes
                                           ↓
                      Core admission → native turn → tools
                                           ↓
                      blocking question → stop the native turn
                                           ↓
                  Owner answer → saved native delivery → resume
                                           ↓
                       file effect → report → coordinator review
```

## Shared protocol and evidence

`@uzina/contracts/assignments` validates `uzina.assignment.v1`: stable card/attempt IDs, title, bounded brief and exact report item ID. `messageNativeWorker` accepts an optional structured `assignment` alongside its serialized `text`. Core stores it with the original mailbox message; it does not create another inbox. Untyped instructions remain available for manual reading, not automatic execution.

Core permits **one active typed assignment per worker**. It refuses another assignment while that assignment is queued/admitted/started, or while blocking coordination items remain unresolved. A correctly correlated report ends the execution assignment; it is still only a worker report. Goal review/acceptance remains a separate Pi Durable/Owner decision, including its human-decision gates.

| Evidence                     | Meaning                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning/process receipt | Executor admitted or observed a process; not native task admission.                                                                                                 |
| MCP readiness                | Initialized, served catalogues and observed local host ownership; not a model turn.                                                                                 |
| Mailbox acknowledgement      | Receipt only; cannot upgrade a task to admitted or started.                                                                                                         |
| Assignment `admission`       | Exact tagged user-message bytes, entry ID and conversation binding were verified against Pi's persisted JSONL after fsync.                                          |
| Assignment `startedAt`       | The bound native turn entered Pi's pre-provider context gate after Core confirmed admission. Not proof a provider request succeeded or a tool/file effect occurred. |
| Correlated report            | The worker reported an outcome under the requested item ID. Not independent verification or acceptance.                                                             |
| Goal acceptance              | Coordinator/Owner reviewed criterion-linked evidence and the current decision gates.                                                                                |

The native extension retains intent **before** calling `pi.sendUserMessage(..., { expandPromptTemplates: false })`. That API is fire-and-forget: its return and message events are not persistence receipts. Before a provider request, the adapter finds the exact user entry on the current branch, reads/fsyncs its native JSONL, and publishes entry ID/hash evidence. The daemon independently reads the private journal and actual native entry before Core admits/acknowledges it. HTTP/model callers cannot submit evidence or select a session path.

`factory_board view` on a native goal includes its correlated `nativeReceipt`; the original coordination receipt retains that admission/start/report evidence after the active assignment is released and across Core reopen. A receipt for another worker is refused.

`GET /v1/worker/runtime` / `FactoryClient.getWorkerRuntime()` returns the dedicated worker's active assignment, compact blocking references and bounded existing mailbox. It is used by the adapter, not added to the model-facing tool menu. Worker/provisioning reads may refresh existing evidence, but never prepare a worker, send input or launch a process. Core rechecks worker revocation and placement around asynchronous evidence work.

## Idle delivery, blocking, and manual control

The extension polls the mailbox every 500 ms without invoking a model. It sends only a typed assignment or an answer for the current blocking work, and only while the correct Pi conversation is idle, has no pending input, editor draft or blocking UI prompt. Blocking answers outrank unrelated mail; active assignments cannot be hidden by older instructions behind a bounded mailbox page.

A Factory-owned turn admits at most **one tool call per model response**. The reservation occurs before asynchronous authorization, so parallel or nested sibling calls cannot slip past a question. The adapter revalidates current authority and blocking state before tools. A blocking question ends that turn; the supported answer delivery starts a new turn only after its persisted receipt clears the blocking gate. No repeated model polling is used.

In the original native Pi conversation:

- `/factory` shows delivery state.
- `/factory pause` disarms delivery and requests native-turn abort.
- `/factory resume` explicitly rearms the verified original conversation. Active work continues from its persisted context, not by reinjecting the original assignment.
- Escape, Control-C, native abort, or manual conversation input disarms automatic work. Already admitted tool effects may still finish; abort is not process termination or workspace quiescence.

Reload/reopen remains paused until explicit resume, including an idle reload. New/switch/fork/tree operations cannot silently transfer identity. A different conversation is detached, and both the Pi tool gate and private Factory MCP bridge refuse its inherited Factory connection. Returning to the original saved conversation remains paused until explicit resume. This is recovery of a launch's original conversation, not adoption of arbitrary existing sessions.

A prepared delivery without confirmed native admission is **uncertain**, not rejected. It is never blindly injected again. Restore access and reconcile the original IDs, original native file and current branch. Missing, changed, oversized or unsafe private state stops automatic work; there is no force-clear/replacement API. A native turn that ends without a blocking question or report also pauses rather than starting an unbounded reminder loop.

## Private state and limits

The immutable worker configuration pins the Pi UUID, private session directory, workspace and native Factory tool name. `activity.json` plus a single-live-owner lock live beside that worker's private configuration, outside the workspace. Updates are mode-0600 atomic replacements under a mode-0700 directory, with fsync and retained-byte conflict checks. Journals contain IDs/hashes and bounded lifecycle metadata, not native transcript copies or credentials. Core stores only reference evidence, not session paths or native conversation text.

An adapter retains at most 128 delivery intents and reads at most 8 MiB of native session JSONL. Exceeding a bound pauses delivery; no history is silently pruned. Pi's own JSONL file remains in its normal format/mode within the private launch session directory. Native conversation and tool output remain in Rex; trusted local admission verification is not a transcript API.

PID/lock/file observations are **OS-user diagnostics, not signed native identity or an OS sandbox**. A same-user process can access other permitted files, including credentials. The external Rex MCP server retains OS-user authority; a native shell sandbox does not sandbox it. No credential isolation, arbitrary-effect exactly-once guarantee, supervision/reassignment, remote delivery, or complete native workspace quiescence is claimed.

## Proof

`local-startup.test.ts` starts the built default CLI without Factory configuration. With real Core/HTTP, SQLite, Pi Durable tasks, generated extensions, MCP subprocesses and Pi's session engine, it proves assignment → question → Owner answer → file effect → report → review/acceptance. Only external Rex/PTY and model responses are substituted. It also covers backlog priority, one active assignment, premature-report refusal, parallel-tool blocking, Escape, reload/fork/new/switch fencing, retained identity and forged private evidence rejection. Disabling the executor's entry-byte/hash verification makes the forged queued assignment incorrectly become `started`; the normal guard is restored.

The installed-agent opt-in test runs **ordinary installed Pi and Codex TUIs in real Rex sessions against built bundles**. Pi uses a private controlled provider extension and completes the task/question/answer/effect/report loop; Codex initializes both MCP connections without inference. Cleanup uses exact labels from both executor and worker tool journals. No terminal input, paid provider call, global native setting mutation or existing-session cleanup is used. This is controlled-response lifecycle proof, not acceptance of a real model's reasoning; a real-provider acceptance run requires separate authorization.
