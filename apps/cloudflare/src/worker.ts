import { CONTRACT_VERSION, healthResponseSchema } from "@uzina/contracts";
import { FACTORY_DURABLE_OBJECT_NAME, type FactoryRpc } from "./factory-object";

export interface WorkerEnvironment {
  FACTORY: {
    idFromName(name: string): unknown;
    get(id: unknown): FactoryRpc;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const worker = {
  fetch(request: Request, environment: WorkerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Promise.resolve(
        json(
          healthResponseSchema.parse({
            contractVersion: CONTRACT_VERSION,
            status: "ok",
          }),
        ),
      );
    }
    const id = environment.FACTORY.idFromName(FACTORY_DURABLE_OBJECT_NAME);
    return environment.FACTORY.get(id).fetch(request);
  },
};

export default worker;
