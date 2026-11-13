import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryService, createFactoryHttpHandler } from "@uzina/core";
import { BunFactoryDatabase } from "../src/factory/sqlite";

type LocalHost = {
  directory: string;
  database: BunFactoryDatabase;
  factory: FactoryService;
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  close(): void;
};

const bootstrapSecret = "local-scoped-access-private-bootstrap";
const hosts: LocalHost[] = [];
const extraDirectories: string[] = [];

function openHost(
  directory = mkdtempSync(join(tmpdir(), "uzina-access-test-")),
): LocalHost {
  const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
  const factory = new FactoryService(database, bootstrapSecret);
  const handler = createFactoryHttpHandler(factory, {
    async context(threadId) {
      return {
        threadId,
        messages: [
          { role: "assistant", text: "owner-private assistant context" },
        ],
      };
    },
    async status(threadId) {
      return { threadId, status: "not-created" };
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  let closed = false;
  const host: LocalHost = {
    directory,
    database,
    factory,
    server,
    baseUrl: server.url.toString(),
    close() {
      if (closed) return;
      closed = true;
      server.stop(true);
      database.close();
    },
  };
  hosts.push(host);
  return host;
}

async function call<T = Record<string, unknown>>(
  host: LocalHost,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT";
    credential?: string;
    bootstrap?: boolean;
    body?: unknown;
  } = {},
): Promise<{ status: number; value: T }> {
  const response = await fetch(new URL(path, host.baseUrl), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.credential
        ? {
            authorization: `${options.bootstrap ? "Bootstrap" : "Bearer"} ${options.credential}`,
          }
        : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, value: (await response.json()) as T };
}

async function createFixture() {
  const host = openHost();
  const bootstrapped = await call<{ credential: string }>(
    host,
    "/v1/bootstrap",
    {
      credential: bootstrapSecret,
      bootstrap: true,
      body: { name: "Factory owner" },
    },
  );
  const owner = bootstrapped.value.credential;
  const projectA = await call<{ projectId: string }>(host, "/v1/projects", {
    credential: owner,
    body: { projectId: "project:scoped", name: "Scoped project" },
  });
  const projectB = await call<{ projectId: string }>(host, "/v1/projects", {
    credential: owner,
    body: { projectId: "project:private", name: "Private project" },
  });
  const node = await call<{ node: { nodeId: string }; credential: string }>(
    host,
    "/v1/nodes",
    {
      credential: owner,
      body: { nodeId: "node:local", name: "Local execution node" },
    },
  );
  const workspaceA = await call<{ workspaceId: string }>(
    host,
    "/v1/workspaces",
    {
      credential: owner,
      body: {
        workspaceId: "workspace:scoped",
        nodeId: node.value.node.nodeId,
        name: "Scoped workspace",
      },
    },
  );
  const workspaceB = await call<{ workspaceId: string }>(
    host,
    "/v1/workspaces",
    {
      credential: owner,
      body: {
        workspaceId: "workspace:private",
        nodeId: node.value.node.nodeId,
        name: "Private workspace",
      },
    },
  );
  const threadA = await call<{ threadId: string }>(host, "/v1/threads", {
    credential: owner,
    body: {
      threadId: "thread:scoped",
      projectId: projectA.value.projectId,
      title: "Scoped thread",
      target: {
        nodeId: node.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
    },
  });
  const privateThread = await call<{ threadId: string }>(host, "/v1/threads", {
    credential: owner,
    body: {
      threadId: "thread:assistant-private",
      projectId: projectA.value.projectId,
      title: "Owner-private assistant context",
      ownerPrivate: true,
      target: {
        nodeId: node.value.node.nodeId,
        workspaceId: workspaceA.value.workspaceId,
      },
    },
  });
  const threadB = await call<{ threadId: string }>(host, "/v1/threads", {
    credential: owner,
    body: {
      threadId: "thread:other-project",
      projectId: projectB.value.projectId,
      title: "Other project thread",
      target: {
        nodeId: node.value.node.nodeId,
        workspaceId: workspaceB.value.workspaceId,
      },
    },
  });
  return {
    host,
    owner,
    projectA: projectA.value.projectId,
    projectB: projectB.value.projectId,
    threadA: threadA.value.threadId,
    privateThread: privateThread.value.threadId,
    threadB: threadB.value.threadId,
  };
}

async function invite(
  host: LocalHost,
  owner: string,
  role: "guest" | "viewer",
  grants: Array<{ type: "project" | "thread"; resourceId: string }>,
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
) {
  return call<{ invitation: { invitationId: string }; code: string }>(
    host,
    "/v1/invitations",
    {
      credential: owner,
      body: { role, grants, expiresAt },
    },
  );
}

afterEach(() => {
  const openedHosts = hosts.splice(0);
  for (const host of openedHosts) host.close();
  for (const directory of new Set(openedHosts.map((host) => host.directory))) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const directory of extraDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("scoped collaboration over persistent local HTTP", () => {
  test("existing bootstrapped SQLite databases migrate without replacing owner credentials or threads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uzina-legacy-access-"));
    extraDirectories.push(directory);
    const database = new BunFactoryDatabase(join(directory, "factory.sqlite"));
    const ownerToken = "uz_human_existing-owner-credential";
    const ownerActor = {
      contractVersion: 1,
      kind: "human",
      userId: "user:owner",
    } as const;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(ownerToken),
    );
    const tokenHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    database.exec(
      "CREATE TABLE factory_meta (singleton INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, ownership_generation INTEGER NOT NULL)",
    );
    database.exec(
      "INSERT INTO factory_meta (singleton, owner_id, ownership_generation) VALUES (1, 'user:owner', 0)",
    );
    database.exec(
      "CREATE TABLE credentials (credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, actor_json TEXT NOT NULL, name TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL)",
    );
    database.exec(
      "INSERT INTO credentials (credential_id, token_hash, actor_json, name, created_at) VALUES ('credential:node-first', 'fixture-node-hash', ?, 'Earlier node name', '2023-01-01T00:00:00.000Z')",
      [
        JSON.stringify({
          contractVersion: 1,
          kind: "node",
          nodeId: "node:old",
        }),
      ],
    );
    database.exec(
      "INSERT INTO credentials (credential_id, token_hash, actor_json, name, created_at) VALUES ('credential:legacy-owner', ?, ?, 'Legacy owner display name', '2024-01-01T00:00:00.000Z')",
      [tokenHash, JSON.stringify(ownerActor)],
    );
    database.exec(
      "CREATE TABLE threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, node_id TEXT NOT NULL, workspace_id TEXT NOT NULL, ownership_generation INTEGER NOT NULL, created_at TEXT NOT NULL)",
    );
    try {
      const factory = new FactoryService(database);
      const owner = await factory.authenticate(ownerToken);
      expect(owner.actor).toMatchObject(ownerActor);
      expect(factory.currentParticipant(owner)).toMatchObject({
        userId: "user:owner",
        displayName: "Legacy owner display name",
        role: "owner",
      });
      const threadColumns = database.all<{ name: string }>(
        "PRAGMA table_info(threads)",
      );
      expect(
        threadColumns.some((column) => column.name === "owner_private"),
      ).toBe(true);
      expect(
        database.all<{ credential_id: string }>(
          "SELECT credential_id FROM credentials ORDER BY credential_id",
        ),
      ).toEqual([
        { credential_id: "credential:legacy-owner" },
        { credential_id: "credential:node-first" },
      ]);
    } finally {
      database.close();
    }
  });

  test("project/thread grants constrain reads, receipts, context, events, and node APIs; discussion is not managed input", async () => {
    const fixture = await createFixture();
    const guestInvite = await invite(fixture.host, fixture.owner, "guest", [
      { type: "project", resourceId: fixture.projectA },
    ]);
    expect(guestInvite.status).toBe(201);
    expect(
      (
        await call(fixture.host, "/v1/invitations", {
          credential: fixture.owner,
          body: {
            role: "guest",
            grants: [{ type: "thread", resourceId: fixture.privateThread }],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(fixture.host, "/v1/invitations", {
          credential: fixture.owner,
          body: {
            role: "guest",
            grants: [{ type: "factory", resourceId: fixture.projectA }],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        })
      ).status,
    ).toBe(400);
    const guestJoin = await call<{
      credential: string;
      participant: { userId: string; role: string };
    }>(fixture.host, "/v1/invitations/redeem", {
      body: { code: guestInvite.value.code, displayName: "Guest Ada" },
    });
    expect(guestJoin.status).toBe(201);
    expect(guestJoin.value.participant).toMatchObject({
      displayName: "Guest Ada",
      role: "guest",
    });
    const guest = guestJoin.value.credential;

    const viewerInvite = await invite(fixture.host, fixture.owner, "viewer", [
      { type: "thread", resourceId: fixture.threadA },
    ]);
    const viewerJoin = await call<{
      credential: string;
      participant: { userId: string };
    }>(fixture.host, "/v1/invitations/redeem", {
      body: { code: viewerInvite.value.code, displayName: "Viewer Bea" },
    });
    const viewer = viewerJoin.value.credential;

    const projects = await call<{ projects: Array<{ projectId: string }> }>(
      fixture.host,
      "/v1/projects",
      {
        credential: guest,
      },
    );
    expect(projects.value.projects.map((project) => project.projectId)).toEqual(
      [fixture.projectA],
    );
    const threads = await call<{ threads: Array<{ threadId: string }> }>(
      fixture.host,
      "/v1/threads",
      {
        credential: guest,
      },
    );
    expect(threads.value.threads.map((thread) => thread.threadId)).toEqual([
      fixture.threadA,
    ]);
    const filtered = await call<{ threads: unknown[] }>(
      fixture.host,
      `/v1/threads?projectId=${fixture.projectB}`,
      { credential: guest },
    );
    expect(filtered.value.threads).toEqual([]);

    const ownerReceipt = await call<{ requestId: string }>(
      fixture.host,
      `/v1/threads/${fixture.threadB}/inputs`,
      {
        credential: fixture.owner,
        body: { requestId: "request:other-project", text: "owner-only work" },
      },
    );
    expect(ownerReceipt.status).toBe(202);
    expect(
      (
        await call(
          fixture.host,
          `/v1/commands/${ownerReceipt.value.requestId}`,
          { credential: guest },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(fixture.host, `/v1/threads/${fixture.threadB}/context`, {
          credential: guest,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          fixture.host,
          `/v1/threads/${fixture.privateThread}/context`,
          { credential: guest },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          fixture.host,
          `/v1/threads/${fixture.privateThread}/context`,
          { credential: viewer },
        )
      ).status,
    ).toBe(404);
    const ownerContext = await call<{
      runtime: { messages: Array<{ text: string }> };
    }>(fixture.host, `/v1/threads/${fixture.privateThread}/context`, {
      credential: fixture.owner,
    });
    expect(ownerContext.value.runtime.messages[0]?.text).toBe(
      "owner-private assistant context",
    );
    expect(
      (await call(fixture.host, "/v1/nodes", { credential: guest })).status,
    ).toBe(403);
    expect(
      (await call(fixture.host, "/v1/workspaces", { credential: guest }))
        .status,
    ).toBe(403);
    expect(
      (await call(fixture.host, "/v1/people", { credential: guest })).status,
    ).toBe(403);
    expect(
      (await call(fixture.host, "/v1/invitations", { credential: guest }))
        .status,
    ).toBe(403);
    expect(
      (await call(fixture.host, "/v1/credentials", { credential: guest }))
        .status,
    ).toBe(403);
    expect((await invite(fixture.host, guest, "viewer", [])).status).toBe(403);

    const viewerDiscussion = await call<{
      discussionId: string;
      actor: { userId: string };
      displayName: string;
    }>(fixture.host, `/v1/threads/${fixture.threadA}/discussion`, {
      credential: viewer,
      body: { text: "A human discussion message, not agent input." },
    });
    expect(viewerDiscussion.status).toBe(201);
    expect(viewerDiscussion.value.actor.userId).toBe(
      viewerJoin.value.participant.userId,
    );
    expect(viewerDiscussion.value.displayName).toBe("Viewer Bea");
    expect(
      (
        await call(fixture.host, `/v1/threads/${fixture.threadA}/inputs`, {
          credential: viewer,
          body: {
            requestId: "request:viewer-denied",
            text: "Must not dispatch.",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(fixture.host, `/v1/threads/${fixture.threadB}/discussion`, {
          credential: viewer,
          body: { text: "Must not cross the thread grant." },
        })
      ).status,
    ).toBe(404);

    const discussion = await call<{
      discussion: Array<{
        discussionId: string;
        text: string;
        displayName: string;
        actor: { userId: string };
      }>;
    }>(fixture.host, `/v1/threads/${fixture.threadA}/discussion`, {
      credential: guest,
    });
    expect(discussion.value.discussion).toHaveLength(1);
    expect(discussion.value.discussion[0]).toMatchObject({
      discussionId: viewerDiscussion.value.discussionId,
      text: "A human discussion message, not agent input.",
      displayName: "Viewer Bea",
      actor: { userId: viewerJoin.value.participant.userId },
    });
    expect(
      fixture.host.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM command_receipts WHERE request_id = 'request:viewer-denied'",
      )[0]?.count,
    ).toBe(0);
    expect(
      fixture.host.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM thread_discussion WHERE thread_id = ?",
        [fixture.threadA],
      )[0]?.count,
    ).toBe(1);

    const guestEvents = await call<{
      events: Array<{
        cursor: number;
        threadId: string | null;
        requestId: string | null;
      }>;
    }>(fixture.host, "/v1/events", { credential: guest });
    for (let index = 1; index < guestEvents.value.events.length; index += 1) {
      expect(guestEvents.value.events[index]!.cursor).toBe(
        guestEvents.value.events[index - 1]!.cursor + 1,
      );
    }
    expect(
      guestEvents.value.events.some(
        (event) => event.requestId === "request:other-project",
      ),
    ).toBe(false);
    expect(
      guestEvents.value.events.some(
        (event) => event.threadId === fixture.privateThread,
      ),
    ).toBe(false);

    const assistant = await call<{ credential: string }>(
      fixture.host,
      "/v1/credentials",
      {
        credential: fixture.owner,
        body: { kind: "assistant", name: "Private assistant" },
      },
    );
    const assistantContext = await call<{
      runtime: { messages: Array<{ text: string }> };
    }>(fixture.host, `/v1/threads/${fixture.privateThread}/context`, {
      credential: assistant.value.credential,
    });
    expect(assistantContext.value.runtime.messages[0]?.text).toBe(
      "owner-private assistant context",
    );

    expect(
      fixture.host.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM dispatch_intents WHERE thread_id = ?",
        [fixture.threadA],
      )[0]?.count,
    ).toBe(0);
    expect(
      fixture.host.database
        .all<{ token_hash: string }>("SELECT token_hash FROM credentials")
        .map((row) => row.token_hash),
    ).not.toContain(viewer);
    const visibleEvents = JSON.stringify(
      fixture.host.factory.events(
        await fixture.host.factory.authenticate(fixture.owner),
        0,
      ),
    );
    expect(visibleEvents.includes(viewerInvite.value.code)).toBe(false);
    expect(visibleEvents.includes(viewer)).toBe(false);
    expect(
      JSON.stringify(
        fixture.host.factory.events(
          await fixture.host.factory.authenticate(fixture.owner),
          0,
        ),
      ).includes(viewerInvite.value.code),
    ).toBe(false);
  });

  test("invitation redemption is persistent, expiring, single-use, and atomic under concurrency", async () => {
    const fixture = await createFixture();
    const concurrent = await invite(fixture.host, fixture.owner, "viewer", [
      { type: "thread", resourceId: fixture.threadA },
    ]);
    const attempts = await Promise.all([
      call<{ credential: string }>(fixture.host, "/v1/invitations/redeem", {
        body: { code: concurrent.value.code, displayName: "Concurrent one" },
      }),
      call<{ credential: string }>(fixture.host, "/v1/invitations/redeem", {
        body: { code: concurrent.value.code, displayName: "Concurrent two" },
      }),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
      201, 404,
    ]);
    const winner = attempts.find((attempt) => attempt.status === 201)!;
    expect(
      fixture.host.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM factory_users WHERE role = 'viewer'",
      )[0]?.count,
    ).toBe(1);

    const invitationRows = fixture.host.database.all<{ code_hash: string }>(
      "SELECT code_hash FROM invitations WHERE invitation_id = ?",
      [concurrent.value.invitation.invitationId],
    );
    expect(invitationRows[0]?.code_hash).not.toBe(concurrent.value.code);
    expect(
      fixture.host.database
        .all<{ token_hash: string }>("SELECT token_hash FROM credentials")
        .map((row) => row.token_hash),
    ).not.toContain(winner.value.credential);

    const expired = await invite(fixture.host, fixture.owner, "guest", [
      { type: "project", resourceId: fixture.projectA },
    ]);
    fixture.host.database.exec(
      "UPDATE invitations SET expires_at = ? WHERE invitation_id = ?",
      [
        new Date(Date.now() - 1_000).toISOString(),
        expired.value.invitation.invitationId,
      ],
    );
    const revoked = await invite(fixture.host, fixture.owner, "viewer", [
      { type: "thread", resourceId: fixture.threadA },
    ]);
    expect(
      (
        await call(
          fixture.host,
          `/v1/invitations/${revoked.value.invitation.invitationId}/revoke`,
          {
            credential: fixture.owner,
            body: {},
          },
        )
      ).status,
    ).toBe(200);

    const directory = fixture.host.directory;
    fixture.host.close();
    const reopened = openHost(directory);
    const persistedOwner = await reopened.factory.authenticate(fixture.owner);
    const persistedInvite = reopened.factory.listInvitations(persistedOwner);
    expect(
      persistedInvite.find(
        (item) =>
          item.invitationId === concurrent.value.invitation.invitationId,
      )?.redeemedAt,
    ).not.toBeNull();
    expect(
      (await reopened.factory.authenticate(winner.value.credential)).actor.kind,
    ).toBe("human");
    expect(
      (
        await call(reopened, "/v1/invitations/redeem", {
          body: { code: concurrent.value.code, displayName: "Reused code" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(reopened, "/v1/invitations/redeem", {
          body: { code: expired.value.code, displayName: "Expired code" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(reopened, "/v1/invitations/redeem", {
          body: { code: revoked.value.code, displayName: "Revoked code" },
        })
      ).status,
    ).toBe(404);
  });

  test("downgrades and revocation immediately change retained-credential reads, mutations, and event polling", async () => {
    const fixture = await createFixture();
    const invitation = await invite(fixture.host, fixture.owner, "guest", [
      { type: "project", resourceId: fixture.projectA },
    ]);
    const joined = await call<{
      credential: string;
      participant: { userId: string };
    }>(fixture.host, "/v1/invitations/redeem", {
      body: { code: invitation.value.code, displayName: "Long-lived browser" },
    });
    const retainedCredential = joined.value.credential;
    const accepted = await call<{ requestId: string }>(
      fixture.host,
      `/v1/threads/${fixture.threadA}/inputs`,
      {
        credential: retainedCredential,
        body: { requestId: "request:before-downgrade", text: "Guest work" },
      },
    );
    expect(accepted.status).toBe(202);
    const cursorBeforeDowngrade = await call<{ nextCursor: number }>(
      fixture.host,
      "/v1/events",
      { credential: retainedCredential },
    );

    const downgrade = await call(
      fixture.host,
      `/v1/people/${joined.value.participant.userId}/access`,
      {
        method: "PUT",
        credential: fixture.owner,
        body: {
          role: "viewer",
          grants: [{ type: "project", resourceId: fixture.projectA }],
        },
      },
    );
    expect(downgrade.status).toBe(200);
    expect(
      (
        await call(fixture.host, `/v1/threads/${fixture.threadA}/inputs`, {
          credential: retainedCredential,
          body: {
            requestId: "request:after-downgrade",
            text: "Viewer must not steer",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(fixture.host, `/v1/threads/${fixture.threadA}/discussion`, {
          credential: retainedCredential,
          body: { text: "Viewer discussion is still allowed" },
        })
      ).status,
    ).toBe(201);
    const refreshedEvents = await call<{
      events: unknown[];
      nextCursor: number;
    }>(
      fixture.host,
      `/v1/events?after=${cursorBeforeDowngrade.value.nextCursor}`,
      { credential: retainedCredential },
    );
    expect(refreshedEvents.value.events.length).toBeGreaterThan(0);
    expect(refreshedEvents.value.nextCursor).toBeGreaterThan(
      cursorBeforeDowngrade.value.nextCursor,
    );

    const removeGrant = await call(
      fixture.host,
      `/v1/people/${joined.value.participant.userId}/access`,
      {
        method: "PUT",
        credential: fixture.owner,
        body: { role: "viewer", grants: [] },
      },
    );
    expect(removeGrant.status).toBe(200);
    expect(
      (
        await call(fixture.host, `/v1/threads/${fixture.threadA}/discussion`, {
          credential: retainedCredential,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(fixture.host, `/v1/commands/${accepted.value.requestId}`, {
          credential: retainedCredential,
        })
      ).status,
    ).toBe(404);
    const events = await call<{ events: Array<{ threadId: string | null }> }>(
      fixture.host,
      "/v1/events?after=0",
      {
        credential: retainedCredential,
      },
    );
    expect(events.value.events).toEqual([]);

    expect(
      (
        await call(
          fixture.host,
          `/v1/people/${joined.value.participant.userId}/revoke`,
          {
            credential: fixture.owner,
            body: {},
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(fixture.host, "/v1/me", { credential: retainedCredential }))
        .status,
    ).toBe(401);
  });
});
