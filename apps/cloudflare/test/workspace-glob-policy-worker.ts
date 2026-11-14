import { portableWorkspaceBlobReferences } from "@uzina/checkpoints/portable";

interface ValidationRequest {
  manifest: unknown;
  manifestReference: string;
  manifestBytes: number;
}

const worker = {
  async fetch(request: Request): Promise<Response> {
    let body: ValidationRequest;
    try {
      body = (await request.json()) as ValidationRequest;
    } catch {
      return Response.json({ outcome: "invalid-request" }, { status: 400 });
    }
    try {
      const references = portableWorkspaceBlobReferences(
        body.manifest,
        body.manifestReference,
        body.manifestBytes,
      );
      return Response.json({
        outcome: "accepted",
        references: references.length,
      });
    } catch (error) {
      return Response.json(
        {
          outcome: "rejected",
          error:
            error instanceof Error ? error.message : "unknown validation error",
        },
        { status: 422 },
      );
    }
  },
};

export default worker;
