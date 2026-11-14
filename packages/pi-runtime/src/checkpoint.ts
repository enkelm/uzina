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
  type TaskId,
  type StorageWrite,
  type SubmissionId,
  type SubmissionRecord,
  type TaskRecord,
} from "@earendil-works/pi-durable";

const CHECKPOINT_FORMAT = "uzina.pi-managed-work";
const CHECKPOINT_VERSION = 1;
const PAGE_SIZE = 128;
export const MANAGED_WORK_CHECKPOINT_MAX_BYTES = 32 * 1024 * 1024;
export const MANAGED_WORK_CHECKPOINT_MAX_RECORDS = 100_000;

export type ManagedWorkCheckpointExportLimits = {
  /** Lower test/operator quota; the hard profile limit remains 100,000 records. */
  maxRecords?: number;
  /** Lower test/operator quota; the hard runtime artifact limit remains 32 MiB. */
  maxBytes?: number;
};

type ExportBudget = {
  maxRecords: number;
  maxBytes: number;
  records: number;
  bytes: number;
};

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

function exportBudget(
  limits: ManagedWorkCheckpointExportLimits = {},
): ExportBudget {
  const maxRecords = limits.maxRecords ?? MANAGED_WORK_CHECKPOINT_MAX_RECORDS;
  const maxBytes = limits.maxBytes ?? MANAGED_WORK_CHECKPOINT_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > MANAGED_WORK_CHECKPOINT_MAX_RECORDS ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MANAGED_WORK_CHECKPOINT_MAX_BYTES
  ) {
    throw new Error("Managed-work export limits exceed the bounded profile");
  }
  return { maxRecords, maxBytes, records: 0, bytes: 0 };
}

function accountExportRecord(budget: ExportBudget, value: unknown): void {
  if (budget.records >= budget.maxRecords) {
    throw new UnsupportedCheckpointState(
      "Managed-work storage scan exceeds its record limit",
    );
  }
  accountExportValue(budget, value);
  budget.records += 1;
}

function accountExportValue(budget: ExportBudget, value: unknown): void {
  if (budget.bytes >= budget.maxBytes) {
    throw new UnsupportedCheckpointState(
      "Managed-work storage scan exceeds its byte limit",
    );
  }
  let encoded: Uint8Array;
  try {
    encoded = boundedCanonicalJsonBytes(value, budget.maxBytes - budget.bytes);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Managed-work runtime artifact exceeds its size limit"
    ) {
      throw new UnsupportedCheckpointState(
        "Managed-work storage scan exceeds its byte limit",
      );
    }
    throw error;
  }
  budget.bytes += encoded.byteLength;
}

async function scanPages<T>(
  scan: (limit: number, cursor?: Cursor) => Promise<Page<T, Cursor>>,
  budget: ExportBudget,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(PAGE_SIZE, cursor);
    for (const item of page.items) {
      accountExportRecord(budget, item);
      items.push(item);
    }
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

async function checksumBytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function boundedCanonicalJsonBytes(
  value: unknown,
  maxBytes: number,
): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Managed-work artifact byte limit must be positive");
  }
  type Task =
    | { type: "value"; value: unknown }
    | { type: "text"; value: string }
    | { type: "string"; value: string }
    | { type: "leave"; value: object };
  const tasks: Task[] = [{ type: "value", value }];
  const active = new Set<object>();
  const parts: string[] = [];
  let byteLength = 0;
  const append = (text: string) => {
    byteLength += utf8ByteLength(text);
    if (byteLength > maxBytes) {
      throw new Error("Managed-work runtime artifact exceeds its size limit");
    }
    parts.push(text);
  };
  const appendString = (text: string) => {
    const encodedLength = jsonStringByteLength(text);
    if (byteLength + encodedLength > maxBytes) {
      throw new Error("Managed-work runtime artifact exceeds its size limit");
    }
    const encoded = JSON.stringify(text);
    if (encoded === undefined)
      throw new Error("Checkpoint contains non-JSON data");
    byteLength += encodedLength;
    parts.push(encoded);
  };

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.type === "text") {
      append(task.value);
      continue;
    }
    if (task.type === "string") {
      appendString(task.value);
      continue;
    }
    if (task.type === "leave") {
      active.delete(task.value);
      continue;
    }
    const item = task.value;
    if (item === null) {
      append("null");
    } else if (typeof item === "string") {
      appendString(item);
    } else if (typeof item === "number" || typeof item === "boolean") {
      const encoded = JSON.stringify(item);
      if (encoded === undefined)
        throw new Error("Checkpoint contains non-JSON data");
      append(encoded);
    } else if (Array.isArray(item)) {
      if (active.has(item)) throw new Error("Checkpoint contains cyclic data");
      active.add(item);
      tasks.push({ type: "leave", value: item }, { type: "text", value: "]" });
      for (let index = item.length - 1; index >= 0; index -= 1) {
        tasks.push({ type: "value", value: item[index] });
        if (index > 0) tasks.push({ type: "text", value: "," });
      }
      tasks.push({ type: "text", value: "[" });
    } else if (typeof item === "object") {
      if (active.has(item)) throw new Error("Checkpoint contains cyclic data");
      active.add(item);
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      tasks.push({ type: "leave", value: item }, { type: "text", value: "}" });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        tasks.push(
          { type: "value", value: record[key] },
          { type: "text", value: ":" },
          { type: "string", value: key },
        );
        if (index > 0) tasks.push({ type: "text", value: "," });
      }
      tasks.push({ type: "text", value: "{" });
    } else {
      throw new Error("Checkpoint contains non-JSON data");
    }
  }
  return new TextEncoder().encode(parts.join(""));
}

