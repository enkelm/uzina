import { z } from "zod";

export const CONTRACT_VERSION = 1 as const;

const stableIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const commandIdSchema = stableIdentifier.brand<"CommandId">();
export const jobIdSchema = stableIdentifier.brand<"JobId">();
export const actorIdSchema = stableIdentifier.brand<"ActorId">();
export const nodeIdSchema = stableIdentifier.brand<"NodeId">();
export const workspaceIdSchema = stableIdentifier.brand<"WorkspaceId">();
export const ownershipGenerationSchema = z.number().int().nonnegative().safe();

const versioned = {
  contractVersion: z.literal(CONTRACT_VERSION),
};

export const actorIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    ...versioned,
    kind: z.literal("human"),
    userId: actorIdSchema,
  }),
  z.object({
    ...versioned,
    kind: z.literal("assistant"),
    assistantId: actorIdSchema,
    ownerId: actorIdSchema,
  }),
  z.object({
    ...versioned,
    kind: z.literal("node"),
    nodeId: nodeIdSchema,
  }),
]);

export const executionTargetSchema = z.object({
  nodeId: nodeIdSchema,
  workspaceId: workspaceIdSchema,
});

export const commandAcceptanceSchema = z.object({
  ...versioned,
  status: z.literal("accepted"),
  commandId: commandIdSchema,
  jobId: jobIdSchema,
  target: executionTargetSchema,
  ownershipGeneration: ownershipGenerationSchema,
  acceptedAt: z.string().datetime(),
});

export const executionOutcomeSchema = z.object({
  ...versioned,
  status: z.enum(["completed", "failed", "uncertain"]),
  commandId: commandIdSchema,
  jobId: jobIdSchema,
  target: executionTargetSchema,
  ownershipGeneration: ownershipGenerationSchema,
  observedAt: z.string().datetime(),
});

export const capabilityDescriptionSchema = z.object({
  operation: z.enum([
    "reattach",
    "native-resume",
    "managed-checkpoint-recovery",
    "steer",
    "stop",
  ]),
  supported: z.boolean(),
});

export const capabilitySetSchema = z.object({
  ...versioned,
  capabilities: z.array(capabilityDescriptionSchema),
});

export const healthResponseSchema = z.object({
  ...versioned,
  status: z.literal("ok"),
});

export const identityResponseSchema = z.object({
  ...versioned,
  actor: actorIdentitySchema,
});

export type ActorIdentity = z.infer<typeof actorIdentitySchema>;
export type CommandAcceptance = z.infer<typeof commandAcceptanceSchema>;
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
export type CapabilityDescription = z.infer<typeof capabilityDescriptionSchema>;
