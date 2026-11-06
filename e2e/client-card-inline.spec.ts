import { expect, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

test('client accordion edits inline, retains failed draft, and archives equipment with confirmation', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
    r.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  const now = new Date().toISOString();
  let company = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Inline проверка',
    inn: '',
    city: 'Москва',
    industry: '',
    segment: 'end_client',
    stage: 'new',
    archived: false,
    revenue: null,
    potential: 1000,
    divisions: { lv: 1000 },
    notes: 'Только об этом клиенте',
    ownerId: 'owner',
    ownerName: 'Тест',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  let fail = true;
  const patches: any[] = [];
  await page.route('**/api/companies**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/companies') return route.fulfill({ json: [company] });
    if (path === `/api/companies/${company.id}`) {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        patches.push(body);
        if (fail || body.version !== company.version) {
          if (fail) {
            fail = false;
            company = { ...company, city: 'Омск', version: 2 };
          }
          return route.fulfill({
            status: 409,
            json: { message: 'Карточка изменена. Повторите сохранение.' },
          });
        }
        company = { ...company, ...body.data, version: company.version + 1 };
        return route.fulfill({ json: company });
      }
      return route.fulfill({
        json: {
          company,
          records: [],
          audit: [],
          holdingMembers: [],
          holdingPotential: null,
          holdingDivisions: {},
        },
      });
    }
    return route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  await navigate(page, 'Клиенты');
  const card = page.locator('.cc-card').filter({ hasText: 'Inline проверка' });
  await card.locator('.pico-client-row').click();
  await expect(card.locator('.cc-section')).toHaveCount(5);
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Данные/ })
    .click();
  await card.getByRole('button', { name: 'Изменить Город', exact: true }).click();
  await card.getByRole('textbox', { name: 'Город', exact: true }).fill('Казань');
  await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Карточка изменена');
  await expect(card.getByRole('textbox', { name: 'Город', exact: true })).toHaveValue('Казань');
  await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Карточка изменена');
  expect(patches[1].version).toBe(1);
  expect(company.city).toBe('Омск');
  await expect(card.getByRole('textbox', { name: 'Город', exact: true })).toHaveValue('Казань');
  await card.getByRole('button', { name: 'Отмена', exact: true }).click();
  await card.getByRole('button', { name: 'Изменить Город', exact: true }).click();
  await expect(card.getByRole('textbox', { name: 'Город', exact: true })).toHaveValue('Омск');
  await card.getByRole('textbox', { name: 'Город', exact: true }).fill('Казань');
  await card.getByRole('button', { name: 'Сохранить', exact: true }).click();

  await expect(card.getByRole('button', { name: 'Изменить Город', exact: true })).toHaveText(
    /Казань/,
  );
  await expect(card.getByText(/Изменения сохранены, но обновление не удалось/)).toHaveCount(0);
  expect(patches[2].data).not.toHaveProperty('id');
  expect(patches[2].version).toBe(2);
  // Hold startup animation callbacks until after the user's Select All. This
  // reproduces the slow-frame ordering from CI without a sleep: startup work
  // must never move the caret after editing has already begun.
  await page.evaluate(() => {
    const state = {
      nativeFrame: window.requestAnimationFrame.bind(window),
      pending: [] as FrameRequestCallback[],
    };
    (window as any).__picoStartupFrames = state;
    window.requestAnimationFrame = (callback) =>
      state.nativeFrame((time) => {
        if (document.documentElement.dataset.picoNumberOpen === 'true')
          state.pending.push(callback);
        else callback(time);
      });
  });
  await card.getByRole('button', { name: 'Изменить Выключатели 0,4 кВ', exact: true }).click();
  const amount = card.getByRole('textbox', { name: 'Выключатели 0,4 кВ', exact: true });
  await amount.press('ControlOrMeta+A');
  await expect
    .poll(() => page.evaluate(() => (window as any).__picoStartupFrames.pending.length))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const state = (window as any).__picoStartupFrames as {
      nativeFrame: typeof requestAnimationFrame;
      pending: FrameRequestCallback[];
    };
    window.requestAnimationFrame = state.nativeFrame;
    for (const callback of state.pending) callback(performance.now());
    delete (window as any).__picoStartupFrames;
  });
  expect(
    await amount.evaluate((field: HTMLInputElement) => ({
      start: field.selectionStart,
      end: field.selectionEnd,
      length: field.value.length,
    })),
  ).toEqual({ start: 0, end: 5, length: 5 });
  await page.keyboard.insertText('1.5');
  await expect(amount).toHaveValue('1.5');
  await amount.press('Tab');
  await expect(
    card.getByRole('button', { name: 'Изменить Выключатели 0,4 кВ', exact: true }),
  ).toBeVisible();
  expect(company.divisions.lv).toBe(1500000);
  await expect(card.locator('.cc-equipment')).toContainText('1.5');
  await expect(card.locator('.cc-equipment')).toContainText('млн ₽');
  const removeEquipment = card.getByRole('button', { name: /Удалить оборудование/ });
  const equipmentCell = card
    .locator('.cc-swipe')
    .filter({ has: page.locator('.cc-equipment') })
    .last();
  await equipmentCell.dispatchEvent('touchstart', {
    touches: [{ identifier: 0, clientX: 300, clientY: 300 }],
  });
  await equipmentCell.dispatchEvent('touchend', {
    changedTouches: [{ identifier: 0, clientX: 100, clientY: 300 }],
  });
  await removeEquipment.click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  expect(company.potential).toBe(1500000);
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Подтвердить удаление', exact: true })
    .click();
  await expect(card.getByText('Оборудование пока не добавлено', { exact: true })).toBeVisible();
  expect(company.potential).toBe(0);
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(patches.at(-1).version).toBe(4);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath('client-inline-390.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
