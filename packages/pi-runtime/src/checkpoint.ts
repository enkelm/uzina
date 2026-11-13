import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type DocumentCreate,
  type DocumentId,
  type DocumentRecord,
  type EntryId,
  type EntryRecord,
  type Page,
  type Storage,
  type StorageWrite,
  type SubmissionId,
  type SubmissionRecord,
  type TaskId,
  type TaskRecord,
} from "@earendil-works/pi-durable";

const CHECKPOINT_FORMAT = "uzina.pi-managed-work";
const CHECKPOINT_VERSION = 1;
const PAGE_SIZE = 500;

export type CheckpointDocument = {
  record: DocumentRecord;
  version: number;
  value: Record<string, JsonValue>;
};

export type ManagedWorkCheckpoint = {
  format: typeof CHECKPOINT_FORMAT;
  version: typeof CHECKPOINT_VERSION;
  profile: "quiescent-current-documents-no-forks-v1";
  rootConversationId: ConversationId;
  capturedAt: number;
  conversations: ConversationRecord[];
  entries: EntryRecord[];
  tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[];
  submissions: SubmissionRecord[];
  documents: CheckpointDocument[];
  limitations: string[];
  sha256: string;
};

type CheckpointBody = Omit<ManagedWorkCheckpoint, "sha256">;

export class UnsupportedCheckpointState extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCheckpointState";
  }
}

