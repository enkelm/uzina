import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cloudflareDirectory = resolve(scriptDirectory, "..");
const productionEntrypoint = join(cloudflareDirectory, "src/index.ts");
const piAiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
const piAiDist = dirname(piAiEntry);
const piAiPackage = JSON.parse(
  await readFile(join(piAiDist, "../package.json"), "utf8"),
) as { version?: string };
const expectedPiAiVersion = "1.4.0";
if (piAiPackage.version !== expectedPiAiVersion) {
  throw new Error(
    `Cloudflare provider compatibility is pinned to Pi AI ${expectedPiAiVersion}; found ${piAiPackage.version ?? "unknown"}`,
  );
}

const authContextPath = join(piAiDist, "auth/context.js");
const oauthLoadPath = join(piAiDist, "auth/oauth/load.js");
const authContextSource = await readFile(authContextPath, "utf8");
const oauthLoadSource = await readFile(oauthLoadPath, "utf8");
if (
  !authContextSource.includes("defaultProviderAuthContext") ||
  !oauthLoadSource.includes("loadOpenAIChatGPTOAuth") ||
  !oauthLoadSource.includes("registerBundledOAuthFlowLoaders")
) {
  throw new Error(
    "Pi AI host-auth modules no longer match the reviewed Cloudflare compatibility contract",
  );
}

const replaced = new Set<string>();
const compatibilityPlugin: Bun.BunPlugin = {
  name: "uzina-cloudflare-pi-ai-auth-compatibility",
  setup(build) {
    build.onResolve(
      { filter: /^(?:\.\/auth\/context\.js|\.\.\/auth\/oauth\/load\.js)$/ },
      (args) => {
        const target = resolve(dirname(args.importer), args.path);
        const replacement =
          target === authContextPath
            ? join(cloudflareDirectory, "worker-compat/auth-context.ts")
            : target === oauthLoadPath
              ? join(cloudflareDirectory, "worker-compat/oauth-load.ts")
              : undefined;
        if (!replacement) return;
        replaced.add(target);
        return { path: replacement };
      },
    );
  },
};

export interface CloudflareWorkerArtifact {
  path: string;
  script: string;
}

let buildPromise: Promise<CloudflareWorkerArtifact> | undefined;

/** Production and test entrypoints share the reviewed Worker compatibility bundle. */
export function buildCloudflareWorkerArtifact(
  entrypoint = productionEntrypoint,
): Promise<CloudflareWorkerArtifact> {
  if (entrypoint !== productionEntrypoint) {
    return buildWorkerArtifact(entrypoint);
  }
  buildPromise ??= buildWorkerArtifact(productionEntrypoint);
  return buildPromise;
}

async function buildWorkerArtifact(
  entrypoint: string,
): Promise<CloudflareWorkerArtifact> {
  const outdir = join(cloudflareDirectory, "build");
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    packages: "bundle",
    external: ["cloudflare:workers"],
    sourcemap: "none",
    plugins: [compatibilityPlugin],
  });
  if (!result.success) {
    throw new AggregateError(
      result.logs.map((log) => log.message),
      "Could not build the compatibility-bundled Cloudflare Worker",
    );
  }
  if (!replaced.has(authContextPath) || !replaced.has(oauthLoadPath)) {
    throw new Error(
      "Expected Pi AI Worker auth and OAuth modules were not replaced; refusing an unreviewed bundle",
    );
  }
  const output = result.outputs.find((file) => file.path.endsWith(".js"));
  if (!output)
    throw new Error("Cloudflare compatibility bundle has no JavaScript entry");
  return { path: output.path, script: await output.text() };
}

if (import.meta.main) {
  const artifact = await buildCloudflareWorkerArtifact();
  console.log(`Built Cloudflare Worker compatibility bundle: ${artifact.path}`);
}
