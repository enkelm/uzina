import { z } from "zod";
import { CONTRACT_VERSION, actorIdentitySchema } from "./index";
import {
  executionCaptureControlIdSchema,
  executionCaptureIdSchema,
  executionCaptureFenceReceiptSchema,
  executionReceiptSchema,
} from "./execution";

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

export const accessGrantSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project"), resourceId: identifier }).strict(),
  z.object({ type: z.literal("thread"), resourceId: identifier }).strict(),
]);
const distinctGrants = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(schema).superRefine((grants, context) => {
    const seen = new Set<string>();
    grants.forEach((grant, index) => {
      const value = grant as { type: string; resourceId?: string };
      const key = `${value.type}:${value.resourceId ?? ""}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Grant targets must be unique",
        });
      }
      seen.add(key);
    });
  });

export const bootstrapFactoryRequestSchema = z
  .object({ name: displayName })
  .strict();
export const assistantCredentialGrantSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("factory") }).strict(),
  z.object({ type: z.literal("project"), resourceId: identifier }).strict(),
  z.object({ type: z.literal("thread"), resourceId: identifier }).strict(),
]);
export const assistantCredentialGrantsSchema = distinctGrants(
  assistantCredentialGrantSchema,
).superRefine((grants, context) => {
  if (grants.some((grant) => grant.type === "factory") && grants.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Factory-wide assistant access cannot be combined with narrower grants",
    });
  }
});
export const provisionCredentialRequestSchema = z
  .object({
    kind: z.enum(["human", "assistant"]),
    name: displayName,
    assistantGrants: assistantCredentialGrantsSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.kind === "human" && request.assistantGrants !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assistantGrants"],
        message: "Assistant grants apply only to assistant credentials",
      });
    }
  });
export const assistantCredentialGrantsRequestSchema = z
  .object({
    grants: assistantCredentialGrantsSchema,
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
    ownerPrivate: z.boolean().optional(),
  })
  .strict();
export const accessRoleSchema = z.enum(["owner", "guest", "viewer"]);
export const participantRoleSchema = z.enum(["guest", "viewer"]);
export const invitationCreateRequestSchema = z
  .object({
    role: participantRoleSchema,
    grants: distinctGrants(accessGrantSchema),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const invitationRedeemRequestSchema = z
  .object({ code: z.string().min(1).max(256), displayName })
  .strict();
export const participantAccessRequestSchema = z
  .object({
    role: participantRoleSchema,
    grants: distinctGrants(accessGrantSchema),
  })
  .strict();
export const discussionPostRequestSchema = z
  .object({ text: z.string().trim().min(1).max(20_000) })
  .strict();
export const submitInputRequestSchema = z
  .object({
    requestId: identifier,
    text: z.string().min(1).max(100_000),
  })
  .strict();
export const provisionedCredentialSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  credentialId: identifier,
  name: displayName,
  actor: factoryActorSchema,
  credential: z.string().min(1),
  assistantGrants: z.array(assistantCredentialGrantSchema).optional(),
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
  ownerPrivate: z.boolean().default(false),
  ownershipGeneration: z.number().int().nonnegative().safe(),
  createdAt: z.string().datetime(),
});
export const factoryParticipantSchema = z.object({
  userId: identifier,
  displayName,
  role: accessRoleSchema,
  revokedAt: z.string().datetime().nullable(),
  grants: z.array(accessGrantSchema),
  createdAt: z.string().datetime(),
});
export const factoryInvitationSchema = z.object({
  invitationId: identifier,
  role: participantRoleSchema,
  grants: z.array(accessGrantSchema),
  expiresAt: z.string().datetime(),
  redeemedAt: z.string().datetime().nullable(),
  redeemedBy: identifier.nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export const invitationRedemptionResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  participant: factoryParticipantSchema,
  credentialId: identifier,
  credentialName: displayName,
  credential: z.string().min(1),
  actor: factoryActorSchema,
});
export const discussionEntrySchema = z.object({
  discussionId: identifier,
  threadId: identifier,
  actor: factoryActorSchema,
  displayName,
  text: z.string(),
  createdAt: z.string().datetime(),
});

export const captureControlAdmissionRequestSchema = z
  .object({ ...versioned, requestId: identifier })
  .strict();
export const captureControlStatusSchema = z
  .object({
    ...versioned,
    requestId: identifier,
    controlId: executionCaptureControlIdSchema,
    captureId: executionCaptureIdSchema,
    threadId: identifier,
    target: factoryTargetSchema,
    ownershipGeneration: z.number().int().nonnegative().safe(),
    status: z.enum(["queued", "claimed", "source-capture-fenced", "blocked"]),
    acceptedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    sourceFence: executionCaptureFenceReceiptSchema.optional(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();

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
  executionEffects: z.array(executionReceiptSchema).optional(),
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
  // Owner cursors use the durable sequence; participant cursors are scope-local and generation-bound.
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
    "credential.grants_changed",
    "invitation.created",
    "invitation.revoked",
    "invitation.redeemed",
    "participant.access_changed",
    "participant.revoked",
    "discussion.posted",
    "execution.accepted",
    "execution.completed",
    "execution.failed",
    "execution.uncertain",
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
export type AccessGrant = z.infer<typeof accessGrantSchema>;
export type AssistantCredentialGrant = z.infer<
  typeof assistantCredentialGrantSchema
>;
export type ParticipantRole = z.infer<typeof participantRoleSchema>;
export type FactoryParticipant = z.infer<typeof factoryParticipantSchema>;
export type FactoryInvitation = z.infer<typeof factoryInvitationSchema>;
export type CaptureControlAdmissionRequest = z.infer<
  typeof captureControlAdmissionRequestSchema
>;
export type CaptureControlStatus = z.infer<typeof captureControlStatusSchema>;
export type DiscussionEntry = z.infer<typeof discussionEntrySchema>;
export type FactoryDispatchStatus = z.infer<typeof factoryDispatchStatusSchema>;
export type FactoryCommandReceipt = z.infer<typeof factoryCommandReceiptSchema>;
export type FactoryQueueJob = z.infer<typeof factoryQueueJobSchema>;
export type FactoryEvent = z.infer<typeof factoryEventSchema>;

export interface ManagedRuntimeDispatch {
  dispatch(
    input: FactoryQueueJob,
  ): Promise<
    | { status: "dispatched"; detail?: string }
    | { status: "completed"; detail?: string }
    | { status: "failed"; detail?: string }
    | { status: "uncertain"; detail?: string }
  >;
}
