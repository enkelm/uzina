import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";

export async function verifyUiSdk(page: Page, output: string) {
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
  for (const entry of visible) {
    assert.ok(
      entry.label,
      `${entry.component} ${entry.ref} has no accessible name`,
    );
  }
  for (const label of [
    "PROJECT",
    "Search Work items",
    "Open Work item by ID",
    "Create project",
    "Create Work item",
    "Sign out",
  ]) {
    assert.ok(
      visible.some((entry) => entry.label === label),
      `${label} is absent from the agent snapshot`,
    );
  }

  const initial = snapshot.find((entry) => entry.label === "PROJECT");
  assert.ok(initial);
  const projectChoices = await agent.evaluate(
    ({ bridge }, ref) => bridge.query({ within: ref }),
    initial.ref,
  );
  assert.ok(!("error" in projectChoices), JSON.stringify(projectChoices));
  const other = projectChoices[0]?.items?.find(
    (item) => item.value !== initial?.value,
  );
  assert.ok(other);
  const switchProject = await agent.evaluate(
    ({ bridge }, args) =>
      bridge.act({
        steps: [{ ref: args.ref, action: "setValue", args: [args.value] }],
      }),
    { ref: initial.ref, value: other.label },
  );
  assert.ok(switchProject.ok, switchProject.error?.message ?? "Switch failed");
  await page.waitForURL(
    (url) => url.searchParams.get("project") === other.value,
  );
  const restore = await agent.evaluate(
    ({ bridge }, args) =>
      bridge.act({
        steps: [{ ref: args.ref, action: "setValue", args: [args.value] }],
      }),
    { ref: initial.ref, value: initial.value },
  );
  assert.ok(restore.ok, restore.error?.message ?? "Restore failed");
  await page.getByRole("button", { name: /^Original work / }).waitFor();

  const search = await agent.evaluate(({ bridge }) =>
    bridge.act({
      steps: [
        {
          ref: "Search Work items",
          action: "setValue",
          args: ["Original work"],
        },
      ],
    }),
  );
  assert.ok(search.ok, search.error?.message ?? "Search failed");
  await page.getByRole("button", { name: /^Original work / }).waitFor();
  assert.equal(
    await page
      .getByRole("navigation", { name: "Work items", exact: true })
      .getByRole("button")
      .count(),
    1,
  );
  assert.equal(
    await page.getByLabel("Search Work items", { exact: true }).inputValue(),
    "Original work",
  );
  const clear = await agent.evaluate(({ bridge }) =>
    bridge.act({
      steps: [
        { ref: "Search Work items", action: "clear" },
        { ref: "Open Work item by ID", action: "setOpen", args: [true] },
        {
          ref: "Work item ID",
          action: "setValue",
          args: ["thread:agent-draft"],
        },
      ],
    }),
  );
  assert.ok(clear.ok, clear.error?.message ?? "Clear failed");
  assert.equal(
    await page.getByLabel("Work item ID", { exact: true }).inputValue(),
    "thread:agent-draft",
  );
  const closeId = await agent.evaluate(({ bridge }) =>
    bridge.act({
      steps: [
        { ref: "Work item ID", action: "clear" },
        { ref: "Open Work item by ID", action: "setOpen", args: [false] },
        { ref: "Create project", action: "setOpen", args: [true] },
      ],
    }),
  );
  assert.ok(closeId.ok, closeId.error?.message ?? "Close failed");

  const projectDialog = page.getByRole("dialog", {
    name: "Create project",
    exact: true,
  });
  await projectDialog.waitFor();
  await projectDialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  assert.equal(
    await page
      .getByLabel("Project name", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
    "An empty required project name must prevent submission",
  );
  const projectDraft = await agent.evaluate(({ bridge }) =>
    bridge.act({
      steps: [
        {
          ref: "Project name",
          action: "setValue",
          args: ["Agent project draft"],
        },
      ],
    }),
  );
  assert.ok(projectDraft.ok, projectDraft.error?.message ?? "Fill failed");
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Agent project draft",
  );
  await projectDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await projectDialog.waitFor({ state: "hidden" });
  const resetProject = await agent.evaluate(({ bridge }) =>
    bridge.act({
      steps: [
        { ref: "Create project", action: "setOpen", args: [true] },
        { ref: "Project name", action: "clear" },
        { ref: "Create project", action: "press", args: ["Close"] },
        { ref: "Create Work item", action: "setOpen", args: [true] },
      ],
    }),
  );
  assert.ok(resetProject.ok, resetProject.error?.message ?? "Reset failed");

  const workDialog = page.getByRole("dialog", {
    name: "Create Work item",
    exact: true,
  });
  await workDialog.waitFor();
  const node = page.getByRole("combobox", {
    name: "Execution node",
    exact: true,
  });
  const workspace = page.getByRole("combobox", {
    name: "Workspace",
    exact: true,
  });
  assert.equal(await node.textContent(), "Choose a node");
  assert.equal(await workspace.isDisabled(), true);
  const choices = await agent.evaluate(({ bridge }) =>
    bridge.query({ within: "Execution node" }),
  );
  assert.ok(!("error" in choices), JSON.stringify(choices));
  if ("error" in choices) throw new Error(String(choices.error));
  const nodes = choices.flatMap((entry) => entry.items ?? []);
  assert.ok(nodes.length >= 2);
  const firstNode = nodes.find((item) =>
    item.label.includes("Disposable test node"),
  );
  const otherNode = nodes.find((item) => item.value !== firstNode?.value);
  assert.ok(firstNode && otherNode);
  const setNode = await agent.evaluate(
    ({ bridge }, label) =>
      bridge.act({
        steps: [{ ref: "Execution node", action: "setValue", args: [label] }],
      }),
    firstNode.label,
  );
  assert.ok(setNode.ok, setNode.error?.message ?? "Select failed");
  const workspaceChoices = await agent.evaluate(({ bridge }) =>
    bridge.query({ within: "Workspace" }),
  );
  assert.ok(!("error" in workspaceChoices), JSON.stringify(workspaceChoices));
  if ("error" in workspaceChoices)
    throw new Error(String(workspaceChoices.error));
  const firstWorkspace = workspaceChoices.flatMap(
    (entry) => entry.items ?? [],
  )[0];
  assert.ok(firstWorkspace);
  const setWorkspace = await agent.evaluate(
    ({ bridge }, label) =>
      bridge.act({
        steps: [{ ref: "Workspace", action: "setValue", args: [label] }],
      }),
    firstWorkspace.label,
  );
  assert.ok(setWorkspace.ok, setWorkspace.error?.message ?? "Select failed");
  assert.equal(await node.textContent(), firstNode.label);
  assert.equal(await workspace.textContent(), firstWorkspace.label);
  await workDialog
    .getByRole("button", { name: "Create Work item", exact: true })
    .click();
  assert.equal(
    await page
      .getByLabel("Work item name", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
    "An empty required Work item name must prevent submission",
  );
  const changeNode = await agent.evaluate(
    ({ bridge }, label) =>
      bridge.act({
        steps: [
          {
            ref: "Work item name",
            action: "setValue",
            args: ["Agent work draft"],
          },
          { ref: "Execution node", action: "setValue", args: [label] },
        ],
      }),
    otherNode.label,
  );
  assert.ok(changeNode.ok, changeNode.error?.message ?? "Change failed");
  assert.equal(
    await workspace.textContent(),
    "Choose a Workspace",
    "Changing nodes must clear the previous node's Workspace",
  );
  assert.equal(
    await page.getByLabel("Work item name", { exact: true }).inputValue(),
    "Agent work draft",
  );
  await workDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const reopen = await agent.evaluate(({ bridge }) =>
    bridge.act({
      steps: [
        { ref: "Create Work item", action: "setOpen", args: [true] },
        { ref: "Work item name", action: "clear" },
      ],
    }),
  );
  assert.ok(reopen.ok, reopen.error?.message ?? "Open failed");
  assert.equal(
    await node.textContent(),
    "Choose a node",
    "Agent-opened dialogs must reset explicit placement too",
  );
  assert.equal(await workspace.isDisabled(), true);
  await workDialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Create Work item" }).click();

  await node.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  const highlighted = page.getByRole("option").first();
  const keyboardChoice = await highlighted.textContent();
  await page.keyboard.press("Enter");
  assert.equal(await node.textContent(), keyboardChoice);
  assert.equal(
    await node.evaluate((el) => el === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace.click();
  await page.screenshot({
    path: join(output, "ui-sdk-workspace-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.keyboard.press("Escape");
  await workDialog.waitFor();
  await workDialog.getByRole("button", { name: "Close", exact: true }).click();
  await workDialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(
    await page
      .getByRole("button", { name: "Create Work item", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
    "Closing a dialog must restore its trigger focus",
  );
  console.log(
    "PASS: ui-sdk agent discovery, controlled fields, dependent targets, required forms, keyboard selection and mobile nested popups.",
  );
  return agent;
}

export async function sendWithUiSdk(
  page: Page,
  agent: Awaited<ReturnType<typeof verifyUiSdk>>,
  text: string,
) {
  try {
    const names = await agent.evaluate(({ bridge }) => bridge.snapshot());
    for (const entry of names) {
      if (!entry.offPage && entry.component !== "more") assert.ok(entry.label);
    }
    const fill = await agent.evaluate(
      ({ bridge }, value) =>
        bridge.act({
          steps: [{ ref: "Message", action: "setValue", args: [value] }],
        }),
      text,
    );
    assert.ok(fill.ok, fill.error?.message ?? "Fill failed");
    assert.equal(
      await page.getByLabel("Message", { exact: true }).inputValue(),
      text,
    );
    const refused = await agent.evaluate(({ bridge }) =>
      bridge.act({ steps: [{ ref: "Send input", action: "press" }] }),
    );
    assert.equal(refused.ok, false, "Sending input needs a person's approval");
    assert.equal(
      await page.getByLabel("Message", { exact: true }).inputValue(),
      text,
    );
    const sent = await agent.evaluate(({ bridge, approve }) => {
      approve();
      return bridge.act({ steps: [{ ref: "Send input", action: "press" }] });
    });
    assert.ok(sent.ok, sent.error?.message ?? "Send failed");
  } finally {
    await agent.dispose();
  }
}
