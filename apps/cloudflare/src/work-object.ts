import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { FactoryQueueJob } from "@uzina/contracts/factory";
import type {
  ExecutionOperation,
  ExecutionReceipt,
} from "@uzina/contracts/execution";
import type {
  ManagedWorkCaptureBinding,
  ManagedWorkCaptureState,
  ManagedWorkRuntimeAdmission,
} from "@uzina/core";
import {
  exportManagedWorkCheckpoint as exportPiManagedWorkCheckpoint,
  MANAGED_WORK_CHECKPOINT_MAX_BYTES,
  prepareManagedWorkCheckpointArtifact,
  type ManagedWorkCheckpoint,
} from "@uzina/pi-runtime/checkpoint";
import {
  ManagedPiWork,
  createManagedRemoteToolExecutor,
  type ManagedPiWorkOptions,
} from "@uzina/pi-runtime/work";

type DurableObjectSqliteStorage = Parameters<
  typeof openDurableObjectSqliteStorage
>[0];

type AlarmStorage = DurableObjectSqliteStorage & {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export interface ManagedWorkState {
  id: { name?: string };
  storage: AlarmStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  abort(reason?: string): void;
}

/** Supplied by the later Worker composition; no model or tool credential is embedded here. */
export type ManagedWorkRuntimeOptions = Omit<
  ManagedPiWorkOptions,
  "storage" | "onWake" | "beforeWork"
>;

export type ManagedWorkCheckpointExportRequest = {
  captureId: string;
  captureRequestId: string;
};

export type ManagedWorkCheckpointExport = {
  captureId: string;
  captureRequestId: string;
  threadId: string;
  target: { nodeId: string; workspaceId: string };
  ownershipGeneration: number;
  rootConversationId: number;
  profile: ManagedWorkCheckpoint["profile"];
  /** Logical v1 body checksum; it is not a digest of the returned `bytes`. */
  checkpointSha256: string;
  sizeBytes: number;
  bytes: Uint8Array;
};

export type ManagedWorkFactoryBridge = {
  getManagedWorkCaptureState(
    threadId: string,
  ): Promise<ManagedWorkCaptureState>;
  acquireManagedWorkRuntimePermit(
    threadId: string,
  ): Promise<ManagedWorkRuntimeAdmission>;
  releaseManagedWorkRuntimePermit(
    threadId: string,
    permitId: string,
  ): void | Promise<void>;
  getActiveManagedInput(
    threadId: string,
  ): FactoryQueueJob | undefined | Promise<FactoryQueueJob | undefined>;
  enqueueManagedRemoteExecution(
    threadId: string,
    taskId: string,
    callId: string,
    operation: ExecutionOperation,
  ): Promise<ExecutionReceipt>;
  getRemoteExecutionReceipt(
    jobId: string,
  ): ExecutionReceipt | null | Promise<ExecutionReceipt | null>;
  markManagedEffectUncertain(
    jobId: string,
    detail: string,
  ): void | Promise<void>;
};

export type ManagedWorkEnvironment = {
  runtimeOptions():
    ManagedWorkRuntimeOptions | Promise<ManagedWorkRuntimeOptions>;
  factory(): ManagedWorkFactoryBridge;
};

export type ManagedInputSettlement = {
  status: "completed" | "failed" | "uncertain";
  detail: string;
};

function validateCaptureExportRequest(
  request: ManagedWorkCheckpointExportRequest,
): ManagedWorkCheckpointExportRequest {
  if (
    typeof request !== "object" ||
    request === null ||
    Object.keys(request).length !== 2 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.captureId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.captureRequestId)
  ) {
    throw new Error("Invalid managed-work capture export request");
  }
  return {
    captureId: request.captureId,
    captureRequestId: request.captureRequestId,
  };
}

function assertSameCaptureBinding(
  expected: ManagedWorkCaptureBinding,
  current: ManagedWorkCaptureBinding,
): void {
  if (
    expected.captureId !== current.captureId ||
    expected.captureRequestId !== current.captureRequestId ||
    expected.controlId !== current.controlId ||
    expected.threadId !== current.threadId ||
    expected.projectId !== current.projectId ||
    expected.target.nodeId !== current.target.nodeId ||
    expected.target.workspaceId !== current.target.workspaceId ||
    expected.ownershipGeneration !== current.ownershipGeneration ||
    expected.reportSha256 !== current.reportSha256 ||
    expected.sourceFence.receiptSha256 !== current.sourceFence.receiptSha256 ||
    expected.sourceFence.fencedAt !== current.sourceFence.fencedAt
  ) {
    throw new Error("Managed-work capture binding changed during export");
  }
}

