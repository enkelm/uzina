# Native Rex workers and the Factory inbox

Native agent sessions stay in Rex. The Factory does not import their transcripts, turn them into managed Work items, or type instructions into their terminals. A registered worker exchanges explicit questions, reports, instructions and answers through a durable Core mailbox. This protocol is agent-neutral; agent-specific installation and lifecycle adapters remain separate.

The existing owner-private Pi Durable assistant is the coordinator for this slice. It uses its own named, revocable Factory credential and current grants. There is no second scheduler, supervisor hierarchy, or permanent model loop. An outbox wakes the assistant when a worker posts a new item. Missing assistant configuration leaves the item pending; it does not discard the question or prevent the Owner from answering it.

## Register a worker

For a **new local Pi/Codex launch**, prefer [connected worker provisioning](native-worker-provisioning.md): the coordinator selects an operator-delegated profile/placement, retains one provisioning identity, and connects both `rex` and `factory` MCP without exposing a worker credential. Core reserves a `preparing` worker with `rex: null`, then binds observed launch identities/readiness before allowing new coordination. This is launch-scoped binding, not authenticated native conversation lifecycle evidence.

For manual metadata-only registration, an Owner/trusted provisioner calls `FactoryClient.registerNativeWorker` or `POST /v1/native-workers`. Supply:

- A stable `workerId`, project ID and display name.
- An explicit current node/workspace target and workspace ownership generation.
- Rex session and block IDs identifying the native session.
- A fresh random credential for this worker, at least 32 characters. For example, a trusted Node/Bun provisioner can use `randomBytes(32).toString("base64url")` from `node:crypto`.

Retain the registration payload and credential privately until registration is reconciled. Retrying an identical registration returns the same worker. Changed bindings or credentials conflict. Credentials cannot be reused from another worker or from an ordinary Factory identity. Core stores only the credential hash and omits the credential from worker responses.

Rex metadata is provisioner-supplied identity, not proof that a live native agent exists. Registration does not launch, adopt, inspect or revive a Rex process. Give the worker only its dedicated credential, never the Owner, node or coordinator bearer. Keep credentials in a private environment/configuration channel, not prompts, shell history, browser storage, URLs or reports.

## Connect the native worker

Provisioned Pi/Codex workers receive one private stdio **`factory`** tool with `status`, `ask`, `report`, `inbox`, and `acknowledge` operations. No operation accepts an alternate identity or credential. The bridge delegates to the same Core operations below; it creates no competing inbox. [Provisioning setup and bridge bounds](native-worker-provisioning.md) describe its immutable private files and retry behavior.

For manual integrations, configure the native session's MCP extension/client to use the Factory's `/v1/worker/mcp` endpoint with `Authorization: Bearer <worker credential>`. This endpoint exposes only:

