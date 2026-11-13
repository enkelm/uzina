import {
  createWorkerManagedRuntimeOptions,
  type ManagedRuntimeEnvironment,
} from "@uzina/pi-runtime/worker-provider";
import {
  FACTORY_DURABLE_OBJECT_NAME,
  type FactoryDurableObjectEnvironment,
} from "./factory-object";
import { ManagedWorkRpcObject } from "./durable-objects";
import type { ManagedWorkState } from "./work-object";

export type ManagedWorkDurableEnvironment = FactoryDurableObjectEnvironment &
  ManagedRuntimeEnvironment;

/** Production binding: real Pi AI provider configuration plus the trusted Factory RPC bridge. */
export class ManagedWorkObject extends ManagedWorkRpcObject {
  constructor(
    state: ManagedWorkState,
    environment: ManagedWorkDurableEnvironment,
  ) {
    super(state, environment, {
      runtimeOptions: () => createWorkerManagedRuntimeOptions(environment),
      factory: () =>
        environment.FACTORY.get(
          environment.FACTORY.idFromName(FACTORY_DURABLE_OBJECT_NAME),
        ),
    });
  }
}
