import { FactoryObject } from "../src/durable-objects";
import { ManagedWorkObject } from "../src/managed-work-object";
import {
  PrivateAssistantObject,
  type PrivateAssistantState,
  type PrivateAssistantWorkerEnvironment,
} from "../src/private-assistant-object";
import worker from "../src/worker";

export { FactoryObject, ManagedWorkObject };
export default worker;

/** Observes host-delivered alarms without changing the production alarm path. */
export class ObservedPrivateAssistantObject extends PrivateAssistantObject {
  #alarmInvocations = 0;

  constructor(
    state: PrivateAssistantState,
    environment: PrivateAssistantWorkerEnvironment,
  ) {
    super(state, environment);
  }

  override async alarm(): Promise<void> {
    this.#alarmInvocations += 1;
    await super.alarm();
  }

  alarmInvocations(): number {
    return this.#alarmInvocations;
  }
}
