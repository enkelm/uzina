import type { AuthContext } from "@earendil-works/pi-ai";
import type { Credential } from "@earendil-works/pi-ai";

export type ManagedModelConfig = {
  provider: string;
  modelId: string;
  apiKey: string;
};

export type ManagedRuntimeEnvironment = {
  UZINA_MODEL_PROVIDER?: string;
  UZINA_MODEL_ID?: string;
  UZINA_MODEL_API_KEY?: string;
  /** Cloudflare encrypted Worker secret, keyed by Pi provider ID; never a public var. */
  UZINA_PROVIDER_CREDENTIALS?: string;
};

export function readManagedModelConfig(
  environment: ManagedRuntimeEnvironment,
): ManagedModelConfig {
  const provider = environment.UZINA_MODEL_PROVIDER?.trim();
  const modelId = environment.UZINA_MODEL_ID?.trim();
  const apiKey = environment.UZINA_MODEL_API_KEY;
  if (!provider || !modelId || !apiKey?.trim()) {
    throw new Error(
      "Managed Pi requires UZINA_MODEL_PROVIDER, UZINA_MODEL_ID, and UZINA_MODEL_API_KEY",
    );
  }
  return { provider, modelId, apiKey };
}

export const managedModelAuthContext: AuthContext = {
  async env() {
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

export function managedApiKeyCredential(apiKey: string): Credential {
  if (!apiKey.trim()) throw new Error("Managed model API key is required");
  return { type: "api_key", key: apiKey };
}
