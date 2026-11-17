import { test, expect } from "bun:test";
import { join } from "node:path";
import { Miniflare } from "./miniflare-test-support";
import { buildCloudflareWorkerArtifact } from "../scripts/build-worker";

test("additional Worker providers reach their real SDK transport and redact rejected secret bindings", async () => {
  const artifact = await buildCloudflareWorkerArtifact(
    join(import.meta.dir, "provider-workerd-entry.ts"),
  );
  for (const profile of [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      host: "api.anthropic.com",
      keyHeader: "x-api-key",
    },
    {
      provider: "google",
      modelId: "gemini-2.5-flash",
      host: "generativelanguage.googleapis.com",
      keyHeader: "x-goog-api-key",
    },
  ]) {
    const key = `dummy-worker-${profile.provider}-key`;
    const observed: { host: string; authenticated: boolean }[] = [];
    const worker = new Miniflare({
      name: "worker",
      script: artifact.script,
      modules: true,
      compatibilityDate: "2026-05-01",
      host: "127.0.0.1",
      port: 0,
      bindings: {
        UZINA_MODEL_PROVIDER: profile.provider,
        UZINA_MODEL_ID: profile.modelId,
        UZINA_PROVIDER_CREDENTIALS: JSON.stringify({
          [profile.provider]: { type: "api_key", key },
        }),
      },
      outboundService(request) {
        const url = new URL(request.url);
        observed.push({
          host: url.hostname,
          authenticated:
            request.headers.get(profile.keyHeader) === key ||
            url.searchParams.get("key") === key,
        });
        if (url.hostname !== profile.host)
          return new Response("Unexpected outbound request", { status: 599 });
        return Response.json(
          {
            type: "error",
            error: {
              code: 401,
              type: "authentication_error",
              status: "UNAUTHENTICATED",
              message: `Credential rejected: ${key}`,
            },
          },
          { status: 401 },
        );
      },
    });
    try {
      const response = await worker.dispatchFetch("http://uzina.test/model");
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        stopReason: string;
        errorMessage: string;
      };
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("401");
      expect(JSON.stringify(result)).not.toContain(key);
      expect(observed).toEqual([{ host: profile.host, authenticated: true }]);
    } finally {
      await worker.dispose();
    }
  }
}, 30_000);
