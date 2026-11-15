import { z } from "zod";
import { CONTRACT_VERSION, actorIdentitySchema } from "./index";
import { EXECUTION_CONTRACT_VERSION } from "./execution";
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
export const privateAssistantInputRequestSchema = z
  .object({ inputId: identifier, text: z.string().min(1).max(100_000) })
  .strict();
export const privateAssistantReceiptSchema = z.object({
  inputId: identifier,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: identifier,
  submissionId: identifier.nullable(),
  acceptedAt: z.string().datetime(),
  submission: z.unknown().optional(),
});
export const privateAssistantStatusSchema = z.object({
  available: z.boolean(),
  state: z.enum(["ready", "parked"]),
  reason: z
    .enum([
      "configuration_missing",
      "credential_unavailable",
      "identity_mismatch",
      "identity_persistence_unavailable",
    ])
    .nullable(),
  detail: z.string().nullable(),
  runtime: z.unknown(),
});
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
    historical: z.literal(true).optional(),
  })
  .strict();

export const workspaceSnapshotRequestSchema = z
  .object({ ...versioned, requestId: identifier, captureRequestId: identifier })
  .strict();
export const workspaceSnapshotStatusSchema = z
  .object({
    ...versioned,
    requestId: identifier,
    snapshotId: identifier,
    captureRequestId: identifier,
    captureId: executionCaptureIdSchema,
    threadId: identifier,
    target: factoryTargetSchema,
    ownershipGeneration: z.number().int().nonnegative().safe(),
    status: z.enum([
      "queued",
      "claimed",
      "workspace-checkpoint-available",
      "blocked",
      "uncertain",
    ]),
    acceptedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    manifestReference: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    errorCode: z.string().min(1).max(128).optional(),
    historical: z.literal(true).optional(),
  })
  .strict();

export const managedWorkCheckpointRequestSchema = z
  .object({
    ...versioned,
    requestId: identifier,
    captureRequestId: identifier,
    workspaceSnapshotRequestId: identifier,
  })
  .strict();
export const managedWorkImportRequestSchema = z
  .object({
    ...versioned,
    requestId: identifier,
    sourceCatalogId: identifier,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    destinationId: identifier,
  })
  .strict();
export const managedWorkImportHostBindingSchema = z
  .object({
    hostDescriptor: z.string().min(1).max(4096),
    sourceCatalog: z
      .object({
        sourceCatalogId: identifier,
        canonicalRoot: z.string().min(1).max(4096),
      })
      .strict(),
    destination: z
      .object({
        destinationId: identifier,
        canonicalRoot: z.string().min(1).max(4096),
      })
      .strict(),
  })
  .strict();
export const managedWorkImportPreparationReceiptSchema = z
  .object({
    format: z.literal("uzina-prepared-managed-work-restore"),
    version: z.literal(1),
    status: z.literal("prepared-inactive"),
    receiptId: z.string().regex(/^[a-f0-9]{64}$/),
    manifestReference: z.string().regex(/^[a-f0-9]{64}$/),
    preparedAt: z.string().datetime(),
    workspacePath: z.literal("workspace"),
    runtimePath: z.literal("managed-work.sqlite"),
    attachmentNames: z.array(z.string().min(1).max(1024)).max(100_000),
  })
  .strict();
export const managedWorkImportStatusSchema = z
  .object({
    ...versioned,
    requestId: identifier,
    ownerId: identifier,
    actor: factoryActorSchema,
    sourceCatalogId: identifier,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    destinationId: identifier,
    hostBinding: managedWorkImportHostBindingSchema,
    status: z.enum([
      "admitted",
      "preparing",
      "prepared-inactive",
      "blocked",
      "uncertain",
    ]),
    acceptedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    preparationReceipt: managedWorkImportPreparationReceiptSchema.optional(),
    preparationReceiptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    errorCode: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
      .optional(),
  })
  .strict()
  .superRefine((status, context) => {
    const hasReceipt = status.preparationReceipt !== undefined;
    const hasReceiptHash = status.preparationReceiptSha256 !== undefined;
    const terminalError =
      status.status === "blocked" || status.status === "uncertain";
    if (
      status.hostBinding.sourceCatalog.sourceCatalogId !==
        status.sourceCatalogId ||
      status.hostBinding.destination.destinationId !== status.destinationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hostBinding"],
        message:
          "Host descriptors must bind the configured catalog and destination IDs",
      });
    }
    if (
      (status.status === "prepared-inactive" &&
        !(hasReceipt && hasReceiptHash)) ||
      hasReceipt !== hasReceiptHash ||
      ((status.status === "admitted" ||
        status.status === "preparing" ||
        status.status === "blocked") &&
        hasReceipt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preparationReceipt"],
        message: "Preparation evidence must match the import state",
      });
    }
    if (terminalError !== (status.errorCode !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message:
          "Blocked and uncertain imports require a normalized error code",
      });
    }
    if (
      status.preparationReceipt &&
      status.preparationReceipt.manifestReference !== status.manifestSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preparationReceipt", "manifestReference"],
        message: "Preparation receipt must bind the requested manifest",
      });
    }
  });
