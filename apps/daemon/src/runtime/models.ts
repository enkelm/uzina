import {
  ModelRuntime,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { redactProviderErrors } from "@uzina/pi-runtime/provider-errors";

/** Same native model/credential resolution as pi-coop: Pi auth.json, models.json and machine environment. */
export async function createLocalRuntimeOptions() {
  const environment = process.env;
  const cwd = process.cwd();
  const agentDir = environment.PI_CODING_AGENT_DIR ?? getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir);
  const models = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
  });
  // Redact the resolved key at request time, including refreshed OAuth access tokens.
  for (const provider of models.getProviders()) {
    models.registerNativeProvider(redactProviderErrors(provider));
  }
  const explicitProvider = environment.UZINA_MODEL_PROVIDER?.trim();
  const explicitModel = environment.UZINA_MODEL_ID?.trim();
  const provider = explicitProvider || settings.getDefaultProvider();
  const modelId = explicitModel || settings.getDefaultModel();
  const available = await models.getAvailable(explicitProvider);
  const preferred = available.find(
    (candidate) =>
      (!provider || candidate.provider === provider) &&
      (!modelId || candidate.id === modelId),
  );
  const model = explicitModel
    ? available.find((candidate) => candidate.id === explicitModel)
    : (preferred ??
      available.find((candidate) => candidate.id === "gpt-4o-mini") ??
      available[0]);
  if (!model) {
    throw new Error(
      "No usable local Pi model. Sign in with Pi or set a provider environment key; optionally select UZINA_MODEL_PROVIDER and UZINA_MODEL_ID.",
    );
  }
  return {
    models,
    agent: { model: { provider: model.provider, modelId: model.id } },
  };
}
