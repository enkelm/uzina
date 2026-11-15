import { mock } from "bun:test";
import type { PathLike } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { deterministicToolModels } from "../../../packages/pi-runtime/test-support/deterministic-tool-model";

interface ChildConfiguration {
  databasePath: string;
  runtimeDirectory: string;
  bootstrapSecret: string;
  catalogs: Readonly<Record<string, string>>;
  destinations: Readonly<Record<string, string>>;
  workspacePath: string;
  modelProvider: string;
  modelId: string;
}

async function isPresent(path: string): Promise<boolean> {
  try {
    await fsPromises.access(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

async function holdAfterRealOperation(
  gateDirectory: string,
  message: string,
): Promise<void> {
  await fsPromises.writeFile(join(gateDirectory, "reached"), message);
  while (!(await isPresent(join(gateDirectory, "release")))) {
    await new Promise((resolveGate) => setTimeout(resolveGate, 10));
  }
}

async function main(): Promise<void> {
  const encoded = process.env.UZINA_IMPORT_CHILD_CONFIG;
  if (!encoded) throw new Error("Missing owned import child configuration");
  const configuration = JSON.parse(encoded) as ChildConfiguration;
  const finalRenameTarget = process.env.UZINA_IMPORT_CHILD_FINAL_RENAME_TARGET;
  const finalRenameGate = process.env.UZINA_IMPORT_CHILD_FINAL_RENAME_GATE;
  const catalogOpenTarget = process.env.UZINA_IMPORT_CHILD_CATALOG_OPEN_TARGET;
  const catalogOpenGate = process.env.UZINA_IMPORT_CHILD_CATALOG_OPEN_GATE;
  const catalogChunkReadTarget =
    process.env.UZINA_IMPORT_CHILD_CATALOG_CHUNK_READ_TARGET;
  const catalogChunkReadGate =
    process.env.UZINA_IMPORT_CHILD_CATALOG_CHUNK_READ_GATE;
  const workspaceVerifyTarget =
    process.env.UZINA_IMPORT_CHILD_WORKSPACE_VERIFY_TARGET;
  const workspaceVerifyGate =
    process.env.UZINA_IMPORT_CHILD_WORKSPACE_VERIFY_GATE;
  const workspaceVerifyRoot =
    process.env.UZINA_IMPORT_CHILD_WORKSPACE_VERIFY_ROOT;
  const workspaceGrowthGate =
    process.env.UZINA_IMPORT_CHILD_WORKSPACE_GROWTH_GATE;
  const workspaceGrowthTarget =
    process.env.UZINA_IMPORT_CHILD_WORKSPACE_GROWTH_TARGET;
  const receiptMarkerProbeGate =
    process.env.UZINA_IMPORT_CHILD_RECEIPT_MARKER_PROBE_GATE;
  const receiptMarkerProbeTarget =
    process.env.UZINA_IMPORT_CHILD_RECEIPT_MARKER_PROBE_TARGET;
  const receiptMarkerProbeRoot =
    process.env.UZINA_IMPORT_CHILD_RECEIPT_MARKER_PROBE_ROOT;
  const preparedReceiptGate =
    process.env.UZINA_IMPORT_CHILD_PREPARED_RECEIPT_GATE;
  const preparedReceiptTarget =
    process.env.UZINA_IMPORT_CHILD_PREPARED_RECEIPT_TARGET;

  if (
    (finalRenameTarget && finalRenameGate) ||
    (catalogOpenTarget && catalogOpenGate) ||
    (catalogChunkReadTarget && catalogChunkReadGate) ||
    (workspaceVerifyTarget && workspaceVerifyGate && workspaceVerifyRoot) ||
    (workspaceGrowthTarget && workspaceGrowthGate) ||
    (receiptMarkerProbeTarget &&
      receiptMarkerProbeGate &&
      receiptMarkerProbeRoot) ||
    (preparedReceiptTarget && preparedReceiptGate)
  ) {
    const originalRename = fsPromises.rename;
    const originalOpen = fsPromises.open;
    const originalLstat = fsPromises.lstat;
    const originalReaddir = fsPromises.readdir;
    mock.module("node:fs/promises", () => ({
      ...fsPromises,
      async rename(source: PathLike, destination: PathLike) {
        await originalRename(source, destination);
        if (
          !finalRenameTarget ||
          !finalRenameGate ||
          resolve(destination.toString()) !== resolve(finalRenameTarget)
        ) {
          return;
        }
        await holdAfterRealOperation(
          finalRenameGate,
          "actual final rename completed\n",
        );
      },
      async lstat(...args: Parameters<typeof fsPromises.lstat>) {
        const path = args[0];
        const isChunkTarget =
          Boolean(catalogChunkReadTarget && catalogChunkReadGate) &&
          resolve(path.toString()) === resolve(catalogChunkReadTarget!);
        const isWorkspacePath =
          Boolean(workspaceVerifyRoot && workspaceVerifyGate) &&
          isWithin(workspaceVerifyRoot!, path.toString());
        const isReceiptMarkerProbePath =
          Boolean(receiptMarkerProbeRoot && receiptMarkerProbeGate) &&
          isWithin(receiptMarkerProbeRoot!, path.toString());
        const isReceiptMarkerProbeTarget =
          Boolean(receiptMarkerProbeTarget && receiptMarkerProbeGate) &&
          resolve(path.toString()) === resolve(receiptMarkerProbeTarget!);
        const isPreparedReceiptPath =
          Boolean(preparedReceiptTarget && preparedReceiptGate) &&
          resolve(path.toString()) === resolve(preparedReceiptTarget!);
        const gateDirectory = isPreparedReceiptPath
          ? preparedReceiptGate!
          : isChunkTarget
            ? catalogChunkReadGate!
            : isWorkspacePath
              ? workspaceVerifyGate!
              : isReceiptMarkerProbePath
                ? receiptMarkerProbeGate!
                : undefined;
        const revokedPath = gateDirectory
          ? join(gateDirectory, "revoked")
          : undefined;
        const startedAfterRevocation =
          revokedPath !== undefined && (await isPresent(revokedPath));
        if (startedAfterRevocation) {
          await fsPromises.appendFile(
            join(gateDirectory!, "native-results-after-revocation.jsonl"),
            `${JSON.stringify({
              operation: isPreparedReceiptPath
                ? "prepared-receipt-path-stat"
                : isReceiptMarkerProbePath
                  ? "receipt-marker-path-stat"
                  : "path-stat",
              phase: "start",
              afterRevocation: true,
              path: isReceiptMarkerProbePath
                ? relative(receiptMarkerProbeRoot!, resolve(path.toString()))
                : isPreparedReceiptPath
                  ? "prepared-restore.json"
                  : undefined,
            })}\n`,
          );
        }
        const result = await originalLstat(...args);
        if (isReceiptMarkerProbeTarget && !startedAfterRevocation) {
          await holdAfterRealOperation(
            receiptMarkerProbeGate!,
            "actual prepared metadata directory stat completed\n",
          );
        }
        if (revokedPath !== undefined && (await isPresent(revokedPath))) {
          if (!isReceiptMarkerProbePath || startedAfterRevocation) {
            await fsPromises.appendFile(
              join(gateDirectory!, "native-results-after-revocation.jsonl"),
              `${JSON.stringify({
                operation: isPreparedReceiptPath
                  ? "prepared-receipt-path-stat"
                  : isReceiptMarkerProbePath
                    ? "receipt-marker-path-stat"
                    : "path-stat",
                phase: "complete",
                afterRevocation: true,
                startedAfterRevocation,
                path: isReceiptMarkerProbePath
                  ? relative(receiptMarkerProbeRoot!, resolve(path.toString()))
                  : isPreparedReceiptPath
                    ? "prepared-restore.json"
                    : undefined,
              })}\n`,
            );
          }
        }
        return result;
      },
      async readdir(...args: Parameters<typeof fsPromises.readdir>) {
        const path = args[0];
        const isWorkspacePath =
          Boolean(workspaceVerifyRoot && workspaceVerifyGate) &&
          isWithin(workspaceVerifyRoot!, path.toString());
        const revokedPath = isWorkspacePath
          ? join(workspaceVerifyGate!, "revoked")
          : undefined;
        const startedAfterRevocation =
          revokedPath !== undefined && (await isPresent(revokedPath));
        if (startedAfterRevocation) {
          await fsPromises.appendFile(
            join(workspaceVerifyGate!, "native-results-after-revocation.jsonl"),
            `${JSON.stringify({
              operation: "directory-read",
              phase: "start",
              afterRevocation: true,
            })}\n`,
          );
        }
        const result = await originalReaddir(...args);
        if (revokedPath !== undefined && (await isPresent(revokedPath))) {
          await fsPromises.appendFile(
            join(workspaceVerifyGate!, "native-results-after-revocation.jsonl"),
            `${JSON.stringify({
              operation: "directory-read",
              phase: "complete",
              afterRevocation: true,
              startedAfterRevocation,
            })}\n`,
          );
        }
        return result;
      },
      async open(...args: Parameters<typeof fsPromises.open>) {
        const path = args[0];
        if (
          workspaceVerifyRoot &&
          workspaceVerifyGate &&
          isWithin(workspaceVerifyRoot, path.toString()) &&
          (await isPresent(join(workspaceVerifyGate, "revoked")))
        ) {
          await fsPromises.appendFile(
            join(workspaceVerifyGate, "native-results-after-revocation.jsonl"),
            `${JSON.stringify({
              operation: "workspace-open",
              phase: "start",
              afterRevocation: true,
              path: relative(workspaceVerifyRoot, resolve(path.toString())),
            })}\n`,
          );
        }
        const file = await originalOpen(...args);
        const isCatalogOpenTarget =
          Boolean(catalogOpenTarget && catalogOpenGate) &&
          resolve(path.toString()) === resolve(catalogOpenTarget!);
        const isCatalogChunkTarget =
          Boolean(catalogChunkReadTarget && catalogChunkReadGate) &&
          resolve(path.toString()) === resolve(catalogChunkReadTarget!);
        const isWorkspaceVerifyTarget =
          Boolean(workspaceVerifyTarget && workspaceVerifyGate) &&
          resolve(path.toString()) === resolve(workspaceVerifyTarget!);
        const isWorkspaceGrowthTarget =
          Boolean(workspaceGrowthTarget && workspaceGrowthGate) &&
          resolve(path.toString()) === resolve(workspaceGrowthTarget!);
        const isPreparedReceiptTarget =
          Boolean(preparedReceiptTarget && preparedReceiptGate) &&
          resolve(path.toString()) === resolve(preparedReceiptTarget!);
        if (
          !isCatalogOpenTarget &&
          !isCatalogChunkTarget &&
          !isWorkspaceVerifyTarget &&
          !isWorkspaceGrowthTarget &&
          !isPreparedReceiptTarget
        ) {
          return file;
        }

        const gateDirectory = isPreparedReceiptTarget
          ? preparedReceiptGate!
          : isWorkspaceVerifyTarget
            ? workspaceVerifyGate!
            : isWorkspaceGrowthTarget
              ? workspaceGrowthGate!
              : isCatalogChunkTarget
                ? catalogChunkReadGate!
                : catalogOpenGate!;
        const revokedPath = join(gateDirectory, "revoked");
        const observationsPath = join(
          gateDirectory,
          "native-results-after-revocation.jsonl",
        );
        let firstChunkHeld = false;
        const proxy = new Proxy(file, {
          get(target, property) {
            const operation = Reflect.get(target, property, target);
            if (
              typeof operation !== "function" ||
              !["stat", "read", "readFile", "close"].includes(String(property))
            ) {
              return typeof operation === "function"
                ? operation.bind(target)
                : operation;
            }
            return async (...operationArgs: unknown[]) => {
              const startedAfterRevocation =
                ((isCatalogChunkTarget && property === "read") ||
                  (isWorkspaceVerifyTarget && property === "read") ||
                  (isPreparedReceiptTarget &&
                    (property === "stat" || property === "read"))) &&
                (await isPresent(revokedPath));
              if (startedAfterRevocation) {
                await fsPromises.appendFile(
                  observationsPath,
                  `${JSON.stringify({
                    operation: isPreparedReceiptTarget
                      ? property === "stat"
                        ? "prepared-receipt-stat"
                        : "prepared-receipt-read"
                      : "read",
                    phase: "start",
                    afterRevocation: true,
                  })}\n`,
                );
              }
              const result = await Reflect.apply(
                operation,
                target,
                operationArgs,
              );
              const completedAfterRevocation = await isPresent(revokedPath);
              if (
                isCatalogChunkTarget &&
                property === "read" &&
                !firstChunkHeld &&
                (result as { bytesRead: number }).bytesRead > 0
              ) {
                firstChunkHeld = true;
                await holdAfterRealOperation(
                  gateDirectory,
                  `actual first catalog chunk completed: ${(result as { bytesRead: number }).bytesRead}\n`,
                );
              }
              if (
                isWorkspaceVerifyTarget &&
                (property === "read" || property === "readFile") &&
                !firstChunkHeld
              ) {
                const bytesRead =
                  property === "read"
                    ? (result as { bytesRead: number }).bytesRead
                    : Buffer.isBuffer(result)
                      ? result.byteLength
                      : new Uint8Array(result as ArrayBufferLike).byteLength;
                if (bytesRead > 0) {
                  firstChunkHeld = true;
                  await holdAfterRealOperation(
                    gateDirectory,
                    `actual prepared workspace ${property === "read" ? "chunk " : ""}read completed: ${bytesRead}\n`,
                  );
                }
              }
              if (isWorkspaceGrowthTarget) {
                const operationObservation =
                  property === "read"
                    ? {
                        operation: "read",
                        requestedBytes:
                          typeof operationArgs[2] === "number"
                            ? operationArgs[2]
                            : null,
                        bytesRead: (result as { bytesRead: number }).bytesRead,
                      }
                    : property === "readFile"
                      ? {
                          operation: "readFile",
                          bytesRead: Buffer.isBuffer(result)
                            ? result.byteLength
                            : new Uint8Array(result as ArrayBufferLike)
                                .byteLength,
                        }
                      : undefined;
                if (operationObservation) {
                  await fsPromises.appendFile(
                    join(gateDirectory, "workspace-read-observations.jsonl"),
                    `${JSON.stringify(operationObservation)}\n`,
                  );
                }
              }
              if (
                isWorkspaceGrowthTarget &&
                property === "stat" &&
                !firstChunkHeld
              ) {
                firstChunkHeld = true;
                const stats = result as { size: number };
                await holdAfterRealOperation(
                  gateDirectory,
                  `actual prepared workspace descriptor stat completed: ${stats.size}\n`,
                );
              }
              if (
                (isCatalogChunkTarget && completedAfterRevocation) ||
                (isCatalogOpenTarget && completedAfterRevocation) ||
                (isWorkspaceVerifyTarget && completedAfterRevocation) ||
                (isPreparedReceiptTarget && completedAfterRevocation)
              ) {
                let observation: Record<string, unknown>;
                if (property === "stat") {
                  const stats = result as {
                    dev: number;
                    ino: number;
                    size: number;
                  };
                  observation = {
                    operation: "stat",
                    dev: stats.dev,
                    ino: stats.ino,
                    size: stats.size,
                  };
                } else if (property === "read") {
                  observation = isCatalogChunkTarget
                    ? {
                        operation: "read",
                        phase: "complete",
                        afterRevocation: true,
                        startedAfterRevocation,
                        bytesRead: (result as { bytesRead: number }).bytesRead,
                      }
                    : {
                        operation: "read",
                        bytesRead: (result as { bytesRead: number }).bytesRead,
                      };
                } else if (property === "readFile") {
                  observation = {
                    operation: "read-file",
                    bytesRead: Buffer.isBuffer(result)
                      ? result.byteLength
                      : new Uint8Array(result as ArrayBufferLike).byteLength,
                  };
                } else {
                  observation = { operation: "close", completed: true };
                }
                await fsPromises.appendFile(
                  observationsPath,
                  `${JSON.stringify(observation)}\n`,
                );
              }
              return result;
            };
          },
        });
        if (isCatalogOpenTarget) {
          await holdAfterRealOperation(
            gateDirectory,
            "actual catalog descriptor opened\n",
          );
        }
        if (isPreparedReceiptTarget) {
          await holdAfterRealOperation(
            gateDirectory,
            "actual prepared receipt descriptor opened\n",
          );
        }
        return proxy;
      },
    }));
  }

  const model = deterministicToolModels({
    providerId: configuration.modelProvider,
    modelId: configuration.modelId,
    toolName: "remote_write_file",
    arguments: { path: "unused-by-import-child.txt", content: "unused" },
  });
  const { createStandaloneFactoryServer } =
    await import("../src/factory/standalone");
  const host = await createStandaloneFactoryServer({
    databasePath: configuration.databasePath,
    runtimeDirectory: configuration.runtimeDirectory,
    bootstrapSecret: configuration.bootstrapSecret,
    models: model.models,
    modelProvider: configuration.modelProvider,
    modelId: configuration.modelId,
    managedWorkImportCatalogs: configuration.catalogs,
    managedWorkImportDestinations: configuration.destinations,
    workspaceDirectories: {
      "workspace:local-proof": configuration.workspacePath,
    },
    port: 0,
  });
  const statsPath = process.env.UZINA_IMPORT_CHILD_STATS;
  let closing = false;
  process.once("SIGTERM", () => {
    if (closing) return;
    closing = true;
    void host
      .close()
      .then(async () => {
        if (statsPath) {
          await fsPromises.writeFile(statsPath, String(model.requests()), {
            flag: "wx",
          });
        }
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  });
  process.stdout.write(
    `RECOVERY_CHILD_READY ${JSON.stringify({ url: host.server.url.toString() })}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
