import { FactoryService } from "@uzina/core";
import { createFactoryHttpHandler } from "@uzina/core/http";
import type { FactoryDatabase, SqlRow, SqlValue } from "@uzina/core/database";

interface DurableSqlCursor<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends Iterable<T> {
  toArray(): T[];
}

interface DurableSqlStorage {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...values: SqlValue[]
  ): DurableSqlCursor<T>;
}

interface FactoryDurableObjectStorage {
  sql: DurableSqlStorage;
  transactionSync<T>(operation: () => T): T;
}

interface FactoryDurableObjectState {
  storage: FactoryDurableObjectStorage;
}

export interface FactoryDurableObjectEnvironment {
  UZINA_BOOTSTRAP_SECRET?: string;
}

class DurableObjectFactoryDatabase implements FactoryDatabase {
  constructor(private readonly storage: FactoryDurableObjectStorage) {}

  exec(query: string, values: readonly SqlValue[] = []): void {
    this.storage.sql.exec(query, ...values);
  }

  all<T extends SqlRow = SqlRow>(
    query: string,
    values: readonly SqlValue[] = [],
  ): T[] {
    return this.storage.sql.exec<T>(query, ...values).toArray();
  }

  transaction<T>(operation: () => T): T {
    return this.storage.transactionSync(operation);
  }
}

/** Cloudflare Durable Object composition; execution/runtime services remain injected at integration. */
export class FactoryObject {
  readonly #handle: (request: Request) => Promise<Response>;

  constructor(
    state: FactoryDurableObjectState,
    environment: FactoryDurableObjectEnvironment,
  ) {
    const factory = new FactoryService(
      new DurableObjectFactoryDatabase(state.storage),
      environment.UZINA_BOOTSTRAP_SECRET,
    );
    this.#handle = createFactoryHttpHandler(factory);
  }

  fetch(request: Request): Promise<Response> {
    return this.#handle(request);
  }
}
