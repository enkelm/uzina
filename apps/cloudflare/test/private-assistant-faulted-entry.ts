import { FactoryObject } from "../src/durable-objects";
import { ManagedWorkObject } from "../src/managed-work-object";
import {
  PrivateAssistantObject,
  type PrivateAssistantState,
  type PrivateAssistantWorkerEnvironment,
} from "../src/private-assistant-object";
import {
  PRIVATE_ASSISTANT_DURABLE_OBJECT_NAME,
  type FactoryRpc,
} from "../src/factory-object";
import worker, { type WorkerEnvironment } from "../src/worker";

export { FactoryObject, ManagedWorkObject };

const testWorker = {
  async fetch(
    request: Request,
    environment: WorkerEnvironment,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/private-assistant/recover") {
      const assistant = environment.PRIVATE_ASSISTANT.get(
        environment.PRIVATE_ASSISTANT.idFromName(
          PRIVATE_ASSISTANT_DURABLE_OBJECT_NAME,
        ),
      ) as unknown as PrivateAssistantTestRpc;
      const identityFailuresTriggered =
        await assistant.identityFailuresTriggered();
      await assistant.triggerRecoveryAlarm();
      return Response.json({ identityFailuresTriggered });
    }
    if (url.pathname === "/__test/private-assistant/close") {
      const assistant = environment.PRIVATE_ASSISTANT.get(
        environment.PRIVATE_ASSISTANT.idFromName(
          PRIVATE_ASSISTANT_DURABLE_OBJECT_NAME,
        ),
      ) as unknown as PrivateAssistantTestRpc;
      await assistant.closeForTestEviction();
      return Response.json({ closed: true });
    }
    return worker.fetch(request, environment);
  },
};

export default testWorker;

type PrivateAssistantTestRpc = {
  identityFailuresTriggered(): Promise<number>;
  triggerRecoveryAlarm(): Promise<void>;
  closeForTestEviction(): Promise<void>;
};

type IdentityProbeFault = { remaining: number; triggered: number };
const identityProbeFault: IdentityProbeFault = { remaining: 2, triggered: 0 };

/** Workerd test class that faults two real private-assistant /v1/me HTTP probes. */
export class FaultedPrivateAssistantObject extends PrivateAssistantObject {
  readonly #identityProbeFault: IdentityProbeFault;

  constructor(
    state: PrivateAssistantState,
    environment: PrivateAssistantWorkerEnvironment,
  ) {
    const faultedEnvironment: PrivateAssistantWorkerEnvironment = {
      ...environment,
      FACTORY: {
        idFromName: (name) => environment.FACTORY.idFromName(name),
        get(id) {
          const factory = environment.FACTORY.get(id);
          return new Proxy(factory, {
            get(target, property, receiver) {
              if (property === "factoryHttp") {
                return async (
                  request: Parameters<FactoryRpc["factoryHttp"]>[0],
                ) => {
                  if (
                    identityProbeFault.remaining > 0 &&
                    new URL(request.url).pathname === "/v1/me"
                  ) {
                    identityProbeFault.remaining -= 1;
                    identityProbeFault.triggered += 1;
                    return {
                      status: 503,
                      headers: { "content-type": "application/json" },
                      body: '{"error":"temporary_unavailable"}',
                    };
                  }
                  return target.factoryHttp(request);
                };
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    };
    super(state, faultedEnvironment);
    this.#identityProbeFault = identityProbeFault;
  }

  identityFailuresTriggered(): number {
    return this.#identityProbeFault.triggered;
  }

  triggerRecoveryAlarm(): Promise<void> {
    return super.alarm();
  }

  closeForTestEviction(): Promise<void> {
    return super.close();
  }
}
