import { expect, test, Page } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

async function login(page: Page) {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ body: '' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
}
const today = () => {
  const day = new Date();
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
};
const feed = (page: Page) => page.getByRole('region', { name: 'Задачи и встречи на главной' });
for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`Home restores exact empty blocks with reachable content at ${size.width}`, async ({
    page,
  }, info) => {
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
    const blocks = page.locator('.pico-home-block');
    await expect(blocks).toHaveCount(2);
    const cards = page.locator('.pico-home-empty');
    await expect(cards).toHaveCount(2);
    await expect(blocks.first().getByRole('heading', { name: 'Сегодня', exact: true })).toHaveCSS(
      'font-size',
      '18px',
    );
    await expect(blocks.first().locator('h2')).toHaveCSS('line-height', '24px');
    await expect(blocks.first().locator('h2')).toHaveCSS('font-weight', '800');
    await expect(blocks.first().locator('h2')).toHaveCSS('margin-top', '20px');
    await expect(blocks.first().locator('h2')).toHaveCSS('margin-bottom', '8px');
    await expect(cards.first()).toContainText(
      'Хорошее время, чтобы запланировать следующий контакт с клиентами.',
    );
    await expect(cards.last()).toContainText(
      'Каждая встреча приближает сделку. Назначьте первую, это займёт минуту.',
    );
    for (const card of await cards.all()) {
      await expect(card).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(card).toHaveCSS('border-radius', '20px');
      await expect(card).toHaveCSS('border-top-color', 'rgb(230, 235, 243)');
      await expect(card).toHaveCSS('padding', '16px 20px 18px');
      await expect(card.locator('.pico-home-empty-icon')).toHaveCSS('width', '40px');
      await expect(card.locator('.pico-home-empty-icon')).toHaveCSS('height', '40px');
      await expect(card.locator('.pico-home-empty-icon')).toHaveCSS('border-radius', '13px');
      await expect(card.locator('strong')).toHaveCSS('font-size', '15px');
      await expect(card.locator('p')).toHaveCSS('font-size', '13px');
      await expect(card.locator('p')).toHaveCSS('line-height', '18px');
      await expect(card.locator('button')).toHaveCount(0);
      await expect(card.locator('svg')).toHaveCount(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      animations: 'disabled',
      path: `/tmp/pico-home-evidence/empty-top-${size.width}-${info.project.name}.png`,
    });
    const nav = page.locator('.pico-bottom-nav');
    const navBefore = await nav.boundingBox();
    await cards.last().evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }));
    const bottom = size.width <= 760 ? (await nav.boundingBox())!.y : size.height;
    const lastBox = (await cards.last().boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(bottom);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await nav.boundingBox()).toEqual(navBefore);
    expect(
      await feed(page).evaluate((el) => {
        const e = new Event('touchmove', { bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    ).toBe(false);
    await page.screenshot({
      animations: 'disabled',
      path: `/tmp/pico-home-evidence/empty-bottom-${size.width}-${info.project.name}.png`,
    });
    await navigate(page, 'Задачи');
    await expect(page.locator('html')).not.toHaveClass(/pico-home-active/);
    await navigate(page, 'Главная');
    await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    await page
      .locator('.pico-more-menu')
      .getByRole('button', { name: 'Права и помощь', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(
      await page.getByRole('dialog').evaluate((el) => {
        const e = new Event('touchmove', { bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    ).toBe(false);
  });
}

test('Home restores task and meeting lists, actions and bounded scrolling', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as any).swipeCalls = [];
    (window as any).Telegram = {
      WebApp: {
        isVerticalSwipesEnabled: true,
        isVersionAtLeast: () => true,
        disableVerticalSwipes() {
          (window as any).swipeCalls.push('disable');
        },
        enableVerticalSwipes() {
          (window as any).swipeCalls.push('enable');
        },
      },
    };
  });
  const date = today();
  let tasks = [
    { id: 'today', data: { text: 'Сегодняшний звонок', type: 'call', due: date } },
    { id: 'todaymeeting', data: { text: 'Встреча сегодня', type: 'meeting', due: date } },
    { id: 'future', data: { text: 'Будущая встреча', type: 'meeting', due: '2099-01-01' } },
    { id: 'nodate', data: { text: 'Встреча без срока', type: 'meeting', due: null } },
    { id: 'futurecall', data: { text: 'Будущий звонок', type: 'call', due: '2099-01-01' } },
    { id: 'done', data: { text: 'Завершённая задача', type: 'call', due: date, done: true } },
    ...Array.from({ length: 18 }, (_, i) => ({
      id: `old${i}`,
      data: { text: `Просроченная задача ${i}`, type: 'reminder', due: '2020-01-01' },
    })),
  ].map((t) => ({
    ...t,
    version: 1,
    companyId: 'company',
    companyName: 'Компания',
    kind: 'task',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  await page.route('**/api/records/task*', (r) => r.fulfill({ json: tasks }));
  await page.route('**/api/records/today', async (r) => {
    const body = r.request().postDataJSON();
    tasks = tasks.map((t) =>
      t.id === 'today' ? { ...t, data: body.data, version: t.version + 1 } : t,
    );
    await r.fulfill({ json: tasks.find((t) => t.id === 'today') });
  });
  await login(page);
  const todayBlock = page.getByRole('region', { name: 'Сегодня', exact: true });
  const meetingBlock = page.getByRole('region', { name: 'Встречи', exact: true });
  await expect(todayBlock.locator('.pico-task-row')).toHaveCount(1);
  await expect(todayBlock).toContainText('Сегодняшний звонок');
  await expect(meetingBlock.locator('.pico-task-row .task-text strong')).toHaveText([
    'Встреча сегодня',
    'Будущая встреча',
    'Встреча без срока',
  ]);
  await expect(feed(page)).not.toContainText('Будущий звонок');
  await expect(feed(page)).not.toContainText('Завершённая задача');
  await expect(page.getByRole('button', { name: 'Просроченные задачи · 18' })).toHaveCount(1);
  await page.screenshot({
    animations: 'disabled',
    path: `/tmp/pico-home-evidence/populated-${info.project.name}.png`,
  });
  await todayBlock.locator('.task-text').click();
  await expect(todayBlock.getByRole('button', { name: 'Отложить', exact: true })).toBeVisible();
  await todayBlock.getByRole('button', { name: 'Выполнено', exact: true }).click();
  await expect(todayBlock).toContainText('На сегодня задач нет');
  await meetingBlock.locator('.task-text').first().click();
  await expect(page.getByRole('dialog')).toContainText('Встреча сегодня');
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Просроченные задачи · 18' }).click();
  await expect(page.locator('.pico-task-row')).toHaveCount(18);
  expect(await page.evaluate(() => (window as any).swipeCalls)).toEqual([
    'disable',
    'enable',
    'disable',
    'enable',
  ]);
  await navigate(page, 'Главная');
  // A long list uses the home feed without shifting the header or bottom navigation.
  await page.setViewportSize({ width: 320, height: 568 });
  tasks = Array.from({ length: 25 }, (_, i) => ({
    ...tasks[0],
    id: `long${i}`,
    data: {
      text: `Задача с длинным названием для проверки прокрутки ${i}`,
      type: 'call',
      due: date,
    },
  }));
  await page.reload();
  await expect(page.locator('.pico-home-block').first().locator('.pico-task-row')).toHaveCount(25);
  const navBefore = await page.locator('.pico-bottom-nav').boundingBox();
  await feed(page).focus();
  await feed(page).press('End');
  await expect.poll(() => feed(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByText('Встреч не запланировано', { exact: true })).toBeInViewport();
  expect(await page.locator('.pico-bottom-nav').boundingBox()).toEqual(navBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    animations: 'disabled',
    path: `/tmp/pico-home-evidence/long-bottom-${info.project.name}.png`,
  });
});

test('Home fits long names, safe insets, onboarding and overdue together', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  await page.addInitScript(() => {
    (window as any).Telegram = { WebApp: { safeAreaInset: { top: 32, bottom: 20 } } };
  });
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), name: 'Константин-Александр Оченьдлиннаяфамилия' },
    });
  });
  await page.route('**/api/companies*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/records/task*', (route) =>
    route.fulfill({
      json: [
        {
          id: 'overdue',
          companyId: 'company',
          companyName: 'Компания',
          version: 1,
          kind: 'task',
          data: { text: 'Старая задача', due: '2020-01-01', type: 'reminder' },
        },
      ],
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  const footer = (await page.locator('.pico-bottom-nav').boundingBox())!;
  for (const target of await page
    .locator('.pico-home-start, .pico-home-feed > .pico-add-row')
    .all()) {
    await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = (await target.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
    expect(await target.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: info.outputPath('home-long-name-insets.png') });
  await page.getByRole('button', { name: /С чего начать/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.evaluate((el) => {
    el.scrollTop = 10000;
  });
  expect(await dialog.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await dialog.getByRole('button', { name: /Поставить задачу/ }).click();
  await expect(page.getByRole('dialog', { name: 'Новая задача', exact: true })).toBeVisible();
});
