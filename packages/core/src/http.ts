import { CONTRACT_VERSION } from "@uzina/contracts";
import {
  bootstrapFactoryRequestSchema,
  createProjectRequestSchema,
  createThreadRequestSchema,
  createWorkspaceRequestSchema,
  discussionPostRequestSchema,
  invitationCreateRequestSchema,
  invitationRedeemRequestSchema,
  participantAccessRequestSchema,
  provisionCredentialRequestSchema,
  provisionNodeRequestSchema,
  submitInputRequestSchema,
} from "@uzina/contracts/factory";
import {
  executionClaimRequestSchema,
  executionClaimResponseSchema,
  executionHeartbeatRequestSchema,
  executionJobReportSchema,
  executionRegisterRequestSchema,
} from "@uzina/contracts/execution";
import { FactoryError, FactoryService } from "./factory";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function body<T>(
  request: Request,
  schema: { parse(value: unknown): T },
): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new FactoryError(
      400,
      "invalid_json",
      "Request body must be valid JSON",
    );
  }
  try {
    return schema.parse(value);
  } catch {
    throw new FactoryError(
      400,
      "invalid_request",
      "Request body does not match the route contract",
    );
  }
}

function bearer(request: Request, scheme = "Bearer"): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [providedScheme, ...value] = header.split(" ");
  if (providedScheme !== scheme || value.length !== 1 || !value[0]) return null;
  return value[0];
}