| Tool                    | Purpose                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ask_factory`           | Persist a question or meaningful report using a stable `itemId`, `kind`, `title`, `text`, and `blocking` flag. |
| `check_factory_mailbox` | Read this worker's unacknowledged answers and instructions.                                                    |
| `ack_factory_message`   | Acknowledge receipt of a specific `messageId`.                                                                 |

The same operations are available through the typed client (`postWorkerItem`, `getWorkerMailbox`, `acknowledgeWorkerMessage`) and REST:

- `GET /v1/worker/status` (`getWorkerStatus`)
- `POST /v1/worker/items`
- `GET /v1/worker/mailbox`
- `POST /v1/worker/acknowledgements`

The worker chooses a stable item ID before sending and reuses the exact payload after a lost response. Questions should include enough context, options and a recommendation for the bot to decide or escalate. Text is bounded to 8,000 characters; do not forward terminal transcripts or credentials.

Manual workers explicitly check their mailbox, particularly after a blocking question. Newly provisioned connected Pi workers can use the [native Pi delivery adapter](native-pi-delivery.md), which verifies persisted native admission and delivers blocking answers at a safe boundary. Codex remains manual. Process status and Rex OSC indicators are presentation hints, not Factory assignment evidence.

For reusable local command jobs, a compatible CLI can separately load the [local Rex MCP tool](rex-tools.md), including its explicit raw-CLI fallback policy. That OS-user service is not a worker credential, a Factory authorization path, or an automatic mailbox-delivery adapter.

For **new** Pi/Codex sessions, [connected provisioning](native-worker-provisioning.md) uses the [local launcher](native-agent-launch.md) to attach both servers without changing global settings. The raw Owner launch method remains mechanics-only. The raw launch and mailbox alone do not prove admission or wake an idle model; connected Pi's separately verified lifecycle adapter supplies those capabilities.

## Bot and Owner workflow

A new item starts as `bot_pending`. Core commits the item and notification intent together. The host submits a stable notification input ID to the private assistant, which inspects the item with `factory_threads` (`op: "inspect"`, coordination target). Worker content is untrusted task data, not authority or a replacement for the Owner's instructions.

The assistant can answer within its delegated authority or escalate with an explanation. Escalation changes the item to `needs_user`; Core then rejects assistant answers to that item. The Owner can answer either a pending or an escalated item. The answer queues one worker mailbox message and changes the item to `answered`. Worker acknowledgement changes it to `acknowledged`.

The Owner opens **Factory inbox** in the web header for the selected project. Questions, escalation explanations, answers and delivery state all refer to the same Core item. The dialog supports keyboard/focus recovery, a narrow viewport, paged items and retrying an uncertain decision with its original request identity. There is no separate Kanban or sticky-note store.

The coordinator sees two tools:

- `factory_board`: view workers/inbox, maintain durable goals and attempts, review evidence, and answer/escalate Core items.
- `factory_threads`: inspect coordination items, queue instructions, reconcile command receipts, and manage separate focused Pi Durable discussions.

See [Factory bot tools and task lifetimes](factory-bot.md) for their command variants. The existing granular tools remain private implementation operations. Ordinary Factory MCP still exposes `list_native_workers`, `list_coordination_items`, `get_coordination_item`, `decide_coordination_item`, `message_native_worker`, and `get_coordination_receipt`. Reads require project visibility; decisions/instructions require Owner or project-authorized assistant authority; manual registration and revocation are Owner-only. Local automated provisioning additionally allows a project-authorized assistant only on operator-delegated target/profile policies. Native-worker credentials cannot call ordinary Factory APIs. Every native request rechecks revocation and current workspace authority, including mailbox reads and acknowledgements.

## Delivery and recovery

Decision and instruction mutations use stable `requestId` receipts. Pi Durable tools memoize their request identity and payload hash before HTTP mutation. After an uncertain acknowledgement they return the original request ID and direct the bot to `factory_threads` (`op: "receipt"`, `kind: "coordination"`), not to invent a fresh command. REST clients reconcile with `GET /v1/coordination-commands/:requestId`; receipts are limited to the issuing credential and its current project visibility.

The notification outbox retains its input identity across failures and restarts. Standalone startup drains pending notifications and retries failed admissions after 30 seconds. Cloudflare arms a recovery alarm before worker mutation, drains through the separate Private Assistant Durable Object, and retains an alarm while notifications remain. Pi Durable admission deduplicates a notification whose successful reply was lost.

Lists are byte-bounded below the client/tool response limit. Worker and coordination lists return `nextOffset`; continue until it is null. These are live offset pages, not frozen snapshots: refresh from the first page after concurrent changes. Coordination items needing user input sort first. Mailbox reads return only pending messages; acknowledge received messages and check again to drain the next bounded batch.

`FactoryClient.revokeNativeWorker` or `POST /v1/native-workers/:workerId/revoke` disables that worker's credential. Ownership movement fences a registration bound to the old generation. Neither revocation nor acknowledgement proves that already-read instructions stopped or executed.

## Boundaries

The mailbox itself is not a workforce scheduler. The [Factory bot foundation](factory-bot.md) adds persistent goals and recoverable assignment/observation tasks using Pi Durable, not another scheduler. Local Pi/Codex provisioning connects workers through those records, without a feature-specific startup opt-in. Connected Pi also has original-conversation delivery/lifecycle fencing and persisted admission evidence; that is an OS-user observation, not signed native identity. Remote provisioning, Codex automatic delivery, execution leases, autonomous terminal steering, transcript synchronization, native Pi state transfer, push notifications, board UI and OS sandboxing remain separate. The existing Rex lifecycle infrastructure and managed Pi work remain separate resources. The first-party web agentic conversation surface remains for Pi Durable work, not native Rex chats.
