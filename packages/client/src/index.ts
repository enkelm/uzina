import { CONTRACT_VERSION, capabilitySetSchema } from "@uzina/contracts";
import {
  factoryCommandReceiptSchema,
  factoryEventSchema,
  factoryNodeSchema,
  factoryProjectSchema,
  factoryThreadSchema,
  factoryWorkspaceSchema,
  submitInputRequestSchema,
} from "@uzina/contracts/factory";
import { z } from "zod";

const limitSchema = z.number().int().min(1).max(100);
const cursorSchema = z.number().int().nonnegative().safe();
const MAX_RESPONSE_BYTES = 256 * 1024;

export class FactoryClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Factory request failed (${status}): ${code}`);
    this.name = "FactoryClientError";
  }
}

export type FactoryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FactoryClientOptions {
  baseUrl: string | URL;
  credential: string;
  fetch?: FactoryFetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

const projectsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  projects: z.array(factoryProjectSchema),
});
const threadsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  threads: z.array(factoryThreadSchema),
});
const nodesResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  nodes: z.array(factoryNodeSchema),
});
const workspacesResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  workspaces: z.array(factoryWorkspaceSchema),
});
const runsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  threadId: z.string(),
  runs: z.array(factoryCommandReceiptSchema),
});
const eventsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  events: z.array(factoryEventSchema),
  nextCursor: cursorSchema,
});
const receiptResponseSchema = factoryCommandReceiptSchema;
const capabilitiesResponseSchema = capabilitySetSchema;
const jsonObjectResponseSchema = z.record(z.unknown());

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function checkedIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError(`${name} is not a valid Factory identifier`);
  }
  return encodeURIComponent(value);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function readBoundedResponseBytes(
  response: Response,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array();

  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  const reader = body.getReader();
  let length = 0;
  let completed = false;
  let cancellationStarted = false;
  const cancel = (reason: unknown) => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    try {
      void reader.cancel(reason).catch(() => {});
    } catch {
      // Preserve the read or size error when a body refuses cancellation.
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        completed = true;
        break;
      }
      if (chunk.value.byteLength > MAX_RESPONSE_BYTES - length) {
        throw new FactoryClientError(502, "response_too_large");
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return bytes.subarray(0, length);
  } catch (error) {
    if (!completed) cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Authenticated Factory API client bound to one origin and one Factory credential. */
export class FactoryClient {
  readonly #baseUrl: URL;
  readonly #origin: string;
  readonly #credential: string;
  readonly #fetch: FactoryFetch;

  constructor(options: FactoryClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (
      (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.search !== "" ||
      baseUrl.hash !== "" ||
      baseUrl.pathname !== "/"
    ) {
      throw new TypeError(
        "Factory baseUrl must be an origin URL without credentials or a path",
      );
    }
    if (!options.credential.trim() || /\s/.test(options.credential)) {
      throw new TypeError("Factory credential must be a nonempty bearer token");
    }
    this.#baseUrl = baseUrl;
    this.#origin = baseUrl.origin;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? fetch;
  }

  async listProjects(options: RequestOptions & { limit?: number } = {}) {
    const limit = limitSchema.parse(options.limit ?? 100);
    return this.#get(
      `/v1/projects${query({ limit })}`,
      projectsResponseSchema,
      options.signal,
    );
  }

  async listThreads(
    options: RequestOptions & { projectId?: string; limit?: number } = {},
  ) {
    const limit = limitSchema.parse(options.limit ?? 100);
    if (options.projectId) checkedIdentifier(options.projectId, "projectId");
    return this.#get(
      `/v1/threads${query({ projectId: options.projectId, limit })}`,
      threadsResponseSchema,
      options.signal,
    );
  }

  async listNodes(options: RequestOptions & { limit?: number } = {}) {
    const limit = limitSchema.parse(options.limit ?? 100);
    return this.#get(
      `/v1/nodes${query({ limit })}`,
      nodesResponseSchema,
      options.signal,
    );
  }

  async listWorkspaces(options: RequestOptions & { limit?: number } = {}) {
    const limit = limitSchema.parse(options.limit ?? 100);
    return this.#get(
      `/v1/workspaces${query({ limit })}`,
      workspacesResponseSchema,
      options.signal,
    );
  }

  async listRuns(
    threadId: string,
    options: RequestOptions & { limit?: number } = {},
  ) {
    const limit = limitSchema.parse(options.limit ?? 100);
    const id = checkedIdentifier(threadId, "threadId");
    return this.#get(
      `/v1/threads/${id}/runs${query({ limit })}`,
      runsResponseSchema,
      options.signal,
    );
  }

  async getReceipt(requestId: string, options: RequestOptions = {}) {
    const id = checkedIdentifier(requestId, "requestId");
    return this.#get(
      `/v1/commands/${id}`,
      receiptResponseSchema,
      options.signal,
    );
  }

  async submitInput(
    threadId: string,
    requestId: string,
    text: string,
    options: RequestOptions = {},
  ) {
    const id = checkedIdentifier(threadId, "threadId");
    const input = submitInputRequestSchema.parse({ requestId, text });
    return this.#request(
      `/v1/threads/${id}/inputs`,
      "POST",
      input,
      factoryCommandReceiptSchema,
      options.signal,
    );
  }

  async getContext(threadId: string, options: RequestOptions = {}) {
    const id = checkedIdentifier(threadId, "threadId");
    return this.#get(
      `/v1/threads/${id}/context`,
      jsonObjectResponseSchema,
      options.signal,
    );
  }

  async getStatus(threadId: string, options: RequestOptions = {}) {
    const id = checkedIdentifier(threadId, "threadId");
    return this.#get(
      `/v1/threads/${id}/status`,
      jsonObjectResponseSchema,
      options.signal,
    );
  }

  async getEvents(
    after = 0,
    options: RequestOptions & { limit?: number } = {},
  ) {
    cursorSchema.parse(after);
    const limit = limitSchema.parse(options.limit ?? 100);
    return this.#get(
      `/v1/events${query({ after, limit })}`,
      eventsResponseSchema,
      options.signal,
    );
  }

  async getLifecycleCapabilities(
    threadId: string,
    options: RequestOptions = {},
  ) {
    const id = checkedIdentifier(threadId, "threadId");
    return this.#get(
      `/v1/threads/${id}/lifecycle-capabilities`,
      capabilitiesResponseSchema,
      options.signal,
    );
  }

  async #get<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#request(path, "GET", undefined, schema, signal);
  }

  async #request<T>(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#origin)
      throw new TypeError("Factory request escaped its configured origin");
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.#credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new FactoryClientError(0, "network_error");
    }
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== this.#origin)
    ) {
      throw new FactoryClientError(502, "cross_origin_redirect_refused");
    }
    let value: unknown;
    try {
      const bytes = await readBoundedResponseBytes(response);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = text ? (JSON.parse(text) as unknown) : null;
    } catch (error) {
      if (isAbortError(error) || error instanceof FactoryClientError)
        throw error;
      throw new FactoryClientError(502, "invalid_response");
    }
    if (!response.ok) {
      const code =
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string" &&
        /^[a-z0-9_:-]{1,100}$/i.test(value.error)
          ? value.error
          : "request_failed";
      throw new FactoryClientError(response.status, code);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new FactoryClientError(502, "invalid_response");
    return parsed.data;
  }
}

export type FactoryCommandReceipt = z.infer<typeof factoryCommandReceiptSchema>;
