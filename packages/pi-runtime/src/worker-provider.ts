import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
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

/** Cloudflare profile: real OpenAI Responses API with a stored API-key credential only. */
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
  if (config.provider !== "openai") {
    throw new Error(
      "Cloudflare Workers support only the OpenAI API-key provider profile; other providers are unsupported",
    );
  }

  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () =>
    managedApiKeyCredential(config.apiKey),
  );
  const models = createModels({
    credentials,
    authContext: managedModelAuthContext,
  });
  models.setProvider(redactProviderErrors(openaiProvider(), config.apiKey));
  const model = models.getModel("openai", config.modelId);
  if (!model) {
    throw new Error("Configured model is not in the OpenAI Pi AI catalog");
  }
  const auth = await models.getAuth(model);
  if (!auth) {
    throw new Error("Configured OpenAI API-key credential is not usable");
  }
  return models;
}

export async function createWorkerManagedRuntimeOptions(
  environment: ManagedRuntimeEnvironment,
) {
  const config = readManagedModelConfig(environment);
  return {
    models: await createWorkerConfiguredModels(config),
    agent: { model: { provider: config.provider, modelId: config.modelId } },
  } as const;
}
