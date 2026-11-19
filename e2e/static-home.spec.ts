import { expect, Page, test } from '@playwright/test';
import { action, browserToday, navigate, pickInline, prepareDemoAuth } from './helpers';

test.use({ locale: 'ru-RU' });

const agenda = (page: Page) => page.getByRole('region', { name: 'Дела', exact: true });
const rows = (page: Page) => agenda(page).locator('.pico-agenda-row');
const scrollable = (page: Page) => agenda(page).getByRole('region', { name: 'Список дел' });
const companyId = '35e34f14-db30-4fd1-9a46-e7b70d601925';

async function login(page: Page) {
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(agenda(page)).toBeVisible();
}

function task(id: string, due: string | null, time: string | null, type: string) {
  return {
    id,
    version: 1,
    companyId,
    companyName: 'Компания',
    kind: 'task',
    data: { text: id, due, time, type, done: false },
  };
}

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`Home empty agenda and actions stay reachable at ${size.width}`, async ({ page }, info) => {
    await page.setViewportSize(size);
    if (size.width > 760 && info.project.name === 'mobile') {
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
    }
    await page.route('**/api/records/task*', (r) => r.fulfill({ json: [] }));
    await login(page);
    await expect(page.locator('html')).toHaveClass(/pico-home-active/);
    const panel = agenda(page).locator('.pico-agenda-panel');
    if (size.width > 760) await expect(panel).toHaveCSS('height', '296px');
    else expect((await panel.boundingBox())!.height).toBeGreaterThanOrEqual(280);
    await expect(agenda(page).getByRole('heading', { name: 'Дела' })).toHaveCSS('height', '44px');
    await expect(panel).toContainText('День свободен');
    await expect(panel).toContainText('Время сделать шаг к новой сделке');
    const freeDay = panel.locator('.pico-agenda-empty-heading');
    await expect(freeDay.locator('svg')).toHaveCount(0);
    const shortcut = panel.getByRole('button', { name: /^Позвонить клиенту/ });
    expect((await freeDay.boundingBox())!.x).toBe((await shortcut.boundingBox())!.x);
    await expect(scrollable(page)).toHaveCount(0);
    await expect(panel.locator('.pico-agenda-fade, .pico-agenda-scroll-track')).toHaveCount(0);

    const add = panel.getByRole('button', { name: 'Добавить задачу', exact: true });
    await expect(add).toHaveCSS('height', '48px');
    for (const [label, type] of [
      ['Позвонить клиенту', 'Звонок'],
      ['Назначить встречу', 'Встреча'],
      ['Поставить задачу', 'Задача'],
      ['Добавить задачу', 'Задача'],
    ]) {
      await panel.getByRole('button', { name: new RegExp('^' + label) }).click();
      const sheet = page.getByRole('dialog', { name: 'Новая задача', exact: true });
      await expect(sheet.getByRole('textbox', { name: 'Что нужно сделать?' })).toBeFocused();
      const typeButton = sheet.getByRole('button', { name: type, exact: true });
      await expect(typeButton).toHaveAttribute('aria-expanded', 'false');
      await expect(sheet.getByLabel('Срок')).toHaveValue(await browserToday(page));
      await expect(sheet.getByLabel('Время', { exact: true })).toHaveValue('');
      await expect(sheet.getByRole('button', { name: 'Создать задачу' })).toBeDisabled();
      if (label === 'Добавить задачу') {
        const fields = sheet.locator('.pico-picker-box');
        await expect(fields.locator('.pico-picker-row-label')).toHaveText([
          'Дата',
          'Время',
          'Тип',
          'Клиент',
          'Проект',
          'Ответственный',
        ]);
        await expect(fields).toContainText(/Сегодня, /);
        await expect(fields).toContainText('Не указано');
        await expect(sheet.getByPlaceholder('Что нужно сделать?')).toHaveCSS('min-height', '52px');
        await expect(fields.locator('.pico-picker-row').first()).toHaveCSS('min-height', '45px');
        await page.screenshot({ path: info.outputPath(`home-create-empty-${size.width}.png`) });
        await typeButton.click();
        await sheet.getByRole('button', { name: 'Звонок', exact: true }).click();
        await expect(sheet.getByRole('button', { name: 'Звонок', exact: true })).toHaveAttribute(
          'aria-expanded',
          'false',
        );
      }
      await sheet.getByRole('button', { name: 'Закрыть' }).click();
    }

    await page.locator('.pico-home-workspace').evaluate((el) => {
      el.scrollTop = 0;
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width);
    if (size.width === 390) {
      const nav = (await page.locator('.pico-bottom-nav').boundingBox())!;
      const dots = (await page.locator('.pico-home-action-dots').boundingBox())!;
      expect(nav.y).toBe(772);
      expect(dots.y + dots.height).toBeCloseTo(nav.y - 5, 0);
      await expect(page.locator('.pico-home-workspace')).toHaveJSProperty('scrollTop', 0);
    }
    await page.screenshot({ path: info.outputPath(`home-empty-${size.width}.png`) });
    if (size.width === 320) {
      const workspace = page.locator('.pico-home-workspace');
      await workspace.evaluate((el) => (el.scrollTop = el.scrollHeight));
      const dots = (await page.locator('.pico-home-action-dots').boundingBox())!;
      const nav = (await page.locator('.pico-bottom-nav').boundingBox())!;
      expect(dots.y + dots.height).toBeCloseTo(nav.y - 5, 0);
      await page.screenshot({ path: info.outputPath('home-short-scroll-bottom.png') });
      await workspace.evaluate((el) => (el.scrollTop = 0));
    }
    await action(page, 'С чего начать');
    await expect(page.getByRole('dialog', { name: 'С чего начать' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();
    await navigate(page, 'Задачи');
    await expect(page.locator('html')).not.toHaveClass(/pico-home-active/);
  });
}

test('Home agenda and carousel fit the Telegram header reserve at 390x844', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperties(screen, {
      width: { configurable: true, value: 390 },
      height: { configurable: true, value: 844 },
    });
    Object.defineProperties(screen.orientation, {
      type: { configurable: true, value: 'portrait-primary' },
      angle: { configurable: true, value: 0 },
    });
    (window as typeof window & { Telegram: unknown }).Telegram = {
      WebApp: {
        platform: 'ios',
        viewportStableHeight: 844,
        safeAreaInset: { top: 47, bottom: 34 },
        contentSafeAreaInset: { top: 51 },
      },
    };
  });
  await page.route('**/api/records/task*', (route) => route.fulfill({ json: [] }));
  await login(page);
  const dots = page.locator('.pico-home-action-dots');
  await expect(dots).toBeVisible();
  const dotsBox = (await dots.boundingBox())!;
  const navigation = (await page.locator('.pico-bottom-nav').boundingBox())!;
  expect(dotsBox.y + dotsBox.height).toBeCloseTo(navigation.y - 5, 0);
  expect(navigation.y).toBe(751);
  await expect(page.locator('.pico-home-workspace')).toHaveJSProperty('scrollTop', 0);
  await page.screenshot({ path: info.outputPath('home-telegram-390.png') });
});

