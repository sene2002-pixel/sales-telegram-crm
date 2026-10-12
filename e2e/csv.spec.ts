import { createHmac } from 'node:crypto';
import { navigate, prepareDemoAuth } from './helpers';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => prepareDemoAuth(page));

// Use a real numeric local actor: authoritative /me must not trust altered dev-auth UI data.
let csvSession = '';
test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  if (!csvSession) {
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const response = await page.request.post('/api/users', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        telegramId: String(Date.now()) + String(Math.floor(Math.random() * 100)),
        name: 'CSV Аудит',
        role: 'admin',
        active: true,
      },
    });
    expect(response.ok()).toBeTruthy();
    const actor = await response.json();
    const payload = Buffer.from(
      JSON.stringify({ sub: actor.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    csvSession =
      payload +
      '.' +
      createHmac('sha256', 'e2e-local-secret-not-a-production-secret')
        .update(payload)
        .digest('base64url');
  }
  await page.evaluate((value) => sessionStorage.setItem('crm-session', value), csvSession);
  await page.reload();
  await navigate(page, 'Команда');
});

test('CSV browser download has dated filename', async ({ page }) => {
  const file = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт CSV', exact: true }).click();
  expect((await file).suggestedFilename()).toMatch(
    /^team-report-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/,
  );
});

test('CSV bot delivery button reports success and errors without redirecting', async ({ page }) => {
  await page.route('**/api/dashboard/export-bot', async (route) => {
    expect(Object.keys(route.request().postDataJSON()).sort()).toEqual(['from', 'to']);
    await route.fulfill({ json: { sent: true } });
  });
  await page.getByRole('button', { name: 'Получить CSV в боте' }).click();
  await expect(page.getByRole('status')).toContainText('CSV отправлен');
  await page.route('**/api/dashboard/export-bot', (route) =>
    route.fulfill({ status: 502, json: { message: 'Не удалось отправить CSV' } }),
  );
  await page.getByRole('button', { name: 'Получить CSV в боте' }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось отправить CSV');
});

test('CSV Telegram native download uses issued HTTPS link and reports cancellation', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.Telegram = {
      WebApp: {
        initData: 'test',
        ready() {},
        expand() {},
        isVersionAtLeast: () => true,
        downloadFile(params, callback) {
          (window as any).csvParams = params;
          callback?.(false);
        },
      },
    };
  });
  await page.route('**/api/dashboard/export-link', async (route) => {
    expect(route.request().headers().authorization).toMatch(/^Bearer /);
    expect(Object.keys(route.request().postDataJSON()).sort()).toEqual(['from', 'to']);
    await route.fulfill({
      json: {
        url: 'https://crm.example.test/api/downloads/csv/test-ticket',
        filename: 'team-report.csv',
      },
    });
  });
  await page.getByRole('button', { name: 'Экспорт CSV', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Скачивание отменено');
  expect(await page.evaluate(() => (window as any).csvParams)).toEqual({
    url: 'https://crm.example.test/api/downloads/csv/test-ticket',
    file_name: 'team-report.csv',
  });
});

test('CSV old Telegram explains fallback; API failure is visible', async ({ page }) => {
  await page.evaluate(() => {
    window.Telegram = {
      WebApp: { initData: 'test', ready() {}, expand() {}, isVersionAtLeast: () => false },
    };
  });
  await page.getByRole('button', { name: 'Экспорт CSV', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Получить CSV в боте');
  await page.evaluate(() => {
    window.Telegram!.WebApp!.isVersionAtLeast = () => true;
    window.Telegram!.WebApp!.downloadFile = () => {};
  });
  await page.route('**/api/dashboard/export-link', (route) =>
    route.fulfill({ status: 503, json: { message: 'Для скачивания в Telegram нужен HTTPS' } }),
  );
  await page.getByRole('button', { name: 'Экспорт CSV', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('нужен HTTPS');
  await expect(page.getByRole('button', { name: 'Экспорт CSV', exact: true })).toBeEnabled();
});
