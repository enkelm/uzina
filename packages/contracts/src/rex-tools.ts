import { z } from "zod";

const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const argv = z
  .array(
    z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0"), "Arguments cannot contain NUL"),
  )
  .min(1)
  .max(128);
const waitMs = z.number().int().min(0).max(30_000);
const tailLines = z.number().int().min(1).max(500);
const maxBytes = z.number().int().min(256).max(32_768);

/** An object-shaped discovery schema, with operation-specific validation below. */
export const rexToolInputSchema = z
  .object({
    op: z.enum(["context", "run", "inspect", "wait", "output"]),
    requestId: requestId.optional(),
    argv: argv.optional(),
    waitMs: waitMs.optional(),
    tailLines: tailLines.optional(),
    maxBytes: maxBytes.optional(),
  })
  .strict();

const outputOptions = {
  tailLines: tailLines.default(30),
  maxBytes: maxBytes.default(8192),
};
export const rexToolRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("context") }).strict(),
  z
    .object({
      op: z.literal("run"),
      requestId,
      argv,
      waitMs: waitMs.default(0),
      ...outputOptions,
    })
    .strict(),
  z.object({ op: z.literal("inspect"), requestId }).strict(),
  z
    .object({
      op: z.literal("wait"),
      requestId,
      waitMs: waitMs.default(1000),
    })
    .strict(),
  z.object({ op: z.literal("output"), requestId, ...outputOptions }).strict(),
]);

/** Trusted local configuration, not model-supplied arguments or Factory authority. */
export const rexToolConfigurationSchema = z
  .object({
    workspaceDirectory: z.string().min(1).max(4096),
    journalPath: z.string().min(1).max(4096),
    server: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "unix:" &&
            url.hostname === "" &&
            url.pathname.startsWith("/") &&
            url.pathname !== "/" &&
            !url.search &&
            !url.hash &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }, "An explicit local unix:// Rex endpoint is required"),
    rexExecutable: z.string().min(1).max(4096).default("rex"),
  })
  .strict();

export type RexToolRequest = z.infer<typeof rexToolRequestSchema>;
export type RexToolConfiguration = z.infer<typeof rexToolConfigurationSchema>;
