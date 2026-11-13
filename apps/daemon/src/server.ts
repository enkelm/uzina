import {
  CONTRACT_VERSION,
  actorIdentitySchema,
  healthResponseSchema,
  identityResponseSchema,
} from "@uzina/contracts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleDaemonRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json(
      healthResponseSchema.parse({
        contractVersion: CONTRACT_VERSION,
        status: "ok",
      }),
    );
  }

  if (request.method === "POST" && url.pathname === "/identity") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_identity" }, 400);
    }

    const parsed = actorIdentitySchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_identity" }, 400);

    return json(
      identityResponseSchema.parse({
        contractVersion: CONTRACT_VERSION,
        actor: parsed.data,
      }),
    );
  }

  return json({ error: "not_found" }, 404);
}

export function createDaemonServer(
  port = 8788,
  hostname = "127.0.0.1",
): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port, hostname, fetch: handleDaemonRequest });
}
