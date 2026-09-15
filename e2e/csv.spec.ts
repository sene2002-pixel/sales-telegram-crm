import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  await page.route('**/api/auth/dev', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.telegramId = '123456';
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Команда' }).click();
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
