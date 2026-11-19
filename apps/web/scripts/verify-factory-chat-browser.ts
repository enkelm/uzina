import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";
import type { FactoryClient } from "@uzina/client";
import { chooseSelect } from "./browser-controls";

export async function verifyFactoryChat(
  page: Page,
  output: string,
  owner: FactoryClient,
  ownerCredential: string,
  viewerCredential: string,
) {
  const origin = new URL(page.url()).origin;
  const first =
    "Factory chat smoke test: inspect my projects, without starting a worker.";
  const second =
    "Factory chat recovery test: keep this as a separate private input.";
  const answer =
    "The browser used the real local Pi runtime with deterministic external model transport.";
  const dialog = page.getByRole("dialog", {
    name: "Factory chat",
    exact: true,
  });
  const trigger = page.getByRole("button", {
    name: "Factory chat",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await dialog.getByText("Coordinator ready", { exact: false }).waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Send to Factory", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await dialog.locator("iframe, canvas, .terminal").count(), 0);
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
  const snapshot = await agent.evaluate(({ bridge }) => bridge.snapshot());
  const visible = snapshot.filter(
    (entry) => !entry.offPage && entry.component !== "more",
  );
  for (const entry of visible)
    assert.ok(entry.label, `${entry.component} has no accessible name`);
  for (const label of [
    "Factory chat",
    "Message to Factory",
    "Send to Factory",
    "Refresh chat",
  ])
    assert.ok(
      snapshot.some((entry) => entry.label === label),
      `${label} is absent from the agent snapshot`,
    );
  assert.ok(
    snapshot
      .find((entry) => entry.label === "Factory chat")
      ?.buttons?.includes("Close chat"),
  );
  const fill = await agent.evaluate(
    ({ bridge }, text) =>
      bridge.act({
        steps: [
          { ref: "Message to Factory", action: "setValue", args: [text] },
        ],
      }),
    first,
  );
  assert.ok(fill.ok, fill.error?.message ?? "Factory input was not filled");
  const refused = await agent.evaluate(({ bridge }) =>
    bridge.act({ steps: [{ ref: "Send to Factory", action: "press" }] }),
  );
  assert.equal(refused.ok, false);
  assert.ok(
    !JSON.stringify(await owner.getPrivateAssistantContext()).includes(first),
  );
  const requests: string[] = [];
  const inputRoute = "**/v1/private-assistant/inputs";
  await page.route(inputRoute, async (route) => {
    requests.push(route.request().postData()!);
    if (requests.length === 1) {
      const response = await route.fetch();
      assert.ok(response.ok());
      await response.dispose();
      await route.abort("connectionreset");
    } else if (requests.length === 2) await route.abort("connectionreset");
    else await route.continue();
  });
  try {
    const sent = await agent.evaluate(({ bridge, approve }) => {
      approve();
      return bridge.act({
        steps: [{ ref: "Send to Factory", action: "press" }],
      });
    });
    assert.ok(sent.ok, sent.error?.message ?? "Factory input was not sent");
    await dialog.getByRole("alert").waitFor();
    assert.equal(
      await dialog
        .getByLabel("Message to Factory", { exact: true })
        .getAttribute("readonly"),
      "",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await trigger.evaluate((element) => element === document.activeElement),
      true,
    );
    await chooseSelect(page, "PROJECT", "Later project");
    await trigger.click();
    await dialog.getByText("Coordinator ready", { exact: false }).waitFor();
    assert.equal(
      await dialog
        .getByLabel("Message to Factory", { exact: true })
        .inputValue(),
      first,
    );
    assert.equal(
      await dialog
        .getByLabel("Message to Factory", { exact: true })
        .getAttribute("readonly"),
      "",
      "Uncertain input must remain locked after closing/reopening and changing projects",
    );
    await dialog
      .getByRole("button", { name: "Reconcile Factory input", exact: true })
      .click();
    await dialog.getByText("Reply complete", { exact: true }).waitFor();
    await dialog
      .getByRole("region", { name: "Factory conversation", exact: true })
      .getByText(answer, { exact: true })
      .waitFor();
    assert.equal(
      requests.length,
      1,
      "A committed lost reply is recovered by reading its receipt, not a new submission",
    );
    const receipt = await owner.getPrivateAssistantReceipt(
      JSON.parse(requests[0]!).inputId,
    );
    assert.equal(receipt.inputId, JSON.parse(requests[0]!).inputId);
    assert.deepEqual(
      (
        await owner.listThreads({ projectId: "project:later-browser" })
      ).threads.map((thread) => thread.threadId),
      ["thread:later-browser"],
      "Private chat must not create a managed Work conversation",
    );
    const contrast = await dialog
      .getByRole("button", { name: "Close chat", exact: true })
      .evaluate((button) => {
        const luminance = (color: string) => {
          const c = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => v / 255)
            .map((v) =>
              v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
            );
          return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;
        };
        const fg = luminance(getComputedStyle(button).color),
          bg = luminance(
            getComputedStyle(button.closest('[role="dialog"]')!)
              .backgroundColor,
          );
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
    assert.ok(
      contrast >= 4.5,
      "Factory chat must not inherit the shell's white text on white dialog controls",
    );
    await page.screenshot({
      path: join(output, "factory-chat-desktop.png"),
      fullPage: true,
    });
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(size);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      const bounds = await dialog.boundingBox();
      assert.ok(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= size.width &&
          bounds.y + bounds.height <= size.height,
      );
      for (const name of ["Close chat", "Send to Factory"]) {
        const rect = await dialog
          .getByRole("button", { name, exact: true })
          .boundingBox();
        assert.ok(
          rect && rect.y >= 0 && rect.y + rect.height <= size.height,
          `${name} must stay on screen`,
        );
      }
      await page.keyboard.press("Escape");
      for (const name of ["Factory chat", "Factory inbox", "Sign out"]) {
        const rect = await page
          .getByRole("button", { name, exact: true })
          .boundingBox();
        assert.ok(
          rect &&
            rect.x >= 0 &&
            rect.x + rect.width <= size.width &&
            rect.y + rect.height <= 54,
          `${name} must fit the narrow header`,
        );
      }
      await trigger.click();
      await dialog.getByText("Coordinator ready", { exact: false }).waitFor();
      if (size.width === 390)
        await page.screenshot({
          path: join(output, "factory-chat-mobile.png"),
          fullPage: true,
        });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const input = dialog.getByLabel("Message to Factory", { exact: true });
    await input.fill(second);
    await input.press("Shift+Enter");
    assert.equal(await input.inputValue(), `${second}\n`);
    assert.equal(requests.length, 1);
    await input.press("Enter");
    await dialog.getByRole("alert").waitFor();
    await dialog
      .getByRole("button", { name: "Reconcile Factory input", exact: true })
      .click();
    await dialog.getByText("Reply complete", { exact: true }).waitFor();
    assert.equal(requests.length, 3);
    assert.equal(
      requests[1],
      requests[2],
      "Absent receipts retry the exact original input identity and bytes",
    );
    const canonical = await owner.getPrivateAssistantContext();
    const messages = canonical.messages as Array<{
      role: string;
      content: unknown;
    }>;
    for (const text of [first, second])
      assert.equal(
        messages.filter(
          (entry) =>
            entry.role === "user" &&
            JSON.stringify(entry.content).includes(text),
        ).length,
        1,
      );
  } finally {
    await page.unroute(inputRoute);
  }

  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const captured = new Promise<void>((resolve) => {
    started = resolve;
  });
  let completed!: () => void;
  const finished = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const contextRoute = "**/v1/private-assistant/context";
  await page.route(
    contextRoute,
    async (route) => {
      const response = await route.fetch();
      try {
        assert.ok(response.ok());
        started();
        await gate;
        try {
          await route.fulfill({ response });
        } catch (error) {
          if (!route.request().failure()) throw error;
        }
      } finally {
        await response.dispose();
        completed();
      }
    },
    { times: 1 },
  );
  const accountTab = await page.context().newPage();
  try {
    await dialog
      .getByLabel("Message to Factory", { exact: true })
      .fill("Owner-only unsent Factory draft");
    await dialog
      .getByRole("button", { name: "Refresh chat", exact: true })
      .click();
    await captured;
    const login = async (credential: string) => {
      await accountTab.goto(
        `${new URL(page.url()).origin}/login?token=${encodeURIComponent(credential)}`,
      );
      await accountTab
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
    };
    await login(viewerCredential);
    await page.getByText("viewer", { exact: true }).waitFor();
    release();
    await finished;
    assert.equal(
      await page
        .getByRole("button", { name: "Factory chat", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.getByText(first, { exact: true }).count(), 0);
    assert.equal(
      (
        await page.request.get(`${origin}/v1/private-assistant/context`)
      ).status(),
      403,
    );
    await login(ownerCredential);
    await page.getByText("owner", { exact: true }).waitFor();
    await trigger.click();
    await dialog.getByText("Coordinator ready", { exact: false }).waitFor();
    assert.equal(
      await dialog
        .getByLabel("Message to Factory", { exact: true })
        .inputValue(),
      "",
    );
    await dialog
      .getByRole("region", { name: "Factory conversation", exact: true })
      .getByText(first, { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    const response = await page.request.get(`${origin}/v1/credentials`);
    assert.ok(response.ok());
    const coordinator = (await response.json()).credentials.find(
      (credential: { name: string }) =>
        credential.name === "Private Factory assistant",
    );
    assert.ok(coordinator);
    assert.ok(
      (
        await page.request.post(
          `${origin}/v1/credentials/${encodeURIComponent(coordinator.credentialId)}/revoke`,
        )
      ).ok(),
    );
    await dialog
      .getByRole("button", { name: "Refresh chat", exact: true })
      .click();
    await dialog.getByText("Coordinator parked.", { exact: false }).waitFor();
    assert.equal(
      await dialog
        .getByRole("button", { name: "Send to Factory", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await dialog
        .getByRole("region", { name: "Factory conversation", exact: true })
        .getByText(first, { exact: true })
        .count(),
      1,
    );
    await dialog
      .getByRole("button", { name: "Close chat", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await trigger.evaluate((element) => element === document.activeElement),
      true,
    );
  } finally {
    release();
    await accountTab.close();
    await page.unroute(contextRoute);
    await agent.dispose();
  }
  await chooseSelect(page, "PROJECT", "Shared fixture project");
  console.info(
    "PASS: Owner Factory chat, real private Pi context/receipts, lost-before/after-admission recovery, keyboard/mobile/agent controls, parked identity, and late Owner context fenced after account switch.",
  );
}
