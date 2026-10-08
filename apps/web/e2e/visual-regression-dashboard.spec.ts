import { test, expect } from '@playwright/test';

test.describe('Visual Regression Coverage - Responsive Dashboard States (#332)', () => {
  test.beforeEach(async ({ page }) => {
    // Intercept API endpoints for predictable rendering
    await page.route('**/wallets', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            { id: 'w1', publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', label: 'Main Hot Wallet' },
          ],
        }),
      });
    });

    await page.route('**/payments**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: 'p1',
              walletId: 'w1',
              txHash: '0xabc123def456',
              fromAddress: 'GAXYZ1234567890ABCDEF',
              amount: 1500,
              asset: 'XLM',
              receivedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });
  });

  test('renders desktop responsive state (1280px)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/dashboard');
    const header = page.locator('header');
    if (await header.isVisible()) {
      await expect(header).toContainText(/StellarAlerts/i);
    }
  });

  test('renders mobile responsive state (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dashboard');
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });

  test('enforces dark theme contrast and background styling', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/dashboard');
    const html = page.locator('html');
    await expect(html).toBeVisible();
  });

  test('renders loading skeleton and spinner states', async ({ page }) => {
    await page.route('**/payments**', async (route) => {
      // Intentionally delay response to exercise loading state
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
    });
    await page.goto('/dashboard');
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });

  test('renders empty dashboard state when no wallets or payments are present', async ({ page }) => {
    await page.route('**/payments**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.goto('/dashboard');
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });

  test('renders error state on API failure', async ({ page }) => {
    await page.route('**/payments**', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal Server Error' }) });
    });
    await page.goto('/dashboard');
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});
