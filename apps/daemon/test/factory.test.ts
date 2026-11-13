import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FactoryError,
  FactoryService,
  createFactoryHttpHandler,
} from "@uzina/core";
import { executionRegisterRequestSchema } from "@uzina/contracts/execution";
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
