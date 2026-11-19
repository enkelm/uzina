import { z } from "zod";
import { executionRexProcessReceiptSchema } from "./execution";
import {
  nativeAgentLaunchRequestSchema,
  nativeAgentMcpReadinessSchema,
} from "./native-agents";
import { CONTRACT_VERSION } from "./index";
import { nativeConversationBindingSchema } from "./assignments";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const provisionNativeWorkerRequestSchema = z
  .object({
    requestId: id,
    projectId: id,
    targetId: id,
    profileId: id,
    name: z.string().trim().min(1).max(160),
  })
  .strict();
export const nativeProvisioningBindingSchema = nativeAgentLaunchRequestSchema
  .omit({ requestId: true })
  .extend({
    targetId: id,
    allowAssistant: z.boolean(),
    maxWorkers: z.number().int().min(1).max(32).default(8),
  })
  .strict();
export const nativeProvisioningStatusSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    request: provisionNativeWorkerRequestSchema,
    binding: nativeProvisioningBindingSchema,
    workerId: id,
    scopeId: id,
    nativeBinding: nativeConversationBindingSchema.nullable().default(null),
    capabilities: z
      .object({
        rexTools: z.literal(true),
        factoryCoordination: z.literal(true),
        automaticDelivery: z.boolean(),
        nativeActivity: z.boolean(),
      })
      .strict()
      .default({
        rexTools: true,
        factoryCoordination: true,
        automaticDelivery: false,
        nativeActivity: false,
      }),
    status: z.enum(["admitted", "starting", "ready", "uncertain", "stopped"]),
    process: executionRexProcessReceiptSchema.nullable(),
    mcp: z
      .object({
        rex: nativeAgentMcpReadinessSchema,
        factory: nativeAgentMcpReadinessSchema,
      })
      .strict()
      .nullable(),
    errorCode: z.string().max(100).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const nativeProvisioningTargetsSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    targets: z
      .array(
        z
          .object({
            targetId: id,
            projectId: id,
            profileIds: z.array(id).max(32),
            target: nativeAgentLaunchRequestSchema.shape.target,
            ownershipGeneration:
              nativeAgentLaunchRequestSchema.shape.ownershipGeneration,
            allowAssistant: z.boolean(),
            maxWorkers: z.number().int().min(1).max(32).default(8),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ProvisionNativeWorkerRequest = z.infer<
  typeof provisionNativeWorkerRequestSchema
>;
export type NativeProvisioningBinding = z.infer<
  typeof nativeProvisioningBindingSchema
>;
export type NativeProvisioningStatus = z.infer<
  typeof nativeProvisioningStatusSchema
>;
export type NativeProvisioningTargets = z.infer<
  typeof nativeProvisioningTargetsSchema
>;
export type NativeProvisioningTargetInput = z.input<
  typeof nativeProvisioningTargetsSchema
>["targets"];

export const factoryWorkerConfigurationSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/" &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      }),
    credential: z
      .string()
      .min(32)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    workerId: id,
    projectId: id,
    target: nativeAgentLaunchRequestSchema.shape.target,
    ownershipGeneration:
      nativeAgentLaunchRequestSchema.shape.ownershipGeneration,
    journalPath: z.string().min(1).max(4096),
    nativeDelivery: z
      .object({
        binding: nativeConversationBindingSchema.extend({
          adapter: z.literal("pi"),
          sessionId: z.string().uuid(),
        }),
        statePath: z.string().min(1).max(4096),
        sessionDirectory: z.string().min(1).max(4096),
        workspaceDirectory: z.string().min(1).max(4096),
        factoryToolName: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FactoryWorkerConfiguration = z.infer<
  typeof factoryWorkerConfigurationSchema
>;
const item = {
  itemId: id,
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(8000),
};
export const factoryWorkerToolInputSchema = z
  .object({
    op: z.enum(["status", "ask", "report", "inbox", "acknowledge"]),
    itemId: item.itemId.optional(),
    title: item.title.optional(),
    text: item.text.optional(),
    blocking: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    messageId: id.optional(),
  })
  .strict();
export const factoryWorkerToolRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }).strict(),
  z
    .object({
      op: z.literal("ask"),
      ...item,
      blocking: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      op: z.literal("report"),
      ...item,
      blocking: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      op: z.literal("inbox"),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  z.object({ op: z.literal("acknowledge"), messageId: id }).strict(),
]);
