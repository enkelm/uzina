import { test, expect } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStandaloneFactoryServer } from "../src/factory/standalone";
import { deterministicModels } from "../../../packages/pi-runtime/test-support/deterministic-model";
import { FactoryClient } from "@uzina/client";

test("native owner links survive restart; cookie sharing is single-use, scoped and revocable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uzina-browser-auth-"));
  const options = {
    databasePath: join(directory, "factory.sqlite"),
    runtimeDirectory: join(directory, "runtime"),
    models: deterministicModels().models,
    modelProvider: "uzina-test",
    modelId: "fixed-model",
    port: 0,
  };
  let host = await createStandaloneFactoryServer(options);
  try {
    const signIn = host.ownerSignInPath!;
    const login = await fetch(new URL(signIn, host.server.url));
    expect(login.headers.get("set-cookie")).toBeNull(); // GET cannot switch accounts.
    expect(login.headers.get("referrer-policy")).toBe("no-referrer");
    const token = new URL(signIn, host.server.url).searchParams.get("token")!;
    const ownerLogin = await fetch(new URL("/login", host.server.url), {
      method: "POST",
      body: new URLSearchParams({ token }),
      redirect: "manual",
    });
    expect(ownerLogin.status).toBe(303);
    const ownerCookie = ownerLogin.headers.get("set-cookie")!;
    expect(ownerCookie).toContain("HttpOnly");
    expect(ownerCookie).toContain("SameSite=Lax");
    expect(
      (await stat(`${options.databasePath}.owner-token`)).mode & 0o777,
    ).toBe(0o600);
    const owner = { cookie: ownerCookie.split(";")[0]! };
    let currentCookie = owner.cookie;
    const browserClient = new FactoryClient({
      baseUrl: host.server.url,
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set("cookie", currentCookie);
        return fetch(request);
      },
    });
    await browserClient.me();
    const anotherOwner = await host.factory.provisionCredential(
      await host.factory.authenticate(token),
      "human",
      "Other browser device",
    );
    currentCookie = `uzina_auth=${anotherOwner.credential}`;
    await expect(
      browserClient.createProject("Wrong browser session"),
    ).rejects.toMatchObject({ status: 401, code: "session_changed" });
    const createProject = async (name: string) => {
      const response = await fetch(new URL("/v1/projects", host.server.url), {
        method: "POST",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { projectId: string }).projectId;
    };
    const sharedId = await createProject("Shared");
    await createProject("Private");
    const share = await fetch(new URL("/sharing", host.server.url), {
      method: "POST",
      headers: owner,
      body: new URLSearchParams({
        role: "viewer",
        scope: `project|${sharedId}`,
        minutes: "15",
      }),
    });
    expect(share.status).toBe(200);
    const code = /\/join\/([^"<]+)/.exec(await share.text())![1]!;
    const preview = await fetch(new URL(`/join/${code}`, host.server.url));
    expect(await preview.text()).toContain("not steer agents");
    const joinResponse = await fetch(
      new URL(`/join/${code}`, host.server.url),
      {
        method: "POST",
        body: new URLSearchParams({ name: "A viewer" }),
        redirect: "manual",
      },
    );
    expect(joinResponse.status).toBe(303);
    const viewer = {
      cookie: joinResponse.headers.get("set-cookie")!.split(";")[0]!,
    };
    expect(
      (await fetch(new URL(`/join/${code}`, host.server.url))).status,
    ).toBe(404);
    const projects = await fetch(new URL("/v1/projects", host.server.url), {
      headers: viewer,
    });
    expect(
      (
        (await projects.json()) as { projects: { projectId: string }[] }
      ).projects.map((project) => project.projectId),
    ).toEqual([sharedId]);
    expect(
      (await fetch(new URL("/sharing", host.server.url), { headers: viewer }))
        .status,
    ).toBe(403);
    const me = await fetch(new URL("/v1/me", host.server.url), {
      headers: viewer,
    });
    const identity = (await me.json()) as { participant: { userId: string } };
    const revoke = await fetch(new URL("/sharing", host.server.url), {
      method: "POST",
      headers: owner,
      body: new URLSearchParams({
        action: "revoke-person",
        id: identity.participant.userId,
      }),
    });
    expect(revoke.status).toBe(200);
    expect(
      (await fetch(new URL("/v1/me", host.server.url), { headers: viewer }))
        .status,
    ).toBe(401);
    const logout = await fetch(new URL("/v1/auth/logout", host.server.url), {
      method: "POST",
      headers: owner,
    });
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const ownerSession = await host.factory.authenticate(token);
    const assistant = host.factory
      .listCredentials(ownerSession)
      .find((credential) => credential.actor.kind === "assistant")!;
    expect(assistant).toBeDefined();
    host.factory.revokeCredential(ownerSession, assistant.credentialId);
    await host.close();
    host = await createStandaloneFactoryServer(options);
    expect(host.ownerSignInPath).toBe(signIn);
    const privateStatus = await fetch(
      new URL("/v1/private-assistant/status", host.server.url),
      { headers: owner },
    );
    expect(await privateStatus.json()).toMatchObject({
      available: false,
      state: "parked",
    });
    expect(
      host.factory
        .listCredentials(ownerSession)
        .filter((credential) => credential.actor.kind === "assistant"),
    ).toHaveLength(1);
    expect(
      (await fetch(new URL("/v1/me", host.server.url), { headers: owner }))
        .status,
    ).toBe(200);
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser mutations reject cross-site login, logout and Factory writes; bearer APIs still work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uzina-browser-csrf-"));
  const host = await createStandaloneFactoryServer({
    databasePath: join(directory, "factory.sqlite"),
    runtimeDirectory: join(directory, "runtime"),
    models: deterministicModels().models,
    modelProvider: "uzina-test",
    modelId: "fixed-model",
    port: 0,
  });
  try {
    const token = new URL(
      host.ownerSignInPath!,
      host.server.url,
    ).searchParams.get("token")!;
    for (const path of ["/login", "/v1/auth/logout", "/v1/projects"]) {
      const response = await fetch(new URL(path, host.server.url), {
        method: "POST",
        headers: {
          cookie: `uzina_auth=${token}`,
          origin: "https://other.invalid",
          "sec-fetch-site": "cross-site",
        },
        body: new URLSearchParams({ token }),
        redirect: "manual",
      });
      expect(response.status).toBe(403);
    }
    const authenticated = await fetch(
      new URL("/v1/projects", host.server.url),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "API client" }),
      },
    );
    expect(authenticated.status).toBe(201);
    const node = await host.factory.provisionNode(
      await host.factory.authenticate(token),
      undefined,
      "Test node",
    );
    const nonhuman = await fetch(new URL("/login", host.server.url), {
      method: "POST",
      body: new URLSearchParams({ token: node.credential.credential }),
      redirect: "manual",
    });
    expect(nonhuman.status).toBe(403);
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
