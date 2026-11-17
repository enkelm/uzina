import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { redactProviderErrors } from "./provider-errors";
import type { Models } from "@earendil-works/pi-ai";
import {
  managedApiKeyCredential,
  managedModelAuthContext,
  type ManagedModelConfig,
  type ManagedRuntimeEnvironment,
  readManagedModelConfig,
} from "./model-config";
export type { ManagedRuntimeEnvironment } from "./model-config";

const workerProviders = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
};

/** Cloudflare profiles use encrypted Worker secrets, never ambient machine credentials. */
export async function createWorkerConfiguredModels(
  config: ManagedModelConfig,
): Promise<Models> {
  if (
    !config.provider.trim() ||
    !config.modelId.trim() ||
    !config.apiKey.trim()
  ) {
    throw new Error(
      "Managed model provider, model ID, and API key are required",
    );
  }
  if (!Object.hasOwn(workerProviders, config.provider)) {
    throw new Error(
      "Cloudflare Workers support OpenAI, Anthropic and Google API-key provider profiles; other providers are unsupported",
    );
  }

  const credentials = new InMemoryCredentialStore();
  await credentials.modify(config.provider, async () =>
    managedApiKeyCredential(config.apiKey),
  );
  const models = createModels({
    credentials,
    authContext: managedModelAuthContext,
  });
  const provider =
    workerProviders[config.provider as keyof typeof workerProviders]();
  models.setProvider(redactProviderErrors(provider, config.apiKey));
  const model = models.getModel(config.provider, config.modelId);
  if (!model) {
    throw new Error("Configured model is not in the Worker Pi AI catalog");
  }
  const auth = await models.getAuth(model);
  if (!auth) {
    throw new Error("Configured Worker API-key credential is not usable");
  }
  return models;
}

export async function createWorkerManagedRuntimeOptions(
  environment: ManagedRuntimeEnvironment,
) {
  if (!environment.UZINA_PROVIDER_CREDENTIALS) {
    const config = readManagedModelConfig(environment);
    return {
      models: await createWorkerConfiguredModels(config),
      agent: { model: { provider: config.provider, modelId: config.modelId } },
    } as const;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(environment.UZINA_PROVIDER_CREDENTIALS);
  } catch {
    throw new Error(
      "UZINA_PROVIDER_CREDENTIALS must be a JSON provider credential map",
    );
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(
      "UZINA_PROVIDER_CREDENTIALS must be a JSON provider credential map",
    );
  }
  const credentials = new InMemoryCredentialStore();
  const models = createModels({
    credentials,
    authContext: managedModelAuthContext,
  });
  for (const [id, value] of Object.entries(stored)) {
    if (
      !Object.hasOwn(workerProviders, id) ||
      !value ||
      typeof value !== "object" ||
      value.type !== "api_key" ||
      typeof value.key !== "string" ||
      !value.key.trim()
    ) {
      throw new Error(
        "Worker credentials require a supported provider and an api_key credential; OAuth remains local-only",
      );
    }
    await credentials.modify(id, async () =>
      managedApiKeyCredential(value.key),
    );
    models.setProvider(
      redactProviderErrors(
        workerProviders[id as keyof typeof workerProviders](),
        value.key,
      ),
    );
  }
  const available = await models.getAvailable(environment.UZINA_MODEL_PROVIDER);
  const selected = environment.UZINA_MODEL_ID
    ? available.find((model) => model.id === environment.UZINA_MODEL_ID)
    : (available.find((model) => model.id === "gpt-4o-mini") ?? available[0]);
  if (!selected)
    throw new Error(
      "No usable Worker model for the stored provider credentials",
    );
  return {
    models,
    agent: { model: { provider: selected.provider, modelId: selected.id } },
  } as const;
}
