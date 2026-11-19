import { z } from "zod";
import { executionTargetSchema, ownershipGenerationSchema } from "./execution";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** Paths, environment, CLI arguments and credentials are trusted host configuration, never launch input. */
export const nativeAgentLaunchRequestSchema = z
  .object({
    requestId: identifier,
    projectId: identifier,
    profileId: identifier,
    target: executionTargetSchema,
    ownershipGeneration: ownershipGenerationSchema,
  })
  .strict();

export type NativeAgentLaunchRequest = z.infer<
  typeof nativeAgentLaunchRequestSchema
>;
export type NativeAgentLaunchInput = z.input<
  typeof nativeAgentLaunchRequestSchema
>;

const argument = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
export const nativeAgentBootstrapSchema = z
  .object({
    workspaceDirectory: argument,
    executable: argument,
    argv: z.array(argument).max(128),
    environment: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z
        .string()
        .max(32768)
        .refine((value) => !value.includes("\0")),
    ),
  })
  .strict();
export const nativeAgentProfileSchema = z
  .object({
    agent: z.enum(["pi", "codex"]),
    executable: z.string().min(1),
    /** Trusted operator values; dedicated worker/model credentials only. */
    environment: nativeAgentBootstrapSchema.shape.environment.default({}),
    offline: z.boolean().default(false),
  })
  .strict();
export type NativeAgentProfile = z.input<typeof nativeAgentProfileSchema>;
export type ParsedNativeAgentProfile = z.output<
  typeof nativeAgentProfileSchema
>;

export const nativeAgentMcpReadinessSchema = z
  .object({
    status: z.enum([
      "pending",
      "initialized",
      "ready",
      "disconnected",
      "unavailable",
    ]),
    initializedAt: z.string().datetime().optional(),
    catalogServedAt: z.string().datetime().optional(),
    verifiedAt: z.string().datetime().optional(),
    client: z
      .object({ name: z.string().max(128), version: z.string().max(128) })
      .optional(),
    errorCode: z.string().max(100).optional(),
  })
  .strict();
export type NativeAgentMcpReadiness = z.infer<
  typeof nativeAgentMcpReadinessSchema
>;
