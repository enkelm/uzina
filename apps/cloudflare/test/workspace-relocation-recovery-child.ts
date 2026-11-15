import { ExecutionDaemon } from "../../daemon/src/execution/daemon";
import { HttpExecutionControllerConnector } from "../../daemon/src/execution/connector";
import { workspaceRelocationClaimSchema } from "@uzina/contracts/factory";

const environment = process.env;
const claimJson = environment.UZINA_RELOCATION_TEST_CLAIM;
const databasePath = environment.UZINA_RELOCATION_TEST_DATABASE;
const workspaceDirectory = environment.UZINA_RELOCATION_TEST_WORKSPACE;
const baseUrl = environment.UZINA_RELOCATION_TEST_CONTROLLER;
const nodeId = environment.UZINA_RELOCATION_TEST_NODE_ID;
const nodeCredential = environment.UZINA_RELOCATION_TEST_NODE_CREDENTIAL;
if (
  !claimJson ||
  !databasePath ||
  !workspaceDirectory ||
  !baseUrl ||
  !nodeId ||
  !nodeCredential
) {
  throw new Error("Relocation recovery child configuration is incomplete");
}

const claim = workspaceRelocationClaimSchema.parse(JSON.parse(claimJson));
const daemon = new ExecutionDaemon({
  databasePath,
  nodeId,
  nodeCredential,
  workspaces: [
    {
      workspaceId: claim.destination.workspaceId,
      directory: workspaceDirectory,
      ownershipGeneration: claim.ownershipGeneration,
    },
  ],
});
const controller = new HttpExecutionControllerConnector({
  controllerUrl: baseUrl,
  nodeId,
  credential: nodeCredential,
});

try {
  const report = await daemon.executeWorkspaceRelocation(
    claim,
    (relocationId, reference) =>
      controller.fetchWorkspaceRelocationBlob(relocationId, reference),
  );
  process.stdout.write(`${JSON.stringify({ kind: "report", report })}\n`);
} catch (error) {
  const failure = error as { name?: unknown; code?: unknown };
  process.stderr.write(
    `${JSON.stringify({
      kind: "child-error",
      name: typeof failure.name === "string" ? failure.name : "Error",
      code: typeof failure.code === "string" ? failure.code : undefined,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  daemon.close();
}