export const managedWorkImportOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("prepared-inactive"),
      preparationReceipt: managedWorkImportPreparationReceiptSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(["blocked", "uncertain"]),
      errorCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    })
    .strict(),
]);
export const managedWorkCheckpointStageSchema = z.enum([
  "admitted",
  "runtime-export-started",
  "runtime-export-recorded",
  "evidence-write-started",
  "evidence-recorded",
  "bundle-compose-started",
  "bundle-composed",
  "closure-verification-started",
  "available",
]);
export const managedWorkCheckpointStatusSchema = z
  .object({
    ...versioned,
    requestId: identifier,
    captureRequestId: identifier,
    workspaceSnapshotRequestId: identifier,
    captureId: executionCaptureIdSchema,
    threadId: identifier,
    target: factoryTargetSchema,
    ownershipGeneration: z.number().int().nonnegative().safe(),
    status: z.enum(["assembling", "available", "blocked", "uncertain"]),
    stage: managedWorkCheckpointStageSchema,
    acceptedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    manifestReference: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    historical: z.literal(true).optional(),
  })
  .strict()
  .superRefine((status, context) => {
    if (
      status.status === "available" &&
      (status.stage !== "available" || !status.manifestReference)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manifestReference"],
        message: "Available checkpoints require a verified manifest reference",
      });
    }
    if (status.status !== "available" && status.manifestReference) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manifestReference"],
        message: "Unpublished checkpoints cannot expose a manifest reference",
      });
    }
  });

const workspaceRelocationTargetSchema = factoryTargetSchema.strict();
const workspaceRelocationErrorCodeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const workspaceRelocationBindingShape = {
  contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
  relocationId: identifier,
  requestId: identifier,
  checkpointRequestId: identifier,
  captureRequestId: identifier,
  captureId: executionCaptureIdSchema,
  workspaceSnapshotRequestId: identifier,
  snapshotId: identifier,
  threadId: identifier,
  source: workspaceRelocationTargetSchema,
  destination: workspaceRelocationTargetSchema,
  ownershipGeneration: z.number().int().nonnegative().safe(),
  destinationOwnershipGeneration: z
    .number()
    .int()
    .nonnegative()
    .safe()
    .optional(),
  manifestReference: z.string().regex(/^[a-f0-9]{64}$/),
};

export const workspaceRelocationRequestSchema = z
  .object({
    ...versioned,
    requestId: identifier,
    checkpointRequestId: identifier,
    destination: workspaceRelocationTargetSchema,
  })
  .strict();
export const workspaceRelocationStatusSchema = z
  .object({
    ...workspaceRelocationBindingShape,
    contractVersion: z.literal(CONTRACT_VERSION),
    status: z.enum([
      "queued",
      "claimed",
      "prepared-inactive",
      "blocked",
      "uncertain",
    ]),
    acceptedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    receiptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    previousReceiptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    errorCode: workspaceRelocationErrorCodeSchema.optional(),
    activation: z
      .lazy(() => workspaceRelocationActivationStatusSchema)
      .optional(),
    historical: z.literal(true).optional(),
  })
  .strict()
  .superRefine((status, context) => {
    const terminal = ["prepared-inactive", "blocked", "uncertain"].includes(
      status.status,
    );
    if (terminal !== Boolean(status.receiptSha256)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receiptSha256"],
        message: "Terminal relocation status requires its local receipt digest",
      });
    }
    if (
      status.previousReceiptSha256 !== undefined &&
      status.status !== "uncertain"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousReceiptSha256"],
        message: "Only an uncertain relocation may retain a prior receipt",
      });
    }
    if (
      status.status === "prepared-inactive" &&
      status.errorCode !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Prepared relocation cannot include an error",
      });
    }
    if (
      (status.status === "blocked" || status.status === "uncertain") !==
      Boolean(status.errorCode)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Blocked or uncertain relocation requires an error code",
      });
    }
  });
export const workspaceRelocationActivationIntentRequestSchema = z
  .object({ ...versioned })
  .strict();
