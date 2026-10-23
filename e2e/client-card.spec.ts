import { expect, Locator, Page, test } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';
import { companySchema } from '../src/shared/contracts';

const equipment = 'Выключатели 0,4 кВ';
async function login(page: Page, role = 'Менеджер') {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: role, exact: true }).click();
  await clients(page);
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  return { Authorization: `Bearer ${token}` };
}
async function fixture(page: Page, headers: Record<string, string>) {
  const response = await page.request.post('/api/companies', {
    headers,
    data: {
      name: `Карточка ${Date.now()}-${test.info().project.name}`,
      city: 'Томск',
      potential: 1_000_000,
      divisions: { lv: 1_000_000 },
      notes: 'Сохранить исходную заметку',
      website: 'https://example.test',
    },
  });
  expect(response.ok()).toBeTruthy();
  const company = await response.json();
  const contactResponse = await page.request.post(`/api/companies/${company.id}/records/contact`, {
    headers,
    data: {
      data: {
        name: 'Иван Тестовый',
        role: 'Инженер',
        phone: '+7 999 123-45-67',
        email: 'ivan@example.test',
      },
    },
  });
  expect(contactResponse.ok()).toBeTruthy();
  const contact = await contactResponse.json();
  const fileResponse = await page.request.post(`/api/companies/${company.id}/files`, {
    headers,
    multipart: {
      category: 'docs',
      file: {
        name: 'client-proof.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Fixture document'),
      },
    },
  });
  expect(fileResponse.ok()).toBeTruthy();
  const file = await fileResponse.json();
  await action(page, 'Обновить');
  const row = page
    .locator('.pico-client-accordion')
    .filter({ has: page.locator('strong', { hasText: company.name }) });
  await row.locator('.pico-client-row').click();
  await expect(row.locator('.client-funnel')).toContainText('1 балл из 8');
  return { company, contact, file, row };
}
async function fresh(page: Page, headers: Record<string, string>, id: string) {
  const response = await page.request.get(`/api/companies/${id}`, { headers });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function reveal(page: Page, row: Locator, label: string) {
  const toggle = row.getByRole('button', { name: `Действия: ${label}`, exact: true });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
async function swipe(page: Page, row: Locator, dx: number, dy = 0) {
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width * 0.35;
  const y = box!.y + Math.min(box!.height / 2, 35);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

test('client accordion uses real score, ordered sections and persists million amounts and notes', async ({
  page,
}, info) => {
  const headers = await login(page);
  const { row, company } = await fixture(page, headers);
  await expect(row.locator('.client-section-heading')).toHaveText([
    /Потенциал/,
    /Контакты/,
    /Файлы/,
    /Заметки/,
    /Данные/,
  ]);
  for (const name of ['Потенциал', 'Контакты', 'Файлы', 'Заметки', 'Данные']) {
    const heading = row.locator('.client-section-heading').filter({ hasText: name });
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
  }
  await row.screenshot({
    path: `/tmp/client-card-expanded-${info.project.name}.png`,
  });
  await row.getByRole('button', { name: `Изменить сумму: ${equipment}`, exact: true }).click();
  await row.getByRole('textbox', { name: `Сумма: ${equipment}`, exact: true }).fill('2,5');
  await row.getByRole('button', { name: `Сохранить сумму: ${equipment}`, exact: true }).click();
  await expect
    .poll(async () => (await fresh(page, headers, company.id)).company.divisions.lv)
    .toBe(2_500_000);
  const saved = await fresh(page, headers, company.id);
  expect(saved.company.potential).toBe(2_500_000);
  expect(saved.company.website).toBe('https://example.test');
  expect(saved.company.notes).toBe('Сохранить исходную заметку');
  await row
    .getByRole('button', { name: `Изменить заметки · ${company.name}`, exact: true })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Заметки', exact: true });
  await sheet
    .getByRole('textbox', { name: 'Заметки', exact: true })
    .fill('Новая заметка после встречи');
  await sheet.getByRole('button', { name: 'Сохранить заметки', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect((await fresh(page, headers, company.id)).company.notes).toBe(
    'Новая заметка после встречи',
  );
  await expect(row.locator('.client-funnel')).toContainText('1 балл из 8');
});

test('contact bottom sheet retains rejected input and retries against the real database', async ({
  page,
}, info) => {
  const headers = await login(page);
  const { row, company, contact } = await fixture(page, headers);
  await row.locator('.pico-client-contacts .client-section-heading').click();
  await reveal(page, row, 'контакт Иван Тестовый');
  await row
    .getByRole('button', { name: 'Редактировать контакт Иван Тестовый', exact: true })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Контакт', exact: true });
  await sheet.getByLabel('ФИО', { exact: true }).fill('Пётр Обновлённый');
  await page.screenshot({
    path: `/tmp/client-card-contact-${info.project.name}.png`,
    fullPage: false,
  });
  let rejected = false;
  await page.route(`**/api/records/${contact.id}`, async (route) => {
    if (route.request().method() === 'PATCH' && !rejected) {
      rejected = true;
      await route.fulfill({
        status: 429,
        json: { message: 'Слишком много запросов. Повторите позже' },
      });
    } else await route.continue();
  });
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('Слишком много запросов');
  await expect(sheet.getByLabel('ФИО', { exact: true })).toHaveValue('Пётр Обновлённый');
  expect(
    (await fresh(page, headers, company.id)).records.find((r: any) => r.id === contact.id).data
      .name,
  ).toBe('Иван Тестовый');
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row.locator('.client-compact-contact')).toContainText('Пётр Обновлённый');
  expect(
    (await fresh(page, headers, company.id)).records.find((r: any) => r.id === contact.id).data
      .name,
  ).toBe('Пётр Обновлённый');
});

test('company sheet saves website and equipment amounts without losing records', async ({
  page,
}, info) => {
  const headers = await login(page);
  const { row, company, contact, file } = await fixture(page, headers);
  await reveal(page, row, `клиент ${company.name}`);
  await row
    .getByRole('button', { name: `Редактировать клиент ${company.name}`, exact: true })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Редактирование карточки', exact: true });
  await sheet.locator('.client-form-potential > summary').click();
  const amount = sheet.getByRole('textbox', { name: equipment, exact: true });
  await amount.fill('');
  await amount.pressSequentially('1.5');
  await expect(amount).toHaveValue('1.5');
  await amount.fill('3,75');
  await expect(amount).toHaveValue('3,75');
  await sheet.locator('.pico-advanced > summary').click();
  await sheet.getByLabel('Сайт', { exact: true }).fill('https://updated.example.test');
  const headerBox = await sheet.locator(':scope > .section-head').boundingBox();
  const sheetBox = await sheet.boundingBox();
  expect(headerBox!.y).toBeGreaterThanOrEqual(sheetBox!.y - 1);
  await expect(sheet.getByRole('button', { name: 'Закрыть', exact: true })).toBeInViewport();
  await expect(sheet.getByRole('button', { name: 'Сохранить', exact: true })).toBeInViewport();

  await page.screenshot({
    path: `/tmp/client-card-company-${info.project.name}.png`,
    fullPage: false,
  });
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const saved = await fresh(page, headers, company.id);
  expect(saved.company.website).toBe('https://updated.example.test');
  expect(saved.company.divisions.lv).toBe(3_750_000);
  expect(saved.company.potential).toBe(3_750_000);
  expect(saved.company.notes).toBe('Сохранить исходную заметку');
  expect(saved.records.map((r: any) => r.id)).toEqual(
    expect.arrayContaining([contact.id, file.id]),
  );
});

test('horizontal swipe reveals actions, reverse closes, vertical gesture does not delete', async ({
  page,
}) => {
  const headers = await login(page);
  const { row, company, contact } = await fixture(page, headers);
  await row.locator('.pico-client-contacts .client-section-heading').click();
  const item = row.locator('.client-contact-swipe');
  const toggle = item.getByRole('button', { name: 'Действия: контакт Иван Тестовый', exact: true });
  await swipe(page, item, -100);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(
    item.getByRole('button', { name: 'Убрать контакт Иван Тестовый', exact: true }),
  ).toBeVisible();
  expect(
    (await fresh(page, headers, company.id)).records.some((r: any) => r.id === contact.id),
  ).toBeTruthy();
  await swipe(page, item, 100);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await swipe(page, item, 4, 65);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await reveal(page, item, 'контакт Иван Тестовый');
  await item.getByRole('button', { name: 'Убрать контакт Иван Тестовый', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Подтверждение', exact: true });
  await confirm.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(
    (await fresh(page, headers, company.id)).records.some((r: any) => r.id === contact.id),
  ).toBeTruthy();
  await reveal(page, item, 'контакт Иван Тестовый');
  await item.getByRole('button', { name: 'Убрать контакт Иван Тестовый', exact: true }).click();
  await confirm.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(item).toHaveCount(0);
  expect(
    (await fresh(page, headers, company.id)).records.some((r: any) => r.id === contact.id),
  ).toBeFalsy();
});

test('archive preserves client data and only administrator can restore', async ({ page }) => {
  const manager = await login(page);
  const { company, contact, file } = await fixture(page, manager);
  const leaderSession = await page.request.post('/api/auth/dev', { data: { role: 'supervisor' } });
  expect(leaderSession.ok()).toBeTruthy();
  const leader = { Authorization: `Bearer ${(await leaderSession.json()).token}` };
  const adminSession = await page.request.post('/api/auth/dev', { data: { role: 'admin' } });
  expect(adminSession.ok()).toBeTruthy();
  const admin = { Authorization: `Bearer ${(await adminSession.json()).token}` };
  // A leader owns this isolated fixture; no shared user's team membership is changed.
  const assign = await page.request.post(`/api/companies/${company.id}/assign`, {
    headers: admin,
    data: {
      ownerId: (await (await page.request.get('/api/me', { headers: leader })).json()).id,
      version: company.version,
    },
  });
  expect(assign.ok()).toBeTruthy();
  const assigned = await fresh(page, leader, company.id);
  const archive = await page.request.post(`/api/companies/${company.id}/archive`, {
    headers: leader,
    data: { archived: true, version: assigned.company.version },
  });
  expect(archive.ok()).toBeTruthy();
  const archived = await fresh(page, leader, company.id);
  expect(archived.company.archived).toBeTruthy();
  expect(archived.records.map((r: any) => r.id)).toEqual(
    expect.arrayContaining([contact.id, file.id]),
  );
  const forbidden = await page.request.post(`/api/companies/${company.id}/archive`, {
    headers: leader,
    data: { archived: false, version: archived.company.version },
  });
  expect(forbidden.status()).toBe(403);
  const restore = await page.request.post(`/api/companies/${company.id}/archive`, {
    headers: admin,
    data: { archived: false, version: archived.company.version },
  });
  expect(restore.ok()).toBeTruthy();
  const restored = await fresh(page, admin, company.id);
  expect(restored.company.archived).toBeFalsy();
  expect(restored.company.notes).toBe(company.notes);
  expect(restored.company.divisions.lv).toBe(1_000_000);
  expect(restored.records.map((r: any) => r.id)).toEqual(
    expect.arrayContaining([contact.id, file.id]),
  );
  expect(restored.audit.map((a: any) => a.action)).toEqual(
    expect.arrayContaining(['company.archived', 'company.restored']),
  );
});

test('company draft survives a focus refresh and rejects a concurrent version without overwriting', async ({
  page,
}) => {
  const headers = await login(page);
  const { row, company } = await fixture(page, headers);
  await reveal(page, row, `клиент ${company.name}`);
  await row
    .getByRole('button', { name: `Редактировать клиент ${company.name}`, exact: true })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Редактирование карточки', exact: true });
  await sheet.locator('.pico-advanced > summary').click();
  await sheet.getByLabel('Сайт', { exact: true }).fill('https://draft.example.test');
  const before = await fresh(page, headers, company.id);
  const externalData = {
    ...companySchema.strip().parse(before.company),
    city: 'Казань',
    notes: 'Изменено другим сотрудником',
  };
  const external = await page.request.patch(`/api/companies/${company.id}`, {
    headers,
    data: { version: before.company.version, data: externalData },
  });
  expect(external.ok()).toBeTruthy();
  const externalCompany = await external.json();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(row.locator('.pico-client-metadata')).toContainText('Казань');
  await expect(sheet.getByLabel('Город', { exact: true })).toHaveValue('Томск');
  await expect(sheet.getByLabel('Сайт', { exact: true })).toHaveValue('https://draft.example.test');
  const conflict = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().endsWith(`/api/companies/${company.id}`),
  );
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(sheet.getByRole('alert')).toContainText('Карточка изменена');
  await expect(sheet.getByLabel('Сайт', { exact: true })).toHaveValue('https://draft.example.test');
  const saved = await fresh(page, headers, company.id);
  expect(saved.company.version).toBe(externalCompany.version);
  expect(saved.company.notes).toBe('Изменено другим сотрудником');
  expect(saved.company.city).toBe('Казань');
  expect(saved.company.website).toBe('https://example.test');
});

test('equipment and file swipe deletion preserve contacts; client trash archives through UI', async ({
  page,
}) => {
  const headers = await login(page, 'Администратор');
  const { row, company, contact, file } = await fixture(page, headers);
  await row.locator('.pico-client-potential .client-section-heading').click();
  const equipmentRow = row.locator('.client-equipment-swipe');
  await reveal(page, equipmentRow, `оборудование ${equipment}`);
  await equipmentRow
    .getByRole('button', { name: `Убрать оборудование ${equipment}`, exact: true })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Подтверждение', exact: true });
  await confirm.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(equipmentRow).toHaveCount(0);
  expect((await fresh(page, headers, company.id)).company.potential).toBe(0);
  await row.locator('.pico-client-files .client-section-heading').click();
  const fileRow = row.locator('.client-file-swipe');
  await reveal(page, fileRow, `файл ${file.data.name}`);
  await fileRow.getByRole('button', { name: `Убрать файл ${file.data.name}`, exact: true }).click();
  await confirm.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(fileRow).toHaveCount(0);
  const afterDelete = await fresh(page, headers, company.id);
  expect(afterDelete.records.map((r: any) => r.id)).toContain(contact.id);
  expect(afterDelete.records.map((r: any) => r.id)).not.toContain(file.id);
  await reveal(page, row, `клиент ${company.name}`);
  await row.getByRole('button', { name: `Убрать клиент ${company.name}`, exact: true }).click();
  await expect(confirm).toContainText('в архив');
  await confirm.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(row).toHaveCount(0);
  const archived = await fresh(page, headers, company.id);
  expect(archived.company.archived).toBeTruthy();
  expect(archived.records.map((r: any) => r.id)).toContain(contact.id);
});
