function unsupportedOAuthError(): Error {
  return new Error(
    "Pi AI OAuth login is unsupported in Cloudflare Workers; configure UZINA_MODEL_API_KEY for the OpenAI API-key profile",
  );
}

function unsupportedOAuth(..._arguments: unknown[]): Promise<never> {
  return Promise.reject(unsupportedOAuthError());
}

export const loadAnthropicOAuth = unsupportedOAuth;
export const loadOpenAICodexOAuth = unsupportedOAuth;
export const loadOpenAIChatGPTOAuth = unsupportedOAuth;
export const loadGitHubCopilotOAuth = unsupportedOAuth;
export const loadOpenRouterOAuth = unsupportedOAuth;
export const loadKimiCodingOAuth = unsupportedOAuth;
export const loadMetaOAuth = unsupportedOAuth;
export const loadXaiOAuth = unsupportedOAuth;
export const loadRadiusOAuth = unsupportedOAuth;

export function registerBundledOAuthFlowLoaders(): never {
  throw unsupportedOAuthError();
}
