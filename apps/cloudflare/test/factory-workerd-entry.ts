import {
  FactoryObject,
  type FactoryDurableObjectEnvironment,
} from "../src/factory-object";

type FactoryState = ConstructorParameters<typeof FactoryObject>[0];
type FactoryNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};
type TestEnvironment = FactoryDurableObjectEnvironment & {
  FACTORY: FactoryNamespace;
};

export class TestFactory extends FactoryObject {
  constructor(
    state: FactoryState,
    environment: FactoryDurableObjectEnvironment,
  ) {
    super(state, environment);
  }
}

export default {
  fetch(request: Request, environment: TestEnvironment): Promise<Response> {
    const id = environment.FACTORY.idFromName("factory-workerd-proof");
    return environment.FACTORY.get(id).fetch(request);
  },
};
