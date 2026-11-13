declare module "cloudflare:workers" {
  export interface DurableObjectState {
    id: { name?: string };
    storage: unknown;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
    waitUntil(promise: Promise<unknown>): void;
    abort(reason?: string): void;
  }

  export class DurableObject<Environment = unknown> {
    constructor(state: DurableObjectState, environment: Environment);
  }
}
