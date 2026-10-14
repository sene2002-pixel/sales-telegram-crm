import { createHmac, randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  // A portrait tablet can have a wide or keyboard-shortened window; no portrait guard is disabled.
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
});
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
async function api(page: Page, path: string, token: string, data?: unknown) {
  const response = await page.request.fetch('/api' + path, {
    method: data ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token },
    data,
  });
  expect(response.ok(), path).toBeTruthy();
  return response.json();
}
async function setup(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = (await page.evaluate(() => sessionStorage.getItem('crm-session')))!;
  const actor = await api(page, '/users', token, {
    telegramId: String(Date.now()) + String(Math.floor(Math.random() * 100)).padStart(2, '0'),
    name: 'Экран-' + randomUUID().slice(0, 8),
    role: 'manager',
    active: true,
    supervisorId: null,
  });
  const company = await api(page, '/companies', localToken(actor.id), {
    name: 'ООО «Экран ' + randomUUID().slice(0, 8) + '»',
    potential: 12_345_678.9,
  });
  const project = await api(page, `/companies/${company.id}/records/project`, token, {
    data: { name: 'Проект ' + randomUUID().slice(0, 8), amount: 987_654.32 },
  });
  const dates = await page.evaluate(() => {
    const format = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = new Date(),
      past = new Date(now),
      future = new Date(now);
    past.setDate(now.getDate() - 1);
    future.setDate(now.getDate() + 1);
    return {
      today: format(now),
      past: format(past),
      future: format(future),
      month: format(now).slice(0, 7),
    };
  });
  async function task(text: string, due: string, type = 'call', done = false) {
    return api(page, `/companies/${company.id}/records/task`, token, {
      projectId: project.id,
      data: { text, due, type, time: '12:00', done },
    });
  }
  async function scope() {
    await page.reload();
    await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
    await page.getByRole('combobox', { name: 'Данные сотрудника' }).selectOption(actor.id);
    await expect(page.locator('.pico-summary')).toBeVisible();
  }
  return { token, actor, company, project, dates, task, scope };
}
async function filterGeometry(page: Page, label: string) {
  const filter = page.getByRole('button', { name: label, exact: true }),
    box = (await filter.boundingBox())!,
    row = (await page.locator('.pico-filter-chip-row').boundingBox())!;
  expect(box.width).toBeCloseTo(60, 0);
  expect(box.height).toBeCloseTo(30, 0);
  expect(box.x + box.width).toBeCloseTo(row.x + row.width, 0);
  await filter.click();
  await expect(page.getByRole('dialog', { name: label, exact: true })).toBeVisible();
}

