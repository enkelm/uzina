import { describe, expect, test } from "bun:test";
import {
  managedWorkImportHostBindingSchema,
  managedWorkImportRequestSchema,
  managedWorkImportStatusSchema,
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