test('Home sorts open tasks, keeps one agenda height and shows scrollbar only during scrolling', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const date = await browserToday(page);
  let data = [
    task('Без даты', null, null, 'reminder'),
    task('Сегодня без времени', date, null, 'meeting'),
    task('Позже', '2099-01-01', '12:30', 'call'),
    task('Сегодня после обеда', date, '13:00', 'meeting'),
    task('Старая задача', '2020-01-01', null, 'reminder'),
    task('Сегодня утром', date, '09:00', 'call'),
  ];
  const done = task('Завершённая', date, '07:00', 'call');
  const deleted = task('Удалённая', date, '08:00', 'call');
  await page.route('**/api/records/task*', (r) =>
    r.fulfill({
      json: [
        ...data,
        { ...done, data: { ...done.data, done: true } },
        {
          ...deleted,
          data: { ...deleted.data, deleted: true },
        },
      ],
    }),
  );
  await login(page);
  const add = agenda(page).getByRole('button', { name: 'Добавить задачу' });
  const addBox = await add.boundingBox();
  const navBox = await page.locator('.pico-bottom-nav').boundingBox();
  await expect(rows(page).locator('strong')).toHaveText([
    'Старая задача',
    'Сегодня утром',
    'Сегодня после обеда',
    'Сегодня без времени',
    'Позже',
    'Без даты',
  ]);
  await expect(page.locator('.pico-summary strong').last()).toHaveText('6');
  await expect(rows(page).first().locator('.pico-agenda-overdue')).toContainText('Просрочено');
  await expect(rows(page).first().locator('.pico-agenda-checkbox')).toHaveCSS('width', '44px');
  await expect(agenda(page).locator('.pico-agenda-fade')).toBeVisible();
  const thumb = agenda(page).locator('.pico-agenda-scroll-track > span');
  await expect(thumb).toHaveCSS('opacity', '0');
  await page.screenshot({ path: info.outputPath('home-populated.png') });
  await scrollable(page).focus();
  await scrollable(page).press('End');
  await expect.poll(() => scrollable(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(agenda(page).locator('.pico-agenda-fade')).toHaveCount(0);
  await expect(thumb).toHaveCSS('opacity', '1');
  await expect(thumb).toHaveCSS('opacity', '0');
  expect(await add.boundingBox()).toEqual(addBox);
  expect(await page.locator('.pico-bottom-nav').boundingBox()).toEqual(navBox);

  for (const n of [4, 3, 2, 1]) {
    data = data.slice(0, n);
    await page.reload();
    await expect(rows(page)).toHaveCount(n);
    await expect(scrollable(page)).toHaveCount(0);
    await expect(agenda(page).locator('.pico-agenda-fade, .pico-agenda-scroll-track')).toHaveCount(
      0,
    );
    await expect(agenda(page).locator('.pico-agenda-hint')).toHaveCount(n <= 2 ? 1 : 0);
    expect(await add.boundingBox()).toEqual(addBox);
  }
});

test('Home task details save changes on close, and creation sends the selected client and default actor', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const date = await browserToday(page);
  let tasks = [task('Позвонить коллеге', date, '12:30', 'call')];
  await page.route('**/api/companies', (r) =>
    r.fulfill({
      json: [
        { id: companyId, name: 'Компания для задачи', archived: false, industry: '', city: '' },
      ],
    }),
  );
  await page.route(`**/api/companies/${companyId}`, (r) => r.fulfill({ json: { records: [] } }));
  await page.route('**/api/records/task*', (r) => r.fulfill({ json: tasks }));
  await page.route('**/api/tasks/*/advice', (r) =>
    r.fulfill({ json: { text: 'Проверьте следующий шаг.' } }),
  );
  await page.route('**/api/records/*', async (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback();
    const body = r.request().postDataJSON();
    tasks[0] = { ...tasks[0], version: tasks[0].version + 1, data: body.data };
    await r.fulfill({ json: tasks[0] });
  });
  await page.route(`**/api/companies/${companyId}/records/task`, async (r) => {
    const body = r.request().postDataJSON();
    expect(body).toEqual({
      assignToSelf: true,
      projectId: null,
      data: {
        text: 'Подготовить КП',
        due: date,
        time: '17:15',
        contactId: null,
        type: 'reminder',
        done: false,
      },
    });
    tasks.push({ ...task('Подготовить КП', date, '17:15', 'reminder'), data: body.data });
    await r.fulfill({ status: 201, json: tasks.at(-1) });
  });
  await login(page);
  await rows(page).locator('.pico-agenda-open').click();
  const detail = page.getByRole('dialog', { name: 'Позвонить коллеге', exact: true });
  await expect(detail.getByRole('button', { name: 'Выполнено' })).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await detail.getByRole('button', { name: 'Время', exact: true }).click();
  const field = page.getByRole('dialog', { name: 'Изменить Время', exact: true });
  await field.getByLabel('Время', { exact: true }).fill('16:45');
  await field.getByRole('button', { name: 'Закрыть' }).click();
  await expect(field).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Время', exact: true })).toContainText('16:45');
  await detail.getByRole('button', { name: 'Закрыть' }).click();
  await expect(rows(page)).toContainText('Сегодня, 16:45');

  await agenda(page).getByRole('button', { name: 'Добавить задачу' }).click();
  const create = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await create.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Подготовить КП');
  const due = create.getByLabel('Срок', { exact: true });
  await due.fill('2027-01-01');
  await expect(due.locator('..')).toContainText('пт 1 января');
  await due.fill(date);
  await create.getByLabel('Время', { exact: true }).fill('17:15');
  await expect(
    create.locator('.pico-picker-value').getByText('17:15', { exact: true }),
  ).toBeVisible();
  await pickInline(page, create, 'Клиент', 'Компания для задачи');
  await page.screenshot({ path: info.outputPath('home-create.png') });
  await create.getByRole('button', { name: 'Создать задачу' }).click();
  await expect(create).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).last()).toContainText('Подготовить КП');
});
