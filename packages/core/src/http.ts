import { CONTRACT_VERSION } from "@uzina/contracts";
import {
  assistantCredentialGrantsRequestSchema,
  bootstrapFactoryRequestSchema,
  captureControlAdmissionRequestSchema,
  createProjectRequestSchema,
  createThreadRequestSchema,
  createWorkspaceRequestSchema,
  discussionPostRequestSchema,
  invitationCreateRequestSchema,
  invitationRedeemRequestSchema,
  participantAccessRequestSchema,
  provisionCredentialRequestSchema,
  provisionNodeRequestSchema,
  privateAssistantInputRequestSchema,
  submitInputRequestSchema,
  workspaceSnapshotRequestSchema,
  managedWorkCheckpointRequestSchema,
  workspaceSnapshotClaimRequestSchema,
  workspaceSnapshotClaimResponseSchema,
  workspaceSnapshotReportSchema,
} from "@uzina/contracts/factory";
import {
  executionCaptureControlClaimRequestSchema,
  executionCaptureControlClaimResponseSchema,
  executionCaptureControlReportSchema,
  executionClaimRequestSchema,
  executionClaimResponseSchema,
  executionHeartbeatRequestSchema,
  executionJobReportSchema,
  executionRegisterRequestSchema,
} from "@uzina/contracts/execution";
import { FactoryError, FactoryService } from "./factory";
import { createFactoryMcpHandler } from "./mcp";
import {
  verifyPublishedWorkspaceManifest,
  type WorkspaceSnapshotStorage,
} from "./snapshot-storage";
import type { ManagedWorkCheckpointPrivateStorage } from "./managed-work-checkpoint-verification";

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
  exportCheckpoint?(request: {
    captureId: string;
    captureRequestId: string;
    threadId: string;
  }): Promise<unknown>;
}

export interface PrivateAssistantQueries {
  context(): Promise<unknown>;
  status(): Promise<unknown>;
  receipt(inputId: string): Promise<unknown>;
  submit(inputId: string, text: string): Promise<unknown>;
}