export const workspaceRelocationActivationStatusSchema = z
  .object({
    status: z.enum([
      "intent",
      "preflight-claimed",
      "ownership-committed",
      "activated",
      "uncertain",
    ]),
    destinationOwnershipGeneration: z.number().int().nonnegative().safe(),
    ownershipGeneration: z.number().int().nonnegative().safe().optional(),
    preparedReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    readinessReceiptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    activationReceiptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    uncertaintyReceiptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    intentAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((activation, context) => {
    const hasGeneration = activation.ownershipGeneration !== undefined;
    const hasReadiness = activation.readinessReceiptSha256 !== undefined;
    const hasActivationReceipt =
      activation.activationReceiptSha256 !== undefined;
    const hasUncertaintyReceipt =
      activation.uncertaintyReceiptSha256 !== undefined;
    const initial = ["intent", "preflight-claimed"].includes(activation.status);
    const committed = ["ownership-committed", "activated"].includes(
      activation.status,
    );
    const valid = initial
      ? !hasGeneration &&
        !hasReadiness &&
        !hasActivationReceipt &&
        !hasUncertaintyReceipt
      : committed
        ? hasGeneration &&
          hasReadiness &&
          (activation.status === "activated") === hasActivationReceipt &&
          !hasUncertaintyReceipt
        : activation.status === "uncertain"
          ? hasGeneration === hasReadiness &&
            !hasActivationReceipt &&
            hasUncertaintyReceipt === hasGeneration
          : false;
    if (!valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readinessReceiptSha256"],
        message: "Activation evidence must match its persisted phase",
      });
    }
  });
const workspaceRelocationActivationBindingShape = {
  contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
  relocationId: identifier,
  requestId: identifier,
  checkpointRequestId: identifier,
  captureRequestId: identifier,
  captureId: executionCaptureIdSchema,
  workspaceSnapshotRequestId: identifier,
  snapshotId: identifier,
  threadId: identifier,
  source: workspaceRelocationTargetSchema,
  destination: workspaceRelocationTargetSchema,
  sourceOwnershipGeneration: z.number().int().nonnegative().safe(),
  destinationOwnershipGeneration: z.number().int().nonnegative().safe(),
  manifestReference: z.string().regex(/^[a-f0-9]{64}$/),
  sourceProofSha256: z.string().regex(/^[a-f0-9]{64}$/),
  preparedReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
export const workspaceRelocationActivationPreflightSchema = z
  .object(workspaceRelocationActivationBindingShape)
  .strict();
export const workspaceRelocationActivationCommandSchema = z
  .object({
    ...workspaceRelocationActivationBindingShape,
    ownershipGeneration: z.number().int().nonnegative().safe(),
    readinessReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    committedAt: z.string().datetime(),
  })
  .strict();
export const workspaceRelocationActivationClaimSchema = z.discriminatedUnion(
  "phase",
  [
    z
      .object({
        phase: z.literal("preflight"),
        assignment: workspaceRelocationActivationPreflightSchema,
      })
      .strict(),
    z
      .object({
        phase: z.literal("activate"),
        command: workspaceRelocationActivationCommandSchema,
      })
      .strict(),
  ],
);
export const workspaceRelocationActivationClaimRequestSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    nodeId: identifier,
  })
  .strict();
export const workspaceRelocationActivationClaimResponseSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    activation: workspaceRelocationActivationClaimSchema.nullable(),
  })
  .strict();
export const workspaceRelocationActivationReadinessSchema = z
  .object({
    ...workspaceRelocationActivationBindingShape,
    readinessReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reportedAt: z.string().datetime(),
  })
  .strict();
export const workspaceRelocationActivationReadinessResponseSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    nodeId: identifier,
    relocationId: identifier,
    accepted: z.literal(true),
    command: workspaceRelocationActivationCommandSchema,
  })
  .strict();
export const workspaceRelocationActivationReportSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("activated"),
        command: workspaceRelocationActivationCommandSchema,
        activationReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
        reportedAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({
        status: z.literal("uncertain"),
        command: workspaceRelocationActivationCommandSchema,
        uncertaintyReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
        errorCode: workspaceRelocationErrorCodeSchema,
        reportedAt: z.string().datetime(),
      })
      .strict(),
  ],
);
export const workspaceRelocationActivationReportResponseSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    nodeId: identifier,
    relocationId: identifier,
    accepted: z.literal(true),
    status: z.enum(["activated", "uncertain"]),
  })
  .strict();
export const workspaceRelocationClaimRequestSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    nodeId: identifier,
  })
  .strict();
