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
        if (fail) {
          fail = false;
          company = { ...company, city: 'Омск', version: 2 };
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
  await expect(card.getByRole('button', { name: 'Изменить Город', exact: true })).toHaveText(
    /Казань/,
  );
  await expect(card.getByText(/Изменения сохранены, но обновление не удалось/)).toHaveCount(0);
  expect(patches[1].data).not.toHaveProperty('id');
  expect(patches[1].version).toBe(2);
  await card.getByRole('button', { name: /Удалить оборудование/ }).click();
  await expect(card.getByRole('alertdialog')).toBeVisible();
  expect(company.potential).toBe(1000);
  await card.getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
  await expect(card.getByText('Оборудование пока не добавлено', { exact: true })).toBeVisible();
  expect(company.potential).toBe(0);
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(patches.at(-1).version).toBe(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath('client-inline-390.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
