# Uzina: single-factory foundation across Cloudflare and two laptops

## Problem Statement

The owner wants a software factory that can coordinate coding-agent work from a browser, use Rex to host and inspect machine-local execution, and run managed Pi conversations durably in either Cloudflare or a local runtime. Work should be transferable between cloud and local machines without losing its conversation, workspace changes, or execution provenance.

Today, the relevant capabilities are spread across separate projects. Pi Tava provides collaboration, invite-based access, and managed Pi execution. T3 Code demonstrates structured CLI adapters, durable command receipts, and execution recovery. Rex provides process and terminal hosting. None of these currently constitutes an Uzina implementation.

The immediate need is to establish one coherent factory, its private assistant, and a working deployment across Cloudflare and two laptops. The owner does not want to build multi-factory tenancy, cross-factory synchronization, or an email identity platform before proving that foundation.

## Solution

Build Uzina as a Bun-workspaces monorepo with a portable Factory Core, a Cloudflare deployment, a persistent local daemon, and a minimal PWA. The same Core operations are exposed through authenticated HTTP and MCP interfaces. The factory's assistant uses MCP or custom tools rather than privileged database access.

The first connected deployment uses Cloudflare for authoritative coordination and managed Pi Durable execution. Each laptop runs an authenticated execution daemon that supplies explicitly assigned workspaces, files, Git operations, and tool processes. Rex hosts terminal and CLI execution on those machines. A standalone local mode composes the same application behavior with local persistence and Pi Durable execution.

Introduce versioned checkpoints and explicit ownership transfer rather than continuously synchronizing mutable databases. First prove managed work across Cloudflare and both laptops, then prove restoration and continuation in the standalone local runtime. Each deployment is a single-factory application; this does not introduce a multi-factory management product.

Use Pi Tava-style owner bootstrap, expiring invitation codes, and simple roles. Retain Tailscale as the private human-access network, with separately authenticated connections to the Cloudflare runtime. Email login and external identity-provider integration remain deferred.

## User Stories

