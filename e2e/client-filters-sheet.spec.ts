import { expect, Locator, Page, test } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';
import { labels } from '../src/shared/contracts';
import { divisionLabels } from '../src/shared/crm-taxonomy';

async function setup(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const api = async (
    path: string,
    data?: unknown,
    method = data ? 'POST' : 'GET',
    actorToken = token,
  ) => {
    const response = await page.request.fetch('/api' + path, {
      method,
      data,
      headers: { Authorization: `Bearer ${actorToken}` },
    });
    expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
    return response.json();
  };
  const tag = `ФильтрQA-${Date.now()}-${width}`;
  const definitions = [
    {
      letter: 'Альфа',
      city: 'Москва',
      segment: 'oem',
      direction: 'lv',
      potential: 30_000_000,
      stage: 'supply',
    },
    {
      letter: 'Бета',
      city: 'Москва',
      segment: 'end_client',
      direction: 'mv',
      potential: 10_000_000,
      stage: 'new',
    },
    {
      letter: 'Гамма',
      city: 'Санкт-Петербург с очень длинным названием города',
      segment: 'oem',
      direction: 'mv',
      potential: 20_000_000,
      stage: 'new',
    },
    {
      letter: 'Дельта',
      city: 'Москва',
      segment: 'contractor',
      direction: 'heat',
      potential: 40_000_000,
      stage: 'new',
    },
    {
      letter: 'Ель',
      city: 'Москва',
      segment: 'integrator',
      direction: 'lv',
      potential: 0,
      stage: 'new',
    },
    {
      letter: 'Жук',
      city: 'Москва',
      segment: 'oem',
      direction: 'lv',
      potential: 50_000_000,
      stage: 'closed',
    },
  ];
  const companies: any[] = [];
  for (const definition of definitions)
    companies.push(
      await api('/companies', {
        name: `${definition.letter} ${tag}`,
        city: definition.city,
        segment: definition.segment,
        stage: definition.stage,
        potential: definition.potential,
        divisions: { [definition.direction]: definition.potential },
      }),
    );
  const due = new Date().toISOString().slice(0, 10);
  // Real analytical evidence deliberately disagrees with Alpha's manual supply stage.
  for (const index of [1, 2]) {
    await api(`/companies/${companies[index].id}/records/task`, {
      data: { text: `Звонок ${tag}`, due, type: 'call' },
    });
    await api(`/companies/${companies[index].id}/records/project`, {
      data: { name: `Проект ${tag}-${index}`, amount: 1_000_000 },
    });
  }
  for (const name of ['Первый контакт', 'Второй контакт']) {
    await api(`/companies/${companies[1].id}/records/contact`, {
      data: { name: `${name} ${tag}`, phone: '+79990000000' },
    });
  }
  await api(`/companies/${companies[1].id}/records/task`, {
    data: { text: `Встреча ${tag}`, type: 'meeting', due, done: true },
  });
  await action(page, 'Обновить');
  await clients(page);
  const search = page.getByRole('textbox', { name: 'Поиск компаний', exact: true });
  await search.fill(tag);
  const cards = page.locator('.pico-client-list > .cc-card');
  await expect(cards).toHaveCount(5);
  const open = async () => {
    await page.getByRole('button', { name: 'Фильтры клиентов', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Фильтры', exact: true });
    await expect(sheet).toBeVisible();
    return sheet;
  };
  return { api, tag, companies, cards, search, open };
}
async function show(sheet: Locator, count: number) {
  const button = sheet.getByRole('button', { name: `Показать ${count} клиентов`, exact: true });
  await expect(button).toBeEnabled();
  return button;
}
async function chip(sheet: Locator, group: string, name: string) {
  await sheet
    .getByRole('group', { name: group, exact: true })
    .getByRole('button', { name, exact: true })
    .click();
}
async function names(cards: Locator) {
  return cards
    .locator('.pico-client-copy > strong')
    .evaluateAll((elements) => elements.map((el) => el.textContent));
}

for (const width of [320, 390, 1440]) {
  test(`Client filters combine OR within groups and AND across groups without moving controls at ${width}`, async ({
    page,
  }, info) => {
    test.skip(width === 1440 && info.project.name === 'mobile', 'Portrait-only mobile application');
    const { open, cards, tag, companies } = await setup(page, width);
    const trigger = page.getByRole('button', { name: 'Фильтры клиентов', exact: true });
    const status = page.getByRole('button', { name: 'Закрытые', exact: true });
    const triggerBox = (await trigger.boundingBox())!;
    const statusBox = (await status.boundingBox())!;
    expect(triggerBox.x).toBeGreaterThanOrEqual(statusBox.x + statusBox.width);
    let sheet = await open();
    await expect(sheet.getByText('Архив компаний', { exact: true })).toHaveCount(0);
    const city = sheet.getByRole('combobox', { name: 'Город', exact: true });
    const sort = sheet.getByRole('button', { name: /^Сортировка:/ });
    const cityBox = (await city.boundingBox())!;
    const sortBox = (await sort.boundingBox())!;
    expect(cityBox.height).toBe(40);
    expect(sortBox.height).toBe(40);
    expect(Math.abs(cityBox.y - sortBox.y)).toBeLessThanOrEqual(1);
    expect(sortBox.x - cityBox.x - cityBox.width).toBeCloseTo(10, 0);
    await show(sheet, 5);
    await city.selectOption({ label: companies[2].city });
    await show(sheet, 1);
    await expect(city).toHaveCSS('text-overflow', 'ellipsis');
    await expect(sort.locator('span')).toHaveCSS('text-overflow', 'ellipsis');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`client-filter-long-city-${width}.png`),
      animations: 'disabled',
    });
    await city.selectOption('');
    await show(sheet, 5);
    await chip(sheet, 'Категория клиента', labels.oem);
    await show(sheet, 2);
    await chip(sheet, 'Категория клиента', labels.end_client);
    await show(sheet, 3);
    await chip(sheet, 'Оборудование', divisionLabels.lv);
    await show(sheet, 1);
    await chip(sheet, 'Оборудование', divisionLabels.mv);
    await show(sheet, 3);
    await city.selectOption({ label: 'Москва' });
    await show(sheet, 2);
    await chip(sheet, 'Оборудование', divisionLabels.mv);
    await show(sheet, 1);
    await (await show(sheet, 1)).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText(companies[0].name);
    sheet = await open();
    const reset = sheet.getByRole('button', { name: 'Сбросить', exact: true });
    const showAll = await show(sheet, 1);
    const resetBox = (await reset.boundingBox())!;
    const showBox = (await showAll.boundingBox())!;
    expect(resetBox.width).toBe(112);
    expect(resetBox.height).toBe(48);
    expect(showBox.height).toBe(48);
    expect(resetBox.x).toBeLessThan(showBox.x);
    await reset.click();
    await expect(sheet).toBeVisible();
    await expect(city).toHaveValue('');
    await expect(
      sheet.getByRole('group', { name: 'Категория клиента' }).locator('[aria-pressed="true"]'),
    ).toHaveCount(0);
    await expect(
      sheet.getByRole('group', { name: 'Оборудование' }).locator('[aria-pressed="true"]'),
    ).toHaveCount(0);
    await (await show(sheet, 5)).click();
    await expect(cards).toHaveCount(5);
    expect(await names(cards)).toEqual(companies.slice(0, 5).map((company) => company.name));
    await page.getByRole('button', { name: 'Закрытые', exact: true }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText(companies[5].name);
    sheet = await open();
    await show(sheet, 1);
    await chip(sheet, 'Категория клиента', labels.integrator);
    await show(sheet, 0);
    await chip(sheet, 'Категория клиента', labels.integrator);
    await show(sheet, 1);
    await page.screenshot({
      path: info.outputPath(`client-filters-${width}.png`),
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
    expect(await page.getByRole('textbox', { name: 'Поиск компаний' }).inputValue()).toBe(tag);
  });
}

const sorts = [
  'По алфавиту А–Я',
  'По потенциалу ↓',
  'По потенциалу ↑',
  'По обновлению ↓',
  'По обновлению ↑',
  'По проработке ↓',
  'По проработке ↑',
];
test('Client sort menu has seven keyboard-accessible choices and matches real API values', async ({
  page,
}) => {
  const { api, open, cards, companies } = await setup(page);
  const byName = companies.slice(0, 5).map((company) => company.name);
  const sheet = await open();
  const trigger = sheet.getByRole('button', { name: /^Сортировка:/ });
  await trigger.click();
  const menu = sheet.getByRole('menu', { name: 'Сортировка клиентов', exact: true });
  await expect(menu.getByRole('menuitemradio')).toHaveText(sorts);
  await expect(menu).toHaveCSS('background-color', 'rgba(62, 69, 87, 0.92)');
  await expect(menu.getByRole('menuitemradio', { name: sorts[0], exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(menu.getByRole('menuitemradio', { name: sorts[0], exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitemradio', { name: sorts[6], exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await sheet.getByRole('heading', { name: 'Фильтры', exact: true }).click();
  await expect(menu).toHaveCount(0);
  const choose = async (label: string) => {
    await trigger.click();
    await menu.getByRole('menuitemradio', { name: label, exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAccessibleName(`Сортировка: ${label}`);
    await expect(trigger).toBeFocused();
    await (await show(sheet, 5)).click();
  };
  const expectedOrders = [
    byName,
    [byName[3], byName[0], byName[2], byName[1], byName[4]],
    [byName[4], byName[1], byName[2], byName[0], byName[3]],
  ];
  for (let index = 0; index < sorts.length; index++) {
    if (index) await open();
    await choose(sorts[index]);
    await expect(cards).toHaveCount(5);
    if (index < 3) expect(await names(cards)).toEqual(expectedOrders[index]);
    else if (index === 3 || index === 4) {
      const stored = (await api('/companies')).filter((company: any) =>
        byName.includes(company.name),
      );
      const timestamps = new Map(stored.map((company: any) => [company.name, company.updatedAt]));
      const values = (await names(cards)).map((name) => timestamps.get(name));
      const ascending = [...values].sort();
      expect(values).toEqual(index === 3 ? ascending.reverse() : ascending);
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const analytics = await api(`/analytics?mode=all&from=${today}&to=${today}`);
      const levels = ['new', 'acquaintance', 'development', 'partner', 'ours'];
      const idByName = new Map(companies.map((company) => [company.name, company.id]));
      const scoreById = new Map(
        analytics.clientAnalytics.clients.map((score: any) => [score.id, score]),
      );
      const scores: any[] = (await names(cards)).map((name) => scoreById.get(idByName.get(name)));
      expect(scores.every(Boolean)).toBe(true);
      const ranks = scores.map((score) => levels.indexOf(score.level));
      expect(new Set(ranks).size).toBeGreaterThan(1);
      expect(ranks).toEqual([...ranks].sort((a, b) => (index === 5 ? b - a : a - b)));
      // Manual stage is intentionally not the source of analytical progress.
      if (index === 5) expect((await names(cards))[0]).toBe(companies[1].name);
    }
  }
  await open();
  await sheet.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await expect(trigger).toHaveAccessibleName(`Сортировка: ${sorts[0]}`);
});

test('Manager filter counts and progress sorting never include foreign companies', async ({
  page,
}) => {
  const { api, tag } = await setup(page);
  const session = await page.request.post('/api/auth/dev', { data: { role: 'manager' } });
  expect(session.ok()).toBeTruthy();
  const { token } = await session.json();
  const foreignCity = `Чужой город ${tag}`;
  const foreign = await api('/companies', {
    name: `Чужая компания ${tag}`,
    city: foreignCity,
    potential: 99_000_000,
  });
  const own = await api(
    '/companies',
    { name: `Личная компания ${tag}`, city: `Мой город ${tag}`, potential: 1_000_000 },
    'POST',
    token,
  );
  const accessible = await api('/companies', undefined, 'GET', token);
  expect(accessible.some((company: any) => company.id === foreign.id)).toBe(false);
  await page.evaluate((value) => sessionStorage.setItem('crm-session', value), token);
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await clients(page);
  await page.getByRole('textbox', { name: 'Поиск компаний', exact: true }).fill(tag);
  const cards = page.locator('.pico-client-list > .cc-card');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(own.name);
  await page.getByRole('button', { name: 'Фильтры клиентов', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Фильтры', exact: true });
  await expect(
    sheet
      .getByRole('combobox', { name: 'Город', exact: true })
      .getByRole('option', { name: foreignCity, exact: true }),
  ).toHaveCount(0);
  await sheet.getByRole('button', { name: /^Сортировка:/ }).click();
  await sheet.getByRole('menuitemradio', { name: 'По проработке ↓', exact: true }).click();
  await (await show(sheet, 1)).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(own.name);
  await expect(cards).not.toContainText(foreign.name);
});
