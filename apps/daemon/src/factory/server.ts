import { FactoryService } from "@uzina/core";
import { createFactoryHttpHandler } from "@uzina/core/http";
import { BunFactoryDatabase } from "./sqlite";

export interface LocalFactoryServer {
  server: ReturnType<typeof Bun.serve>;
  factory: FactoryService;
  database: BunFactoryDatabase;
  close(force?: boolean): void;
}

export function createLocalFactoryServer(options: {
  databasePath: string;
  bootstrapSecret?: string;
  port?: number;
  hostname?: string;
}): LocalFactoryServer {
  const database = new BunFactoryDatabase(options.databasePath);
  const factory = new FactoryService(database, options.bootstrapSecret);
  const server = Bun.serve({
    port: options.port ?? 8788,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: createFactoryHttpHandler(factory),
  });
  return {
    server,
    factory,
    database,
    close(force = true) {
      server.stop(force);
      database.close();
    },
  };
}