1. As the owner, I want Uzina to manage one factory, so that I can prove the workflow without configuring tenants or unrelated factories.
2. As the owner, I want to run a standalone factory locally, so that I can use the same application behavior without requiring the cloud deployment.
3. As the owner, I want to deploy authoritative coordination to Cloudflare, so that connected execution does not depend on keeping a particular laptop awake.
4. As the owner, I want to register each of my two laptops as an execution node, so that either can execute assigned work.
5. As the owner, I want node registrations to survive daemon restarts, so that I do not need to enroll my machines repeatedly.
6. As the owner, I want to see which nodes are available, disconnected, or unable to perform an operation, so that I can choose an appropriate execution destination.
7. As the owner, I want to assign work to a specific node and workspace, so that execution does not silently happen on the wrong machine.
8. As the owner, I want unavailable destinations to produce an explicit blocked or unavailable state, so that a failure does not cause an unexpected local or remote fallback.
9. As the owner, I want projects to organize related work, so that I can find the relevant threads, runs, and workspaces.
10. As the owner, I want to create and reopen threads, so that agent conversations remain available after a browser or daemon restart.
11. As a participant, I want to see where a runtime lives separately from where its tools execute, so that I understand which machine holds the workspace.
12. As an authorized participant, I want to submit input to a managed Pi conversation, so that I can start and continue useful work.
13. As an authorized participant, I want to see streamed progress and committed outcomes, so that I can distinguish current activity from durable results.
14. As an authorized participant, I want to reconnect without resubmitting input, so that a network interruption does not create duplicate work.
15. As an authorized participant, I want to inspect the status of an accepted command, so that a lost response does not force me to guess whether it succeeded.
16. As an authorized participant, I want supported steering and stopping operations, so that I can direct work without relying on terminal keystrokes.
17. As an authorized participant, I want unsupported runtime operations to be refused explicitly, so that the application does not pretend every harness has identical capabilities.
18. As the owner, I want managed Pi tasks to recover from supported durable checkpoints, so that a controller restart does not discard accepted work.
19. As the owner, I want failed, parked, interrupted, and uncertain work to remain distinguishable, so that I know whether to retry, investigate, or provide direction.
20. As the owner, I want Rex-hosted processes and their associated work to be inspectable, so that I can use terminal tools without making terminal output the orchestration database.
21. As the owner, I want closing the PWA or a desktop window to leave the execution daemon running, so that the user interface does not own process lifetime.
22. As the owner, I want machine-specific credentials to stay on their authorized destination, so that connecting a node does not copy another machine's private configuration.
23. As the owner, I want a private factory assistant, so that I can ask questions about projects and coordinate work through one conversation.
24. As the assistant, I want to discover the factory's supported operations through tools, so that I can use explicit application capabilities rather than guess at internal state.
25. As the assistant, I want to list projects and inspect permitted threads and runs, so that I can understand the current work before acting.
26. As the assistant, I want to submit, steer, and stop permitted work through MCP or custom tools, so that my actions follow the same rules as human actions.
27. As the owner, I want the assistant to have a named, separately revocable credential, so that I can remove its access without sharing or replacing my browser credential.
28. As a participant, I want assistant-originated actions to identify the assistant and accountable owner, so that the transcript does not misrepresent automation as a direct human message.
29. As the owner, I want a private bootstrap sign-in flow, so that I can administer the factory without configuring email delivery.
30. As the owner, I want to invite someone with an expiring, single-use code or link, so that I can grant access without managing passwords.
31. As an invitee, I want to join using a display name, so that collaboration does not require a new email account or external identity provider.
32. As the owner, I want Owner, Guest, and Viewer roles, so that administration, agent steering, and viewing are distinguishable.
33. As the owner, I want project- or thread-scoped invitations, so that a participant receives access only to the intended work.
34. As a viewer, I want to read permitted work and participate in discussion without starting agent execution, so that I can collaborate without controlling paid or shell-capable work.
35. As a guest, I want to steer permitted agent work without administering users or factory settings, so that I can contribute within my granted scope.
36. As the owner, I want to change or revoke access, so that an existing browser or tool connection cannot indefinitely retain old permissions.
37. As the owner, I want invitation expiry and redemption to survive restarts, so that restarting the controller does not revive used codes or lose valid invitations.
38. As the owner, I want to capture a coherent checkpoint of managed work and its workspace, so that I can restore the same work elsewhere.
39. As the owner, I want checkpoints to preserve staged, unstaged, untracked, and binary working changes within the declared workspace scope, so that a transfer does not silently discard unfinished work.
40. As the owner, I want checkpoint manifests to identify runtime requirements, integrity hashes, and omitted resources, so that compatibility and completeness can be checked before restoration.
41. As the owner, I want checkpoint transfers to use a local file or blob storage, so that the format is not tied to a single cloud provider.
42. As the owner, I want to preview and validate a restoration before execution begins, so that incompatible runtime versions, missing resources, or conflicting destinations fail safely.
43. As the owner, I want to move workspace execution from laptop A to laptop B while retaining the cloud runtime, so that I can change execution machines without unnecessarily migrating conversation control.
44. As the owner, I want to restore a supported managed checkpoint into the standalone local runtime, so that I can continue the transferred work locally after an explicit move.
45. As the owner, I want an execution move to leave the source inactive, so that two machines do not independently mutate the same transferred work.
46. As the owner, I want interrupted transfers and repeated restore requests to find their original receipts, so that retrying does not allocate duplicate work or activate a second copy.
47. As the owner, I want uncertain external effects to remain uncertain until reconciled, so that recovery does not blindly repeat a command that may already have run.
48. As the owner, I want a restored workspace to resolve credentials and tools on the destination, so that checkpoint import does not install another machine's secrets or silently downgrade its execution requirements.
49. As a maintainer, I want the local and cloud deployments to share Core behavior, so that authorization, command acceptance, and recovery do not diverge between hosts.
50. As a maintainer, I want platform-specific adapters to remain separate from browser and portable runtime code, so that a change to local process execution does not break the Cloudflare bundle.
51. As a maintainer, I want a reproducible demonstration using Cloudflare and both laptops, so that the first milestone proves real execution and transfer rather than only mocked interfaces.
52. As the owner, I want setup and validation to disclose required human credentials, unrun checks, and infrastructure blockers, so that a successful local test is not mistaken for a completed cloud or second-laptop deployment.

## Implementation Decisions

### Scope and working vocabulary

