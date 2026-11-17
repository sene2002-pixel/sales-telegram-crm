import { expect, test, Page, Locator } from '@playwright/test';
import { action, clients, navigate, prepareDemoAuth } from './helpers';

async function setup(page: Page, width = 390) {
  await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await clients(page);
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const create = await page.request.post('/api/companies', {
    headers,
    data: {
      name: 'Проверка отмены ' + Date.now(),
      divisions: { lv: 1_000_000, mv: 3_000_000 },
      potential: 4_000_000,
      notes: 'Сохранённая заметка',
    },
  });
  expect(create.ok()).toBeTruthy();
  const company = await create.json();
  const createdContact = await page.request.post(`/api/companies/${company.id}/records/contact`, {
    headers,
    data: { data: { name: 'Контакт для отмены' } },
  });
  expect(createdContact.ok()).toBeTruthy();
  const contact = await createdContact.json();
  const stored = async () => {
    const response = await page.request.get(`/api/companies/${company.id}`, { headers });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  await action(page, 'Обновить');
  await page.getByRole('textbox', { name: 'Поиск компаний' }).fill(company.name);
  const card = page.locator('.cc-card').filter({ hasText: company.name });
  const row = card.locator(':scope > .cc-swipe');
  const toast = page.locator('.pico-undo-toast');
  return {
    company,
    contact,
    headers,
    card,
    row,
    stored,
    toast,
    undo: toast.getByRole('button', { name: 'Отменить', exact: true }),
  };
}

async function reveal(row: Locator) {
  await row.scrollIntoViewIfNeeded();
  await row.focus();
  await row.press('ArrowLeft');
}

async function swipeDelete(row: Locator) {
  await reveal(row);
  await row.locator(':scope > .cc-trash-track .cc-trash').click();
}

async function freezeClock(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
}

for (const width of [320, 390]) {
  test(`Client archive can be undone at ${width}px, including after navigation`, async ({
    page,
  }, info) => {
    const { company, row, card, stored, toast, undo } = await setup(page, width);
    let writes = 0;
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname === `/api/companies/${company.id}/archive` &&
        request.method() === 'POST'
      )
        writes++;
    });
    await freezeClock(page);
    await swipeDelete(row);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect(toast).toContainText('Клиент удалён');
    await expect(toast.locator('.pico-undo-fill')).toHaveCSS('animation-duration', '3s');
    await expect(toast.locator('.pico-undo-fill')).toHaveCSS('animation-timing-function', 'linear');
    const box = (await toast.boundingBox())!;
    expect(box.x).toBe(44);
    expect(box.width).toBe(width - 88);
    expect(box.height).toBe(40);
    await page.screenshot({ path: info.outputPath(`client-undo-${width}.png`) });
    await page.clock.runFor(2500);
    expect(writes).toBe(0);
    expect((await stored()).company.archived).toBe(false);
    await navigate(page, 'Главная');
    await expect(undo).toBeVisible();
    await undo.click();
    await page.clock.runFor(1000);
    await clients(page);
    await expect(card).toBeVisible();
    expect(writes).toBe(0);
    expect((await stored()).company).toMatchObject({
      archived: false,
      notes: 'Сохранённая заметка',
      potential: 4_000_000,
    });
  });
}

test('Rejected archive brings the client back and a new undo window can be committed once', async ({
  page,
}) => {
  const { company, contact, card, row, stored, toast } = await setup(page);
  let calls = 0;
  await page.route(`**/api/companies/${company.id}/archive`, async (route) => {
    calls++;
    if (calls === 1)
      return route.fulfill({ status: 429, json: { message: 'Сервис временно занят' } });
    return route.continue();
  });
  await freezeClock(page);
  await swipeDelete(row);
  await expect(card).toHaveCount(0);
  await expect(toast).toBeVisible();
  expect(calls).toBe(0);
  await page.clock.runFor(3100);
  await expect(page.getByRole('alert')).toContainText('Сервис временно занят');
  await expect(card).toBeVisible();
  expect((await stored()).company.archived).toBe(false);
  await swipeDelete(row);
  await expect(card).toHaveCount(0);
  expect(calls).toBe(1);
  await page.clock.runFor(3100);
  await expect.poll(async () => (await stored()).company.archived).toBe(true);
  await expect(toast).toHaveCount(0);
  expect(calls).toBe(2);
  await page.getByRole('button', { name: 'Закрытые', exact: true }).click();
  await expect(card).toBeVisible();
  const final = await stored();
  expect(final.company.potential).toBe(4_000_000);
  expect(final.records.some((r: { id: string }) => r.id === contact.id)).toBe(true);
});

