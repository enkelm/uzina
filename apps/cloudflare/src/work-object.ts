import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ManagedPiWork, type ManagedPiWorkOptions } from "@uzina/pi-runtime";

type DurableObjectSqliteStorage = Parameters<
  typeof openDurableObjectSqliteStorage
>[0];

type AlarmStorage = DurableObjectSqliteStorage & {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export interface ManagedWorkState {
  storage: AlarmStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  abort(reason?: string): void;
}

/** Supplied by the later Worker composition; no model or tool credential is embedded here. */
export type ManagedWorkRuntimeOptions = Omit<
  ManagedPiWorkOptions,
  "storage" | "onWake" | "beforeWork"
>;

export type ManagedWorkEnvironment = {
  runtimeOptions(): ManagedWorkRuntimeOptions;
};

/** Cloudflare Durable Object adapter for one Pi Durable managed-work storage unit. */
export class ManagedWork {
  private work: ManagedPiWork | undefined;
  private opening: Promise<ManagedPiWork> | undefined;
  private readonly ready: Promise<void>;
  private closed = false;
  private alarmChain: Promise<void> = Promise.resolve();
  private operationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: ManagedWorkState,
    private readonly env: ManagedWorkEnvironment,
  ) {
    this.ready = state.blockConcurrencyWhile(async () => {
      await this.armFallbackBeforeRecovery();
      await this.openWork();
      await this.work?.resume();
    });
  }

  async create(): Promise<number> {
    return this.run(async (work) => work.create());
  }

  async submit(requestId: string, content: string) {
    return this.run(async (work) => work.submit(requestId, content));
  }

  async context() {
    return this.run(async (work) => work.context());
  }

  async status() {
    return this.run(async (work) => work.status());
  }

  async resume(): Promise<void> {
    await this.run(async (work) => work.resume());
  }

  async close(): Promise<void> {
    await this.ready;
    return this.enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      await this.queueAlarm(async () => this.state.storage.deleteAlarm());
      const work = this.work;
      this.work = undefined;
      this.opening = undefined;
      await work?.close(BACKGROUND_CONTEXT);
    });
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (this.closed) return;
    await this.run(async (work) => {
      await this.arm({ ...workWake(work), active: true });
      await work.resume();
    });
  }

  private run<T>(operation: (work: ManagedPiWork) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.ready;
      if (this.closed)
        throw new Error("Managed Pi work Durable Object is closed");
      const work = this.work ?? (await this.openWork());
      return operation(work);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async openWork(): Promise<ManagedPiWork> {
    if (this.work) return this.work;
    if (this.opening) return this.opening;
    const storage = await openDurableObjectSqliteStorage(this.state.storage);
    const opening = ManagedPiWork.open(
      {
        ...this.env.runtimeOptions(),
        storage,
        onWake: (wake) => {
          void this.arm(wake).catch(() =>
            this.state.abort("Could not arm managed-work recovery alarm"),
          );
        },
        beforeWork: (wake) => this.arm(wake),
      },
      BACKGROUND_CONTEXT,
    );
    this.opening = opening;
    try {
      this.work = await opening;
      return this.work;
    } catch (error) {
      this.opening = undefined;
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
      throw error;
    }
  }

  private async armFallbackBeforeRecovery(): Promise<void> {
    const fallback = Date.now() + 60_000;
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
