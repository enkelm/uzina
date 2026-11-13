import { z } from "zod";

export const EXECUTION_CONTRACT_VERSION = 1 as const;
export const MAX_EXECUTION_FILE_BYTES = 1_048_576;
export const MAX_EXECUTION_COMMAND_OUTPUT_BYTES = 65_536;
export const MAX_EXECUTION_COMMAND_TIMEOUT_MS = 120_000;

const versioned = { contractVersion: z.literal(EXECUTION_CONTRACT_VERSION) };
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const relativePath = z.string().min(1).max(2048);
const base64 = z.string().max(Math.ceil(MAX_EXECUTION_FILE_BYTES / 3) * 4);

export const executionNodeIdSchema = identifier.brand<"ExecutionNodeId">();
export const executionWorkspaceIdSchema =
  identifier.brand<"ExecutionWorkspaceId">();
export const executionJobIdSchema = identifier.brand<"ExecutionJobId">();
export const executionProcessIdSchema =
  identifier.brand<"ExecutionProcessId">();
export const ownershipGenerationSchema = z.number().int().nonnegative().safe();

export const executionTargetSchema = z
  .object({
    nodeId: executionNodeIdSchema,
    workspaceId: executionWorkspaceIdSchema,
  })
  .strict();

export const executionCapabilitiesSchema = z
  .object({
    fileRead: z.literal(true),
    fileWrite: z.literal(true),
    argvCommand: z.literal(true),
    rexProcessCreate: z.literal(true),
    rexProcessInspect: z.literal(true),
    rexProcessStop: z.literal(true),
  })
  .strict();

export const executionWorkspaceReportSchema = z
  .object({
    workspaceId: executionWorkspaceIdSchema,
    ownershipGeneration: ownershipGenerationSchema,
    state: z.enum(["active", "fenced"]),
  })
  .strict();

export const executionRegisterRequestSchema = z
  .object({
    ...versioned,
    nodeId: executionNodeIdSchema,
    daemonVersion: z.string().min(1).max(64),
    workspaces: z.array(executionWorkspaceReportSchema).max(256),
    capabilities: executionCapabilitiesSchema,
  })
  .strict();

export const executionRegisterResponseSchema = z
  .object({
    ...versioned,
    nodeId: executionNodeIdSchema,
    registered: z.literal(true),
    controllerTime: z.string().datetime(),
  })
  .strict();

export const executionHeartbeatRequestSchema = z
  .object({
    ...versioned,
    nodeId: executionNodeIdSchema,
    sentAt: z.string().datetime(),
    workspaces: z.array(executionWorkspaceReportSchema).max(256),
    capabilities: executionCapabilitiesSchema,
  })
  .strict();

export const executionHeartbeatResponseSchema = z
  .object({
    ...versioned,
    nodeId: executionNodeIdSchema,
    receivedAt: z.string().datetime(),
  })
  .strict();

export const executionClaimRequestSchema = z
  .object({ ...versioned, nodeId: executionNodeIdSchema })
  .strict();

const jobCommon = {
  ...versioned,
  jobId: executionJobIdSchema,
  nodeId: executionNodeIdSchema,
  target: executionTargetSchema,
  ownershipGeneration: ownershipGenerationSchema,
};

export const executionJobSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...jobCommon,
      operation: z.literal("read-file"),
      path: relativePath,
      maxBytes: z.number().int().positive().max(MAX_EXECUTION_FILE_BYTES),
    })
    .strict(),
  z
    .object({
      ...jobCommon,
      operation: z.literal("write-file"),
      path: relativePath,
      contentBase64: base64,
    })
    .strict(),
  z
    .object({
      ...jobCommon,
      operation: z.literal("argv-command"),
      argv: z.array(z.string().min(1).max(4096)).min(1).max(128),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_EXECUTION_COMMAND_TIMEOUT_MS),
      maxOutputBytes: z
        .number()
        .int()
        .positive()
        .max(MAX_EXECUTION_COMMAND_OUTPUT_BYTES),
    })
    .strict(),
]);

