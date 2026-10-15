import { expireSession } from './helpers';
import { expect, test, Page } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

const none = { kind: 'none', percent: null, tone: 'neutral' };
const settings = { revision: 1, taskDays: 14, meetingMonths: 3, projectMonths: 1, updatedAt: null };
function response(mode: string, unavailable = false, potential = 235000000) {
  const all = mode === 'all';
  const missing = { kind: 'unavailable', percent: null, tone: 'neutral' };
  return {
    // Intentionally different legacy data proves that new cards never use manual CRM stages.
    funnel: [{ key: 'closed', label: 'Закрыто', count: 999 }],
    conversion: 999,
    activeClients: 999,
    clientAnalytics: {
      ruleVersion: 1,
      asOf: '2026-10-15',
      settings,
      clientFunnel: [
        { key: 'new', label: 'Новый', count: 18 },
        { key: 'acquaintance', label: 'Знакомство', count: 0 },
        { key: 'development', label: 'Развитие', count: 6 },
        { key: 'partner', label: 'Партнёр', count: 0 },
        { key: 'ours', label: 'Наш клиент', count: 0 },
      ],
      clients: [],
      metrics: {
        potential: {
          value: unavailable ? null : potential,
          companies: 24,
          delta: unavailable
            ? missing
            : all
              ? none
              : { kind: 'percent', percent: 10, tone: 'positive' },
        },
        projects: {
          value: unavailable ? null : 120000000,
          count: 8,
          delta: unavailable
            ? missing
            : all
              ? none
              : { kind: 'percent', percent: -22, tone: 'negative' },
        },
        growth: {
          value: unavailable ? null : 6,
          share: unavailable ? null : 25,
          delta: unavailable
            ? missing
            : all
              ? none
              : { kind: 'new', percent: null, tone: 'neutral' },
        },
        active: {
          value: unavailable ? null : 18,
          total: 24,
          delta: unavailable
            ? missing
            : all
              ? none
              : { kind: 'percent', percent: 0, tone: 'neutral' },
        },
      },
      historyIncomplete: unavailable ? 2 : 0,
      contactSourcesUnknown: unavailable ? 3 : 0,
    },
  };
}
async function login(page: Page, role = 'Администратор') {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
    r.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: role, exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
}
async function mockAnalytics(page: Page) {
  const requests: URL[] = [];
  await page.route('**/api/analytics?*', (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    return route.fulfill({
      json: response(url.searchParams.get('mode')!, url.searchParams.get('from') === '2020-01-01'),
    });
  });
  return requests;
}

