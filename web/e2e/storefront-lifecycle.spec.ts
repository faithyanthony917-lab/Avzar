import { test, expect, type Page } from '@playwright/test';

const email = process.env.PLAYWRIGHT_EMAIL;
const password = process.env.PLAYWRIGHT_PASSWORD;
const allowMutations = process.env.PLAYWRIGHT_ALLOW_MUTATIONS === 'true';
const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const configured = Boolean(email && password && allowMutations);
const safeTarget = (() => {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host.split('.').some((label) => label.includes('staging'));
  } catch { return false; }
})();

async function signIn(page: Page) {
  await page.goto('/login?next=%2Fstorefront');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Some accounts belong to multiple businesses; select the intended business if configured.
  const businessSelect = page.getByLabel('Business');
  if (process.env.PLAYWRIGHT_BUSINESS_ID && await businessSelect.isVisible().catch(() => false)) {
    await businessSelect.selectOption(process.env.PLAYWRIGHT_BUSINESS_ID);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page).toHaveURL(/\/storefront(?:$|\?)/, { timeout: 45_000 });
}

test.describe('storefront editing, publishing and rollback', () => {
  test.skip(!configured, 'Requires staging credentials and PLAYWRIGHT_ALLOW_MUTATIONS=true. Never run mutation tests against production.');
  test.skip(!safeTarget, 'Mutation E2E tests are restricted to staging or localhost.');

  test('creates a draft, edits it, publishes versions and restores an earlier version', async ({ page }) => {
    // The test creates a dedicated storefront and publishes test versions; use a staging business.
    page.on('dialog', (dialog) => dialog.accept());
    await signIn(page);

    const name = `Avzar E2E ${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await page.getByLabel('Storefront name').fill(name);
    await page.getByRole('button', { name: 'Create storefront' }).click();
    await expect(page.getByRole('heading', { name }).first()).toBeVisible({ timeout: 30_000 });

    const pageTitle = page.getByLabel('Page title');
    await expect(pageTitle).toBeVisible();
    await pageTitle.fill('E2E first version');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(/Draft saved\. Visitors still see the published version until you publish\./i)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Publish saved draft' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Published version 1/i })).toBeVisible({ timeout: 30_000 });

    await pageTitle.fill('E2E second version');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByRole('button', { name: 'Publish saved draft' }).click();
    await expect(page.getByText(/Published version 2/i)).toBeVisible({ timeout: 30_000 });

    const firstVersion = page.getByRole('row').filter({ hasText: 'v1' });
    await expect(firstVersion).toBeVisible();
    await firstVersion.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText(/Rollback published as version 3/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('row').filter({ hasText: /Rollback from v1/i })).toBeVisible();
  });
});
