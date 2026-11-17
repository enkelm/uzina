// Adapted from pi-coop src/server/auth.ts and http/sign-in.ts (MIT).
// Keep bearer API clients separate from browser sessions; both use live Core grants.
import { FactoryError, type FactoryService } from "./factory";

const COOKIE = "uzina_auth";

export function requestCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header !== null) return /^Bearer ([^\s]+)$/.exec(header)?.[1] ?? null;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (part.slice(0, index).trim() !== COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Bun reconstructs request.url with its backend address; Vite preserves the browser Host. */
function browserOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (!host) return url.origin;
  let external: URL;
  try {
    external = new URL(`${url.protocol}//${host}`);
  } catch {
    throw new FactoryError(400, "invalid_host");
  }
  if (
    external.username ||
    external.password ||
    external.pathname !== "/" ||
    external.search ||
    external.hash
  )
    throw new FactoryError(400, "invalid_host");
  return external.origin;
}

/** Cookie requests cannot use a cross-site form/fetch to mutate Factory state. */
export function assertBrowserOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.has("authorization")) return;
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (
    (site !== null && site !== "same-origin" && site !== "none") ||
    (origin !== null &&
      origin !== browserOrigin(request) &&
      // no-referrer sign-in pages cause browsers to send Origin: null on forms.
      !(origin === "null" && site === "same-origin"))
  )
    throw new FactoryError(403, "cross_site_request");
}

function cookie(request: Request, token: string): string {
  return [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${token ? 60 * 60 * 24 * 365 : 0}`,
    ...(new URL(request.url).protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function page(title: string, content: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Uzina</title><style>body{font:1rem/1.6 system-ui;color:#172e32;background:#edf2f2;margin:0}main{max-width:28rem;margin:4rem auto;padding:2rem}input,select,button{font:inherit;padding:.6rem;display:block;margin:.75rem 0}input,select{max-width:100%;box-sizing:border-box}a{color:#123f3c;overflow-wrap:anywhere}label{display:block;margin-top:1.2rem}button{background:#123f3c;color:white;border:0;border-radius:.25rem;cursor:pointer}button:hover{background:#0a302e}:focus-visible{outline:2px solid #123f3c;outline-offset:3px}::selection{background:#c9dfdc}input{caret-color:#123f3c}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`,
    {
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    },
  );
}

function signedIn(request: Request, token: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...headers,
      location: "/",
      "set-cookie": cookie(request, token),
    },
  });
}

async function formText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const bytes = new Uint8Array(10_000);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > bytes.length - length) {
        void reader.cancel().catch(() => {});
        throw new FactoryError(413, "request_too_large");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally {
    reader.releaseLock();
  }
}

