import { expect, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`Home stays fixed and navigation remains usable at ${size.width}`, async ({
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
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Администратор', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/pico-home-active/);
    const cards = page.locator('.pico-home-snapshot');
    await expect(cards).toHaveCount(2);
    const bottom =
      size.width <= 760 ? (await page.locator('.pico-bottom-nav').boundingBox())!.y : size.height;
    for (const card of await cards.all()) {
      const box = (await card.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(bottom);
      expect(box.height).toBeGreaterThanOrEqual(64);
    }
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.wheel(0, 1200);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await cards.first().evaluate((el) => {
        const event = new Event('touchmove', { bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`static-home-${size.width}.png`) });
    await cards.first().click();
    await expect(page.locator('html')).not.toHaveClass(/pico-home-active/);
    await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
    await navigate(page, 'Главная');
    await cards.nth(1).click();
    await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
    await navigate(page, 'Главная');
    await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    await page
      .locator('.pico-more-menu')
      .getByRole('button', { name: 'Права и помощь', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(
      await dialog.evaluate((el) => {
        const event = new Event('touchmove', { bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(false);
  });
}

test('Home counters open matching task selections and restore native swipes', async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
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
  const day = new Date();
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const tasks = [
    { id: 'today', data: { text: 'Сегодняшний звонок', type: 'call', due: date } },
    { id: 'future', data: { text: 'Будущая встреча', type: 'meeting', due: '2099-01-01' } },
    ...Array.from({ length: 40 }, (_, i) => ({
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
  await page.route('**/api/records/task*', (route) => route.fulfill({ json: tasks }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.pico-home-snapshot').first()).toContainText('Задач на сегодня: 1');
  await expect(page.locator('.pico-home-snapshot').nth(1)).toContainText('Запланировано: 1');
  expect(await page.evaluate(() => (window as any).swipeCalls)).toEqual(['disable']);
  await page.getByRole('button', { name: /Просроченные задачи/ }).click();
  await expect(page.locator('.pico-task-row')).toHaveCount(40);
  await navigate(page, 'Главная');
  await page.locator('.pico-home-snapshot').first().click();
  await expect(page.locator('.pico-task-row')).toHaveCount(1);
  await expect(page.locator('.pico-task-row')).toContainText('Сегодняшний звонок');
  await navigate(page, 'Главная');
  await page.locator('.pico-home-snapshot').nth(1).click();
  await expect(page.locator('.pico-task-row')).toHaveCount(1);
  await expect(page.locator('.pico-task-row')).toContainText('Будущая встреча');
  expect(await page.evaluate(() => (window as any).swipeCalls)).toEqual([
    'disable',
    'enable',
    'disable',
    'enable',
    'disable',
    'enable',
  ]);
  await page.mouse.move(200, 400);
  await page.mouse.wheel(0, 1200);
  // Full lists are deliberately free to scroll after leaving the static overview.
  await navigate(page, 'Главная');
  await page.getByRole('button', { name: /Просроченные задачи/ }).click();
  await page.mouse.wheel(0, 1200);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
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
  for (const target of await page.locator('.pico-static-home > button').all()) {
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
