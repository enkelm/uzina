import { FactoryService } from "@uzina/core";
import { createFactoryHttpHandler } from "@uzina/core/http";
import { FileWorkspaceSnapshotStorage } from "./snapshot-storage";
import { BunFactoryDatabase } from "./sqlite";
import { assertLoopbackHostname } from "../loopback";

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
  assertLoopbackHostname(options.hostname ?? "127.0.0.1");
  const database = new BunFactoryDatabase(options.databasePath);
  const factory = new FactoryService(database, options.bootstrapSecret);
  const snapshotStorage = new FileWorkspaceSnapshotStorage(
    `${options.databasePath}.workspace-checkpoints`,
  );
  const server = Bun.serve({
    port: options.port ?? 8788,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: createFactoryHttpHandler(
      factory,
      undefined,
      undefined,
      snapshotStorage,
    ),
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
