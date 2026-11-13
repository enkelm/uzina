import {
  executionClaimRequestSchema,
  executionClaimResponseSchema,
  executionHeartbeatRequestSchema,
  executionHeartbeatResponseSchema,
  executionJobReportSchema,
  executionRegisterRequestSchema,
  executionRegisterResponseSchema,
  executionReportResponseSchema,
  type ExecutionJob,
} from "@uzina/contracts/execution";

export class ControllerHttpError extends Error {
  constructor(
    readonly status: number,
    message = `Controller returned HTTP ${status}`,
  ) {
    super(message);
    this.name = "ControllerHttpError";
  }
}

export class ControllerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControllerProtocolError";
  }
}

export interface ExecutionControllerConnector {
  register(request: unknown): Promise<void>;
  heartbeat(request: unknown): Promise<void>;
  claim(): Promise<ExecutionJob | null>;
  report(report: unknown): Promise<void>;
}

export interface HttpExecutionControllerConnectorOptions {
  controllerUrl: string;
  nodeId: string;
  credential: string;
}

export class HttpExecutionControllerConnector implements ExecutionControllerConnector {
  readonly #baseUrl: string;
  readonly #nodeId: string;
  readonly #credential: string;

  constructor(options: HttpExecutionControllerConnectorOptions) {
    const url = new URL(options.controllerUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("controllerUrl must be an HTTP(S) origin or path");
    }
    if (!options.nodeId || !options.credential) {
      throw new TypeError("nodeId and node credential are required");
    }
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#nodeId = options.nodeId;
    this.#credential = options.credential;
  }

  async register(request: unknown): Promise<void> {
    const body = executionRegisterRequestSchema.parse(request);
    this.#assertNode(body.nodeId);
    const response = await this.#post(
      `/v1/nodes/${this.#nodeId}/register`,
      body,
      executionRegisterResponseSchema,
    );
    this.#assertNode(response.nodeId);
  }

  async heartbeat(request: unknown): Promise<void> {
    const body = executionHeartbeatRequestSchema.parse(request);
    this.#assertNode(body.nodeId);
    const response = await this.#post(
      `/v1/nodes/${this.#nodeId}/heartbeat`,
      body,
      executionHeartbeatResponseSchema,
    );
    this.#assertNode(response.nodeId);
  }

  async claim(): Promise<ExecutionJob | null> {
    const body = executionClaimRequestSchema.parse({
      contractVersion: 1,
      nodeId: this.#nodeId,
    });
    const response = await this.#post(
      `/v1/nodes/${this.#nodeId}/jobs/claim`,
      body,
      executionClaimResponseSchema,
    );
    if (response.job) {
      this.#assertNode(response.job.nodeId);
      this.#assertNode(response.job.target.nodeId);
    }
    return response.job;
  }

  async report(report: unknown): Promise<void> {
    const body = executionJobReportSchema.parse(report);
    this.#assertNode(body.nodeId);
    this.#assertNode(body.target.nodeId);
    const response = await this.#post(
      `/v1/nodes/${this.#nodeId}/jobs/${body.jobId}/report`,
      body,
      executionReportResponseSchema,
    );
    if (
      response.nodeId !== this.#nodeId ||
      response.jobId !== body.jobId ||
      response.status !== body.status
    ) {
      throw new ControllerProtocolError(
        "Controller report acknowledgement mismatch",
      );
    }
  }

  async #post<T>(
    route: string,
    body: unknown,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: unknown };
    },
  ): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#credential}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ControllerHttpError(response.status);

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ControllerProtocolError("Controller returned invalid JSON");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ControllerProtocolError(
        "Controller response did not match its schema",
      );
    }
    return parsed.data;
  }

  #assertNode(nodeId: string): void {
    if (nodeId !== this.#nodeId) {
      throw new ControllerProtocolError("Controller node identity mismatch");
    }
  }
}