/** Cloudflare Durable Object adapter for one Pi Durable managed-work storage unit. */
export class ManagedWork {
  private work: ManagedPiWork | undefined;
  private opening: Promise<ManagedPiWork> | undefined;
  private runtimeStorage: Storage | undefined;
  private runtimePermitId: string | undefined;
  private settlementWaiters = 0;
  private readonly ready: Promise<void>;
  private closed = false;
  private alarmChain: Promise<void> = Promise.resolve();
  private operationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: ManagedWorkState,
    private readonly env: ManagedWorkEnvironment,
  ) {
    this.ready = state.blockConcurrencyWhile(() =>
      this.armFallbackBeforeRecovery(),
    );
  }

  async create(): Promise<number> {
    return this.run(async (work) => work.create(), true);
  }

  async submit(requestId: string, content: string) {
    return this.run(async (work) => work.submit(requestId, content), true);
  }

  async acceptManagedInput(
    input: FactoryQueueJob,
  ): Promise<ManagedInputSettlement> {
    if (input.threadId !== this.threadId) {
      throw new Error(
        "Managed input thread does not match its Durable Object identity",
      );
    }
    try {
      await this.requireRuntimePermit();
      const persisted = await this.env
        .factory()
        .getActiveManagedInput(this.threadId);
      if (
        !persisted ||
        persisted.jobId !== input.jobId ||
        persisted.requestId !== input.requestId ||
        persisted.threadId !== input.threadId ||
        persisted.actor.kind !== input.actor.kind ||
        JSON.stringify(persisted.actor) !== JSON.stringify(input.actor) ||
        persisted.target.nodeId !== input.target.nodeId ||
        persisted.target.workspaceId !== input.target.workspaceId ||
        persisted.ownershipGeneration !== input.ownershipGeneration ||
        persisted.input.text !== input.input.text
      ) {
        throw new Error(
          "Managed input does not match accepted persisted Factory work",
        );
      }
      const accepted = await this.run(async (work) => {
        await work.create();
        return work.submit(input.requestId, input.input.text);
      }, true);
      if (accepted.status.status === "unanswered") {
        return {
          status: "failed",
          detail: `Managed Pi submission ended unanswered: ${accepted.status.reason}`,
        };
      }
      try {
        const settled = await this.waitForSubmission(input.requestId);
        return settled.status === "done"
          ? {
              status: "completed",
              detail: `Pi submission ${settled.id} settled with assistant entry ${settled.answer}`,
            }
          : {
              status: "failed",
              detail: `Managed Pi submission ended unanswered: ${settled.reason}`,
            };
      } catch (error) {
        return {
          status: "uncertain",
          detail:
            error instanceof Error
              ? `Managed Pi completion is uncertain: ${error.message}`
              : "Managed Pi completion is uncertain",
        };
      }
    } finally {
      await this.enqueue(() => this.releaseRuntimeIfQuiescent());
    }
  }

  async context() {
    return this.run(async (work) => work.context());
  }

  async status() {
    try {
      return await this.run(async (work) => work.status());
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Managed Pi work has not been created"
      ) {
        return { status: "not-created" };
      }
      throw error;
    }
  }

  async resume(): Promise<void> {
    await this.run(async (work) => work.resume());
  }

  async exportManagedWorkCheckpoint(
    request: ManagedWorkCheckpointExportRequest,
  ): Promise<ManagedWorkCheckpointExport> {
    return this.enqueue(async () => {
      await this.ready;
      if (this.closed)
        throw new Error("Managed Pi work Durable Object is closed");
      const captureRequest = validateCaptureExportRequest(request);
      const threadId = this.threadId;
      const initial = await this.requireExportBinding(threadId, captureRequest);
      let storage = this.runtimeStorage;
      const ownsStorage = storage === undefined;
      if (!storage) {
        storage = await openDurableObjectSqliteStorage(this.state.storage);
      }
      try {
        const beforeRead = await this.requireExportBinding(
          threadId,
          captureRequest,
        );
        assertSameCaptureBinding(initial, beforeRead);
        const checkpoint = await exportPiManagedWorkCheckpoint(
          storage,
          ROOT_CONVERSATION_ID,
        );
        const artifact = await prepareManagedWorkCheckpointArtifact(
          checkpoint,
          MANAGED_WORK_CHECKPOINT_MAX_BYTES,
        );
        const afterRead = await this.requireExportBinding(
          threadId,
          captureRequest,
        );
        assertSameCaptureBinding(initial, afterRead);
        return {
          captureId: initial.captureId,
          captureRequestId: initial.captureRequestId,
          threadId,
          target: initial.target,
          ownershipGeneration: initial.ownershipGeneration,
          rootConversationId: artifact.checkpoint.rootConversationId,
          profile: artifact.checkpoint.profile,
          checkpointSha256: artifact.checkpoint.sha256,
          sizeBytes: artifact.bytes.byteLength,
          bytes: artifact.bytes,
        };
      } finally {
        if (ownsStorage) await storage.close(BACKGROUND_CONTEXT);
      }
    });
  }

  async close(): Promise<void> {
    await this.ready;
    return this.enqueue(async () => {
      if (this.closed) return;
      await this.releaseRuntimeIfQuiescent();
      if (
        this.settlementWaiters > 0 ||
        this.work ||
        this.opening ||
        this.runtimeStorage ||
        this.runtimePermitId
      ) {
        throw new Error(
          "Cannot close managed Pi work while runtime work is unsettled",
        );
      }
      this.closed = true;
      await this.queueAlarm(async () => this.state.storage.deleteAlarm());
    });
  }

  async alarm(): Promise<void> {
    await this.enqueue(async () => {
      await this.ready;
      if (this.closed) return;
      try {
        const permitId = await this.acquireRuntimePermit();
        if (!permitId) return;
        const work = this.work ?? (await this.openWork());
        await this.arm({ ...workWake(work), active: true });
        await work.resume();
      } finally {
        await this.releaseRuntimeIfQuiescent();
      }
    });
  }

  private run<T>(
    operation: (work: ManagedPiWork) => Promise<T>,
    resumeAfter = false,
  ): Promise<T> {
    return this.enqueue(async () => {
      await this.ready;
      if (this.closed)
        throw new Error("Managed Pi work Durable Object is closed");
      try {
        await this.requireRuntimePermit();
        const work = await this.openUnlockedWork();
        const result = await operation(work);
        if (resumeAfter) await work.resume();
        return result;
      } finally {
        await this.releaseRuntimeIfQuiescent();
      }
    });
  }

  private async waitForSubmission(requestId: string) {
    const waiting = await this.enqueue(async () => {
      await this.ready;
      if (this.closed)
        throw new Error("Managed Pi work Durable Object is closed");
      await this.requireRuntimePermit();
      const work = await this.openUnlockedWork();
      // A sleeping task needs later alarms on this chain, but closing its
      // Harness before this waiter observes settlement rejects it as uncertain.
      const settlement = work.waitForSubmission(requestId);
      this.settlementWaiters += 1;
      return { settlement };
    });
    try {
      return await waiting.settlement;
    } finally {
      await this.enqueue(async () => {
        this.settlementWaiters -= 1;
        await this.releaseRuntimeIfQuiescent();
      });
    }
  }

  private async openUnlockedWork(): Promise<ManagedPiWork> {
    if (!this.runtimePermitId) {
      throw new Error("Managed Pi work requires a Core runtime permit");
    }
    const isCold = this.work === undefined;
    const work = this.work ?? (await this.openWork());
    if (isCold) await work.resume();
    return work;
  }

  private async requireRuntimePermit(): Promise<string> {
    const permitId = await this.acquireRuntimePermit();
    if (!permitId) {
      throw new Error("Managed Pi work is held by an active capture lock");
    }
    return permitId;
  }

  private async acquireRuntimePermit(): Promise<string | undefined> {
    const admission = await this.env
      .factory()
      .acquireManagedWorkRuntimePermit(this.threadId);
    if (admission.state !== "permitted") return undefined;
    this.runtimePermitId = admission.permitId;
    await this.arm({ active: true });
    return admission.permitId;
  }

  private async releaseRuntimeIfQuiescent(): Promise<void> {
    if (this.closed || !this.runtimePermitId || this.settlementWaiters > 0)
      return;
    const work = this.work;
    if (work) {
      let quiescent: boolean;
      try {
        quiescent = await work.isQuiescent(BACKGROUND_CONTEXT);
      } catch (error) {
        this.state.abort("Could not verify managed-work quiescence");
        throw error;
      }
      if (!quiescent) return;
      try {
        await work.close(BACKGROUND_CONTEXT);
      } catch (error) {
        this.state.abort("Could not close quiescent managed-work Harness");
        throw error;
      }
      if (this.work === work) {
        this.work = undefined;
        this.runtimeStorage = undefined;
        this.opening = undefined;
      }
    } else if (this.opening || this.runtimeStorage) {
      return;
    }
    await this.releaseRuntimePermit(this.runtimePermitId);
  }

  private async releaseRuntimePermit(permitId: string): Promise<void> {
    await this.env
      .factory()
      .releaseManagedWorkRuntimePermit(this.threadId, permitId);
    if (this.runtimePermitId === permitId) this.runtimePermitId = undefined;
    await this.queueAlarm(async () => this.state.storage.deleteAlarm());
  }

  private async requireExportBinding(
    threadId: string,
    request: ManagedWorkCheckpointExportRequest,
  ): Promise<ManagedWorkCaptureBinding> {
    const state = await this.env.factory().getManagedWorkCaptureState(threadId);
    if (state.state !== "source-capture-fenced") {
      throw new Error(
        "Managed-work export requires a confirmed source-capture-fenced lock",
      );
    }
    if (
      state.binding.threadId !== threadId ||
      state.binding.captureId !== request.captureId ||
      state.binding.captureRequestId !== request.captureRequestId
    ) {
      throw new Error(
        "Managed-work export request does not match its persisted capture binding",
      );
    }
    return state.binding;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private get threadId(): string {
    const threadId = this.state.id.name;
    if (!threadId)
      throw new Error("Managed Pi work requires a named thread Durable Object");
    return threadId;
  }

  private async openWork(): Promise<ManagedPiWork> {
    if (this.work) return this.work;
    if (this.opening) return this.opening;
    const storage = await openDurableObjectSqliteStorage(this.state.storage);
    const bridge = this.env.factory();
    const opening = Promise.resolve()
      .then(() => this.env.runtimeOptions())
      .then((options) =>
        ManagedPiWork.open(
          {
            ...options,
            storage,
            toolExecutor: createManagedRemoteToolExecutor(this.threadId, {
              enqueue: (threadId, identity, operation) =>
                bridge.enqueueManagedRemoteExecution(
                  threadId,
                  identity.taskId,
                  identity.callId,
                  operation,
                ),
              receipt: (jobId) => bridge.getRemoteExecutionReceipt(jobId),
              markUncertain: (jobId, detail) =>
                bridge.markManagedEffectUncertain(jobId, detail),
            }),
            onWake: (wake) => {
              void this.arm({ ...wake, active: true })
                .then(() =>
                  this.enqueue(() => this.releaseRuntimeIfQuiescent()),
                )
                .catch(() =>
                  this.state.abort("Could not maintain managed-work recovery"),
                );
            },
            beforeWork: (wake) => this.arm(wake),
          },
          BACKGROUND_CONTEXT,
        ),
      );
    this.opening = opening;
    try {
      this.work = await opening;
      this.runtimeStorage = storage;
      this.opening = undefined;
      return this.work;
    } catch (error) {
      this.opening = undefined;
      try {
        await storage.close(BACKGROUND_CONTEXT);
      } catch (closeError) {
        this.runtimeStorage = storage;
        this.state.abort("Could not close failed managed-work storage");
        throw closeError;
      }
      throw error;
    }
  }

  private async armFallbackBeforeRecovery(): Promise<void> {
    const fallback = Date.now();
    const current = await this.state.storage.getAlarm();
    if (current === null || current > fallback) {
      await this.state.storage.setAlarm(fallback);
    }
  }

  private arm(wake: { active: boolean; at?: number }): Promise<void> {
    return this.queueAlarm(async () => {
      if (this.closed) return;
      const heartbeat = wake.active ? Date.now() + 60_000 : undefined;
      const at =
        heartbeat === undefined || wake.at === undefined
          ? (heartbeat ?? wake.at)
          : Math.min(heartbeat, wake.at);
      if (at === undefined) await this.state.storage.deleteAlarm();
      else await this.state.storage.setAlarm(at);
    });
  }

  private queueAlarm(operation: () => Promise<void>): Promise<void> {
    const result = this.alarmChain.then(operation);
    this.alarmChain = result.catch(() => {});
    return result;
  }
}

function workWake(work: ManagedPiWork): { active: boolean; at?: number } {
  return work.wake();
}

export type { Context };
