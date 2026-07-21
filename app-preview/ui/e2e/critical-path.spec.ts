/**
 * Run this smoke suite outside the sandbox:
 * 1. Install dependencies and Chromium: `cd ui && npm install && npx playwright install chromium`.
 * 2. Start the orchestrator: `cd orchestrator && npm install && npm run dev` (port 7071).
 * 3. In another terminal, start the UI: `cd ui && npm start` (port 4200, proxying `/api`).
 * 4. In a third terminal, run: `cd ui && npm run e2e`.
 *    Set `PLAYWRIGHT_BASE_URL` if the UI is running on a different origin.
 */
import { expect, test } from '@playwright/test';

test('creates a chat, renders the turn stream, and restores history after reload', async ({
  page,
}) => {
  const prompt = `Add a visible heading that reads "E2E persistence ${Date.now()}" to the home page.`;

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What do you want to create?' })).toBeVisible();

  await page.getByPlaceholder('Ask ng-v0 to build…').fill(prompt);
  await page.getByRole('button', { name: 'Start building' }).click();

  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const activity = page.getByRole('log', { name: 'Generation activity' });
  const turn = activity.locator('app-turn-block').filter({ hasText: prompt }).last();
  await expect(turn.locator('[data-user-prompt]')).toHaveText(prompt);

  const versionChip = turn.locator('[data-version-chip]');
  await expect(versionChip).toBeVisible({ timeout: 8 * 60 * 1000 });

  const assistantNarration = turn.locator('section p').first();
  await expect(assistantNarration).toHaveText(/\S/);
  const assistantText = (await assistantNarration.innerText()).trim();

  await page.reload();

  const restoredTurn = page
    .getByRole('log', { name: 'Generation activity' })
    .locator('app-turn-block')
    .filter({ hasText: prompt })
    .last();
  await expect(restoredTurn.locator('[data-user-prompt]')).toHaveText(prompt);
  await expect(restoredTurn.locator('section p').first()).toHaveText(assistantText);
  await expect(restoredTurn.locator('[data-version-chip]')).toBeVisible();

  // The full version-history modal now lives on the workspace toolbar; the
  // in-stream chip is the inline representation of the same versions.
  await page.getByRole('button', { name: 'Version history' }).click();
  await expect(page.getByRole('dialog', { name: 'Version history' })).toBeVisible();
});

test('resolves a server-created custom project route', async ({ page, request }) => {
  const projectName = `Playwright project ${Date.now()}`;
  const response = await request.post('/api/projects', { data: { name: projectName } });
  expect(response.ok()).toBe(true);
  const project = (await response.json()) as { id: string };

  await page.goto(`/projects/${encodeURIComponent(project.id)}`);

  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
});
