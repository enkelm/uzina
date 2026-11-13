import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import {
  captureManagedWorkBundle,
  type BlobTransport,
  type CapturedManagedWorkBundle,
} from "@uzina/checkpoints";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createManagedRemoteToolExecutor,
  type ManagedModels,
  type ManagedPiWork,
} from "@uzina/pi-runtime";
import { createFactoryHttpHandler } from "@uzina/core/http";
import { FactoryService } from "@uzina/core";
import { BunFactoryDatabase } from "./sqlite";
import type { FactoryQueueJob } from "@uzina/contracts/factory";
import { openLocalManagedPiWork } from "../runtime/managed-work";

export interface StandaloneFactoryServer {
  server: ReturnType<typeof Bun.serve>;
  factory: FactoryService;
  database: BunFactoryDatabase;
  captureManagedWorkCheckpoint(input: {
    credential: string;
    threadId: string;
    transport: BlobTransport;
  }): Promise<CapturedManagedWorkBundle & { captureId: string }>;
  close(force?: boolean): Promise<void>;
}

export type StandaloneFactoryOptions = {
  databasePath?: string;
  runtimeDirectory?: string;
  bootstrapSecret: string;
  models: ManagedModels;
  modelProvider: string;
  modelId: string;
  port?: number;
  hostname?: string;
  /** Trusted local mappings; capture refuses ambiguous physical workspace aliases. */
  workspaceDirectories?: Readonly<Record<string, string>>;
  /** Must durably quiesce the selected local/remote writer and supported Rex activity. */
  workspaceCaptureQuiescence?: {
    acquire(
      workspaceId: string,
      captureId: string,
    ): Promise<{
      workspacePath: string;
      release(): void | Promise<void>;
    }>;
  };
};

