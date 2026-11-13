import { describe, expect, test } from "bun:test";
import {
  createConfiguredModels,
  readManagedModelConfig,
} from "../src/provider";
import { createWorkerConfiguredModels } from "../src/worker-provider";

describe("managed provider configuration", () => {
  test("fails closed when any selected provider, model or API credential is missing", async () => {
    expect(() =>
      readManagedModelConfig({ UZINA_MODEL_PROVIDER: "openai" }),
    ).toThrow("UZINA_MODEL_PROVIDER, UZINA_MODEL_ID, and UZINA_MODEL_API_KEY");
    await expect(
      createConfiguredModels({
        provider: "",
        modelId: "gpt-4o-mini",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("provider, model ID, and API key are required");
    await expect(
      createConfiguredModels({
        provider: "unknown-provider",
        modelId: "unknown-model",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("provider is not supported");
    await expect(
      createWorkerConfiguredModels({
        provider: "anthropic",
        modelId: "claude-3-5-haiku",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("support only the OpenAI API-key provider profile");
  });

  test("resolves a real Pi AI catalog model and credential without making a paid request", async () => {
    const config = readManagedModelConfig({
      UZINA_MODEL_PROVIDER: "openai",
      UZINA_MODEL_ID: "gpt-4o-mini",
      UZINA_MODEL_API_KEY: "test-only-not-a-credential",
    });
    const models = await createConfiguredModels(config);
    const model = models.getModel(config.provider, config.modelId);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-4o-mini",
    });
    expect(await models.getAuth(model!)).toBeDefined();
  });
});
