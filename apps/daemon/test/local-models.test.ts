import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("local runtime reuses Pi settings and machine credentials without a Factory model key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uzina-local-models-"));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  try {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "gpt-4o-mini",
      }),
    );
    const modulePath = resolve(import.meta.dir, "../src/runtime/models.ts");
    // Clean child environment prevents accidentally consulting the operator's real sign-ins.
    const run = async (env: Record<string, string> = {}) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `import { createLocalRuntimeOptions } from ${JSON.stringify(modulePath)}; const { models, agent } = await createLocalRuntimeOptions(); const auth = await models.getAuth(agent.model.provider); console.log(JSON.stringify({ model: agent.model, configured: !!auth, source: auth?.source }));`,
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH!,
            HOME: directory,
            PI_CODING_AGENT_DIR: agentDir,
            ...env,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(status, stderr).toBe(0);
      expect(stdout).not.toContain("dummy-local-key");
      return JSON.parse(stdout);
    };
    const ambient = await run({ OPENAI_API_KEY: "dummy-local-key-from-env" });
    expect(ambient).toMatchObject({
      model: { provider: "openai", modelId: "gpt-4o-mini" },
      configured: true,
      source: "OPENAI_API_KEY",
    });
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", key: "dummy-local-key-from-pi" },
      }),
      { mode: 0o600 },
    );
    const stored = await run();
    expect(stored).toMatchObject({
      model: { provider: "openai", modelId: "gpt-4o-mini" },
      configured: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
