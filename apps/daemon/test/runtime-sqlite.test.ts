import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { BunSqliteDatabase } from "../src/runtime/sqlite";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Bun SQLite async facade", () => {
  test("preserves BLOB and integer bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-sqlite-bindings-"));
    const database = await BunSqliteDatabase.open(
      join(directory, "data.sqlite"),
    );
    try {
      await database.exec(
        "CREATE TABLE binding_test (id INTEGER, payload BLOB)",
      );
      const bytes = new Uint8Array([0, 1, 127, 255]);
      await database.run("INSERT INTO binding_test VALUES (?, ?)", 42n, bytes);
      const row = await database.get<{
        id: number | bigint;
        payload: Uint8Array;
      }>("SELECT id, payload FROM binding_test");
      expect(row?.id).toBe(42);
      expect(row?.payload).toEqual(bytes);
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes unrelated operations and scopes transaction handles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-sqlite-queue-"));
    const database = await BunSqliteDatabase.open(
      join(directory, "data.sqlite"),
    );
    const entered = deferred();
    const release = deferred();
    let transactionExecutor:
      Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
    try {
      await database.exec("CREATE TABLE queue_test (value INTEGER)");
      const transaction = database.transaction(async (executor) => {
        transactionExecutor = executor;
        await executor.run("INSERT INTO queue_test VALUES (1)");
        entered.resolve();
        await release.promise;
        await executor.run("INSERT INTO queue_test VALUES (2)");
      });
      await entered.promise;
      let outsideFinished = false;
      const outside = database
        .run("INSERT INTO queue_test VALUES (3)")
        .then(() => {
          outsideFinished = true;
        });
      await Promise.resolve();
      expect(outsideFinished).toBe(false);
      release.resolve();
      await Promise.all([transaction, outside]);
      expect(
        await database.all("SELECT value FROM queue_test ORDER BY value"),
      ).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
      await expect(
        transactionExecutor?.run("INSERT INTO queue_test VALUES (4)"),
      ).rejects.toThrow("no longer active");
    } finally {
      release.resolve();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back with the callback error and can be reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-sqlite-rollback-"));
    const path = join(directory, "data.sqlite");
    const database = await BunSqliteDatabase.open(path);
    const failure = new Error("abort this transaction");
    try {
      await database.exec("CREATE TABLE rollback_test (value INTEGER)");
      await expect(
        database.transaction(async (transaction) => {
          await transaction.run("INSERT INTO rollback_test VALUES (9)");
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(
        await database.get("SELECT value FROM rollback_test"),
      ).toBeUndefined();
    } finally {
      await database.close();
    }

    const reopened = await BunSqliteDatabase.open(path);
    try {
      expect(
        await reopened.get("SELECT value FROM rollback_test"),
      ).toBeUndefined();
    } finally {
      await reopened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