- The product is Uzina. It is a fresh single-factory application, not a fork or wholesale transplant of Pi Tava or T3 Code.
- A factory is the application-managed space for projects, participants, work, and execution resources. There is no tenant model, factory directory, cross-factory membership, or global multi-factory assistant in this milestone.
- A controller accepts authoritative coordination commands for a deployment. An execution node is a registered machine providing execution capabilities. A connected execution node is not a fallback controller.
- A project organizes related work. A workspace is an actual checkout or working directory on a particular execution node. A thread is a conversation. A run is an execution attempt associated with accepted input. A work item groups the root thread, relevant descendants, and workspace state that must travel together.
- A checkpoint is a versioned, coherent representation of supported runtime state and workspace state. Copying history alone is not execution transfer.
- A standalone local deployment and a cloud-controlled deployment are alternative compositions of the same single-factory application. Checkpoint transfer between them does not require a multi-factory interface, synchronized accounts, or shared mutable databases.

### Monorepo and module responsibilities

- Use Bun workspaces for installation, workspace scripts, and local development. Bun is the intended local daemon runtime, subject to an early compatibility proof with Pi Durable and the chosen SQLite facade. Cloudflare continues to use its own Workers runtime.
- Provide three initial application entry points: a PWA, a local daemon, and a Cloudflare deployment. Do not create a desktop shell or additional empty applications during scaffolding.
- The Contracts module owns runtime-validated requests, responses, events, resource identities, capability descriptions, and version negotiation. It contains no storage or process implementations.
- The Core module owns project and work operations, command admission, execution placement, node registration, access policies, durable receipts, and transfer coordination. It accepts dependencies instead of constructing host resources.
- The Pi Runtime module owns Pi Durable integration, including Harness setup, conversation operations, supported task recovery, extension assembly, and binding tools to an execution environment. It does not replace Pi Durable's task scheduler.
- The Client module owns authenticated requests, event subscriptions, reconnect handling, and stable request identities for the PWA and custom tools.
- The Checkpoints module owns manifests, validation, compatibility checks, restore preparation, and transfer orchestration. Actual filesystem acquisition and blob persistence are supplied by adapters.
- Keep shared HTTP and MCP adapters thin and independently importable. Both call the same authorized Core operations. They must not become parallel implementations of the application.
- Keep local filesystem, Git, process, Rex, and native CLI implementations in the daemon until another production consumer justifies extracting a package. Do not create generic utility, UI, or plugin packages preemptively.
- The PWA is one shared frontend. React and Vite are the proposed implementation choice, not an independent product requirement; no existing frontend implementation is present. A future Tauri shell should reuse that frontend rather than introduce a second application model.

### Deployment, execution, and persistence

- The first connected topology places authoritative Factory coordination and managed Pi execution on Cloudflare. Both laptops register as execution nodes using explicit node credentials and destination configuration.
- The local daemon has connected-executor and standalone modes. Connected-executor mode supplies execution without creating a competing authoritative work catalogue. Standalone mode composes Core, local persistence, Pi Runtime, and local execution.
- Identify runtime placement separately from workspace execution placement. A Cloudflare-managed conversation can execute tools on laptop A and later laptop B without moving the conversation runtime.
- Use Cloudflare Durable Object SQLite for cloud coordination and managed runtime persistence, R2 for cloud checkpoint and artifact blobs, and local SQLite and files for the standalone deployment. Do not assume a Node-specific SQLite adapter works unchanged in Bun.
- Separate Factory coordination state from portable managed work state. Keep a managed work item's root conversation and owned descendants within one recoverable storage unit where practical. A model response is not its own deployment or storage unit.
- Pi Durable already provides Cloudflare storage and alarm-based recovery hooks. Wire these hooks in the cloud entry point; wire local shutdown and recovery in the daemon. Verify actual runtime behavior rather than implementing permanent polling as a substitute.
- Cloudflare does not execute ordinary CLI subprocesses or host Rex. Managed filesystem and command operations use an execution environment bound to the selected laptop and workspace.
- Execution jobs have stable identities and observable receipts. An unavailable node cannot be replaced implicitly with another machine. Relevant destination, workspace, authorization, and ownership checks occur before effects.
- Execution nodes retain workspace files, native session data, and any job evidence needed for safe reconciliation. They do not replicate the Factory's authoritative mutable coordination database. They are not literally disposable while holding uncheckpointed work.
- Persist accepted intent before dispatching external effects. Acknowledging a command means its acceptance is durable, not that the requested execution or checkpoint has finished.
- Cross-module or cross-Durable-Object work uses durable intent and correlated outcomes, not an assumed transaction spanning multiple stores. Do not promise exactly-once execution of arbitrary shell commands or third-party effects.
- Repeated input or mutation requests with the same identity return the existing receipt. A lost acknowledgement does not authorize a new request identity or automatic replay of uncertain external input.
- The daemon owns process lifetime independently of browser connections. Rex remains the process/multiplexer substrate, while structured runtime events and persisted application records describe agent work.
- Establish Rex launch, inspection, and stop behavior as the local execution foundation. The managed Pi vertical slice is the first acceptance gate. Structured native Pi CLI integration follows that slice; additional harnesses are not required to prove the initial cloud/local transfer.
- Capabilities must distinguish reattachment, native resume, managed checkpoint recovery, steering, and stopping. Unsupported operations refuse before changing work. Do not infer semantic completion from terminal text or treat an uncertain cancellation as confirmed termination.

