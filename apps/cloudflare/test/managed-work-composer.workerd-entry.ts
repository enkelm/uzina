import {
  composeManagedWorkBundleFromWorkspace,
  prepareManagedWorkBundleComposition,
} from "../../../packages/checkpoints/src/managed-work-composition";
import {
  R2BlobTransport,
  type ImmutableR2Bucket,
} from "../../../packages/checkpoints/src/r2";
import type { WorkspaceCheckpointManifest } from "../../../packages/checkpoints/src/index";

interface Environment {
  CHECKPOINTS: ImmutableR2Bucket;
}

interface CompositionRequest {
  managedWork: unknown;
  compatibilityRequirements?: string[];
  attachments?: Array<{ name: string; mediaType: string; bytes: number[] }>;
  workspaceManifest: WorkspaceCheckpointManifest;
  workspaceManifestReference: string;
  workspaceManifestBytes: number[];
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const r2 = new R2BlobTransport(environment.CHECKPOINTS);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/blob/")) {
      const reference = url.pathname.slice("/blob/".length);
      try {
        const bytes = await r2.getBlob(reference);
        const body = new Uint8Array(bytes.byteLength);
        body.set(bytes);
        return new Response(body.buffer);
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : "blob unavailable",
          },
          { status: 404 },
        );
      }
    }
    if (request.method !== "POST" || url.pathname !== "/compose") {
      return new Response("Not found", { status: 404 });
    }

    const input = (await request.json()) as CompositionRequest;
    const prepared = await prepareManagedWorkBundleComposition({
      managedWork: input.managedWork,
      compatibilityRequirements: input.compatibilityRequirements,
      attachments: input.attachments?.map((attachment) => ({
        ...attachment,
        bytes: new Uint8Array(attachment.bytes),
      })),
    });
    const writes: string[] = [];
    const transport = {
      async putBlob(bytes: Uint8Array): Promise<string> {
        const reference = await r2.putBlob(bytes);
        writes.push(reference);
        return reference;
      },
      async getBlob(): Promise<Uint8Array> {
        throw new Error("Worker composition must not read workspace blobs");
      },
    };
    const bundle = await composeManagedWorkBundleFromWorkspace({
      prepared,
      workspaceManifest: input.workspaceManifest,
      workspaceManifestReference: input.workspaceManifestReference,
      workspaceManifestBytes: new Uint8Array(input.workspaceManifestBytes),
      transport,
    });
    return Response.json({ bundle, writes });
  },
};
