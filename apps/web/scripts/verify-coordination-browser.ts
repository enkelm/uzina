import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";
import { FactoryClient } from "@uzina/client";
import { chooseSelect } from "./browser-controls";

export async function verifyCoordinationInbox(
  page: Page,
  output: string,
  owner: FactoryClient,
  baseUrl: URL,
) {
  const credential = `worker_${crypto.randomUUID().replaceAll("-", "")}`;
  await owner.registerNativeWorker({
    workerId: "worker:browser",
    projectId: "project:browser-existing",
    name: "Native browser fixture",
    target: { nodeId: "node:browser", workspaceId: "workspace:browser" },
    ownershipGeneration: 0,
    rex: { sessionId: "session:browser", blockId: "block:browser" },
    credential,
  });
  const worker = new FactoryClient({ baseUrl, credential });
  await worker.postWorkerItem({
    itemId: "question:browser",
    kind: "question",
    title: "Preserve compatibility?",
    text: "The native Pi worker needs a decision before changing the API. Keep the existing field for one release?",
    blocking: true,
  });
  await owner.decideCoordinationItem("question:browser", {
    requestId: "escalation:browser",
    action: "escalate",
    text: "A compatibility change needs your approval.",
  });
  await chooseSelect(page, "PROJECT", "Shared fixture project");
  const agent = await page.evaluateHandle(async () => {
    const entry = "/@id/@ui-sdk/react/agent";
    const { createAgent } = (await import(
      entry
    )) as typeof import("@ui-sdk/react/agent");
    let approved = false;
    return {
      bridge: createAgent({ allow: (step) => !step.confirm || approved }),
      approve: () => {
        approved = true;
      },
    };
  });
  await page
    .getByRole("button", { name: "Factory inbox", exact: true })
    .focus();
  const opened = await agent.evaluate(({ bridge }) =>
    bridge.act({
      steps: [{ ref: "Factory inbox", action: "setOpen", args: [true] }],
    }),
  );
  assert.ok(opened.ok, opened.error?.message ?? "Inbox did not open");
  const dialog = page.getByRole("dialog", {
    name: "Factory inbox",
    exact: true,
  });
  await dialog.getByText("Needs your decision", { exact: true }).waitFor();
  assert.equal(
    await dialog
      .getByRole("heading", { name: "Preserve compatibility?" })
      .count(),
    1,
  );
  assert.equal(await dialog.locator("iframe, canvas, .terminal").count(), 0);
  const contrast = await dialog
    .getByRole("button", { name: "Close inbox", exact: true })
    .evaluate((button) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map((value) => Number(value) / 255)
          .map((value) =>
            value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
          );
        return (
          channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
        );
      };
      const foreground = luminance(getComputedStyle(button).color);
      const background = luminance(
        getComputedStyle(button.closest('[role="dialog"]')!).backgroundColor,
      );
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      );
    });
  assert.ok(
    contrast >= 4.5,
    "Inbox controls need readable text, not inherited white shell text",
  );
  const snapshot = await agent.evaluate(({ bridge }) => bridge.snapshot());
  assert.ok(
    snapshot.some(
      (entry) => entry.label === "Your decision for Preserve compatibility?",
    ),
  );
  assert.ok(snapshot.some((entry) => entry.label === "Send decision"));
  await page.screenshot({
    path: join(output, "factory-inbox-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const footerBounds = await dialog
    .getByRole("button", { name: "Refresh inbox", exact: true })
    .boundingBox();
  assert.ok(
    footerBounds &&
      footerBounds.y >= 0 &&
      footerBounds.y + footerBounds.height <= 844,
    "Inbox footer must remain visible without scrolling the dialog shell",
  );
  const bounds = await dialog.boundingBox();
  assert.ok(
    bounds &&
      bounds.x >= 0 &&
      bounds.x + bounds.width <= 390 &&
      bounds.y >= 0 &&
      bounds.y + bounds.height <= 844,
  );
  await page.screenshot({
    path: join(output, "factory-inbox-mobile.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  for (const name of ["Factory inbox", "Sign out"]) {
    const rect = await page
      .getByRole("button", { name, exact: true, includeHidden: true })
      .boundingBox();
    assert.ok(
      rect &&
        rect.x >= 0 &&
        rect.x + rect.width <= 320 &&
        rect.y + rect.height <= 54,
      "Small-screen header controls must fit the shell",
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const filled = await agent.evaluate(({ bridge }) =>
    bridge.act({
      steps: [
        {
          ref: "Your decision for Preserve compatibility?",
          action: "setValue",
          args: ["Preserve compatibility for one release."],
        },
      ],
    }),
  );
  assert.ok(filled.ok, filled.error?.message ?? "Decision was not filled");
  const refused = await agent.evaluate(({ bridge }) =>
    bridge.act({ steps: [{ ref: "Send decision", action: "press" }] }),
  );
  assert.equal(refused.ok, false);
  assert.deepEqual((await worker.getWorkerMailbox()).messages, []);
  const requests: string[] = [];
  const route = "**/v1/coordination/*/decisions";
  await page.route(route, async (request) => {
    requests.push(request.request().postData()!);
    if (requests.length === 1) {
      await request.fetch();
      await request.abort("connectionreset");
    } else await request.continue();
  });
  try {
    const sent = await agent.evaluate(({ bridge, approve }) => {
      approve();
      return bridge.act({ steps: [{ ref: "Send decision", action: "press" }] });
    });
    assert.ok(sent.ok, sent.error?.message ?? "Decision was not sent");
    await dialog
      .getByRole("button", { name: "Retry decision", exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "Retry decision", exact: true })
      .click();
    await dialog.getByText("Answer queued", { exact: true }).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    const mailbox = await worker.getWorkerMailbox();
    assert.equal(mailbox.messages.length, 1);
    assert.equal(
      mailbox.messages[0]!.text,
      "Preserve compatibility for one release.",
    );
    await worker.acknowledgeWorkerMessage(mailbox.messages[0]!.messageId);
    await dialog
      .getByRole("button", { name: "Refresh inbox", exact: true })
      .click();
    await dialog.getByText("Received by worker", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("button", { name: "Factory inbox", exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    );
  } finally {
    await page.unroute(route);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await agent.dispose();
  console.info(
    "PASS: Factory inbox agent confirmation, mobile controls/contrast/focus, lost-answer retry and worker acknowledgement through the real API.",
  );
}
