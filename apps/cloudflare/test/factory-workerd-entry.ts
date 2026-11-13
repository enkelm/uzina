import type {
  FactoryDurableObjectEnvironment,
  FactoryRpc,
} from "../src/factory-object";
import { TestFactory, TestManagedWork } from "./workerd-entry";

export { TestFactory, TestManagedWork };

type FactoryNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): FactoryRpc;
};
type TestEnvironment = FactoryDurableObjectEnvironment & {
  FACTORY: FactoryNamespace;
};

export default {
  fetch(request: Request, environment: TestEnvironment): Promise<Response> {
    const id = environment.FACTORY.idFromName("factory-workerd-proof");
    return environment.FACTORY.get(id).fetch(request);
  },
};
