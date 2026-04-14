import { expect, test } from '@playwright/test';

test('renders a data URL page', async ({ page }) => {
  await page.goto('data:text/html,<h1>Hello Mergify</h1>');
  await expect(page.locator('h1')).toHaveText('Hello Mergify');
});