test('Analytics uses all-period eight-point data, four comparisons and truthful unavailable history', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = await mockAnalytics(page);
  await login(page);
  await navigate(page, 'Аналитика');
  const metrics = page.locator('.pico-client-metric');
  await expect(metrics).toHaveCount(4);
  expect(requests.at(-1)!.searchParams.get('mode')).toBe('all');
  await expect(page.getByRole('button', { name: 'Период аналитики' })).toContainText('Весь период');
  await expect(page.locator('.pico-client-funnel polygon')).toHaveCount(5);
  await expect(page.locator('.pico-client-funnel-legend')).toContainText('Наш клиент');
  await expect(page.locator('.pico-client-funnel-legend')).not.toContainText('999');
  await expect(page.locator('.pico-metric-delta')).toHaveCount(0);
  await expect(metrics.filter({ hasText: 'Потенциал клиентов' })).toContainText('235');
  await page.locator('.pico-score-explanation summary').click();
  await expect(page.locator('.pico-score-explanation')).toContainText(
    'пять баллов за базу и три за регулярность',
  );
  await expect(page.locator('.pico-score-explanation')).toContainText(
    'найденные ботом, не учитываются',
  );
  await page.locator('.pico-score-explanation summary').click();
  await page.screenshot({ path: info.outputPath('analytics-all-390.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Период аналитики' }).click();
  let dialog = page.getByRole('dialog', { name: 'Период', exact: true });
  await dialog.getByRole('radio', { name: /^30 дней/ }).click();
  await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.locator('.pico-metric-delta')).toHaveCount(4);
  expect(requests.at(-1)!.searchParams.get('mode')).toBe('range');
  await expect(page.locator('.tone-positive')).toHaveText('↑ +10%');
  await expect(page.locator('.tone-negative')).toHaveText('↓ 22%');
  await expect(page.locator('.tone-neutral').filter({ hasText: /^новое$/ })).toHaveCount(1);
  await expect(page.locator('.tone-neutral').filter({ hasText: /^0%$/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Период аналитики' }).click();
  dialog = page.getByRole('dialog', { name: 'Период', exact: true });
  await dialog.getByRole('radio', { name: /^Свой период/ }).click();
  await dialog.getByLabel('Начало периода').fill('2020-01-01');
  await dialog.getByLabel('Конец периода').fill('2020-01-30');
  await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.locator('.pico-metric-value > strong')).toHaveText(['—', '—', '—', '—']);
  await expect(page.locator('.pico-analytics-limits')).toContainText(
    'Не всю историю можно подтвердить',
  );
  await expect(page.locator('.pico-analytics-final')).not.toContainText(
    'Контакты с неизвестным источником',
  );
  await expect(page.locator('.pico-metric-delta')).toHaveText(
    Array(4).fill('Нет данных для сравнения'),
  );
});

test('Analytics settings are versioned, reload on conflict and never expose admin control to manager', async ({
  page,
}) => {
  await mockAnalytics(page);
  let current = { ...settings },
    conflict = true;
  const saves: any[] = [];
  await page.route('**/api/analytics/settings', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current });
    const data = route.request().postDataJSON();
    saves.push(data);
    if (conflict) {
      conflict = false;
      current = { ...settings, revision: 2, taskDays: 21 };
      return route.fulfill({ status: 409, json: { message: 'Настройки изменены' } });
    }
    current = { ...data, revision: data.revision + 1, updatedAt: null };
    return route.fulfill({ json: current });
  });
  await login(page);
  await navigate(page, 'Аналитика');
  await page.getByRole('button', { name: 'Дополнительное меню' }).click();
  await page.getByRole('button', { name: 'Настройки аналитики', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки аналитики', exact: true });
  await expect(dialog.getByLabel('Задачи: интервал, дней')).toHaveValue('14');
  await dialog.getByLabel('Задачи: интервал, дней').fill('30');
  await dialog.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Загружены актуальные значения');
  await expect(dialog.getByLabel('Задачи: интервал, дней')).toHaveValue('21');
  await dialog.getByLabel('Задачи: интервал, дней').fill('365');
  await dialog.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(dialog).toHaveCount(0);
  expect(saves).toEqual([
    { revision: 1, taskDays: 30, meetingMonths: 3, projectMonths: 1 },
    { revision: 2, taskDays: 365, meetingMonths: 3, projectMonths: 1 },
  ]);
  await expireSession(page);
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  await page.getByRole('button', { name: 'Дополнительное меню' }).click();
  await expect(page.getByRole('button', { name: 'Настройки аналитики', exact: true })).toHaveCount(
    0,
  );
});

test('Analytics scope rejection removes every cached metric and equipment row', async ({
  page,
}) => {
  let denied = false;
  await page.route('**/api/analytics?*', (r) =>
    r.fulfill(
      denied
        ? { status: 403, json: { message: 'Доступ к аналитике отозван' } }
        : { json: response('all') },
    ),
  );
  await login(page);
  await navigate(page, 'Аналитика');
  await expect(page.locator('.pico-client-metric')).toHaveCount(4);
  denied = true;
  await navigate(page, 'Главная');
  await navigate(page, 'Аналитика');
  await expect(page.getByRole('alert')).toContainText('Доступ к аналитике отозван');
  await expect(page.locator('.pico-client-metric')).toHaveCount(0);
  await expect(page.locator('.pico-client-equipment')).toHaveCount(0);
});

