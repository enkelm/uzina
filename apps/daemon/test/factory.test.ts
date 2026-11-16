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

function reopenFixtureDatabase(
  directory: string,
  database: BunFactoryDatabase,
) {
  database.close();
  const reopened = new BunFactoryDatabase(join(directory, "factory.sqlite"));
  const fixture = fixtures.find((item) => item.directory === directory);
  if (!fixture) throw new Error("Factory test fixture is not registered");
  fixture.database = reopened;
  return reopened;
}

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

  test("local Owner import admission reserves exact configured descriptors across retries and reopen", async () => {
    const fixture = await provisionFixture(false);
    const request = {
      contractVersion: 1,
      requestId: "import:offline-one",
      sourceCatalogId: "catalog:offline",
      manifestSha256: "a".repeat(64),
      destinationId: "destination:private-one",
    };
    const binding = {
      hostDescriptor: "bun-standalone:/var/lib/uzina/factory.sqlite",
      sourceCatalog: {
        sourceCatalogId: request.sourceCatalogId,
        canonicalRoot: "/var/lib/uzina/import-catalog",
      },
      destination: {
        destinationId: request.destinationId,
        canonicalRoot: "/var/lib/uzina/prepared/work-one",
      },
    };

    const admitted = fixture.factory.requestManagedWorkImport(
      fixture.owner,
      request,
      binding,
    );
    expect(admitted).toMatchObject({
      requestId: request.requestId,
      ownerId:
        fixture.owner.actor.kind === "human" ? fixture.owner.actor.userId : "",
      actor: fixture.owner.actor,
      sourceCatalogId: request.sourceCatalogId,
      manifestSha256: request.manifestSha256,
      destinationId: request.destinationId,
      hostBinding: binding,
      status: "admitted",
    });
    expect(
      fixture.factory.requestManagedWorkImport(fixture.owner, request, binding),
    ).toEqual(admitted);
    expect(() =>
      fixture.factory.assertManagedWorkImportReservationsDisjoint([
        "/var/lib/uzina/prepared/work-one/nested/database.sqlite",
      ]),
    ).toThrow("managed_work_import_destination_reserved");
    expect(() =>
      fixture.factory.assertManagedWorkImportReservationsDisjoint([
        "/var/lib/uzina/ordinary-runtime",
      ]),
    ).not.toThrow();
    expect(
      fixture.factory.database.all<{
        request_id: string;
        owner_id: string;
        source_catalog_root: string;
        destination_root: string;
        status: string;
      }>(
        "SELECT request_id, owner_id, source_catalog_root, destination_root, status FROM managed_work_imports WHERE request_id = ?",
        [request.requestId],
      )[0],
    ).toMatchObject({
      request_id: request.requestId,
      owner_id: admitted.ownerId,
      source_catalog_root: binding.sourceCatalog.canonicalRoot,
      destination_root: binding.destination.canonicalRoot,
      status: "admitted",
    });

    expect(() =>
      fixture.factory.requestManagedWorkImport(
        fixture.nodeSession,
        { ...request, requestId: "import:node-denied" },
        {
          ...binding,
          destination: {
            ...binding.destination,
            destinationId: "destination:node",
          },
        },
      ),
    ).toThrow("This credential kind cannot perform that operation");

    expect(() =>
      fixture.factory.requestManagedWorkImport(fixture.owner, request, {
        ...binding,
        destination: {
          ...binding.destination,
          canonicalRoot: "/var/lib/uzina/prepared/work-one/child",
        },
      }),
    ).toThrow("managed_work_import_request_conflict");
    const aliasRequest = {
      ...request,
      requestId: "import:destination-alias",
    };
    expect(() =>
      fixture.factory.requestManagedWorkImport(
        fixture.owner,
        aliasRequest,
        binding,
      ),
    ).toThrow("managed_work_import_destination_reserved");

    const nestedRequest = {
      ...request,
      requestId: "import:nested-destination",
      destinationId: "destination:nested",
    };
    const nestedBinding = {
      ...binding,
      destination: {
        destinationId: nestedRequest.destinationId,
        canonicalRoot: "/var/lib/uzina/prepared/work-one/nested",
      },
    };
    expect(() =>
      fixture.factory.requestManagedWorkImport(
        fixture.owner,
        nestedRequest,
        nestedBinding,
      ),
    ).toThrow("managed_work_import_destination_reserved");

    const persisted = fixture.factory.getManagedWorkImportStatus(
      fixture.owner,
      request.requestId,
    );
    const database = reopenFixtureDatabase(fixture.directory, fixture.database);
    const reopened = new FactoryService(database, bootstrapSecret);
    const owner = await reopened.authenticate(
      fixture.ownerCredential.credential,
    );
    expect(
      reopened.getManagedWorkImportStatus(owner, request.requestId),
    ).toEqual(persisted);
    expect(
      database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM managed_work_imports WHERE destination_id = ?",
        [request.destinationId],
      )[0]?.count,
    ).toBe(1);
  });

  test("managed-work import preparation boundary is claimed once", async () => {
    const fixture = await provisionFixture(false);
    const request = {
      contractVersion: 1,
      requestId: "import:preparation-claim",
      sourceCatalogId: "catalog:offline",
      manifestSha256: "c".repeat(64),
      destinationId: "destination:claim",
    };
    const binding = {
      hostDescriptor: "bun-standalone:/var/lib/uzina/factory.sqlite",
      sourceCatalog: {
        sourceCatalogId: request.sourceCatalogId,
        canonicalRoot: "/var/lib/uzina/import-catalog",
      },
      destination: {
        destinationId: request.destinationId,
        canonicalRoot: "/var/lib/uzina/prepared/claim",
      },
    };
    fixture.factory.requestManagedWorkImport(fixture.owner, request, binding);
    expect(
      fixture.factory.beginManagedWorkImportPreparation(
        fixture.owner,
        request.requestId,
        binding,
      ).status,
    ).toBe("preparing");
    expect(() =>
      fixture.factory.beginManagedWorkImportPreparation(
        fixture.owner,
        request.requestId,
        binding,
      ),
    ).toThrow("managed_work_import_stage_conflict");
    expect(
      fixture.factory.getManagedWorkImportStatus(
        fixture.owner,
        request.requestId,
      ).status,
    ).toBe("preparing");
  });

  test("HTTP import admission refuses without local host capability and accepts only resolved descriptors", async () => {
    const fixture = await provisionFixture(false);
    const request = {
      contractVersion: 1,
      requestId: "import:http-one",
      sourceCatalogId: "catalog:http",
      manifestSha256: "b".repeat(64),
      destinationId: "destination:http",
    };
    const headers = {
      authorization: `Bearer ${fixture.ownerCredential.credential}`,
      "content-type": "application/json",
    };
    const unavailable = await createFactoryHttpHandler(fixture.factory)(
      new Request("https://factory.test/v1/managed-work-imports", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: "managed_work_import_host_unavailable",
    });
    expect(
      fixture.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM managed_work_imports",
      )[0]?.count,
    ).toBe(0);

    const binding = {
      hostDescriptor: "bun-standalone:/var/lib/uzina/http-factory.sqlite",
      sourceCatalog: {
        sourceCatalogId: request.sourceCatalogId,
        canonicalRoot: "/var/lib/uzina/http-catalog",
      },
      destination: {
        destinationId: request.destinationId,
        canonicalRoot: "/var/lib/uzina/http-prepared",
      },
    };
    let resolved: unknown;
    const handler = createFactoryHttpHandler(
      fixture.factory,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        async run(input, journal) {
          resolved = input;
          journal.admit(input, binding);
        },
      },
    );
    const nonOwner = await handler(
      new Request("https://factory.test/v1/managed-work-imports", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.nodeCredential.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      }),
    );
    expect(nonOwner.status).toBe(403);
    expect(resolved).toBeUndefined();
    expect(
      fixture.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM managed_work_imports",
      )[0]?.count,
    ).toBe(0);

    const admitted = await handler(
      new Request("https://factory.test/v1/managed-work-imports", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      }),
    );
    expect(admitted.status).toBe(202);
    expect(await admitted.json()).toMatchObject({
      requestId: request.requestId,
      status: "admitted",
      hostBinding: binding,
    });
    expect(resolved).toEqual(request);

    const status = await handler(
      new Request(
        `https://factory.test/v1/managed-work-imports/${request.requestId}`,
        { headers: { authorization: headers.authorization } },
      ),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      requestId: request.requestId,
      status: "admitted",
      manifestSha256: request.manifestSha256,
    });
  });

  test("HTTP import rechecks the current local Owner after asynchronous host resolution", async () => {
    const fixture = await provisionFixture(false);
    const temporaryOwner = await fixture.factory.provisionCredential(
      fixture.owner,
      "human",
      "Temporary owner credential",
    );
    const request = {
      contractVersion: 1,
      requestId: "import:owner-revoked-during-resolution",
      sourceCatalogId: "catalog:revoked-owner",
      manifestSha256: "d".repeat(64),
      destinationId: "destination:revoked-owner",
    };
    const binding = {
      hostDescriptor: "bun-standalone:/var/lib/uzina/factory.sqlite",
      sourceCatalog: {
        sourceCatalogId: request.sourceCatalogId,
        canonicalRoot: "/var/lib/uzina/revoked-catalog",
      },
      destination: {
        destinationId: request.destinationId,
        canonicalRoot: "/var/lib/uzina/revoked-destination",
      },
    };
    const handler = createFactoryHttpHandler(
      fixture.factory,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        async run(input, journal) {
          await fixture.factory.revokeCredential(
            fixture.owner,
            temporaryOwner.credentialId,
          );
          journal.admit(input, binding);
        },
      },
    );
    const response = await handler(
      new Request("https://factory.test/v1/managed-work-imports", {
        method: "POST",
        headers: {
          authorization: `Bearer ${temporaryOwner.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      }),
    );
    expect(response.status).toBe(401);
    expect(
      fixture.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM managed_work_imports WHERE request_id = ?",
        [request.requestId],
      )[0]?.count,
    ).toBe(0);
    const status = await handler(
      new Request(
        `https://factory.test/v1/managed-work-imports/${request.requestId}`,
        {
          headers: {
            authorization: `Bearer ${fixture.ownerCredential.credential}`,
          },
        },
      ),
    );
    expect(status.status).toBe(404);
  });

  test("legacy databases acquire the additive import journal without rewriting existing authority", async () => {
    const fixture = await provisionFixture(false);
    const accepted = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:before-import-migration",
      "Keep existing work unchanged",
    );
    const beforeReceipt = fixture.database.all(
      "SELECT request_id, job_id FROM command_receipts WHERE request_id = ?",
      [accepted.requestId],
    );
    const beforeIntent = fixture.database.all(
      "SELECT request_id, job_id, ownership_generation FROM dispatch_intents WHERE request_id = ?",
      [accepted.requestId],
    );
    fixture.database.exec("DROP TABLE managed_work_imports");

    const database = reopenFixtureDatabase(fixture.directory, fixture.database);
    const reopened = new FactoryService(database, bootstrapSecret);
    const owner = await reopened.authenticate(
      fixture.ownerCredential.credential,
    );
    expect(
      database
        .all<{ name: string }>("PRAGMA table_info(managed_work_imports)")
        .map((column) => column.name),
    ).toContain("host_binding_json");
    expect(
      database.all(
        "SELECT request_id, job_id FROM command_receipts WHERE request_id = ?",
        [accepted.requestId],
      ),
    ).toEqual(beforeReceipt);
    expect(
      database.all(
        "SELECT request_id, job_id, ownership_generation FROM dispatch_intents WHERE request_id = ?",
        [accepted.requestId],
      ),
    ).toEqual(beforeIntent);
    expect(reopened.getReceipt(owner, accepted.requestId)).toMatchObject({
      requestId: accepted.requestId,
      jobId: accepted.jobId,
    });
  });

  test("legacy workspace generations migrate once and new provisioning ignores the legacy singleton", async () => {
    const fixture = await provisionFixture(true);
    const oldInput = await fixture.factory.submitInput(
      fixture.owner,
      fixture.thread.threadId,
      "request:legacy-workspace-migration",
      "Preserve this accepted input",
    );
    const settled = await fixture.factory.dispatchNext({
      async dispatch() {
        return { status: "completed" };
      },
    });
    expect(settled?.jobId).toBe(oldInput.jobId);
    const before = {
      thread: fixture.database.all<{
        thread_id: string;
        node_id: string;
        workspace_id: string;
        ownership_generation: number;
      }>(
        "SELECT thread_id, node_id, workspace_id, ownership_generation FROM threads WHERE thread_id = ?",
        [fixture.thread.threadId],
      )[0],
      input: fixture.database.all<{
        job_id: string;
        request_id: string;
        ownership_generation: number;
      }>(
        "SELECT job_id, request_id, ownership_generation FROM dispatch_intents WHERE request_id = ?",
        [oldInput.requestId],
      )[0],
      receipt: fixture.database.all<{ request_id: string; job_id: string }>(
        "SELECT request_id, job_id FROM command_receipts WHERE request_id = ?",
        [oldInput.requestId],
      )[0],
    };

    fixture.database.exec(
      "ALTER TABLE workspaces DROP COLUMN ownership_generation",
    );
    let database = reopenFixtureDatabase(fixture.directory, fixture.database);
    let factory = new FactoryService(database, bootstrapSecret);
    let owner = await factory.authenticate(fixture.ownerCredential.credential);
    expect(
      database.all<{ ownership_generation: number }>(
        "SELECT ownership_generation FROM workspaces WHERE workspace_id = ?",
        [fixture.thread.target.workspaceId],
      )[0]?.ownership_generation,
    ).toBe(0);
    expect(
      database.all(
        "SELECT thread_id, node_id, workspace_id, ownership_generation FROM threads WHERE thread_id = ?",
        [fixture.thread.threadId],
      )[0],
    ).toEqual(before.thread);
    expect(
      database.all(
        "SELECT job_id, request_id, ownership_generation FROM dispatch_intents WHERE request_id = ?",
        [oldInput.requestId],
      )[0],
    ).toEqual(before.input);
    expect(
      database.all(
        "SELECT request_id, job_id FROM command_receipts WHERE request_id = ?",
        [oldInput.requestId],
      )[0],
    ).toEqual(before.receipt);

    database.exec(
      "UPDATE factory_meta SET ownership_generation = 7 WHERE singleton = 1",
    );
    database = reopenFixtureDatabase(fixture.directory, database);
    factory = new FactoryService(database, bootstrapSecret);
    owner = await factory.authenticate(fixture.ownerCredential.credential);
    const workspace = factory.createWorkspace(
      owner,
      "workspace:new-after-migration",
      "node:laptop-a",
      "New workspace",
    );
    const thread = factory.createThread(owner, {
      threadId: "thread:new-after-migration",
      projectId: fixture.thread.projectId,
      title: "New scoped thread",
      target: { nodeId: "node:laptop-a", workspaceId: workspace.workspaceId },
    });
    expect(thread.ownershipGeneration).toBe(0);
    expect(
      database.all<{ ownership_generation: number }>(
        "SELECT ownership_generation FROM workspaces WHERE workspace_id = ?",
        [workspace.workspaceId],
      )[0]?.ownership_generation,
    ).toBe(0);

    const node = await factory.authenticate(fixture.nodeCredential.credential);
    factory.registerExecutionNode(
      node,
      executionRegisterRequestSchema.parse({
        ...registration("node:laptop-a", fixture.thread.target.workspaceId),
        workspaces: [
          {
            workspaceId: fixture.thread.target.workspaceId,
            ownershipGeneration: 0,
            state: "active",
          },
          {
            workspaceId: workspace.workspaceId,
            ownershipGeneration: 0,
            state: "active",
          },
        ],
      }),
    );
    const accepted = await factory.submitInput(
      owner,
      thread.threadId,
      "request:new-scoped-workspace",
      "Use the new workspace",
    );
    expect(accepted).toMatchObject({
      status: "accepted",
      dispatchStatus: "queued",
      ownershipGeneration: 0,
      target: { nodeId: "node:laptop-a", workspaceId: workspace.workspaceId },
    });
    let dispatchedTarget: { nodeId: string; workspaceId: string } | undefined;
    await factory.dispatchNext({
      async dispatch(job) {
        dispatchedTarget = job.target;
        expect(job.ownershipGeneration).toBe(0);
        return { status: "dispatched" };
      },
    });
    expect(dispatchedTarget).toEqual({
      nodeId: "node:laptop-a",
      workspaceId: workspace.workspaceId,
    });

    const effect = await factory.enqueueRemoteExecution({
      contractVersion: 1,
      jobId: "job:new-scoped-workspace",
      nodeId: "node:laptop-a",
      target: { nodeId: "node:laptop-a", workspaceId: workspace.workspaceId },
      ownershipGeneration: 0,
      operation: "read-file",
      path: "README.md",
      maxBytes: 1024,
    });
    expect(effect).toMatchObject({ status: "queued", ownershipGeneration: 0 });
    expect(factory.claimExecutionJob(node, "node:laptop-a")).toMatchObject({
      jobId: effect.jobId,
      target: { workspaceId: workspace.workspaceId },
      ownershipGeneration: 0,
    });
    expect(
      database.all<{ ownership_generation: number }>(
        "SELECT ownership_generation FROM factory_meta WHERE singleton = 1",
      )[0]?.ownership_generation,
    ).toBe(7);
  });

  test("reopen rejects an invalid already-scoped authority instead of defaulting from the legacy singleton", async () => {
    const fixture = await provisionFixture(false);
    fixture.database.exec(
      "UPDATE workspaces SET ownership_generation = 9007199254740992 WHERE workspace_id = ?",
      [fixture.thread.target.workspaceId],
    );
    fixture.database.exec(
      "UPDATE factory_meta SET ownership_generation = 0 WHERE singleton = 1",
    );
    const database = reopenFixtureDatabase(fixture.directory, fixture.database);
    expect(() => new FactoryService(database, bootstrapSecret)).toThrow(
      /Invalid scoped workspace ownership authority/,
    );
    expect(
      database.all<{ ownership_generation: number }>(
        "SELECT ownership_generation FROM workspaces WHERE workspace_id = ?",
        [fixture.thread.target.workspaceId],
      )[0]?.ownership_generation,
    ).toBe(9007199254740992);
  });

  test("contradictory legacy thread placement refuses migration without adding partial authority", async () => {
    const fixture = await provisionFixture(true);
    fixture.database.exec(
      "ALTER TABLE workspaces DROP COLUMN ownership_generation",
    );
    fixture.database.exec(
      "UPDATE threads SET ownership_generation = 1 WHERE thread_id = ?",
      [fixture.thread.threadId],
    );
    const database = reopenFixtureDatabase(fixture.directory, fixture.database);
    expect(() => new FactoryService(database, bootstrapSecret)).toThrow(
      /Thread placement disagrees with workspace ownership/,
    );
    expect(
      database
        .all<{ name: string }>("PRAGMA table_info(workspaces)")
        .map((column) => column.name),
    ).not.toContain("ownership_generation");
  });

  test("missing or unsafe legacy singleton and mismatched node observations fail closed", async () => {
    const missing = await provisionFixture(false);
    missing.database.exec(
      "ALTER TABLE workspaces DROP COLUMN ownership_generation",
    );
    missing.database.exec("DELETE FROM factory_meta WHERE singleton = 1");
    const missingDatabase = reopenFixtureDatabase(
      missing.directory,
      missing.database,
    );
    expect(() => new FactoryService(missingDatabase, bootstrapSecret)).toThrow(
      /safe legacy ownership generation/,
    );
    expect(
      missingDatabase
        .all<{ name: string }>("PRAGMA table_info(workspaces)")
        .map((column) => column.name),
    ).not.toContain("ownership_generation");

    const unsafe = await provisionFixture(false);
    unsafe.database.exec(
      "ALTER TABLE workspaces DROP COLUMN ownership_generation",
    );
    unsafe.database.exec(
      "UPDATE factory_meta SET ownership_generation = 9007199254740992 WHERE singleton = 1",
    );
    const unsafeDatabase = reopenFixtureDatabase(
      unsafe.directory,
      unsafe.database,
    );
    expect(() => new FactoryService(unsafeDatabase, bootstrapSecret)).toThrow(
      /safe legacy ownership generation/,
    );
    expect(
      unsafeDatabase
        .all<{ name: string }>("PRAGMA table_info(workspaces)")
        .map((column) => column.name),
    ).not.toContain("ownership_generation");

    const mismatched = await provisionFixture(true);
    mismatched.database.exec(
      "ALTER TABLE workspaces DROP COLUMN ownership_generation",
    );
    mismatched.database.exec(
      "UPDATE execution_node_workspaces SET ownership_generation = 1 WHERE workspace_id = ?",
      [mismatched.thread.target.workspaceId],
    );
    const mismatchedDatabase = reopenFixtureDatabase(
      mismatched.directory,
      mismatched.database,
    );
    expect(
      () => new FactoryService(mismatchedDatabase, bootstrapSecret),
    ).toThrow(/Node workspace observation disagrees with workspace ownership/);
    expect(
      mismatchedDatabase
        .all<{ name: string }>("PRAGMA table_info(workspaces)")
        .map((column) => column.name),
    ).not.toContain("ownership_generation");

    const wrongNode = await provisionFixture(false);
    await wrongNode.factory.provisionNode(
      wrongNode.owner,
      "node:laptop-b",
      "Laptop B",
    );
    wrongNode.database.exec(
      "INSERT INTO execution_node_workspaces(node_id, workspace_id, ownership_generation, state) VALUES (?, ?, 0, 'active')",
      ["node:laptop-b", wrongNode.thread.target.workspaceId],
    );
    wrongNode.database.exec(
      "ALTER TABLE workspaces DROP COLUMN ownership_generation",
    );
    const wrongNodeDatabase = reopenFixtureDatabase(
      wrongNode.directory,
      wrongNode.database,
    );
    expect(
      () => new FactoryService(wrongNodeDatabase, bootstrapSecret),
    ).toThrow(/Node workspace observation disagrees with workspace ownership/);
    expect(
      wrongNodeDatabase
        .all<{ name: string }>("PRAGMA table_info(workspaces)")
        .map((column) => column.name),
    ).not.toContain("ownership_generation");
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

  test("transfer hold rejects non-owners and cannot bind without real source evidence", async () => {
    const fixture = await provisionFixture(true);
    const request = {
      contractVersion: 1,
      requestId: "transfer:missing-source",
      captureRequestId: "capture:not-present",
      checkpointRequestId: "checkpoint:not-present",
    };
    const invite = await fixture.factory.createInvitation(fixture.owner, {
      role: "guest",
      grants: [{ type: "thread", resourceId: fixture.thread.threadId }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const guest = await fixture.factory.authenticate(
      (await fixture.factory.redeemInvitation(invite.code, "Guest")).credential,
    );
    await expect(
      fixture.factory.requestManagedWorkTransferHold(
        guest,
        fixture.thread.threadId,
        request,
      ),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(
      fixture.factory.requestManagedWorkTransferHold(
        fixture.owner,
        fixture.thread.threadId,
        request,
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      fixture.factory.getManagedWorkTransferHoldStatus(
        fixture.owner,
        request.requestId,
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(
      fixture.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM managed_work_transfer_holds",
      )[0]?.count,
    ).toBe(0);
  });

  test("transfer-hold schema reopens additively without seeding source evidence", async () => {
    const fixture = await provisionFixture(false);
    fixture.database.exec("DROP TABLE managed_work_transfer_holds");
    const database = reopenFixtureDatabase(fixture.directory, fixture.database);
    const reopened = new FactoryService(database, bootstrapSecret);
    const columns = database
      .all<{ name: string }>("PRAGMA table_info(managed_work_transfer_holds)")
      .map((column) => column.name);
    expect(columns).toContain("binding_sha256");
    expect(columns).toContain("source_fence_json");
    expect(columns).toContain("coherent_checkpoint_manifest_reference");
    expect(
      database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM managed_work_transfer_holds",
      )[0]?.count,
    ).toBe(0);
    expect(reopened.listProjects(fixture.owner)).toHaveLength(1);
  });

  test("transfer hold HTTP route is source-capability gated and strict before admission", async () => {
    const fixture = await provisionFixture(true);
    const request = {
      contractVersion: 1,
      requestId: "transfer:unavailable-source",
      captureRequestId: "capture:source",
      checkpointRequestId: "checkpoint:source",
    };
    const headers = {
      authorization: `Bearer ${fixture.ownerCredential.credential}`,
      "content-type": "application/json",
    };
    const unavailable = await createFactoryHttpHandler(fixture.factory)(
      new Request(
        `https://factory.test/v1/threads/${fixture.thread.threadId}/managed-work-transfer-holds`,
        { method: "POST", headers, body: JSON.stringify(request) },
      ),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: "managed_work_transfer_hold_unavailable",
    });
    const missingStatus = await createFactoryHttpHandler(fixture.factory)(
      new Request(
        "https://factory.test/v1/managed-work-transfer-holds/transfer:missing",
        { headers },
      ),
    );
    expect(missingStatus.status).toBe(404);

    let exportCalled = false;
    const strictHandler = createFactoryHttpHandler(
      fixture.factory,
      {
        context: async () => null,
        status: async () => null,
        async exportCheckpoint() {
          exportCalled = true;
          throw new Error(
            "A missing request body must not export a Checkpoint",
          );
        },
      },
      undefined,
      undefined,
      () => ({ getBlobStream: async () => null }),
    );
    const missingBody = await strictHandler(
      new Request(
        `https://factory.test/v1/threads/${fixture.thread.threadId}/managed-work-transfer-holds`,
        { method: "POST", headers: { authorization: headers.authorization } },
      ),
    );
    expect(missingBody.status).toBe(400);
    expect(await missingBody.json()).toMatchObject({ error: "invalid_json" });
    expect(exportCalled).toBe(false);
    expect(
      fixture.database.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM managed_work_transfer_holds",
      )[0]?.count,
    ).toBe(0);
  });

  test("a Bun host without a private assembly adapter refuses admission before recording it", async () => {
    const fixture = await provisionFixture(true);
    const handler = createFactoryHttpHandler(fixture.factory);
    const response = await handler(
      new Request(
        `https://factory.test/v1/threads/${fixture.thread.threadId}/managed-work-checkpoints`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${fixture.ownerCredential.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            contractVersion: 1,
            requestId: "checkpoint:bun-unsupported",
            captureRequestId: "capture:held-source",
            workspaceSnapshotRequestId: "snapshot:available",
          }),
        },
      ),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "managed_work_checkpoint_assembly_unavailable",
    });
    const missing = await handler(
      new Request(
        "https://factory.test/v1/managed-work-checkpoints/checkpoint:bun-unsupported",
        {
          headers: {
            authorization: `Bearer ${fixture.ownerCredential.credential}`,
          },
        },
      ),
    );
    expect(missing.status).toBe(404);
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
