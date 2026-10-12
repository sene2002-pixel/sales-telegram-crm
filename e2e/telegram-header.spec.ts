import { test, expect, Page } from '@playwright/test';
import { prepareDemoAuth } from './helpers';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
});

async function physicalPortrait(page: Page) {
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

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(name + '.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width + 1,
  );
}

async function accessibleMenu(page: Page) {
  const trigger = page.getByRole('button', { name: 'Дополнительное меню', exact: true });
  await trigger.click();
  await expect(
    page.locator('.pico-more-menu').getByRole('button', { name: 'Мой профиль', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pico-more-menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .locator('.pico-more-menu')
    .getByRole('button', { name: 'Мой профиль', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Мой профиль', exact: true })).toBeVisible();
}

test('Telegram header: authenticated mobile keeps native chrome, exits fullscreen and preserves menu', async ({
  page,
}, info) => {
  const width = info.project.name === 'mobile' ? 390 : 360;
  await page.setViewportSize({ width, height: 844 });
  await physicalPortrait(page);
  await page.addInitScript(() => {
    const callbacks = new Map<string, Set<() => void>>();
    const calls = { ready: 0, expand: 0, requestFullscreen: 0, exitFullscreen: 0 };
    (window as any).telegramHeaderCalls = calls;
    (window as any).Telegram = {
      WebApp: {
        initData: 'synthetic-local-header-auth',
        platform: 'android',
        version: '8.0',
        viewportStableHeight: 844,
        isFullscreen: true,
        safeAreaInset: { top: 24, bottom: 20, left: 0, right: 0 },
        contentSafeAreaInset: { top: 48, bottom: 0, left: 0, right: 0 },
        ready() {
          calls.ready++;
        },
        expand() {
          calls.expand++;
        },
        requestFullscreen() {
          calls.requestFullscreen++;
        },
        exitFullscreen() {
          calls.exitFullscreen++;
          this.isFullscreen = false;
          queueMicrotask(() => callbacks.get('fullscreenChanged')?.forEach((fn) => fn()));
        },
        isVersionAtLeast() {
          return true;
        },
        onEvent(name: string, fn: () => void) {
          if (!callbacks.has(name)) callbacks.set(name, new Set());
          callbacks.get(name)!.add(fn);
        },
        offEvent(name: string, fn: () => void) {
          callbacks.get(name)?.delete(fn);
        },
        BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
      },
    };
  });
  await page.route('**/api/auth/telegram', async (route) => {
    expect(route.request().postDataJSON().initData).toBe('synthetic-local-header-auth');
    const response = await page.request.post('/api/auth/dev', { data: { role: 'admin' } });
    expect(response.ok()).toBeTruthy();
    await route.fulfill({ response });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveClass(/telegram-native-header/);
  await expect(page.locator('.mobile-brand')).toBeHidden();
  expect(await page.evaluate(() => (window as any).telegramHeaderCalls)).toMatchObject({
    requestFullscreen: 0,
    exitFullscreen: 1,
  });
  expect((await page.evaluate(() => (window as any).telegramHeaderCalls)).expand).toBeGreaterThan(
    0,
  );
  const menu = (await page
    .getByRole('button', { name: 'Дополнительное меню', exact: true })
    .boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(72);
  expect(menu.x + menu.width).toBeLessThanOrEqual(width);
  await screenshot(page, 'native-header-' + width);
  await accessibleMenu(page);
});

test('Telegram header: ordinary browser title centers without overlapping menu at 360 and 390', async ({
  page,
}) => {
  await physicalPortrait(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const brand = page.locator('.mobile-brand');
    await expect(brand).toBeVisible();
    await expect(brand).toHaveText('Pico Bot');
    await expect(brand.locator('.brand-mark')).toBeHidden();
    expect(
      await brand
        .locator('.brand-mark')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    ).toBeTruthy();
    const title = (await brand.boundingBox())!,
      menu = (await page
        .getByRole('button', { name: 'Дополнительное меню', exact: true })
        .boundingBox())!;
    expect(Math.abs(title.x + title.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(title.x + title.width).toBeLessThanOrEqual(menu.x);
    await screenshot(page, 'browser-centered-header-' + width);
  }
  await accessibleMenu(page);
});

test('Telegram header: wide portrait tablet browser retains sidebar brand and navigation', async ({
  page,
}) => {
  await physicalPortrait(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell > aside')).toBeVisible();
  const avatar = page.locator('.app-shell > aside .brand-mark');
  await expect(avatar).toBeVisible();
  expect(
    await avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
  ).toBeTruthy();
  await page
    .locator('.pico-secondary-nav')
    .getByRole('button', { name: 'Мой профиль', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Мой профиль', exact: true })).toBeVisible();
  await screenshot(page, 'browser-wide-header');
});