async function scanPages<T>(
  scan: (limit: number, cursor?: Cursor) => Promise<Page<T, Cursor>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(PAGE_SIZE, cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error("Checkpoint contains a non-JSON value");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

async function checksum(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function scanAllConversations(storage: Storage, context: Context) {
  return scanPages((limit, cursor) =>
    storage.scanConversations({ order: "ascending" }, limit, cursor, context),
  );
}

async function scanAllTasks(storage: Storage, context: Context) {
  return scanPages((limit, cursor) =>
    storage.scanTasks({}, limit, cursor, context),
  );
}

async function scanAllSubmissions(storage: Storage, context: Context) {
  return scanPages((limit, cursor) =>
    storage.scanSubmissions({}, limit, cursor, context),
  );
}

function assertNoForks(conversations: readonly ConversationRecord[]): void {
  if (conversations.some((conversation) => conversation.parent !== undefined)) {
    throw new UnsupportedCheckpointState(
      "History forks are not supported by checkpoint profile v1",
    );
  }
}

function assertSettledTask(
  task: TaskRecord<JsonValue, JsonValue, JsonValue>,
): void {
  if (task.state.status !== "terminal") {
    throw new UnsupportedCheckpointState(
      `Task ${task.id} is ${task.state.status}; active or uncertain task checkpoints cannot be imported safely`,
    );
  }
}

function assertSettledSubmission(submission: SubmissionRecord): void {
  if (submission.status === "queued" || submission.status === "placed") {
    throw new UnsupportedCheckpointState(
      `Submission ${submission.id} is ${submission.status}; checkpoint capture requires settled submissions`,
    );
  }
}

/**
 * Capture public Pi Durable records for one quiescent root and its owned descendants.
 * Document values are current snapshots only; historical revisions and forks are not exported.
 */
export async function exportManagedWorkCheckpoint(
  storage: Storage,
  rootConversationId: ConversationId,
  context: Context = BACKGROUND_CONTEXT,
): Promise<ManagedWorkCheckpoint> {
  const [allConversations, allTasks, allSubmissions, sessionDocuments] =
    await Promise.all([
      scanAllConversations(storage, context),
      scanAllTasks(storage, context),
      scanAllSubmissions(storage, context),
      scanPages((limit, cursor) =>
        storage.scanDocuments(
          { scope: { kind: "session" }, at: "current" },
          limit,
          cursor,
          context,
        ),
      ),
    ]);
  if (sessionDocuments.length > 0) {
    throw new UnsupportedCheckpointState(
      "Session-scoped documents cannot be assigned to one work-item checkpoint",
    );
  }
  const root = allConversations.find((item) => item.id === rootConversationId);
  if (!root)
    throw new Error(`Conversation ${rootConversationId} was not found`);
  if (root.parent || root.owner) {
    throw new UnsupportedCheckpointState(
      "Checkpoint root must be an ownerless, non-fork conversation",
    );
  }
  if (root.id !== ROOT_CONVERSATION_ID) {
    throw new UnsupportedCheckpointState(
      "Checkpoint root must use the reserved root conversation ID",
    );
  }

  const conversations = new Map<number, ConversationRecord>([[root.id, root]]);
  const tasks = new Map<number, TaskRecord<JsonValue, JsonValue, JsonValue>>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of allTasks) {
      if (conversations.has(task.conversationId) && !tasks.has(task.id)) {
        assertSettledTask(task);
        tasks.set(task.id, task);
        changed = true;
      }
    }
    for (const conversation of allConversations) {
      if (
        !conversations.has(conversation.id) &&
        conversation.owner &&
        conversations.has(conversation.owner.conversationId) &&
        tasks.has(conversation.owner.taskId)
      ) {
        if (conversation.parent) {
          throw new UnsupportedCheckpointState(
            "Owned fork conversations are not supported by checkpoint profile v1",
          );
        }
        conversations.set(conversation.id, conversation);
        changed = true;
      }
    }
  }

  const conversationRecords = [...conversations.values()].sort(
    (left, right) => left.id - right.id,
  );
  assertNoForks(conversationRecords);

  const taskRecords = [...tasks.values()].sort(
    (left, right) => left.id - right.id,
  );
  for (const task of taskRecords) {
    if (task.owner && !tasks.has(task.owner)) {
      throw new UnsupportedCheckpointState(
        `Task ${task.id} is owned by task ${task.owner} outside the checkpoint`,
      );
    }
  }

  const conversationIds = new Set(conversationRecords.map((item) => item.id));
  const taskIds = new Set(taskRecords.map((item) => Number(item.id)));
  const entries: EntryRecord[] = [];
  const documents: CheckpointDocument[] = [];
  for (const conversation of conversationRecords) {
    entries.push(
      ...(await scanPages((limit, cursor) =>
        storage.scanEntries(
          { conversationId: conversation.id, order: "ascending" },
          limit,
          cursor,
          context,
        ),
      )),
    );
    for (const record of await scanPages((limit, cursor) =>
      storage.scanDocuments(
        {
          scope: { kind: "conversation", conversationId: conversation.id },
          at: "current",
        },
        limit,
        cursor,
        context,
      ),
    )) {
      const stored = await storage.document(record.id, "current", context);
      if (!stored)
        throw new Error(`Document ${record.id} disappeared during capture`);
      documents.push({
        record: stored.record,
        version: stored.version,
        value: stored.value,
      });
    }
  }
  for (const task of taskRecords) {
    for (const record of await scanPages((limit, cursor) =>
      storage.scanDocuments(
        { scope: { kind: "task", taskId: task.id }, at: "current" },
        limit,
        cursor,
        context,
      ),
    )) {
      const stored = await storage.document(record.id, "current", context);
      if (!stored)
        throw new Error(`Document ${record.id} disappeared during capture`);
      documents.push({
        record: stored.record,
        version: stored.version,
        value: stored.value,
      });
    }
  }
  const selectedSubmissions = allSubmissions.filter((item) =>
    conversationIds.has(item.conversationId),
  );
  selectedSubmissions.forEach(assertSettledSubmission);

  if (
    entries.some(
      (entry) => entry.byTaskId && !taskIds.has(Number(entry.byTaskId)),
    )
  ) {
    throw new UnsupportedCheckpointState(
      "A transcript entry refers to a task outside the owned work item",
    );
  }
  documents.sort((left, right) => left.record.id - right.record.id);
  const body: CheckpointBody = {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    profile: "quiescent-current-documents-no-forks-v1",
    rootConversationId,
    capturedAt: Date.now(),
    conversations: conversationRecords,
    entries: entries.sort((left, right) => left.id - right.id),
    tasks: taskRecords,
    submissions: selectedSubmissions.sort((left, right) => left.id - right.id),
    documents,
    limitations: [
      "Only terminal task records and settled submissions are supported; active, sleeping, parked, or uncertain work is rejected.",
      "Conversation forks and parent-history dependencies are rejected.",
      "Document export uses the current materialized value only; historical document revisions are not represented.",
      "Import preserves transcript entries, canonical model messages, request IDs, receipts, and terminal task outcomes; it does not transfer workspace files, credentials, runtime ownership, or execution authority.",
      "Imported records are not activated automatically; a host must explicitly open and resume the destination runtime.",
    ],
  };
  return { ...body, sha256: await checksum(body) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCheckpoint(
  value: unknown,
): asserts value is ManagedWorkCheckpoint {
  if (
    !isRecord(value) ||
    value.format !== CHECKPOINT_FORMAT ||
    value.version !== CHECKPOINT_VERSION ||
    value.profile !== "quiescent-current-documents-no-forks-v1" ||
    !Array.isArray(value.conversations) ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.submissions) ||
    !Array.isArray(value.documents) ||
    !Array.isArray(value.limitations) ||
    typeof value.rootConversationId !== "number" ||
    typeof value.capturedAt !== "number" ||
    typeof value.sha256 !== "string"
  ) {
    throw new Error("Unsupported or malformed managed-work checkpoint");
  }
}

function documentCreate(record: DocumentRecord): DocumentCreate {
  const { id, kind, key, scope } = record;
  if (scope.kind === "session") {
    throw new UnsupportedCheckpointState(
      "Session-scoped documents are not part of a work-item checkpoint",
    );
  }
  return {
    id,
    kind,
    ...(key === undefined ? {} : { key }),
    scope,
    ...(scope.kind === "conversation"
      ? { history: record.history, fork: record.fork }
      : {}),
  } as DocumentCreate;
}

function validateCheckpointGraph(checkpoint: ManagedWorkCheckpoint): void {
  if (checkpoint.rootConversationId !== ROOT_CONVERSATION_ID) {
    throw new UnsupportedCheckpointState(
      "Checkpoint root must use the reserved root conversation ID",
    );
  }
  const conversations = new Map(
    checkpoint.conversations.map((record) => [record.id, record]),
  );
  const taskIds = new Set(checkpoint.tasks.map((record) => Number(record.id)));
  if (!conversations.has(checkpoint.rootConversationId)) {
    throw new Error("Checkpoint root conversation is missing");
  }
  const seenIds = new Set<number>();
  const claim = (id: number) => {
    if (!Number.isSafeInteger(id) || id < 1 || seenIds.has(id)) {
      throw new Error(
        `Checkpoint contains invalid or duplicate record ID ${id}`,
      );
    }
    seenIds.add(id);
  };
  for (const conversation of checkpoint.conversations) {
    claim(conversation.id);
    if (conversation.parent) {
      throw new UnsupportedCheckpointState("Fork histories are unsupported");
    }
    if (conversation.id === checkpoint.rootConversationId) {
      if (conversation.owner)
        throw new Error("Checkpoint root must be ownerless");
    } else if (
      !conversation.owner ||
      !conversations.has(conversation.owner.conversationId) ||
      !taskIds.has(Number(conversation.owner.taskId))
    ) {
      throw new Error(
        `Conversation ${conversation.id} is not owned by this checkpoint`,
      );
    }
  }
  for (const entry of checkpoint.entries) {
    claim(entry.id);
    if (!conversations.has(entry.conversationId)) {
      throw new Error(`Entry ${entry.id} refers to an absent conversation`);
    }
    if (entry.byTaskId && !taskIds.has(Number(entry.byTaskId))) {
      throw new Error(`Entry ${entry.id} refers to an absent task`);
    }
  }
  for (const task of checkpoint.tasks) {
    claim(task.id);
    assertSettledTask(task);
    if (!conversations.has(task.conversationId)) {
      throw new Error(`Task ${task.id} refers to an absent conversation`);
    }
    if (task.owner && !taskIds.has(Number(task.owner))) {
      throw new Error(`Task ${task.id} refers to an absent owner task`);
    }
  }
  for (const submission of checkpoint.submissions) {
    claim(submission.id);
    assertSettledSubmission(submission);
    if (!conversations.has(submission.conversationId)) {
      throw new Error(
        `Submission ${submission.id} refers to an absent conversation`,
      );
    }
  }
  for (const document of checkpoint.documents) {
    claim(document.record.id);
    if (document.record.scope.kind === "conversation") {
      if (!conversations.has(document.record.scope.conversationId)) {
        throw new Error(
          `Document ${document.record.id} refers to an absent conversation`,
        );
      }
    } else if (
      document.record.scope.kind === "task" &&
      !taskIds.has(Number(document.record.scope.taskId))
    ) {
      throw new Error(
        `Document ${document.record.id} refers to an absent task`,
      );
    } else if (document.record.scope.kind === "session") {
      throw new UnsupportedCheckpointState("Session documents are unsupported");
    }
  }
}

/**
 * `mintId` proves the global ID space has no prior allocation above reserved ID 1;
 * inspect ID 1 separately because it is not returned by the allocator.
 */
async function assertFreshStorage(
  storage: Storage,
  context: Context,
): Promise<void> {
  const firstMintedId = await storage.mintId<ConversationId>();
  if (firstMintedId !== Number(ROOT_CONVERSATION_ID) + 1) {
    throw new Error(
      "Checkpoint import requires a fresh, never-used destination storage",
    );
  }

  const reservedId = Number(ROOT_CONVERSATION_ID);
  const [conversation, entry, task, submission, document] = await Promise.all([
    storage.conversation(ROOT_CONVERSATION_ID, context),
    storage.entry(reservedId as EntryId, context),
    storage.task(reservedId as TaskId, context),
    storage.submission(reservedId as SubmissionId, context),
    storage.document(reservedId as DocumentId, "current", context),
  ]);
  if (conversation || entry || task || submission || document) {
    throw new Error(
      "Checkpoint import requires a fresh, never-used destination storage",
    );
  }
}

/**
 * Import logical records into a fresh, exclusively held destination without opening or resuming a Harness.
 * Once the freshness guard runs, do not retry on that storage instance: it consumes its initial minted ID.
 */
export async function importManagedWorkCheckpoint(
  storage: Storage,
  value: unknown,
  context: Context = BACKGROUND_CONTEXT,
): Promise<{ rootConversationId: ConversationId; imported: number }> {
  assertCheckpoint(value);
  const { sha256, ...body } = value;
  if ((await checksum(body)) !== sha256) {
    throw new Error("Managed-work checkpoint checksum mismatch");
  }
  validateCheckpointGraph(value);
  await assertFreshStorage(storage, context);

  const writes: StorageWrite[] = [
    ...value.conversations.map((record) => ({
      type: "conversation" as const,
      value: record,
    })),
    ...value.entries.map((record) => ({
      type: "entry" as const,
      value: record,
    })),
    ...value.tasks.map((record) => ({ type: "task" as const, value: record })),
    ...value.submissions.map((record) => ({
      type: "submission" as const,
      value: record,
    })),
    ...value.documents.map((document) => ({
      type: "document.create" as const,
      record: documentCreate(document.record),
      content: {
        kind: "base" as const,
        version: document.version,
        value: document.value,
      },
    })),
  ];
  await storage.commit(writes, context);
  return {
    rootConversationId: value.rootConversationId,
    imported: writes.length,
  };
}
