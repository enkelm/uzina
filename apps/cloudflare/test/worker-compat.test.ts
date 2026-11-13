import { describe, expect, test } from "bun:test";
import { defaultProviderAuthContext } from "../worker-compat/auth-context";
import {
  loadAnthropicOAuth,
  loadGitHubCopilotOAuth,
  loadKimiCodingOAuth,
  loadMetaOAuth,
  loadOpenAICodexOAuth,
  loadOpenAIChatGPTOAuth,
  loadOpenRouterOAuth,
  loadRadiusOAuth,
  loadXaiOAuth,
  registerBundledOAuthFlowLoaders,
} from "../worker-compat/oauth-load";

describe("Cloudflare Pi AI compatibility shims", () => {
  test("does not discover environment credentials or filesystem auth", async () => {
    const context = defaultProviderAuthContext();
    expect(await context.env("OPENAI_API_KEY")).toBeUndefined();
    expect(await context.fileExists("~/.config/provider-credentials")).toBe(
      false,
    );
  });

  test("fails closed for every unsupported upstream OAuth loader", async () => {
    const loaders = [
      () => loadAnthropicOAuth(),
      () => loadOpenAICodexOAuth(),
      () => loadOpenAIChatGPTOAuth(),
      () => loadGitHubCopilotOAuth(),
      () => loadOpenRouterOAuth(),
      () => loadKimiCodingOAuth(),
      () => loadMetaOAuth(),
      () => loadXaiOAuth(),
      () =>
        loadRadiusOAuth({
          name: "unsupported",
          gateway: "https://example.invalid",
        }),
    ];
    for (const load of loaders) {
      await expect(load()).rejects.toThrow(
        "OAuth login is unsupported in Cloudflare Workers",
      );
    }
    expect(registerBundledOAuthFlowLoaders).toThrow(
      "OAuth login is unsupported in Cloudflare Workers",
    );
  });
});
