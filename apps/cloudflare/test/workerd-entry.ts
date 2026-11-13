import type { Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { FactoryObject, ManagedWorkRpcObject } from "../src/durable-objects";
import type { FactoryRpc } from "../src/factory-object";
import type { ManagedWorkFactoryBridge } from "../src/work-object";

let modelCalls = 0;
let readAlarm: () => Promise<number | null> = async () => null;
let firstModelAlarmArmed = false;
let recoveryModelAlarmArmed = false;

const model = {
  id: "fixed-model",
  name: "Fixed model",
  provider: "uzina-test",
  api: "uzina-test-api",
  baseUrl: "https://test.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 4096,
  maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const models = {
  getModel(provider: string, id: string) {
    return provider === model.provider && id === model.id ? model : undefined;
  },
  async getAuth() {
    return undefined;
  },
  stream() {
    return delayedResponse();
  },
  streamSimple() {
    return delayedResponse();
  },
} as unknown as Models;

function delayedResponse() {
  modelCalls += 1;
  const callNumber = modelCalls;
  const stream = createAssistantMessageEventStream();
  void readAlarm().then((alarm) => {
    if (callNumber === 1) {
      firstModelAlarmArmed = alarm !== null;
      return;
    }
    recoveryModelAlarmArmed = alarm !== null;
    if (recoveryModelAlarmArmed) {
      stream.end({
        role: "assistant",
        content: [{ type: "text", text: "recovered from workerd" }],
        api: "uzina-test-api",
        provider: "uzina-test",
        model: "fixed-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
  });
  return stream;
}

type State = ConstructorParameters<typeof ManagedWorkRpcObject>[0];
type FactoryState = ConstructorParameters<typeof FactoryObject>[0];

export class TestFactory extends FactoryObject {
  constructor(
    state: FactoryState,
    environment: ConstructorParameters<typeof FactoryObject>[1],
  ) {
    super(state, environment);
  }
}

type TestEnvironment = {
  FACTORY: {
    idFromName(name: string): unknown;
    get(id: unknown): FactoryRpc & ManagedWorkFactoryBridge;
  };
  MANAGED_WORK: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
};

export class TestManagedWork extends ManagedWorkRpcObject {
  private readonly alarmStorage: State["storage"];

  constructor(state: State, env: TestEnvironment) {
    super(state, env, {
      runtimeOptions: () => ({
        models,
        agent: { model: { provider: "uzina-test", modelId: "fixed-model" } },
      }),
      factory: () =>
        env.FACTORY.get(env.FACTORY.idFromName("uzina-single-factory")),
    });
    this.alarmStorage = state.storage;
    readAlarm = () => state.storage.getAlarm();
  }

  async alarm(): Promise<void> {
    await super.alarm();
  }

  async alarmTime() {
    await this.status();
    return this.alarmStorage.getAlarm();
  }

  resetObservations() {
    modelCalls = 0;
    firstModelAlarmArmed = false;
    recoveryModelAlarmArmed = false;
  }

  observations() {
    return { modelCalls, firstModelAlarmArmed, recoveryModelAlarmArmed };
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    let result: unknown;
    if (path === "/create") result = await this.create();
    else if (path === "/submit") {
      const body = (await request.json()) as {
        requestId: string;
        content: string;
      };
      result = await this.submit(body.requestId, body.content);
    } else if (path === "/status") result = await this.status();
    else if (path === "/alarm") result = await this.alarmTime();
    else if (path === "/reset") result = this.resetObservations();
    else if (path === "/observations") result = this.observations();
    else return new Response("not found", { status: 404 });
    return Response.json(result ?? null);
  }
}

export default {
  async fetch(request: Request, env: TestEnvironment): Promise<Response> {
    const id = env.MANAGED_WORK.idFromName("actual-workerd-managed-work");
    return env.MANAGED_WORK.get(id).fetch(request);
  },
};
