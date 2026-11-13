import {
  R2BlobTransport,
  type ImmutableR2Bucket,
} from "../../../packages/checkpoints/src/r2";

interface Environment {
  CHECKPOINTS: ImmutableR2Bucket;
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const transport = new R2BlobTransport(environment.CHECKPOINTS);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/put") {
      const reference = await transport.putBlob(
        new Uint8Array(await request.arrayBuffer()),
      );
      return Response.json({ reference });
    }
    if (request.method === "POST" && url.pathname.startsWith("/overwrite/")) {
      const reference = url.pathname.slice("/overwrite/".length);
      const inserted = await environment.CHECKPOINTS.put(
        reference,
        new Uint8Array([9, 9, 9]),
        { onlyIf: { etagDoesNotMatch: "*" } },
      );
      return Response.json({ inserted: inserted !== null });
    }
    if (request.method === "GET" && url.pathname.startsWith("/get/")) {
      try {
        const bytes = await transport.getBlob(
          url.pathname.slice("/get/".length),
        );
        return new Response(bytes.buffer as ArrayBuffer);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "R2 read failed" },
          { status: 500 },
        );
      }
    }
    return new Response("not found", { status: 404 });
  },
};
