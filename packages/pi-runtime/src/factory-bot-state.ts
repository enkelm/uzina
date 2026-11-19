import type { JsonValue } from "@earendil-works/chord/json";
import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";

export const FACTORY_BOT_LIMITS = {
  goals: 1_000,
  threads: 1_000,
  attention: 12,
  active: 8,
  page: 20,
  pollMs: 30_000,
  deadlineMs: 86_400_000,
} as const;
export type GoalBrief = {
  objective: string;
  inputs: string[];
  deliverables: string[];
  acceptance: string[];
  constraints: string[];
};
export type GoalTarget =
  | { kind: "work"; threadId: string }
  | { kind: "native"; workerId: string };
export type GoalState =
  | "idea"
  | "queued"
  | "waiting"
  | "review"
  | "complete"
  | "paused"
  | "cancelled"
  | "uncertain"
  | "blocked";
export type Goal = {
  cardId: string;
  projectId: string;
  title: string;
  brief: GoalBrief;
  priority: "normal" | "high";
  pinned: boolean;
  revision: number;
  state: GoalState;
  nextStep: string;
  control: "run" | "pause" | "cancel";
  dependencies: string[];
  attempts: TaskId[];
  attempt: null | {
    taskId: TaskId;
    requestId: string;
    resultItemId: string;
    target: GoalTarget;
    stage: "prepared" | "admitting" | "admitted";
    deadline: number;
  };
  evidence: string[];
  review: { criterion: string; evidence: string; note: string }[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};
export type BotThread = {
  threadId: string;
  cardId: string;
  projectId: string;
  title: string;
  purpose: "planning" | "review";
  brief: GoalBrief;
  conversationId: ConversationId | null;
  taskId: TaskId | null;
  submissionId: SubmissionId | null;
  state: "queued" | "running" | "answered" | "failed" | "closed";
  summary: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type BotIndex = {
  goals: string[];
  threads: string[];
  attention: string[];
  activeGoals: string[];
  activeThreads: string[];
};
const semantics = {
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => true,
} as const;
export const FactoryAgenda = defineDoc<BotIndex>({
  ...semantics,
  kind: "uzina.factory-agenda",
  initial: () => ({
    goals: [],
    threads: [],
    attention: [],
    activeGoals: [],
    activeThreads: [],
  }),
});
export const FactoryGoal = defineDocFamily<Goal, Goal>({
  ...semantics,
  family: true,
  kind: "uzina.factory-goal",
  initial: (goal) => goal,
});
export const FactoryThread = defineDocFamily<BotThread, BotThread>({
  ...semantics,
  family: true,
  kind: "uzina.factory-thread",
  initial: (thread) => thread,
});
export const FactoryCommand = defineDocFamily<
  { hash: string; result: JsonValue | null },
  string
>({
  ...semantics,
  family: true,
  kind: "uzina.factory-command",
  initial: (hash) => ({ hash, result: null }),
});
export const emptyIndex = (): BotIndex => ({
  goals: [],
  threads: [],
  attention: [],
  activeGoals: [],
  activeThreads: [],
});
export function remove(values: string[], value: string) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}
export function fail(code: string): never {
  throw new Error(`Factory bot: ${code}`);
}
export function requireRevision(goal: Readonly<Goal>, expected: number) {
  if (goal.revision !== expected)
    fail(
      "revision_conflict: inspect the card before retrying with a new command",
    );
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function sanitize<T>(value: T, secret: string): T {
  if (typeof value === "string")
    return (secret ? value.split(secret).join("[redacted]") : value) as T;
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, secret)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitize(key, secret),
        sanitize(item, secret),
      ]),
    ) as T;
  return value;
}
export function reportNeedsDecision(report: {
  blocking: boolean;
  status: string;
}) {
  return (
    report.status === "needs_user" ||
    (report.blocking && !["answered", "acknowledged"].includes(report.status))
  );
}
export function goalSummary(goal: Readonly<Goal>) {
  return {
    cardId: goal.cardId,
    projectId: goal.projectId,
    title: goal.title,
    state: goal.state,
    control: goal.control,
    revision: goal.revision,
    pinned: goal.pinned,
    priority: goal.priority,
    nextStep: goal.nextStep.slice(0, 300),
    attempt: goal.attempt,
    evidence: goal.evidence.slice(-3),
    archived: goal.archived,
    availableActions: goal.archived
      ? ["inspect"]
      : [
          "inspect",
          "refine",
          ...(["idea", "review"].includes(goal.state) && goal.control === "run"
            ? ["dispatch"]
            : []),
          "control",
          ...(["blocked", "uncertain"].includes(goal.state)
            ? ["reconcile"]
            : []),
          ...(goal.state === "review" ? ["accept"] : []),
          "open_thread",
        ],
  };
}
