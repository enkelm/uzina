import { describe, expect, test } from "bun:test";
import {
  actorIdentitySchema,
  capabilitySetSchema,
  commandAcceptanceSchema,
  executionOutcomeSchema,
} from "./index";

describe("shared contracts", () => {
  test("validates versioned human, assistant, and node identities", () => {
    const identities = [
      { contractVersion: 1, kind: "human", userId: "user:owner" },
      {
        contractVersion: 1,
        kind: "assistant",
        assistantId: "assistant:factory",
        ownerId: "user:owner",
      },
      { contractVersion: 1, kind: "node", nodeId: "node:laptop-a" },
    ];

    for (const identity of identities) {
      expect(actorIdentitySchema.safeParse(identity).success).toBe(true);
    }
    expect(
      actorIdentitySchema.safeParse({
        contractVersion: 2,
        kind: "human",
        userId: "user:owner",
      }).success,
    ).toBe(false);
    expect(
      actorIdentitySchema.safeParse({
        contractVersion: 1,
        kind: "assistant",
        assistantId: "assistant:factory",
      }).success,
    ).toBe(false);
  });

  test("requires stable IDs, explicit placement, generation, and acceptance time", () => {
    const acceptance = {
      contractVersion: 1,
      status: "accepted",
      commandId: "cmd:0001",
      jobId: "job:0001",
      target: { nodeId: "node:laptop-a", workspaceId: "workspace:repo" },
      ownershipGeneration: 0,
      acceptedAt: "2026-05-01T12:00:00.000Z",
    };

    expect(commandAcceptanceSchema.safeParse(acceptance).success).toBe(true);
    expect(
      commandAcceptanceSchema.safeParse({
        ...acceptance,
        target: { nodeId: "node:laptop-a" },
      }).success,
    ).toBe(false);
    expect(
      commandAcceptanceSchema.safeParse({ ...acceptance, commandId: "bad id" })
        .success,
    ).toBe(false);
  });

  test("keeps acceptance separate from completed, failed, and uncertain outcomes", () => {
    const base = {
      contractVersion: 1,
      commandId: "cmd:0001",
      jobId: "job:0001",
      target: { nodeId: "node:laptop-a", workspaceId: "workspace:repo" },
      ownershipGeneration: 3,
      observedAt: "2026-05-01T12:01:00.000Z",
    };

    for (const status of ["completed", "failed", "uncertain"] as const) {
      expect(
        executionOutcomeSchema.safeParse({ ...base, status }).success,
      ).toBe(true);
    }
    expect(
      executionOutcomeSchema.safeParse({ ...base, status: "accepted" }).success,
    ).toBe(false);
  });

  test("describes supported and unsupported runtime capabilities", () => {
    expect(
      capabilitySetSchema.safeParse({
        contractVersion: 1,
        capabilities: [
          { operation: "reattach", supported: true },
          { operation: "managed-checkpoint-recovery", supported: false },
        ],
      }).success,
    ).toBe(true);
    expect(
      capabilitySetSchema.safeParse({
        contractVersion: 1,
        capabilities: [{ operation: "guess", supported: true }],
      }).success,
    ).toBe(false);
  });
});
