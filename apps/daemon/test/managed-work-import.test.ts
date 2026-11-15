import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { createStandaloneManagedWorkImportHost } from "../src/factory/managed-work-import";

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "uzina-import-roots-"));
  directories.push(directory);
  const catalog = join(directory, "catalog");
  const destinationParent = join(directory, "destinations");
  const runtime = join(directory, "runtime");
  await Promise.all([mkdir(catalog), mkdir(destinationParent), mkdir(runtime)]);
  return { directory, catalog, destinationParent, runtime };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("standalone managed-work import root resolution", () => {
  test("rejects destination roots nested under every protected local root", async () => {
    const paths = await fixture();
    const protectedRoots = [
      { path: "managed-work", kind: "directory" },
      {
        path: "managed-work/private-assistant",
        kind: "directory",
      },
      { path: "snapshots", kind: "directory" },
      { path: "workspace", kind: "directory" },
      { path: "factory.sqlite", kind: "file" },
      { path: "factory.sqlite-wal", kind: "file" },
      { path: "factory.sqlite-shm", kind: "file" },
      { path: "factory.sqlite-journal", kind: "file" },
    ] as const;

    for (const [
      index,
      { path: relativePath, kind },
    ] of protectedRoots.entries()) {
      const destinationRoot = join(paths.directory, `candidate-${index}`);
      const localRoot = join(destinationRoot, relativePath);
      await mkdir(destinationRoot);
      if (kind === "directory") {
        await mkdir(localRoot, { recursive: true });
      } else {
        await writeFile(localRoot, "protected local file\n");
      }
      await expect(
        createStandaloneManagedWorkImportHost({
          catalogs: { "catalog:local": paths.catalog },
          destinations: { "destination:local": destinationRoot },
          localRoots: [localRoot],
          supportedRuntimeRequirements: [],
          supportedModel: { provider: "test", modelId: "model" },
          supportedToolNames: [],
        }),
      ).rejects.toThrow("outside local runtime");
    }
  });

  test("rejects configured catalog and destination roots that are symlinks", async () => {
    const paths = await fixture();
    const catalogAlias = join(paths.directory, "catalog-alias");
    const destinationAlias = join(paths.directory, "destination-alias");
    await symlink(paths.catalog, catalogAlias);
    await mkdir(join(paths.directory, "real-destination"));
    await symlink(join(paths.directory, "real-destination"), destinationAlias);

    await expect(
      createStandaloneManagedWorkImportHost({
        catalogs: { "catalog:local": catalogAlias },
        destinations: {
          "destination:local": join(paths.destinationParent, "slot"),
        },
        localRoots: [paths.runtime],
        supportedRuntimeRequirements: [],
        supportedModel: { provider: "test", modelId: "model" },
        supportedToolNames: [],
      }),
    ).rejects.toThrow("catalog must be a real directory");
    await expect(
      createStandaloneManagedWorkImportHost({
        catalogs: { "catalog:local": paths.catalog },
        destinations: { "destination:local": destinationAlias },
        localRoots: [paths.runtime],
        supportedRuntimeRequirements: [],
        supportedModel: { provider: "test", modelId: "model" },
        supportedToolNames: [],
      }),
    ).rejects.toThrow("destination must be a real directory");
  });

  test("rejects equal and projected catalog/destination roots", async () => {
    const paths = await fixture();
    const isolatedRuntime = join(paths.directory, "isolated-runtime");
    const outerCatalog = join(paths.directory, "catalog-container");
    const innerCatalog = join(outerCatalog, "source");
    await Promise.all([
      mkdir(isolatedRuntime),
      mkdir(innerCatalog, { recursive: true }),
    ]);
    const createHost = (catalog: string, destination: string) =>
      createStandaloneManagedWorkImportHost({
        catalogs: { "catalog:overlap": catalog },
        destinations: { "destination:overlap": destination },
        localRoots: [isolatedRuntime],
        supportedRuntimeRequirements: [],
        supportedModel: { provider: "test", modelId: "model" },
        supportedToolNames: [],
      });

    await expect(createHost(paths.catalog, paths.catalog)).rejects.toThrow(
      "catalog and destination roots must not overlap",
    );
    await expect(
      createHost(paths.catalog, join(paths.catalog, "prepared")),
    ).rejects.toThrow("catalog and destination roots must not overlap");
    await expect(createHost(innerCatalog, outerCatalog)).rejects.toThrow(
      "catalog and destination roots must not overlap",
    );
    await expect(
      createHost(
        innerCatalog,
        join(outerCatalog, "temporary", "..", "source", "prepared"),
      ),
    ).rejects.toThrow("catalog and destination roots must not overlap");
  });

  test("rejects physical root overlap even when one root is an ancestor", async () => {
    const paths = await fixture();
    const shared = join(paths.directory, "shared");
    await mkdir(shared);
    await mkdir(join(shared, "prepared"));
    await expect(
      createStandaloneManagedWorkImportHost({
        catalogs: { "catalog:local": paths.catalog },
        destinations: {
          "destination:local": join(shared, "prepared", "slot"),
        },
        localRoots: [shared],
        supportedRuntimeRequirements: [],
        supportedModel: { provider: "test", modelId: "model" },
        supportedToolNames: [],
      }),
    ).rejects.toThrow("outside local runtime");
  });
});
