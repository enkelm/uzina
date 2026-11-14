import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import type { FactoryQueueJob } from "@uzina/contracts/factory";
import type { ExecutionReceipt } from "@uzina/contracts/execution";
import {
  FactoryController,
  type FactoryDurableObjectEnvironment,
  type FactoryDurableObjectState,
  type FactoryRpc,
} from "./factory-object";
import {
  ManagedWork,
  type ManagedInputSettlement,
  type ManagedWorkEnvironment,
  type ManagedWorkState,
  type ManagedWorkCheckpointExport,
  type ManagedWorkCheckpointExportRequest,
} from "./work-object";

export class FactoryObject
  extends DurableObject<FactoryDurableObjectEnvironment>
  implements FactoryRpc
{
  readonly #controller: FactoryController;

  constructor(
    state: FactoryDurableObjectState,
    environment: FactoryDurableObjectEnvironment,
  ) {
    super(state as unknown as DurableObjectState, environment);
    this.#controller = new FactoryController(state, environment);
  }

  fetch(request: Request): Promise<Response> {
    return this.#controller.fetch(request);
  }

  factoryHttp(request: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  }) {
    return this.#controller.factoryHttp(request);
  }

  authorizePrivateAssistant(credential: string) {
    return this.#controller.authorizePrivateAssistant(credential);
  }

  alarm(): Promise<void> {
    return this.#controller.alarm();
  }

  getManagedWorkCaptureState(threadId: string) {
    return this.#controller.getManagedWorkCaptureState(threadId);
  }

  acquireManagedWorkRuntimePermit(threadId: string) {
    return this.#controller.acquireManagedWorkRuntimePermit(threadId);
  }

  releaseManagedWorkRuntimePermit(threadId: string, permitId: string) {
    return this.#controller.releaseManagedWorkRuntimePermit(threadId, permitId);
  }

  getActiveManagedInput(threadId: string): FactoryQueueJob | undefined {
    return this.#controller.getActiveManagedInput(threadId);
  }

  enqueueManagedRemoteExecution(
    threadId: string,
    taskId: string,
    callId: string,
    operation: Parameters<
      FactoryController["enqueueManagedRemoteExecution"]
    >[3],
  ): Promise<ExecutionReceipt> {
    return this.#controller.enqueueManagedRemoteExecution(
      threadId,
      taskId,
      callId,
      operation,
    );
  }

  getRemoteExecutionReceipt(jobId: string): ExecutionReceipt | null {
    return this.#controller.getRemoteExecutionReceipt(jobId);
  }

  markManagedEffectUncertain(jobId: string, detail: string): void {
    this.#controller.markManagedEffectUncertain(jobId, detail);
  }
}

/** Worker RPC wrapper for Pi Durable; the injected runtime remains host-neutral. */
export class ManagedWorkRpcObject extends DurableObject<unknown> {
  readonly #work: ManagedWork;

  constructor(
    state: ManagedWorkState,
    environment: unknown,
    runtime: ManagedWorkEnvironment,
  ) {
    super(state as unknown as DurableObjectState, environment);
    this.#work = new ManagedWork(state, runtime);
  }

  create() {
    return this.#work.create();
  }

  submit(requestId: string, content: string) {
    return this.#work.submit(requestId, content);
  }

  acceptManagedInput(input: FactoryQueueJob): Promise<ManagedInputSettlement> {
    return this.#work.acceptManagedInput(input);
  }

  exportManagedWorkCheckpoint(
    request: ManagedWorkCheckpointExportRequest,
  ): Promise<ManagedWorkCheckpointExport> {
    return this.#work.exportManagedWorkCheckpoint(request);
  }

  context() {
    return this.#work.context();
  }

  status() {
    return this.#work.status();
  }

  resume() {
    return this.#work.resume();
  }

  close() {
    return this.#work.close();
  }

  alarm() {
    return this.#work.alarm();
  }
}
