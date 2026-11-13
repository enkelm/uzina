import {
  executionResultSchema,
  type ExecutionOperation,
  type ExecutionReceipt,
} from "@uzina/contracts/execution";
import type {
  RemoteCommandResult,
  RemoteReadResult,
  RemoteToolExecutor,
  RemoteToolIdentity,
} from "./tools";

export interface ManagedRemoteExecutionBridge {
  enqueue(
    threadId: string,
    identity: RemoteToolIdentity,
    operation: ExecutionOperation,
  ): Promise<ExecutionReceipt>;
  receipt(
    jobId: string,
  ): ExecutionReceipt | null | Promise<ExecutionReceipt | null>;
  markUncertain(jobId: string, detail: string): void | Promise<void>;
}

const RECEIPT_POLL_MS = 250;
const MAX_RECEIPT_WAIT_MS = 120_000;

export class RemoteEffectUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteEffectUncertainError";
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReceipt(
  bridge: ManagedRemoteExecutionBridge,
  job: ExecutionReceipt,
): Promise<ExecutionReceipt> {
  if (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "uncertain"
  ) {
    return job;
  }
  const deadline = Date.now() + MAX_RECEIPT_WAIT_MS;
  while (Date.now() < deadline) {
    await pause(RECEIPT_POLL_MS);
    try {
      const current = await bridge.receipt(job.jobId);
      if (
        current &&
        (current.status === "completed" ||
          current.status === "failed" ||
          current.status === "uncertain")
      ) {
        return current;
      }
    } catch {
      // A lost receipt read never admits another effect; keep looking up this identity.
    }
  }
  await bridge.markUncertain(
    job.jobId,
    "The managed tool stopped waiting before an external effect receipt settled",
  );
  throw new RemoteEffectUncertainError(
    `Remote execution ${job.jobId} did not settle before the wait limit`,
  );
}

async function execute(
  bridge: ManagedRemoteExecutionBridge,
  threadId: string,
  identity: RemoteToolIdentity,
  operation: ExecutionOperation,
): Promise<ExecutionReceipt> {
  const accepted = await bridge.enqueue(threadId, identity, operation);
  const settled = await waitForReceipt(bridge, accepted);
  if (settled.status === "uncertain") {
    await bridge.markUncertain(
      settled.jobId,
      `Remote execution ${settled.jobId} is uncertain${settled.errorCode ? ` (${settled.errorCode})` : ""}`,
    );
    throw new RemoteEffectUncertainError(
      `Remote execution ${settled.jobId} is uncertain and was not replayed`,
    );
  }
  if (settled.status === "failed") {
    throw new Error(
      `Remote execution ${settled.jobId} failed${settled.errorCode ? ` (${settled.errorCode})` : ""}`,
    );
  }
  return settled;
}

export function createManagedRemoteToolExecutor(
  threadId: string,
  bridge: ManagedRemoteExecutionBridge,
): RemoteToolExecutor {
  return {
    async readFile(input, identity): Promise<RemoteReadResult> {
      const receipt = await execute(bridge, threadId, identity, {
        operation: "read-file",
        path: input.path,
        maxBytes: input.maxBytes,
      });
      const result = executionResultSchema.parse(receipt.result);
      if (result.operation !== "read-file") {
        throw new Error("Remote read receipt has the wrong result operation");
      }
      const bytes = fromBase64(result.contentBase64);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { content, truncated: false };
    },
    async writeFile(input, identity): Promise<void> {
      const bytes = new TextEncoder().encode(input.content);
      await execute(bridge, threadId, identity, {
        operation: "write-file",
        path: input.path,
        contentBase64: base64(bytes),
      });
    },
    async runCommand(input, identity): Promise<RemoteCommandResult> {
      const receipt = await execute(bridge, threadId, identity, {
        operation: "argv-command",
        argv: [...input.argv],
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
      });
      const result = executionResultSchema.parse(receipt.result);
      if (result.operation !== "argv-command") {
        throw new Error(
          "Remote command receipt has the wrong result operation",
        );
      }
      if (result.exitCode === null) {
        throw new RemoteEffectUncertainError(
          `Remote command ${receipt.jobId} completed without a confirmed exit code`,
        );
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        outputTruncated: result.outputTruncated,
      };
    },
  };
}
