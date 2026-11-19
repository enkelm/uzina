import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  wrapTool,
  Harness,
  type Conversation,
  type JsonObject,
  type Submission,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { FactoryClient } from "@uzina/client";
import { FactoryService, createFactoryHttpHandler } from "@uzina/core";
import { createFactoryBotExtension } from "@uzina/pi-runtime";
import type {
  BotThread,
  Goal,
  GoalBrief,
} from "../../../packages/pi-runtime/src/factory-bot-state";
import { factoryBotTestModels } from "../../../packages/pi-runtime/test-support/factory-bot-model";
import { BunFactoryDatabase } from "../src/factory/sqlite";
import { openBunSqliteStorage } from "../src/runtime/sqlite";

const brief: GoalBrief = {
  objective: "Deliver safe worker integration",
  inputs: ["coordination:existing"],
  deliverables: ["Verified implementation report"],
  acceptance: ["No duplicate assignment after restart"],
  constraints: ["Keep native sessions in Rex"],
};
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Factory bot scenario did not settle");
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "uzina-factory-bot-"));
  const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
  const factory = new FactoryService(database, "bootstrap-test");
  const ownerCredential = (await factory.bootstrap("bootstrap-test", "Owner"))
    .credential;
  const owner = await factory.authenticate(ownerCredential);
  factory.createProject(owner, "project:one", "One");
  factory.createProject(owner, "project:two", "Two");
  await factory.provisionNode(owner, "node:one", "One");
  factory.createWorkspace(owner, "workspace:one", "node:one", "One");
  const assistant = await factory.provisionCredential(
    owner,
    "assistant",
    "Factory coordinator",
    [{ type: "project", resourceId: "project:one" }],
  );
  const assistantSession = await factory.authenticate(assistant.credential);
  const handler = createFactoryHttpHandler(factory);
  const mutations: string[] = [];
  let loseAcknowledgement = false;
  const transport = (async (input, init) => {
    const request = new Request(input, init);
    const isAssignment =
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/messages");
    if (isAssignment)
      mutations.push(
        ((await request.clone().json()) as { requestId: string }).requestId,
      );
    const response = await handler(request);
    if (isAssignment && loseAcknowledgement && response.ok) {
      loseAcknowledgement = false;
      throw new TypeError("Lost accepted assignment response");
    }
    return response;
  }) as typeof fetch;
  const client = new FactoryClient({
    baseUrl: "http://factory.test",
    credential: assistant.credential,
    fetch: transport,
  });
  const ownerClient = new FactoryClient({
    baseUrl: "http://factory.test",
    credential: ownerCredential,
    fetch: transport,
  });
  const model = factoryBotTestModels();
  const registry = createRegistry();
  const factoryBot = createFactoryBotExtension(client, {
    credentialToRedact: assistant.credential,
  });
  registry.install(factoryBot);
  let clock = Date.now(),
    sequence = 0;
  let interruptBoardOp: string | undefined;
  let commandCommitted: (() => void) | undefined;
  registry.install(
    defineExtension({
      name: "test:lost-board-result",
      wraps: [
        wrapTool(
          factoryBot.tools!.find((tool) => tool.name === "factory_board")!,
          (tool) => ({
            ...tool,
            async execute(args, api, invocation) {
              const result = await tool.execute(args, api, invocation);
              if (
                args !== null &&
                typeof args === "object" &&
                "op" in args &&
                args.op === interruptBoardOp
              ) {
                interruptBoardOp = undefined;
                commandCommitted?.();
                await new Promise<never>((_resolve, reject) => {
                  const signal = invocation.abortSignal;
                  if (!signal || signal.aborted) {
                    reject(new Error("Invocation interrupted"));
                    return;
                  }
                  signal.addEventListener(
                    "abort",
                    () =>
                      reject(
                        new Error(
                          "Invocation interrupted after application commit",
                        ),
                      ),
                    { once: true },
                  );
                });
              }
              return result;
            },
          }),
        ),
      ],
    }),
  );
  let harness: Harness, root: Conversation;
  let lastSubmission: SubmissionId | undefined;
  async function open() {
    harness = await Harness.open(
      await openBunSqliteStorage(join(directory, "bot.sqlite")),
      { registry, models: model.models, now: () => clock },
      context,
    );
    root = await harness.root(context, {
      agent: { model: { provider: "uzina-test", modelId: "fixed-model" } },
    });
    harness.resume();
  }
  await open();
  async function invoke<T>(
    tool: string,
    args: JsonObject,
  ): Promise<{ error: boolean; value: T }> {
    const submission = await root.submit(
      {
        type: "input",
        requestId: `test:${++sequence}`,
        content: JSON.stringify({ tool, args }),
      },
      context,
    );
    lastSubmission = submission.id;
    return answer<T>(submission);
  }
  async function answer<T>(
    submission: Submission,
  ): Promise<{ error: boolean; value: T }> {
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.type === "write")
      throw new Error("Test command unanswered");
    const view = await root.context(context, { at: settled.answer });
    const answer = view.messages.at(-1);
    if (answer?.role !== "assistant" || answer.content[0]?.type !== "text")
      throw new Error("Test command has no answer");
    return JSON.parse(answer.content[0].text);
  }
  const board = <T>(args: JsonObject) => invoke<T>("factory_board", args);
  const threads = <T>(args: JsonObject) => invoke<T>("factory_threads", args);
  const inspect = async (cardId: string) => {
    const result = await board<{
      card: Goal;
      task: { state: { status: string } } | null;
    }>({ op: "view", cardId });
    if (result.error) throw new Error(JSON.stringify(result.value));
    return result.value;
  };
  async function register(workerId = "worker:one", projectId = "project:one") {
    const credential = `native_test_${workerId.replaceAll(":", "_")}_00000000000000000000000000000`;
    await ownerClient.registerNativeWorker({
      workerId,
      projectId,
      name: workerId,
      target: { nodeId: "node:one", workspaceId: "workspace:one" },
      ownershipGeneration: 0,
      rex: { sessionId: "rex:metadata-only", blockId: "block:metadata-only" },
      credential,
    });
    return new FactoryClient({
      baseUrl: "http://factory.test",
      credential,
      fetch: transport,
    });
  }
  return {
    board,
    threads,
    invoke,
    inspect,
    register,
    model,
    mutations,
    client,
    ownerClient,
    loseNextAcknowledgement() {
      loseAcknowledgement = true;
    },
    interruptNextBoardResult(op: string) {
      interruptBoardOp = op;
      return new Promise<void>((resolve) => {
        commandCommitted = resolve;
      });
    },
    async recoverLastResult<T>() {
      const submission = lastSubmission
        ? await harness.submission(lastSubmission, context)
        : undefined;
      if (!submission) throw new Error("Missing interrupted invocation");
      return answer<T>(submission);
    },
    async tick() {
      clock += 31_000;
      harness.resume();
      await Bun.sleep(10);
    },
    async reopen() {
      await harness.close(context);
      await open();
    },
    async reset() {
      await root.reset(undefined, context);
    },
    async abortOrdinary() {
      await root.abort(context);
    },
    restoreProject() {
      factory.setAssistantCredentialGrants(
        owner,
        assistantSession.credentialId,
        [{ type: "project", resourceId: "project:one" }],
      );
    },
    revokeProject() {
      factory.setAssistantCredentialGrants(
        owner,
        assistantSession.credentialId,
        [{ type: "project", resourceId: "project:two" }],
      );
    },
    async close() {
      await harness.close(context).catch(() => {});
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Factory goals outlive context reset and restart; focused discussions are background Pi tasks with no execution capabilities", async () => {
  const f = await fixture();
  try {
    const captured = await f.board<{ card: Goal }>({
      op: "capture",
      projectId: "project:one",
      title: "Native worker integration",
      brief,
    });
    expect(captured.error).toBe(false);
    const cardId = captured.value.card.cardId;
    expect(
      f.model.requests
        .filter((request) => !request.discussion)
        .every(
          (request) =>
            JSON.stringify(request.tools) ===
            JSON.stringify(["factory_board", "factory_threads"]),
        ),
    ).toBe(true);
    const hidden = await f.invoke<string>("factory_list_projects", {});
    expect(hidden.error).toBe(true);
    const stale = await f.board<string>({
      op: "refine",
      cardId,
      expectedRevision: 5,
      title: "Should not apply",
    });
    expect(stale.error).toBe(true);
    expect(stale.value).toContain("revision_conflict");
    const falseCompletion = await f.board<string>({
      op: "accept",
      cardId,
      expectedRevision: 1,
      review: [
        {
          criterion: brief.acceptance[0]!,
          evidence: "invented",
          note: "Not proven",
        },
      ],
    });
    expect(falseCompletion.error).toBe(true);
    const opened = await f.threads<{ thread: BotThread }>({
      op: "open",
      cardId,
      purpose: "review",
      brief,
    });
    expect(opened.error).toBe(false);
    const threadId = opened.value.thread.threadId;
    await until(async () =>
      f.model.requests.some((request) => request.discussion),
    );
    expect(
      f.model.requests
        .filter((request) => request.discussion)
        .every((request) => request.tools.length === 0),
    ).toBe(true);
    await f.abortOrdinary();
    await f.reset();
    await f.reopen();
    await f.tick();
    await until(
      async () =>
        (
          await f.threads<{ thread: BotThread }>({
            op: "inspect",
            target: { kind: "discussion", threadId },
          })
        ).value.thread.state === "answered",
    );
    const summary = await f.threads<{
      thread: BotThread;
      task: { state: { status: string } };
    }>({ op: "summarize", threadId });
    expect(summary.value.thread.summary).toContain(
      "acknowledgement is not execution",
    );
    expect(summary.value.task.state.status).toBe("terminal");
    expect((await f.inspect(cardId)).card).toMatchObject({
      title: "Native worker integration",
      state: "idea",
      brief,
    });
    const attention = f.model.requests
      .at(-1)
      ?.messages.filter((message) => message.role === "system");
    expect(JSON.stringify(attention)).toContain(cardId);
    expect(JSON.stringify(attention)).toContain("Persistent commitments");
    const continued = await f.threads<{ threadId: string }>({
      op: "send",
      target: { kind: "discussion", threadId },
      text: "Assess safe follow-up delivery.",
    });
    expect(continued.error).toBe(false);
    await f.threads({ op: "close", threadId });
    await f.tick();
    const closed = await f.threads<{ thread: BotThread }>({
      op: "inspect",
      target: { kind: "discussion", threadId },
    });
    expect(closed.value.thread.state).toBe("closed");
    const afterClose = await f.threads<string>({
      op: "send",
      target: { kind: "discussion", threadId },
      text: "Must not reopen implicitly.",
    });
    expect(afterClose.error).toBe(true);
    const discussionCount = f.model.requests.filter(
      (request) => request.discussion,
    ).length;
    const revokingThread = await f.threads<{ thread: BotThread }>({
      op: "open",
      cardId,
      purpose: "review",
      brief,
    });
    await until(
      async () =>
        f.model.requests.filter((request) => request.discussion).length >
        discussionCount,
    );
    f.revokeProject();
    await f.tick();
    const forbidden = await f.board<string>({ op: "view", cardId });
    expect(forbidden.error).toBe(true);
    expect(forbidden.value).not.toContain("Native worker integration");
    const inaccessibleDiscussion = await f.threads<string>({
      op: "summarize",
      threadId,
    });
    expect(inaccessibleDiscussion.error).toBe(true);
    await f.reset();
    await f.board({ op: "view" });
    expect(JSON.stringify(f.model.requests.at(-1)?.messages)).not.toContain(
      cardId,
    );
    f.restoreProject();
    const failedDiscussion = await f.threads<{
      thread: BotThread;
      task: { state: { status: string } };
    }>({
      op: "inspect",
      target: {
        kind: "discussion",
        threadId: revokingThread.value.thread.threadId,
      },
    });
    expect(failedDiscussion.value.thread.state).toBe("failed");
    expect(failedDiscussion.value.task.state.status).toBe("terminal");
  } finally {
    await f.close();
  }
}, 20_000);

