import {
  workspaceSnapshotClaimRequestSchema,
  workspaceSnapshotClaimResponseSchema,
  workspaceSnapshotReportSchema,
  workspaceSnapshotReportResponseSchema,
  workspaceRelocationClaimRequestSchema,
  workspaceRelocationClaimResponseSchema,
  workspaceRelocationReportSchema,
  workspaceRelocationReportResponseSchema,
  type WorkspaceSnapshotClaim,
  type WorkspaceRelocationClaim,
} from "@uzina/contracts/factory";
import {
  executionCaptureControlClaimRequestSchema,
  executionCaptureControlClaimResponseSchema,
  executionCaptureControlReportResponseSchema,
  executionCaptureControlReportSchema,
  executionClaimRequestSchema,
  executionClaimResponseSchema,
  executionHeartbeatRequestSchema,
  executionHeartbeatResponseSchema,
  executionJobReportSchema,
  executionRegisterRequestSchema,
  executionRegisterResponseSchema,
  executionReportResponseSchema,
  type ExecutionCaptureControl,
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

export class ControllerTransportError extends Error {
  constructor() {
    super("Controller transport failed");
    this.name = "ControllerTransportError";
  }
}

function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}

export function isRetryableControllerFailure(error: unknown): boolean {
  return (
    error instanceof ControllerTransportError ||
    (error instanceof ControllerHttpError &&
      (error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        error.status >= 500))
  );
}

function transportStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) controller.close();
        else controller.enqueue(part.value);
      } catch {
        controller.error(new ControllerTransportError());
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export interface ExecutionControllerConnector {
  register(request: unknown): Promise<void>;
  heartbeat(request: unknown): Promise<void>;
  claim(): Promise<ExecutionJob | null>;
  report(report: unknown): Promise<void>;
  claimCaptureControl(): Promise<ExecutionCaptureControl | null>;
  reportCaptureControl(report: unknown): Promise<void>;
  claimWorkspaceSnapshot(): Promise<WorkspaceSnapshotClaim | null>;
  reportWorkspaceSnapshot(report: unknown): Promise<void>;
  uploadCaptureBlob(
    captureId: string,
    reference: string,
    stream: ReadableStream<Uint8Array>,
    contentLength: number,
  ): Promise<void>;
  claimWorkspaceRelocation(): Promise<WorkspaceRelocationClaim | null>;
  fetchWorkspaceRelocationBlob(
    relocationId: string,
    reference: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number }>;
  reportWorkspaceRelocation(report: unknown): Promise<void>;
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

  async claimCaptureControl(): Promise<ExecutionCaptureControl | null> {
    const body = executionCaptureControlClaimRequestSchema.parse({
      contractVersion: 1,
      nodeId: this.#nodeId,
    });
    const response = await this.#post(
      `/v1/nodes/${this.#nodeId}/capture-controls/claim`,
      body,
      executionCaptureControlClaimResponseSchema,
    );
    if (response.control) {
      this.#assertNode(response.control.nodeId);
      this.#assertNode(response.control.target.nodeId);
    }
    return response.control;
  }

  async reportCaptureControl(report: unknown): Promise<void> {
    const body = executionCaptureControlReportSchema.parse(report);
    this.#assertNode(body.nodeId);
    this.#assertNode(body.target.nodeId);
    const response = await this.#post(
      `/v1/nodes/${this.#nodeId}/capture-controls/${body.controlId}/report`,
      body,
      executionCaptureControlReportResponseSchema,
    );
    if (
      response.nodeId !== this.#nodeId ||
      response.controlId !== body.controlId ||
      response.captureId !== body.captureId ||
      response.status !== body.status
    ) {
      throw new ControllerProtocolError(
        "Controller capture-control acknowledgement mismatch",
      );
    }
  }

  async claimWorkspaceSnapshot(): Promise<WorkspaceSnapshotClaim | null> {
    const body = workspaceSnapshotClaimRequestSchema.parse({
      contractVersion: 1,
      nodeId: this.#nodeId,
    });
    const response = await this.#post(
      `/v1/nodes/${this.#nodeId}/workspace-snapshots/claim`,
      body,
      workspaceSnapshotClaimResponseSchema,
    );
    if (response.snapshot) {
      this.#assertNode(response.snapshot.nodeId);
      this.#assertNode(response.snapshot.target.nodeId);
    }
    return response.snapshot;
  }

  async reportWorkspaceSnapshot(report: unknown): Promise<void> {
    const body = workspaceSnapshotReportSchema.parse(report);
    this.#assertNode(body.nodeId);
    this.#assertNode(body.target.nodeId);
    const response = await this.#post(
      `/v1/nodes/${this.#nodeId}/workspace-snapshots/${body.snapshotId}/report`,
      body,
      workspaceSnapshotReportResponseSchema,
    );
    if (
      response.nodeId !== this.#nodeId ||
      response.snapshotId !== body.snapshotId ||
      response.captureId !== body.captureId ||
      response.status !== body.status
    ) {
      throw new ControllerProtocolError(
        "Controller snapshot acknowledgement mismatch",
      );
    }
  }

  async uploadCaptureBlob(
    captureId: string,
    reference: string,
    stream: ReadableStream<Uint8Array>,
    contentLength: number,
  ): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(captureId)) {
      throw new ControllerProtocolError("Invalid capture namespace");
    }
    if (!/^[a-f0-9]{64}$/.test(reference)) {
      throw new ControllerProtocolError("Invalid workspace blob reference");
    }
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > 512 * 1024 * 1024
    ) {
      throw new ControllerProtocolError(
        "Workspace blob exceeds its transfer bound",
      );
    }
    const timeout = AbortSignal.timeout(10 * 60_000);
    let response: Response;
    try {
      response = await fetch(
        `${this.#baseUrl}/v1/nodes/${this.#nodeId}/captures/${encodeURIComponent(captureId)}/blobs/${reference}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${this.#credential}`,
            "content-type": "application/octet-stream",
            "content-length": String(contentLength),
          },
          body: stream,
          redirect: "manual",
          signal: timeout,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      );
    } catch (error) {
      if (isTransportFailure(error)) throw new ControllerTransportError();
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ControllerHttpError(response.status);
    }
    if (response.status !== 204) {
      await response.body?.cancel();
      throw new ControllerProtocolError(
        "Controller returned invalid blob acknowledgement",
      );
    }
  }

  async claimWorkspaceRelocation(): Promise<WorkspaceRelocationClaim | null> {
    const body = workspaceRelocationClaimRequestSchema.parse({
      contractVersion: 1,
      nodeId: this.#nodeId,
    });
    const response = await this.#post(
      `/v1/nodes/${encodeURIComponent(this.#nodeId)}/workspace-relocations/claim`,
      body,
      workspaceRelocationClaimResponseSchema,
    );
    if (response.relocation) {
      if (
        response.relocation.destination.nodeId !== this.#nodeId ||
        response.relocation.source.nodeId === this.#nodeId
      ) {
        throw new ControllerProtocolError(
          "Controller relocation node assignment mismatch",
        );
      }
    }
    return response.relocation;
  }

  async fetchWorkspaceRelocationBlob(
    relocationId: string,
    reference: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(relocationId)) {
      throw new ControllerProtocolError("Invalid relocation identity");
    }
    if (!/^[a-f0-9]{64}$/.test(reference)) {
      throw new ControllerProtocolError("Invalid workspace blob reference");
    }
    const timeout = AbortSignal.timeout(10 * 60_000);
    let response: Response;
    try {
      response = await fetch(
        `${this.#baseUrl}/v1/nodes/${encodeURIComponent(this.#nodeId)}/workspace-relocations/${encodeURIComponent(relocationId)}/blobs/${reference}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.#credential}`,
            accept: "application/octet-stream",
          },
          redirect: "manual",
          signal: timeout,
        },
      );
    } catch (error) {
      if (isTransportFailure(error)) throw new ControllerTransportError();
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ControllerHttpError(response.status);
    }
    const rawSize = response.headers.get("content-length");
    const size = rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : NaN;
    if (
      response.status !== 200 ||
      response.headers.get("content-type") !== "application/octet-stream" ||
      response.headers.get("x-content-sha256") !== reference ||
      !response.body ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 512 * 1024 * 1024
    ) {
      await response.body?.cancel();
      throw new ControllerProtocolError(
        "Controller returned invalid workspace relocation blob metadata",
      );
    }
    return { body: transportStream(response.body), size };
  }

  async reportWorkspaceRelocation(report: unknown): Promise<void> {
    const body = workspaceRelocationReportSchema.parse(report);
    this.#assertNode(body.destination.nodeId);
    const response = await this.#post(
      `/v1/nodes/${encodeURIComponent(this.#nodeId)}/workspace-relocations/${encodeURIComponent(body.relocationId)}/report`,
      body,
      workspaceRelocationReportResponseSchema,
    );
    if (
      response.nodeId !== this.#nodeId ||
      response.relocationId !== body.relocationId ||
      response.status !== body.status
    ) {
      throw new ControllerProtocolError(
        "Controller relocation report acknowledgement mismatch",
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
    const requestUrl = `${this.#baseUrl}${route}`;
    const requestBody = JSON.stringify(body);
    const timeout = AbortSignal.timeout(30_000);
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#credential}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: requestBody,
        redirect: "manual",
        signal: timeout,
      });
    } catch (error) {
      if (isTransportFailure(error)) {
        throw new ControllerTransportError();
      }
      throw error;
    }
    if (!response.ok) throw new ControllerHttpError(response.status);

    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (isTransportFailure(error)) throw new ControllerTransportError();
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
