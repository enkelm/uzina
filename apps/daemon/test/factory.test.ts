import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FactoryError,
  FactoryService,
  createFactoryHttpHandler,
} from "@uzina/core";
import {
  executionJobReportSchema,
  executionRegisterRequestSchema,
} from "@uzina/contracts/execution";
import { BunFactoryDatabase } from "../src/factory/sqlite";

const bootstrapSecret = "fixture-only-private-bootstrap-secret";
const fixtures: Array<{ directory: string; database: BunFactoryDatabase }> = [];

function openDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "uzina-factory-test-"));
  const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
  fixtures.push({ directory, database });
  return { directory, database };
}

function registration(nodeId: string, workspaceId: string) {
  return executionRegisterRequestSchema.parse({
    contractVersion: 1,
    nodeId,
    daemonVersion: "test",
    workspaces: [{ workspaceId, ownershipGeneration: 0, state: "active" }],
    capabilities: {
      fileRead: true,
      fileWrite: true,
      argvCommand: true,
      rexProcessCreate: true,
      rexProcessInspect: true,
      rexProcessStop: true,
    },
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

async function provisionFixture(nodeOnline: boolean) {
  const { directory, database } = openDatabase();
  const factory = new FactoryService(database, bootstrapSecret);
  await expect(
    factory.bootstrap("wrong-bootstrap-secret", "Owner"),
  ).rejects.toMatchObject({ status: 401 });
  const ownerCredential = await factory.bootstrap(bootstrapSecret, "Owner");
  await expect(
    factory.bootstrap(bootstrapSecret, "Second owner"),
  ).rejects.toMatchObject({ status: 409, code: "already_bootstrapped" });
  const owner = await factory.authenticate(ownerCredential.credential);
  const project = factory.createProject(owner, "project:alpha", "Alpha");
  const { node, credential: nodeCredential } = await factory.provisionNode(
    owner,
    "node:laptop-a",
    "Laptop A",
  );
  const nodeSession = await factory.authenticate(nodeCredential.credential);
  const workspace = factory.createWorkspace(
    owner,
    "workspace:repo",
    node.nodeId,
    "Repository",
  );
  const thread = factory.createThread(owner, {
    threadId: "thread:alpha",
    projectId: project.projectId,
    title: "First thread",
    target: { nodeId: node.nodeId, workspaceId: workspace.workspaceId },
  });
  if (nodeOnline) {
    factory.registerExecutionNode(
      nodeSession,
      registration(node.nodeId, workspace.workspaceId),
    );
  }
  return {
    directory,
    database,
    factory,
    owner,
    ownerCredential,
    nodeSession,
    nodeCredential,
    thread,
  };
}

describe("persistent Factory behavior over Bun SQLite", () => {
  test("a lost acceptance reply deduplicates after reopen and keeps committed cursor events", async () => {
    const fixture = await provisionFixture(false);
    await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:lost-reply",
      "Inspect the selected workspace",
    ); // The client deliberately drops this acknowledgement before restart.

    const storedHashes = fixture.database
      .all<{ token_hash: string }>("SELECT token_hash FROM credentials")
      .map((row) => row.token_hash);
    expect(storedHashes).not.toContain(fixture.ownerCredential.credential);
    expect(storedHashes).not.toContain(fixture.nodeCredential.credential);

    fixture.database.close();
    const reopenedDatabase = new BunFactoryDatabase(
      join(fixture.directory, "factory.sqlite"),
    );
    fixtures[fixtures.length - 1]!.database = reopenedDatabase;
    const reopened = new FactoryService(reopenedDatabase, bootstrapSecret);
    const owner = await reopened.authenticate(
      fixture.ownerCredential.credential,
    );
    const retry = await reopened.submitInput(
      owner,
      fixture.thread.threadId,
      "request:lost-reply",
      "Inspect the selected workspace",
    );
    expect(retry).toMatchObject({
      status: "accepted",
      dispatchStatus: "unavailable",
      ownershipGeneration: 0,
    });
    expect(
      reopenedDatabase.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM dispatch_intents WHERE request_id = ?",
        ["request:lost-reply"],
      )[0]?.count,
    ).toBe(1);

    await expect(
      reopened.submitInput(
        owner,
        fixture.thread.threadId,
        "request:lost-reply",
        "Different payload",
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "request_id_conflict",
    });
    const eventPage = reopened.events(owner, 0);
    const requestEvents = eventPage.events.filter(
      (event) => event.requestId === "request:lost-reply",
    );
    expect(requestEvents.map((event) => event.type)).toEqual([
      "command.accepted",
      "dispatch.unavailable",
    ]);
    expect(requestEvents[0]!.cursor).toBeLessThan(requestEvents[1]!.cursor);
    expect(eventPage.nextCursor).toBeGreaterThan(0);
    expect(requestEvents[0]!.payload.jobId).toBe(retry.jobId);
    expect(reopened.getReceipt(owner, "request:lost-reply").jobId).toBe(
      retry.jobId,
    );
    expect(reopened.listNodes(owner)[0]).toMatchObject({
      availability: "offline",
      nodeId: "node:laptop-a",
    });
  });

  test("credential kind, actor attribution, and revocation gate later operations", async () => {
    const fixture = await provisionFixture(true);
    const assistantCredential = await fixture.factory.provisionCredential(
      fixture.owner,
      "assistant",
      "Factory assistant",
    );
    const assistant = await fixture.factory.authenticate(
      assistantCredential.credential,
    );
    expect(assistant.actor.kind).toBe("assistant");
    expect(
      fixture.factory
        .listCredentials(fixture.owner)
        .some(
          (credential) =>
            credential.name === "Factory assistant" &&
            credential.actor.kind === "assistant",
        ),
    ).toBe(true);
    expect(fixture.factory.listProjects(assistant)).toHaveLength(1);
    expect(() =>
      fixture.factory.createProject(assistant, undefined, "Forbidden project"),
    ).toThrow(FactoryError);
    expect(() =>
      fixture.factory.registerExecutionNode(
        assistant,
        registration("node:laptop-a", "workspace:repo"),
      ),
    ).toThrow();
    expect(() =>
      fixture.factory.listProjects({
        credentialId: fixture.nodeSession.credentialId,
        actor: fixture.owner.actor,
      }),
    ).toThrow(FactoryError);

    const receipt = await fixture.factory.submitInput(
      assistant,
      fixture.thread.threadId,
      "request:assistant",
      "Run the assigned work",
    );
    expect(receipt.dispatchStatus).toBe("queued");
    const acceptedEvent = fixture.factory
      .events(fixture.owner, 0)
      .events.find((event) => event.requestId === "request:assistant");
    expect(acceptedEvent?.actor).toEqual(assistant.actor);

    const handler = createFactoryHttpHandler(fixture.factory);
    const unauthorized = await handler(
      new Request("https://factory.test/v1/projects"),
    );
    expect(unauthorized.status).toBe(401);
    const bodyActorIsRejected = await handler(
      new Request(
        `https://factory.test/v1/threads/${fixture.thread.threadId}/inputs`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${assistantCredential.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: "request:forged-actor",
            text: "No body-selected actor",
            actor: { kind: "human" },
          }),
        },
      ),
    );
    expect(bodyActorIsRejected.status).toBe(400);
    expect(
      fixture.factory
        .events(fixture.owner, 0)
        .events.some((event) => event.requestId === "request:forged-actor"),
    ).toBe(false);

    await expect(
      fixture.factory.revokeCredential(
        assistant,
        assistantCredential.credentialId,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await fixture.factory.revokeCredential(
      fixture.owner,
      assistantCredential.credentialId,
    );
    await expect(
      fixture.factory.authenticate(assistantCredential.credential),
    ).rejects.toMatchObject({ status: 401 });
    const wrongKind = await handler(
      new Request("https://factory.test/v1/projects", {
        headers: {
          authorization: `Bearer ${fixture.nodeCredential.credential}`,
        },
      }),
    );
    expect(wrongKind.status).toBe(403);

    const secondaryHuman = await fixture.factory.provisionCredential(
      fixture.owner,
      "human",
      "Owner laptop",
    );
    expect(
      (await fixture.factory.authenticate(secondaryHuman.credential)).actor,
    ).toEqual(fixture.owner.actor);
    await fixture.factory.revokeCredential(
      fixture.owner,
      secondaryHuman.credentialId,
    );
    await expect(
      fixture.factory.authenticate(secondaryHuman.credential),
    ).rejects.toMatchObject({ status: 401 });
    await fixture.factory.revokeCredential(
      fixture.owner,
      fixture.nodeCredential.credentialId,
    );
    const revokedNode = await handler(
      new Request("https://factory.test/v1/nodes/node:laptop-a/heartbeat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.nodeCredential.credential}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(revokedNode.status).toBe(401);
  });

  test("a downgraded guest cannot dispatch a previously queued input or admit later Pi execution", async () => {
    const fixture = await provisionFixture(true);
    const invite = await fixture.factory.createInvitation(fixture.owner, {
      role: "guest",
      grants: [{ type: "thread", resourceId: fixture.thread.threadId }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const redemption = await fixture.factory.redeemInvitation(
      invite.code,
      "Revoked before dispatch",
    );
    const guest = await fixture.factory.authenticate(redemption.credential);
    const accepted = await fixture.factory.submitInput(
      guest,
      fixture.thread.threadId,
      "request:guest-revoked-before-dispatch",
      "The guest was initially permitted to steer this thread",
    );
    expect(accepted.dispatchStatus).toBe("queued");

    fixture.factory.setParticipantAccess(
      fixture.owner,
      redemption.participant.userId,
      "viewer",
      [{ type: "thread", resourceId: fixture.thread.threadId }],
    );
    let externalDispatchCalled = false;
    const settled = await fixture.factory.dispatchNext({
      async dispatch() {
        externalDispatchCalled = true;
        return { status: "dispatched" };
      },
    });
    expect(externalDispatchCalled).toBe(false);
    expect(settled).toMatchObject({
      requestId: accepted.requestId,
      dispatchStatus: "failed",
      outcome: "The actor no longer has permission to steer this thread",
    });
    expect(
      fixture.factory.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM execution_jobs WHERE request_id = ?",
        [accepted.requestId],
      )[0]?.count,
    ).toBe(0);

    const secondInvite = await fixture.factory.createInvitation(fixture.owner, {
      role: "guest",
      grants: [{ type: "thread", resourceId: fixture.thread.threadId }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const secondRedemption = await fixture.factory.redeemInvitation(
      secondInvite.code,
      "Revoked during Pi work",
    );
    const secondGuest = await fixture.factory.authenticate(
      secondRedemption.credential,
    );
    const secondAccepted = await fixture.factory.submitInput(
      secondGuest,
      fixture.thread.threadId,
      "request:guest-revoked-during-pi",
      "A later Pi tool must be denied after downgrade",
    );
    await fixture.factory.dispatchNext({
      async dispatch(input) {
        fixture.factory.setParticipantAccess(
          fixture.owner,
          secondRedemption.participant.userId,
          "viewer",
          [{ type: "thread", resourceId: fixture.thread.threadId }],
        );
        await expect(
          fixture.factory.enqueueManagedRemoteExecution(
            input.threadId,
            "task:guest-revoked-during-pi",
            "call:guest-revoked-during-pi",
            {
              operation: "write-file",
              path: "must-not-run.txt",
              contentBase64: Buffer.from("no effect").toString("base64"),
            },
          ),
        ).rejects.toMatchObject({ status: 403, code: "forbidden" });
        return {
          status: "failed",
          detail: "Access changed before tool admission",
        };
      },
    });
    expect(
      fixture.factory.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM execution_jobs WHERE request_id = ?",
        [secondAccepted.requestId],
      )[0]?.count,
    ).toBe(0);
  });

  test("managed inputs remain in their runtime queue and are never exposed as node execution jobs", async () => {
    const fixture = await provisionFixture(true);
    const accepted = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:managed-input",
      "Run this in the managed conversation",
    );
    let dispatchedInput: unknown;
    const dispatched = await fixture.factory.dispatchNext({
      async dispatch(job) {
        dispatchedInput = job.input;
        return { status: "dispatched", detail: "runtime accepted submission" };
      },
    });

    expect(dispatched?.jobId).toBe(accepted.jobId);
    expect(dispatched?.dispatchStatus).toBe("dispatched");
    expect(dispatchedInput).toEqual({
      kind: "managed-input",
      text: "Run this in the managed conversation",
    });
    expect(
      fixture.factory.claimExecutionJob(fixture.nodeSession, "node:laptop-a"),
    ).toBeNull();
  });

  test("an unexpected managed-input drain failure settles accepted queued and active intents", async () => {
    const fixture = await provisionFixture(true);
    const queued = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:drain-failure-queued",
      "Keep this accepted input visible",
    );
    fixture.factory.failManagedDispatchDrain("Standalone drain failed");
    expect(
      fixture.factory.getReceipt(fixture.owner, queued.requestId),
    ).toMatchObject({
      jobId: queued.jobId,
      dispatchStatus: "failed",
      outcome: "Standalone drain failed",
    });

    const active = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:drain-failure-active",
      "Do not replay this active input",
    );
    let enteredDispatch!: () => void;
    let finishDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => {
      enteredDispatch = resolve;
    });
    const dispatchCanFinish = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    const dispatch = fixture.factory.dispatchNext({
      async dispatch() {
        enteredDispatch();
        await dispatchCanFinish;
        return { status: "completed" };
      },
    });
    await dispatchEntered;
    fixture.factory.failManagedDispatchDrain(
      "Active drain outcome is uncertain",
    );
    expect(
      fixture.factory.getReceipt(fixture.owner, active.requestId),
    ).toMatchObject({
      jobId: active.jobId,
      dispatchStatus: "uncertain",
      outcome: "Active drain outcome is uncertain",
    });
    finishDispatch();
    await dispatch;
    expect(
      fixture.factory.getReceipt(fixture.owner, active.requestId)
        .dispatchStatus,
    ).toBe("uncertain");
  });

  test("an expired queued managed effect is fenced before the node can claim it", async () => {
    const fixture = await provisionFixture(true);
    const accepted = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:effect-wait-expired-queued",
      "Write a bounded effect",
    );
    const operation = {
      operation: "write-file" as const,
      path: "expired-effect.txt",
      contentBase64: Buffer.from("must not run").toString("base64"),
    };
    const result = await fixture.factory.dispatchNext({
      async dispatch(input) {
        const admitted = await fixture.factory.enqueueManagedRemoteExecution(
          input.threadId,
          "task:wait-expired-queued",
          "call:wait-expired-queued",
          operation,
        );
        expect(admitted.status).toBe("queued");
        fixture.factory.markManagedEffectUncertain(
          admitted.jobId,
          "The tool stopped waiting before an executor claim",
        );
        return { status: "uncertain", detail: "Managed work timed out" };
      },
    });

    expect(result?.dispatchStatus).toBe("uncertain");
    expect(result?.executionEffects).toMatchObject([
      {
        status: "failed",
        errorCode: "managed_effect_abandoned_before_claim",
      },
    ]);
    expect(
      fixture.factory.claimExecutionJob(fixture.nodeSession, "node:laptop-a"),
    ).toBeNull();
    expect(
      fixture.factory.getReceipt(fixture.owner, accepted.requestId)
        .dispatchStatus,
    ).toBe("uncertain");
  });

  test("an expired claimed effect is not reclaimed but one late correlated report reconciles its receipt", async () => {
    const fixture = await provisionFixture(true);
    const accepted = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:effect-wait-expired-claimed",
      "Write a bounded effect",
    );
    const operation = {
      operation: "write-file" as const,
      path: "claimed-effect.txt",
      contentBase64: Buffer.from(
        "completed by the original assignment",
      ).toString("base64"),
    };
    let claimed:
      | {
          jobId: string;
          nodeId: string;
          target: { nodeId: string; workspaceId: string };
          ownershipGeneration: number;
          payloadSha256: string;
        }
      | undefined;
    const result = await fixture.factory.dispatchNext({
      async dispatch(input) {
        const admitted = await fixture.factory.enqueueManagedRemoteExecution(
          input.threadId,
          "task:wait-expired-claimed",
          "call:wait-expired-claimed",
          operation,
        );
        const assignment = fixture.factory.claimExecutionJob(
          fixture.nodeSession,
          "node:laptop-a",
        );
        claimed = assignment
          ? { ...assignment, payloadSha256: admitted.payloadSha256 }
          : undefined;
        expect(claimed?.jobId).toBe(admitted.jobId);
        fixture.factory.markManagedEffectUncertain(
          admitted.jobId,
          "The tool stopped waiting after executor assignment",
        );
        expect(
          fixture.factory.claimExecutionJob(
            fixture.nodeSession,
            "node:laptop-a",
          ),
        ).toBeNull();
        return { status: "uncertain", detail: "Managed work timed out" };
      },
    });

    expect(result?.dispatchStatus).toBe("uncertain");
    expect(result?.executionEffects).toMatchObject([
      { status: "uncertain", errorCode: "managed_tool_wait_expired" },
    ]);
    const lateReport = executionJobReportSchema.parse({
      contractVersion: 1,
      jobId: claimed!.jobId,
      nodeId: claimed!.nodeId,
      target: claimed!.target,
      ownershipGeneration: claimed!.ownershipGeneration,
      status: "completed",
      payloadSha256: claimed!.payloadSha256,
      finishedAt: new Date().toISOString(),
      result: {
        operation: "write-file",
        bytes: Buffer.from("completed by the original assignment").byteLength,
        sha256: "a".repeat(64),
      },
    });
    await fixture.factory.reportExecutionJob(
      fixture.nodeSession,
      "node:laptop-a",
      claimed!.jobId,
      lateReport,
    );
    const reconciled = fixture.factory.getReceipt(
      fixture.owner,
      accepted.requestId,
    );
    expect(reconciled.dispatchStatus).toBe("uncertain");
    expect(reconciled.executionEffects).toMatchObject([
      {
        jobId: claimed!.jobId,
        status: "completed",
        operation: "write-file",
      },
    ]);
    expect(
      fixture.factory.claimExecutionJob(fixture.nodeSession, "node:laptop-a"),
    ).toBeNull();
  });

  test("controller reopen cancels a queued Pi effect before another node claim", async () => {
    const fixture = await provisionFixture(true);
    const accepted = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:restart-fences-effect",
      "Perform one managed write",
    );
    let enteredDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => {
      enteredDispatch = resolve;
    });
    let admitted:
      | Awaited<ReturnType<FactoryService["enqueueManagedRemoteExecution"]>>
      | undefined;
    void fixture.factory.dispatchNext({
      async dispatch(input) {
        admitted = await fixture.factory.enqueueManagedRemoteExecution(
          input.threadId,
          "task:restart-fences-effect",
          "call:restart-fences-effect",
          {
            operation: "write-file",
            path: "restart-effect.txt",
            contentBase64: Buffer.from("must not replay").toString("base64"),
          },
        );
        enteredDispatch();
        return new Promise(() => {});
      },
    });
    await dispatchEntered;
    expect(admitted?.status).toBe("queued");

    fixture.database.close();
    const reopenedDatabase = new BunFactoryDatabase(
      join(fixture.directory, "factory.sqlite"),
    );
    fixtures[fixtures.length - 1]!.database = reopenedDatabase;
    const reopened = new FactoryService(reopenedDatabase, bootstrapSecret);
    const owner = await reopened.authenticate(
      fixture.ownerCredential.credential,
    );
    const node = await reopened.authenticate(fixture.nodeCredential.credential);
    const recovered = reopened.getReceipt(owner, accepted.requestId);
    expect(recovered.dispatchStatus).toBe("uncertain");
    expect(recovered.executionEffects).toMatchObject([
      {
        jobId: admitted!.jobId,
        status: "failed",
        errorCode: "managed_input_interrupted_before_claim",
      },
    ]);
    expect(reopened.claimExecutionJob(node, "node:laptop-a")).toBeNull();
    const retry = await reopened.submitInput(
      owner,
      fixture.thread.threadId,
      accepted.requestId,
      "Perform one managed write",
    );
    expect(retry).toMatchObject({
      jobId: accepted.jobId,
      dispatchStatus: "uncertain",
    });
    expect(retry.executionEffects).toMatchObject([
      { jobId: admitted!.jobId, status: "failed" },
    ]);
  });

  test("controller reopen fences a claimed Pi effect from redelivery", async () => {
    const fixture = await provisionFixture(true);
    const accepted = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:restart-fences-claimed-effect",
      "Perform one managed write",
    );
    let enteredDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => {
      enteredDispatch = resolve;
    });
    let admitted:
      | Awaited<ReturnType<FactoryService["enqueueManagedRemoteExecution"]>>
      | undefined;
    let claimed:
      | {
          jobId: string;
          nodeId: string;
          target: { nodeId: string; workspaceId: string };
          ownershipGeneration: number;
        }
      | undefined;
    void fixture.factory.dispatchNext({
      async dispatch(input) {
        admitted = await fixture.factory.enqueueManagedRemoteExecution(
          input.threadId,
          "task:restart-fences-claimed-effect",
          "call:restart-fences-claimed-effect",
          {
            operation: "write-file",
            path: "restart-claimed-effect.txt",
            contentBase64: Buffer.from("may have started").toString("base64"),
          },
        );
        claimed = fixture.factory.claimExecutionJob(
          fixture.nodeSession,
          "node:laptop-a",
        )!;
        enteredDispatch();
        return new Promise(() => {});
      },
    });
    await dispatchEntered;
    expect(claimed?.jobId).toBe(admitted?.jobId);

    fixture.database.close();
    const reopenedDatabase = new BunFactoryDatabase(
      join(fixture.directory, "factory.sqlite"),
    );
    fixtures[fixtures.length - 1]!.database = reopenedDatabase;
    const reopened = new FactoryService(reopenedDatabase, bootstrapSecret);
    const owner = await reopened.authenticate(
      fixture.ownerCredential.credential,
    );
    const node = await reopened.authenticate(fixture.nodeCredential.credential);
    const recovered = reopened.getReceipt(owner, accepted.requestId);
    expect(recovered.dispatchStatus).toBe("uncertain");
    expect(recovered.executionEffects).toMatchObject([
      {
        jobId: claimed!.jobId,
        status: "uncertain",
        errorCode: "managed_input_interrupted_after_claim",
      },
    ]);
    expect(reopened.claimExecutionJob(node, "node:laptop-a")).toBeNull();
  });

  test("interrupted managed-runtime dispatch is uncertain after reopen and is not converted into a node job", async () => {
    const fixture = await provisionFixture(true);
    const accepted = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:uncertain",
      "Perform a managed runtime effect",
    );
    let enteredDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => {
      enteredDispatch = resolve;
    });
    void fixture.factory.dispatchNext({
      dispatch: () =>
        new Promise(() => {
          enteredDispatch();
        }),
    });
    await dispatchEntered;
    expect(
      fixture.factory.getReceipt(fixture.owner, accepted.requestId)
        .dispatchStatus,
    ).toBe("running");

    fixture.database.close();
    const reopenedDatabase = new BunFactoryDatabase(
      join(fixture.directory, "factory.sqlite"),
    );
    fixtures[fixtures.length - 1]!.database = reopenedDatabase;
    const reopened = new FactoryService(reopenedDatabase, bootstrapSecret);
    const owner = await reopened.authenticate(
      fixture.ownerCredential.credential,
    );
    const node = await reopened.authenticate(fixture.nodeCredential.credential);
    expect(reopened.getReceipt(owner, accepted.requestId).dispatchStatus).toBe(
      "uncertain",
    );
    expect(reopened.claimExecutionJob(node, "node:laptop-a")).toBeNull();
    expect(
      reopened
        .events(owner, 0)
        .events.some(
          (event) =>
            event.type === "dispatch.uncertain" &&
            event.requestId === accepted.requestId,
        ),
    ).toBe(true);
  });
});
