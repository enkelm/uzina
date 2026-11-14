import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import {
  FactoryController,
  type FactoryDurableObjectEnvironment,
  type FactoryDurableObjectState,
} from "../src/factory-object";

const MAX_RESPONSE_BYTES = 256 * 1024;
const CHUNK_BYTES = 16 * 1024;
const OVERSIZED_REMAINDER_CHUNKS = 64;

type FixtureName = "empty" | "small" | "at-limit" | "oversized" | "read-error";

type ResponseProbe = {
  request: {
    url: string;
    method: string;
    authorization: string;
    fixtureHeader: string;
  };
  pullCalls: number;
  producedBytes: number;
  totalBytes: number;
  totalChunks: number;
  cancelled: boolean;
};

class StreamedResponseFactoryController extends FactoryController {
  readonly #probes = new Map<FixtureName, ResponseProbe>();
  readonly #responses = new Map<FixtureName, Response>();

  override async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).pathname.split("/").at(-1) as FixtureName;
    if (
      name !== "empty" &&
      name !== "small" &&
      name !== "at-limit" &&
      name !== "oversized" &&
      name !== "read-error"
    ) {
      return super.fetch(request);
    }

    const fixture = responseFixture(name);
    const probe: ResponseProbe = {
      request: {
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization") ?? "",
        fixtureHeader: request.headers.get("x-fixture") ?? "",
      },
      pullCalls: 0,
      producedBytes: 0,
      totalBytes: fixture.totalBytes,
      totalChunks: fixture.totalChunks,
      cancelled: false,
    };
    this.#probes.set(name, probe);

    let nextChunk = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          probe.pullCalls += 1;
          if (name === "read-error" && nextChunk === 1) {
            controller.error(new Error("fixture response stream failed"));
            return;
          }
          const chunk = fixture.chunk(nextChunk++);
          if (chunk === undefined) {
            controller.close();
            return;
          }
          probe.producedBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          probe.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, {
      status: name === "at-limit" ? 202 : 201,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-fixture-response": name,
      },
    });
    this.#responses.set(name, response);
    return response;
  }

  responseProbe(name: FixtureName) {
    const probe = this.#probes.get(name);
    if (!probe) throw new Error(`No response probe for ${name}`);
    const bodyLocked = this.#responses.get(name)?.body?.locked ?? false;
    this.#responses.delete(name);
    return {
      ...probe,
      request: { ...probe.request },
      bodyLocked,
    };
  }
}

function responseFixture(name: FixtureName): {
  totalBytes: number;
  totalChunks: number;
  chunk(index: number): Uint8Array | undefined;
} {
  const encoder = new TextEncoder();
  if (name === "empty") {
    return { totalBytes: 0, totalChunks: 0, chunk: () => undefined };
  }
  if (name === "small") {
    const bytes = encoder.encode('{"value":"café"}');
    const split = bytes.indexOf(0xc3) + 1;
    const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
    return {
      totalBytes: bytes.byteLength,
      totalChunks: chunks.length,
      chunk: (index) => chunks[index],
    };
  }
  if (name === "at-limit") {
    const expected = `{"value":"${"a".repeat(MAX_RESPONSE_BYTES - 15)}€"}`;
    const bytes = encoder.encode(expected);
    const split = bytes.indexOf(0xe2) + 1;
    const chunks = [
      bytes.subarray(0, split),
      bytes.subarray(split, split + 1),
      bytes.subarray(split + 1),
    ];
    return {
      totalBytes: bytes.byteLength,
      totalChunks: chunks.length,
      chunk: (index) => chunks[index],
    };
  }
  if (name === "oversized") {
    const totalChunks =
      MAX_RESPONSE_BYTES / CHUNK_BYTES + 1 + OVERSIZED_REMAINDER_CHUNKS;
    return {
      totalBytes:
        MAX_RESPONSE_BYTES + 1 + OVERSIZED_REMAINDER_CHUNKS * CHUNK_BYTES,
      totalChunks,
      chunk: (index) => {
        if (index < MAX_RESPONSE_BYTES / CHUNK_BYTES) {
          return new Uint8Array(CHUNK_BYTES).fill(0x61);
        }
        if (index === MAX_RESPONSE_BYTES / CHUNK_BYTES) {
          return Uint8Array.of(0x62);
        }
        if (index < totalChunks) return new Uint8Array(CHUNK_BYTES).fill(0x63);
        return undefined;
      },
    };
  }
  const bytes = encoder.encode("partial");
  return {
    totalBytes: bytes.byteLength,
    totalChunks: 1,
    chunk: (index) => (index === 0 ? bytes : undefined),
  };
}

export class FactoryHttpRpcProbeObject extends DurableObject<FactoryDurableObjectEnvironment> {
  readonly #controller: StreamedResponseFactoryController;

  constructor(
    state: FactoryDurableObjectState,
    environment: FactoryDurableObjectEnvironment,
  ) {
    super(state as unknown as DurableObjectState, environment);
    this.#controller = new StreamedResponseFactoryController(
      state,
      environment,
    );
  }

  factoryHttp(input: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  }) {
    return this.#controller.factoryHttp(input);
  }

  responseProbe(name: FixtureName) {
    return this.#controller.responseProbe(name);
  }
}

type FactoryHttpProbeEnvironment = {
  FACTORY: {
    idFromName(name: string): unknown;
    get(id: unknown): FactoryHttpRpcProbeObject;
  };
};

export default {
  async fetch(
    request: Request,
    environment: FactoryHttpProbeEnvironment,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    const factory = environment.FACTORY.get(
      environment.FACTORY.idFromName("factory-http-rpc"),
    );
    if (path[0] === "__factory-http" && path[1]) {
      try {
        const method = request.method === "POST" ? "POST" : "GET";
        const response = await factory.factoryHttp({
          url: `https://uzina-factory.internal/v1/test-response/${path[1]}`,
          method,
          headers: {
            authorization: request.headers.get("authorization") ?? "",
            ...(request.headers.has("x-fixture")
              ? { "x-fixture": request.headers.get("x-fixture")! }
              : {}),
          },
          ...(method === "POST" ? { body: await request.text() } : {}),
        });
        return Response.json(response);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }
    if (path[0] === "__response-probe" && path[1]) {
      return Response.json(await factory.responseProbe(path[1] as FixtureName));
    }
    return new Response("not found", { status: 404 });
  },
};