export function createFactoryHttpHandler(
  factory: FactoryService,
  managedWork?: ManagedWorkQueries,
  privateAssistant?: PrivateAssistantQueries,
  snapshotStorage?: WorkspaceSnapshotStorage,
  checkpointPrivateStorage?: (
    requestId: string,
  ) => Pick<ManagedWorkCheckpointPrivateStorage, "getBlobStream">,
): (request: Request) => Promise<Response> {
  const mcp = createFactoryMcpHandler(factory, managedWork);
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ contractVersion: CONTRACT_VERSION, status: "ok" });
    }
    if (url.pathname === "/v1/mcp") return mcp(request);
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
          credentialId: session.credentialId,
          actor: session.actor,
          participant: factory.currentParticipant(session),
        });
      if (path.startsWith("/v1/private-assistant/")) {
        factory.requirePrivateAssistantOwner(session);
        if (!privateAssistant)
          throw new FactoryError(503, "private_assistant_unavailable");
        if (request.method === "GET" && path === "/v1/private-assistant/status")
          return json(await privateAssistant.status());
        if (
          request.method === "GET" &&
          path === "/v1/private-assistant/context"
        )
          return json(await privateAssistant.context());
        const receiptMatch = path.match(
          /^\/v1\/private-assistant\/receipts\/([^/]+)$/,
        );
        if (request.method === "GET" && receiptMatch)
          return json(
            await privateAssistant.receipt(
              decodeURIComponent(receiptMatch[1]!),
            ),
          );
        if (
          request.method === "POST" &&
          path === "/v1/private-assistant/inputs"
        ) {
          const input = await body(request, privateAssistantInputRequestSchema);
          return json(
            await privateAssistant.submit(input.inputId, input.text),
            202,
          );
        }
        return json({ error: "not_found" }, 404);
      }
      if (request.method === "GET" && path === "/v1/projects")
        return json({
          contractVersion: CONTRACT_VERSION,
          projects: factory.listProjects(
            session,
            numberParameter(url.searchParams.get("limit"), 100),
          ),
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
          nodes: factory.listNodes(
            session,
            numberParameter(url.searchParams.get("limit"), 100),
          ),
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
          workspaces: factory.listWorkspaces(
            session,
            numberParameter(url.searchParams.get("limit"), 100),
          ),
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
            numberParameter(url.searchParams.get("limit"), 100),
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
      const managedWorkCheckpointAdmissionMatch = path.match(
        /^\/v1\/threads\/([^/]+)\/managed-work-checkpoints$/,
      );
      if (request.method === "POST" && managedWorkCheckpointAdmissionMatch) {
        if (!managedWork?.exportCheckpoint || !checkpointPrivateStorage) {
          throw new FactoryError(
            503,
            "managed_work_checkpoint_assembly_unavailable",
          );
        }
        const input = await body(request, managedWorkCheckpointRequestSchema);
        return json(
          await factory.requestManagedWorkCheckpoint(
            session,
            decodeURIComponent(managedWorkCheckpointAdmissionMatch[1]!),
            input,
          ),
          202,
        );
      }
      const managedWorkCheckpointStatusMatch = path.match(
        /^\/v1\/managed-work-checkpoints\/([^/]+)$/,
      );
      if (request.method === "GET" && managedWorkCheckpointStatusMatch) {
        return json(
          await factory.getManagedWorkCheckpointStatus(
            session,
            decodeURIComponent(managedWorkCheckpointStatusMatch[1]!),
          ),
        );
      }
      const managedWorkCheckpointBlobMatch = path.match(
        /^\/v1\/managed-work-checkpoints\/([^/]+)\/blobs\/([a-f0-9]{64})$/,
      );
      if (request.method === "GET" && managedWorkCheckpointBlobMatch) {
        const requestId = decodeURIComponent(
          managedWorkCheckpointBlobMatch[1]!,
        );
        const reference = managedWorkCheckpointBlobMatch[2]!;
        const authorized = await factory.getAuthorizedManagedWorkCheckpointBlob(
          session,
          requestId,
          reference,
        );
        let blob: { size: number; body: ReadableStream<Uint8Array> } | null;
        if (authorized.scope === "private") {
          if (!checkpointPrivateStorage) {
            throw new FactoryError(
              503,
              "managed_work_checkpoint_storage_unavailable",
            );
          }
          blob =
            await checkpointPrivateStorage(requestId).getBlobStream(reference);
        } else {
          if (!snapshotStorage) {
            throw new FactoryError(
              503,
              "workspace_snapshot_storage_unavailable",
            );
          }
          blob = await snapshotStorage.getBlob(authorized.captureId, reference);
        }
        if (!blob || blob.size !== authorized.size) {
          await blob?.body.cancel().catch(() => {});
          throw new FactoryError(404, "managed_work_checkpoint_blob_not_found");
        }
        return new Response(blob.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(blob.size),
            "cache-control": "private, no-store",
            "x-content-sha256": reference,
          },
        });
      }
      const captureAdmissionMatch = path.match(
        /^\/v1\/threads\/([^/]+)\/capture-controls$/,
      );
      if (request.method === "POST" && captureAdmissionMatch) {
        const input = await body(request, captureControlAdmissionRequestSchema);
        return json(
          await factory.requestCaptureControl(
            session,
            decodeURIComponent(captureAdmissionMatch[1]!),
            input,
          ),
          202,
        );
      }
      const snapshotBlobUploadMatch = path.match(
        /^\/v1\/nodes\/([^/]+)\/captures\/([^/]+)\/blobs\/([a-f0-9]{64})$/,
      );
      if (request.method === "PUT" && snapshotBlobUploadMatch) {
        const nodeId = decodeURIComponent(snapshotBlobUploadMatch[1]!);
        const captureId = decodeURIComponent(snapshotBlobUploadMatch[2]!);
        const reference = snapshotBlobUploadMatch[3]!;
        if (
          !factory.authorizeWorkspaceSnapshotUpload(session, nodeId, captureId)
        ) {
          await request.body?.cancel();
          throw new FactoryError(404, "workspace_snapshot_not_found");
        }
        if (!snapshotStorage || !request.body) {
          await request.body?.cancel();
          throw new FactoryError(503, "workspace_snapshot_storage_unavailable");
        }
        const rawLength = request.headers.get("content-length");
        const declaredSize = rawLength === null ? null : Number(rawLength);
        if (
          declaredSize !== null &&
          (!Number.isSafeInteger(declaredSize) ||
            declaredSize < 0 ||
            declaredSize > 512 * 1024 * 1024)
        ) {
          await request.body.cancel();
          throw new FactoryError(413, "workspace_blob_size_limit");
        }
        await snapshotStorage.putBlob(
          captureId,
          reference,
          request.body,
          declaredSize,
        );
        return new Response(null, { status: 204 });
      }
      const snapshotBlobDownloadMatch = path.match(
        /^\/v1\/workspace-snapshots\/([^/]+)\/blobs\/([a-f0-9]{64})$/,
      );
      if (request.method === "GET" && snapshotBlobDownloadMatch) {
        if (!snapshotStorage) {
          throw new FactoryError(503, "workspace_snapshot_storage_unavailable");
        }
        const requestId = decodeURIComponent(snapshotBlobDownloadMatch[1]!);
        const status = factory.getWorkspaceSnapshotStatus(session, requestId);
        const references = factory.getAuthorizedWorkspaceSnapshotBlobReferences(
          session,
          status.captureId,
        );
        const reference = snapshotBlobDownloadMatch[2]!;
        if (!references.includes(reference)) {
          throw new FactoryError(404, "workspace_checkpoint_blob_not_found");
        }
        const blob = await snapshotStorage.getBlob(status.captureId, reference);
        if (!blob)
          throw new FactoryError(404, "workspace_checkpoint_blob_not_found");
        return new Response(blob.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(blob.size),
            "cache-control": "private, no-store",
            "x-content-sha256": reference,
          },
        });
      }
      if (request.method === "POST" && path === "/v1/workspace-snapshots") {
        const input = await body(request, workspaceSnapshotRequestSchema);
        return json(factory.requestWorkspaceSnapshot(session, input), 202);
      }
      const workspaceSnapshotStatusMatch = path.match(
        /^\/v1\/workspace-snapshots\/([^/]+)$/,
      );
      if (request.method === "GET" && workspaceSnapshotStatusMatch) {
        return json(
          factory.getWorkspaceSnapshotStatus(
            session,
            decodeURIComponent(workspaceSnapshotStatusMatch[1]!),
          ),
        );
      }
      const captureStatusMatch = path.match(
        /^\/v1\/capture-controls\/([^/]+)$/,
      );
      if (request.method === "GET" && captureStatusMatch) {
        return json(
          factory.getCaptureControlStatus(
            session,
            decodeURIComponent(captureStatusMatch[1]!),
          ),
        );
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
      const runsMatch = path.match(/^\/v1\/threads\/([^/]+)\/runs$/);
      if (request.method === "GET" && runsMatch) {
        return json({
          contractVersion: CONTRACT_VERSION,
          threadId: decodeURIComponent(runsMatch[1]!),
          runs: factory.listThreadReceipts(
            session,
            decodeURIComponent(runsMatch[1]!),
            numberParameter(url.searchParams.get("limit"), 100),
          ),
        });
      }
      const lifecycleMatch = path.match(
        /^\/v1\/threads\/([^/]+)\/lifecycle-capabilities$/,
      );
      if (request.method === "GET" && lifecycleMatch) {
        return json(
          factory.getLifecycleCapabilities(
            session,
            decodeURIComponent(lifecycleMatch[1]!),
          ),
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
          input.assistantGrants,
        );
        return json({ contractVersion: CONTRACT_VERSION, ...result }, 201);
      }
      const credentialGrantsMatch = path.match(
        /^\/v1\/credentials\/([^/]+)\/grants$/,
      );
      if (request.method === "PUT" && credentialGrantsMatch) {
        const input = await body(
          request,
          assistantCredentialGrantsRequestSchema,
        );
        return json({
          contractVersion: CONTRACT_VERSION,
          ...factory.setAssistantCredentialGrants(
            session,
            decodeURIComponent(credentialGrantsMatch[1]!),
            input.grants,
          ),
        });
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
      const captureControlClaimMatch = path.match(
        /^\/v1\/nodes\/([^/]+)\/capture-controls\/claim$/,
      );
      if (request.method === "POST" && captureControlClaimMatch) {
        const input = await body(
          request,
          executionCaptureControlClaimRequestSchema,
        );
        if (input.nodeId !== decodeURIComponent(captureControlClaimMatch[1]!)) {
          throw new FactoryError(403, "node_identity_mismatch");
        }
        return json(
          executionCaptureControlClaimResponseSchema.parse({
            contractVersion: CONTRACT_VERSION,
            control: factory.claimCaptureControl(session, input),
          }),
        );
      }
      const workspaceSnapshotClaimMatch = path.match(
        /^\/v1\/nodes\/([^/]+)\/workspace-snapshots\/claim$/,
      );
      if (request.method === "POST" && workspaceSnapshotClaimMatch) {
        const input = await body(request, workspaceSnapshotClaimRequestSchema);
        if (
          input.nodeId !== decodeURIComponent(workspaceSnapshotClaimMatch[1]!)
        ) {
          throw new FactoryError(403, "node_identity_mismatch");
        }
        return json(
          workspaceSnapshotClaimResponseSchema.parse({
            contractVersion: CONTRACT_VERSION,
            snapshot: factory.claimWorkspaceSnapshot(session, input),
          }),
        );
      }
      const workspaceSnapshotReportMatch = path.match(
        /^\/v1\/nodes\/([^/]+)\/workspace-snapshots\/([^/]+)\/report$/,
      );
      if (request.method === "POST" && workspaceSnapshotReportMatch) {
        const input = await body(request, workspaceSnapshotReportSchema);
        const nodeId = decodeURIComponent(workspaceSnapshotReportMatch[1]!);
        const snapshotId = decodeURIComponent(workspaceSnapshotReportMatch[2]!);
        let verifiedBlobs: { reference: string; size: number }[] = [];
        if (input.status === "workspace-checkpoint-available") {
          try {
            return json(
              await factory.reportWorkspaceSnapshot(
                session,
                nodeId,
                snapshotId,
                input,
              ),
            );
          } catch (error) {
            if (
              !(error instanceof FactoryError) ||
              error.code !== "workspace_snapshot_integrity_unverified"
            ) {
              throw error;
            }
          }
          if (!snapshotStorage || !input.manifestReference) {
            throw new FactoryError(
              503,
              "workspace_snapshot_storage_unavailable",
            );
          }
          try {
            verifiedBlobs = await verifyPublishedWorkspaceManifest(
              snapshotStorage,
              input.captureId,
              input.manifestReference,
            );
          } catch {
            throw new FactoryError(
              422,
              "workspace_checkpoint_integrity_failed",
              "Workspace checkpoint failed bounded manifest or object integrity checks",
            );
          }
        }
        return json(
          await factory.reportWorkspaceSnapshot(
            session,
            nodeId,
            snapshotId,
            input,
            verifiedBlobs,
          ),
        );
      }
      const captureControlReportMatch = path.match(
        /^\/v1\/nodes\/([^/]+)\/capture-controls\/([^/]+)\/report$/,
      );
      if (request.method === "POST" && captureControlReportMatch) {
        const input = await body(request, executionCaptureControlReportSchema);
        return json(
          await factory.reportCaptureControl(
            session,
            decodeURIComponent(captureControlReportMatch[1]!),
            decodeURIComponent(captureControlReportMatch[2]!),
            input,
          ),
        );
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
      return json({ error: "internal_error" }, 500);
    }
  };
}