function numberParameter(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

export interface ManagedWorkQueries {
  context(threadId: string): Promise<unknown>;
  status(threadId: string): Promise<unknown>;
}

export function createFactoryHttpHandler(
  factory: FactoryService,
  managedWork?: ManagedWorkQueries,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ contractVersion: CONTRACT_VERSION, status: "ok" });
    }
    if (!url.pathname.startsWith("/v1/"))
      return json({ error: "not_found" }, 404);

    try {
      if (request.method === "POST" && url.pathname === "/v1/bootstrap") {
        const input = await body(request, bootstrapFactoryRequestSchema);
        const secret = bearer(request, "Bootstrap");
        if (!secret)
          throw new FactoryError(
            401,
            "unauthorized",
            "A configured private bootstrap credential is required",
          );
        const result = await factory.bootstrap(secret, input.name);
        return json({ contractVersion: CONTRACT_VERSION, ...result }, 201);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/invitations/redeem"
      ) {
        const input = await body(request, invitationRedeemRequestSchema);
        return json(
          {
            contractVersion: CONTRACT_VERSION,
            ...(await factory.redeemInvitation(input.code, input.displayName)),
          },
          201,
        );
      }

      const credential = bearer(request);
      if (!credential)
        throw new FactoryError(
          401,
          "unauthorized",
          "A valid active Bearer credential is required",
        );
      const session = await factory.authenticate(credential);
      const path = url.pathname;

      if (request.method === "GET" && path === "/v1/me")
        return json({
          contractVersion: CONTRACT_VERSION,
          actor: session.actor,
          participant: factory.currentParticipant(session),
        });
      if (request.method === "GET" && path === "/v1/projects")
        return json({
          contractVersion: CONTRACT_VERSION,
          projects: factory.listProjects(session),
        });
      if (request.method === "POST" && path === "/v1/projects") {
        const input = await body(request, createProjectRequestSchema);
        return json(
          factory.createProject(session, input.projectId, input.name),
          201,
        );
      }
      if (request.method === "GET" && path === "/v1/nodes")
        return json({
          contractVersion: CONTRACT_VERSION,
          nodes: factory.listNodes(session),
        });
      if (request.method === "POST" && path === "/v1/nodes") {
        const input = await body(request, provisionNodeRequestSchema);
        const result = await factory.provisionNode(
          session,
          input.nodeId,
          input.name,
        );
        return json(
          {
            contractVersion: CONTRACT_VERSION,
            node: result.node,
            credentialId: result.credential.credentialId,
            credentialName: result.credential.name,
            actor: result.credential.actor,
            credential: result.credential.credential,
          },
          201,
        );
      }
      if (request.method === "GET" && path === "/v1/workspaces")
        return json({
          contractVersion: CONTRACT_VERSION,
          workspaces: factory.listWorkspaces(session),
        });
      if (request.method === "POST" && path === "/v1/workspaces") {
        const input = await body(request, createWorkspaceRequestSchema);
        return json(
          factory.createWorkspace(
            session,
            input.workspaceId,
            input.nodeId,
            input.name,
          ),
          201,
        );
      }
      if (request.method === "GET" && path === "/v1/threads") {
        return json({
          contractVersion: CONTRACT_VERSION,
          threads: factory.listThreads(
            session,
            url.searchParams.get("projectId") ?? undefined,
          ),
        });
      }
      if (request.method === "POST" && path === "/v1/threads") {
        const input = await body(request, createThreadRequestSchema);
        return json(factory.createThread(session, input), 201);
      }
      const managedQueryMatch = path.match(
        /^\/v1\/threads\/([^/]+)\/(context|status)$/,
      );
      if (request.method === "GET" && managedQueryMatch) {
        const threadId = decodeURIComponent(managedQueryMatch[1]!);
        factory.getAuthorizedThread(session, threadId);
        if (!managedWork) {
          throw new FactoryError(503, "managed_runtime_unavailable");
        }
        const runtime =
          managedQueryMatch[2] === "context"
            ? await managedWork.context(threadId)
            : await managedWork.status(threadId);
        const currentThread = factory.getAuthorizedThread(session, threadId);
        return json({
          contractVersion: CONTRACT_VERSION,
          thread: currentThread,
          runtime,
        });
      }
      const inputMatch = path.match(/^\/v1\/threads\/([^/]+)\/inputs$/);
      if (request.method === "POST" && inputMatch) {
        const input = await body(request, submitInputRequestSchema);
        const receipt = await factory.submitInput(
          session,
          decodeURIComponent(inputMatch[1]!),
          input.requestId,
          input.text,
        );
        return json(receipt, 202);
      }
      const discussionMatch = path.match(
        /^\/v1\/threads\/([^/]+)\/discussion$/,
      );
      if (request.method === "GET" && discussionMatch) {
        return json({
          contractVersion: CONTRACT_VERSION,
          discussion: factory.listDiscussion(
            session,
            decodeURIComponent(discussionMatch[1]!),
          ),
        });
      }
      if (request.method === "POST" && discussionMatch) {
        const input = await body(request, discussionPostRequestSchema);
        return json(
          factory.postDiscussion(
            session,
            decodeURIComponent(discussionMatch[1]!),
            input.text,
          ),
          201,
        );
      }
      const receiptMatch = path.match(/^\/v1\/commands\/([^/]+)$/);
      if (request.method === "GET" && receiptMatch) {
        return json(
          factory.getReceipt(session, decodeURIComponent(receiptMatch[1]!)),
        );
      }
      if (request.method === "GET" && path === "/v1/events") {
        return json(
          factory.events(
            session,
            numberParameter(url.searchParams.get("after"), 0),
            numberParameter(url.searchParams.get("limit"), 100),
          ),
        );
      }
      if (request.method === "GET" && path === "/v1/people")
        return json({
          contractVersion: CONTRACT_VERSION,
          participants: factory.listParticipants(session),
        });
      if (request.method === "GET" && path === "/v1/invitations")
        return json({
          contractVersion: CONTRACT_VERSION,
          invitations: factory.listInvitations(session),
        });
      if (request.method === "POST" && path === "/v1/invitations") {
        const input = await body(request, invitationCreateRequestSchema);
        const created = await factory.createInvitation(session, input);
        return json({ contractVersion: CONTRACT_VERSION, ...created }, 201);
      }
      const invitationRevokeMatch = path.match(
        /^\/v1\/invitations\/([^/]+)\/revoke$/,
      );
      if (request.method === "POST" && invitationRevokeMatch) {
        factory.revokeInvitation(
          session,
          decodeURIComponent(invitationRevokeMatch[1]!),
        );
        return json({ contractVersion: CONTRACT_VERSION, status: "revoked" });
      }
      const participantAccessMatch = path.match(
        /^\/v1\/people\/([^/]+)\/access$/,
      );
      if (request.method === "PUT" && participantAccessMatch) {
        const input = await body(request, participantAccessRequestSchema);
        return json(
          factory.setParticipantAccess(
            session,
            decodeURIComponent(participantAccessMatch[1]!),
            input.role,
            input.grants,
          ),
        );
      }
      const participantRevokeMatch = path.match(
        /^\/v1\/people\/([^/]+)\/revoke$/,
      );
      if (request.method === "POST" && participantRevokeMatch) {
        factory.revokeParticipant(
          session,
          decodeURIComponent(participantRevokeMatch[1]!),
        );
        return json({ contractVersion: CONTRACT_VERSION, status: "revoked" });
      }
      if (request.method === "GET" && path === "/v1/credentials")
        return json({
          contractVersion: CONTRACT_VERSION,
          credentials: factory.listCredentials(session),
        });
      if (request.method === "POST" && path === "/v1/credentials") {
        const input = await body(request, provisionCredentialRequestSchema);
        const result = await factory.provisionCredential(
          session,
          input.kind,
          input.name,
        );
        return json({ contractVersion: CONTRACT_VERSION, ...result }, 201);
      }
      const revokeMatch = path.match(/^\/v1\/credentials\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revokeMatch) {
        await factory.revokeCredential(
          session,
          decodeURIComponent(revokeMatch[1]!),
        );
        return json({ contractVersion: CONTRACT_VERSION, status: "revoked" });
      }

      const registerMatch = path.match(/^\/v1\/nodes\/([^/]+)\/register$/);
      if (request.method === "POST" && registerMatch) {
        const input = await body(request, executionRegisterRequestSchema);
        if (input.nodeId !== decodeURIComponent(registerMatch[1]!)) {
          throw new FactoryError(403, "node_identity_mismatch");
        }
        return json(factory.registerExecutionNode(session, input));
      }
      const heartbeatMatch = path.match(/^\/v1\/nodes\/([^/]+)\/heartbeat$/);
      if (request.method === "POST" && heartbeatMatch) {
        const input = await body(request, executionHeartbeatRequestSchema);
        if (input.nodeId !== decodeURIComponent(heartbeatMatch[1]!)) {
          throw new FactoryError(403, "node_identity_mismatch");
        }
        return json(factory.heartbeatExecutionNode(session, input));
      }
      const claimMatch = path.match(/^\/v1\/nodes\/([^/]+)\/jobs\/claim$/);
      if (request.method === "POST" && claimMatch) {
        const input = await body(request, executionClaimRequestSchema);
        if (input.nodeId !== decodeURIComponent(claimMatch[1]!)) {
          throw new FactoryError(403, "node_identity_mismatch");
        }
        return json(
          executionClaimResponseSchema.parse({
            contractVersion: CONTRACT_VERSION,
            job: factory.claimExecutionJob(session, input.nodeId),
          }),
        );
      }
      const reportMatch = path.match(
        /^\/v1\/nodes\/([^/]+)\/jobs\/([^/]+)\/report$/,
      );
      if (request.method === "POST" && reportMatch) {
        const input = await body(request, executionJobReportSchema);
        return json(
          await factory.reportExecutionJob(
            session,
            decodeURIComponent(reportMatch[1]!),
            decodeURIComponent(reportMatch[2]!),
            input,
          ),
        );
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof FactoryError)
        return json(
          { error: error.code, message: error.message },
          error.status,
        );
      return json({ error: "internal_error" }, 500);
    }
  };
}
