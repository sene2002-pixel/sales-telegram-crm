import { expect, test, Locator, Page } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';

async function reveal(row: Locator) {
  await row.scrollIntoViewIfNeeded();
  await row.focus();
  await row.press('ArrowLeft');
  await expect(row).toHaveClass(/cc-revealed/);
}
async function setup(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ body: '' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const api = async (path: string, data?: unknown, method = data ? 'POST' : 'GET') => {
    const response = await page.request.fetch('/api' + path, { headers, method, data });
    expect(response.ok(), `${method} ${path} ${response.status()}`).toBeTruthy();
    return response.json();
  };
  const company = await api('/companies', {
    name: `Свайп QA ${Date.now()}-${width}`,
    divisions: { lv: 1_000_000, mv: 3_000_000 },
    potential: 4_000_000,
  });
  const second = await api('/companies', { name: `Вторая QA ${Date.now()}-${width}` });
  const contact = await api(`/companies/${company.id}/records/contact`, {
    data: { name: 'Контакт свайпа', phone: '+79990000000', role: 'Инженер', email: '' },
  });
  const upload = await page.request.post(`/api/companies/${company.id}/files`, {
    headers,
    multipart: {
      category: 'docs',
      file: {
        name: 'Свайп QA.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic QA data'),
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  await clients(page);
  await action(page, 'Обновить');
  const card = page.locator('.cc-card').filter({ hasText: company.name });
  return {
    api,
    company,
    contact,
    card,
    secondCard: page.locator('.cc-card').filter({ hasText: second.name }),
  };
}
for (const width of [320, 390, 1440]) {
  test(`Swipe actions and Pico amount entry persist through real API ${width}`, async ({
    page,
  }, info) => {
    test.skip(width === 1440 && info.project.name === 'mobile', 'Portrait-only mobile app');
    const { api, company, card, secondCard } = await setup(page, width);
    const outer = card.locator(':scope > .cc-swipe');
    const other = secondCard.locator(':scope > .cc-swipe');
    await expect(outer.locator(':scope > .cc-trash-track')).toBeHidden();
    await reveal(outer);
    await expect(outer.locator(':scope > .cc-swipe-content')).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, -112, 0)',
    );
    await reveal(other);
    await expect(outer).not.toHaveClass(/cc-revealed/);
    await page.getByRole('heading', { name: 'Клиенты', exact: true }).click();
    await expect(other).not.toHaveClass(/cc-revealed/);
    await card.locator('.pico-client-row').click();
    const equipment = card.getByRole('group', {
      name: 'Действия: оборудование «Выключатели 0,4 кВ»',
      exact: true,
    });
    await reveal(equipment);
    const rail = equipment.locator(':scope > .cc-trash-track');
    await expect(rail.getByRole('button')).toHaveCount(2);
    await expect(equipment.locator(':scope > .cc-swipe-content')).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, -112, 0)',
    );
    for (const button of await rail.getByRole('button').all()) {
      await expect(button).toHaveCSS('width', '56px');
      await expect(button).toHaveCSS('color', 'rgb(107, 115, 144)');
      await expect(button.locator('svg')).toHaveAttribute('width', '22');
    }
    await rail.getByRole('button', { name: /Редактировать/ }).click();
    await expect(equipment).not.toHaveClass(/cc-revealed/);
    const keypad = page.getByRole('region', { name: 'Клавиатура Pico', exact: true });
    await expect(keypad).toBeVisible();
    const input = equipment.getByRole('textbox', { name: 'Выключатели 0,4 кВ', exact: true });
    await expect(input).toHaveAttribute('inputmode', 'none');
    await expect(input).toHaveValue('1');
    if (width <= 760) await expect(page.locator('.pico-bottom-nav')).toBeHidden();
    const rowBox = (await equipment.locator('.cc-equipment').boundingBox())!;
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual((await keypad.boundingBox())!.y);
    await keypad.getByRole('button', { name: 'Стереть', exact: true }).click();
    await keypad.getByRole('button', { name: '2', exact: true }).click();
    await keypad.getByRole('button', { name: 'Запятая', exact: true }).click();
    await keypad.getByRole('button', { name: '5', exact: true }).click();
    await expect(input).toHaveValue('2,5');
    await keypad.getByRole('button', { name: 'Готово', exact: true }).click();
    await expect(keypad).toHaveCount(0);
    await expect
      .poll(async () => (await api(`/companies/${company.id}`)).company.potential)
      .toBe(5_500_000);
    await expect(card.locator('.company-money')).toContainText('5,5');
    await expect(card.locator('.cc-section > summary').first()).toContainText('5.5');
    await card
      .locator('.cc-section > summary')
      .filter({ hasText: /^Контакты/ })
      .click();
    const contactRow = card.getByRole('group', {
      name: 'Действия: контакт «Контакт свайпа»',
      exact: true,
    });
    await reveal(contactRow);
    await contactRow
      .locator(':scope > .cc-trash-track')
      .getByRole('button', { name: /Редактировать/ })
      .click();
    await expect(page.getByRole('dialog', { name: 'Контакт', exact: true })).toBeVisible();
    await page
      .getByRole('dialog', { name: 'Контакт', exact: true })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click();
    await card
      .locator('.cc-section > summary')
      .filter({ hasText: /^Файлы/ })
      .click();
    const file = card.getByRole('group', { name: 'Действия: файл «Свайп QA.txt»', exact: true });
    await reveal(file);
    await expect(file.locator(':scope > .cc-trash-track').getByRole('button')).toHaveCount(1);
    await expect(file.locator(':scope > .cc-swipe-content')).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, -64, 0)',
    );
    await expect(file.getByRole('button', { name: /Редактировать/ })).toHaveCount(0);
    await file.press('ArrowRight');
    await expect(file).not.toHaveClass(/cc-revealed/);
    await reveal(equipment);
    await equipment
      .locator(':scope > .cc-trash-track')
      .getByRole('button', { name: /Удалить/ })
      .click();
    await page
      .getByRole('alertdialog', { name: 'Подтверждение удаления', exact: true })
      .getByRole('button', { name: 'Подтвердить удаление', exact: true })
      .click();
    await expect
      .poll(async () => (await api(`/companies/${company.id}`)).company.potential)
      .toBe(3_000_000);
    await expect(card.locator('.company-money')).toContainText('3');
    await page.screenshot({ path: `/tmp/pico-swipe-keypad-${info.project.name}-${width}.png` });
  });
}

