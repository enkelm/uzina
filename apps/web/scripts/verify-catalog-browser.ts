import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { FactoryClient } from "@uzina/client";
import { factoryThreadSchema } from "@uzina/contracts/factory";
import {
  createLocalFactoryServer,
  type LocalFactoryServer,
} from "../../daemon/src/factory/server";

const metadataNotice =
  "Runtime status is unavailable. Showing last-known Work item details; command history has current access checks.";
const idLimitation =
  "This Factory cannot supply Work item details by ID while runtime status is unavailable. Select a shown Work item to read its command history.";

/** A distinct supported composition: real catalog/history HTTP, no runtime adapter. */
export async function verifyCatalogWithoutRuntime(
  browser: Browser,
  directory: string,
) {
  let host: LocalFactoryServer | undefined;
  let vite: ViteDevServer | undefined;
  let context: BrowserContext | undefined;
  let primary: unknown;
  try {
    host = createLocalFactoryServer({
      databasePath: join(directory, "catalog-only.sqlite"),
      bootstrapSecret: "owned-catalog-bootstrap",
      port: 0,
    });
    const credential = (
      await host.factory.bootstrap("owned-catalog-bootstrap", "Catalog Owner")
    ).credential;
    const owner = await host.factory.authenticate(credential);
    const project = host.factory.createProject(
      owner,
      "project:catalog-only",
      "Catalog-only project",
    );
    const provisioned = await host.factory.provisionNode(
      owner,
      "node:catalog-only",
      "Catalog node",
    );
    const workspace = host.factory.createWorkspace(
      owner,
      "workspace:catalog-only",
      provisioned.node.nodeId,
      "Catalog Workspace",
    );
    const target = {
      nodeId: provisioned.node.nodeId,
      workspaceId: workspace.workspaceId,
    };
    for (let i = 0; i < 101; i += 1) {
      host.factory.createThread(owner, {
        threadId: `thread:catalog-${String(i).padStart(3, "0")}`,
        projectId: project.projectId,
        title: `Catalog work ${i}`,
        target,
      });
    }
    const client = new FactoryClient({
      baseUrl: host.server.url.origin,
      credential,
    });
    vite = await createServer({
      root: process.cwd(),
      configFile: resolve("vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: {
          "/v1": { target: host.server.url.origin, changeOrigin: false },
        },
      },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "networkidle",
    });
    const signIn = await page.request.post(
      new URL("/login", host.server.url).href,
      { form: { token: credential }, maxRedirects: 0 },
    );
    assert.equal(signIn.status(), 303);
    await page
      .getByRole("button", { name: "Check sign-in", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Work items", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Create Work item", exact: true })
      .click();
    await page
      .getByLabel("Work item name", { exact: true })
      .fill("Last-known catalog work");
    await page
      .getByLabel("Execution node", { exact: true })
      .selectOption(target.nodeId);
    await page
      .getByLabel("Workspace", { exact: true })
      .selectOption(target.workspaceId);
    const creation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/v1/threads",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create Work item", exact: true })
      .click();
    const createdResponse = await creation;
    assert.ok(createdResponse.ok());
    const created = factoryThreadSchema.parse(await createdResponse.json());
    await page
      .getByRole("heading", { name: "Last-known catalog work", exact: true })
      .waitFor();
    await client.submitInput(
      created.threadId,
      "catalog-history-receipt",
      "A real catalog-only input admission.",
    );
    const unavailableStatus = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/threads/${encodeURIComponent(created.threadId)}/status` &&
        response.status() === 503,
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await unavailableStatus;
    // Observe the resulting UI, not just a still-visible heading before its await settles.
    await page
      .getByText(metadataNotice, { exact: true })
      .or(
        page.getByRole("heading", { name: "Factory unavailable", exact: true }),
      )
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "Factory unavailable", exact: true })
        .count(),
      0,
      "A missing runtime adapter must not disconnect an authorized catalog or hide its command history",
    );
    assert.equal(
      (await client.listProjects()).projects[0]?.projectId,
      project.projectId,
    );
    assert.equal(
      (await client.listRuns(created.threadId)).runs[0]?.requestId,
      "catalog-history-receipt",
    );
    await page
      .getByRole("button", { name: "Work details", exact: true })
      .click();
    await page
      .getByText("catalog-history-receipt", { exact: true })
      .waitFor({ timeout: 10_000 });
    await page
      .getByRole("button", { name: "Close work details", exact: true })
      .click();
    await page.getByText("Open Work item by ID", { exact: true }).click();
    await page
      .getByLabel("Work item ID", { exact: true })
      .fill("thread:catalog-100");
    await page
      .getByRole("button", { name: "Open Work item", exact: true })
      .click();
    await page.getByText(idLimitation, { exact: true }).waitFor();
    await page
      .getByRole("heading", { name: "Last-known catalog work", exact: true })
      .waitFor();
    assert.equal(await page.getByText("Connected", { exact: true }).count(), 1);
    await page.screenshot({
      path: resolve(".impeccable/review/factory-catalog-without-runtime.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: real local Factory without runtime keeps authorized catalog/history connected and discloses exact-ID limitation.",
    );
  } catch (error) {
    primary = error;
  } finally {
    const failures: unknown[] = [];
    try {
      await context?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await vite?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await host?.server.stop(true);
    } catch (error) {
      failures.push(error);
    }
    try {
      host?.database.close();
    } catch (error) {
      failures.push(error);
    }
    if (primary || failures.length)
      throw new AggregateError(
        primary ? [primary, ...failures] : failures,
        "Owned catalog-only browser scenario failed (all cleanup attempted)",
      );
  }
}
