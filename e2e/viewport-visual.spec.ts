import { expect, Page, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
});

async function telegramViewport(page: Page, height: number, landscape = false) {
  await page.addInitScript(
    ({ height, landscape }) => {
      const callbacks = new Map<string, Set<(...args: any[]) => void>>();
      const orientation = new EventTarget() as any;
      Object.assign(orientation, {
        type: landscape ? 'landscape-primary' : 'portrait-primary',
        angle: landscape ? 90 : 0,
        async lock() {
          throw new Error('Synthetic native orientation lock unavailable');
        },
        unlock() {},
      });
      Object.defineProperty(screen, 'orientation', { value: orientation, configurable: true });
      Object.defineProperty(window, 'orientation', {
        value: orientation.angle,
        configurable: true,
        writable: true,
      });
      const tg: any = {
        initData: '',
        version: '8.0',
        platform: 'android',
        viewportHeight: height,
        viewportStableHeight: height,
        isExpanded: true,
        isFullscreen: false,
        safeAreaInset: landscape
          ? { top: 12, bottom: 21, left: 44, right: 44 }
          : { top: 24, bottom: 20, left: 0, right: 0 },
        contentSafeAreaInset: landscape
          ? { top: 48, bottom: 0, left: 0, right: 0 }
          : { top: 48, bottom: 0, left: 0, right: 0 },
        ready() {},
        expand() {},
        disableVerticalSwipes() {},
        enableVerticalSwipes() {},
        isVersionAtLeast() {
          return true;
        },
        requestFullscreen() {
          this.isFullscreen = true;
          queueMicrotask(() => callbacks.get('fullscreenChanged')?.forEach((fn) => fn()));
        },
        onEvent(name: string, fn: (...args: any[]) => void) {
          if (!callbacks.has(name)) callbacks.set(name, new Set());
          callbacks.get(name)!.add(fn);
        },
        offEvent(name: string, fn: (...args: any[]) => void) {
          callbacks.get(name)?.delete(fn);
        },
        BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
      };
      (window as any).Telegram = { WebApp: tg };
      (window as any).viewportVisualMock = {
        emit(name: string) {
          callbacks.get(name)?.forEach((fn) => fn({ isStateStable: true }));
        },
        setHeight(value: number) {
          tg.viewportHeight = value;
          callbacks.get('viewportChanged')?.forEach((fn) => fn({ isStateStable: false }));
        },
        rotatePortrait() {
          orientation.type = 'portrait-primary';
          orientation.angle = 0;
          (window as any).orientation = 0;
          tg.viewportHeight = 844;
          tg.viewportStableHeight = 844;
          tg.safeAreaInset = { top: 24, bottom: 20, left: 0, right: 0 };
          orientation.dispatchEvent(new Event('change'));
          window.dispatchEvent(new Event('orientationchange'));
          callbacks.get('safeAreaChanged')?.forEach((fn) => fn());
        },
        rotateLandscape() {
          orientation.type = 'landscape-primary';
          orientation.angle = 90;
          (window as any).orientation = 90;
          tg.viewportHeight = 390;
          tg.viewportStableHeight = 390;
          tg.safeAreaInset = { top: 12, bottom: 21, left: 44, right: 44 };
          orientation.dispatchEvent(new Event('change'));
          window.dispatchEvent(new Event('orientationchange'));
          callbacks.get('safeAreaChanged')?.forEach((fn) => fn());
        },
      };
    },
    { height, landscape },
  );
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(name + '.png'), animations: 'disabled' });
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    rootWidth: document.documentElement.scrollWidth,
    visualHeight: visualViewport?.height,
    scrollY,
    dialogs: [...document.querySelectorAll('[role=dialog]')].map((el) => ({
      box: el.getBoundingClientRect().toJSON(),
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    })),
    nav: [...document.querySelectorAll('nav')]
      .filter((el) => el.getClientRects().length)
      .map((el) => el.getBoundingClientRect().toJSON()),
  }));
  await test.info().attach(name + '-geometry', {
    contentType: 'application/json',
    body: JSON.stringify(geometry),
  });
  expect(geometry.rootWidth).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