test('Analytics matches native-frame geometry at 360, 390 and 1440 and exposes the report above footer', async ({
  page,
}, info) => {
  await page.route('**/api/analytics?*', (r) =>
    r.fulfill({ json: response('all', false, 450123456) }),
  );
  await login(page);
  // Authentication above is the local demo. Simulate native chrome already outside
  // the WebView; this is geometry evidence, not a live Telegram authentication test.
  await page.evaluate(() => {
    (window as any).Telegram = { WebApp: { initData: 'native-geometry-fixture' } };
  });
  await navigate(page, 'Аналитика');
  await expect(page.locator('.telegram-native-header')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [320, 360, 390, 1440]) {
    if (width === 1440 && info.project.name === 'mobile') {
      // A portrait tablet with a keyboard-height WebView, matching the other
      // responsive tests; actual landscape rejection has separate coverage.
      await page.evaluate(() => {
        Object.defineProperties(screen, {
          width: { configurable: true, value: 1440 },
          height: { configurable: true, value: 2560 },
        });
        Object.defineProperties(screen.orientation, {
          type: { configurable: true, value: 'portrait-primary' },
          angle: { configurable: true, value: 0 },
        });
      });
    }
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 734 });
    await expect(page.locator('.pico-client-metric')).toHaveCount(4);
    const heading = (await page
      .getByRole('heading', { name: 'Аналитика', exact: true })
      .boundingBox())!;
    const period = (await page.getByRole('button', { name: 'Период аналитики' }).boundingBox())!;
    if (width < 761) {
      const gear = (await page
        .getByRole('button', { name: 'Дополнительное меню', exact: true })
        .boundingBox())!;
      expect(period.x + period.width).toBeLessThanOrEqual(gear.x);
      if (Math.abs(heading.y - period.y) < 20)
        expect(heading.x + heading.width).toBeLessThanOrEqual(period.x);
    }
    await expect(page.locator('.pico-client-funnel-content > svg')).toHaveCSS(
      'width',
      width === 320 ? '138px' : '150px',
    );
    await expect(page.locator('.pico-client-funnel-content > svg')).toHaveCSS(
      'height',
      width === 320 ? '134.312px' : '146px',
    );
    expect(
      await page
        .locator('.pico-score-scale > div')
        .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).flexGrow)),
    ).toEqual(['1', '2', '3', '2', '1']);
    await expect(page.locator('.pico-metric-value > strong').first()).toHaveText('450,1');
    await expect(page.locator('.pico-metric-value > strong').first()).toHaveAttribute(
      'title',
      /450.*123.*456/,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    if (width === 390) {
      const menu = (await page.locator('.pico-bottom-nav').boundingBox())!;
      const lastMetric = (await page.locator('.pico-client-metric').last().boundingBox())!;
      const equipment = (await page.locator('.pico-client-equipment').boundingBox())!;
      expect(lastMetric.y + lastMetric.height).toBeLessThanOrEqual(menu.y - 6);
      expect(equipment.y).toBeGreaterThanOrEqual(menu.y);
    }
    await page.screenshot({
      path: info.outputPath(`analytics-native-${width}.png`),
      animations: 'disabled',
    });
    const report = page.getByRole('button', {
      name: 'Коммерческий отчёт руководителю',
      exact: true,
    });
    await report.scrollIntoViewIfNeeded();
    const reportBox = (await report.boundingBox())!;
    expect(reportBox.height).toBe(44);
    if (width < 761) {
      const nav = (await page.locator('.pico-bottom-nav').boundingBox())!;
      expect(reportBox.y + reportBox.height).toBeLessThanOrEqual(nav.y - 16);
    }
    await page.screenshot({
      path: info.outputPath(`analytics-scroll-native-${width}.png`),
      animations: 'disabled',
    });
    await page.evaluate(() => window.scrollTo(0, 0));
  }
});

