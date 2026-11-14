import {
  digestReadableStream,
  portableWorkspaceBlobReferences,
  PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
  PORTABLE_WORKSPACE_MAX_FILES,
} from "@uzina/checkpoints/portable";

export interface StoredWorkspaceBlob {
  size: number;
  body: ReadableStream<Uint8Array>;
}

/** Capture-scoped binary storage; object keys are never globally addressable. */
export interface WorkspaceSnapshotStorage {
  putBlob(
    captureId: string,
    reference: string,
    body: ReadableStream<Uint8Array>,
    declaredSize: number | null,
  ): Promise<number>;
  getBlob(
    captureId: string,
    reference: string,
  ): Promise<StoredWorkspaceBlob | null>;
  listBlobs(
    captureId: string,
  ): Promise<readonly { reference: string; size: number }[]>;
}

export async function verifyPublishedWorkspaceManifest(
  storage: WorkspaceSnapshotStorage,
  captureId: string,
  manifestReference: string,
): Promise<Array<{ reference: string; size: number }>> {
  const storedManifest = await storage.getBlob(captureId, manifestReference);
  if (
    !storedManifest ||
    storedManifest.size > PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES
  ) {
    throw new Error("Workspace manifest is unavailable or oversized");
  }
  const manifestBytes = await readBounded(
    storedManifest.body,
    PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES,
  );
  if (manifestBytes.byteLength !== storedManifest.size) {
    throw new Error("Workspace manifest size mismatch");
  }
  const manifestDigest = await digestBytes(manifestBytes);
  if (manifestDigest !== manifestReference) {
    throw new Error("Workspace manifest digest mismatch");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
    );
  } catch {
    throw new Error("Workspace manifest is malformed JSON");
  }
  const references = portableWorkspaceBlobReferences(
    manifest,
    manifestReference,
    manifestBytes.byteLength,
  );
  if (references.length > PORTABLE_WORKSPACE_MAX_FILES + 3) {
    throw new Error("Workspace checkpoint has too many references");
  }
  let aggregate = 0;
  for (const reference of references) {
    aggregate += reference.size;
    if (
      aggregate >
      PORTABLE_WORKSPACE_TOTAL_MAX_BYTES + PORTABLE_WORKSPACE_MANIFEST_MAX_BYTES
    ) {
      throw new Error("Workspace checkpoint exceeds aggregate storage limit");
    }
    const object = await storage.getBlob(captureId, reference.reference);
    if (!object || object.size !== reference.size) {
      throw new Error(
        "Workspace checkpoint has a missing or incorrectly sized object",
      );
    }
    const integrity = await digestReadableStream(
      object.body,
      PORTABLE_WORKSPACE_TOTAL_MAX_BYTES,
    );
    if (
      integrity.reference !== reference.reference ||
      integrity.size !== reference.size
    ) {
      throw new Error(
        "Workspace checkpoint object failed content integrity verification",
      );
    }
  }
  const actual = [...(await storage.listBlobs(captureId))].sort(byReference);
  const expected = [...references].sort(byReference);
  if (
    actual.length !== expected.length ||
    actual.some(
      (blob, index) =>
        blob.reference !== expected[index]?.reference ||
        blob.size !== expected[index]?.size,
    )
  ) {
    throw new Error(
      "Workspace checkpoint object references do not match the manifest exactly",
    );
  }
  return references;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) throw new Error("Blob exceeds its byte limit");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return (await digestReadableStream(stream, bytes.byteLength)).reference;
}

function byReference(
  left: { reference: string; size: number },
  right: { reference: string; size: number },
): number {
  return left.reference.localeCompare(right.reference);
}