test('Equipment and contact undo restore totals and rows while file delete still confirms', async ({
  page,
}) => {
  const { company, contact, headers, card, stored, toast, undo } = await setup(page);
  const uploaded = await page.request.post(`/api/companies/${company.id}/files`, {
    headers,
    multipart: {
      category: 'docs',
      file: {
        name: 'synthetic-confirmation.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic confirmation audit'),
      },
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  await card.locator('.pico-client-row').click();
  const potential = card.locator('.cc-section > summary').filter({ hasText: /^Потенциал/ });
  const total = card.locator('.company-money');
  const contacts = card.locator('.cc-section > summary').filter({ hasText: /^Контакты/ });
  await contacts.click();
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Файлы/ })
    .click();
  const equipment = card.getByRole('group', {
    name: 'Действия: оборудование «Выключатели 0,4 кВ»',
    exact: true,
  });
  const contactRow = card.getByRole('group', {
    name: 'Действия: контакт «Контакт для отмены»',
    exact: true,
  });
  const file = card.getByRole('group', {
    name: 'Действия: файл «synthetic-confirmation.txt»',
    exact: true,
  });
  const hasContact = async () =>
    (await stored()).records.some((r: { id: string }) => r.id === contact.id);

  await freezeClock(page);
  await swipeDelete(equipment);
  await expect(equipment).toHaveCount(0);
  await expect(potential).toContainText('3 млн ₽');
  await expect(total).toContainText('3');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await stored()).company.potential).toBe(4_000_000);
  await undo.click();
  await page.clock.runFor(3100);
  await expect(equipment).toBeVisible();
  await expect(potential).toContainText('4 млн ₽');
  await expect(total).toContainText('4');
  expect((await stored()).company.potential).toBe(4_000_000);

  await swipeDelete(contactRow);
  await expect(contactRow).toHaveCount(0);
  await expect(contacts).toContainText('0');
  await expect(toast).toContainText('Контакт удалён');
  expect(await hasContact()).toBe(true);
  await undo.click();
  await page.clock.runFor(3100);
  await expect(contactRow).toBeVisible();
  await expect(contacts).toContainText('1');
  expect(await hasContact()).toBe(true);

  await swipeDelete(equipment);
  await swipeDelete(contactRow);
  await expect(equipment).toHaveCount(0);
  await expect(contactRow).toHaveCount(0);
  await expect(toast).toContainText('Оборудование удалено');
  await page.clock.runFor(3100);
  await expect.poll(async () => (await stored()).company.potential).toBe(3_000_000);
  await expect(toast).toContainText('Контакт удалён');
  await page.clock.runFor(2500);
  expect(await hasContact()).toBe(true);
  await undo.click();
  await page.clock.runFor(1000);
  expect(await hasContact()).toBe(true);
  await expect(contactRow).toBeVisible();

  await swipeDelete(contactRow);
  await page.clock.runFor(3100);
  await expect.poll(hasContact).toBe(false);
  await expect(toast).toHaveCount(0);
  await page.clock.resume();

  await swipeDelete(file);
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(file.locator(':scope > .cc-trash-track .cc-trash')).toBeFocused();
  await expect(card.locator('.pico-client-row')).toHaveAttribute('aria-expanded', 'true');
  expect((await stored()).records.some((r: { kind: string }) => r.kind === 'file')).toBe(true);
});

test('A newer contact edit survives a stale pending deletion', async ({ page }) => {
  const { card, contact, headers, stored, toast } = await setup(page);
  await card.locator('.pico-client-row').click();
  const contacts = card.locator('.cc-section > summary').filter({ hasText: /^Контакты/ });
  await contacts.click();
  const row = card.getByRole('group', { name: 'Действия: контакт «Контакт для отмены»' });
  await freezeClock(page);
  await swipeDelete(row);
  await expect(contacts).toContainText('0');
  const update = await page.request.patch(`/api/records/${contact.id}`, {
    headers,
    data: { version: contact.version, data: { name: 'Контакт изменён в другой сессии' } },
  });
  expect(update.ok()).toBeTruthy();

  const failure = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === `/api/contacts/${contact.id}`,
  );
  await page.clock.runFor(3100);
  expect((await failure).status()).toBe(409);
  await expect(toast).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Изменение не сохранено');
  await expect(contacts).toContainText('1');
  const contactNow = (await stored()).records.find((r: { id: string }) => r.id === contact.id);
  expect(contactNow.data.name).toBe('Контакт изменён в другой сессии');
  expect(contactNow.version).toBe(contact.version + 1);
});

test('Pending contact deletion stays hidden in a client dialog opened before expiry', async ({
  page,
}) => {
  const { company, card, contact, stored, toast } = await setup(page);
  const hasContact = async () =>
    (await stored()).records.some((r: { id: string }) => r.id === contact.id);
  await card.locator('.pico-client-row').click();
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Контакты/ })
    .click();
  const row = card.getByRole('group', { name: 'Действия: контакт «Контакт для отмены»' });
  await freezeClock(page);
  await swipeDelete(row);
  await expect(row).toHaveCount(0);
  await expect(toast).toContainText('Контакт удалён');
  expect(await hasContact()).toBe(true);

  await card.getByRole('button', { name: 'Задачи и проекты', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog', { name: company.name, exact: true });
  await dialog.getByRole('button', { name: 'Контакты', exact: true }).click();
  await expect(dialog).toContainText('Записей пока нет.');
  await dialog.locator('.records').evaluate((records, contactName) => {
    const resurrections = new MutationObserver(() => {
      if (records.textContent?.includes(contactName)) records.dataset.contactResurrected = 'true';
    });
    resurrections.observe(records, { childList: true, subtree: true, characterData: true });
  }, contact.data.name);

  await page.clock.runFor(3100);
  await expect.poll(hasContact).toBe(false);
  await expect(toast).toHaveCount(0);
  await expect(dialog).toContainText('Записей пока нет.');
  expect(await dialog.locator('.records').getAttribute('data-contact-resurrected')).toBeNull();
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(row).toHaveCount(0);
});
