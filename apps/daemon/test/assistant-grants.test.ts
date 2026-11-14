import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryError, FactoryService } from "@uzina/core";
import { createFactoryHttpHandler } from "@uzina/core/http";
import { BunFactoryDatabase } from "../src/factory/sqlite";

const fixtures: Array<{ directory: string; database: BunFactoryDatabase }> = [];

function openDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "uzina-assistant-grants-"));
  const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
  fixtures.push({ directory, database });
  return { directory, database };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const { directory, database } = openDatabase();
  const factory = new FactoryService(database, "assistant-grants-bootstrap");
  const ownerCredential = await factory.bootstrap(
    "assistant-grants-bootstrap",
    "Owner",
  );
  const owner = await factory.authenticate(ownerCredential.credential);
  const projectA = factory.createProject(owner, "project:grant-a", "A");
  const projectB = factory.createProject(owner, "project:grant-b", "B");
  const { node } = await factory.provisionNode(
    owner,
    "node:grant-test",
    "Grant test node",
  );
  const workspaceA = factory.createWorkspace(
    owner,
    "workspace:grant-a",
    node.nodeId,
    "A workspace",
  );
  const workspaceB = factory.createWorkspace(
    owner,
    "workspace:grant-b",
    node.nodeId,
    "B workspace",
  );
  const threadA = factory.createThread(owner, {
    threadId: "thread:grant-a",
    projectId: projectA.projectId,
    title: "A thread",
    target: { nodeId: node.nodeId, workspaceId: workspaceA.workspaceId },
  });
  const privateThread = factory.createThread(owner, {
    threadId: "thread:grant-private",
    projectId: projectA.projectId,
    title: "Owner private thread",
    ownerPrivate: true,
    target: { nodeId: node.nodeId, workspaceId: workspaceA.workspaceId },
  });
  const threadB = factory.createThread(owner, {
    threadId: "thread:grant-b",
    projectId: projectB.projectId,
    title: "B thread",
    target: { nodeId: node.nodeId, workspaceId: workspaceB.workspaceId },
  });
  database.exec(
    "UPDATE nodes SET availability = 'online', last_seen_at = ? WHERE node_id = ?",
    [new Date().toISOString(), node.nodeId],
  );
  return {
    directory,
    database,
    factory,
    owner,
    ownerCredential,
    projectA,
    projectB,
    threadA,
    privateThread,
    threadB,
    workspaceA,
    workspaceB,
  };
}

