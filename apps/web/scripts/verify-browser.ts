import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium, type Route } from "playwright";
import { createServer } from "vite";
import { createStandaloneFactoryServer } from "../../../apps/daemon/src/factory/standalone";
import { ExecutionDaemon } from "../../../apps/daemon/src/execution/daemon";
import { HttpExecutionControllerConnector } from "../../../apps/daemon/src/execution/connector";
import { ExecutionLoop } from "../../../apps/daemon/src/execution/loop";
import { deterministicModels } from "../../../packages/pi-runtime/test-support/deterministic-model";
import { verifyCatalogWithoutRuntime } from "./verify-catalog-browser";
import { chooseSelect } from "./browser-controls";
import { verifyUiSdk, sendWithUiSdk } from "./verify-ui-sdk";
import { verifyCoordinationInbox } from "./verify-coordination-browser";
import { verifyFactoryChat } from "./verify-factory-chat-browser";
import { FactoryClient } from "@uzina/client";

const output = resolve(".impeccable/review");
const browserPath =
  process.env.UZINA_WEB_BROWSER_EXECUTABLE ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const releaseGates: Array<() => void> = [];
const intercepted: Promise<void>[] = [];
function ownRoute(operation: (route: Route) => Promise<void>) {
  return (route: Route) => {
    const work = operation(route);
    intercepted.push(work);
    void work.catch(() => {}); // Still inspected and joined in finally.
    return work;
  };
}
async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const directory = await mkdtemp(join(tmpdir(), "uzina-ui-browser-"));
let host: Awaited<ReturnType<typeof createStandaloneFactoryServer>> | undefined;
let nodeDaemon: ExecutionDaemon | undefined;
let nodeAbort: AbortController | undefined;
let nodeLoopTask: Promise<void> | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let primary: unknown;
const failures: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  const workspaceDirectory = join(directory, "workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const models = deterministicModels(
    "The browser used the real local Pi runtime with deterministic external model transport.",
  );
  host = await createStandaloneFactoryServer({
    databasePath: join(directory, "factory.sqlite"),
    runtimeDirectory: join(directory, "managed-work"),
    ownerSignIn: true,
    models: models.models,
    modelProvider: "uzina-test",
    modelId: "fixed-model",
    port: 0,
    workspaceDirectories: { "workspace:browser": workspaceDirectory },
  });
  const ownerCredential = new URL(
    host.ownerSignInPath!,
    host.server.url,
  ).searchParams.get("token")!;
  const owner = await host.factory.authenticate(ownerCredential);
  const project = host.factory.createProject(
    owner,
    "project:browser-existing",
    "Shared fixture project",
  );
  const provisioned = await host.factory.provisionNode(
    owner,
    "node:browser",
    "Disposable test node",
  );
  const { node } = provisioned;
  const workspace = host.factory.createWorkspace(
    owner,
    "workspace:browser",
    node.nodeId,
    "Disposable test Workspace",
  );
  nodeDaemon = new ExecutionDaemon({
    databasePath: join(directory, "node.sqlite"),
    nodeId: node.nodeId,
    nodeCredential: provisioned.credential.credential,
    workspaces: [
      { workspaceId: workspace.workspaceId, directory: workspaceDirectory },
    ],
  });
  const connector = new HttpExecutionControllerConnector({
    controllerUrl: host.server.url.origin,
    nodeId: node.nodeId,
    credential: provisioned.credential.credential,
  });
  const executionLoop = new ExecutionLoop({
    daemon: nodeDaemon,
    controller: connector,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 2_000,
  });
  nodeAbort = new AbortController();
  nodeLoopTask = executionLoop.run(nodeAbort.signal);
  void nodeLoopTask.catch(() => {}); // The original result is joined below.
  const target = { nodeId: node.nodeId, workspaceId: workspace.workspaceId };
  const threadA = host.factory.createThread(owner, {
    threadId: "thread:browser-original",
    projectId: project.projectId,
    title: "Original work",
    target,
  });
  const threadB = host.factory.createThread(owner, {
    threadId: "thread:browser-other",
    projectId: project.projectId,
    title: "Other work",
    target,
  });
  host.factory.createThread(owner, {
    threadId: "constructor",
    projectId: project.projectId,
    title: "Opaque identifier work",
    target,
  });
  // Real bounded-list fixtures: normal Core admission, never synthetic rows.
  const crowded = host.factory.createProject(
    owner,
    "project:crowded",
    "Crowded project",
  );
  const offlineNode = await host.factory.provisionNode(
    owner,
    "node:offline-browser",
    "Offline fixture node",
  );
  const offlineWorkspace = host.factory.createWorkspace(
    owner,
    "workspace:offline-browser",
    offlineNode.node.nodeId,
    "Offline fixture Workspace",
  );
  let newestCrowded = "";
  for (let i = 0; i < 101; i += 1) {
    newestCrowded = host.factory.createThread(owner, {
      threadId: `thread:crowded-${String(i).padStart(3, "0")}`,
      projectId: crowded.projectId,
      title: `Crowded work ${i}`,
      target: {
        nodeId: offlineNode.node.nodeId,
        workspaceId: offlineWorkspace.workspaceId,
      },
    }).threadId;
  }
  for (let i = 0; i < 101; i += 1) {
    await host.factory.submitInput(
      owner,
      newestCrowded,
      `crowded-input-${i}`,
      `Real offline admission ${i}`,
    );
  }
  const later = host.factory.createProject(
    owner,
    "project:later-browser",
    "Later project",
  );
  host.factory.createThread(owner, {
    threadId: "thread:later-browser",
    projectId: later.projectId,
    title: "Later project work",
    target,
  });
  const invite = async (role: "viewer" | "guest", name: string) => {
    const invitation = await host!.factory.createInvitation(owner, {
      role,
      grants: [{ type: "project", resourceId: project.projectId }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return (await host!.factory.redeemInvitation(invitation.code, name))
      .credential;
  };
  const viewerCredential = await invite("viewer", "Scoped Browser Viewer");
  const guestCredential = await invite("guest", "Scoped Browser Guest");
  const viewerSession = await host.factory.authenticate(viewerCredential);
  if (viewerSession.actor.kind !== "human")
    throw new Error("Fixture Viewer credential is not human");
  assert.equal(
    host.factory.listThreads(viewerSession, project.projectId).length,
    3,
    "Viewer is authorized by actual Core scope",
  );

  process.env.UZINA_WEB_API_ORIGIN = host.server.url.origin;
  vite = await createServer({
    root: process.cwd(),
    configFile: resolve("vite.config.ts"),
    optimizeDeps: {
      entries: ["src/main.tsx"],
      include: ["@ui-sdk/react/agent"],
    },
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: "networkidle",
  });
  const connect = async (credential: string) => {
    const signIn = await page.request.post(
      new URL("/login", host!.server.url).href,
      { form: { token: credential }, maxRedirects: 0 },
    );
    assert.equal(signIn.status(), 303);
    await page
      .getByRole("button", { name: "Check sign-in", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Work items", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
  };
  await page.goto(
    `http://127.0.0.1:${address.port}/login?token=${encodeURIComponent(ownerCredential)}`,
  );
  await page
    .getByRole("heading", { name: "Sign in to your Factory", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(output, "sign-in-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(output, "sign-in-mobile.png"),
    fullPage: true,
  });
  const [loginResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/login" &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  assert.equal(
    loginResponse.status(),
    303,
    await loginResponse.text().catch(() => ""),
  );
  await page
    .getByRole("navigation", { name: "Work items", exact: true })
    .waitFor({ timeout: 10_000 });
  const signedInUrl = new URL(page.url());
  assert.equal(signedInUrl.pathname, "/");
  assert.ok(
    [...signedInUrl.searchParams.keys()].every((key) =>
      ["project", "work"].includes(key),
    ),
  );
  assert.ok(!page.url().includes(ownerCredential));
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.getByText("owner", { exact: true }).count(), 1);
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );

  // Native sharing pages and invite forms work through the same production proxy/cookie boundary.
  const [sharingResponse] = await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/sharing",
    ),
    page.getByRole("link", { name: "Sharing", exact: true }).click(),
  ]);
  assert.equal(sharingResponse.status(), 200, await sharingResponse.text());
  await page
    .getByLabel("Share", { exact: true })
    .selectOption(`project|${project.projectId}`);
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Invitation ready", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(output, "sharing-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(output, "sharing-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const invitationLink = await page
    .locator('a[href*="/join/"]')
    .getAttribute("href");
  const invitedContext = await browser.newContext();
  try {
    const invitedPage = await invitedContext.newPage();
    await invitedPage.goto(invitationLink!);
    await invitedPage
      .getByLabel("Your name", { exact: true })
      .fill("Invited browser viewer");
    await invitedPage
      .getByRole("button", { name: "Join Factory", exact: true })
      .click();
    await invitedPage.getByText("viewer", { exact: true }).waitFor();
    assert.equal(
      await invitedPage
        .getByRole("link", { name: "Sharing", exact: true })
        .count(),
      0,
    );
  } finally {
    await invitedContext.close();
  }
  await page
    .getByRole("link", { name: "Back to Factory", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Work items", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });

  // Cookies are shared across tabs: changing accounts clears the other tab's private state.
  const otherTab = await context.newPage();
  try {
    await otherTab.goto(
      `http://127.0.0.1:${address.port}/login?token=${encodeURIComponent(viewerCredential)}`,
    );
    await otherTab
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await otherTab.getByText("viewer", { exact: true }).waitFor();
    await page.getByText("viewer", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Create project", exact: true })
        .count(),
      0,
    );
    await otherTab.goto(
      `http://127.0.0.1:${address.port}/login?token=${encodeURIComponent(ownerCredential)}`,
    );
    await otherTab
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await otherTab.getByText("owner", { exact: true }).waitFor();
    await page.getByText("owner", { exact: true }).waitFor();
  } finally {
    await otherTab.close();
  }

  const uiSdk = await verifyUiSdk(page, output);
  await verifyFactoryChat(
    page,
    output,
    new FactoryClient({
      baseUrl: host.server.url,
      credential: ownerCredential,
    }),
    ownerCredential,
    viewerCredential,
  );
  await verifyCoordinationInbox(
    page,
    output,
    new FactoryClient({
      baseUrl: host.server.url,
      credential: ownerCredential,
    }),
    host.server.url,
  );

  // Owner creates a real project and then a real Work item against the explicit existing target.
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Browser-created project");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create Work item", exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await page
    .getByRole("button", { name: "Create Work item", exact: true })
    .click();
  await page
    .getByLabel("Work item name", { exact: true })
    .fill("Browser-created work");
  await chooseSelect(page, "Execution node", /^Disposable test node · /);
  await chooseSelect(page, "Workspace", workspace.name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create Work item", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Browser-created work", exact: true })
    .waitFor({ timeout: 10_000 });
  await page.getByText("online", { exact: true }).waitFor();
  await sendWithUiSdk(
    page,
    uiSdk,
    "Please answer with the deterministic test response.",
  );
  await page
    .getByText("Input accepted", { exact: true })
    .waitFor({ timeout: 10_000 });
  try {
    await page
      .getByText(
        "The browser used the real local Pi runtime with deterministic external model transport.",
        { exact: true },
      )
      .waitFor({ timeout: 25_000 });
  } catch (error) {
    console.log(
      "Owner app surface after submission timeout:",
      (await page.locator("body").innerText()).slice(-2500),
    );
    console.log(
      "Actual durable receipts:",
      JSON.stringify(
        host.factory.listThreadReceipts(
          owner,
          host.factory
            .listThreads(owner)
            .find((item) => item.title === "Browser-created work")!.threadId,
        ),
      ),
    );
    throw error;
  }
  await page
    .getByRole("region", { name: "Conversation", exact: true })
    .getByText("Please answer with the deterministic test response.", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Work details", exact: true }).click();
  await page.getByText("Command history", { exact: true }).waitFor();
  const verifyDetailsDoNotCoverReceipt = async () => {
    await page
      .getByRole("button", { name: "Check receipt", exact: true })
      .scrollIntoViewIfNeeded();
    const [receipt, details, conversation] = await Promise.all([
      page
        .getByRole("article")
        .filter({
          has: page.getByRole("button", { name: "Check receipt", exact: true }),
        })
        .boundingBox(),
      page
        .getByRole("complementary", { name: "Work item details", exact: true })
        .boundingBox(),
      page
        .getByRole("region", { name: "Conversation", exact: true })
        .boundingBox(),
    ]);
    assert.ok(receipt && details && conversation);
    // Scroll containers clip fractional overflow. Compare the visible receipt,
    // not a subpixel of its box outside the conversation's painted area.
    const visible = {
      left: Math.max(receipt.x, conversation.x),
      top: Math.max(receipt.y, conversation.y),
      right: Math.min(
        receipt.x + receipt.width,
        conversation.x + conversation.width,
      ),
      bottom: Math.min(
        receipt.y + receipt.height,
        conversation.y + conversation.height,
      ),
    };
    assert.ok(visible.right > visible.left && visible.bottom > visible.top);
    assert.ok(
      visible.right <= details.x ||
        details.x + details.width <= visible.left ||
        visible.bottom <= details.y ||
        details.y + details.height <= visible.top,
      `Expanded details must not cover the visible receipt: ${JSON.stringify({ viewport: page.viewportSize(), visible, details })}`,
    );
    await page
      .getByRole("button", { name: "Check receipt", exact: true })
      .click({ trial: true });
  };
  await verifyDetailsDoNotCoverReceipt();
  await page.screenshot({
    path: resolve(output, "factory-owner-working-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await verifyDetailsDoNotCoverReceipt();
  await page.screenshot({
    path: resolve(output, "factory-owner-working-intermediate.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Close work details", exact: true })
    .click();
  const back = page.getByRole("button", { name: "Work items", exact: true });
  const backBox = await back.boundingBox();
  assert.ok(
    backBox && backBox.y >= 54,
    "Mobile Work item navigation stays below the shell header",
  );
  await back.click();
  await page
    .getByRole("navigation", { name: "Work items", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^Browser-created work / }).click();
  await page
    .getByRole("heading", { name: "Browser-created work", exact: true })
    .waitFor();
  await page.screenshot({
    path: resolve(output, "factory-owner-working-mobile.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Cross-thread lost request: abort before admission, switch Work items, ensure A's action is absent on B.
  await chooseSelect(page, "PROJECT", project.name);
  await page.getByRole("button", { name: /^Original work / }).click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  const originalUrl = page.url();
  assert.equal(
    new URL(originalUrl).searchParams.get("project"),
    project.projectId,
  );
  assert.equal(new URL(originalUrl).searchParams.get("work"), threadA.threadId);
  await page.getByRole("button", { name: /^Other work / }).click();
  await page
    .getByRole("heading", { name: "Other work", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).searchParams.get("work"), threadB.threadId);
  await page.goBack();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  assert.equal(page.url(), originalUrl);
  await page.goForward();
  await page
    .getByRole("heading", { name: "Other work", exact: true })
    .waitFor();
  await page.goBack();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  assert.equal(page.url(), originalUrl);
  const originalInput = "  Only Original work\n";
  let lost: { requestId: string; text: string } | undefined;
  await page.route(
    `**/v1/threads/${encodeURIComponent(threadA.threadId)}/inputs`,
    ownRoute(async (route) => {
      const body = route.request().postDataJSON();
      assert.equal(body.text, originalInput);
      lost = { requestId: body.requestId, text: body.text };
      await route.abort("connectionreset");
    }),
    { times: 1 },
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(originalInput);
  await page.getByRole("button", { name: "Send input", exact: true }).click();
  await page
    .getByRole("button", { name: "Reconcile request", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Reconcile request", exact: true })
    .click({ trial: true });
  assert.ok(lost);
  assert.equal(
    await page
      .getByRole("button", { name: "Send input", exact: true })
      .isDisabled(),
    true,
    "Unknown input must use receipt-first reconciliation, not Send",
  );
  assert.equal(
    host.factory.listThreadReceipts(owner, threadA.threadId).length,
    0,
  );
  // A genuine transport failure hides private views and clears ordinary forms,
  // but cannot erase this unresolved command's identity or exact bytes.
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Private disconnected form");
  await context.setOffline(true);
  await page
    .getByRole("heading", { name: "Factory unavailable", exact: true })
    .waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await page.getByText("Only Original work", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("Input accepted", { exact: true }).count(),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click({ trial: true });
  await page.screenshot({
    path: resolve(output, "factory-unavailable-mobile.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.screenshot({
    path: resolve(output, "factory-unavailable-small.png"),
    fullPage: false,
  });
  await context.setOffline(false);
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .inputValue(),
    originalInput,
  );
  await page.screenshot({
    path: resolve(output, "factory-owner-working-small.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Other work / }).click();
  await page
    .getByRole("heading", { name: "Other work", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Reconcile request", exact: true })
      .count(),
    0,
    "A pending A request must not be offered on B",
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .inputValue(),
    "",
    "A draft must not leak into B",
  );
  await page.getByRole("button", { name: /^Original work / }).click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .inputValue(),
    originalInput,
  );
  await page
    .getByRole("button", { name: "Reconcile request", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check receipt", exact: true })
    .waitFor({ timeout: 10_000 });
  assert.equal(
    host.factory.listThreadReceipts(owner, threadA.threadId).length,
    1,
  );
  assert.equal(
    host.factory.listThreadReceipts(owner, threadB.threadId).length,
    0,
  );
  assert.equal(
    host.factory.listThreadReceipts(owner, threadA.threadId)[0]?.requestId,
    lost.requestId,
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .inputValue(),
    "",
    "Reconciled input is not left ready to resend under a new request ID",
  );
  const originalMessage = page
    .getByRole("region", { name: "Conversation", exact: true })
    .getByText("Only Original work", { exact: true });
  await originalMessage.waitFor({ timeout: 20_000 });
  assert.equal(
    await originalMessage.textContent(),
    originalInput,
    "The actual Pi conversation preserves the exact submitted input",
  );
  let releaseContext!: () => void;
  let markContextStarted!: () => void;
  let markContextFinished!: () => void;
  const contextStarted = new Promise<void>((resolve) => {
    markContextStarted = resolve;
  });
  const contextFinished = new Promise<void>((resolve) => {
    markContextFinished = resolve;
  });
  const contextGate = new Promise<void>((resolve) => {
    releaseContext = resolve;
    releaseGates.push(resolve);
  });
  let lateContextResult = "pending";
  await page.route(
    `**/v1/threads/${encodeURIComponent(threadA.threadId)}/context`,
    ownRoute(async (route) => {
      const response = await route.fetch();
      try {
        markContextStarted();
        await contextGate;
        try {
          await route.fulfill({ response });
          lateContextResult = "fulfilled";
        } catch (error) {
          if (!route.request().failure()) throw error;
          lateContextResult = "aborted after thread switch";
        }
      } finally {
        try {
          await response.dispose();
        } finally {
          markContextFinished();
        }
      }
    }),
    { times: 1 },
  );
  await page.getByRole("button", { name: /^Other work / }).click();
  await page
    .getByRole("heading", { name: "Other work", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^Original work / }).click();
  await within(contextStarted, "the actual A context response");
  await page.getByRole("button", { name: /^Other work / }).click();
  await page
    .getByRole("heading", { name: "Other work", exact: true })
    .waitFor();
  releaseContext();
  await within(contextFinished, "the held A response to settle");
  assert.equal(
    await page.getByText("Only Original work", { exact: true }).count(),
    0,
    "A late actual A context response cannot repopulate B",
  );
  assert.ok(
    lateContextResult === "fulfilled" ||
      lateContextResult === "aborted after thread switch",
  );

  // A response dropped after the real Core accepted the request reconciles the same real receipt.
  await page.getByRole("button", { name: /^Original work / }).click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  await page.route(
    `**/v1/threads/${encodeURIComponent(threadA.threadId)}/inputs`,
    ownRoute(async (route) => {
      const response = await route.fetch();
      try {
        assert.ok(response.ok());
        await route.abort("connectionreset");
      } finally {
        await response.dispose();
      }
    }),
    { times: 1 },
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Accepted before response loss");
  await page.getByRole("button", { name: "Send input", exact: true }).click();
  await page
    .getByRole("button", { name: "Reconcile request", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Reconcile request", exact: true })
    .click({ trial: true });
  assert.equal(
    host.factory.listThreadReceipts(owner, threadA.threadId).length,
    2,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Send input", exact: true })
      .isDisabled(),
    true,
    "An admitted request with a lost reply also requires receipt-first reconciliation",
  );
  await page
    .getByRole("button", { name: "Reconcile request", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check receipt", exact: true })
    .waitFor({ timeout: 10_000 });
  assert.equal(
    host.factory.listThreadReceipts(owner, threadA.threadId).length,
    2,
    "Receipt lookup must not duplicate accepted input",
  );

  // Project-scoped listing finds work beyond the global first 100. The exact
  // status resource opens a known ID outside a project's first page.
  await chooseSelect(page, "PROJECT", later.name);
  await page.getByRole("button", { name: /^Later project work / }).waitFor();
  await chooseSelect(page, "PROJECT", crowded.name);
  await page
    .getByText(
      "First 100 Work items in this project shown, oldest first. More may exist. Open a Work item by ID; search covers only the shown list.",
      { exact: true },
    )
    .waitFor();
  await page.getByText("Open Work item by ID", { exact: true }).click();
  await page.getByLabel("Work item ID", { exact: true }).fill(newestCrowded);
  await page
    .getByRole("button", { name: "Open Work item", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Crowded work 100", exact: true })
    .waitFor();
  const crowdedUrl = page.url();
  await page.reload();
  await page
    .getByRole("heading", { name: "Crowded work 100", exact: true })
    .waitFor();
  assert.equal(page.url(), crowdedUrl);
  await page.getByRole("button", { name: "Work details", exact: true }).click();
  await page
    .getByText(
      "First 100 commands shown, oldest first. Newer commands may be absent. This API has no history pagination; use Check receipt for this tab’s last accepted input.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "Close work details", exact: true })
    .click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Private unsent offline draft");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Work items", exact: true }).click();
  await context.setOffline(true);
  await page
    .getByRole("heading", { name: "Factory unavailable", exact: true })
    .waitFor({ timeout: 15_000 });
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click({ trial: true });
  assert.equal(await page.getByLabel("Message", { exact: true }).count(), 0);
  await context.setOffline(false);
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Work items", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByText("Open Work item by ID", { exact: true }).click();
  await page.getByLabel("Work item ID", { exact: true }).fill(newestCrowded);
  await page
    .getByRole("button", { name: "Open Work item", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Crowded work 100", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Message", { exact: true }).inputValue(),
    "",
    "A cleared ordinary draft does not reappear after reconnection",
  );

  // Viewer authentication only calls APIs allowed to participants and remains read-only.
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Check sign-in", exact: true })
    .waitFor();
  await connect(viewerCredential);
  assert.equal(await page.getByText("viewer", { exact: true }).count(), 1);
  await chooseSelect(page, "PROJECT", project.name);
  await page.getByRole("button", { name: /^Original work / }).click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Message", { exact: true }).count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("option", { name: "Browser-created project", exact: true })
      .count(),
    0,
    "Project-scoped Viewer cannot see the Owner's unrelated project",
  );
  await page.getByRole("button", { name: /^Opaque identifier work / }).click();
  await page
    .getByRole("heading", { name: "Opaque identifier work", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^Original work / }).click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  host.factory.revokeParticipant(owner, viewerSession.actor.userId);
  await page
    .getByRole("button", { name: "Check sign-in", exact: true })
    .waitFor({ timeout: 15_000 });
  assert.equal(
    await page.getByText("Only Original work", { exact: true }).count(),
    0,
    "Revoked Viewer context must be cleared",
  );
  await page
    .getByRole("button", { name: "Check sign-in", exact: true })
    .waitFor();
  await connect(guestCredential);
  await chooseSelect(page, "PROJECT", project.name);
  await page.getByRole("button", { name: /^Original work / }).click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Message", { exact: true }).count(), 1);
  assert.equal(
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .count(),
    0,
  );
  await page.getByLabel("Message", { exact: true }).fill("private guest draft");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Check sign-in", exact: true })
    .waitFor();
  await connect(ownerCredential);
  await chooseSelect(page, "PROJECT", project.name);
  await page.getByRole("button", { name: /^Original work / }).click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Message", { exact: true }).inputValue(),
    "",
    "Account switch must clear the previous actor's draft",
  );
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("private project form value");
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
    true,
    "Keyboard focus must remain inside the creation dialog",
  );
  await page.keyboard.press("Escape");
  await page.locator("#project-title").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Create project",
    "Escape must restore focus to the modal trigger",
  );
  let releaseOldMe!: () => void;
  let startedOldMe!: () => void;
  let finishedOldMe!: () => void;
  const oldMeStarted = new Promise<void>((resolve) => {
    startedOldMe = resolve;
  });
  const oldMeFinished = new Promise<void>((resolve) => {
    finishedOldMe = resolve;
  });
  const oldMeGate = new Promise<void>((resolve) => {
    releaseOldMe = resolve;
    releaseGates.push(resolve);
  });
  await page.route(
    "**/v1/me",
    ownRoute(async (route) => {
      const response = await route.fetch();
      try {
        assert.ok(response.ok());
        startedOldMe();
        await oldMeGate;
        try {
          await route.abort("connectionreset");
        } catch (error) {
          if (!route.request().failure()) throw error;
        }
      } finally {
        try {
          await response.dispose();
        } finally {
          finishedOldMe();
        }
      }
    }),
    { times: 1 },
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await within(
    oldMeStarted,
    "the real Owner identity read before account switch",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Check sign-in", exact: true })
    .waitFor();
  await connect(guestCredential);
  releaseOldMe();
  await within(
    oldMeFinished,
    "the old Owner transport failure after Guest connected",
  );
  await page.getByText("guest", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Factory unavailable", exact: true })
      .count(),
    0,
    "An old account's late request failure cannot disconnect the new account",
  );
  assert.equal(
    await page.getByRole("dialog").count(),
    0,
    "Former Owner dialog must not survive account switch",
  );
  await chooseSelect(page, "PROJECT", project.name);
  await page.getByRole("button", { name: /^Original work / }).click();
  await page
    .getByRole("heading", { name: "Original work", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Message", { exact: true }).inputValue(),
    "",
    "Former account draft must not reappear",
  );
  assert.deepEqual(consoleErrors, []);
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  console.log(
    "PASS: real Owner create/target/send/Pi answer, real Viewer/Guest scope, and cross-thread/lost-ack receipt reconciliation.",
  );
  await verifyCatalogWithoutRuntime(browser, directory);
} catch (error) {
  primary = error;
} finally {
  for (const release of releaseGates) release();
  try {
    await browser?.close();
  } catch (error) {
    failures.push(error);
  }
  for (const result of await Promise.allSettled(intercepted)) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  try {
    await vite?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    nodeAbort?.abort();
    await nodeLoopTask;
  } catch (error) {
    failures.push(error);
  }
  try {
    nodeDaemon?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await host?.close(true);
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
}
if (primary || failures.length)
  throw new AggregateError(
    primary ? [primary, ...failures] : failures,
    "Owned UI browser scenario failed (all cleanup attempted)",
  );
