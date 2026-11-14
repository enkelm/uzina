import type { FactoryClient } from "@uzina/client";
import type {
  Extension,
  Registry,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ManagedPiWork } from "./index";

export type PrivateAssistantIdentity = {
  credentialId: string;
  assistantId: string;
  ownerId: string;
};

export type PrivateAssistantAdmission = {
  inputId: string;
  payloadSha256: string;
  requestId: string;
  submissionId: string | null;
  acceptedAt: string;
};

export interface PrivateAssistantStore {
  bindIdentity(identity: PrivateAssistantIdentity): Promise<boolean>;
  reserveInput(
    inputId: string,
    payloadSha256: string,
  ): Promise<PrivateAssistantAdmission>;
  setSubmission(
    inputId: string,
    payloadSha256: string,
    submissionId: string,
  ): Promise<void>;
  getInput(inputId: string): Promise<PrivateAssistantAdmission | undefined>;
}

export class PrivateAssistantError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "PrivateAssistantError";
  }
}

function identityFromMe(
  identity: Awaited<ReturnType<FactoryClient["me"]>>,
): PrivateAssistantIdentity | null {
  if (identity.actor.kind !== "assistant") return null;
  return {
    credentialId: identity.credentialId,
    assistantId: identity.actor.assistantId,
    ownerId: identity.actor.ownerId,
  };
}

/** Authenticates the host-named assistant through ordinary Factory HTTP, then pins its private runtime identity. */
export type PrivateAssistantIdentityCheck = {
  available: boolean;
  reason:
    | "ready"
    | "configuration_missing"
    | "credential_unavailable"
    | "identity_mismatch"
    | "identity_persistence_unavailable";
  detail?: string;
};

export const PRIVATE_ASSISTANT_IDENTITY_TIMEOUT_MS = 5_000;

