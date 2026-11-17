import {
  createWorkerManagedRuntimeOptions,
  type ManagedRuntimeEnvironment,
} from "@uzina/pi-runtime/worker-provider";

export default {
  async fetch(_request: Request, environment: ManagedRuntimeEnvironment) {
    const { models, agent } =
      await createWorkerManagedRuntimeOptions(environment);
    const model = models.getModel(agent.model.provider, agent.model.modelId)!;
    const result = await models.completeSimple(model, {
      messages: [
        { role: "user", content: "Provider compatibility probe", timestamp: 1 },
      ],
    });
    return Response.json(result);
  },
};
