import { test, expect } from '@playwright/test';
import { prepareDemoAuth, clients } from './helpers';
for (const width of [320, 390])
  test(`new client sheet ${width}: scroll, millions, atomic contacts`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 740 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
    await clients(page);
    await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
    await dialog.getByLabel('Название', { exact: true }).fill(`Sheet ${width} ${Date.now()}`);
    await dialog
      .locator('.company-form-accordion > summary')
      .filter({ hasText: 'Потенциал' })
      .click();
    await dialog.getByRole('spinbutton').first().fill('2.5');
    await expect(dialog.locator('.company-form-accordion > summary').first()).toContainText(
      '2.5 млн ₽',
    );
    await dialog
      .locator('.company-form-accordion > summary')
      .filter({ hasText: 'Дополнительные поля' })
      .click();
    await dialog.getByRole('button', { name: 'Добавить контакт', exact: true }).click();
    await dialog.getByLabel('Имя', { exact: true }).fill('Контакт');
    const before = await dialog.locator('.section-head').boundingBox();
    const footerBefore = await dialog.locator('.company-form-footer').boundingBox();
    await dialog.locator('.company-form-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const after = await dialog.locator('.section-head').boundingBox();
    const footerAfter = await dialog.locator('.company-form-footer').boundingBox();
    expect(after?.y).toBe(before?.y);
    expect(footerAfter?.y).toBe(footerBefore?.y);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`company-form-${width}.png`), fullPage: true });
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/companies') && response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    const payload = response.request().postDataJSON();
    expect(payload.potential).toBe(2500000);
    expect(payload.initialContacts).toEqual([{ name: 'Контакт', role: '', phone: '', email: '' }]);
    await expect(dialog).toHaveCount(0);
  });
