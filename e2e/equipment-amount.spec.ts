import { expect, test } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';

for (const width of [320, 390]) {
  test(`equipment amount stays in its row and saves safely on blur at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
    await clients(page);
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const headers = { Authorization: `Bearer ${token}` };
    const response = await page.request.post('/api/companies', {
      headers,
      data: {
        name: `Сумма-${Date.now()}-${width}`,
        divisions: { lv: 1_000_000, mv: 3_000_000 },
        potential: 4_000_000,
      },
    });
    expect(response.ok()).toBeTruthy();
    const company = await response.json();
    const fresh = async () =>
      (await (await page.request.get(`/api/companies/${company.id}`, { headers })).json()).company;
    await action(page, 'Обновить');
    const card = page.locator('.cc-card').filter({ hasText: company.name });
    await card.locator('.pico-client-row').click();
    const group = card.locator('.cc-amount-group').filter({ hasText: 'Выключатели 0,4 кВ' });
    const row = group.locator('.cc-equipment');
    const open = group.getByRole('button', { name: 'Изменить Выключатели 0,4 кВ', exact: true });
    const input = group.getByRole('textbox', { name: 'Выключатели 0,4 кВ', exact: true });
    const before = (await row.boundingBox())!;
    const unitBefore = (await row.locator('small').boundingBox())!;
    expect(before.height).toBe(40);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/pico-amount-evidence/read-${width}-${info.project.name}.png`,
    });
    let patches = 0;
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname === `/api/companies/${company.id}` &&
        request.method() === 'PATCH'
      )
        patches++;
    });
    await group.getByText('Выключатели 0,4 кВ', { exact: true }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(await input.evaluate((el) => (el as HTMLInputElement).selectionStart)).toBe(1);
    expect((await row.boundingBox())!.height).toBe(40);
    await expect(row).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(row).toHaveCSS('border-color', 'rgb(31, 122, 234)');
    await expect(input).toHaveCSS('border-top-width', '0px');
    await expect(input).toHaveCSS('text-align', 'right');
    expect(
      Math.abs((await row.locator('small').boundingBox())!.x - unitBefore.x),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `/tmp/pico-amount-evidence/edit-${width}-${info.project.name}.png`,
    });
    await input.fill('2,5');
    await input.press('Tab');
    await expect(open).toBeVisible();
    await expect.poll(async () => (await fresh()).potential).toBe(5_500_000);
    expect((await fresh()).divisions).toEqual({ lv: 2_500_000, mv: 3_000_000 });
    expect(patches).toBe(1);
    await expect(card.locator('.company-money')).toContainText('5,5');
    await expect(card.locator('.cc-section > summary').first()).toContainText('5.5');
    await open.click();
    await input.fill('bad');
    await input.press('Tab');
    await expect(group.getByRole('alert')).toBeVisible();
    expect(patches).toBe(1);
    expect((await row.boundingBox())!.height).toBe(40);
    await page.screenshot({
      path: `/tmp/pico-amount-evidence/error-${width}-${info.project.name}.png`,
    });
    for (const invalid of ['', '-1', '1000001']) {
      await input.fill(invalid);
      await input.press('Tab');
      await expect(group.getByRole('alert')).toBeVisible();
      expect(patches).toBe(1);
      await expect(input).toHaveValue(invalid);
    }
    await input.fill('0');
    await input.press('Enter');
    await expect(open).toBeVisible();
    expect((await fresh()).divisions.lv).toBe(0);
    expect(patches).toBe(2);
    await open.click();
    await input.fill('8');
    await input.press('Escape');
    await expect(open).toBeVisible();
    expect(patches).toBe(2);
    // Error from Enter retains focus; cancellation must not resubmit via blur.
    await page.route(`**/api/companies/${company.id}`, async (route) => {
      if (route.request().method() === 'PATCH')
        await route.fulfill({ status: 429, json: { message: 'Повторите позже' } });
      else await route.continue();
    });
    await open.click();
    await input.fill('9');
    await input.press('Enter');
    await expect(group.getByRole('alert')).toContainText('Повторите позже');
    await expect(input).toBeFocused();
    expect(patches).toBe(3);
    await group.getByRole('button', { name: 'Отменить правку суммы', exact: true }).click();
    await expect(open).toBeVisible();
    expect(patches).toBe(3);
    expect((await fresh()).divisions.lv).toBe(0);

    await page.unroute(`**/api/companies/${company.id}`);
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route(`**/api/companies/${company.id}`, async (route) => {
      if (route.request().method() === 'PATCH') await saveGate;
      await route.continue();
    });
    await open.click();
    await input.fill('1.25');
    await input.press('Enter');
    await input.evaluate((element) => (element as HTMLInputElement).blur());
    releaseSave();
    await expect(open).toBeVisible();
    expect(patches).toBe(4);
    expect((await fresh()).divisions.lv).toBe(1_250_000);
  });
}
