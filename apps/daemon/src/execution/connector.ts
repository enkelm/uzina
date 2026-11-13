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
import { executionPayloadSha256 } from "./payload";

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
  readonly #claimedJobs = new Map<string, ExecutionJob>();
  readonly #reportedStatuses = new Map<
    string,
    "completed" | "failed" | "uncertain"
  >();

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
      const previous = this.#claimedJobs.get(response.job.jobId);
      if (
        previous &&
        executionPayloadSha256(previous) !==
          executionPayloadSha256(response.job)
      ) {
        throw new ControllerProtocolError(
          "Controller changed a claimed job payload",
        );
      }
      this.#claimedJobs.set(response.job.jobId, response.job);
    }
    return response.job;
  }

  async report(report: unknown): Promise<void> {
    const body = executionJobReportSchema.parse(report);
    this.#assertNode(body.nodeId);
    this.#assertNode(body.target.nodeId);
    const assigned = this.#claimedJobs.get(body.jobId);
    if (
      !assigned ||
      assigned.nodeId !== body.nodeId ||
      assigned.target.nodeId !== body.target.nodeId ||
      assigned.target.workspaceId !== body.target.workspaceId ||
      assigned.ownershipGeneration !== body.ownershipGeneration ||
      executionPayloadSha256(assigned) !== body.payloadSha256
    ) {
      throw new ControllerProtocolError("Report does not match a claimed job");
    }
    const priorStatus = this.#reportedStatuses.get(body.jobId);
    if (priorStatus && priorStatus !== body.status) {
      throw new ControllerProtocolError("Conflicting report for claimed job");
    }
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
    this.#reportedStatuses.set(body.jobId, body.status);
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
