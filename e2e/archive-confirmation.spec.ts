import { expect, test, Page, Locator } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';

async function setup(page: Page, width = 390) {
  await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ body: '' }));
  await page.addInitScript(() => {
    const back = new Set<() => void>();
    (window as any).archiveBack = () => [...back].forEach((fn) => fn());
    (window as any).Telegram = {
      WebApp: {
        BackButton: {
          show() {},
          hide() {},
          onClick(fn: () => void) {
            back.add(fn);
          },
          offClick(fn: () => void) {
            back.delete(fn);
          },
        },
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await clients(page);
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const response = await page.request.post('/api/companies', {
    headers,
    data: {
      name: 'Проверка архива и сохранённых данных ' + Date.now(),
      divisions: { lv: 1_000_000 },
      potential: 1_000_000,
      notes: 'Сохранённая заметка',
    },
  });
  expect(response.ok()).toBeTruthy();
  const company = await response.json();
  await action(page, 'Обновить');
  await page.getByRole('textbox', { name: 'Поиск компаний' }).fill(company.name);
  const card = page.locator('.cc-card').filter({ hasText: company.name });
  const row = card.locator(':scope > .cc-swipe');
  return { company, headers, card, row };
}
async function reveal(row: Locator) {
  await row.focus();
  await row.press('ArrowLeft');
}
async function dismiss(page: Page, channel: string) {
  const modal = page.getByRole('alertdialog');
  if (channel === 'escape') await page.keyboard.press('Escape');
  if (channel === 'back') await page.evaluate(() => (window as any).archiveBack());
  if (channel === 'x') await modal.getByRole('button', { name: 'Закрыть', exact: true }).click();
  if (channel === 'cancel')
    await modal.getByRole('button', { name: 'Отмена', exact: true }).click();
  if (channel === 'backdrop') await modal.locator('..').click({ position: { x: 2, y: 2 } });
}
for (const width of [320, 390]) {
  test(`archive confirmation traps focus and all cancellation channels are safe at ${width}`, async ({
    page,
  }, info) => {
    const { company, headers, row } = await setup(page, width);
    const initialOverflow = await page.evaluate(() => document.body.style.overflow);
    let writes = 0;
    page.on('request', (req) => {
      if (
        new URL(req.url()).pathname === `/api/companies/${company.id}/archive` &&
        req.method() === 'POST'
      )
        writes++;
    });
    for (const channel of ['escape', 'x', 'backdrop', 'back', 'cancel']) {
      await reveal(row);
      const trigger = row.locator(':scope > .cc-trash-track .cc-trash');
      await expect(trigger).toHaveAccessibleName(`Перенести клиента «${company.name}» в архив`);
      await trigger.click();
      const modal = page.getByRole('alertdialog', {
        name: 'Перенести клиента в архив?',
        exact: true,
      });
      await expect(modal).toHaveAttribute('aria-modal', 'true');
      await expect(modal).toContainText('Контакты, потенциал, заметки и файлы сохранятся');
      await expect(modal).toContainText('Закрытые');
      await expect(modal.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
      await page.screenshot({
        animations: 'disabled',
        path: `/tmp/pico-archive-evidence/archive-${width}-${info.project.name}.png`,
      });
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
        expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      await dismiss(page, channel);
      await expect(modal).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.body.style.overflow)).toBe(initialOverflow);
    }
    expect(writes).toBe(0);
    const detail = await (
      await page.request.get(`/api/companies/${company.id}`, { headers })
    ).json();
    expect(detail.company.archived).toBe(false);
    expect(detail.company.notes).toBe('Сохранённая заметка');
  });
}

test('archive error stays open; pending retry cannot close or submit twice and preserves records', async ({
  page,
}, info) => {
  const { company, headers, card, row } = await setup(page);
  await page.request.post(`/api/companies/${company.id}/records/contact`, {
    headers,
    data: { data: { name: 'Сохранённый контакт' } },
  });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/companies/${company.id}/archive`, async (route) => {
    calls++;
    if (calls === 1)
      return route.fulfill({ status: 429, json: { message: 'Сервис временно занят' } });
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  await reveal(row);
  await row.locator(':scope > .cc-trash-track .cc-trash').click();
  const modal = page.getByRole('alertdialog');
  const archive = modal.getByRole('button', { name: 'Перенести в архив', exact: true });
  await archive.click();
  await expect(modal.getByRole('alert')).toContainText('Сервис временно занят');
  await page.screenshot({
    animations: 'disabled',
    path: `/tmp/pico-archive-evidence/error-${info.project.name}.png`,
  });
  await archive.click();
  await expect(modal.getByRole('button', { name: 'Переносим…', exact: true })).toBeDisabled();
  await modal.getByRole('button', { name: 'Переносим…', exact: true }).dispatchEvent('click');
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).archiveBack());
  await modal.locator('..').click({ position: { x: 2, y: 2 } });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Закрыть', exact: true })).toBeDisabled();
  expect(calls).toBe(2);
  release();
  await expect(modal).toHaveCount(0);
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await page.getByRole('button', { name: 'Закрытые', exact: true }).click();
  await expect(card).toBeVisible();
  const detail = await (await page.request.get(`/api/companies/${company.id}`, { headers })).json();
  expect(detail.company.archived).toBe(true);
  expect(detail.company.potential).toBe(1_000_000);
  expect(
    detail.records.some(
      (r: { kind: string; data: { name: string } }) =>
        r.kind === 'contact' && r.data.name === 'Сохранённый контакт',
    ),
  ).toBe(true);
});

test('nested equipment, contact and file confirmations cancel without outer swipe interference', async ({
  page,
}, info) => {
  const { company, headers, card } = await setup(page);
  await page.request.post(`/api/companies/${company.id}/records/contact`, {
    headers,
    data: { data: { name: 'Контакт для отмены' } },
  });
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
  await action(page, 'Обновить');
  await card.locator('.pico-client-row').click();
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Контакты/ })
    .click();
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Файлы/ })
    .click();
  for (const kind of ['cc-equipment', 'cc-contact', 'cc-file']) {
    const nested = card
      .locator('.cc-swipe')
      .filter({ has: page.locator('.' + kind) })
      .last();
    await reveal(nested);
    const trash = nested.locator(':scope > .cc-trash-track .cc-trash');
    await trash.click();
    const modal = page.getByRole('alertdialog');
    await expect(
      modal.getByRole('button', { name: 'Подтвердить удаление', exact: true }),
    ).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
    await page.screenshot({
      animations: 'disabled',
      path: `/tmp/pico-archive-evidence/${kind}-${info.project.name}.png`,
    });
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(trash).toBeFocused();
    await expect(card.locator('.pico-client-row')).toHaveAttribute('aria-expanded', 'true');
  }
  const detail = await (await page.request.get(`/api/companies/${company.id}`, { headers })).json();
  expect(detail.company.archived).toBe(false);
  expect(detail.company.divisions.lv).toBe(1_000_000);
  expect(detail.records.some((r: { kind: string }) => r.kind === 'contact')).toBe(true);
  expect(detail.records.some((r: { kind: string }) => r.kind === 'file')).toBe(true);
});
