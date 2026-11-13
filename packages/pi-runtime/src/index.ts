import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  ROOT_CONVERSATION_ID,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type Harness as PiHarness,
  type HarnessInspection,
  type HarnessOptions,
  type Registry,
  type SettledSubmissionRecord,
  type SubmissionId,
  type SubmissionRecord,
  type ToolRegistration,
  type Wake,
} from "@earendil-works/pi-durable";
import { createRemoteToolExtension, type RemoteToolExecutor } from "./tools";
import { exportManagedWorkCheckpoint } from "./checkpoint";
import type { ManagedWorkCheckpoint } from "./checkpoint";

export type ManagedPiWorkOptions<
  Tool extends ToolRegistration = ToolRegistration,
> = Omit<HarnessOptions<Tool>, "registry" | "onWake"> & {
  storage: Storage;
  registry?: Registry<Tool>;
  /** Used only when this is a new work item. */
  agent?: AgentChange;
  toolExecutor?: RemoteToolExecutor;
  onWake?: (wake: Wake) => void;
  /** Called before any operation that may enable Pi task execution. */
  beforeWork?: (wake: Wake) => void | Promise<void>;
};

export type ManagedSubmission = {
  conversationId: ConversationId;
  submissionId: SubmissionId;
  requestId: string;
  status: SubmissionRecord;
};

export type ManagedWorkStatus = {
  conversationId: ConversationId;
  wake: Wake;
  inspection: HarnessInspection;
  context: Awaited<ReturnType<Conversation["context"]>>;
};

/** Pi Durable facade that deliberately exposes only one root conversation. */
export class ManagedPiWork {
  private constructor(
    private readonly harness: PiHarness,
    private readonly options: ManagedPiWorkOptions,
  ) {}

  static async open<Tool extends ToolRegistration = ToolRegistration>(
    options: ManagedPiWorkOptions<Tool>,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ManagedPiWork> {
    const registry = options.registry ?? createRegistry<Tool>();
    if (options.toolExecutor) {
      registry.install(
        createRemoteToolExtension(options.toolExecutor) as never,
      );
    }

    const {
      storage,
      agent: _agent,
      toolExecutor: _toolExecutor,
      beforeWork,
      onWake,
      ...harnessOptions
    } = options;
    const harness = await Harness.open(
      storage,
      {
        ...harnessOptions,
        registry,
        ...(onWake ? { onWake } : {}),
      },
      context,
    );
    return new ManagedPiWork(harness, {
      ...options,
      registry,
      beforeWork,
      onWake,
    });
  }

  /** Idempotently create the one root conversation. */
  async create(context: Context = BACKGROUND_CONTEXT): Promise<ConversationId> {
    const conversation = await this.harness.root(context, {
      ...(this.options.agent ? { agent: this.options.agent } : {}),
    });
    return conversation.id;
  }

  /** Open an existing root; unlike create(), this never creates missing state. */
  async openRoot(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ConversationId> {
    const conversation = await this.harness.conversation(
      ROOT_CONVERSATION_ID,
      context,
    );
    if (!conversation) throw new Error("Managed Pi work has not been created");
    return conversation.id;
  }

  async submit(
    requestId: string,
    content: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ManagedSubmission> {
    if (!requestId.trim()) throw new Error("requestId must not be empty");
    const conversation = await this.requireRoot(context);
    await this.options.beforeWork?.({ ...this.harness.wake(), active: true });
    const submission = await conversation.submit(
      { type: "input", requestId, content },
      context,
    );
    return {
      conversationId: conversation.id,
      submissionId: submission.id,
      requestId,
      status: await submission.status(context),
    };
  }

  async submission(
    requestId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SubmissionRecord | undefined> {
    const conversation = await this.requireRoot(context);
    return this.harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, requestId),
      context,
    );
  }

  async waitForSubmission(
    requestId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<SettledSubmissionRecord> {
    const record = await this.submission(requestId, context);
    if (!record)
      throw new Error(`No submission exists for request ${requestId}`);
    const submission = await this.harness.submission(record.id, context);
    if (!submission) throw new Error(`Submission ${record.id} disappeared`);
    await this.options.beforeWork?.({ ...this.harness.wake(), active: true });
    return submission.wait(context);
  }

  async context(context: Context = BACKGROUND_CONTEXT) {
    const conversation = await this.requireRoot(context);
    return conversation.context(context);
  }

  /** Export the supported logical profile without opening or resuming a task. */
  async exportCheckpoint(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ManagedWorkCheckpoint> {
    await this.openRoot(context);
    return exportManagedWorkCheckpoint(
      this.options.storage,
      ROOT_CONVERSATION_ID,
      context,
    );
  }

  async status(
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<ManagedWorkStatus> {
    const conversation = await this.requireRoot(context);
    const [inspection, canonicalContext] = await Promise.all([
      this.harness.inspect(context),
      conversation.context(context),
    ]);
    return {
      conversationId: conversation.id,
      wake: this.harness.wake(),
      inspection,
      context: canonicalContext,
    };
  }

  /** Arm host recovery before allowing pending or sleeping tasks to continue. */
  async resume(): Promise<void> {
    await this.options.beforeWork?.({ ...this.harness.wake(), active: true });
    this.harness.resume();
  }

  wake(): Wake {
    return this.harness.wake();
  }

  async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.harness.close(context);
  }

  private async requireRoot(context: Context): Promise<Conversation> {
    const conversation = await this.harness.conversation(
      ROOT_CONVERSATION_ID,
      context,
    );
    if (!conversation) throw new Error("Managed Pi work has not been created");
    return conversation;
  }
}

export type { ConversationView, Wake };
export { createRemoteToolExtension } from "./tools";
export type { RemoteToolExecutor } from "./tools";
export { createManagedRemoteToolExecutor } from "./remote-bridge";
export type { ManagedRemoteExecutionBridge } from "./remote-bridge";
export {
  createConfiguredModels,
  createManagedRuntimeOptions,
  readManagedModelConfig,
} from "./provider";
export type {
  ManagedModelConfig,
  ManagedRuntimeEnvironment,
  ManagedModels,
} from "./provider";