async function footer(page: Page, width: number, top: number, bottom: number, height: number) {
  const nav = page.getByRole('navigation', { name: 'Основная навигация', exact: true });
  await expect(nav).toBeVisible();
  for (const label of ['Главная', 'Клиенты', 'Проекты', 'Задачи', 'Аналитика']) {
    const button = nav.getByRole('button', { name: label, exact: true });
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect(box.y).toBeGreaterThanOrEqual(top - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(height - bottom + 1);
  }
}

async function reachableTask(page: Page, name: string, safeTop = 0, safeBottom = 0) {
  await navigate(page, 'Задачи');
  await page.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await dialog.getByLabel('Задача', { exact: true }).fill('Проверить доступность формы');
  for (const label of ['Срок', 'Время']) {
    const input = dialog.getByLabel(label, { exact: true });
    await input.click({ timeout: 3000 });
    await expect(input).toBeFocused();
  }
  const save = dialog.getByRole('button', { name: 'Добавить задачу', exact: true });
  await save.scrollIntoViewIfNeeded();
  const box = (await save.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(safeTop - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height - safeBottom + 1);
  await capture(page, name);
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test('Viewport visual: Telegram portrait safe content protects header/footer and shortened modal remains reachable', async ({
  page,
}, info) => {
  const width = info.project.name === 'mobile' ? 390 : 360,
    height = 844;
  await page.setViewportSize({ width, height });
  await telegramViewport(page, height);
  await login(page);
  await capture(page, 'telegram-portrait-' + width);
  await footer(page, width, 72, 20, height);
  const brand = (await page.locator('.workspace .brand-mark:visible').first().boundingBox())!;
  expect(brand.y).toBeGreaterThanOrEqual(71);
  await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
  await capture(page, 'telegram-menu-' + width);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width, height: 360 });
  await page.evaluate(() => (window as any).viewportVisualMock.setHeight(360));
  await footer(page, width, 72, 20, 360);
  await reachableTask(page, 'telegram-short-form-' + width, 72, 20);
});

test('Viewport visual: Telegram landscape requests portrait and restores the app after rotation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await telegramViewport(page, 390, true);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-pico-portrait-required', 'true');
  await expect(page.locator('#pico-app')).toBeHidden();
  await expect(page.locator('.pico-portrait-guard')).toBeVisible();
  await expect(page.locator('.pico-portrait-guard')).toContainText(
    'Поверните устройство вертикально',
  );
  await capture(page, 'telegram-landscape-portrait-guard');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).viewportVisualMock.rotatePortrait());
  await expect(page.locator('html')).not.toHaveAttribute('data-pico-portrait-required', 'true');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, 'telegram-rotated-portrait');
  await reachableTask(page, 'telegram-rotated-portrait-form', 72, 20);
  await page.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await dialog.getByLabel('Задача', { exact: true }).fill('Текст сохраняется при повороте');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => (window as any).viewportVisualMock.rotateLandscape());
  await expect(page.locator('.pico-portrait-guard')).toBeVisible();
  await expect(dialog).toBeHidden();
  await capture(page, 'telegram-open-form-landscape-guard');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).viewportVisualMock.rotatePortrait());
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Задача', { exact: true })).toHaveValue(
    'Текст сохраняется при повороте',
  );
  await capture(page, 'telegram-restored-open-form');
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
});

test('Viewport visual: ordinary browser fallback fits narrow and desktop navigation and dialogs', async ({
  page,
}, info) => {
  const width = info.project.name === 'mobile' ? 390 : 1440;
  if (info.project.name === 'mobile') {
    await page.addInitScript(() => {
      // A keyboard changes the visible viewport without rotating the physical screen.
      if (screen.orientation) {
        Object.defineProperty(screen.orientation, 'type', {
          get: () => 'portrait-primary',
          configurable: true,
        });
        Object.defineProperty(screen.orientation, 'angle', { get: () => 0, configurable: true });
      }
      Object.defineProperty(window, 'orientation', { get: () => 0, configurable: true });
    });
  }
  await page.setViewportSize({ width, height: 900 });
  await login(page);
  await capture(page, 'browser-fallback-' + width);
  await reachableTask(page, 'browser-fallback-form-' + width);
  await page.setViewportSize({ width: 390, height: 360 });
  await footer(page, 390, 0, 0, 360);
  await reachableTask(page, 'browser-short-form');
});