async function scanAllConversations(
  storage: Storage,
  context: Context,
  budget: ExportBudget,
) {
  return scanPages(
    (limit, cursor) =>
      storage.scanConversations({ order: "ascending" }, limit, cursor, context),
    budget,
  );
}

async function scanAllTasks(
  storage: Storage,
  context: Context,
  budget: ExportBudget,
) {
  return scanPages(
    (limit, cursor) => storage.scanTasks({}, limit, cursor, context),
    budget,
  );
}

async function scanAllSubmissions(
  storage: Storage,
  context: Context,
  budget: ExportBudget,
) {
  return scanPages(
    (limit, cursor) => storage.scanSubmissions({}, limit, cursor, context),
    budget,
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
  limits: ManagedWorkCheckpointExportLimits = {},
): Promise<ManagedWorkCheckpoint> {
  const budget = exportBudget(limits);
  const allConversations = await scanAllConversations(storage, context, budget);
  const allTasks = await scanAllTasks(storage, context, budget);
  const allSubmissions = await scanAllSubmissions(storage, context, budget);
  const sessionDocuments = await scanPages(
    (limit, cursor) =>
      storage.scanDocuments(
        { scope: { kind: "session" }, at: "current" },
        limit,
        cursor,
        context,
      ),
    budget,
  );
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
  const tasksByConversation = new Map<
    number,
    TaskRecord<JsonValue, JsonValue, JsonValue>[]
  >();
  for (const task of allTasks) {
    const rows = tasksByConversation.get(task.conversationId) ?? [];
    rows.push(task);
    tasksByConversation.set(task.conversationId, rows);
  }
  const conversationsByOwnerTask = new Map<number, ConversationRecord[]>();
  for (const conversation of allConversations) {
    if (!conversation.owner) continue;
    const rows = conversationsByOwnerTask.get(conversation.owner.taskId) ?? [];
    rows.push(conversation);
    conversationsByOwnerTask.set(conversation.owner.taskId, rows);
  }
  const pendingConversations = [root.id];
  for (let index = 0; index < pendingConversations.length; index += 1) {
    const conversationId = pendingConversations[index]!;
    for (const task of tasksByConversation.get(conversationId) ?? []) {
      if (tasks.has(task.id)) continue;
      assertSettledTask(task);
      tasks.set(task.id, task);
      for (const conversation of conversationsByOwnerTask.get(task.id) ?? []) {
        if (conversation.owner?.conversationId !== conversationId) continue;
        if (conversation.parent) {
          throw new UnsupportedCheckpointState(
            "Owned fork conversations are not supported by checkpoint profile v1",
          );
        }
        if (!conversations.has(conversation.id)) {
          conversations.set(conversation.id, conversation);
          pendingConversations.push(conversation.id);
        }
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
  if (
    conversations.size !== allConversations.length ||
    tasks.size !== allTasks.length ||
    allSubmissions.some((item) => !conversationIds.has(item.conversationId))
  ) {
    throw new UnsupportedCheckpointState(
      "Managed-work storage contains records outside the supported root and owned closure",
    );
  }
  const taskIds = new Set(taskRecords.map((item) => Number(item.id)));
  const entries: EntryRecord[] = [];
  const documents: CheckpointDocument[] = [];
  for (const conversation of conversationRecords) {
    entries.push(
      ...(await scanPages(
        (limit, cursor) =>
          storage.scanEntries(
            { conversationId: conversation.id, order: "ascending" },
            limit,
            cursor,
            context,
          ),
        budget,
      )),
    );
    for (const record of await scanPages(
      (limit, cursor) =>
        storage.scanDocuments(
          {
            scope: { kind: "conversation", conversationId: conversation.id },
            at: "current",
          },
          limit,
          cursor,
          context,
        ),
      budget,
    )) {
      const stored = await storage.document(record.id, "current", context);
      if (!stored)
        throw new Error(`Document ${record.id} disappeared during capture`);
      const document = {
        record: stored.record,
        version: stored.version,
        value: stored.value,
      };
      accountExportValue(budget, document);
      documents.push(document);
    }
  }
  for (const task of taskRecords) {
    for (const record of await scanPages(
      (limit, cursor) =>
        storage.scanDocuments(
          { scope: { kind: "task", taskId: task.id }, at: "current" },
          limit,
          cursor,
          context,
        ),
      budget,
    )) {
      const stored = await storage.document(record.id, "current", context);
      if (!stored)
        throw new Error(`Document ${record.id} disappeared during capture`);
      const document = {
        record: stored.record,
        version: stored.version,
        value: stored.value,
      };
      accountExportValue(budget, document);
      documents.push(document);
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
  const bodyBytes = boundedCanonicalJsonBytes(body, budget.maxBytes);
  const checkpoint = {
    ...body,
    sha256: await checksumBytes(bodyBytes),
  };
  boundedCanonicalJsonBytes(checkpoint, budget.maxBytes);
  return checkpoint;
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
async function validateManagedWorkCheckpointValue(
  value: unknown,
  maxBytes?: number,
): Promise<ManagedWorkCheckpoint> {
  assertCheckpoint(value);
  const { sha256, ...body } = value;
  const bodyBytes =
    maxBytes === undefined
      ? new TextEncoder().encode(canonicalJson(body))
      : boundedCanonicalJsonBytes(body, maxBytes);
  if ((await checksumBytes(bodyBytes)) !== sha256) {
    throw new Error("Managed-work checkpoint checksum mismatch");
  }
  validateCheckpointGraph(value);
  return value;
}

export async function validateManagedWorkCheckpoint(
  value: unknown,
): Promise<ManagedWorkCheckpoint> {
  return validateManagedWorkCheckpointValue(value);
}

/** Validate once and return the bounded v1 artifact bytes for bundle composition. */
export async function prepareManagedWorkCheckpointArtifact(
  value: unknown,
  maxBytes: number,
): Promise<{ checkpoint: ManagedWorkCheckpoint; bytes: Uint8Array }> {
  const checkpoint = await validateManagedWorkCheckpointValue(value, maxBytes);
  const bytes = boundedCanonicalJsonBytes(checkpoint, maxBytes);
  return { checkpoint, bytes };
}

async function scanPagesAtMost<T>(
  expectedCount: number,
  scan: (limit: number, cursor?: Cursor) => Promise<Page<T, Cursor>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(
      Math.max(1, Math.min(PAGE_SIZE, expectedCount + 1 - items.length)),
      cursor,
    );
    items.push(...page.items);
    if (items.length > expectedCount) {
      throw new Error("Prepared managed-work runtime has unexpected records");
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

/** Compare every current Pi Durable record to a validated inactive checkpoint. */
export async function verifyManagedWorkCheckpointStorage(
  storage: Storage,
  value: unknown,
): Promise<void> {
  const expected = await validateManagedWorkCheckpoint(value);
  const [conversations, tasks, submissions, sessionDocuments] =
    await Promise.all([
      scanPagesAtMost(expected.conversations.length, (limit, cursor) =>
        storage.scanConversations(
          { order: "ascending" },
          limit,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      ),
      scanPagesAtMost(expected.tasks.length, (limit, cursor) =>
        storage.scanTasks({}, limit, cursor, BACKGROUND_CONTEXT),
      ),
      scanPagesAtMost(expected.submissions.length, (limit, cursor) =>
        storage.scanSubmissions({}, limit, cursor, BACKGROUND_CONTEXT),
      ),
      scanPagesAtMost(0, (limit, cursor) =>
        storage.scanDocuments(
          { scope: { kind: "session" }, at: "current" },
          limit,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      ),
    ]);
  conversations.sort((left, right) => Number(left.id) - Number(right.id));
  tasks.sort((left, right) => Number(left.id) - Number(right.id));
  submissions.sort((left, right) => Number(left.id) - Number(right.id));
  const entries: EntryRecord[] = [];
  for (const conversation of conversations) {
    const remaining = expected.entries.length - entries.length;
    entries.push(
      ...(await scanPagesAtMost(remaining, (limit, cursor) =>
        storage.scanEntries(
          { conversationId: conversation.id, order: "ascending" },
          limit,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      )),
    );
  }
  entries.sort((left, right) => Number(left.id) - Number(right.id));
  if (
    sessionDocuments.length > 0 ||
    canonicalJson(conversations) !==
      canonicalJson(
        [...expected.conversations].sort((a, b) => Number(a.id) - Number(b.id)),
      ) ||
    canonicalJson(entries) !==
      canonicalJson(
        [...expected.entries].sort((a, b) => Number(a.id) - Number(b.id)),
      ) ||
    canonicalJson(tasks) !==
      canonicalJson(
        [...expected.tasks].sort((a, b) => Number(a.id) - Number(b.id)),
      ) ||
    canonicalJson(submissions) !==
      canonicalJson(
        [...expected.submissions].sort((a, b) => Number(a.id) - Number(b.id)),
      )
  ) {
    throw new Error("Prepared managed-work runtime does not match bundle");
  }

  const documents: CheckpointDocument[] = [];
  const collectDocuments = async (
    scope:
      | { kind: "conversation"; conversationId: ConversationId }
      | { kind: "task"; taskId: TaskId },
  ) => {
    const remaining = expected.documents.length - documents.length;
    const records = await scanPagesAtMost(remaining, (limit, cursor) =>
      storage.scanDocuments(
        { scope, at: "current" },
        limit,
        cursor,
        BACKGROUND_CONTEXT,
      ),
    );
    for (const record of records) {
      const document = await storage.document(
        record.id,
        "current",
        BACKGROUND_CONTEXT,
      );
      if (!document) {
        throw new Error("Prepared managed-work document disappeared");
      }
      documents.push({
        record: document.record,
        version: document.version,
        value: document.value,
      });
    }
  };
  for (const conversation of conversations) {
    await collectDocuments({
      kind: "conversation",
      conversationId: conversation.id,
    });
  }
  for (const task of tasks) {
    await collectDocuments({ kind: "task", taskId: task.id });
  }
  documents.sort(
    (left, right) => Number(left.record.id) - Number(right.record.id),
  );
  if (
    canonicalJson(documents) !==
    canonicalJson(
      [...expected.documents].sort(
        (left, right) => Number(left.record.id) - Number(right.record.id),
      ),
    )
  ) {
    throw new Error("Prepared managed-work runtime does not match bundle");
  }
}

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
  const checkpoint = await validateManagedWorkCheckpoint(value);
  await assertFreshStorage(storage, context);

  const writes: StorageWrite[] = [
    ...checkpoint.conversations.map((record) => ({
      type: "conversation" as const,
      value: record,
    })),
    ...checkpoint.entries.map((record) => ({
      type: "entry" as const,
      value: record,
    })),
    ...checkpoint.tasks.map((record) => ({
      type: "task" as const,
      value: record,
    })),
    ...checkpoint.submissions.map((record) => ({
      type: "submission" as const,
      value: record,
    })),
    ...checkpoint.documents.map((document) => ({
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
    rootConversationId: checkpoint.rootConversationId,
    imported: writes.length,
  };
}