export async function checkPrivateAssistantIdentity(
  client: FactoryClient | undefined,
  expected: PrivateAssistantIdentity | undefined,
  store: PrivateAssistantStore,
): Promise<PrivateAssistantIdentityCheck> {
  if (!client || !expected) {
    return { available: false, reason: "configuration_missing" };
  }
  let me: Awaited<ReturnType<FactoryClient["me"]>>;
  try {
    me = await client.me({
      signal: AbortSignal.timeout(PRIVATE_ASSISTANT_IDENTITY_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      available: false,
      reason: "credential_unavailable",
      detail:
        error &&
        typeof error === "object" &&
        "status" in error &&
        "code" in error &&
        typeof error.status === "number"
          ? `factory_http_${error.status}`
          : "request_unavailable",
    };
  }
  const actual = identityFromMe(me);
  if (
    !actual ||
    actual.credentialId !== expected.credentialId ||
    actual.assistantId !== expected.assistantId ||
    actual.ownerId !== expected.ownerId
  ) {
    return { available: false, reason: "identity_mismatch" };
  }
  try {
    return (await store.bindIdentity(actual))
      ? { available: true, reason: "ready" }
      : { available: false, reason: "identity_mismatch" };
  } catch {
    return { available: false, reason: "identity_persistence_unavailable" };
  }
}

export async function verifyPrivateAssistantIdentity(
  client: FactoryClient,
  expected: PrivateAssistantIdentity,
  store: PrivateAssistantStore,
): Promise<boolean> {
  return (await checkPrivateAssistantIdentity(client, expected, store))
    .available;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Owner-private admission and receipt facade over one isolated Pi Durable runtime. */
export class PrivateAssistantRuntime {
  #toolsInstalled = false;
  #identityCheck: PrivateAssistantIdentityCheck;
  #availabilityCheck: Promise<boolean> | undefined;
  #resumeCheck: Promise<boolean> | undefined;

  constructor(
    private readonly work: ManagedPiWork,
    private readonly store: PrivateAssistantStore,
    private readonly client: FactoryClient | undefined,
    private readonly expectedIdentity: PrivateAssistantIdentity | undefined,
    private readonly registry: Registry<ToolRegistration>,
    private readonly factoryTools: Extension | undefined,
    identityCheck: PrivateAssistantIdentityCheck,
  ) {
    this.#identityCheck = identityCheck;
    if (identityCheck.available) this.#installFactoryTools();
  }

  available(): Promise<boolean> {
    if (!this.client || !this.expectedIdentity || !this.factoryTools) {
      return Promise.resolve(false);
    }
    if (this.#availabilityCheck) return this.#availabilityCheck;
    const checking = this.#refreshAvailability();
    this.#availabilityCheck = checking;
    return checking.finally(() => {
      if (this.#availabilityCheck === checking)
        this.#availabilityCheck = undefined;
    });
  }

  async #refreshAvailability(): Promise<boolean> {
    const identityCheck = await checkPrivateAssistantIdentity(
      this.client,
      this.expectedIdentity,
      this.store,
    );
    this.#identityCheck = identityCheck;
    if (identityCheck.available) this.#installFactoryTools();
    else this.#removeFactoryTools();
    return identityCheck.available;
  }

  #installFactoryTools(): void {
    if (this.#toolsInstalled || !this.factoryTools) return;
    this.registry.install(this.factoryTools);
    this.#toolsInstalled = true;
  }

  #removeFactoryTools(): void {
    if (!this.#toolsInstalled || !this.factoryTools) return;
    this.registry.uninstall(this.factoryTools);
    this.#toolsInstalled = false;
  }

  async resume(): Promise<boolean> {
    if (!(await this.available())) return false;
    if (this.#resumeCheck) return this.#resumeCheck;
    const resuming = this.#resumeScheduler();
    this.#resumeCheck = resuming;
    try {
      return await resuming;
    } finally {
      if (this.#resumeCheck === resuming) this.#resumeCheck = undefined;
    }
  }

  async #resumeScheduler(): Promise<boolean> {
    try {
      await this.work.resume();
      return true;
    } catch (error) {
      if (
        error instanceof PrivateAssistantError &&
        error.code === "private_assistant_unavailable"
      ) {
        return false;
      }
      throw error;
    }
  }

  async submit(inputId: string, text: string) {
    if (!(await this.resume()))
      throw new PrivateAssistantError(503, "private_assistant_unavailable");
    await this.work.create();
    const payloadSha256 = await sha256(text);
    let admission: PrivateAssistantAdmission;
    try {
      admission = await this.store.reserveInput(inputId, payloadSha256);
    } catch (error) {
      if (error instanceof PrivateAssistantError && error.httpStatus === 409) {
        throw error;
      }
      throw new PrivateAssistantError(503, "private_assistant_unavailable");
    }
    const existing = await this.work.submission(admission.requestId);
    if (existing) {
      await this.store.setSubmission(
        inputId,
        payloadSha256,
        String(existing.id),
      );
    } else {
      const accepted = await this.work.submit(admission.requestId, text);
      await this.store.setSubmission(
        inputId,
        payloadSha256,
        String(accepted.submissionId),
      );
    }
    return this.receipt(inputId);
  }

  async receipt(inputId: string) {
    const admission = await this.store.getInput(inputId);
    if (!admission)
      throw new PrivateAssistantError(
        404,
        "private_assistant_receipt_not_found",
      );
    const submission = await this.work.submission(admission.requestId);
    if (submission && admission.submissionId !== String(submission.id)) {
      await this.store.setSubmission(
        inputId,
        admission.payloadSha256,
        String(submission.id),
      );
    }
    const current = (await this.store.getInput(inputId)) ?? admission;
    return {
      ...current,
      ...(submission ? { submission } : {}),
    };
  }

  async context() {
    try {
      return await this.work.context();
    } catch {
      return { status: "not-created" };
    }
  }

  async close(): Promise<void> {
    await this.work.close();
  }

  async status() {
    const available = await this.resume();
    let runtime: unknown;
    try {
      runtime = await this.work.status();
    } catch {
      runtime = { status: "not-created" };
    }
    return {
      available,
      state: available ? "ready" : "parked",
      reason: available
        ? null
        : this.#identityCheck.reason === "ready"
          ? "credential_unavailable"
          : this.#identityCheck.reason,
      detail: available ? null : (this.#identityCheck.detail ?? null),
      runtime,
    };
  }
}
