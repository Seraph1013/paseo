import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import {
  expectComposerDraft,
  fillComposerDraft,
  submitMessageWithButton,
} from "../support/helpers/composer";

if (process.env.E2E_BROWSER_CHANNEL) {
  test.use({ channel: process.env.E2E_BROWSER_CHANNEL });
}

test("plugin draft insertion preserves edits, refuses stale writes, and observes accepted submission", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "plugin-composer-draft-" });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Composer draft capability",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-composer-draft-"));
  const pluginClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await pluginClient.getDaemonConfig();
  const pluginId = "composer-draft-fixture";
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: pluginId, requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `
export default function contribute(client) {
  const agentId = ${JSON.stringify(agent.id)};
  const workspaceId = ${JSON.stringify(workspace.workspaceId)};
  let captured;
  let unsubscribe = () => {};
  let observing = false;
  const registrations = [];
  const pill = (id, title, onPress) => {
    const registration = client.addComposerPill({ id, workspaceId, agentId,
      button: { title, label: title, icon: "TextCursorInput", behavior: { kind: "action", onPress } } });
    registrations.push(registration);
    return registration;
  };
  const inserted = pill("insert", "Insert fixture snippets", () => {
    const draft = client.composer.ref(agentId).getDraft();
    if (!observing) {
      observing = true;
      unsubscribe = client.composer.ref(agentId).subscribe( (next) => {
        inserted.update({ label: "Submissions: " + next.submissionRevision });
      });
    }
    client.composer.ref(agentId).replaceDraft({ revision: draft.revision, text: "PREPEND\\n\\n" + draft.text + "\\n\\nAPPEND" });
  });
  pill("capture", "Capture draft revision", () => { captured = client.composer.ref(agentId).getDraft(); });
  pill("stale", "Apply stale draft", () => { client.composer.ref(agentId).replaceDraft({ revision: captured.revision, text: "MUST NOT OVERWRITE" }); });
  return () => { unsubscribe(); for (const registration of registrations) registration.remove(); };
}
`,
  );
  try {
    await pluginClient.patchDaemonConfig({ pluginsEnabled: true });
    await pluginClient.installDirectoryPlugin(directory);
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ sendBehavior: "queue", language: "en" }),
      );
    });
    await gotoAppShell(page);
    await page.goto(buildAgentRoute(workspace.workspaceId, agent.id));
    await expect(
      page.getByRole("button", { name: "Insert fixture snippets", exact: true }),
    ).toBeVisible();

    await fillComposerDraft(page, "USER BODY");
    await page.getByRole("button", { name: "Insert fixture snippets", exact: true }).click();
    await expectComposerDraft(page, "PREPEND\n\nUSER BODY\n\nAPPEND");

    await page.getByRole("button", { name: "Capture draft revision", exact: true }).click();
    await fillComposerDraft(page, "PREPEND\n\nUSER BODY EDITED\n\nAPPEND");
    await page.getByRole("button", { name: "Apply stale draft", exact: true }).click();
    await expect(page.getByText(/Your draft changed/)).toBeVisible();
    await expectComposerDraft(page, "PREPEND\n\nUSER BODY EDITED\n\nAPPEND");

    await submitMessageWithButton(page, "PREPEND\n\nUSER BODY EDITED\n\nAPPEND");
    await expectComposerDraft(page, "");
    await expect(
      page.getByRole("button", { name: "Insert fixture snippets", exact: true }),
    ).toHaveText("Submissions: 1");
    await fillComposerDraft(page, "QUEUED BODY");
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await expectComposerDraft(page, "");
    await expect(
      page.getByRole("button", { name: "Insert fixture snippets", exact: true }),
    ).toHaveText("Submissions: 2");
  } finally {
    await pluginClient.removePlugin(pluginId).catch(() => undefined);
    await pluginClient.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await pluginClient.close();
    await workspace.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
