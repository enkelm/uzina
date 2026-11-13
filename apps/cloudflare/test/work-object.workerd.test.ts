import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { describe, expect, test } from "bun:test";

type WorkerdId = { toString(): string };
type WorkerdNamespace = { idFromName(name: string): WorkerdId };

function waitFor(timeoutMs = 5_000) {
  const start = Date.now();
  return async (predicate: () => Promise<boolean>) => {
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for workerd Durable Object state");
  };
}

describe("Cloudflare ManagedWork in Miniflare workerd", () => {
  test("pre-arms recovery alarms and resumes a task after Durable Object eviction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-workerd-"));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "workerd-entry.ts")],
      outdir: directory,
      target: "browser",
      packages: "bundle",
      sourcemap: "none",
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs.map((log) => log.message),
        "Could not bundle the workerd test Worker",
      );
    }

    const miniflare = new Miniflare({
      name: "worker",
      script: await build.outputs[0]!.text(),
      modules: true,
      compatibilityDate: "2026-05-01",
      durableObjects: {
        MANAGED_WORK: { className: "TestManagedWork", useSQLite: true },
      },
    });
    const call = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await miniflare.dispatchFetch(
        `http://uzina.test/${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        },
      );
      if (!response.ok) {
        throw new Error(`Workerd RPC ${path} failed: ${await response.text()}`);
      }
      return response.json() as Promise<T>;
    };
    try {
      const namespace = (await miniflare.getDurableObjectNamespace(
        "MANAGED_WORK",
      )) as unknown as WorkerdNamespace;
      const id = namespace.idFromName("actual-workerd-managed-work");
      await call<number>("create");
      await call("reset");

      await call("submit", {
        requestId: "workerd-request-1",
        content: "continue after eviction",
      });
      const waitUntil = waitFor();
      const observations = () =>
        call<{
          modelCalls: number;
          firstModelAlarmArmed: boolean;
          recoveryModelAlarmArmed: boolean;
        }>("observations");
      await waitUntil(async () => (await observations()).modelCalls > 0);
      const whileRunning = await observations();
      expect(whileRunning.modelCalls).toBeGreaterThan(0);
      expect(whileRunning.firstModelAlarmArmed).toBe(true);
      expect(await call<number | null>("alarm")).not.toBeNull();

      await miniflare.unsafeEvictDurableObject("worker", "TestManagedWork", {
        id: id.toString(),
      });
      await waitUntil(async () => (await observations()).modelCalls > 1);
      await waitUntil(
        async () => (await observations()).recoveryModelAlarmArmed,
      );
      const recovered = await observations();
      expect(recovered.modelCalls).toBeGreaterThan(1);
      expect(recovered.recoveryModelAlarmArmed).toBe(true);
      await waitUntil(async () => {
        const status = await call<{
          context: { messages: readonly unknown[] };
        }>("status");
        return status.context.messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "role" in message &&
            message.role === "assistant",
        );
      });
      const finalStatus = await call<{
        context: { messages: readonly unknown[] };
      }>("status");
      expect(finalStatus.context.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "recovered from workerd" }],
      });
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
