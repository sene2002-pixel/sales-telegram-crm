import { expect, test } from '@playwright/test';
import { prepareDemoAuth } from './helpers';

test('Pico avatar loads and authenticated menus have no logout action', async ({ page }, info) => {
  await prepareDemoAuth(page);
  await page.goto('/');
  const avatar = page.getByRole('img', { name: 'Pico — AI-помощник' });
  await expect(avatar).toHaveJSProperty('naturalWidth', 1254);
  await expect(avatar).toHaveAttribute('src', /\/assets\/pico-avatar-[^/]+\.png$/);
  await page.screenshot({ path: info.outputPath('pico-login.png') });
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByTitle('Выйти', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
  await expect(page.locator('.pico-more-menu')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toHaveCount(0);
});
