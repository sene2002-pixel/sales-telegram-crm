import { expect, test } from '@playwright/test';
import { clients, prepareDemoAuth } from './helpers';

for (const width of [320, 1440]) {
  test(`Client search keeps filter and closes on Done at ${width}`, async ({ page }, info) => {
    test.skip(width > 760 && info.project.name === 'mobile', 'Portrait-only mobile application');
    await page.setViewportSize({ width, height: 844 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Администратор', exact: true }).click();
    await expect(page.locator('.app-shell')).toBeVisible();
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const suffix = `${Date.now()}-${width}-${info.project.name}`;
    const names = [`Зенит QA ${suffix}`, `Маяк QA ${suffix}`];
    for (const name of names) {
      const response = await page.request.post('/api/companies', {
        headers: { Authorization: `Bearer ${token}` },
        data: { name },
      });
      expect(response.ok(), `company create status ${response.status()}`).toBeTruthy();
    }
    await page.reload();
    await clients(page);
    const first = page.locator('.cc-card').filter({ hasText: names[0] });
    const second = page.locator('.cc-card').filter({ hasText: names[1] });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    const field = page.getByRole('textbox', { name: 'Поиск компаний' });
    const shell = field.locator('..');
    await expect(field).toHaveAttribute('enterkeyhint', 'done');
    await expect(field).toHaveAttribute('placeholder', 'Поиск клиента, компании или контакта');
    await field.click();
    await expect(field).toBeFocused();
    await expect(field).toHaveCSS('outline-style', 'none');
    await expect(field).toHaveCSS('box-shadow', 'none');
    await expect(shell).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(shell).toHaveCSS('border-top-color', 'rgb(230, 235, 243)');
    await field.fill(names[0]);
    await expect(first).toBeVisible();
    await expect(second).toHaveCount(0);
    await field.press('Enter');
    await expect(field).not.toBeFocused();
    await expect(field).toHaveValue(names[0]);
    await expect(first).toBeVisible();
    await expect(second).toHaveCount(0);
    await field.fill('');
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await field.focus();
    await field.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
      ),
    );
    await expect(field).toBeFocused();
  });
}
