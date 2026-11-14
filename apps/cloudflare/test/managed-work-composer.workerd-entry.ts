import {
  composeManagedWorkBundleFromWorkspace,
  prepareManagedWorkBundleComposition,
} from "../../../packages/checkpoints/src/managed-work-composition";
import type { WorkspaceCheckpointManifest } from "../../../packages/checkpoints/src/index";
import { R2ManagedWorkCheckpointStorage } from "../src/managed-work-checkpoint-storage";
import {
  R2WorkspaceSnapshotStorage,
  type R2WorkspaceBucket,
} from "../src/snapshot-storage";

interface Environment {
  CHECKPOINTS: R2WorkspaceBucket;
}

interface CompositionRequest {
  requestId: string;
  managedWork: unknown;
  compatibilityRequirements?: string[];
  attachments?: Array<{ name: string; mediaType: string; bytes: number[] }>;
  workspaceManifest: WorkspaceCheckpointManifest;
  workspaceManifestReference: string;
  workspaceManifestBytes: number[];
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    const workspaceStorage = new R2WorkspaceSnapshotStorage(
      environment.CHECKPOINTS,
    );
    const sourceUpload = url.pathname.match(
      /^\/source\/([^/]+)\/([a-f0-9]{64})$/,
    );
    if (request.method === "PUT" && sourceUpload && request.body) {
      try {
        const size = await workspaceStorage.putBlob(
          decodeURIComponent(sourceUpload[1]!),
          sourceUpload[2]!,
          request.body,
          Number(request.headers.get("content-length")),
        );
        return Response.json({ size });
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error ? error.message : "source upload failed",
          },
          { status: 400 },
        );
      }
    }

    const sourceProbe = url.pathname.match(
      /^\/source-probe\/([^/]+)\/([a-f0-9]{64})$/,
    );
    if (request.method === "GET" && sourceProbe) {
      const object = await workspaceStorage.getBlob(
        decodeURIComponent(sourceProbe[1]!),
        sourceProbe[2]!,
      );
      await object?.body.cancel();
      return Response.json({ found: object !== null });
    }

    const compose = url.pathname === "/compose" && request.method === "POST";
    if (compose) {
      const input = (await request.json()) as CompositionRequest;
      const privateStorage = new R2ManagedWorkCheckpointStorage(
        environment.CHECKPOINTS,
        input.requestId,
      );
      const prepared = await prepareManagedWorkBundleComposition({
        managedWork: input.managedWork,
        compatibilityRequirements: input.compatibilityRequirements,
        attachments: input.attachments?.map((attachment) => ({
          ...attachment,
          bytes: new Uint8Array(attachment.bytes),
        })),
      });
      const bundle = await composeManagedWorkBundleFromWorkspace({
        prepared,
        workspaceManifest: input.workspaceManifest,
        workspaceManifestReference: input.workspaceManifestReference,
        workspaceManifestBytes: new Uint8Array(input.workspaceManifestBytes),
        transport: privateStorage,
      });
      return Response.json({
        bundle,
        privateBlobs: await privateStorage.listBlobs(),
      });
    }

    const privateList = url.pathname.match(/^\/private-list\/([^/]+)$/);
    if (request.method === "GET" && privateList) {
      const storage = new R2ManagedWorkCheckpointStorage(
        environment.CHECKPOINTS,
        decodeURIComponent(privateList[1]!),
      );
      return Response.json(await storage.listBlobs());
    }

    const privateBlob = url.pathname.match(/^\/blob\/([^/]+)\/([a-f0-9]{64})$/);
    if (request.method === "GET" && privateBlob) {
      try {
        const storage = new R2ManagedWorkCheckpointStorage(
          environment.CHECKPOINTS,
          decodeURIComponent(privateBlob[1]!),
        );
        const bytes = await storage.getBlob(privateBlob[2]!);
        return new Response(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
          {
            headers: { "content-type": "application/octet-stream" },
          },
        );
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : "blob unavailable",
          },
          { status: 404 },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
