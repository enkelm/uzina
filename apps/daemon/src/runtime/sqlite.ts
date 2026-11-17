import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/chord/sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteStorageOptions } from "@earendil-works/pi-durable/storage/sqlite";

/** Bun's synchronous SQLite connection behind Pi Durable's asynchronous contract. */
export class BunSqliteDatabase implements SqliteDatabase {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private closeResult: Promise<void> | undefined;

  private constructor(private readonly database: Database) {}

  static async open(path: string): Promise<BunSqliteDatabase> {
    const filename = path === ":memory:" ? path : resolve(path);
    if (filename !== ":memory:")
      await mkdir(dirname(filename), { recursive: true });
    return new BunSqliteDatabase(new Database(filename, { create: true }));
  }

  exec(sql: string): Promise<void> {
    return this.enqueue(() => {
      this.database.exec(sql);
    });
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.enqueue(() => {
      this.database.query(sql).run(...params);
    });
  }

  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.enqueue(() => this.database.query(sql).run(...params).changes);
  }

  get<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T | undefined> {
    return this.enqueue(() => {
      const row = this.database.query(sql).get(...params);
      return row === null ? undefined : (row as T | undefined);
    });
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.enqueue(() => this.database.query(sql).all(...params) as T[]);
  }

  transaction<T>(
    callback: (transaction: SqliteExecutor) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      let active = true;
      const assertActive = () => {
        if (!active)
          throw new Error("SQLite transaction executor is no longer active");
      };
      const transaction: SqliteExecutor = {
        exec: async (sql) => {
          assertActive();
          this.database.exec(sql);
        },
        run: async (sql, ...params) => {
          assertActive();
          this.database.query(sql).run(...params);
        },
        runCounted: async (sql, ...params) => {
          assertActive();
          return this.database.query(sql).run(...params).changes;
        },
        get: async <Row extends object>(
          sql: string,
          ...params: SqliteValue[]
        ) => {
          assertActive();
          const row = this.database.query(sql).get(...params);
          return row === null ? undefined : (row as Row | undefined);
        },
        all: async <Row extends object>(
          sql: string,
          ...params: SqliteValue[]
        ) => {
          assertActive();
          return this.database.query(sql).all(...params) as Row[];
        },
      };

      try {
        const result = await callback(transaction);
        active = false;
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        active = false;
        try {
          this.database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite transaction failed and rollback could not be confirmed",
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closing = true;
    const closing = this.tail.then(() => {
      if (this.closed) return;
      this.database.close();
      this.closed = true;
    });
    this.tail = closing.then(
      () => undefined,
      () => undefined,
    );
    this.closeResult = closing;
    return closing;
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error("SQLite database is closed"));
    }
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function openBunSqliteStorage(
  path: string,
  options?: SqliteStorageOptions,
): Promise<SqliteStorage> {
  return SqliteStorage.open(await BunSqliteDatabase.open(path), options);
}
