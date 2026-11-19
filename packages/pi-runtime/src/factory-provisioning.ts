import type { Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineDocFamily,
  defineTask,
  type Tx,
  type TaskId,
  type TaskRuntime,
  type DocumentReader,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { FactoryClient, FactoryClientError } from "@uzina/client";
import {
  provisionNativeWorkerRequestSchema,
  type ProvisionNativeWorkerRequest,
  type NativeProvisioningStatus,
} from "@uzina/contracts/native-provisioning";
import { authorizeProject, requestOptions } from "./factory-bot-tasks";
import { fail, remove } from "./factory-bot-state";
const semantics = {
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => true,
} as const;
type Provisioning = {
  request: ProvisionNativeWorkerRequest;
  taskId: TaskId;
  attempts?: TaskId[];
  deadline: number;
  state: "queued" | "starting" | "ready" | "uncertain" | "stopped" | "blocked";
  status: NativeProvisioningStatus | null;
};
const WorkerIndex = defineDoc<{ requests: string[]; active: string[] }>({
  ...semantics,
  kind: "uzina.factory-provisioning-index",
  initial: () => ({ requests: [], active: [] }),
});
const WorkerProvisioning = defineDocFamily<Provisioning, Provisioning>({
  ...semantics,
  family: true,
  kind: "uzina.factory-provisioning",
  initial: (input) => input,
});
type Input = { requestId: string; retry?: boolean };
type Phase = { phase: "reconcile" };
type Result = { state: string };
type Runtime = TaskRuntime<Input, Phase, Result, object>;
export function createFactoryProvisioning(client: FactoryClient) {
  async function finish(
    runtime: Runtime,
    job: Readonly<Provisioning>,
    state: Provisioning["state"],
    status: NativeProvisioningStatus | null,
    context: Context,
    aborted = false,
  ) {
    const root = await runtime.conversation(runtime.conversationId, context);
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(
        WorkerProvisioning,
        runtime.conversationId,
        job.request.requestId,
        job,
      );
      doc.state = state;
      doc.status = status;
      const index = await tx.doc(WorkerIndex, runtime.conversationId);
      remove(index.active, job.request.requestId);
      if (!aborted && root)
        await root.submit(tx, {
          type: "input",
          requestId: `factory-provisioning-result:${runtime.taskId}`,
          content: `Factory worker provisioning ${job.request.requestId}: ${state}. Inspect factory_board view with provisioningRequestId ${job.request.requestId} for current Core evidence and worker identity. This provisioning task sent no assignment. MCP readiness is not native assignment admission or execution; automatic delivery remains unsupported.`,
        });
      return {
        status: "terminal",
        outcome: aborted
          ? { status: "aborted" }
          : { status: "completed", result: { state } },
      };
    }, context);
  }
  const task = defineTask<Input, Phase, Result>({
    name: "uzina.factory-native-worker-provisioning",
    version: 1,
    initial: () => ({ phase: "reconcile" }),
    phases: {
      reconcile: async (task, runtime, context) => {
        const job = await runtime.snapshot(
          WorkerProvisioning,
          runtime.conversationId,
          task.input.requestId,
          context,
        );
        if (!job || job.taskId !== runtime.taskId)
          throw new Error("Factory provisioning binding unavailable");
        try {
          await authorizeProject(client, job.request.projectId, context);
          if (runtime.now() >= job.deadline) {
            await finish(runtime, job, "uncertain", job.status, context);
            return;
          }
          let status: NativeProvisioningStatus | undefined;
          try {
            status = await client.getNativeWorkerProvisioning(
              job.request.requestId,
              requestOptions(context),
            );
          } catch (error) {
            if (!(error instanceof FactoryClientError && error.status === 404))
              throw error;
          }
          // Only provisioning is retried with its ORIGINAL identity. The host reconciles
          // committed/uncertain Rex receipts before considering a new process intent.
          if (
            !status ||
            (!status.process && (!status.errorCode || task.input.retry))
          )
            status = await client.provisionNativeWorker(
              job.request,
              requestOptions(context),
            );
          if (["ready", "uncertain", "stopped"].includes(status.status)) {
            await finish(
              runtime,
              job,
              status.status as "ready" | "uncertain" | "stopped",
              status,
              context,
            );
            return;
          }
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(
              WorkerProvisioning,
              runtime.conversationId,
              job.request.requestId,
              job,
            );
            doc.state = "starting";
            doc.status = status!;
            return {
              status: "sleeping",
              checkpoint: { phase: "reconcile" },
              until: Math.min(job.deadline, runtime.now() + 1000),
            };
          }, context);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          if (
            runtime.now() < job.deadline &&
            ((error instanceof FactoryClientError &&
              (error.status === 0 ||
                error.status === 408 ||
                error.status === 429 ||
                (error.status >= 500 && error.status !== 501))) ||
              (error instanceof Error &&
                ["AbortError", "TimeoutError"].includes(error.name)))
          ) {
            await runtime.sleepUntil(
              Math.min(job.deadline, runtime.now() + 1000),
              { phase: "reconcile" },
              context,
            );
            return;
          }
          await finish(runtime, job, "blocked", job.status, context);
        }
      },
    },
    abort: async (task, runtime, context) => {
      const job = await runtime.snapshot(
        WorkerProvisioning,
        runtime.conversationId,
        task.input.requestId,
        context,
      );
      if (job)
        await finish(runtime, job, "uncertain", job.status, context, true);
    },
  });
  return {
    task,
    get(
      read: DocumentReader,
      conversationId: ConversationId,
      requestId: string,
      context: Context,
    ) {
      return read.snapshot(
        WorkerProvisioning,
        conversationId,
        requestId,
        context,
      );
    },
    async create(
      tx: Tx,
      conversationId: ConversationId,
      key: string,
      input: Omit<ProvisionNativeWorkerRequest, "requestId">,
      now: number,
      resume?: Readonly<Provisioning>,
    ) {
      const index = await tx.doc(WorkerIndex, conversationId);
      const previous = resume
        ? await tx.doc(
            WorkerProvisioning,
            conversationId,
            resume.request.requestId,
            resume,
          )
        : undefined;
      if (previous && index.active.includes(previous.request.requestId))
        return {
          requestId: previous.request.requestId,
          taskId: previous.taskId,
          state: previous.state,
          nextStep:
            "The original provisioning task is still active; inspect its original request, do not queue a replacement.",
        };
      if (previous && !["blocked", "uncertain"].includes(previous.state))
        fail("native_provisioning_resume_not_needed");
      if (
        (!previous && index.requests.length >= 1000) ||
        index.active.length >= 8 ||
        (previous?.attempts?.length ?? 0) >= 100
      )
        fail("native_provisioning_limit");
      const request =
        previous?.request ??
        provisionNativeWorkerRequestSchema.parse({
          requestId: `provision:${key}`,
          ...input,
        });
      const taskId = await tx.createTask(
        task,
        { requestId: request.requestId, retry: !!previous },
        {
          ownership: { kind: "conversation" },
          conversationId,
          background: true,
        },
      );
      const job: Provisioning = {
        request,
        taskId,
        deadline: now + 120_000,
        state: "queued",
        status: previous?.status ?? null,
        attempts: [
          ...(previous?.attempts ?? (previous ? [previous.taskId] : [])),
          taskId,
        ],
      };
      const doc = await tx.doc(
        WorkerProvisioning,
        conversationId,
        request.requestId,
        job,
      );
      if (previous) Object.assign(doc, job);
      else index.requests.push(request.requestId);
      index.active.push(request.requestId);
      return {
        requestId: request.requestId,
        taskId,
        state: "queued",
        nextStep:
          "Inspect factory_board view with provisioningRequestId for current Core evidence. This reserves and launches a worker, not an assignment; no automatic native delivery is supported.",
      };
    },
    async view(
      read: DocumentReader,
      conversationId: ConversationId,
      projectId: string,
      offset: number,
      limit: number,
      context: Context,
    ) {
      const index = await read.snapshot(WorkerIndex, conversationId, context);
      const jobs: Readonly<Provisioning>[] = [];
      for (const requestId of index?.requests ?? []) {
        const job = await read.snapshot(
          WorkerProvisioning,
          conversationId,
          requestId,
          context,
        );
        if (job?.request.projectId === projectId) jobs.push(job);
      }
      return {
        observation:
          "Retained provisioning task outcomes, not continuous liveness; view with provisioningRequestId refreshes Core/process/MCP evidence without relaunching.",
        provisionings: jobs.slice(offset, offset + limit),
        nextOffset: jobs.length > offset + limit ? offset + limit : null,
      };
    },
  };
}
