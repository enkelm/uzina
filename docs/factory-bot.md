# Factory bot: board, threads, and durable commitments

The owner-private Pi Durable assistant now hosts the Factory bot. It has two model-facing tools: `factory_board` and `factory_threads`. Existing Core operations remain underneath them, callable by tools but not directly by the model. Native Pi conversations still live in Rex; focused Pi Durable discussions do not import or replace them.

Owners can open **Factory chat** from the web header to use this private coordinator. The panel uses the existing Owner-only private-assistant API, displays canonical user/assistant text without tool or system messages, and preserves the original input ID/text for same-tab uncertain-send reconciliation. It is not a Work chat or native terminal. Receipt state describes the coordinator reply, not worker completion or goal acceptance. Closed/hidden panels do not poll, and account/access loss clears private state.

This is a runtime foundation, not a new Factory-wide identity or shared board UI. The existing private-assistant identity, ingress, storage isolation, and grant administration remain unchanged. Ordinary managed coding workers receive neither of these tools.

## State and ownership

| Resource                                                                            | Owner and lifetime                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal/card and structured brief                                                      | Conversation-scoped Pi Durable document; survives context reset, restart, and task completion.                                                             |
| Pinned agenda                                                                       | Conversation-scoped index; at most 12 cards rendered before model requests. Briefs and history are retrieved on demand.                                    |
| Execution attempt                                                                   | Custom `uzina.factory-goal-attempt` background task; checkpoints admission and observes Core evidence.                                                     |
| Focused discussion                                                                  | Separate tool-free Pi Durable conversation, initially owned by its background discussion task. Subsequent inputs have their own background reporter tasks. |
| Discussion answer and summary                                                       | Conversation-scoped discussion record; does not retire with the task.                                                                                      |
| Questions, reports, decisions, worker instructions, and external execution receipts | Existing authoritative Core records, referenced by ID rather than copied into another inbox.                                                               |

There is no second scheduler or permanent model loop. Pi Durable schedules tasks and persists sleeps. Bun uses its normal Pi timers; the Cloudflare private-assistant object uses its existing durable recovery alarm. Tasks poll Core or a discussion submission every 30 seconds and have a 24-hour observation deadline. Reaching the deadline requests attention rather than replaying an assignment. Long-lived goals do not expire with an attempt.

Pinned attention contains card IDs, short titles, state, revision, next step, and current task identity. It does not embed full briefs, worker reports, transcripts, credentials, or a timestamp that changes every turn. Each project is authorized through Core before its agenda entries are rendered. Inaccessible entries are omitted; existing conversation history is not retroactively erased by a grant change.

## Board tool

`factory_board` is a typed command union:

- `view`: without a project, discover authorized projects; with `cardId`, inspect its full brief, evidence, and task. Project views choose `section: "cards" | "workers" | "inbox" | "targets" | "provisioning"` and bounded offset pagination. Targets expose only operator-configured profile/placement IDs; provisioning lists retained task outcomes. `view` with `provisioningRequestId` refreshes the original Core/process/MCP receipt without preparing files or relaunching. Sections are separate so combining worst-case records cannot overflow the tool response budget.
- `provision`: after Owner commitment, queue a bounded durable provisioning task with `projectId`, `targetId`, `profileId`, and `name`. Core permits the assistant only on an operator-delegated target/profile and current project grant. It reserves a dedicated worker credential, launches Pi/Codex through the existing executor, and observes both private MCP connections. MCP readiness is not assignment admission; connected Pi's separately observed delivery adapter can admit and start the task at a safe native boundary. To explicitly resume blocked/uncertain provisioning after restoring access, include the original `requestId` and unchanged fields; the same worker/process intent is reconciled, not replaced. See [setup, authority and recovery](native-worker-provisioning.md).
- `capture`: persist a goal with project, title, structured brief, priority, optional dependencies, and optional pinning. A goal is an idea, not a running task. Dependencies must already exist in the same project, making capture-time dependencies acyclic.
- `refine`: change an unstarted brief or update title, priority, pinning, and next step. Briefs attached to an attempt are immutable; changed requirements belong in a follow-up card. Active attempts cannot be refined.
- `dispatch`: create a background attempt targeting an existing managed Work thread or registered native worker. It returns the task and stable Core request identities promptly, not after the work finishes. Dependencies must have accepted outcomes. Core still authorizes the actual submission/instruction and applies current workspace fencing.
- `control`: pause further admission, resume a paused task, request workflow cancellation, or archive settled work. An admission already in flight may still succeed. Neither pause nor cancellation stops a Rex process, reverses an external effect, or proves that execution stopped.
- `reconcile`: start a read-only observer of the **original** Core request after a blocked/uncertain attempt. It never resends an assignment. For a native target, an explicit alternative report ID must belong to the original worker and project and be a report.
- `accept`: record a coordinator review only after an attempt reaches `review`, its Pi task is terminal, current Core evidence remains valid, and every acceptance criterion cites that evidence. A linked blocking/escalated report must be resolved first. There is no unrestricted status setter.
- `decide`: answer or escalate a Core coordination item. Once it is `needs_user`, only the authorized human can answer; accepting a board card cannot bypass that gate.

Mutations of existing cards require `expectedRevision`. A stale revision fails rather than overwriting a concurrent workflow change. Pi command identity, its payload hash, document changes, task creation, and the application receipt are committed through Pi Durable. A resumed tool call returns its original committed result.

Example capture:

