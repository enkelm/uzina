import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FactoryDatabase, SqlRow, SqlValue } from "@uzina/core/database";

/** Local persistent Factory coordination store. Closing and reopening preserves receipts, jobs, and cursors. */
export class BunFactoryDatabase implements FactoryDatabase {
  readonly #database: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new Database(path, { create: true });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA busy_timeout = 5000");
  }

  exec(query: string, values: readonly SqlValue[] = []): void {
    if (values.length === 0) {
      this.#database.exec(query);
      return;
    }
    this.#database.query(query).run(...values);
  }

  all<T extends SqlRow = SqlRow>(
    query: string,
    values: readonly SqlValue[] = [],
  ): T[] {
    return this.#database.query(query).all(...values) as T[];
  }

  transaction<T>(operation: () => T): T {
    return this.#database.transaction(operation)();
  }

  close(): void {
    this.#database.close();
  }
}
