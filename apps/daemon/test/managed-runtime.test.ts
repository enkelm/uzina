import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineTask,
  Harness,
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
