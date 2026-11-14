import { describe, expect, test } from "bun:test";
import {
  executionCaptureControlReportSchema,
  executionCaptureControlSchema,
} from "./execution";

describe("execution capture-control contracts", () => {
  const control = {
    contractVersion: 1,
    controlId: "capture-control:one",
    captureId: "capture:one",
    requestId: "request:one",
    nodeId: "node:source",
    target: { nodeId: "node:source", workspaceId: "workspace:selected" },
    ownershipGeneration: 0,
    payloadSha256: "a".repeat(64),
  };

  test("uses strict version-1 identity and selected-workspace assignment fields", () => {
    expect(executionCaptureControlSchema.safeParse(control).success).toBe(true);
    expect(
      executionCaptureControlSchema.safeParse({
        ...control,
        operation: "argv-command",
      }).success,
    ).toBe(false);
    expect(
      executionCaptureControlSchema.safeParse({
        ...control,
        contractVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      executionCaptureControlSchema.safeParse({
        ...control,
        target: { ...control.target, workspaceId: "bad workspace" },
      }).success,
    ).toBe(false);
  });

  test("source-fenced requires a correlated durable receipt while blocked forbids one", () => {
    const proofBinding = {
      controlId: control.controlId,
      captureId: control.captureId,
      requestId: control.requestId,
      nodeId: control.nodeId,
      target: control.target,
      ownershipGeneration: control.ownershipGeneration,
      fencedAt: "2026-05-01T12:00:00.000Z",
    };
    const report = {
      ...control,
      status: "source-capture-fenced",
      reportedAt: "2026-05-01T12:00:00.000Z",
      sourceFence: { ...proofBinding, receiptSha256: "b".repeat(64) },
    };
    expect(executionCaptureControlReportSchema.safeParse(report).success).toBe(
      true,
    );
    expect(
      executionCaptureControlReportSchema.safeParse({
        ...report,
        sourceFence: undefined,
      }).success,
    ).toBe(false);
    expect(
      executionCaptureControlReportSchema.safeParse({
        ...report,
        status: "blocked",
        sourceFence: undefined,
        errorCode: "workspace_has_unsettled_effects",
      }).success,
    ).toBe(true);
    expect(
      executionCaptureControlReportSchema.safeParse({
        ...report,
        status: "blocked",
        errorCode: "workspace_has_unsettled_effects",
      }).success,
    ).toBe(false);
  });
});