### Access and the private assistant

- Use Pi Tava's basic invitation and token model: private owner bootstrap, display-name joining, expiring single-use invitations, persistent browser access, and Owner, Guest, and Viewer roles. No email address or password is required.
- The owner administers access and factory settings. Guests may steer permitted agent work. Viewers may inspect permitted work and participate in non-agent discussion without starting or steering execution. Project and thread grants are enforced by Core, not only hidden by the UI.
- Persist invitations and their expiry/redemption state. Store non-bootstrap credentials as hashes. Protect bootstrap recovery material and keep credentials out of application events, model prompts, ordinary logs, and exported checkpoints.
- Revocation and role changes affect subsequent reads, mutations, and live subscriptions. Define and expose what can be stopped after revocation; do not claim to undo already dispatched external effects.
- Human-facing deployment access remains tailnet-only. A normal Worker endpoint is not automatically inside the tailnet. Use the local daemon's tailnet-facing gateway for private access where needed and authenticate outbound daemon-to-cloud and assistant-to-controller connections explicitly. Do not expose an anonymous public Factory or MCP endpoint to make connectivity easier.
- The private assistant is a normal authorized actor using MCP or custom tools. Its conversation is owner-private. It receives a named, independently revocable credential rather than an owner's browser token or direct access to the application database.
- Assistant-originated input records both the assistant actor and accountable owner. Its tools use explicit project, thread, run, workspace, and node targets instead of an ambient frontend selection.
- Expose the operations needed to list projects and permitted work, inspect threads and runs, submit input, and invoke supported lifecycle operations. The assistant's breadth of access comes from its grants, not a separate privileged control path.
- MCP is a transport, not an authorization bypass. Validate credentials for the intended resource and do not forward a caller's token indiscriminately to execution nodes or unrelated upstreams.
- Application project grants are not an OS sandbox. A user allowed to steer a shell-capable agent has meaningful execution power. Unrestricted native Rex access must not be represented as equivalent to a scoped Factory invitation.

### Checkpoint and transfer behavior

- Implement versioned logical checkpoint bundles rather than synchronization of open SQLite files or generic bidirectional filesystem replication. Pi Durable's storage adapters are not themselves a complete export/import implementation.
- The first guaranteed transfer target is supported, quiescent Pi Durable work. Preserve the required runtime documents, conversation relationships, submissions and receipts, attachment references, and compatible task checkpoints. Where the public runtime interface cannot reconstruct a safe checkpoint, refuse that state rather than silently exporting history only or copying undocumented internals without a versioned adapter.
- Couple runtime capture with the exact workspace snapshot. Capture Git history/references needed for restoration and relevant staged, unstaged, untracked, and binary bytes and modes. Handle worktree metadata without depending on absolute paths from the source host.
- Declare workspace inclusion/exclusion policy and report omissions. Credential stores, authentication configuration, machine-wide settings, and unselected files are not swept into bundles. Do not claim that an arbitrary workspace is secret-free; show its export scope before publication.
- Checkpoints contain version and capability requirements, integrity information, provenance, and relevant uncertain-operation evidence. Restore validates these before enabling execution, rejects unsafe archive paths and incompatible data, and resolves working directories and attachment references for the destination.
- Destination credentials and executable dependencies are resolved locally. Missing requirements block restoration or activation without silently substituting a different provider, machine, tool set, or security policy.
- Separate checkpoint capture, execution-node relocation, and managed-runtime transfer. Relocating cloud-controlled tool execution need not migrate the Pi runtime. Restoring into standalone mode transfers the selected work, not all users, projects, or factory-controller state.
- A move blocks new source admissions, quiesces supported work, captures a checkpoint, prepares a non-running destination, records an ownership transition, and activates the destination only after the source is durably fenced. Existing unrelated work is not stopped.
- Ownership transfer uses a monotonically advancing ownership generation or equivalent fencing mechanism checked by controllers and execution admissions. A node that reconnects with an old generation cannot resume transferred work. Do not rely solely on an in-memory flag or presumed network disconnection.
- Interrupted moves retain a stable transfer identity and source/destination evidence. Retrying prepares or returns the same destination instead of allocating a second runnable copy. If a move cannot establish exclusive ownership or resolve uncertain writes, leave it blocked for reconciliation.
- Source history remains available as inactive transfer provenance. Reactivating a transferred source is not an implicit retry. Cross-controller reconnection must not create a second writer for already transferred work.
- Support file-based checkpoint export/import and cloud blob-backed transfers using the same manifest semantics. A completed standalone restore must not require the source controller to stay online merely to read its existing conversation or continue supported local work.
- Indefinite offline reconciliation, active-active editing, general-purpose history merging, whole-factory controller migration, and an independent fork workflow are not acceptance requirements for this milestone.

