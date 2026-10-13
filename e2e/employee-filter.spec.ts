import { createHmac, randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { action, navigate, prepareDemoAuth } from './helpers';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
});

// Tokens authenticate synthetic actors created only on the documented local E2E server.
function localToken(id: string) {
  const payload = Buffer.from(
    JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  return (
    payload +
    '.' +
    createHmac('sha256', 'e2e-local-secret-not-a-production-secret')
      .update(payload)
      .digest('base64url')
  );
}
async function api(
  page: Page,
  path: string,
  token: string,
  data?: unknown,
  method = data ? 'POST' : 'GET',
) {
  const response = await page.request.fetch('/api' + path, {
    method,
    data,
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(response.ok(), method + ' ' + path).toBeTruthy();
  return response.json();
}
async function enter(page: Page, token: string) {
  await page.evaluate((value) => sessionStorage.setItem('crm-session', value), token);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
}
async function fixture(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const adminToken = (await page.evaluate(() => sessionStorage.getItem('crm-session')))!;
  const admin = await api(page, '/me', adminToken),
    tag = Date.now() + '-' + Math.floor(Math.random() * 100000);
  async function user(
    prefix: string,
    role: string,
    supervisorId: string | null = null,
    active = true,
  ) {
    const actor = await api(page, '/users', adminToken, {
      telegramId: String(Date.now()) + String(Math.floor(Math.random() * 100)).padStart(2, '0'),
      name: prefix + '-' + tag,
      role,
      active,
      supervisorId,
    });
    return { ...actor, token: localToken(actor.id) };
  }
  const supervisor = await user('Руководитель', 'supervisor');
  const a = await user('СотрудникА', 'manager', supervisor.id),
    b = await user('СотрудникБ', 'manager', supervisor.id);
  const outsider = await user('ВнеКоманды', 'manager'),
    inactive = await user('Неактивный', 'manager', supervisor.id, false);
  async function company(prefix: string, actor: any, potential: number) {
    return api(page, '/companies', actor.token, {
      name: prefix + '-' + tag,
      potential,
      divisions: { lv: potential },
    });
  }
  const ca = await company('КлиентА', a, 11_000_000),
    cb = await company('КлиентБ', b, 22_000_000),
    outside = await company('ЧужойКлиент', outsider, 99_000_000);
  const own = await company('КлиентРуководителя', supervisor, 2_000_000),
    transferred = await company('ПереданныйКлиент', a, 33_000_000);
  const pa = await api(page, `/companies/${ca.id}/records/project`, adminToken, {
    data: { name: 'ПроектА-' + tag, amount: 11_000_000 },
  });
  const pb = await api(page, `/companies/${cb.id}/records/project`, adminToken, {
    data: { name: 'ПроектБ-' + tag, amount: 22_000_000 },
  });
  const pc = await api(page, `/companies/${transferred.id}/records/project`, adminToken, {
    data: { name: 'ПроектПереданный-' + tag, amount: 33_000_000 },
  });
  const due = new Date().toISOString().slice(0, 10);
  const ta = await api(page, `/companies/${ca.id}/records/task`, adminToken, {
    data: { text: 'ЗадачаА-' + tag, type: 'call', due, time: '12:00' },
  });
  const tb = await api(page, `/companies/${cb.id}/records/task`, adminToken, {
    data: { text: 'ЗадачаБ-' + tag, type: 'call', due, time: '12:00' },
  });
  const old = await api(page, `/companies/${transferred.id}/records/task`, adminToken, {
    projectId: pc.id,
    data: { text: 'ВыполненнаяА-' + tag, type: 'call', done: true, due, time: '12:00' },
  });
  await api(page, `/companies/${transferred.id}/assign`, adminToken, {
    ownerId: b.id,
    version: transferred.version,
  });
  await api(page, '/reports', a.token, { text: 'ОтчётА-' + tag, requestId: randomUUID() });
  await api(page, '/reports', b.token, { text: 'ОтчётБ-' + tag, requestId: randomUUID() });
  return {
    admin,
    adminToken,
    tag,
    supervisor,
    a,
    b,
    outsider,
    inactive,
    ca,
    cb,
    outside,
    own,
    transferred,
    pa,
    pb,
    pc,
    ta,
    tb,
    old,
  };
}
function selection(page: Page) {
  return page.getByRole('combobox', { name: 'Данные сотрудника', exact: true });
}
function client(page: Page, name: string) {
  return page.locator('.pico-client-accordion').filter({ hasText: name });
}
async function currentRoute(page: Page) {
  const heading = page.locator('.workspace h1').first();
  const title = (await heading.count())
    ? (await heading.textContent()) || ''
    : (await page
        .locator('nav:visible button.active, .pico-secondary-nav:visible button.active')
        .first()
        .textContent()) || '';
  return title.startsWith('Привет') ? 'Главная' : title;
}
async function selectScope(page: Page, id: string, wait = false) {
  const route = await currentRoute(page);
  await navigate(page, 'Главная');
  await selection(page).selectOption(id);
  if (wait) await expect(page.locator('.pico-scoped-content')).toBeVisible();
  if (route && route !== 'Главная') await navigate(page, route);
}
async function choose(page: Page, id: string) {
  await selectScope(page, id, true);
}
async function storedScope(page: Page) {
  return page.evaluate(() => {
    const token = sessionStorage.getItem('crm-session');
    if (!token) return '';
    const id = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).sub;
    return sessionStorage.getItem(`pico-employee-filter:${id}`) || '';
  });
}
async function refresh(page: Page) {
  if (await page.locator('.connection-state:visible').count())
    await page
      .locator('.connection-state')
      .getByRole('button', { name: 'Обновить', exact: true })
      .click();
  else {
    await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    await page
      .locator('.pico-more-menu')
      .getByRole('button', { name: 'Обновить', exact: true })
      .click();
  }
}

test('Employee filter: supervisor options preserve base ACL and task assignee differs from current client owner', async ({
  page,
}) => {
  const f = await fixture(page);
  await enter(page, f.supervisor.token);
  await navigate(page, 'Клиенты');
  await expect(client(page, f.outside.name)).toBeVisible();
  await navigate(page, 'Главная');
  const values = await selection(page)
    .locator('option')
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
  expect(values).toEqual(expect.arrayContaining(['', f.supervisor.id, f.a.id, f.b.id]));
  expect(values).not.toContain(f.outsider.id);
  expect(values).not.toContain(f.inactive.id);
  expect(values).not.toContain(f.admin.id);
  await navigate(page, 'Клиенты');
  await choose(page, f.a.id);
  await expect(client(page, f.ca.name)).toBeVisible();
  await expect(client(page, f.cb.name)).toHaveCount(0);
  await expect(client(page, f.transferred.name)).toHaveCount(0);
  await navigate(page, 'Проекты');
  await expect(page.getByText('Проекты клиентов сотрудника', { exact: true })).toBeVisible();
  await expect(page.locator('.pico-project-row').filter({ hasText: f.pa.data.name })).toBeVisible();
  await expect(page.locator('.pico-project-row').filter({ hasText: f.pc.data.name })).toHaveCount(
    0,
  );
  await navigate(page, 'Задачи');
  await page.getByRole('button', { name: 'Фильтры задач', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Выполненные', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Показать/ })
    .click();
  const completed = page.locator('.pico-task-row').filter({ hasText: f.old.data.text });
  await expect(completed).toBeVisible();
  await expect(completed).toContainText(f.pc.data.name);
  await completed.locator('.task-text').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(f.a.name);
  await expect(dialog).toContainText(f.transferred.name);
  await dialog.getByRole('button', { name: 'Открыть клиента', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(f.transferred.name);
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await enter(page, f.a.token);
  await expect(selection(page)).toHaveCount(0);
  await navigate(page, 'Клиенты');
  await expect(client(page, f.ca.name)).toBeVisible();
  await expect(client(page, f.cb.name)).toHaveCount(0);
});

test('Employee filter: admin persistence, unaffected account pages and creation keep the real principal', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.reload();
  await navigate(page, 'Клиенты');
  await navigate(page, 'Главная');
  const adminOptions = await selection(page)
    .locator('option')
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
  expect(adminOptions).toEqual(
    expect.arrayContaining([f.admin.id, f.supervisor.id, f.a.id, f.b.id, f.outsider.id]),
  );
  expect(adminOptions).not.toContain(f.inactive.id);
  await choose(page, f.a.id);
  const panel = page.locator('.pico-employee-filter'),
    header = (await page.locator('.workspace > header').boundingBox())!,
    box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
  const card = (await page.locator('.pico-home-overview').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(card.x);
  expect(box.y).toBeGreaterThanOrEqual(card.y);
  expect(box.width).toBeLessThanOrEqual(card.width);
  if (info.project.name === 'mobile')
    expect(
      await selection(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
  const reset = (await page
    .getByRole('button', { name: 'Сбросить фильтр сотрудника', exact: true })
    .boundingBox())!;
  expect(reset.width).toBeGreaterThanOrEqual(40);
  expect(reset.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: info.outputPath('employee-filter-selected.png') });
  for (const name of ['Мой профиль', 'Команда', 'Пользователи']) {
    await navigate(page, name);
    await expect(selection(page)).toHaveCount(0);
  }
  await navigate(page, 'Клиенты');
  await expect.poll(() => storedScope(page)).toBe(f.a.id);
  await page.reload();
  await expect.poll(() => storedScope(page)).toBe(f.a.id);
  await navigate(page, 'Клиенты');
  await expect(client(page, f.ca.name)).toBeVisible();
  await navigate(page, 'Клиенты');
  await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
  await expect(dialog).toContainText('Фильтр не меняет ответственного');
  const name = 'СозданФактическим-' + f.tag;
  await dialog.getByLabel('Название', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  await expect.poll(() => storedScope(page)).toBe('');
  const stored = (await api(page, '/companies', f.adminToken)).find((c: any) => c.name === name);
  expect(stored.ownerId).toBe(f.admin.id);
  await choose(page, f.b.id);
  await navigate(page, 'Главная');
  await page.getByRole('button', { name: 'Сбросить фильтр сотрудника', exact: true }).click();
  await expect.poll(() => storedScope(page)).toBe('');
});

test('Employee filter: delayed A responses cannot replace B during navigation or a later login', async ({
  page,
}) => {
  const f = await fixture(page);
  await enter(page, f.supervisor.token);
  await navigate(page, 'Клиенты');
  let release!: () => void, seen!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (seen = r));
  await page.route('**/api/companies?employeeId=*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('employeeId') === f.a.id) {
      seen();
      const response = await route.fetch();
      await hold;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const oldResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/companies' &&
      new URL(r.url()).searchParams.get('employeeId') === f.a.id,
  );
  await selectScope(page, f.a.id);
  await started;
  await expect(page.locator('.pico-client-accordion')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('selected-loading.png') });
  await selectScope(page, f.b.id);
  await expect(client(page, f.cb.name)).toBeVisible();
  await navigate(page, 'Проекты');
  await expect(page.locator('.pico-project-row').filter({ hasText: f.pb.data.name })).toBeVisible();
  release();
  await oldResponse;
  await expect.poll(() => storedScope(page)).toBe(f.b.id);
  await expect(page.locator('.pico-project-row').filter({ hasText: f.pa.data.name })).toHaveCount(
    0,
  );
  await page.unroute('**/api/companies?employeeId=*');
  let finish!: () => void, reportSeen!: () => void;
  const pause = new Promise<void>((r) => (finish = r)),
    reportStarted = new Promise<void>((r) => (reportSeen = r));
  await page.route('**/api/reports?employeeId=*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('employeeId') === f.a.id) {
      reportSeen();
      const response = await route.fetch();
      await pause;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const staleReport = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/reports' &&
      new URL(r.url()).searchParams.get('employeeId') === f.a.id,
  );
  await choose(page, f.a.id);
  await navigate(page, 'Отчёты');
  await reportStarted;
  await selectScope(page, f.b.id);
  await expect(page.locator('.report-row')).toContainText([f.b.name]);
  finish();
  await staleReport;
  await expect.poll(() => storedScope(page)).toBe(f.b.id);
  await expect(page.locator('.report-row').filter({ hasText: f.a.name })).toHaveCount(0);
  await navigate(page, 'Клиенты');
  await choose(page, f.a.id);
  let releaseLogout!: () => void, logoutSeen!: () => void;
  const logoutHold = new Promise<void>((r) => (releaseLogout = r)),
    logoutStarted = new Promise<void>((r) => (logoutSeen = r));
  await page.route('**/api/companies?employeeId=*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('employeeId') === f.b.id) {
      logoutSeen();
      const response = await route.fetch();
      await logoutHold;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const staleLogout = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/companies' &&
      new URL(r.url()).searchParams.get('employeeId') === f.b.id,
  );
  await selectScope(page, f.b.id);
  await logoutStarted;
  const desktopLogout = page.getByTitle('Выйти', { exact: true });
  if (await desktopLogout.isVisible()) await desktopLogout.click();
  else await action(page, 'Выйти');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  releaseLogout();
  await staleLogout;
  await expect(selection(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toContainText(f.cb.name);
});

test('Employee filter: employee revocation resets scope and errors never retain previous client rows', async ({
  page,
}) => {
  const f = await fixture(page);
  await enter(page, f.supervisor.token);
  await navigate(page, 'Клиенты');
  await choose(page, f.a.id);
  await expect(client(page, f.ca.name)).toBeVisible();
  await api(page, '/users', f.adminToken, {
    telegramId: f.a.telegramId,
    name: f.a.name,
    role: 'manager',
    active: false,
    supervisorId: f.supervisor.id,
  });
  await refresh(page);
  await expect.poll(() => storedScope(page)).toBe('');
  await expect(page.getByRole('alert')).toContainText('сотрудник больше недоступен');
  expect(
    (await api(page, '/employee-filter/options', f.supervisor.token)).map((o: any) => o.id),
  ).not.toContain(f.a.id);
  await page.route('**/api/companies?employeeId=*', (route) =>
    new URL(route.request().url()).searchParams.get('employeeId') === f.b.id
      ? route.fulfill({ status: 503, json: { message: 'Синтетическая ошибка scoped данных' } })
      : route.continue(),
  );
  await navigate(page, 'Главная');
  await selection(page).selectOption(f.b.id);
  await expect(page.getByRole('alert')).toContainText('Синтетическая ошибка scoped данных');
  await page.screenshot({ path: test.info().outputPath('selected-error.png') });
  await expect(page.locator('.pico-client-accordion')).toHaveCount(0);
  await page.unroute('**/api/companies?employeeId=*');
  await refresh(page);
  await expect(page.locator('.pico-scoped-content')).toBeVisible();
  await navigate(page, 'Клиенты');
  await expect(client(page, f.cb.name)).toBeVisible();
  await expect(page.getByText('Синтетическая ошибка scoped данных', { exact: true })).toHaveCount(
    0,
  );
  await api(page, '/users', f.adminToken, {
    telegramId: f.supervisor.telegramId,
    name: f.supervisor.name,
    role: 'manager',
    active: true,
    supervisorId: null,
  });
  await refresh(page);
  await expect(selection(page)).toHaveCount(0);
  await navigate(page, 'Клиенты');
  await expect(client(page, f.own.name)).toBeVisible();
  await expect(client(page, f.cb.name)).toHaveCount(0);
});

test('Employee filter: applied analytics period survives scope changes and binds commercial authors', async ({
  page,
}) => {
  const f = await fixture(page);
  await enter(page, f.supervisor.token);
  await navigate(page, 'Аналитика');
  await choose(page, f.a.id);
  await page.getByRole('button', { name: 'Период аналитики' }).click();
  const period = page.getByRole('dialog');
  await period.getByRole('radio', { name: 'Свой период' }).click();
  await period.getByLabel('Начало периода').fill('2026-01-01');
  await period.getByLabel('Конец периода').fill('2026-12-31');
  await period.getByRole('button', { name: 'Применить', exact: true }).click();
  const analytics = page.waitForResponse((r) => {
    const u = new URL(r.url());
    return (
      u.pathname === '/api/analytics' &&
      u.searchParams.get('employeeId') === f.b.id &&
      u.searchParams.get('from') === '2026-01-01' &&
      u.searchParams.get('to') === '2026-12-31'
    );
  });
  await choose(page, f.b.id);
  expect((await analytics).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Период аналитики' })).toContainText('Свой период');
  await page.getByRole('button', { name: 'Коммерческий отчёт руководителю' }).click();
  await expect(page.getByLabel('Период с')).toHaveValue('2026-01-01');
  await expect(page.getByLabel('Период по')).toHaveValue('2026-12-31');
  await expect(page.getByLabel('Данные менеджера')).toHaveCount(0);
  const report = page.waitForResponse((r) => {
    const u = new URL(r.url());
    return (
      u.pathname === '/api/dashboard/commercial' &&
      u.searchParams.get('employeeId') === f.b.id &&
      u.searchParams.get('authorId') === f.b.id &&
      u.searchParams.get('from') === '2026-01-01' &&
      u.searchParams.get('to') === '2026-12-31'
    );
  });
  await page.getByRole('button', { name: 'Сформировать коммерческий отчёт' }).click();
  expect((await report).ok()).toBeTruthy();
  await expect(page.locator('pre.commercial-report')).toBeVisible();
});

for (const child of ['analytics', 'commercial'] as const) {
  test(`Employee filter: denied ${child} child request clears the entire still-eligible scope`, async ({
    page,
  }) => {
    const f = await fixture(page);
    await enter(page, f.supervisor.token);
    await navigate(page, 'Клиенты');
    await choose(page, f.a.id);
    await expect(client(page, f.ca.name)).toBeVisible();
    const endpoint = child === 'analytics' ? '**/api/analytics?*' : '**/api/dashboard/commercial?*';
    if (child === 'commercial') {
      await navigate(page, 'Аналитика');
      await page.getByRole('button', { name: 'Коммерческий отчёт руководителю' }).click();
      await page.getByRole('button', { name: 'Сформировать коммерческий отчёт' }).click();
      await expect(page.locator('pre.commercial-report')).toBeVisible();
    }
    await page.route(endpoint, (route) =>
      route.fulfill({
        status: child === 'analytics' ? 403 : 401,
        json: { message: 'Синтетический отказ дочернего scope' },
      }),
    );
    if (child === 'analytics') await navigate(page, 'Аналитика');
    else await page.getByRole('button', { name: 'Сформировать коммерческий отчёт' }).click();
    await expect(page.getByRole('alert')).toContainText('Синтетический отказ дочернего scope');
    await expect.poll(() => storedScope(page)).toBe(f.a.id);
    expect(
      (await api(page, '/employee-filter/options', f.supervisor.token)).map((o: any) => o.id),
    ).toContain(f.a.id);
    await expect(page.locator('.pico-scoped-content')).toHaveCount(0);
    await expect(page.locator('.pico-potential')).toHaveCount(0);
    await expect(page.locator('pre.commercial-report')).toHaveCount(0);
    await navigate(page, 'Клиенты');
    await expect(client(page, f.ca.name)).toHaveCount(0);
    await expect(page.getByText('Данные сотрудника не загружены.', { exact: true })).toBeVisible();
    await page.unroute(endpoint);
    await page.getByRole('button', { name: 'Повторить загрузку' }).click();
    await expect(client(page, f.ca.name)).toBeVisible();
    await expect(
      page.getByText('Синтетический отказ дочернего scope', { exact: true }),
    ).toHaveCount(0);
  });
}

test('Employee filter: initial unavailable options block data until a successful retry', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.route('**/api/employee-filter/options', (route) =>
    route.fulfill({ status: 503, json: { message: 'Синтетическая ошибка списка сотрудников' } }),
  );
  await page.evaluate((token) => sessionStorage.setItem('crm-session', token), f.supervisor.token);
  await page.goto('/');
  await expect(selection(page)).toBeDisabled();
  await expect.poll(() => storedScope(page)).toBe('');
  await expect(selection(page).locator('option:checked')).toHaveText(
    'Список сотрудников недоступен',
  );
  await expect(selection(page).locator('option')).toHaveCount(1);
  await expect(page.locator('.pico-employee-filter-error')).toContainText(
    'Не удалось загрузить список сотрудников',
  );
  await expect(page.locator('.pico-scoped-content')).toHaveCount(0);
  await expect(page.locator('.pico-client-accordion, .pico-task-row')).toHaveCount(0);
  await page.unroute('**/api/employee-filter/options');
  await page
    .getByRole('region', { name: 'Фильтр сотрудника' })
    .getByRole('button', { name: 'Повторить', exact: true })
    .click();
  await expect(selection(page)).toBeEnabled();
  await expect(selection(page).locator('option:checked')).toHaveText('Все сотрудники');
  await expect(selection(page).locator(`option[value="${f.a.id}"]`)).toHaveCount(1);
  await expect(
    page.getByText('Синтетическая ошибка списка сотрудников', { exact: true }),
  ).toHaveCount(0);
  await navigate(page, 'Клиенты');
  await expect(client(page, f.ca.name)).toBeVisible();
});

test('Employee filter: Home shared card, inline crown and settings stay usable at every width', async ({
  page,
}, info) => {
  const f = await fixture(page);
  if (info.project.name === 'mobile')
    await page.addInitScript(() => {
      Object.defineProperties(screen, {
        width: { configurable: true, value: 1440 },
        height: { configurable: true, value: 2560 },
      });
      Object.defineProperties(screen.orientation, {
        type: { configurable: true, value: 'portrait-primary' },
        angle: { configurable: true, value: 0 },
      });
    });
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await enter(page, f.adminToken);
    const greeting = page.locator('.pico-home-greeting'),
      card = page.locator('.pico-home-overview');
    await expect(selection(page)).toHaveCount(1);
    await expect(card.locator('.pico-summary > button')).toHaveCount(3);
    const title = (await greeting.locator('h1').boundingBox())!,
      panel = (await card.boundingBox())!;
    expect(panel.y).toBeGreaterThan(title.y + title.height);
    const crown = (await page
      .getByRole('button', { name: 'Управление пользователями' })
      .boundingBox())!;
    expect(crown.y).toBeLessThan(title.y + title.height);
    expect(crown.width).toBeLessThanOrEqual(30);
    const subtitle = (await greeting.locator('p').boundingBox())!;
    expect(subtitle.y - title.y - title.height).toBeGreaterThanOrEqual(3);
    expect(subtitle.y - title.y - title.height).toBeLessThanOrEqual(5);
    await choose(page, f.a.id);
    await page.screenshot({ path: info.outputPath(`home-${width}.png`) });
    await navigate(page, 'Клиенты');
    await expect(selection(page)).toHaveCount(0);
    await expect(client(page, f.ca.name)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`clients-${width}.png`) });
    await navigate(page, 'Главная');
    await expect(selection(page)).toHaveValue(f.a.id);
    if (width < 500) {
      const gear = page.getByRole('button', { name: 'Дополнительное меню', exact: true });
      const box = (await gear.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await gear.click();
      await expect(page.locator('.pico-more-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.pico-more-menu')).toHaveCount(0);
    }
  }
  await page.addInitScript(() => {
    Object.defineProperty(window.screen, 'width', { configurable: true, value: 390 });
    Object.defineProperty(window.screen, 'height', { configurable: true, value: 844 });
    Object.defineProperty(window.screen.orientation, 'type', {
      configurable: true,
      value: 'portrait-primary',
    });
    Object.defineProperty(window.screen.orientation, 'angle', { configurable: true, value: 0 });
    window.Telegram = {
      WebApp: {
        initData: 'qa-native-header',
        platform: 'android',
        version: '8.0',
        ready() {},
        expand() {},
        isVersionAtLeast() {
          return true;
        },
      },
    } as any;
  });
  await page.route('**/api/auth/telegram', (route) =>
    route.fulfill({ json: { token: f.adminToken } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.app-shell.telegram-native-header')).toBeVisible();
  await expect(page.locator('.mobile-brand')).toBeHidden();
  await expect(selection(page)).toHaveValue(f.a.id);
  await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
  await expect(page.locator('.pico-more-menu')).toBeVisible();
});
