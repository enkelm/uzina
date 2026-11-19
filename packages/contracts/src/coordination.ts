import { z } from "zod";
import { CONTRACT_VERSION, actorIdentitySchema } from "./index";
import {
  nativeAssignmentSchema,
  nativeAssignmentRecordSchema,
  nativeConversationBindingSchema,
  nativeActivitySchema,
} from "./assignments";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const text = z.string().trim().min(1).max(8_000);
const timestamp = z.string().datetime();
export const registerNativeWorkerSchema = z
  .object({
    workerId: id,
    projectId: id,
    name: z.string().trim().min(1).max(160),
    target: z.object({ nodeId: id, workspaceId: id }).strict(),
    ownershipGeneration: z.number().int().nonnegative().safe(),
    rex: z
      .object({
        sessionId: z.string().min(1).max(256),
        blockId: z.string().min(1).max(256),
      })
      .strict(),
    // Supplied by the trusted provisioner so a lost reply never loses the only copy.
    credential: z
      .string()
      .min(32)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export const nativeWorkerSchema = registerNativeWorkerSchema
  .omit({ credential: true })
  .extend({
    contractVersion: z.literal(CONTRACT_VERSION),
    createdAt: timestamp,
    revokedAt: timestamp.nullable(),
    rex: registerNativeWorkerSchema.shape.rex.nullable(),
    nativeBinding: nativeConversationBindingSchema.nullable().default(null),
    activity: nativeActivitySchema.nullable().default(null),
    provisioningStatus: z
      .enum(["preparing", "starting", "ready", "uncertain", "stopped"])
      .nullable()
      .default(null),
  });
export const postCoordinationItemSchema = z
  .object({
    itemId: id,
    kind: z.enum(["question", "report"]),
    title: z.string().trim().min(1).max(200),
    text,
    blocking: z.boolean(),
  })
  .strict();
export const coordinationStatusSchema = z.enum([
  "bot_pending",
  "needs_user",
  "answered",
  "acknowledged",
]);
export const workerMessageSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    messageId: id,
    workerId: id,
    itemId: id.nullable(),
    kind: z.enum(["answer", "instruction"]),
    text,
    actor: actorIdentitySchema,
    createdAt: timestamp,
    acknowledgedAt: timestamp.nullable(),
    assignment: nativeAssignmentSchema.nullable().default(null),
    native: nativeAssignmentRecordSchema
      .omit({ assignment: true, workerId: true, projectId: true })
      .nullable()
      .default(null),
  })
  .strict();
export const coordinationItemSchema = postCoordinationItemSchema
  .extend({
    contractVersion: z.literal(CONTRACT_VERSION),
    workerId: id,
    projectId: id,
    status: coordinationStatusSchema,
    escalation: text.nullable(),
    answer: workerMessageSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const decideCoordinationItemSchema = z
  .object({
    requestId: id,
    action: z.enum(["answer", "escalate"]),
    text,
  })
  .strict();
export const coordinationReceiptSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    requestId: id,
    item: coordinationItemSchema.nullable(),
    message: workerMessageSchema.nullable(),
  })
  .strict();
export const sendWorkerMessageSchema = z
  .object({
    requestId: id,
    text,
    assignment: nativeAssignmentSchema.optional(),
  })
  .strict();
export const acknowledgeWorkerMessageSchema = z
  .object({ messageId: id })
  .strict();
export const workerListSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  workers: z.array(nativeWorkerSchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export const coordinationListSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  items: z.array(coordinationItemSchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
  needsUserCount: z.number().int().nonnegative(),
});
export const workerMailboxSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  messages: z.array(workerMessageSchema).max(100),
});
export const workerRuntimeSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    worker: nativeWorkerSchema,
    assignment: nativeAssignmentRecordSchema.nullable(),
    blockingItems: z
      .array(
        z
          .object({
            itemId: id,
            status: coordinationStatusSchema,
            answerMessageId: id.nullable(),
          })
          .strict(),
      )
      .max(100),
    mailbox: workerMailboxSchema,
  })
  .strict();
export type WorkerRuntime = z.infer<typeof workerRuntimeSchema>;
export type NativeWorker = z.infer<typeof nativeWorkerSchema>;
export type CoordinationItem = z.infer<typeof coordinationItemSchema>;
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
