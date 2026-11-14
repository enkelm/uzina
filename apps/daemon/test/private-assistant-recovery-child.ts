import { Database } from "bun:sqlite";
import { type FactoryFetch } from "@uzina/client";
import { join } from "node:path";
import { createStandaloneFactoryServer } from "../src/factory/standalone";
import { FACTORY_INPUT_REQUEST_MEMO } from "@uzina/pi-runtime";
import { deterministicPrivateAssistantModels } from "../../../packages/pi-runtime/test-support/deterministic-private-assistant-model";

type MutationBody = { requestId: string; text: string };

type ChildEvent =
  | { kind: "ready"; baseUrl: string }
  | { kind: "identity-failed" }
  | {
      kind: "mutation-accepted";
      status: number;
      requestId: string;
      threadId: string;
      text: string;
      memoPersisted: boolean;
    }
  | { kind: "child-error"; name: string };

function emit(event: ChildEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const environment = process.env;
const databasePath = environment.PRIVATE_ASSISTANT_TEST_DATABASE;
const runtimeDirectory = environment.PRIVATE_ASSISTANT_TEST_RUNTIME;
const bootstrapSecret = environment.PRIVATE_ASSISTANT_TEST_BOOTSTRAP;
const bearer = environment.PRIVATE_ASSISTANT_TEST_BEARER;
const credentialId = environment.PRIVATE_ASSISTANT_TEST_CREDENTIAL_ID;
const assistantId = environment.PRIVATE_ASSISTANT_TEST_ASSISTANT_ID;
const ownerId = environment.PRIVATE_ASSISTANT_TEST_OWNER_ID;
const threadId = environment.PRIVATE_ASSISTANT_TEST_THREAD_ID;
const mode = environment.PRIVATE_ASSISTANT_TEST_MODE;
if (
  !databasePath ||
  !runtimeDirectory ||
  !bootstrapSecret ||
  !bearer ||
  !credentialId ||
  !assistantId ||
  !ownerId ||
  !threadId ||
  (mode !== "block-ack" && mode !== "resume")
) {
  throw new Error(
    "Private assistant recovery child configuration is incomplete",
  );
}

let failFirstIdentityProbe = mode === "resume";
const privateAssistantFetch: FactoryFetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request ? request.url : input.toString());
  const method = init?.method ?? request?.method ?? "GET";
  if (url.pathname === "/v1/me" && failFirstIdentityProbe) {
    failFirstIdentityProbe = false;
    emit({ kind: "identity-failed" });
    return Response.json({ error: "temporary_unavailable" }, { status: 503 });
  }

  const threadMatch = /^\/v1\/threads\/([^/]+)\/inputs$/.exec(url.pathname);
  const isInputMutation = method === "POST" && threadMatch !== null;
  const threadId = threadMatch
    ? decodeURIComponent(threadMatch[1]!)
    : undefined;
  const body = isInputMutation
    ? (JSON.parse(
        String(init?.body ?? (request ? await request.clone().text() : "{}")),
      ) as MutationBody)
    : undefined;
  let memoPersisted = false;
  if (body) {
    const memoDatabase = new Database(
      join(runtimeDirectory, "private-assistant", "pi-durable.sqlite"),
      { readonly: true },
    );
    try {
      const taskRecords = memoDatabase
        .query("SELECT record FROM tasks")
        .all() as Array<{ record: string }>;
      memoPersisted = taskRecords.some((task) => {
        const record = JSON.parse(task.record) as {
          memos?: Record<string, { requestId?: string }>;
        };
        return (
          record.memos?.[FACTORY_INPUT_REQUEST_MEMO]?.requestId ===
          body.requestId
        );
      });
    } finally {
      memoDatabase.close();
    }
  }
  const response = await fetch(input, init);
  if (body && response.status === 202) {
    emit({
      kind: "mutation-accepted",
      status: response.status,
      requestId: body.requestId,
      threadId: threadId!,
      text: body.text,
      memoPersisted,
    });
    if (mode === "block-ack") {
      await response.body?.cancel();
      await new Promise<never>(() => {});
    }
  }
  return response;
};

try {
  const host = await createStandaloneFactoryServer({
    databasePath,
    runtimeDirectory,
    bootstrapSecret,
    models: deterministicPrivateAssistantModels({ factoryThreadId: threadId }),
    modelProvider: "uzina-test",
    modelId: "fixed-model",
    privateAssistant: {
      bearer,
      credentialId,
      assistantId,
      ownerId,
      fetch: privateAssistantFetch,
    },
    port: 0,
  });
  emit({ kind: "ready", baseUrl: host.server.url.toString() });
} catch (error) {
  emit({
    kind: "child-error",
    name: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
}
