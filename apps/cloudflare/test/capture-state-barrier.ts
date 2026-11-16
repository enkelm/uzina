export type CaptureStateAdmissionScope = {
  kind: "managed-work-transfer-hold" | "workspace-relocation";
  requestId: string;
  threadId: string;
};

type Gate = {
  scope: CaptureStateAdmissionScope;
  entered: Promise<void>;
  enter(): void;
  response?: (response: Response) => void;
  released: boolean;
};

/** Owned external HTTP gate for delaying delivery after real Core state reads. */
export class CaptureStateBarrier {
  readonly #server: ReturnType<typeof Bun.serve>;
  #gate: Gate | undefined;

  constructor() {
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.#handle(request),
    });
  }

  get url(): string {
    return new URL("/capture-state", this.#server.url).toString();
  }

  arm(scope: CaptureStateAdmissionScope): {
    entered: Promise<void>;
    release(): void;
  } {
    if (this.#gate) throw new Error("Capture-state barrier is already armed");
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate: Gate = { scope, entered, enter, released: false };
    this.#gate = gate;
    return {
      entered,
      release: () => this.#release(gate),
    };
  }

  releaseAll(): void {
    if (this.#gate) this.#release(this.#gate);
  }

  async close(): Promise<void> {
    this.releaseAll();
    await this.#server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/capture-state"
    ) {
      await request.body?.cancel();
      return new Response(null, { status: 404 });
    }
    const scope = (await request.json()) as CaptureStateAdmissionScope;
    const gate = this.#gate;
    if (
      !gate ||
      gate.scope.kind !== scope.kind ||
      gate.scope.requestId !== scope.requestId ||
      gate.scope.threadId !== scope.threadId
    ) {
      return new Response(null, { status: 204 });
    }
    if (gate.released) return new Response(null, { status: 204 });
    if (gate.response) return new Response(null, { status: 409 });
    return new Promise<Response>((resolve) => {
      gate.response = resolve;
      gate.enter();
    });
  }

  #release(gate: Gate): void {
    if (gate.released) return;
    gate.released = true;
    if (this.#gate === gate) this.#gate = undefined;
    gate.response?.(new Response(null, { status: 204 }));
  }
}