test('Asana screens: compact Home counts and overdue shortcut show only actual overdue tasks at every width', async ({
  page,
}, info) => {
  const f = await setup(page);
  await f.task('Просрочена ' + f.actor.name, f.dates.past);
  await f.task('Сегодня ' + f.actor.name, f.dates.today);
  await f.task('Будущая ' + f.actor.name, f.dates.future);
  await f.task('Завершённая ' + f.actor.name, f.dates.past, 'call', true);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await f.scope();
    const card = page.locator('.pico-home-overview'),
      bounds = (await card.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(122);
    await expect(card.locator('.pico-summary strong')).toHaveText(['1', '1', '3']);
    const icon = (await page.locator('.pico-employee-notebook').boundingBox())!;
    expect(icon.width).toBe(36);
    expect(icon.height).toBe(36);
    expect(
      await card.locator('select').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBe(16);
    await page.screenshot({ path: info.outputPath(`home-${width}.png`) });
    await page.getByRole('button', { name: 'Просроченные задачи · 1', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
    await expect(page.locator('.pico-task-row')).toHaveCount(1);
    await expect(page.locator('.pico-task-row')).toContainText('Просрочена ' + f.actor.name);
    await expect(page.getByRole('combobox', { name: 'Данные сотрудника' })).toHaveCount(0);
    await filterGeometry(page, 'Фильтры задач');
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Просроченные', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('dialog').getByRole('button', { name: 'Сбросить', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Показать (3)', exact: true })
      .click();
    await expect(page.locator('.pico-task-row')).toHaveCount(3);
    await page.screenshot({ path: info.outputPath(`tasks-${width}.png`) });
  }
});

test('Asana screens: date dots cap at three with full accessible count and distinguish empty day from filters', async ({
  page,
}, info) => {
  const f = await setup(page);
  const days = [f.dates.month + '-01', f.dates.month + '-02', f.dates.month + '-03'];
  for (let day = 0; day < 3; day++)
    for (let i = 0; i < [1, 2, 4][day]!; i++)
      await f.task(`День ${day + 1} задача ${i}`, days[day]!, ['call', 'meeting', 'email'][day]!);
  await f.task('Выполненная не даёт точку', days[2]!, 'call', true);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await f.scope();
    await navigate(page, 'Задачи');
    for (let day = 0; day < 3; day++) {
      const count = [1, 2, 4][day]!,
        button = page.getByRole('button', {
          name: `${days[day]}, открытых задач: ${count}`,
          exact: true,
        });
      await expect(button.locator('.pico-calendar-dots')).toHaveAttribute('aria-hidden', 'true');
      await expect(button.locator('.pico-calendar-dots i')).toHaveCount(Math.min(count, 3));
    }
    await page.getByRole('button', { name: f.dates.month + '-04', exact: true }).click();
    await expect(page.getByText('Этот день пока свободен', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Кто планирует день, быстрее приходит к результату. Добавьте первую задачу.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`calendar-empty-${width}.png`) });
    await page.getByRole('button', { name: `${days[0]}, открытых задач: 1`, exact: true }).click();
    await filterGeometry(page, 'Фильтры задач');
    await page.getByRole('dialog').getByRole('button', { name: 'Встреча', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Показать (0)', exact: true })
      .click();
    await expect(page.getByText('Нет задач по выбранным фильтрам', { exact: true })).toBeVisible();
    await expect(page.getByText('Этот день пока свободен', { exact: true })).toHaveCount(0);
    await filterGeometry(page, 'Фильтры задач');
    await page.getByRole('dialog').getByRole('button', { name: 'Сбросить', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Показать (7)', exact: true })
      .click();
    await expect(page.locator('.pico-task-row')).toHaveCount(7);
  }
});

test('Asana screens: client/project filters align right and compact money keeps the exact amount in its title', async ({
  page,
}, info) => {
  const f = await setup(page);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await f.scope();
    await navigate(page, 'Клиенты');
    const potential = page.locator('.pico-client-accordion .company-money strong');
    const expected = await page.evaluate(
      (amount) => ({
        compact: new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: 'RUB',
          notation: 'compact',
          maximumFractionDigits: 1,
        }).format(amount),
        full: new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: 'RUB',
          maximumFractionDigits: 2,
        }).format(amount),
      }),
      12_345_678.9,
    );
    await expect(potential).toHaveText(expected.compact);
    await expect(potential).toHaveAttribute('title', expected.full);
    await filterGeometry(page, 'Фильтры клиентов');
    await page.getByRole('dialog').getByRole('button', { name: 'Сбросить', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Показать/ })
      .click();
    await page.screenshot({ path: info.outputPath(`clients-${width}.png`) });
    await navigate(page, 'Проекты');
    const amount = page.locator('.pico-project-row b[title]');
    const projectExpected = await page.evaluate(
      (n) =>
        new Intl.NumberFormat('ru-RU', {
          style: 'currency',
          currency: 'RUB',
          maximumFractionDigits: 2,
        }).format(n),
      987_654.32,
    );
    await expect(amount).toHaveAttribute('title', projectExpected);
    await filterGeometry(page, 'Фильтры проектов');
    await page.getByRole('dialog').getByRole('button', { name: 'Сбросить', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Показать/ })
      .click();
    await expect(page.locator('.pico-project-row')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`projects-${width}.png`) });
  }
});
