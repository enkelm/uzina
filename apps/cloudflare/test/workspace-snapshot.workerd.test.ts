import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, test } from "bun:test";
import {
  restoreWorkspaceCheckpoint,
  type BlobTransport,
  type WorkspaceCheckpointManifest,
} from "@uzina/checkpoints";
import { buildCloudflareWorkerArtifact } from "../scripts/build-worker";
import { ExecutionDaemon } from "../../daemon/src/execution/daemon";
import { HttpExecutionControllerConnector } from "../../daemon/src/execution/connector";
import { ExecutionLoop } from "../../daemon/src/execution/loop";

type Fixture = {
  directory: string;
  miniflare: Miniflare;
  close(): Promise<void>;
};
const fixtures: Fixture[] = [];

async function call<T>(
  baseUrl: string,
  path: string,
  options: { credential?: string; bootstrap?: boolean; body?: unknown } = {},
): Promise<{ response: Response; value: T }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.credential
        ? {
            authorization: `${options.bootstrap ? "Bootstrap" : "Bearer"} ${options.credential}`,
          }
        : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return { response, value: (await response.json()) as T };
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the workerd workspace snapshot");
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

async function makeDirtyGitWorkspace(directory: string): Promise<void> {
  await mkdir(directory);
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.name", "Workerd snapshot fixture");
  git(directory, "config", "user.email", "snapshot@example.invalid");
  await writeFile(join(directory, "tracked.txt"), "base\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-m", "base");
  await writeFile(join(directory, "tracked.txt"), "staged content\n");
  git(directory, "add", "tracked.txt");
  await writeFile(join(directory, "tracked.txt"), "unstaged content\n");
  await writeFile(join(directory, "binary"), new Uint8Array([0, 255, 17, 128]));
  await chmod(join(directory, "binary"), 0o755);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("workspace snapshot transport in production-shaped workerd + R2", () => {
  test("fences, captures Git state on the node, uploads scoped R2 objects, and prepares an inactive workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uzina-workerd-snapshot-"));
    const workspace = join(directory, "workspace");
    await makeDirtyGitWorkspace(workspace);
    const artifact = await buildCloudflareWorkerArtifact();
    const miniflare = new Miniflare({
      name: "uzina-workspace-snapshot",
      script: artifact.script,
      modules: true,
      compatibilityDate: "2026-05-01",
      host: "127.0.0.1",
      port: 0,
      bindings: { UZINA_BOOTSTRAP_SECRET: "snapshot-workerd-bootstrap" },
      durableObjects: {
        FACTORY: { className: "FactoryObject", useSQLite: true },
        MANAGED_WORK: { className: "ManagedWorkObject", useSQLite: true },
      },
      r2Buckets: ["CHECKPOINTS"],
    });
    let daemon: ExecutionDaemon | undefined;
    let abort: AbortController | undefined;
    let loop: Promise<void> | undefined;
    fixtures.push({
      directory,
      miniflare,
      async close() {
        abort?.abort();
        await loop?.catch(() => {});
        daemon?.close();
        await miniflare.dispose();
      },
    });
    const baseUrl = (await miniflare.ready).toString();
    const bootstrap = await call<{ credential: string }>(
      baseUrl,
      "/v1/bootstrap",
      {
        credential: "snapshot-workerd-bootstrap",
        bootstrap: true,
        body: { name: "Snapshot owner" },
      },
    );
    const owner = bootstrap.value.credential;
    expect(bootstrap.response.status).toBe(201);
    const project = await call<{ projectId: string }>(baseUrl, "/v1/projects", {
      credential: owner,
      body: { projectId: "project:workspace-snapshot", name: "Snapshot proof" },
    });
    const node = await call<{ node: { nodeId: string }; credential: string }>(
      baseUrl,
      "/v1/nodes",
      {
        credential: owner,
        body: { nodeId: "node:snapshot-workerd", name: "Snapshot node" },
      },
    );
    const workspaceRecord = await call<{ workspaceId: string }>(
      baseUrl,
      "/v1/workspaces",
      {
        credential: owner,
        body: {
          workspaceId: "workspace:snapshot-workerd",
          nodeId: node.value.node.nodeId,
          name: "Git workspace",
        },
      },
    );
    daemon = new ExecutionDaemon({
      databasePath: join(directory, "node.sqlite"),
      nodeId: node.value.node.nodeId,
      nodeCredential: node.value.credential,
      workspaces: [
        {
          workspaceId: workspaceRecord.value.workspaceId,
          directory: workspace,
        },
      ],
    });
    abort = new AbortController();
    loop = new ExecutionLoop({
      daemon,
      controller: new HttpExecutionControllerConnector({
        controllerUrl: baseUrl,
        nodeId: node.value.node.nodeId,
        credential: node.value.credential,
      }),
      pollIntervalMs: 20,
      heartbeatIntervalMs: 500,
    }).run(abort.signal);
    await until(async () => {
      const nodes = await call<{ nodes: Array<{ availability: string }> }>(
        baseUrl,
        "/v1/nodes",
        { credential: owner },
      );
      return nodes.value.nodes[0]?.availability === "online";
    });
    const thread = await call<{ threadId: string }>(baseUrl, "/v1/threads", {
      credential: owner,
      body: {
        threadId: "thread:workspace-snapshot",
        projectId: project.value.projectId,
        title: "Workspace-only snapshot",
        target: {
          nodeId: node.value.node.nodeId,
          workspaceId: workspaceRecord.value.workspaceId,
        },
      },
    });
    const sourceAdmission = await call<{
      requestId: string;
      captureId: string;
    }>(baseUrl, `/v1/threads/${thread.value.threadId}/capture-controls`, {
      credential: owner,
      body: { contractVersion: 1, requestId: "request:snapshot-source-fence" },
    });
    expect(sourceAdmission.response.status).toBe(202);
    await until(async () => {
      const status = await call<{ status: string }>(
        baseUrl,
        `/v1/capture-controls/${sourceAdmission.value.requestId}`,
        { credential: owner },
      );
      return status.value.status === "source-capture-fenced";
    });
    const snapshotAdmission = await call<{
      requestId: string;
      snapshotId: string;
      captureId: string;
      status: string;
    }>(baseUrl, "/v1/workspace-snapshots", {
      credential: owner,
      body: {
        contractVersion: 1,
        requestId: "snapshot:workerd-workspace",
        captureRequestId: sourceAdmission.value.requestId,
      },
    });
    expect(snapshotAdmission.response.status).toBe(202);
    expect(snapshotAdmission.value.captureId).toBe(
      sourceAdmission.value.captureId,
    );
    await until(async () => {
      const status = await call<{ status: string }>(
        baseUrl,
        `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}`,
        { credential: owner },
      );
      return status.value.status === "workspace-checkpoint-available";
    });
    const status = await call<{ status: string; manifestReference: string }>(
      baseUrl,
      `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}`,
      { credential: owner },
    );
    expect(status.value.status).toBe("workspace-checkpoint-available");
    const getBlob = async (reference: string): Promise<Uint8Array> => {
      const response = await fetch(
        new URL(
          `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${reference}`,
          baseUrl,
        ),
        { headers: { authorization: `Bearer ${owner}` } },
      );
      if (!response.ok)
        throw new Error(`owner blob retrieval refused: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const manifestBytes = await getBlob(status.value.manifestReference);
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as WorkspaceCheckpointManifest;
    expect(manifest.runtimeArtifact).toBeNull();
    expect(manifest.attachments).toEqual([]);
    const prepared = join(directory, "prepared-inactive");
    await mkdir(prepared);
    const transport: BlobTransport = {
      async putBlob() {
        throw new Error("owner restore transport is read-only");
      },
      getBlob: getBlob,
    };
    await restoreWorkspaceCheckpoint({
      manifest,
      transport,
      destinationPath: prepared,
    });
    expect(git(prepared, "show", ":tracked.txt")).toBe("staged content\n");
    expect(await readFile(join(prepared, "tracked.txt"), "utf8")).toBe(
      "unstaged content\n",
    );
    expect(await readFile(join(prepared, "binary"))).toEqual(
      Buffer.from([0, 255, 17, 128]),
    );
    expect(git(prepared, "status", "--porcelain").trim()).toBe(
      "MM tracked.txt\n?? binary",
    );
    expect(
      await stat(join(prepared, "binary")).then((file) => file.mode & 0o111),
    ).toBe(0o111);

    const wrongCredential = await fetch(
      new URL(
        `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${status.value.manifestReference}`,
        baseUrl,
      ),
    );
    expect(wrongCredential.status).toBe(401);
    const guessedForeignObject = await fetch(
      new URL(
        `/v1/workspace-snapshots/snapshot:foreign/blobs/${status.value.manifestReference}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(guessedForeignObject.status).toBe(404);
    const wrongNodeUpload = await fetch(
      new URL(
        `/v1/nodes/node:other/captures/${sourceAdmission.value.captureId}/blobs/${"f".repeat(64)}`,
        baseUrl,
      ),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${node.value.credential}`,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array([1]),
      },
    );
    expect(wrongNodeUpload.status).toBe(403);
    const corruptHashUpload = await fetch(
      new URL(
        `/v1/nodes/${node.value.node.nodeId}/captures/${sourceAdmission.value.captureId}/blobs/${"f".repeat(64)}`,
        baseUrl,
      ),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${node.value.credential}`,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(corruptHashUpload.status).not.toBe(204);
    const corruptBlobDownload = await fetch(
      new URL(
        `/v1/workspace-snapshots/${snapshotAdmission.value.requestId}/blobs/${"f".repeat(64)}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${owner}` } },
    );
    expect(corruptBlobDownload.status).toBe(404);
  }, 30_000);
});
