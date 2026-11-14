import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type DocumentId,
  type EntryId,
  type StorageWrite,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import {
  exportManagedWorkCheckpoint,
  prepareManagedWorkCheckpointArtifact,
  UnsupportedCheckpointState,
} from "@uzina/pi-runtime/checkpoint";
import { afterEach, describe, expect, test } from "bun:test";
import { openBunSqliteStorage } from "../src/runtime/sqlite";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "uzina-checkpoint-export-"));
  directories.push(path);
  return path;
}

function entries(count: number): StorageWrite[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "entry" as const,
    value: {
      id: (index + 2) as EntryId,
      conversationId: ROOT_CONVERSATION_ID,
      kind: "checkpoint-export-test",
      model: [
        {
          role: "user" as const,
          content: `entry ${index} ${"x".repeat(128)}`,
          timestamp: index,
        },
      ],
    },
  }));
}

describe("public managed-work storage export bounds", () => {
  test("exports a genuine multi-page SQLite root under a finite byte and record budget", async () => {
    const storage = await openBunSqliteStorage(
      join(await directory(), "source.sqlite"),
    );
    try {
      await storage.commit(
        [
          {
            type: "conversation",
            value: { id: ROOT_CONVERSATION_ID },
          },
          ...entries(260),
          {
            type: "document.create",
            record: {
              id: 262 as DocumentId,
              kind: "capture-export-counter",
              history: "latest",
              fork: "current",
              scope: {
                kind: "conversation",
                conversationId: ROOT_CONVERSATION_ID,
              },
            },
            content: { kind: "base", version: 1, value: { count: 260 } },
          },
        ],
        BACKGROUND_CONTEXT,
      );

      const checkpoint = await exportManagedWorkCheckpoint(
        storage,
        ROOT_CONVERSATION_ID,
        BACKGROUND_CONTEXT,
        { maxRecords: 262 },
      );
      expect(checkpoint.entries).toHaveLength(260);
      expect(checkpoint.documents).toHaveLength(1);
      expect(checkpoint.documents[0]?.value).toEqual({ count: 260 });
      const artifact = await prepareManagedWorkCheckpointArtifact(
        checkpoint,
        256 * 1024,
      );
      expect(artifact.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);

      await expect(
        exportManagedWorkCheckpoint(
          storage,
          ROOT_CONVERSATION_ID,
          BACKGROUND_CONTEXT,
          { maxRecords: 128 },
        ),
      ).rejects.toBeInstanceOf(UnsupportedCheckpointState);
      await expect(
        exportManagedWorkCheckpoint(
          storage,
          ROOT_CONVERSATION_ID,
          BACKGROUND_CONTEXT,
          { maxBytes: 1024 },
        ),
      ).rejects.toThrow("storage scan exceeds its byte limit");
      await expect(
        exportManagedWorkCheckpoint(
          storage,
          ROOT_CONVERSATION_ID,
          BACKGROUND_CONTEXT,
          { maxBytes: 32 * 1024 * 1024 + 1 },
        ),
      ).rejects.toThrow("exceed the bounded profile");
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  test("refuses an uncreated root and a persisted nonterminal task", async () => {
    const absent = await openBunSqliteStorage(
      join(await directory(), "absent.sqlite"),
    );
    try {
      await expect(
        exportManagedWorkCheckpoint(absent, ROOT_CONVERSATION_ID),
      ).rejects.toThrow("Conversation 1 was not found");
    } finally {
      await absent.close(BACKGROUND_CONTEXT);
    }

    const active = await openBunSqliteStorage(
      join(await directory(), "active.sqlite"),
    );
    try {
      await active.commit(
        [
          {
            type: "conversation",
            value: { id: ROOT_CONVERSATION_ID },
          },
          {
            type: "task",
            value: {
              id: 2 as TaskId<JsonValue>,
              conversationId: ROOT_CONVERSATION_ID,
              kind: "capture-export-test",
              version: 1,
              input: {},
              background: false,
              abortRequested: false,
              state: { status: "pending", checkpoint: {} },
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      await expect(
        exportManagedWorkCheckpoint(active, ROOT_CONVERSATION_ID),
      ).rejects.toThrow("Task 2 is pending");
    } finally {
      await active.close(BACKGROUND_CONTEXT);
    }
  });

  test("refuses alternate roots and records outside the supported owned closure", async () => {
    const pendingTask: StorageWrite = {
      type: "task",
      value: {
        id: 3 as TaskId<JsonValue>,
        conversationId: 2 as ConversationId,
        kind: "capture-export-test",
        version: 1,
        input: {},
        background: false,
        abortRequested: false,
        state: { status: "pending", checkpoint: {} },
      },
    };
    const cases: StorageWrite[][] = [
      [
        { type: "conversation", value: { id: 2 as ConversationId } },
        pendingTask,
      ],
      [pendingTask],
      [
        {
          type: "submission",
          value: {
            id: 3 as SubmissionId,
            conversationId: 2 as ConversationId,
            type: "input",
            requestId: "request:outside-root",
            status: "queued",
          },
        },
      ],
    ];
    for (const writes of cases) {
      const storage = await openBunSqliteStorage(
        join(await directory(), "outside-root.sqlite"),
      );
      try {
        await storage.commit(
          [
            { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
            ...writes,
          ],
          BACKGROUND_CONTEXT,
        );
        await expect(
          exportManagedWorkCheckpoint(storage, ROOT_CONVERSATION_ID),
        ).rejects.toThrow("outside the supported root and owned closure");
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    }
  });

  test("refuses owned forks and session-scoped documents", async () => {
    const forked = await openBunSqliteStorage(
      join(await directory(), "forked.sqlite"),
    );
    try {
      await forked.commit(
        [
          {
            type: "conversation",
            value: { id: ROOT_CONVERSATION_ID },
          },
          {
            type: "task",
            value: {
              id: 2 as TaskId<JsonValue>,
              conversationId: ROOT_CONVERSATION_ID,
              kind: "capture-export-test",
              version: 1,
              input: {},
              background: false,
              abortRequested: false,
              state: {
                status: "terminal",
                outcome: { status: "completed", result: null },
              },
            },
          },
          {
            type: "conversation",
            value: {
              id: 3 as ConversationId,
              parent: {
                conversationId: ROOT_CONVERSATION_ID,
                at: 4 as EntryId,
              },
              owner: {
                conversationId: ROOT_CONVERSATION_ID,
                taskId: 2 as TaskId<JsonValue>,
              },
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      await expect(
        exportManagedWorkCheckpoint(forked, ROOT_CONVERSATION_ID),
      ).rejects.toThrow("Owned fork conversations are not supported");
    } finally {
      await forked.close(BACKGROUND_CONTEXT);
    }

    const sessionScoped = await openBunSqliteStorage(
      join(await directory(), "session-document.sqlite"),
    );
    try {
      await sessionScoped.commit(
        [
          {
            type: "conversation",
            value: { id: ROOT_CONVERSATION_ID },
          },
          {
            type: "document.create",
            record: {
              id: 2 as DocumentId,
              kind: "capture-export-test",
              scope: { kind: "session" },
            },
            content: {
              kind: "base",
              version: 1,
              value: { private: false },
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      await expect(
        exportManagedWorkCheckpoint(sessionScoped, ROOT_CONVERSATION_ID),
      ).rejects.toThrow("Session-scoped documents cannot be assigned");
    } finally {
      await sessionScoped.close(BACKGROUND_CONTEXT);
    }
  });
});