describe("owner-administered assistant credential grants", () => {
  test("strict project scopes govern shared Core reads, steering, events, and private threads", async () => {
    const fixture = await createFixture();
    const credential = await fixture.factory.provisionCredential(
      fixture.owner,
      "assistant",
      "Scoped assistant",
      [{ type: "project", resourceId: fixture.projectA.projectId }],
    );
    const assistant = await fixture.factory.authenticate(credential.credential);
    expect(credential.actor).toMatchObject({
      kind: "assistant",
      ownerId: "user:owner",
    });
    expect(
      fixture.factory
        .listProjects(assistant)
        .map((project) => project.projectId),
    ).toEqual([fixture.projectA.projectId]);
    expect(
      fixture.factory.listThreads(assistant).map((thread) => thread.threadId),
    ).toEqual([fixture.threadA.threadId]);
    expect(fixture.factory.listNodes(assistant)).toHaveLength(1);
    expect(
      fixture.factory
        .listWorkspaces(assistant)
        .map((workspace) => workspace.workspaceId),
    ).toEqual([fixture.workspaceA.workspaceId]);
    expect(() =>
      fixture.factory.getAuthorizedThread(
        assistant,
        fixture.privateThread.threadId,
      ),
    ).toThrow(expect.objectContaining({ status: 404 }));
    expect(() =>
      fixture.factory.createProject(assistant, undefined, "No admin"),
    ).toThrow(FactoryError);
    expect(() =>
      fixture.factory.setAssistantCredentialGrants(
        assistant,
        credential.credentialId,
        [],
      ),
    ).toThrow(FactoryError);
    const accepted = await fixture.factory.submitInput(
      assistant,
      fixture.threadA.threadId,
      "request:scoped-assistant",
      "Inspect permitted project A",
    );
    expect(accepted.status).toBe("accepted");
    expect(accepted.dispatchStatus).toBe("queued");
    expect(accepted.requestId).toBe("request:scoped-assistant");
    expect(
      fixture.factory
        .events(assistant, 0)
        .events.every(
          (event) =>
            event.projectId === fixture.projectA.projectId ||
            event.threadId === fixture.threadA.threadId,
        ),
    ).toBe(true);

    const deniedHumanGrant = fixture.factory.provisionCredential(
      fixture.owner,
      "human",
      "Human",
      [{ type: "factory" }],
    );
    await expect(deniedHumanGrant).rejects.toThrow();
  });

  test("owner-only HTTP grant replacement changes REST scope immediately", async () => {
    const fixture = await createFixture();
    const credential = await fixture.factory.provisionCredential(
      fixture.owner,
      "assistant",
      "HTTP-scoped assistant",
      [{ type: "project", resourceId: fixture.projectA.projectId }],
    );
    const handler = createFactoryHttpHandler(fixture.factory);
    const grantUrl = `http://factory.test/v1/credentials/${credential.credentialId}/grants`;
    const response = await handler(
      new Request(grantUrl, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${fixture.ownerCredential.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grants: [{ type: "thread", resourceId: fixture.threadB.threadId }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      contractVersion: 1,
      credentialId: credential.credentialId,
      assistantGrants: [
        { type: "thread", resourceId: fixture.threadB.threadId },
      ],
    });

    const assistantResponse = await handler(
      new Request("http://factory.test/v1/projects", {
        headers: { authorization: `Bearer ${credential.credential}` },
      }),
    );
    expect(assistantResponse.status).toBe(200);
    expect(await assistantResponse.json()).toMatchObject({
      projects: [{ projectId: fixture.projectB.projectId }],
    });
    const denied = await handler(
      new Request(grantUrl, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${credential.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ grants: [] }),
      }),
    );
    expect(denied.status).toBe(403);
  });

  test("owner grant changes apply immediately and fence queued effects before runtime dispatch", async () => {
    const fixture = await createFixture();
    const credential = await fixture.factory.provisionCredential(
      fixture.owner,
      "assistant",
      "Replaceable assistant",
      [{ type: "project", resourceId: fixture.projectA.projectId }],
    );
    const assistant = await fixture.factory.authenticate(credential.credential);
    const accepted = await fixture.factory.submitInput(
      assistant,
      fixture.threadA.threadId,
      "request:grant-revoked-before-dispatch",
      "This must not be dispatched after grant removal",
    );
    expect(accepted.dispatchStatus).toBe("queued");

    const changed = fixture.factory.setAssistantCredentialGrants(
      fixture.owner,
      credential.credentialId,
      [{ type: "thread", resourceId: fixture.threadB.threadId }],
    );
    expect(changed.assistantGrants).toEqual([
      { type: "thread", resourceId: fixture.threadB.threadId },
    ]);
    expect(
      fixture.factory
        .listProjects(assistant)
        .map((project) => project.projectId),
    ).toEqual([fixture.projectB.projectId]);
    expect(
      fixture.factory.listThreads(assistant).map((thread) => thread.threadId),
    ).toEqual([fixture.threadB.threadId]);
    expect(() =>
      fixture.factory.getReceipt(assistant, accepted.requestId),
    ).toThrow(expect.objectContaining({ status: 404 }));

    let dispatched = false;
    const settled = await fixture.factory.dispatchNext({
      async dispatch() {
        dispatched = true;
        return { status: "completed" };
      },
    });
    expect(dispatched).toBe(false);
    expect(settled?.dispatchStatus).toBe("failed");
    expect(
      fixture.factory.getReceipt(fixture.owner, accepted.requestId)
        .dispatchStatus,
    ).toBe("failed");
    await fixture.factory.revokeCredential(
      fixture.owner,
      credential.credentialId,
    );
    await expect(
      fixture.factory.authenticate(credential.credential),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  test("an explicitly empty scope remains empty across database initialization", async () => {
    const fixture = await createFixture();
    const credential = await fixture.factory.provisionCredential(
      fixture.owner,
      "assistant",
      "No-access assistant",
      [],
    );
    const assistant = await fixture.factory.authenticate(credential.credential);
    expect(fixture.factory.listProjects(assistant)).toEqual([]);
    fixture.database.close();

    const reopened = new BunFactoryDatabase(
      join(fixture.directory, "factory.sqlite"),
    );
    fixtures[fixtures.length - 1]!.database = reopened;
    const factory = new FactoryService(reopened, "assistant-grants-bootstrap");
    const reopenedAssistant = await factory.authenticate(credential.credential);
    expect(factory.listProjects(reopenedAssistant)).toEqual([]);
    expect(
      reopened.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM assistant_credential_grants WHERE credential_id = ?",
        [credential.credentialId],
      )[0]?.count,
    ).toBe(0);
  });

  test("legacy grantless assistant credentials migrate to an explicit factory-wide grant", async () => {
    const fixture = await createFixture();
    const credential = await fixture.factory.provisionCredential(
      fixture.owner,
      "assistant",
      "Legacy assistant",
    );
    expect(credential.assistantGrants).toEqual([{ type: "factory" }]);
    fixture.database.exec(
      "DELETE FROM assistant_credential_grants WHERE credential_id = ?",
      [credential.credentialId],
    );
    fixture.database.exec("DROP TABLE assistant_credential_grants");
    fixture.database.exec(
      "ALTER TABLE credentials DROP COLUMN assistant_scope_initialized",
    );
    fixture.database.close();

    const reopened = new BunFactoryDatabase(
      join(fixture.directory, "factory.sqlite"),
    );
    fixtures[fixtures.length - 1]!.database = reopened;
    const factory = new FactoryService(reopened, "assistant-grants-bootstrap");
    const assistant = await factory.authenticate(credential.credential);
    expect(factory.listProjects(assistant)).toHaveLength(2);
    expect(
      factory.getAuthorizedThread(assistant, fixture.privateThread.threadId)
        .ownerPrivate,
    ).toBe(true);
    expect(
      reopened.all<{ resource_type: string; resource_id: string }>(
        "SELECT resource_type, resource_id FROM assistant_credential_grants WHERE credential_id = ?",
        [credential.credentialId],
      ),
    ).toEqual([{ resource_type: "factory", resource_id: "factory" }]);
  });
});