test("a board mutation committed before process loss replays its original result even after its lifecycle preconditions change", async () => {
  const f = await fixture();
  try {
    const captured = await f.board<{ card: Goal }>({
      op: "capture",
      projectId: "project:one",
      title: "Archive receipt recovery",
      brief,
    });
    const cardId = captured.value.card.cardId;
    const committed = f.interruptNextBoardResult("control");
    const interrupted = f
      .board({ op: "control", cardId, expectedRevision: 1, action: "archive" })
      .catch(() => undefined);
    await committed;
    await f.reopen();
    await interrupted;
    const recovered = await f.recoverLastResult<{ card: Goal }>();
    expect(recovered.error).toBe(false);
    expect(recovered.value.card).toMatchObject({
      cardId,
      archived: true,
      revision: 2,
    });
    expect((await f.inspect(cardId)).card.revision).toBe(2);
    expect(
      (
        await f.board<{ cards: Goal[] }>({
          op: "view",
          projectId: "project:one",
        })
      ).value.cards,
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 20_000);

test("Factory attempts reconcile lost Core admission after restart and require a bound worker report plus acceptance review, not a mailbox acknowledgement", async () => {
  const f = await fixture();
  try {
    const worker = await f.register();
    const otherWorker = await f.register("worker:other", "project:two");
    const imposterWorker = await f.register("worker:imposter");
    const captured = await f.board<{ card: Goal }>({
      op: "capture",
      projectId: "project:one",
      title: "Native delivery",
      brief,
    });
    const cardId = captured.value.card.cardId;
    const wrongProject = await f.board<string>({
      op: "dispatch",
      cardId,
      expectedRevision: 1,
      target: { kind: "native", workerId: "worker:other" },
    });
    expect(wrongProject.error).toBe(true);
    expect((await otherWorker.getWorkerMailbox()).messages).toEqual([]);
    f.loseNextAcknowledgement();
    const queued = await f.board<{ card: Goal }>({
      op: "dispatch",
      cardId,
      expectedRevision: 1,
      target: { kind: "native", workerId: "worker:one" },
    });
    expect(queued.error).toBe(false);
    await until(
      async () => (await worker.getWorkerMailbox()).messages.length === 1,
    );
    const message = (await worker.getWorkerMailbox()).messages[0]!;
    const assignment = JSON.parse(message.text) as {
      cardId: string;
      report: { itemId: string };
    };
    expect(assignment.cardId).toBe(cardId);
    expect(f.mutations).toEqual([message.messageId]);
    await f.abortOrdinary();
    await f.reopen();
    await f.tick();
    await until(async () => (await f.inspect(cardId)).card.state === "waiting");
    expect(f.mutations).toEqual([message.messageId]);
    await worker.acknowledgeWorkerMessage(message.messageId);
    await f.tick();
    expect((await f.inspect(cardId)).card.state).toBe("waiting");
    await imposterWorker.postWorkerItem({
      itemId: assignment.report.itemId,
      kind: "report",
      title: "Wrong worker",
      text: "Claimed completion",
      blocking: false,
    });
    await f.tick();
    await until(async () => (await f.inspect(cardId)).card.state === "blocked");
    // A mismatched report cannot be accepted, and the original assignment is never blindly rescheduled.
    const blocked = (await f.inspect(cardId)).card;
    expect(
      (
        await f.board({
          op: "dispatch",
          cardId,
          expectedRevision: blocked.revision,
          target: { kind: "native", workerId: "worker:one" },
        })
      ).error,
    ).toBe(true);
    expect(
      (
        await f.board({
          op: "accept",
          cardId,
          expectedRevision: blocked.revision,
          review: [
            {
              criterion: brief.acceptance[0]!,
              evidence: `coordination:${assignment.report.itemId}`,
              note: "Wrong worker is not evidence.",
            },
          ],
        })
      ).error,
    ).toBe(true);
    expect(f.mutations).toHaveLength(1);
    // The uncertain original assignment remains active. A different idle worker can take a separate follow-up, not silently replace it.
    const followupWorker = await f.register("worker:follow-up");
    const second = await f.board<{ card: Goal }>({
      op: "capture",
      projectId: "project:one",
      title: "Verified follow-up",
      brief,
    });
    const secondId = second.value.card.cardId;
    await f.board({
      op: "dispatch",
      cardId: secondId,
      expectedRevision: 1,
      target: { kind: "native", workerId: "worker:follow-up" },
    });
    await until(
      async () =>
        (await followupWorker.getWorkerMailbox()).messages.length === 1,
    );
    const nextMessage = (await followupWorker.getWorkerMailbox()).messages[0]!;
    const nextAssignment = JSON.parse(nextMessage.text) as {
      report: { itemId: string };
    };
    await followupWorker.postWorkerItem({
      itemId: nextAssignment.report.itemId,
      kind: "report",
      title: "Implementation evidence",
      text: "Verified the original instruction was delivered once across restart.",
      blocking: false,
    });
    await f.tick();
    await until(
      async () => (await f.inspect(secondId)).card.state === "review",
    );
    const review = (await f.inspect(secondId)).card;
    const inventedEvidence = await f.board({
      op: "accept",
      cardId: secondId,
      expectedRevision: review.revision,
      review: [
        {
          criterion: brief.acceptance[0]!,
          evidence: "invented",
          note: "Not a receipt.",
        },
      ],
    });
    expect(inventedEvidence.error).toBe(true);
    const accepted = await f.board<{ card: Goal }>({
      op: "accept",
      cardId: secondId,
      expectedRevision: review.revision,
      review: [
        {
          criterion: brief.acceptance[0]!,
          evidence: `coordination:${nextAssignment.report.itemId}`,
          note: "Reviewed the worker's report; it is a reported result, not independently executed verification.",
        },
      ],
    });
    expect(accepted.error).toBe(false);
    expect(accepted.value.card.state).toBe("complete");
    await f.reopen();
    expect((await f.inspect(secondId)).card.state).toBe("complete");
    expect(f.mutations).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 20_000);

test("pause and cancellation never claim to stop native execution; reconciliation observes the same request without resending it", async () => {
  const f = await fixture();
  try {
    const worker = await f.register();
    const captured = await f.board<{ card: Goal }>({
      op: "capture",
      projectId: "project:one",
      title: "Cancellation boundaries",
      brief,
    });
    const cardId = captured.value.card.cardId;
    const dependent = await f.board<{ card: Goal }>({
      op: "capture",
      projectId: "project:one",
      title: "Dependent outcome",
      brief,
      dependencies: [cardId],
    });
    const premature = await f.board<string>({
      op: "dispatch",
      cardId: dependent.value.card.cardId,
      expectedRevision: 1,
      target: { kind: "native", workerId: "worker:one" },
    });
    expect(premature.error).toBe(true);
    expect(premature.value).toContain("dependency_not_accepted");
    expect(f.mutations).toHaveLength(0);
    await f.board({
      op: "dispatch",
      cardId,
      expectedRevision: 1,
      target: { kind: "native", workerId: "worker:one" },
    });
    await until(async () => (await f.inspect(cardId)).card.state === "waiting");
    const before = (await f.inspect(cardId)).card;
    const paused = await f.board<{ card: Goal }>({
      op: "control",
      cardId,
      expectedRevision: before.revision,
      action: "pause",
    });
    expect(paused.value.card).toMatchObject({
      state: "waiting",
      control: "pause",
    });
    const cancelled = await f.board<{ card: Goal }>({
      op: "control",
      cardId,
      expectedRevision: paused.value.card.revision,
      action: "cancel",
    });
    expect(cancelled.value.card.nextStep).toContain(
      "does NOT stop a Rex process",
    );
    await f.tick();
    await until(
      async () => (await f.inspect(cardId)).card.state === "uncertain",
    );
    const uncertain = (await f.inspect(cardId)).card;
    expect((await worker.getWorkerMailbox()).messages).toHaveLength(1);
    expect(
      (
        await f.board({
          op: "control",
          cardId,
          expectedRevision: uncertain.revision,
          action: "resume",
        })
      ).error,
    ).toBe(true);
    const message = (await worker.getWorkerMailbox()).messages[0]!;
    const assignment = JSON.parse(message.text) as {
      report: { itemId: string };
    };
    await worker.postWorkerItem({
      itemId: assignment.report.itemId,
      kind: "report",
      title: "Completed after cancellation request",
      text: "Work completed. No process-stop operation was delivered.",
      blocking: false,
    });
    const reconciled = await f.board<{ card: Goal }>({
      op: "reconcile",
      cardId,
      expectedRevision: uncertain.revision,
    });
    expect(reconciled.error).toBe(false);
    expect(reconciled.value.card.attempt?.requestId).toBe(
      before.attempt?.requestId,
    );
    await until(async () => (await f.inspect(cardId)).card.state === "review");
    expect(f.mutations).toEqual([message.messageId]);
    expect((await f.inspect(cardId)).card.attempts).toHaveLength(2);
    const reviewed = (await f.inspect(cardId)).card;
    await f.client.decideCoordinationItem(assignment.report.itemId, {
      requestId: "review:escalate",
      action: "escalate",
      text: "Owner must approve this acceptance.",
    });
    const bypass = await f.board<string>({
      op: "accept",
      cardId,
      expectedRevision: reviewed.revision,
      review: [
        {
          criterion: brief.acceptance[0]!,
          evidence: `coordination:${assignment.report.itemId}`,
          note: "Cannot bypass the owner decision.",
        },
      ],
    });
    expect(bypass.error).toBe(true);
    expect(bypass.value).toContain("coordination_decision_required");
    await f.ownerClient.decideCoordinationItem(assignment.report.itemId, {
      requestId: "review:owner-answer",
      action: "answer",
      text: "Approve after reviewing the reported evidence.",
    });
    await f.board({
      op: "accept",
      cardId,
      expectedRevision: reviewed.revision,
      review: [
        {
          criterion: brief.acceptance[0]!,
          evidence: `coordination:${assignment.report.itemId}`,
          note: "Inspected the reported outcome without replaying it.",
        },
      ],
    });
    const dispatchDependent = await f.board({
      op: "dispatch",
      cardId: dependent.value.card.cardId,
      expectedRevision: 1,
      target: { kind: "native", workerId: "worker:one" },
    });
    expect(dispatchDependent.error).toBe(false);
  } finally {
    await f.close();
  }
}, 20_000);