export const workspaceRelocationClaimSchema = z
  .object(workspaceRelocationBindingShape)
  .strict();
export const workspaceRelocationClaimResponseSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    relocation: workspaceRelocationClaimSchema.nullable(),
  })
  .strict();
export const workspaceRelocationReportSchema = z
  .object({
    ...workspaceRelocationBindingShape,
    status: z.enum(["prepared-inactive", "blocked", "uncertain"]),
    receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reportedAt: z.string().datetime(),
    previousReceiptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    errorCode: workspaceRelocationErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.previousReceiptSha256 !== undefined &&
      report.status !== "uncertain"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousReceiptSha256"],
        message: "Only an uncertain relocation may retain a prior receipt",
      });
    }
    if (
      (report.status === "prepared-inactive") !==
      (report.errorCode === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message:
          "Only blocked or uncertain relocation reports require an error code",
      });
    }
  });
export const workspaceRelocationReportResponseSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    nodeId: identifier,
    relocationId: identifier,
    accepted: z.literal(true),
    status: z.enum(["prepared-inactive", "blocked", "uncertain"]),
  })
  .strict();

export const workspaceSnapshotClaimRequestSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    nodeId: identifier,
  })
  .strict();
export const workspaceSnapshotClaimResponseSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    snapshot: z.lazy(() => workspaceSnapshotClaimSchema).nullable(),
  })
  .strict();
export const workspaceSnapshotClaimSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    snapshotId: identifier,
    requestId: identifier,
    captureRequestId: identifier,
    captureId: executionCaptureIdSchema,
    nodeId: identifier,
    target: factoryTargetSchema,
    ownershipGeneration: z.number().int().nonnegative().safe(),
  })
  .strict();
export const workspaceSnapshotReportResponseSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    nodeId: identifier,
    snapshotId: identifier,
    captureId: executionCaptureIdSchema,
    accepted: z.literal(true),
    status: z.enum(["workspace-checkpoint-available", "blocked", "uncertain"]),
  })
  .strict();
export const workspaceSnapshotReportSchema = z
  .object({
    contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    snapshotId: identifier,
    requestId: identifier,
    captureRequestId: identifier,
    captureId: executionCaptureIdSchema,
    nodeId: identifier,
    target: factoryTargetSchema,
    ownershipGeneration: z.number().int().nonnegative().safe(),
    status: z.enum(["workspace-checkpoint-available", "blocked", "uncertain"]),
    reportedAt: z.string().datetime(),
    manifestReference: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.status === "workspace-checkpoint-available" &&
      !report.manifestReference
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manifestReference"],
        message: "Available workspace checkpoint requires a manifest reference",
      });
    }
    if (
      report.status !== "workspace-checkpoint-available" &&
      !report.errorCode
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Blocked snapshot report requires an error code",
      });
    }
    if (
      report.status === "workspace-checkpoint-available" &&
      report.errorCode
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Available checkpoint cannot include an error",
      });
    }
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
  executionEffects: z.array(executionReceiptSchema).optional(),
});
/** Only known normalized executor/controller codes may appear in portable provenance. */
export const FACTORY_PROVENANCE_EXECUTION_ERROR_CODES = [
  "workspace_path_access_denied",
  "workspace_path_is_directory",
  "workspace_symlink_rejected",
  "workspace_path_too_long",
  "workspace_path_not_found",
  "workspace_path_not_directory",
  "workspace_path_not_file",
  "file_size_limit_exceeded",
  "unsafe_workspace_path",
  "invalid_file_content",
  "command_start_failed",
  "command_failed",
  "stale_ownership_generation",
  "access_revoked",
  "managed_effect_abandoned_before_claim",
  "managed_input_interrupted_before_claim",
] as const;
export const factoryProvenanceExecutionErrorCodeSchema = z.enum(
  FACTORY_PROVENANCE_EXECUTION_ERROR_CODES,
);
export const factoryProvenanceExecutionEffectSchema = z
  .object({
    ...versioned,
    jobId: identifier,
    nodeId: identifier,
    target: factoryTargetSchema,
    ownershipGeneration: z.number().int().nonnegative().safe(),
    operation: z.enum(["read-file", "write-file", "argv-command"]),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["completed", "failed"]),
    acceptedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    errorCode: factoryProvenanceExecutionErrorCodeSchema.nullable(),
  })
  .strict();