### Delivery sequence and acceptance

- First prove the dependency and persistence foundations: Bun-hosted Pi Durable, Cloudflare-hosted Pi Durable, durable reopen, cloud alarm recovery, and authenticated node communication.
- Next create one managed cloud conversation that executes a bounded filesystem or shell operation in laptop A's selected workspace. Observe the same accepted work through the client and MCP interfaces.
- Register laptop B and explicitly relocate execution using a coherent checkpoint and ownership transition. Verify that a delayed laptop A cannot continue mutating the transferred work.
- Capture supported managed work, prepare a standalone local restore, transfer ownership, and continue with equivalent model context and preserved workspace state. Repeat restore and transfer requests to prove deduplication and restart recovery.
- Add the minimal project/thread/run/assistant/people PWA views required to operate and inspect these flows. Rich collaboration and full terminal rendering are not prerequisites for the first execution proof.
- Publish reproducible setup, validation, and recovery instructions. Actual deployment to Cloudflare and the second laptop depends on the owner's credentials and machine availability; report these separately from local or simulated test results.

## Testing Decisions

- **Proposed primary seam, awaiting owner confirmation:** the authenticated Factory interface consisting of commands, queries, and committed events. Treat this as one observable application surface, regardless of whether a caller uses HTTP or MCP. Exercise business behavior here rather than against internal repositories, reducers, or orchestration helper call sequences.
- A good test protects an observable outcome or independent contract and has a credible failure mode. It should remain valid when internal organization changes. Do not assert private method calls, duplicate schema facts, source text, or outcomes already fabricated by a mock.
- Define one shared application scenario suite and run it through local and Cloudflare host adapters with real persistence. This proves portable behavior without writing separate copies of every business test. Use minimal deterministic model responses only at the external model-provider seam; do not mock Core acceptance, ownership, or receipt production.
- Cover durable command deduplication, lost acknowledgements, queued input, restart recovery, event ordering after commit, explicit unsupported capabilities, unavailable execution destinations, and the distinction between accepted and completed operations.
- Cover invitation expiry and single use, persistence across restart, role and project/thread restrictions, assistant attribution, revoked credentials, stale subscriptions, and authorization checks before effects. Use independent actors and denied-operation controls so a test proves the intended guard.
- Cover cloud-to-local execution with bounded real workspace effects, node disconnect/reconnect, cancellation uncertainty, delayed responses, stale ownership generations, and no implicit machine fallback. A separate real Rex integration check is justified for process lifetime, capture, and stop behavior, which synthetic job fixtures cannot prove.
- Cover checkpoint equivalence and integrity through public capture/restore operations. Include dirty Git state, binaries, attachments, worktree relocation, required descendants, task checkpoint compatibility, omitted resources, destination conflicts, malformed archives, and credentials remaining outside the bundle.
- Cover transfer interruption before and after each durable ownership milestone. Verify that the source remains fenced, retries find the same destination, and an unknown external effect is not automatically replayed. Assert actual persistent evidence and observable workspace results rather than fixture-invented success receipts.
- Add focused transport tests only for distinct HTTP/MCP risks such as decoding, authentication binding, resource audience, cancellation, and request correlation. Do not repeat the entire domain suite for each transport. Browser tests are reserved for actual browser behavior such as invitation redemption, retained uncertain input, and reconnect presentation.
- Use the actual Cloudflare-compatible test runtime for Durable Object transactions, alarms, eviction/reopen behavior, and Worker-specific interfaces. Bun-only tests are not evidence that these work in production. Use real local SQLite reopen tests for local durability.
- Prefer explicit events, durable receipts, worker drains, and controlled clocks over arbitrary sleeps or timing assertions. Keep fixtures isolated from live Pi Tava data, existing Rex sessions, actual provider credentials, and the owner's working repositories. Real paid-model calls are not required for the automated suite.
- Prior art inspected in Pi Tava includes real SQLite-backed imports preserving canonical model context without re-executing history, persistent invite redemption with authority rechecks, and browser submission recovery retaining one request identity after lost acceptance. T3 Code provides prior art for transactional command receipts and outbox intent, provider recovery, and checkpoint restoration safety. Reuse their behavioral lessons without importing their entire application or private test machinery.
- The final operator demonstration uses Cloudflare and both actual laptops. Record which runtime, node, checkpoint, ownership transition, and workspace effects were observed. Distinguish this from emulator coverage and report unavailable infrastructure or unrun checks explicitly.

