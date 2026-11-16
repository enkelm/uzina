import { describe, expect, test } from "bun:test";
import {
  managedWorkImportHostBindingSchema,
  managedWorkImportRequestSchema,
  managedWorkImportStatusSchema,
  managedWorkTransferHoldRequestSchema,
  managedWorkTransferHoldStatusSchema,
} from "./factory";

const digest = "a".repeat(64);
const request = {
  contractVersion: 1,
  requestId: "import:one",
  sourceCatalogId: "catalog:offline",
  manifestSha256: digest,
  destinationId: "destination:private",
} as const;
const hostBinding = {
  hostDescriptor: "bun-standalone:/var/lib/uzina/factory.sqlite",
  sourceCatalog: {
    sourceCatalogId: request.sourceCatalogId,
    canonicalRoot: "/var/lib/uzina/import-catalog",
  },
  destination: {
    destinationId: request.destinationId,
    canonicalRoot: "/var/lib/uzina/prepared/destination",
  },
};

describe("managed-work transfer hold v1 contract", () => {
  const request = {
    contractVersion: 1,
    requestId: "transfer:source-one",
    captureRequestId: "capture:source-one",
    checkpointRequestId: "checkpoint:source-one",
  } as const;

  test("accepts only a stable request ID and exact existing source evidence IDs", () => {
    expect(managedWorkTransferHoldRequestSchema.parse(request)).toEqual(
      request,
    );
    for (const forbidden of [
      { actor: { kind: "human", userId: "user:owner" } },
      { path: "/tmp/source" },
      { ownershipGeneration: 2 },
      { sourceBearer: "not-a-request-field" },
      { destination: { nodeId: "node:local", workspaceId: "workspace:local" } },
      { activation: true },
    ]) {
      expect(() =>
        managedWorkTransferHoldRequestSchema.parse({
          ...request,
          ...forbidden,
        }),
      ).toThrow();
    }
    expect(() =>
      managedWorkTransferHoldRequestSchema.parse(undefined),
    ).toThrow();
    expect(() =>
      managedWorkTransferHoldRequestSchema.parse({
        ...request,
        extra: "field",
      }),
    ).toThrow();
    expect(() =>
      managedWorkTransferHoldRequestSchema.parse({
        ...request,
        contractVersion: 2,
      }),
    ).toThrow();
  });

  test("status is only source-bound held evidence, without destination or activation fields", () => {
    // Contract-shape validation only; this does not create Core source evidence.
    const status = managedWorkTransferHoldStatusSchema.parse({
      contractVersion: 1,
      requestId: request.requestId,
      ownerId: "user:owner",
      actor: { contractVersion: 1, kind: "human", userId: "user:owner" },
      captureRequestId: request.captureRequestId,
      checkpointRequestId: request.checkpointRequestId,
      workspaceSnapshotRequestId: "snapshot:source-one",
      captureId: "capture:source-one",
      snapshotId: "snapshot-id:source-one",
      projectId: "project:source-one",
      threadId: "thread:source-one",
      source: { nodeId: "node:source", workspaceId: "workspace:source" },
      ownershipGeneration: 0,
      controlId: "capture-control:source-one",
      controlPayloadSha256: digest,
      sourceCaptureReportSha256: digest,
      sourceFence: {
        controlId: "capture-control:source-one",
        captureId: "capture:source-one",
        requestId: request.captureRequestId,
        nodeId: "node:source",
        target: { nodeId: "node:source", workspaceId: "workspace:source" },
        ownershipGeneration: 0,
        fencedAt: "2026-01-01T00:00:00.000Z",
        receiptSha256: digest,
      },
      workspaceSnapshotReportSha256: digest,
      workspaceManifestReference: "b".repeat(64),
      coherentCheckpointManifestReference: "c".repeat(64),
      status: "held-awaiting-local-preparation",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      bindingSha256: "d".repeat(64),
    });
    expect(status.status).toBe("held-awaiting-local-preparation");
    expect(() =>
      managedWorkTransferHoldStatusSchema.parse({
        ...status,
        localDestinationId: "destination:local",
      }),
    ).toThrow();
  });
});

describe("managed-work import v1 contracts", () => {
  test("request names configured resources and a manifest digest, not authority or paths", () => {
    expect(managedWorkImportRequestSchema.parse(request)).toEqual(request);
    for (const forbidden of [
      { actor: { kind: "human", userId: "user:caller" } },
      { path: "/tmp/untrusted" },
      { generation: 7 },
      { sourceBearer: "not-an-import-input" },
      { activation: true },
    ]) {
      expect(() =>
        managedWorkImportRequestSchema.parse({ ...request, ...forbidden }),
      ).toThrow();
    }
    expect(() =>
      managedWorkImportRequestSchema.parse({
        ...request,
        manifestSha256: "not-a-digest",
      }),
    ).toThrow();
  });

  test("status binds admitted owner evidence to trusted configured descriptors", () => {
    expect(
      managedWorkImportStatusSchema.parse({
        contractVersion: 1,
        requestId: request.requestId,
        ownerId: "user:owner",
        actor: { contractVersion: 1, kind: "human", userId: "user:owner" },
        sourceCatalogId: request.sourceCatalogId,
        manifestSha256: digest,
        destinationId: request.destinationId,
        hostBinding: managedWorkImportHostBindingSchema.parse(hostBinding),
        status: "admitted",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "admitted", manifestSha256: digest });
    expect(() =>
      managedWorkImportStatusSchema.parse({
        contractVersion: 1,
        requestId: request.requestId,
        ownerId: "user:owner",
        actor: { contractVersion: 1, kind: "human", userId: "user:owner" },
        sourceCatalogId: request.sourceCatalogId,
        manifestSha256: digest,
        destinationId: request.destinationId,
        hostBinding: {
          ...hostBinding,
          destination: {
            ...hostBinding.destination,
            destinationId: "destination:other",
          },
        },
        status: "admitted",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