export const factoryProvenanceCommandSchema = z
  .object({
    ...versioned,
    requestId: identifier,
    jobId: identifier,
    threadId: identifier,
    target: factoryTargetSchema,
    ownershipGeneration: z.number().int().nonnegative().safe(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    dispatchStatus: z.enum(["completed", "failed"]),
    acceptedAt: z.string().datetime(),
    settledAt: z.string().datetime(),
    executionEffects: z
      .array(factoryProvenanceExecutionEffectSchema)
      .max(100_000),
  })
  .strict();
export const factoryProvenanceEvidenceSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    format: z.literal("uzina-factory-managed-work-provenance"),
    version: z.literal(1),
    checkpointRequestId: identifier,
    threadId: identifier,
    projectId: identifier,
    capture: z
      .object({
        requestId: identifier,
        captureId: executionCaptureIdSchema,
        controlId: executionCaptureControlIdSchema,
        target: factoryTargetSchema,
        ownershipGeneration: z.number().int().nonnegative().safe(),
        reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sourceFence: executionCaptureFenceReceiptSchema,
      })
      .strict(),
    workspaceSnapshot: z
      .object({
        requestId: identifier,
        snapshotId: identifier,
        captureId: executionCaptureIdSchema,
        status: z.literal("workspace-checkpoint-available"),
        manifestReference: z.string().regex(/^[a-f0-9]{64}$/),
        reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    commands: z.array(factoryProvenanceCommandSchema).max(100_000),
  })
  .strict();
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
export type WorkspaceSnapshotRequest = z.infer<
  typeof workspaceSnapshotRequestSchema
>;
export type WorkspaceSnapshotStatus = z.infer<
  typeof workspaceSnapshotStatusSchema
>;
export type WorkspaceRelocationRequest = z.infer<
  typeof workspaceRelocationRequestSchema
>;
export type WorkspaceRelocationStatus = z.infer<
  typeof workspaceRelocationStatusSchema
>;
export type WorkspaceRelocationClaim = z.infer<
  typeof workspaceRelocationClaimSchema
>;
export type WorkspaceRelocationReport = z.infer<
  typeof workspaceRelocationReportSchema
>;
export type WorkspaceRelocationActivationIntentRequest = z.infer<
  typeof workspaceRelocationActivationIntentRequestSchema
>;
export type WorkspaceRelocationActivationStatus = z.infer<
  typeof workspaceRelocationActivationStatusSchema
>;
export type WorkspaceRelocationActivationPreflight = z.infer<
  typeof workspaceRelocationActivationPreflightSchema
>;
export type WorkspaceRelocationActivationCommand = z.infer<
  typeof workspaceRelocationActivationCommandSchema
>;
export type WorkspaceRelocationActivationClaim = z.infer<
  typeof workspaceRelocationActivationClaimSchema
>;
export type WorkspaceRelocationActivationReadiness = z.infer<
  typeof workspaceRelocationActivationReadinessSchema
>;
export type WorkspaceRelocationActivationReport = z.infer<
  typeof workspaceRelocationActivationReportSchema
>;
export type ManagedWorkCheckpointRequest = z.infer<
  typeof managedWorkCheckpointRequestSchema
>;
export type ManagedWorkCheckpointStage = z.infer<
  typeof managedWorkCheckpointStageSchema
>;
export type ManagedWorkCheckpointStatus = z.infer<
  typeof managedWorkCheckpointStatusSchema
>;
export type ManagedWorkImportRequest = z.infer<
  typeof managedWorkImportRequestSchema
>;
export type ManagedWorkImportHostBinding = z.infer<
  typeof managedWorkImportHostBindingSchema
>;
export type ManagedWorkImportPreparationReceipt = z.infer<
  typeof managedWorkImportPreparationReceiptSchema
>;
export type ManagedWorkImportStatus = z.infer<
  typeof managedWorkImportStatusSchema
>;
export type ManagedWorkImportOutcome = z.infer<
  typeof managedWorkImportOutcomeSchema
>;
export type WorkspaceSnapshotClaim = z.infer<
  typeof workspaceSnapshotClaimSchema
>;
export type WorkspaceSnapshotReport = z.infer<
  typeof workspaceSnapshotReportSchema
>;
export type DiscussionEntry = z.infer<typeof discussionEntrySchema>;
export type FactoryDispatchStatus = z.infer<typeof factoryDispatchStatusSchema>;
export type FactoryCommandReceipt = z.infer<typeof factoryCommandReceiptSchema>;
export type FactoryProvenanceCommand = z.infer<
  typeof factoryProvenanceCommandSchema
>;
export type FactoryProvenanceExecutionEffect = z.infer<
  typeof factoryProvenanceExecutionEffectSchema
>;
export type FactoryProvenanceEvidence = z.infer<
  typeof factoryProvenanceEvidenceSchema
>;
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