/** Passwordless sign-in and single-use sharing, using Uzina's persisted identities. */
export async function browserAuth(
  factory: FactoryService,
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (
    !["/login", "/sharing", "/v1/auth/logout"].includes(url.pathname) &&
    !url.pathname.startsWith("/join/")
  )
    return;
  if (request.method !== "GET" && request.method !== "POST")
    return new Response(null, { status: 405, headers });
  assertBrowserOrigin(request);
  if (url.pathname === "/v1/auth/logout") {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers });
    return new Response(null, {
      status: 204,
      headers: { ...headers, "set-cookie": cookie(request, "") },
    });
  }
  // Bound the form before parsing. Do not let sign-in links accept arbitrary API bodies.
  const text = request.method === "POST" ? await formText(request) : "";
  const form =
    request.method === "POST" ? new URLSearchParams(text) : url.searchParams;
  if (url.pathname === "/sharing") {
    const session = await factory.authenticate(requestCredential(request));
    factory.requirePrivateAssistantOwner(session);
    let created = "";
    if (request.method === "POST") {
      if (form.get("action") === "revoke-person") {
        factory.revokeParticipant(session, form.get("id") ?? "");
      } else if (form.get("action") === "revoke-invite") {
        factory.revokeInvitation(session, form.get("id") ?? "");
      } else {
        const scope = form.get("scope") ?? "";
        const separator = scope.indexOf("|");
        const minutes = Number(form.get("minutes") ?? 15);
        if (![15, 60, 1440, 10080].includes(minutes))
          throw new FactoryError(400, "invalid_invitation_expiry");
        const result = await factory.createInvitation(session, {
          role: form.get("role") as "guest" | "viewer",
          grants: [
            {
              type: scope.slice(0, separator) as "project" | "thread",
              resourceId: scope.slice(separator + 1),
            },
          ],
          expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
        });
        const link = new URL(
          `/join/${encodeURIComponent(result.code)}`,
          browserOrigin(request),
        ).href;
        created = `<section><h2>Invitation ready</h2><p>Share this single-use link. It expires ${escapeHtml(result.invitation.expiresAt)}.</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p></section>`;
      }
    }
    const projects = factory.listProjects(session);
    const threads = factory.listThreads(session);
    const scopes = [
      ...projects.map(
        (project) =>
          `<option value="project|${escapeHtml(project.projectId)}">Project: ${escapeHtml(project.name)}</option>`,
      ),
      ...threads
        .filter((thread) => !thread.ownerPrivate)
        .map(
          (thread) =>
            `<option value="thread|${escapeHtml(thread.threadId)}">Work item: ${escapeHtml(thread.title)}</option>`,
        ),
    ].join("");
    const invites = factory
      .listInvitations(session)
      .filter(
        (invite) =>
          !invite.redeemedAt &&
          !invite.revokedAt &&
          Date.parse(invite.expiresAt) > Date.now(),
      );
    const people = factory
      .listParticipants(session)
      .filter((person) => person.role !== "owner" && !person.revokedAt);
    const revoke = (action: string, id: string, label: string) =>
      `<form method="post"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${escapeHtml(id)}"><button aria-label="${escapeHtml(label)}">Revoke</button></form>`;
    return page(
      "Sharing",
      `<p><a href="/">Back to Factory</a></p>${created}<h2>Invite someone</h2><p>Guests can steer agents and run commands. Viewers can read and discuss. Neither can change access.</p>${scopes ? `<form method="post"><label for="role">Access</label><select id="role" name="role"><option value="viewer">Viewer — read and discuss</option><option value="guest">Guest — steer agents</option></select><label for="scope">Share</label><select id="scope" name="scope">${scopes}</select><label for="minutes">Expires in</label><select id="minutes" name="minutes"><option value="15">15 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option><option value="10080">1 week</option></select><button>Create invitation</button></form><p>Shows the first 100 projects and Work items. Invitations grant only the selected scope.</p>` : "<p>Create a project before inviting someone.</p>"}<h2>People</h2>${people.length ? people.map((person) => `<section><p>${escapeHtml(person.displayName)} · ${person.role}</p>${revoke("revoke-person", person.userId, `Revoke access for ${person.displayName}`)}</section>`).join("") : "<p>No participants yet.</p>"}<h2>Pending invitations</h2>${invites.length ? invites.map((invite) => `<section><p>${invite.role} · expires ${escapeHtml(invite.expiresAt)}</p>${revoke("revoke-invite", invite.invitationId, "Revoke invitation")}</section>`).join("") : "<p>No pending invitations.</p>"}`,
    );
  }
  if (url.pathname === "/login") {
    const token = form.get("token") ?? "";
    const session = await factory.authenticate(token);
    if (session.actor.kind !== "human")
      throw new FactoryError(403, "human_sign_in_required");
    if (request.method === "POST") return signedIn(request, token);
    // Like pi-coop's account-switch confirmation, but always require a tap. GET never signs in.
    return page(
      "Sign in to your Factory",
      `<p>This device will sign in with the access in this link.</p><form method="post" action="/login"><input type="hidden" name="token" value="${escapeHtml(token)}"><button>Sign in</button></form><p><a href="/">Cancel</a></p>`,
    );
  }
  const code = decodeURIComponent(url.pathname.slice("/join/".length));
  const grant = await factory.invitationGrant(code);
  if (request.method === "POST") {
    const redeemed = await factory.redeemInvitation(
      code,
      form.get("name")?.replace(/\s+/g, " ").trim().slice(0, 40) || "Guest",
    );
    return signedIn(request, redeemed.credential);
  }
  const access =
    grant.role === "viewer"
      ? "read shared work and take part in discussion, but not steer agents"
      : "read and steer shared work. Agents can run commands on the selected machine";
  return page(
    "Join this Factory",
    `<p>You can ${access}. Access is limited to the projects or Work items in this invitation.</p><p>Each invitation works once, until it expires. Joining replaces this browser’s current sign-in.</p><form method="post"><label>Your name<input name="name" maxlength="40" autocomplete="name" required autofocus></label><button>Join Factory</button></form>`,
  );
}
