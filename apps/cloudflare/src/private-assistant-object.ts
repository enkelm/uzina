import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  createRegistry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { FactoryClient, type FactoryFetch } from "@uzina/client";
import {
  checkPrivateAssistantIdentity,
  PrivateAssistantError,
  PrivateAssistantRuntime,
  createFactoryBotExtension,
  type PrivateAssistantAdmission,
  type PrivateAssistantIdentity,
  type PrivateAssistantStore,
} from "@uzina/pi-runtime";
import { ManagedPiWork } from "@uzina/pi-runtime/work";
import {
  createWorkerManagedRuntimeOptions,
  type ManagedRuntimeEnvironment,
} from "@uzina/pi-runtime/worker-provider";
import type {
  FactoryDurableObjectEnvironment,
  PrivateAssistantRpc,
} from "./factory-object";
import type { ManagedWorkState } from "./work-object";

export type PrivateAssistantWorkerEnvironment = ManagedRuntimeEnvironment & {
  UZINA_PRIVATE_ASSISTANT_BEARER?: string;
  UZINA_PRIVATE_ASSISTANT_CREDENTIAL_ID?: string;
  UZINA_PRIVATE_ASSISTANT_ASSISTANT_ID?: string;
  UZINA_PRIVATE_ASSISTANT_OWNER_ID?: string;
  FACTORY: FactoryDurableObjectEnvironment["FACTORY"];
};

interface PrivateAssistantCursor {
  toArray(): Record<string, unknown>[];
}

type PrivateAssistantStorage = ManagedWorkState["storage"] & {
  sql: {
    exec(
      query: string,
      ...values: (string | number | null)[]
    ): PrivateAssistantCursor;
  };
  transactionSync<T>(operation: () => T): T;
};

export interface PrivateAssistantState {
  id: { name?: string };
  storage: PrivateAssistantStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  abort(reason?: string): void;
}

interface IdentityRow {
  identity_json: string;
}
interface InputRow {
  input_id: string;
  payload_sha256: string;
  request_id: string;
  submission_id: string | null;
  accepted_at: string;
}

