import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  managedApiKeyCredential,
  managedModelAuthContext,
  type ManagedModelConfig,
  type ManagedRuntimeEnvironment,
  readManagedModelConfig,
} from "./model-config";

export type ManagedModels = Models;
export type {
  ManagedModelConfig,
  ManagedRuntimeEnvironment,
} from "./model-config";
export { readManagedModelConfig } from "./model-config";

/** Uses Pi AI's full real provider catalog and auth resolution; no response fallback exists. */
export async function createConfiguredModels(
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
  const credential = managedApiKeyCredential(config.apiKey);
  const credentials: CredentialStore = {
    async read(providerId) {
      return providerId === config.provider ? credential : undefined;
    },
    async list() {
      return [{ providerId: config.provider, type: "api_key" }];
    },
    async modify(providerId, update) {
      return providerId === config.provider ? update(credential) : undefined;
    },
    async delete() {},
  };
  const models = builtinModels({
    credentials,
    authContext: managedModelAuthContext,
  });
  const provider = models.getProvider(config.provider);
  if (!provider) throw new Error("Configured Pi AI provider is not supported");
  const model = models.getModel(config.provider, config.modelId);
  if (!model)
    throw new Error("Configured model is not in the Pi AI provider catalog");
  const auth = await models.getAuth(model);
  if (!auth)
    throw new Error("Configured Pi AI provider has no usable credentials");
  return models;
}

export async function createManagedRuntimeOptions(
  environment: ManagedRuntimeEnvironment,
) {
  const config = readManagedModelConfig(environment);
  return {
    models: await createConfiguredModels(config),
    agent: { model: { provider: config.provider, modelId: config.modelId } },
  } as const;
}