```json
{
  "op": "capture",
  "projectId": "project:example",
  "title": "Safe native answer delivery",
  "priority": "high",
  "brief": {
    "objective": "Deliver owner answers to a native Pi worker without terminal typing",
    "inputs": ["coordination:delivery-policy"],
    "deliverables": ["Implementation and verification report"],
    "acceptance": ["No duplicate instruction after restart"],
    "constraints": ["Keep the native conversation in Rex"]
  }
}
```

Use the returned card ID and revision for later commands. A worker ID, Work thread ID, or brief never grants capabilities or chooses a new execution placement.

## Thread tool

`factory_threads` provides:

- `view`: project-scoped focused discussions plus the existing bounded managed Work inventory.
- `open`: create a focused `planning` or `review` discussion linked to a card and supplied with a structured brief.
- `inspect`: select a `discussion`, managed `work`, or Core `coordination` item explicitly. Discussion history is paged newest-first using `beforeEntryId`; large entries return labelled previews. No native transcript is ingested.
- `send`: continue a focused discussion, queue input to an existing managed Work thread, or queue an instruction to a registered worker. A discussion permits one active input at a time. It cannot be implicitly reopened after closing.
- `receipt`: reconcile a managed Work or coordination command using its original `requestId`. Lost-acknowledgement results point to this facade, not a hidden implementation tool.
- `summarize`: retrieve the retained latest discussion answer, bounded to 8,000 characters. This is not a new model call or a fresh summary of the entire transcript.
- `close`: persist closure and abort that Pi discussion. It does not stop a native session or another discussion.

Discussions have no execution tools, no Factory tools, one model turn per input, and no native environment. The host selects these capabilities; the brief cannot widen them. They return findings and recommendations, not claims that commands ran. The active discussion task is a background boundary, so ordinary root idle/abort does not wait for or cancel it. Explicit discussion close, task cancellation including background work, authorization failure, or the deadline cancels the relevant Pi conversation. Follow-up reporters explicitly cancel their reused conversation too, even if its original owning task has finished.

Results wake the coordinator with a stable, reference-only follow-up input. The result document and follow-up admission commit atomically. Worker text and discussion answers remain retrievable data, not appended system instructions.

## Assignment and evidence protocol

A native attempt queues one instruction containing a JSON `uzina.assignment.v1` envelope: card/task references, title, brief, and a preselected report `itemId`. The worker acknowledges the mailbox message separately and submits its outcome with that exact ID and `kind: "report"` through the existing native-worker endpoint. A managed Work attempt instead requests a normal conversation outcome; Core's command receipt supplies its correlation.

The attempt records `prepared`, `admitting`, and `admitted` stages. Admission intent is committed before HTTP mutation. Recovery first queries the original Core receipt; an accepted request is not resent. Retrying an uncertain admission uses the same ID and exact payload. This is idempotent command admission, not exactly-once external execution.

A managed command marked completed can enter `review`. A native mailbox acknowledgement cannot. Only a report bound to the assigned worker/project can enter review, and a report needing a decision blocks acceptance. Even a correctly correlated report proves **what the worker reported**, not independently that its code ran or acceptance checks passed. The coordinator must inspect the evidence before recording its criterion-by-criterion review.

A blocked or uncertain attempt cannot be blindly dispatched again or resumed as fresh work. Reconciliation observes existing evidence without changing external intent; replacement work needs a deliberate new outcome/attempt after review. All Core mutations retain the assistant's current grants and ordinary Core receipts.

## Bounds and remaining work

Each private bot retains at most 1,000 cards and 1,000 discussion records, with 12 pinned cards, eight active attempts, eight active discussions, and 100 task identities per card. Provisioning separately retains at most 1,000 records and eight active tasks; each task has a two-minute deadline and ends rather than supervising indefinitely. Briefs are bounded to 6,000 serialized characters; list fields have at most eight entries. Lists and history have bounded pages; tool results retain the existing 256 KiB byte cap. Archive preserves a card's record rather than claiming it completed or deleting its history; archival does not reclaim the retention quota.

Normal local startup discovers Pi/Codex/Rex and provides connected-worker provisioning without an extra Factory configuration flag. Newly connected Pi workers use [safe native delivery](native-pi-delivery.md), persisted JSONL admission, native-turn evidence and original-conversation switch/fork/reload fencing. Dispatch sends a validated `uzina.assignment.v1` envelope through the existing mailbox; Core permits one active typed assignment per worker. Codex delivery remains manual. Remote provisioning, process supervision/reassignment, execution leases, a shared Factory-wide coordinator identity, board/sticky-note UI and push notifications remain separate. Manually registered Rex IDs are still metadata, and MCP readiness alone is still not native admission.

## Verification

```sh
bun test apps/daemon/test/factory-bot.test.ts apps/daemon/test/private-assistant.test.ts apps/daemon/test/private-assistant-recovery.test.ts
bun test apps/cloudflare/test/composed-workerd.test.ts
bun run check
bun run typecheck
bun run test
bun run build
```

The Factory-bot scenarios run the real Pi registry, SQLite documents/tasks, HTTP client/handler, Core authorization, worker mailbox, and receipts. Only the external model transport is deterministic; tests make no paid model requests. They cover reset/reopen, tool visibility, background discussion lifetime and scope loss, uncertain admission recovery, wrong-target/report rejection, acknowledgement versus completion, cancellation boundaries, read-only reconciliation, dependencies, and evidence-backed acceptance with the human-decision gate.
