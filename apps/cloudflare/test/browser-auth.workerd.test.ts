import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "./miniflare-test-support";
import { buildCloudflareWorkerArtifact } from "../scripts/build-worker";
import { FACTORY_DURABLE_OBJECT_NAME } from "../src/factory-object";

test("Worker owner secret signs in without bootstrap and retains cookies across DO cold reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uzina-worker-sign-in-"));
  const artifact = await buildCloudflareWorkerArtifact();
  const token = "human_dummy_worker_owner_sign_in_token_32_chars";
  const options = {
    name: "worker",
    script: artifact.script,
    modules: true as const,
    compatibilityDate: "2026-05-01",
    host: "127.0.0.1",
    port: 0,
    durableObjectsPersist: directory,
    bindings: { UZINA_OWNER_TOKEN: token },
    durableObjects: {
      FACTORY: { className: "FactoryObject", useSQLite: true },
      MANAGED_WORK: { className: "ManagedWorkObject", useSQLite: true },
      PRIVATE_ASSISTANT: {
        className: "PrivateAssistantObject",
        useSQLite: true,
      },
    },
  };
  let worker = new Miniflare(options);
  try {
    // Direct DO fetch preserves HTTPS; Miniflare's HTTP ingress rewrites its URL scheme.
    const namespace = (await worker.getDurableObjectNamespace(
      "FACTORY",
    )) as unknown as {
      idFromName(name: string): unknown;
      get(id: unknown): { fetch(request: Request): Promise<Response> };
    };
    const factory = namespace.get(
      namespace.idFromName(FACTORY_DURABLE_OBJECT_NAME),
    );
    const login = await factory.fetch(
      new Request("https://uzina.test/login", {
        method: "POST",
        body: new URLSearchParams({ token }).toString(),
        redirect: "manual",
      }),
    );
    expect(login.status).toBe(303);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0]!;
    const me = await worker.dispatchFetch("https://uzina.test/v1/me", {
      headers: { cookie },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ participant: { role: "owner" } });
    await worker.dispose();
    worker = new Miniflare(options);
    const reopened = await worker.dispatchFetch("https://uzina.test/v1/me", {
      headers: { cookie },
    });
    expect(reopened.status).toBe(200);
    const credentials = await worker.dispatchFetch(
      "https://uzina.test/v1/credentials",
      { headers: { cookie } },
    );
    expect(
      ((await credentials.json()) as { credentials: unknown[] }).credentials,
    ).toHaveLength(1);
    const csrf = await worker.dispatchFetch(
      "https://uzina.test/v1/private-assistant/inputs",
      {
        method: "POST",
        headers: {
          cookie,
          origin: "https://other.invalid",
          "sec-fetch-site": "cross-site",
        },
        body: "{}",
      },
    );
    expect(csrf.status).toBe(403);
    const alternate = await worker.dispatchFetch(
      "https://uzina.test/v1/credentials",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ kind: "human", name: "Other owner device" }),
      },
    );
    const otherOwner = (await alternate.json()) as { credential: string };
    const originalMe = await worker.dispatchFetch("https://uzina.test/v1/me", {
      headers: { cookie },
    });
    const { credentialId } = (await originalMe.json()) as {
      credentialId: string;
    };
    const revoked = await worker.dispatchFetch(
      `https://uzina.test/v1/credentials/${credentialId}/revoke`,
      { method: "POST", headers: { cookie } },
    );
    expect(revoked.status).toBe(200);
    await worker.dispose();
    worker = new Miniflare(options);
    expect(
      (
        await worker.dispatchFetch("https://uzina.test/v1/me", {
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.dispatchFetch("https://uzina.test/v1/me", {
          headers: { authorization: `Bearer ${otherOwner.credential}` },
        })
      ).status,
    ).toBe(200);
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
