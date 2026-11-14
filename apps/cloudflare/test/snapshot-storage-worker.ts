import {
  R2WorkspaceSnapshotStorage,
  type R2WorkspaceBucket,
} from "../src/snapshot-storage";

interface Environment {
  CHECKPOINTS: R2WorkspaceBucket;
}
const worker = {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const storage = new R2WorkspaceSnapshotStorage(environment.CHECKPOINTS);
    const path = new URL(request.url).pathname;
    const upload = path.match(/^\/upload\/([^/]+)\/([a-f0-9]{64})$/);
    if (request.method === "PUT" && upload && request.body) {
      try {
        const size = await storage.putBlob(
          decodeURIComponent(upload[1]!),
          upload[2]!,
          request.body,
          request.headers.has("content-length")
            ? Number(request.headers.get("content-length"))
            : null,
        );
        return Response.json({ size });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "unknown" },
          { status: 500 },
        );
      }
    }
    const list = path.match(/^\/list\/([^/]+)$/);
    if (request.method === "GET" && list) {
      try {
        return Response.json(
          await storage.listBlobs(decodeURIComponent(list[1]!)),
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "unknown" },
          { status: 500 },
        );
      }
    }
    return new Response(null, { status: 404 });
  },
};
export default worker;