class DurablePrivateAssistantStore implements PrivateAssistantStore {
  constructor(private readonly state: PrivateAssistantState) {
    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS private_assistant_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        identity_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS private_assistant_inputs (
        input_id TEXT PRIMARY KEY,
        payload_sha256 TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        submission_id TEXT,
        accepted_at TEXT NOT NULL
      );
    `);
  }

  async bindIdentity(identity: PrivateAssistantIdentity): Promise<boolean> {
    const encoded = JSON.stringify(identity);
    const row = this.state.storage.sql
      .exec(
        "SELECT identity_json FROM private_assistant_identity WHERE singleton = 1",
      )
      .toArray()[0] as unknown as IdentityRow | undefined;
    if (row) return row.identity_json === encoded;
    this.state.storage.sql.exec(
      "INSERT INTO private_assistant_identity (singleton, identity_json) VALUES (1, ?)",
      encoded,
    );
    return true;
  }

  async reserveInput(inputId: string, payloadSha256: string) {
    return this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql
        .exec(
          "SELECT input_id, payload_sha256, request_id, submission_id, accepted_at FROM private_assistant_inputs WHERE input_id = ?",
          inputId,
        )
        .toArray()[0] as unknown as InputRow | undefined;
      if (row) {
        if (row.payload_sha256 !== payloadSha256) {
          throw new PrivateAssistantError(
            409,
            "private_assistant_input_conflict",
          );
        }
        return this.admission(row);
      }
      const admission: PrivateAssistantAdmission = {
        inputId,
        payloadSha256,
        requestId: inputId,
        submissionId: null,
        acceptedAt: new Date().toISOString(),
      };
      this.state.storage.sql.exec(
        "INSERT INTO private_assistant_inputs (input_id, payload_sha256, request_id, accepted_at) VALUES (?, ?, ?, ?)",
        admission.inputId,
        admission.payloadSha256,
        admission.requestId,
        admission.acceptedAt,
      );
      return admission;
    });
  }

  async setSubmission(
    inputId: string,
    payloadSha256: string,
    submissionId: string,
  ) {
    this.state.storage.sql.exec(
      "UPDATE private_assistant_inputs SET submission_id = ? WHERE input_id = ? AND payload_sha256 = ?",
      submissionId,
      inputId,
      payloadSha256,
    );
    const row = this.state.storage.sql
      .exec(
        "SELECT submission_id FROM private_assistant_inputs WHERE input_id = ? AND payload_sha256 = ?",
        inputId,
        payloadSha256,
      )
      .toArray()[0];
    if (!row) {
      throw new PrivateAssistantError(409, "private_assistant_input_conflict");
    }
  }

  async getInput(inputId: string) {
    const row = this.state.storage.sql
      .exec(
        "SELECT input_id, payload_sha256, request_id, submission_id, accepted_at FROM private_assistant_inputs WHERE input_id = ?",
        inputId,
      )
      .toArray()[0] as unknown as InputRow | undefined;
    return row ? this.admission(row) : undefined;
  }

  private admission(row: InputRow): PrivateAssistantAdmission {
    return {
      inputId: row.input_id,
      payloadSha256: row.payload_sha256,
      requestId: row.request_id,
      submissionId: row.submission_id,
      acceptedAt: row.accepted_at,
    };
  }
}

export class PrivateAssistantObject
  extends DurableObject<PrivateAssistantWorkerEnvironment>
  implements PrivateAssistantRpc
{
  readonly #state: PrivateAssistantState;
  readonly #environment: PrivateAssistantWorkerEnvironment;
  readonly #store: DurablePrivateAssistantStore;
  readonly #baseUrl = "https://uzina-factory.internal";
  #work: ManagedPiWork | undefined;
  #runtime: PrivateAssistantRuntime | undefined;
  #opening: Promise<PrivateAssistantRuntime> | undefined;
  #ready: Promise<void>;
  #closed = false;
  #alarmChain: Promise<void> = Promise.resolve();
  #operationChain: Promise<void> = Promise.resolve();

  constructor(
    state: PrivateAssistantState,
    environment: PrivateAssistantWorkerEnvironment,
  ) {
    super(state as unknown as DurableObjectState, environment);
    this.#state = state;
    this.#environment = environment;
    this.#store = new DurablePrivateAssistantStore(state);
    this.#ready = state.blockConcurrencyWhile(async () => {
      await this.#armFallbackBeforeRecovery();
      await this.#open();
    });
  }

  status() {
    return this.#run((runtime) => runtime.status());
  }
  context() {
    return this.#run((runtime) => runtime.context());
  }
  receipt(inputId: string) {
    return this.#run((runtime) => runtime.receipt(inputId));
  }
  submit(inputId: string, text: string) {
    return this.#run((runtime) => runtime.submit(inputId, text));
  }

  async close(): Promise<void> {
    await this.#ready;
    return this.#enqueue(async () => {
      if (this.#closed) return;
      this.#closed = true;
      await this.#queueAlarm(() => this.#state.storage.deleteAlarm());
      const work = this.#work;
      this.#work = undefined;
      this.#runtime = undefined;
      await work?.close(BACKGROUND_CONTEXT);
    });
  }

  async alarm(): Promise<void> {
    await this.#ready;
    if (this.#closed) return;
    await this.#run(async (runtime) => {
      if (await runtime.available()) {
        const work = this.#work;
        if (work) await this.#arm(work.wake());
        await runtime.resume();
      } else {
        await this.#arm({ active: false, at: Date.now() + 60_000 });
      }
    });
  }

  #run<T>(
    operation: (runtime: PrivateAssistantRuntime) => Promise<T>,
  ): Promise<T> {
    return this.#enqueue(async () => {
      await this.#ready;
      if (this.#closed)
        throw new PrivateAssistantError(503, "private_assistant_unavailable");
      const runtime = this.#runtime ?? (await this.#open());
      return operation(runtime);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationChain.then(operation);
    this.#operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #open(): Promise<PrivateAssistantRuntime> {
    if (this.#runtime) return this.#runtime;
    if (this.#opening) return this.#opening;
    const opening = this.#createRuntime();
    this.#opening = opening;
    try {
      this.#runtime = await opening;
      return this.#runtime;
    } finally {
      this.#opening = undefined;
    }
  }

  async #createRuntime(): Promise<PrivateAssistantRuntime> {
    const environment = this.#environment;
    const expected = this.#expectedIdentity();
    const factory = environment.FACTORY.get(
      environment.FACTORY.idFromName("uzina-single-factory"),
    );
    const fetchFactory: FactoryFetch = async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = request ? new URL(request.url) : new URL(input.toString());
      if (url.origin !== this.#baseUrl) {
        throw new TypeError("Private assistant Factory client origin mismatch");
      }
      const method = init?.method ?? request?.method ?? "GET";
      if (method !== "GET" && method !== "POST") {
        throw new TypeError("Private assistant Factory method is unsupported");
      }
      const headers = new Headers(request?.headers);
      new Headers(init?.headers).forEach((value, key) =>
        headers.set(key, value),
      );
      const body =
        init?.body ??
        (request && method !== "GET" ? await request.text() : undefined);
      const result = await factory.factoryHttp({
        url: url.toString(),
        method,
        headers: Object.fromEntries(headers.entries()),
        ...(body === undefined ? {} : { body: String(body) }),
      });
      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    };
    let client: FactoryClient | undefined;
    try {
      if (environment.UZINA_PRIVATE_ASSISTANT_BEARER && expected) {
        client = new FactoryClient({
          baseUrl: this.#baseUrl,
          credential: environment.UZINA_PRIVATE_ASSISTANT_BEARER,
          fetch: fetchFactory,
        });
      }
    } catch {
      client = undefined;
    }
    const checkedIdentity = await checkPrivateAssistantIdentity(
      client,
      expected,
      this.#store,
    );
    const registry = createRegistry<ToolRegistration>();
    const factoryTools =
      client && environment.UZINA_PRIVATE_ASSISTANT_BEARER
        ? createFactoryBotExtension(client, {
            credentialToRedact: environment.UZINA_PRIVATE_ASSISTANT_BEARER,
          })
        : undefined;
    const options = await createWorkerManagedRuntimeOptions(environment);
    const storage = await openDurableObjectSqliteStorage(this.#state.storage);
    let assistantRuntime: PrivateAssistantRuntime | undefined;
    const work = await ManagedPiWork.open({
      ...options,
      storage,
      registry,
      beforeWork: async () => {
        if (!assistantRuntime || !(await assistantRuntime.available())) {
          throw new PrivateAssistantError(503, "private_assistant_unavailable");
        }
        await this.#arm({ ...workWake(this.#work), active: true });
      },
      onWake: (wake) => {
        void this.#arm(wake).catch(() => {
          this.#state.abort("Could not arm private-assistant recovery alarm");
        });
      },
    });
    const runtime = new PrivateAssistantRuntime(
      work,
      this.#store,
      client,
      expected,
      registry,
      factoryTools,
      checkedIdentity,
    );
    assistantRuntime = runtime;
    this.#runtime = runtime;
    this.#work = work;
    if (checkedIdentity.available) {
      await this.#arm({ ...work.wake(), active: true });
      await runtime.resume();
    }
    return runtime;
  }

  #expectedIdentity(): PrivateAssistantIdentity | undefined {
    const credentialId =
      this.#environment.UZINA_PRIVATE_ASSISTANT_CREDENTIAL_ID;
    const assistantId = this.#environment.UZINA_PRIVATE_ASSISTANT_ASSISTANT_ID;
    const ownerId = this.#environment.UZINA_PRIVATE_ASSISTANT_OWNER_ID;
    if (!credentialId || !assistantId || !ownerId) return undefined;
    return { credentialId, assistantId, ownerId };
  }

  async #armFallbackBeforeRecovery(): Promise<void> {
    const fallback = Date.now() + 60_000;
    const current = await this.#state.storage.getAlarm();
    if (current === null || current > fallback)
      await this.#state.storage.setAlarm(fallback);
  }

  #arm(wake: { active: boolean; at?: number }): Promise<void> {
    return this.#queueAlarm(async () => {
      if (this.#closed) return;
      const heartbeat = wake.active ? Date.now() + 60_000 : undefined;
      const at =
        heartbeat === undefined || wake.at === undefined
          ? (heartbeat ?? wake.at)
          : Math.min(heartbeat, wake.at);
      if (at === undefined) await this.#state.storage.deleteAlarm();
      else await this.#state.storage.setAlarm(at);
    });
  }

  #queueAlarm(operation: () => Promise<void>): Promise<void> {
    const result = this.#alarmChain.then(operation);
    this.#alarmChain = result.catch(() => {});
    return result;
  }
}

function workWake(work: ManagedPiWork | undefined) {
  return work?.wake() ?? { active: false };
}