## Out of Scope

- Multiple logical factories in one deployment, tenant identities, factory discovery, account federation, cross-factory assistants, and a multi-factory frontend.
- Generic synchronization engines, mutable database replication, active-active controllers, automatic controller failover, and distributed leader election.
- Whole-factory controller migration, automatic offline history merging, and unrestricted offline execution by a disconnected cloud executor.
- Email/password login, email delivery, external identity-provider integration, organization directories, and complex custom roles.
- Hetzner provisioning as a prerequisite; the initial targets are Cloudflare and the two laptops. The architecture should not prevent a later VPS deployment.
- Tauri packaging, native mobile clients, and separately hosted or dynamically federated frontend modules.
- Full Pi Tava feature parity, rich review/workflow systems, extension marketplaces, advanced memory, scheduled automation, and polished browser terminal parity.
- Codex and additional provider integrations as acceptance gates for the initial managed Pi vertical slice. Native CLI portability is not guaranteed merely because managed Pi checkpoints are portable.
- Transparent migration of process memory, active PTYs, native dialogs, unsaved terminal drafts, or arbitrary running tools.
- Exactly-once guarantees for arbitrary external effects, rollback of completed third-party actions, and claims that access checks provide an OS security sandbox.
- Automatic secret detection or a guarantee that selected project files contain no secrets.
- Selecting Cloudflare solely on assumed savings without measuring actual duration, storage, transfer, and model costs.

## Further Notes

- This is a draft specification synthesized from the conversation, not a report of completed implementation. At drafting time, no Uzina repository, project glossary, ADRs, tracker configuration, or working code existed in the workspace. The named modules describe proposed responsibilities rather than existing interfaces.
- Pi Tava and T3 Code are reference implementations. Their source was inspected to ground invitation behavior, managed runtime integration, durable command handling, and import/recovery test decisions. Pi Tava's current session import copies history and is not an exclusive execution-ownership transfer.
- The locally inspected Pi Durable package was version 1.4.0. It already supplied a Cloudflare Durable Object SQLite adapter and alarm-oriented wake hooks. That does not establish Bun compatibility, safe cross-backend checkpoint export, or application-level transfer semantics; these must be proven in the first implementation stages and the actual dependency versions must be pinned.
- Cloudflare duration billing can include active wall-clock waiting. Cloud placement is a deployment target, not a promised compute-cost reduction. The factory still needs machine execution capacity for ordinary process and filesystem work.
- The terms "instance" and "node" were used loosely during discussion. This draft uses one single-factory application per deployment and explicit execution-node registrations; it does not assume that two independently started controllers share authority merely because their software or labels match.
- The shared Factory test seam still requires the owner's confirmation before publication. No additional product interview is needed to preserve this draft.
- Issue tracker and triage-label configuration have not been provided. Run `/setup-matt-pocock-skills` after initializing the project. Once the proposed testing seam is confirmed and a tracker is configured, publish this spec there with `ready-for-agent`; do not add an additional triage pass. No issue has been published or label applied yet.
