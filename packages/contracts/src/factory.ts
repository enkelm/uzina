import { z } from "zod";
import { CONTRACT_VERSION, actorIdentitySchema } from "./index";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const displayName = z.string().trim().min(1).max(120);
const versioned = { contractVersion: z.literal(CONTRACT_VERSION) };

export const factoryActorSchema = actorIdentitySchema;
export const factoryCredentialKindSchema = z.enum([
  "human",
  "assistant",
  "node",
]);
export const factoryTargetSchema = z.object({
  nodeId: identifier,
  workspaceId: identifier,
});

export const bootstrapFactoryRequestSchema = z
  .object({ name: displayName })
  .strict();
export const provisionCredentialRequestSchema = z
  .object({
    kind: z.enum(["human", "assistant"]),
    name: displayName,
  })
  .strict();
export const provisionNodeRequestSchema = z
  .object({ nodeId: identifier.optional(), name: displayName })
  .strict();
export const createProjectRequestSchema = z
  .object({ projectId: identifier.optional(), name: displayName })
  .strict();
export const createWorkspaceRequestSchema = z
  .object({
    workspaceId: identifier.optional(),
    nodeId: identifier,
    name: displayName,
  })
  .strict();
export const createThreadRequestSchema = z
  .object({
    threadId: identifier.optional(),
    projectId: identifier,
    title: displayName,
    target: factoryTargetSchema,
  })
  .strict();
export const submitInputRequestSchema = z
  .object({
    requestId: identifier,
    text: z.string().min(1).max(100_000),
  })
  .strict();
export const registerNodeRequestSchema = z.object({}).strict();
export const heartbeatNodeRequestSchema = z.object({}).strict();
export const reportNodeJobRequestSchema = z
  .object({
    workspaceId: identifier,
    ownershipGeneration: z.number().int().nonnegative().safe(),
    status: z.enum(["completed", "failed", "uncertain"]),
    detail: z.string().max(4_000).optional(),
  })
  .strict();

export const provisionedCredentialSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  credentialId: identifier,
  name: displayName,
  actor: factoryActorSchema,
  credential: z.string().min(1),
});
export const factoryProjectSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  projectId: identifier,
  name: displayName,
  createdAt: z.string().datetime(),
});
export const factoryNodeSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  nodeId: identifier,
  name: displayName,
  availability: z.enum(["offline", "online"]),
  lastSeenAt: z.string().datetime().nullable(),
});
export const factoryWorkspaceSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  workspaceId: identifier,
  nodeId: identifier,
  name: displayName,
});
export const factoryThreadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  threadId: identifier,
  projectId: identifier,
  title: displayName,
  target: factoryTargetSchema,
  ownershipGeneration: z.number().int().nonnegative().safe(),
  createdAt: z.string().datetime(),
});

export const factoryDispatchStatusSchema = z.enum([
  "queued",
  "unavailable",
  "running",
  "dispatched",
  "completed",
  "failed",
  "uncertain",
]);
export const factoryCommandReceiptSchema = z.object({
  ...versioned,
  status: z.literal("accepted"),
  requestId: identifier,
  jobId: identifier,
  threadId: identifier,
  target: factoryTargetSchema,
  ownershipGeneration: z.number().int().nonnegative().safe(),
  dispatchStatus: factoryDispatchStatusSchema,
  acceptedAt: z.string().datetime(),
  outcome: z.string().max(4_000).optional(),
});
export const factoryQueueJobSchema = z.object({
  ...versioned,
  jobId: identifier,
  requestId: identifier,
  threadId: identifier,
  actor: factoryActorSchema,
  target: factoryTargetSchema,
  ownershipGeneration: z.number().int().nonnegative().safe(),
  input: z
    .object({ kind: z.literal("managed-input"), text: z.string() })
    .strict(),
});
export const factoryEventSchema = z.object({
  ...versioned,
  cursor: z.number().int().positive().safe(),
  type: z.enum([
    "factory.bootstrapped",
    "credential.provisioned",
    "project.created",
    "node.provisioned",
    "node.registered",
    "node.heartbeat",
    "workspace.created",
    "thread.created",
    "command.accepted",
    "dispatch.unavailable",
    "dispatch.started",
    "dispatch.dispatched",
    "dispatch.completed",
    "dispatch.failed",
    "dispatch.uncertain",
    "credential.revoked",
  ]),
  actor: factoryActorSchema,
  projectId: identifier.nullable(),
  threadId: identifier.nullable(),
  requestId: identifier.nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export const factoryEventsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  events: z.array(factoryEventSchema),
  nextCursor: z.number().int().nonnegative().safe(),
});

export type FactoryActor = z.infer<typeof factoryActorSchema>;
export type FactoryCredentialKind = z.infer<typeof factoryCredentialKindSchema>;
export type FactoryTarget = z.infer<typeof factoryTargetSchema>;
export type ProvisionedCredential = z.infer<typeof provisionedCredentialSchema>;
export type FactoryProject = z.infer<typeof factoryProjectSchema>;
export type FactoryNode = z.infer<typeof factoryNodeSchema>;
export type FactoryWorkspace = z.infer<typeof factoryWorkspaceSchema>;
export type FactoryThread = z.infer<typeof factoryThreadSchema>;
export type FactoryDispatchStatus = z.infer<typeof factoryDispatchStatusSchema>;
export type FactoryCommandReceipt = z.infer<typeof factoryCommandReceiptSchema>;
export type FactoryQueueJob = z.infer<typeof factoryQueueJobSchema>;
export type FactoryEvent = z.infer<typeof factoryEventSchema>;

export interface ManagedRuntimeDispatch {
  dispatch(
    input: FactoryQueueJob,
  ): Promise<
    | { status: "dispatched"; detail?: string }
    | { status: "failed"; detail?: string }
    | { status: "uncertain"; detail?: string }
  >;
}
