import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";

export const REMOTE_TOOL_EXTENSION = "uzina.remote-execution";
/** Compatibility IDs for the tool definitions installed by this extension. */
export const MANAGED_REMOTE_TOOL_REQUIREMENTS = [
  "tool:remote_read_file:v1",
  "tool:remote_write_file:v1",
  "tool:remote_run_command:v1",
] as const;
export const MAX_REMOTE_FILE_BYTES = 64 * 1024;
export const MAX_REMOTE_OUTPUT_BYTES = 64 * 1024;
export const MAX_REMOTE_TIMEOUT_MS = 60_000;

export type RemoteReadResult = {
  content: string;
  truncated: boolean;
};

export type RemoteCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputTruncated: boolean;
};

export type RemoteToolIdentity = {
  conversationId: number;
  taskId: string;
  callId: string;
};

/** Bounded destination calls; hosts derive destination authority from accepted Factory work. */
export interface RemoteToolExecutor {
  readFile(
    input: { path: string; maxBytes: number },
    identity: RemoteToolIdentity,
  ): Promise<RemoteReadResult>;
  writeFile(
    input: { path: string; content: string },
    identity: RemoteToolIdentity,
  ): Promise<void>;
  runCommand(
    input: {
      argv: readonly string[];
      cwd?: string;
      timeoutMs: number;
      maxOutputBytes: number;
    },
    identity: RemoteToolIdentity,
  ): Promise<RemoteCommandResult>;
}

const readSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    maxBytes: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_REMOTE_FILE_BYTES }),
    ),
  },
  { additionalProperties: false },
);

const writeSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    content: Type.String({ maxLength: MAX_REMOTE_FILE_BYTES }),
  },
  { additionalProperties: false },
);

const commandSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1, maxLength: 8192 }), {
      minItems: 1,
      maxItems: 64,
    }),
    cwd: Type.Optional(Type.String({ maxLength: 4096 })),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_REMOTE_TIMEOUT_MS }),
    ),
    maxOutputBytes: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_REMOTE_OUTPUT_BYTES }),
    ),
  },
  { additionalProperties: false },
);

const readOutputSchema = Type.Object(
  { content: Type.String(), truncated: Type.Boolean() },
  { additionalProperties: false },
);

const commandOutputSchema = Type.Object(
  {
    stdout: Type.String(),
    stderr: Type.String(),
    exitCode: Type.Integer(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function outputText(value: unknown): string {
  return JSON.stringify(value);
}

const REMOTE_EFFECT_MEMO = "uzina.remote-effect-evidence";

async function toolIdentity(
  api: ToolExecutionApi,
  context: Context,
): Promise<RemoteToolIdentity> {
  const identity = {
    conversationId: api.conversationId,
    taskId: String(api.taskId),
    callId: api.callId,
  };
  const stored = await api.memo(REMOTE_EFFECT_MEMO, identity, context);
  if (
    stored.conversationId !== identity.conversationId ||
    stored.taskId !== identity.taskId ||
    stored.callId !== identity.callId
  ) {
    throw new Error("Pi Durable effect evidence changed during recovery");
  }
  return identity;
}

function createRemoteTools(executor: RemoteToolExecutor): ToolRegistration[] {
  const read = defineTool({
    name: "remote_read_file",
    description:
      "Read a bounded UTF-8 file from the explicitly assigned workspace.",
    parameters: readSchema,
    structuredOutputSchema: readOutputSchema,
    replay: "safe",
    async execute(args, api, context) {
      const maxBytes = args.maxBytes ?? MAX_REMOTE_FILE_BYTES;
      const result = await executor.readFile(
        { path: args.path, maxBytes },
        await toolIdentity(api, context),
      );
      const content = truncateUtf8(result.content, maxBytes);
      const truncated = result.truncated || content !== result.content;
      const value = { content, truncated };
      return {
        output: [{ type: "text", text: outputText(value) }],
        structuredOutput: value,
      };
    },
  });

  const write = defineTool({
    name: "remote_write_file",
    description:
      "Write a bounded UTF-8 file inside the explicitly assigned workspace.",
    parameters: writeSchema,
    replay: "unsafe",
    async execute(args, api, context) {
      if (
        new TextEncoder().encode(args.content).byteLength >
        MAX_REMOTE_FILE_BYTES
      ) {
        throw new Error("Remote file content exceeds the 64 KiB limit");
      }
      await executor.writeFile(
        { path: args.path, content: args.content },
        await toolIdentity(api, context),
      );
      const result = { path: args.path, written: true };
      return {
        output: [{ type: "text", text: outputText(result) }],
        structuredOutput: result,
      };
    },
  });

  const command = defineTool({
    name: "remote_run_command",
    description:
      "Run a bounded argv command in the explicitly assigned workspace without shell parsing.",
    parameters: commandSchema,
    structuredOutputSchema: commandOutputSchema,
    replay: "unsafe",
    async execute(args, api, _context) {
      const maxOutputBytes = args.maxOutputBytes ?? MAX_REMOTE_OUTPUT_BYTES;
      const result = await executor.runCommand(
        {
          argv: args.argv,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          timeoutMs: args.timeoutMs ?? MAX_REMOTE_TIMEOUT_MS,
          maxOutputBytes,
        },
        await toolIdentity(api, _context),
      );
      const stdout = truncateUtf8(result.stdout, maxOutputBytes);
      const remaining = Math.max(
        0,
        maxOutputBytes - new TextEncoder().encode(stdout).byteLength,
      );
      const stderr = truncateUtf8(result.stderr, remaining);
      const value = {
        stdout,
        stderr,
        exitCode: result.exitCode,
        truncated:
          result.outputTruncated ||
          stdout !== result.stdout ||
          stderr !== result.stderr,
      };
      return {
        output: [{ type: "text", text: outputText(value) }],
        structuredOutput: value,
        isError: result.exitCode !== 0,
      };
    },
  });

  return [read, write, command];
}

export function createRemoteToolExtension(
  executor: RemoteToolExecutor,
): Extension {
  return defineExtension({
    name: REMOTE_TOOL_EXTENSION,
    tools: createRemoteTools(executor),
  });
}
