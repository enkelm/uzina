import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineTask,
  Harness,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type DocumentId,
} from "@earendil-works/pi-durable";
import { ManagedPiWork } from "@uzina/pi-runtime";
import {
  exportManagedWorkCheckpoint,
  importManagedWorkCheckpoint,
  UnsupportedCheckpointState,
} from "@uzina/pi-runtime/checkpoint";
import { describe, expect, test } from "bun:test";
import { deterministicModels } from "../../../packages/pi-runtime/test-support/deterministic-model";
import { openLocalManagedPiWork } from "../src/runtime/managed-work";
import { openBunSqliteStorage } from "../src/runtime/sqlite";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Expected JSON value");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

async function resignCheckpoint(
  checkpoint: Awaited<ReturnType<typeof exportManagedWorkCheckpoint>>,
) {
  const { sha256: _previousHash, ...body } = checkpoint;
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    ...body,
    sha256: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}

describe("local managed Pi runtime", () => {
  test("persists canonical context and request receipts across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-managed-runtime-"));
    const databasePath = join(directory, "managed.sqlite");
    const provider = deterministicModels("persisted answer");
    const options = {
      models: provider.models,
      agent: { model: { provider: "uzina-test", modelId: "fixed-model" } },
    } as const;

    let work = await openLocalManagedPiWork(databasePath, options);
    try {
      const conversationId = await work.create();
      const accepted = await work.submit("request-1", "remember this request");
      expect(["queued", "placed", "done"]).toContain(accepted.status.status);
      const settled = await work.waitForSubmission("request-1");
      expect(settled.status).toBe("done");
      expect(provider.requests()).toBe(1);
      const before = await work.context();
      expect(before.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "persisted answer" }],
      });
      await work.close();

      work = await openLocalManagedPiWork(databasePath, options);
      expect(await work.openRoot()).toBe(conversationId);
      expect(await work.context()).toEqual(before);
      await work.resume();
      const duplicate = await work.submit("request-1", "remember this request");
      expect(duplicate.submissionId).toBe(accepted.submissionId);
      expect((await work.waitForSubmission("request-1")).id).toBe(
        accepted.submissionId,
      );
      expect(provider.requests()).toBe(1);
    } finally {
      await work.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("resumes a stored task checkpoint after the Bun SQLite database is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-task-resume-"));
    const databasePath = join(directory, "managed.sqlite");
    const reachedSleep = deferred<void>();
    const ContinuationTask = defineTask<
      { value: string },
      { phase: "park" } | { phase: "finish" },
      string
    >({
      name: "uzina.test.continuation",
      version: 1,
      initial: () => ({ phase: "park" }),
      phases: {
        park: async (_task, runtime, context) => {
          await runtime.sleepUntil(
            runtime.now() + 100,
            { phase: "finish" },
            context,
          );
          reachedSleep.resolve();
        },
        finish: async (task, runtime, context) => {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: task.input.value,
              },
            }),
            context,
          );
        },
      },
      abort: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          context,
        );
      },
    });
    const registry = createRegistry();
    registry.install({
      name: "uzina.test.continuation",
      tasks: [ContinuationTask],
    });
    const provider = deterministicModels();
    let harness = await Harness.open(
      await openBunSqliteStorage(databasePath),
      { models: provider.models, registry, now: () => 10 },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      const taskId = await root.commit(
        (tx) =>
          tx.createTask(
            ContinuationTask,
            { value: "completed after reopen" },
            {
              ownership: { kind: "conversation" },
              conversationId: root.id,
            },
          ),
        BACKGROUND_CONTEXT,
      );
      harness.resume();
      await reachedSleep.promise;
      await harness.close(BACKGROUND_CONTEXT);

      harness = await Harness.open(
        await openBunSqliteStorage(databasePath),
        { models: provider.models, registry, now: () => 1_000 },
        BACKGROUND_CONTEXT,
      );
      harness.resume();
      const completed = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
      expect(completed.state).toMatchObject({
        status: "terminal",
        outcome: { status: "completed", result: "completed after reopen" },
      });
    } finally {
      await harness.close(BACKGROUND_CONTEXT).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a non-reserved ownerless conversation as an export root", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "uzina-checkpoint-root-id-"),
    );
    const storage = await openBunSqliteStorage(
      join(directory, "non-root.sqlite"),
    );
    try {
      await storage.commit(
        [{ type: "conversation", value: { id: 2 as ConversationId } }],
        BACKGROUND_CONTEXT,
      );
      await expect(
        exportManagedWorkCheckpoint(storage, 2 as ConversationId),
      ).rejects.toBeInstanceOf(UnsupportedCheckpointState);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a non-reserved root in a validly checksummed import", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "uzina-checkpoint-import-root-id-"),
    );
    const sourceStorage = await openBunSqliteStorage(
      join(directory, "source.sqlite"),
    );
    const destinationStorage = await openBunSqliteStorage(
      join(directory, "destination.sqlite"),
    );
    try {
      await sourceStorage.commit(
        [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
        BACKGROUND_CONTEXT,
      );
      const checkpoint = await exportManagedWorkCheckpoint(
        sourceStorage,
        ROOT_CONVERSATION_ID,
      );
      const nonRootCheckpoint = structuredClone(checkpoint);
      nonRootCheckpoint.rootConversationId = 2 as ConversationId;
      nonRootCheckpoint.conversations[0] = {
        ...nonRootCheckpoint.conversations[0]!,
        id: 2 as ConversationId,
      };
      const resignedCheckpoint = await resignCheckpoint(nonRootCheckpoint);

      await expect(
        importManagedWorkCheckpoint(destinationStorage, resignedCheckpoint),
      ).rejects.toBeInstanceOf(UnsupportedCheckpointState);
      expect(
        await destinationStorage.conversation(
          2 as ConversationId,
          BACKGROUND_CONTEXT,
        ),
      ).toBeUndefined();
    } finally {
      await Promise.all([
        sourceStorage.close(BACKGROUND_CONTEXT),
        destinationStorage.close(BACKGROUND_CONTEXT),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an orphan scoped document in the checkpoint destination", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "uzina-checkpoint-scoped-document-"),
    );
    const sourceStorage = await openBunSqliteStorage(
      join(directory, "source.sqlite"),
    );
    const destinationStorage = await openBunSqliteStorage(
      join(directory, "destination.sqlite"),
    );
    try {
      await sourceStorage.commit(
        [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
        BACKGROUND_CONTEXT,
      );
      const checkpoint = await exportManagedWorkCheckpoint(
        sourceStorage,
        ROOT_CONVERSATION_ID,
      );

      const documentId = await destinationStorage.mintId<DocumentId>();
      await destinationStorage.commit(
        [
          {
            type: "document.create",
            record: {
              id: documentId,
              kind: "orphan.checkpoint-test",
              scope: {
                kind: "conversation",
                conversationId: 88 as ConversationId,
              },
              history: "latest",
              fork: "current",
            },
            content: { kind: "base", version: 1, value: { retained: true } },
          },
        ],
        BACKGROUND_CONTEXT,
      );

      await expect(
        importManagedWorkCheckpoint(destinationStorage, checkpoint),
      ).rejects.toThrow();
      expect(
        await destinationStorage.conversation(
          ROOT_CONVERSATION_ID,
          BACKGROUND_CONTEXT,
        ),
      ).toBeUndefined();
      expect(
        await destinationStorage.document(
          documentId,
          "current",
          BACKGROUND_CONTEXT,
        ),
      ).toMatchObject({ value: { retained: true } });
    } finally {
      await Promise.all([
        sourceStorage.close(BACKGROUND_CONTEXT),
        destinationStorage.close(BACKGROUND_CONTEXT),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("imports a checksummed logical checkpoint without starting work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-checkpoint-"));
    const sourcePath = join(directory, "source.sqlite");
    const destinationPath = join(directory, "destination.sqlite");
    const provider = deterministicModels("checkpoint answer");
    const options = {
      models: provider.models,
      agent: { model: { provider: "uzina-test", modelId: "fixed-model" } },
    } as const;
    let source = await openLocalManagedPiWork(sourcePath, options);
    try {
      const conversationId = await source.create();
      await source.submit("checkpoint-request", "save this context");
      const receipt = await source.waitForSubmission("checkpoint-request");
      const expected = await source.context();
      await source.close();

      const sourceStorage = await openBunSqliteStorage(sourcePath);
      const checkpoint = await exportManagedWorkCheckpoint(
        sourceStorage,
        conversationId,
      );
      await sourceStorage.close(BACKGROUND_CONTEXT);
      expect(checkpoint.profile).toBe(
        "quiescent-current-documents-no-forks-v1",
      );
      expect(checkpoint.submissions[0]?.id).toBe(receipt.id);

      const destinationStorage = await openBunSqliteStorage(destinationPath);
      const imported = await importManagedWorkCheckpoint(
        destinationStorage,
        checkpoint,
      );
      expect(imported.rootConversationId).toBe(conversationId);
      expect(imported.imported).toBeGreaterThan(0);
      const destination = await ManagedPiWork.open({
        ...options,
        storage: destinationStorage,
      });
      try {
        expect(await destination.openRoot()).toBe(conversationId);
        expect(await destination.context()).toEqual(expected);
        expect((await destination.status()).inspection.tasks).toEqual([]);
        expect(
          (await destination.submit("checkpoint-request", "save this context"))
            .submissionId,
        ).toBe(receipt.id);
        expect(provider.requests()).toBe(1);
      } finally {
        await destination.close();
      }

      const corruptStorage = await openBunSqliteStorage(
        join(directory, "corrupt.sqlite"),
      );
      try {
        const damaged = structuredClone(checkpoint);
        damaged.sha256 = "00".repeat(32);
        await expect(
          importManagedWorkCheckpoint(corruptStorage, damaged),
        ).rejects.toThrow("checksum mismatch");
      } finally {
        await corruptStorage.close(BACKGROUND_CONTEXT);
      }
    } finally {
      await source.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a non-terminal task instead of exporting a runnable checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-checkpoint-active-"));
    const sourcePath = join(directory, "source.sqlite");
    const provider = deterministicModels();
    const registry = createRegistry();
    const PendingTask = defineTask<
      { value: string },
      { phase: "pending" },
      string
    >({
      name: "uzina.test.pending",
      version: 1,
      initial: () => ({ phase: "pending" }),
      phases: {
        pending: async () => undefined,
      },
      abort: async () => undefined,
    });
    registry.install({ name: "uzina.test.pending", tasks: [PendingTask] });
    let harness = await Harness.open(
      await openBunSqliteStorage(sourcePath),
      { models: provider.models, registry },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.commit(
        (tx) =>
          tx.createTask(
            PendingTask,
            { value: "still pending" },
            {
              ownership: { kind: "conversation" },
              conversationId: root.id,
            },
          ),
        BACKGROUND_CONTEXT,
      );
      await harness.close(BACKGROUND_CONTEXT);
      const reopenedStorage = await openBunSqliteStorage(sourcePath);
      await expect(
        exportManagedWorkCheckpoint(reopenedStorage, root.id),
      ).rejects.toBeInstanceOf(UnsupportedCheckpointState);
      await reopenedStorage.close(BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
});
