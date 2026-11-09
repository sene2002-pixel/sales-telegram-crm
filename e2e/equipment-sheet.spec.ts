import { expect, Locator, Page, test } from '@playwright/test';
import { action, clients, navigate, prepareDemoAuth } from './helpers';
import { companySchema } from '../src/shared/contracts';
import { divisionLabels, primaryDivisions } from '../src/shared/crm-taxonomy';

async function setup(
  page: Page,
  width = 390,
  divisions: Record<string, number> = { lv: 1_000_000 },
) {
  await page.setViewportSize({ width, height: 844 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const api = async (path: string, data?: unknown, method = data ? 'POST' : 'GET') => {
    const response = await page.request.fetch('/api' + path, { method, data, headers });
    expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
    return response.json();
  };
  const company = await api('/companies', {
    name: `Оборудование QA ${Date.now()}-${width}`,
    divisions,
    potential: Object.values(divisions).reduce((sum, value) => sum + value, 0),
  });
  await clients(page);
  await action(page, 'Обновить');
  const card = page.locator('.cc-card').filter({ hasText: company.name });
  await card.locator('.pico-client-row').click();
  await expect(card.locator('.cc-section').first()).toBeVisible();
  const open = async () => {
    await card.getByRole('button', { name: 'Добавить оборудование', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Новое оборудование', exact: true });
    await expect(sheet).toBeVisible();
    return sheet;
  };
  return { api, company, card, open };
}

async function enterAmount(sheet: Locator, value: string) {
  const amount = sheet.getByRole('textbox', { name: 'Потенциал, млн ₽', exact: true });
  await amount.click();
  await expect(amount).toHaveAttribute('inputmode', 'none');
  await expect(amount).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await amount.fill(value);
  return amount;
}

for (const width of [320, 390, 1440]) {
  test(`Equipment sheet adds one selected direction and updates CRM at ${width}`, async ({
    page,
  }, info) => {
    test.skip(width === 1440 && info.project.name === 'mobile', 'Portrait-only mobile application');
    const { api, company, card, open } = await setup(page, width);
    const sheet = await open();
    const add = sheet.getByRole('button', { name: 'Добавить', exact: true });
    await expect(add).toBeDisabled();
    const chips = sheet
      .getByRole('group', { name: 'Тип оборудования', exact: true })
      .getByRole('button');
    for (const key of primaryDivisions) {
      const chip = sheet.getByRole('button', { name: divisionLabels[key], exact: true });
      await expect(chip).toHaveAttribute('aria-pressed', 'false');
      if (key === 'lv') await expect(chip).toBeDisabled();
      else await expect(chip).toBeEnabled();
    }
    await expect(chips).toHaveCount(8);
    await sheet.getByRole('button', { name: divisionLabels.mv, exact: true }).click();
    await expect(add).toBeDisabled();
    const amount = await enterAmount(sheet, '');
    const keypad = sheet.getByRole('group', { name: 'Клавиатура Pico', exact: true });
    await expect(keypad).toBeVisible();
    for (const name of ['2', 'Запятая', '5'])
      await keypad.getByRole('button', { name, exact: true }).click();
    await expect(amount).toHaveValue('2,5');
    await expect(add).toBeEnabled();
    if (width < 760) await expect(page.locator('.pico-bottom-nav')).toBeHidden();
    await add.click();
    await expect(sheet).toHaveCount(0);
    await expect
      .poll(async () => (await api(`/companies/${company.id}`)).company.divisions.mv)
      .toBe(2_500_000);
    const saved = (await api(`/companies/${company.id}`)).company;
    expect(saved.divisions.lv).toBe(1_000_000);
    expect(saved.potential).toBe(3_500_000);
    expect(saved.version).toBe(company.version + 1);
    await expect(card.locator('.company-money')).toContainText('3,5');
    await expect(card.locator('.cc-section > summary').first()).toContainText('3.5');
    await expect(
      card.getByRole('button', { name: `Изменить ${divisionLabels.mv}`, exact: true }),
    ).toContainText('2.5');
    await card.locator('.pico-client-row').click();
    await expect(card.locator('.company-money')).toContainText('3,5');
    await navigate(page, 'Аналитика');
    const equipment = page
      .locator('.pico-client-equipment details')
      .filter({ hasText: divisionLabels.mv });
    await equipment.locator(':scope > summary').click();
    const analyticalCompany = equipment
      .locator('.pico-potential-client')
      .filter({ hasText: company.name });
    await expect(analyticalCompany).toContainText('2,5');
    await expect(analyticalCompany.locator('strong')).toHaveAttribute('title', /2.*500.*000/);
  });
}

test('Equipment sheet cancels through close, backdrop and downward swipe without writing', async ({
  page,
}) => {
  const { api, company, open } = await setup(page);
  let patches = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/api/companies/${company.id}`))
      patches++;
  });
  for (const mode of ['close', 'backdrop', 'swipe']) {
    const sheet = await open();
    await sheet.getByRole('button', { name: divisionLabels.mv, exact: true }).click();
    await enterAmount(sheet, '9,25');
    if (mode === 'close') await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
    else if (mode === 'backdrop') {
      const box = (await sheet.boundingBox())!;
      expect(box.y).toBeGreaterThan(5);
      await page.mouse.click(5, box.y / 2);
    } else {
      const handle = sheet.locator('.client-sheet-handle');
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 90, { steps: 6 });
      await page.mouse.up();
    }
    await expect(sheet).toHaveCount(0);
    const stored = (await api(`/companies/${company.id}`)).company;
    expect(stored.version).toBe(company.version);
    expect(stored.divisions).toEqual({ lv: 1_000_000 });
  }
  expect(patches).toBe(0);
});

test('Equipment sheet bounds input and never overwrites a concurrent update', async ({ page }) => {
  const { api, company, open } = await setup(page, 320);
  const sheet = await open();
  await sheet.getByRole('button', { name: divisionLabels.mv, exact: true }).click();
  const amount = await enterAmount(sheet, '1000000');
  const bounds = await amount.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320);
  await amount.fill('-1');
  await expect(sheet.getByRole('button', { name: 'Добавить', exact: true })).toBeDisabled();
  await amount.fill('1000001');
  await expect(sheet.getByRole('button', { name: 'Добавить', exact: true })).toBeDisabled();
  await amount.fill('2,5');
  const latest = (await api(`/companies/${company.id}`)).company;
  const changed = await api(
    `/companies/${company.id}`,
    {
      version: latest.version,
      data: companySchema.strip().parse({ ...latest, city: 'Конкурентное изменение' }),
    },
    'PATCH',
  );
  const response = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/companies/${company.id}`),
  );
  await sheet.getByRole('button', { name: 'Добавить', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(sheet.getByRole('alert')).toBeVisible();
  await expect(amount).toHaveValue('2,5');
  await expect(sheet.getByRole('button', { name: divisionLabels.mv, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const stored = (await api(`/companies/${company.id}`)).company;
  expect(stored.version).toBe(changed.version);
  expect(stored.city).toBe('Конкурентное изменение');
  expect(stored.divisions).toEqual({ lv: 1_000_000 });
});

test('Equipment sheet prevents duplicate directions and hides add after all eight exist', async ({
  page,
}) => {
  const initial = Object.fromEntries(
    primaryDivisions.filter((key) => key !== 'services').map((key) => [key, 1_000_000]),
  );
  const { api, company, card, open } = await setup(page, 390, initial);
  const sheet = await open();
  for (const key of primaryDivisions.filter((key) => key !== 'services')) {
    await expect(
      sheet.getByRole('button', { name: divisionLabels[key], exact: true }),
    ).toBeDisabled();
  }
  await sheet.getByRole('button', { name: divisionLabels.services, exact: true }).click();
  await enterAmount(sheet, '0');
  await sheet.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: 'Добавить оборудование', exact: true }),
  ).toHaveCount(0);
  const saved = (await api(`/companies/${company.id}`)).company;
  expect(saved.divisions.services).toBe(0);
  expect(Object.keys(saved.divisions)).toHaveLength(8);
  expect(saved.potential).toBe(7_000_000);
});