test('Analytics preserves compact white rows, equal empty/populated indentation and centered report submit', async ({
  page,
}, info) => {
  await mockAnalytics(page);
  await page.route('**/api/companies*', (r) =>
    r.request().method() === 'GET'
      ? r.fulfill({
          json: [
            {
              id: 'qa-company',
              name: 'Тестовая компания с подтверждённым потенциалом',
              city: 'Москва',
              industry: 'Энергетика',
              segment: 'end_client',
              stage: 'new',
              potential: 5000000,
              divisions: { mv: 5000000 },
              inn: '',
              notes: '',
              archived: false,
              ownerId: 'qa',
              ownerName: 'Менеджер',
              version: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        })
      : r.fallback(),
  );
  await login(page);
  await navigate(page, 'Аналитика');
  await expect(page.locator('.pico-client-equipment')).toBeVisible();
  const filled = page
    .locator('.pico-client-equipment > details')
    .filter({ hasText: 'Выключатели 6–35 кВ' });
  const empty = page
    .locator('.pico-client-equipment > details')
    .filter({ hasText: 'Выключатели 0,4 кВ' });
  await filled.locator('summary').click();
  await empty.locator('summary').click();
  const filledLabel = (await filled.locator('.pico-potential-client > span').boundingBox())!;
  const emptyLabel = (await empty.locator('.pico-potential-client > span').boundingBox())!;
  expect(emptyLabel.x).toBe(filledLabel.x);
  await expect(filled).toHaveCSS('padding', '0px');
  await expect(empty).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(filled.locator('summary')).toHaveCSS('padding', '0px');
  await expect(page.locator('.pico-score-explanation')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(page.locator('.pico-score-explanation')).toHaveCSS('padding', '0px');
  await expect(page.locator('.pico-score-explanation summary')).toHaveCSS('height', '18px');
  await filled.locator('summary').click();
  await empty.locator('summary').click();
  await expect(filled.locator('summary')).toHaveCSS('height', '44px');
  await expect(filled.locator('.pico-equipment-tile')).toHaveCSS('width', '32px');
  const trigger = page.getByRole('button', {
    name: 'Коммерческий отчёт руководителю',
    exact: true,
  });
  await trigger.click();
  const button = page.getByRole('button', { name: 'Сформировать коммерческий отчёт', exact: true });
  await button.scrollIntoViewIfNeeded();
  const parent = (await page
    .getByRole('region', { name: 'Коммерческий отчёт', exact: true })
    .boundingBox())!;
  const box = (await button.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - parent.x - parent.width / 2)).toBeLessThanOrEqual(1);
  expect(box.width).toBeLessThanOrEqual(parent.width - 28);
  await page.screenshot({
    path: info.outputPath('analytics-reviewed-rows-and-submit.png'),
    animations: 'disabled',
  });
});

test('Analytics declines client/project counts and describes incomplete history without inventing client totals', async ({
  page,
}) => {
  let count = 1;
  await page.route('**/api/analytics?*', (r) => {
    const value = response('all');
    value.clientAnalytics.metrics.potential.companies = count;
    value.clientAnalytics.metrics.projects.count = count;
    value.clientAnalytics.metrics.growth.value = count;
    value.clientAnalytics.historyIncomplete = 999;
    value.clientAnalytics.contactSourcesUnknown = count;
    return r.fulfill({ json: value });
  });
  await login(page);
  for (const [number, clientDative, projectDative, clientUnit] of [
    [1, 'клиенту', 'проекту', 'клиент'],
    [2, 'клиентам', 'проектам', 'клиента'],
    [5, 'клиентам', 'проектам', 'клиентов'],
    [11, 'клиентам', 'проектам', 'клиентов'],
    [21, 'клиенту', 'проекту', 'клиент'],
  ] as const) {
    count = number;
    await navigate(page, 'Аналитика');
    await expect(
      page.getByRole('region', { name: 'Потенциал клиентов', exact: true }),
    ).toContainText(`по ${number} ${clientDative}`);
    await expect(
      page.getByRole('region', { name: 'Потенциал проектов', exact: true }),
    ).toContainText(`по ${number} ${projectDative}`);
    const growth = page.getByRole('region', { name: 'Рост по воронке', exact: true });
    await expect(growth.locator('.pico-metric-value > strong')).toHaveText(String(number));
    await expect(growth.locator('.pico-metric-value > span')).toHaveText(clientUnit);
    await expect(page.locator('.pico-analytics-limits')).toContainText(
      'Не всю историю можно подтвердить. Для таких данных сравнения недоступны.',
    );
    await expect(page.locator('.pico-analytics-limits')).not.toContainText('999');
    await expect(page.locator('.pico-analytics-final')).not.toContainText(
      'Контакты с неизвестным источником',
    );
    await navigate(page, 'Главная');
  }
});

async function levelFixture(page: Page, count: number) {
  const companies = Array.from({ length: count }, (_, i) => ({
    id: `level-company-${i}`,
    name: `Клиент ${String(i + 1).padStart(3, '0')}`,
    city: 'Москва',
    industry: '',
    segment: 'end_client',
    stage: 'new',
    potential: i ? 1000000 : null,
    divisions: {},
    inn: String(7700000000 + i),
    notes: '',
    archived: false,
    ownerId: 'qa',
    ownerName: 'Менеджер',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  await page.route('**/api/companies*', (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: companies }) : r.fallback(),
  );
  let denied = false;
  await page.route('**/api/analytics?*', (r) => {
    if (denied) return r.fulfill({ status: 403, json: { message: 'Доступ к уровню отозван' } });
    const data = response('all');
    data.clientAnalytics.clients = companies.map((c) => ({ id: c.id, level: 'new' })) as any;
    data.clientAnalytics.clientFunnel[0].count = count;
    return r.fulfill({ json: data });
  });
  await login(page);
  await navigate(page, 'Аналитика');
  await page.locator('.pico-levels > summary').click();
  const level = page.locator('.pico-level').first();
  await level.locator('summary').click();
  return {
    level,
    deny: () => {
      denied = true;
    },
  };
}
for (const count of [3, 4, 100]) {
  test(`Level with ${count} clients expands on the analytics page and collapses`, async ({
    page,
  }, info) => {
    const { level } = await levelFixture(page, count);
    await expect(level.locator('li')).toHaveCount(3);
    if (count === 3) {
      await expect(level.getByRole('button')).toHaveCount(0);
    } else {
      const showAll = level.getByRole('button', { name: `Показать всех, ${count}` });
      await expect(showAll).toHaveCSS('min-height', '44px');
      await expect(showAll).toHaveCSS('border-width', '0px');
      await expect(showAll).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(showAll.locator('svg')).toHaveAttribute('aria-hidden', 'true');
      await page.screenshot({
        path: info.outputPath(`show-all-${count}.png`),
        animations: 'disabled',
      });
      await showAll.click();
      await expect(page.getByRole('heading', { name: 'Аналитика', exact: true })).toBeVisible();
      await expect(level.locator('li')).toHaveCount(count);
      await expect(level).not.toContainText('Показаны');
      await expect(level.getByRole('button')).toHaveCount(0);
      await level.locator('summary').click();
      await expect(level.locator('ul')).not.toBeVisible();
      await level.locator('summary').click();
      await expect(level.locator('ul')).toBeVisible();
      await expect(level.locator('li')).toHaveCount(count);
    }
    await expect(page.locator('.pico-level-empty')).toHaveCount(4);
  });
}
test('Large level caps the inline list at 100, searches beyond the cap and clears on scope rejection', async ({
  page,
}, info) => {
  const { level, deny } = await levelFixture(page, 121);
  await expect(level.locator('summary strong')).toHaveText('121');
  await expect(level.locator('li')).toHaveCount(3);
  await expect(level.locator('li strong').first()).toHaveText('—');
  await level.getByRole('button', { name: 'Показать до 100' }).click();
  await expect(level.locator('li')).toHaveCount(100);
  await expect(level).not.toContainText('Показаны');
  await expect(level.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Аналитика', exact: true })).toBeVisible();
  const search = level.getByRole('searchbox', { name: 'Поиск клиентов уровня «Новый»' });
  await search.fill('  кЛиЕнТ 121  ');
  await expect(level.locator('li')).toHaveCount(1);
  await expect(level.locator('li')).toContainText('Клиент 121');
  await search.fill('7700000120');
  await expect(level.locator('li')).toHaveCount(1);
  await search.fill('несуществующий');
  await expect(level.locator('li')).toHaveCount(0);
  await expect(level).toContainText('Клиенты не найдены');
  await search.fill('');
  await expect(level.locator('li')).toHaveCount(100);
  await page.screenshot({
    path: info.outputPath('inline-level-clients.png'),
    animations: 'disabled',
  });
  await level.locator('summary').click();
  await expect(level.locator('ul')).not.toBeVisible();
  await level.locator('summary').click();
  await expect(level.locator('li')).toHaveCount(100);
  await expect(search).toHaveValue('');
  await page.getByRole('button', { name: 'Период аналитики' }).click();
  const dialog = page.getByRole('dialog', { name: 'Период', exact: true });
  await dialog.getByRole('radio', { name: /^30 дней/ }).click();
  await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.locator('.pico-levels')).not.toHaveAttribute('open');
  await expect(page.locator('.pico-level-client-list li')).toHaveCount(3);
  deny();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('Доступ к уровню отозван');
  await expect(page.locator('.pico-levels')).toHaveCount(0);
});