export const executionResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("read-file"),
      contentBase64: base64,
      bytes: z.number().int().nonnegative().max(MAX_EXECUTION_FILE_BYTES),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      operation: z.literal("write-file"),
      bytes: z.number().int().nonnegative().max(MAX_EXECUTION_FILE_BYTES),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      operation: z.literal("argv-command"),
      exitCode: z.number().int().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      outputTruncated: z.boolean(),
      timedOut: z.boolean(),
    })
    .strict(),
]);

export const executionReceiptStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "uncertain",
]);

export const executionReceiptSchema = z
  .object({
    ...versioned,
    jobId: executionJobIdSchema,
    nodeId: executionNodeIdSchema,
    target: executionTargetSchema,
    ownershipGeneration: ownershipGenerationSchema,
    operation: z.enum(["read-file", "write-file", "argv-command"]),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: executionReceiptStatusSchema,
    acceptedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    result: executionResultSchema.optional(),
    errorCode: z.string().min(1).max(128).optional(),
    reconciliationEvidence: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const executionJobReportSchema = z
  .object({
    ...versioned,
    jobId: executionJobIdSchema,
    nodeId: executionNodeIdSchema,
    target: executionTargetSchema,
    ownershipGeneration: ownershipGenerationSchema,
    status: z.enum(["completed", "failed", "uncertain"]),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    finishedAt: z.string().datetime(),
    result: executionResultSchema.optional(),
    errorCode: z.string().min(1).max(128).optional(),
    reconciliationEvidence: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const executionClaimResponseSchema = z
  .object({
    ...versioned,
    job: executionJobSchema.nullable(),
  })
  .strict();

export const executionReportResponseSchema = z
  .object({
    ...versioned,
    nodeId: executionNodeIdSchema,
    jobId: executionJobIdSchema,
    accepted: z.literal(true),
    status: z.enum(["completed", "failed", "uncertain"]),
  })
  .strict();

export const executionRexLaunchRequestSchema = z
  .object({
    ...versioned,
    processId: executionProcessIdSchema,
    nodeId: executionNodeIdSchema,
    target: executionTargetSchema,
    ownershipGeneration: ownershipGenerationSchema,
    argv: z.array(z.string().min(1).max(4096)).min(1).max(128),
  })
  .strict();

export const executionRexProcessReceiptSchema = z
  .object({
    ...versioned,
    processId: executionProcessIdSchema,
    nodeId: executionNodeIdSchema,
    target: executionTargetSchema,
    ownershipGeneration: ownershipGenerationSchema,
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["starting", "running", "stopping", "exited", "uncertain"]),
    launchedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    sessionId: z.string().min(1).max(256).optional(),
    blockId: z.string().min(1).max(256).optional(),
    exitCode: z.number().int().nullable().optional(),
    errorCode: z.string().min(1).max(128).optional(),
    reconciliationEvidence: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const executionRexInspectionSchema = z
  .object({
    ...versioned,
    processId: executionProcessIdSchema,
    status: z.enum(["running", "exited", "uncertain"]),
    exitCode: z.number().int().nullable().optional(),
  })
  .strict();

export type ExecutionCapabilities = z.infer<typeof executionCapabilitiesSchema>;
export type ExecutionClaimRequest = z.infer<typeof executionClaimRequestSchema>;
export type ExecutionHeartbeatRequest = z.infer<
  typeof executionHeartbeatRequestSchema
>;
export type ExecutionJob = z.infer<typeof executionJobSchema>;
export type ExecutionJobReport = z.infer<typeof executionJobReportSchema>;
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export type ExecutionRegisterRequest = z.infer<
  typeof executionRegisterRequestSchema
>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export type ExecutionRexInspection = z.infer<
  typeof executionRexInspectionSchema
>;
export type ExecutionRexLaunchRequest = z.infer<
  typeof executionRexLaunchRequestSchema
>;
export type ExecutionRexProcessReceipt = z.infer<
  typeof executionRexProcessReceiptSchema
>;
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
export type ExecutionWorkspaceReport = z.infer<
  typeof executionWorkspaceReportSchema
>;
