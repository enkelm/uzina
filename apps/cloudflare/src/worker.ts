import { CONTRACT_VERSION, healthResponseSchema } from "@uzina/contracts";
import {
  assertBrowserOrigin,
  requestCredential,
} from "@uzina/core/browser-auth";
import { privateAssistantInputRequestSchema } from "@uzina/contracts/factory";
import {
  FACTORY_DURABLE_OBJECT_NAME,
  PRIVATE_ASSISTANT_DURABLE_OBJECT_NAME,
  type FactoryRpc,
  type PrivateAssistantRpc,
} from "./factory-object";

export interface WorkerEnvironment {
  FACTORY: {
    idFromName(name: string): unknown;
    get(id: unknown): FactoryRpc;
  };
  PRIVATE_ASSISTANT: {
    idFromName(name: string): unknown;
    get(id: unknown): PrivateAssistantRpc;
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

function privateAssistantFailure(error: unknown): Response {
  if (
    error &&
    typeof error === "object" &&
    "httpStatus" in error &&
    "code" in error &&
    typeof error.httpStatus === "number" &&
    typeof error.code === "string" &&
    error.code.startsWith("private_assistant_")
  ) {
    return json({ error: error.code }, error.httpStatus);
  }
  return json({ error: "private_assistant_unavailable" }, 503);
}

async function privateAssistantRequest(
  request: Request,
  environment: WorkerEnvironment,
): Promise<Response> {
  try {
    assertBrowserOrigin(request);
  } catch {
    return json({ error: "cross_site_request" }, 403);
  }
  const credential = requestCredential(request);
  if (!credential) return json({ error: "unauthorized" }, 401);
  try {
    const factory = environment.FACTORY.get(
      environment.FACTORY.idFromName(FACTORY_DURABLE_OBJECT_NAME),
    );
    const authorization = await factory.authorizePrivateAssistant(credential);
    if (!authorization.authorized) {
      return json({ error: authorization.code }, authorization.status);
    }
    const expectedSession = request.headers.get("x-uzina-session");
    if (
      !request.headers.has("authorization") &&
      expectedSession &&
      expectedSession !== authorization.credentialId
    ) {
      return json({ error: "session_changed" }, 401);
    }
    const assistant = environment.PRIVATE_ASSISTANT.get(
      environment.PRIVATE_ASSISTANT.idFromName(
        PRIVATE_ASSISTANT_DURABLE_OBJECT_NAME,
      ),
    );
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === "/v1/private-assistant/status"
    ) {
      return json(await assistant.status());
    }
    if (
      request.method === "GET" &&
      url.pathname === "/v1/private-assistant/context"
    ) {
      return json(await assistant.context());
    }
    const receiptMatch = url.pathname.match(
      /^\/v1\/private-assistant\/receipts\/([^/]+)$/,
    );
    if (request.method === "GET" && receiptMatch) {
      const inputId = decodeURIComponent(receiptMatch[1]!);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(inputId)) {
        return json({ error: "invalid_request" }, 400);
      }
      return json(await assistant.receipt(inputId));
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/private-assistant/inputs"
    ) {
      let value: unknown;
      try {
        value = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const input = privateAssistantInputRequestSchema.safeParse(value);
      if (!input.success) return json({ error: "invalid_request" }, 400);
      return json(
        await assistant.submit(input.data.inputId, input.data.text),
        202,
      );
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    return privateAssistantFailure(error);
  }
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
    if (url.pathname.startsWith("/v1/private-assistant/")) {
      return privateAssistantRequest(request, environment);
    }
    const id = environment.FACTORY.idFromName(FACTORY_DURABLE_OBJECT_NAME);
    return environment.FACTORY.get(id).fetch(request);
  },
};

export default worker;