test('Pico amount keypad retains failed save and is reused by new and edited client forms', async ({
  page,
}) => {
  const { api, company, card } = await setup(page, 390);
  await card.locator('.pico-client-row').click();
  const group = card.locator('.cc-amount-group').filter({ hasText: 'Выключатели 0,4 кВ' });
  await group.getByRole('button', { name: 'Изменить Выключатели 0,4 кВ', exact: true }).click();
  const keypad = page.getByRole('region', { name: 'Клавиатура Pico', exact: true });
  const input = group.getByRole('textbox', { name: 'Выключатели 0,4 кВ', exact: true });
  await keypad.getByRole('button', { name: 'Стереть', exact: true }).click();
  await keypad.getByRole('button', { name: '9', exact: true }).click();
  await page.route(`**/api/companies/${company.id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, json: { message: 'QA unavailable' } })
      : route.continue(),
  );
  await keypad.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(keypad.getByRole('alert')).toContainText('QA unavailable');
  await expect(keypad).toBeVisible();
  await expect(input).toHaveValue('9');
  expect((await api(`/companies/${company.id}`)).company.potential).toBe(4_000_000);
  await page.unroute(`**/api/companies/${company.id}`);
  await keypad.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect
    .poll(async () => (await api(`/companies/${company.id}`)).company.potential)
    .toBe(12_000_000);
  await expect(keypad).toHaveCount(0);
  await group.getByRole('button', { name: 'Изменить Выключатели 0,4 кВ', exact: true }).click();
  await keypad.getByRole('button', { name: 'Стереть', exact: true }).click();
  await keypad.getByRole('button', { name: '4', exact: true }).click();
  await page.getByRole('heading', { name: 'Клиенты', exact: true }).click();
  await expect(keypad).toHaveCount(0);
  await expect
    .poll(async () => (await api(`/companies/${company.id}`)).company.potential)
    .toBe(7_000_000);

  await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
  const newClient = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
  await newClient
    .locator('.company-form-accordion > summary')
    .filter({ hasText: /^Потенциал/ })
    .click();
  const newAmount = newClient.getByRole('textbox', { name: 'Выключатели 0,4 кВ', exact: true });
  await newAmount.click();
  await expect(newAmount).toHaveAttribute('inputmode', 'none');
  await expect(keypad).toBeVisible();
  await keypad.getByRole('button', { name: '2', exact: true }).click();
  await keypad.getByRole('button', { name: 'Запятая', exact: true }).click();
  await keypad.getByRole('button', { name: '5', exact: true }).click();
  await keypad.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(newAmount).toHaveValue('2.5');
  await newClient.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const unsaved = page.getByRole('dialog');
  if (await unsaved.count())
    await unsaved.getByRole('button', { name: 'Удалить черновик', exact: true }).click();
  const outer = card.locator(':scope > .cc-swipe');
  await reveal(outer);
  await outer
    .locator(':scope > .cc-trash-track')
    .getByRole('button', { name: /Редактировать/ })
    .click();
  const editClient = page.getByRole('dialog', { name: 'Редактирование карточки', exact: true });
  await editClient
    .locator('.company-form-accordion > summary')
    .filter({ hasText: /^Потенциал/ })
    .click();
  const editAmount = editClient.getByRole('textbox', { name: 'Выключатели 0,4 кВ', exact: true });
  await editAmount.click();
  await expect(editAmount).toHaveAttribute('inputmode', 'none');
  await expect(keypad).toBeVisible();
  await expect(editAmount).toHaveValue('4');
});

test('Bottom-most form amount remains above Pico panel on short phone', async ({ page }) => {
  const { card } = await setup(page, 320);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
  await sheet
    .locator('.company-form-accordion > summary')
    .filter({ hasText: /^Потенциал/ })
    .click();
  const last = sheet.locator('.pico-number-input').last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  const keypad = page.getByRole('region', { name: 'Клавиатура Pico' });
  await expect(keypad).toBeVisible();
  await expect
    .poll(async () => {
      const field = await last.boundingBox();
      const panel = await keypad.boundingBox();
      return !!field && !!panel && field.y + field.height <= panel.y - 11;
    })
    .toBeTruthy();
  await last.fill('1000000');
  await page.screenshot({ path: '/tmp/pico-form-million.png' });

  await expect.poll(() => last.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
  await keypad.getByRole('button', { name: 'Готово', exact: true }).click();
  await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить черновик', exact: true }).click();
  const outer = card.locator(':scope > .cc-swipe');
  await reveal(outer);
  await outer
    .locator(':scope > .cc-trash-track')
    .getByRole('button', { name: /Редактировать/ })
    .click();
  const edit = page.getByRole('dialog', { name: 'Редактирование карточки', exact: true });
  await edit
    .locator('.company-form-accordion > summary')
    .filter({ hasText: /^Потенциал/ })
    .click();
  const lastEdit = edit.locator('.pico-number-input').last();
  await lastEdit.scrollIntoViewIfNeeded();
  await lastEdit.click();
  await expect
    .poll(async () => {
      const field = await lastEdit.boundingBox();
      const panel = await keypad.boundingBox();
      return !!field && !!panel && field.y + field.height <= panel.y - 11;
    })
    .toBeTruthy();
});
