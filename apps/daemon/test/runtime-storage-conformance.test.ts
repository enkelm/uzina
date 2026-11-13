import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, test } from "bun:test";
import { piStorageAssertions } from "../../../packages/pi-runtime/test-support/assertions";
import { openBunSqliteStorage } from "../src/runtime/sqlite";

const cases = createStorageConformance({
  assertions: piStorageAssertions,
  withStorage: async (use) => {
    const storage = await openBunSqliteStorage(":memory:");
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
});

describe("Bun SQLite Pi Durable storage conformance", () => {
  for (const conformance of cases) {
    test(conformance.name, conformance.run);
  }
});
