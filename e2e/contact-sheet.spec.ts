import { expect, Page, test } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';

async function setup(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 900 });
  await prepareDemoAuth(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const api = async (path: string, data?: unknown) => {
    const response = await page.request.fetch('/api' + path, {
      method: data ? 'POST' : 'GET',
      data,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const company = await api('/companies', { name: `Contact sheet ${Date.now()}-${width}` });
  const contact = await api(`/companies/${company.id}/records/contact`, {
    data: {
      name: 'Иван Иванов',
      role: 'Инженер',
      phone: '+79990000001',
      email: 'ivan@example.test',
    },
  });
  await api(`/companies/${company.id}/records/contact`, { data: { name: 'Другой контакт' } });
  await clients(page);
  await action(page, 'Обновить');
  const card = page.locator('.cc-card').filter({ hasText: company.name });
  await card.locator('.pico-client-row').click();
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Контакты/ })
    .click();
  const cell = card.getByRole('button', { name: 'Изменить контакт «Иван Иванов»', exact: true });
  const sheet = page.getByRole('dialog', { name: 'Контакт', exact: true });
  const stored = async () =>
    (await api(`/companies/${company.id}`)).records.find((r: any) => r.id === contact.id);
  return { card, cell, sheet, contact, stored };
}

for (const width of [320, 390, 1440]) {
  test(`Contact tap selects one card and shows consistent autosized fields at ${width}`, async ({
    page,
  }, info) => {
    test.skip(width === 1440 && info.project.name === 'mobile', 'Portrait-only mobile app');
    const { card, cell, sheet, stored } = await setup(page, width);
    await cell.click();
    await expect(sheet).toBeVisible();
    await expect(card.locator('.cc-contact-selected')).toHaveCount(1);
    await expect(cell).toHaveCSS('border-top-color', 'rgb(31, 122, 234)');
    expect(await cell.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(
      (await sheet.boundingBox())!.y - 10,
    );
    await expect(page.locator('.pico-bottom-nav')).toBeHidden();
    await expect(sheet.locator('.client-sheet-handle')).toHaveCSS('width', '36px');
    await expect(sheet.locator('.client-sheet-handle')).toHaveCSS('height', '4px');
    for (const label of ['ФИО', 'Должность', 'Телефон', 'E-mail']) {
      const field = sheet.getByRole('textbox', { name: `Контакт · ${label}`, exact: true });
      await expect(field).toHaveCSS('background-color', 'rgb(243, 246, 251)');
      expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      const caption = field.locator('..');
      await expect(caption).toHaveCSS('font-size', '14px');
      await expect(caption).toHaveCSS('font-weight', '800');
      await expect(caption).toHaveCSS('color', 'rgb(43, 50, 88)');
    }
    const role = sheet.getByRole('textbox', { name: 'Контакт · Должность', exact: true });
    await role.fill(
      'Руководитель направления разработки и сопровождения промышленных энергетических систем '.repeat(
        2,
      ),
    );
    const phone = sheet.getByRole('textbox', { name: 'Контакт · Телефон', exact: true });
    await phone.fill('+7 999 123-45-67, доб. 12345, резервный телефон +7 999 765-43-21');
    const email = sheet.getByRole('textbox', { name: 'Контакт · E-mail', exact: true });
    await email.fill('engineering-department-with-a-long-address@example.test');
    for (const field of [role, phone, email]) {
      expect(await field.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await field.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(
        1,
      );
    }
    const save = sheet.getByRole('button', { name: 'Сохранить', exact: true });
    await expect(save).toHaveCSS('height', '48px');
    await page.screenshot({
      path: info.outputPath(`contact-sheet-${width}.png`),
      animations: 'disabled',
    });
    await save.click();
    await expect(sheet).toHaveCount(0);
    await expect(card.locator('.cc-contact-selected')).toHaveCount(0);
    await expect
      .poll(async () => (await stored()).data.email)
      .toBe('engineering-department-with-a-long-address@example.test');
    await expect(cell).toContainText('Руководитель направления');
    if (width < 760) await expect(page.locator('.pico-bottom-nav')).toBeVisible();
    else await expect(page.locator('.pico-bottom-nav')).toBeHidden();
  });
}

test('Contact close and backdrop cancel without writes; swipe pencil uses the same sheet', async ({
  page,
}) => {
  const { card, cell, sheet, contact, stored } = await setup(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/records/${contact.id}`)) writes++;
  });
  await cell.focus();
  await page.keyboard.press('Enter');
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole('textbox', { name: 'Контакт · ФИО', exact: true })
    .fill('Отменённый черновик');
  await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(card.locator('.cc-contact-selected')).toHaveCount(0);
  expect(writes).toBe(0);
  await cell.click();
  await sheet
    .getByRole('textbox', { name: 'Контакт · Телефон', exact: true })
    .fill('Отменённый телефон');
  await page.locator('.client-sheet-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(sheet).toHaveCount(0);
  expect(writes).toBe(0);
  expect((await stored()).data.name).toBe('Иван Иванов');
  const swipe = card.getByRole('group', { name: 'Действия: контакт «Иван Иванов»', exact: true });
  await swipe.focus();
  await page.keyboard.press('ArrowLeft');
  await swipe
    .getByRole('button', { name: 'Редактировать контакт «Иван Иванов»', exact: true })
    .click();
  await expect(sheet).toBeVisible();
  await expect(cell).toHaveClass(/cc-contact-selected/);
  await expect(sheet.getByRole('textbox', { name: 'Контакт · ФИО', exact: true })).toHaveValue(
    'Иван Иванов',
  );
});

test('Contact error preserves the draft and opening version without hiding validation failures', async ({
  page,
}) => {
  const { cell, sheet, contact, stored } = await setup(page);
  await cell.click();
  const phone = sheet.getByRole('textbox', { name: 'Контакт · Телефон', exact: true });
  await phone.fill('+79990000002');
  const versions: number[] = [];
  await page.route(`**/api/records/${contact.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    versions.push(route.request().postDataJSON().version);
    return route.fulfill({ status: 409, json: { message: 'Conflict' } });
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(sheet.getByRole('alert')).toContainText('Контакт изменился');
    await expect(phone).toHaveValue('+79990000002');
  }
  expect(versions).toEqual([contact.version, contact.version]);
  expect((await stored()).data.phone).toBe('+79990000001');
  await sheet
    .getByRole('textbox', { name: 'Контакт · E-mail', exact: true })
    .fill('invalid-address');
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(sheet.getByRole('alert')).not.toContainText('Контакт изменился');
  expect(versions).toHaveLength(2);
});