function stableFilePart(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function localFactoryDefaults() {
  const data = join(homedir(), ".local", "share", "uzina");
  return {
    databasePath: join(data, "factory.sqlite"),
    runtimeDirectory: join(data, "managed-work"),
  };
}

export async function createStandaloneFactoryServer(
  options: StandaloneFactoryOptions,
): Promise<StandaloneFactoryServer> {
  if (!options.bootstrapSecret.trim()) {
    throw new Error("Standalone Factory requires UZINA_BOOTSTRAP_SECRET");
  }
  const defaults = localFactoryDefaults();
  const databasePath = resolve(options.databasePath ?? defaults.databasePath);
  const runtimeDirectory = resolve(
    options.runtimeDirectory ?? defaults.runtimeDirectory,
  );
  mkdirSync(runtimeDirectory, { recursive: true });
  if (!options.models.getModel(options.modelProvider, options.modelId)) {
    throw new Error(
      "Standalone Factory model is absent from the configured provider catalog",
    );
  }
  const database = new BunFactoryDatabase(databasePath);
  const factory = new FactoryService(database, options.bootstrapSecret);
  const work = new Map<string, ManagedPiWork>();
  const opening = new Map<string, Promise<ManagedPiWork>>();
  let dispatching: Promise<void> | undefined;
  let drainRequested = false;
  let activeCaptures = 0;
  let closing = false;
  const captureWaiters: Array<() => void> = [];

  const openWork = async (
    threadId: string,
    resume = true,
  ): Promise<ManagedPiWork> => {
    const current = work.get(threadId);
    if (current) return current;
    const inFlight = opening.get(threadId);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const runtimePath = join(
        runtimeDirectory,
        `${stableFilePart(threadId)}.sqlite`,
      );
      const opened = await openLocalManagedPiWork(runtimePath, {
        models: options.models,
        agent: {
          model: {
            provider: options.modelProvider,
            modelId: options.modelId,
          },
        },
        toolExecutor: createManagedRemoteToolExecutor(threadId, {
          enqueue: (selectedThreadId, identity, operation) =>
            factory.enqueueManagedRemoteExecution(
              selectedThreadId,
              identity.taskId,
              identity.callId,
              operation,
            ),
          receipt: (jobId) => factory.getRemoteExecutionReceipt(jobId),
          markUncertain: (jobId, detail) =>
            factory.markManagedEffectUncertain(jobId, detail),
        }),
      });
      try {
        if (resume && !factory.isManagedWorkCapturing(threadId)) {
          await opened.resume();
        }
        work.set(threadId, opened);
        return opened;
      } catch (error) {
        await opened.close().catch(() => {});
        throw error;
      }
    })();
    opening.set(threadId, pending);
    try {
      return await pending;
    } finally {
      if (opening.get(threadId) === pending) opening.delete(threadId);
    }
  };

  const handler = createFactoryHttpHandler(factory, {
    async context(threadId) {
      const runtimePath = join(
        runtimeDirectory,
        `${stableFilePart(threadId)}.sqlite`,
      );
      if (!existsSync(runtimePath)) {
        throw new Error("Managed Pi work has not been created for this thread");
      }
      return (await openWork(threadId)).context();
    },
    async status(threadId) {
      const runtimePath = join(
        runtimeDirectory,
        `${stableFilePart(threadId)}.sqlite`,
      );
      if (!existsSync(runtimePath)) return { status: "not-created" };
      return (await openWork(threadId)).status();
    },
  });

  const dispatch = async (input: FactoryQueueJob) => {
    const managed = await openWork(input.threadId);
    await managed.create();
    const accepted = await managed.submit(input.requestId, input.input.text);
    if (accepted.status.status === "unanswered") {
      return {
        status: "failed" as const,
        detail: `Managed Pi submission ended unanswered: ${accepted.status.reason}`,
      };
    }
    const settled = await managed.waitForSubmission(input.requestId);
    if (settled.status === "done") {
      return {
        status: "completed" as const,
        detail: `Pi submission ${settled.id} settled with assistant entry ${settled.answer}`,
      };
    }
    return {
      status: "failed" as const,
      detail: `Managed Pi submission ended unanswered: ${settled.reason}`,
    };
  };

  const drain = async () => {
    while (await factory.dispatchNext({ dispatch })) {
      // One persisted input settles before another thread input is admitted.
    }
  };
  const startDrain = () => {
    drainRequested = true;
    if (dispatching) return;
    dispatching = (async () => {
      try {
        while (drainRequested) {
          drainRequested = false;
          factory.requeueAvailableManagedInputs();
          await drain();
        }
      } catch (error) {
        const detail = (
          error instanceof Error
            ? `Standalone managed-input drain failed: ${error.message}`
            : "Standalone managed-input drain failed without a known error"
        ).slice(0, 4_000);
        try {
          factory.failManagedDispatchDrain(detail);
        } catch (settlementError) {
          console.error(
            "Could not persist the standalone managed-input drain failure",
            settlementError,
          );
        }
        console.error("Standalone managed-input drain failed", error);
      }
    })().finally(() => {
      dispatching = undefined;
      if (drainRequested) startDrain();
    });
  };

  const server = Bun.serve({
    port: options.port ?? 8788,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      const response = await handler(request);
      const path = new URL(request.url).pathname;
      if (
        response.ok &&
        request.method === "POST" &&
        /^\/v1\/nodes\/[^/]+\/(?:register|heartbeat)$/.test(path)
      ) {
        startDrain();
      }
      if (
        request.method === "POST" &&
        /^\/v1\/threads\/[^/]+\/inputs$/.test(path) &&
        response.status === 202
      ) {
        const receipt = (await response.clone().json()) as {
          dispatchStatus?: string;
        };
        if (receipt.dispatchStatus === "queued") startDrain();
      }
      return response;
    },
  });

  startDrain();

  return {
    server,
    factory,
    database,
    async captureManagedWorkCheckpoint({ credential, threadId, transport }) {
      if (closing) throw new Error("Standalone Factory is closing");
      activeCaptures += 1;
      try {
        const session = await factory.authenticate(credential);
        const { captureId, thread } = factory.beginManagedWorkCapture(
          session,
          threadId,
        );
        let managed: ManagedPiWork | undefined;
        let releaseWorkspace: (() => void | Promise<void>) | undefined;
        try {
          const workspacePath =
            options.workspaceDirectories?.[thread.target.workspaceId];
          if (!workspacePath) {
            throw new Error(
              `No trusted local directory is configured for workspace ${thread.target.workspaceId}`,
            );
          }
          const physicalWorkspace = await realpath(workspacePath);
          for (const [workspaceId, mappedPath] of Object.entries(
            options.workspaceDirectories ?? {},
          )) {
            if (
              workspaceId !== thread.target.workspaceId &&
              (await realpath(mappedPath)) === physicalWorkspace
            ) {
              throw new Error(
                `Workspace ${thread.target.workspaceId} shares a local directory with ${workspaceId}`,
              );
            }
          }
          if (!options.workspaceCaptureQuiescence) {
            throw new Error(
              "No trusted workspace-writer/Rex quiescence adapter is configured",
            );
          }
          const workspaceLease =
            await options.workspaceCaptureQuiescence.acquire(
              thread.target.workspaceId,
              captureId,
            );
          releaseWorkspace = workspaceLease.release;
          if (
            (await realpath(workspaceLease.workspacePath)) !== physicalWorkspace
          ) {
            throw new Error(
              "Capture workspace directory does not match the configured execution-node workspace",
            );
          }
          managed = await openWork(threadId, false);
          const provenance = factory.getManagedWorkCaptureProvenance(
            session,
            threadId,
            captureId,
          );
          const captured = await captureManagedWorkBundle({
            managedWork: await managed.exportCheckpoint(),
            compatibilityRequirements: [
              `model:${options.modelProvider}/${options.modelId}`,
              "tool:remote_read_file:v1",
              "tool:remote_write_file:v1",
              "tool:remote_run_command:v1",
            ],
            workspacePath,
            transport,
            attachments: [
              {
                name: "factory-provenance.json",
                mediaType: "application/json",
                bytes: new TextEncoder().encode(JSON.stringify(provenance)),
              },
            ],
          });
          return { ...captured, captureId };
        } finally {
          try {
            await releaseWorkspace?.();
          } finally {
            try {
              factory.endManagedWorkCapture(session, captureId);
            } finally {
              if (managed) await managed.resume();
            }
          }
        }
      } finally {
        activeCaptures -= 1;
        if (activeCaptures === 0) {
          for (const resolveCapture of captureWaiters.splice(0)) {
            resolveCapture();
          }
        }
      }
    },
    async close(force = true) {
      closing = true;
      server.stop(force);
      while (activeCaptures > 0) {
        await new Promise<void>((resolveCapture) =>
          captureWaiters.push(resolveCapture),
        );
      }
      while (dispatching) await dispatching.catch(() => {});
      await Promise.all(
        [...opening.values()].map((pending) =>
          pending.then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
      await Promise.all([...work.values()].map((managed) => managed.close()));
      work.clear();
      database.close();
    },
  };
}
