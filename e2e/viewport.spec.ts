import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { expect, Page, test } from '@playwright/test';
import { prepareDemoAuth } from './helpers';

// Execute the actual import-free production module in an isolated browser page.
// Only this test page exposes its initializer; production has no test hook or CSP change.
const moduleSource =
  ts.transpileModule(readFileSync(resolve('src/web/viewport.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText + '\nwindow.__configureViewport = configureViewport;';

async function isolatedModule(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('about:blank');
  await page.setContent(
    '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="horizontal" style="width:300px;overflow:auto"><div style="width:2000px;height:200px">Local horizontal fixture</div></div><div style="height:3000px">Local vertical fixture</div>',
  );
  await page.addScriptTag({ type: 'module', content: moduleSource });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__configureViewport))
    .toBe('function');
}
async function configureSdk(
  page: Page,
  mode = 'modern',
  options: { platform?: string; locked?: boolean; failLock?: boolean; version?: string } = {},
) {
  await page.evaluate(
    ({ mode, options }) => {
      const calls = {
        ready: 0,
        expand: 0,
        fullscreen: 0,
        on: [] as string[],
        off: [] as string[],
        lock: 0,
        unlock: 0,
        header: [] as string[],
      };
      const events = new Map<string, Set<() => void>>();
      const sdk: any = {
        ready() {
          calls.ready++;
        },
        expand() {
          calls.expand++;
        },
        requestFullscreen() {
          calls.fullscreen++;
          if (mode === 'throw') throw new Error('Local unsupported native capability');
        },
        isVersionAtLeast: (version: string) =>
          options.version ? Number(version) <= Number(options.version) : mode !== 'old',
        isFullscreen: mode === 'already',
        platform: options.platform,
        isOrientationLocked: options.locked || false,
        lockOrientation() {
          calls.lock++;
          if (options.failLock) throw new Error('Local native orientation unsupported');
          sdk.isOrientationLocked = true;
        },
        unlockOrientation() {
          calls.unlock++;
          sdk.isOrientationLocked = false;
        },
        setHeaderColor(color: string) {
          calls.header.push(color);
        },
        viewportStableHeight: 720,
        safeAreaInset: { top: 20, bottom: 24, left: 4, right: 6 },
        contentSafeAreaInset: { top: 32, bottom: 10, left: 2, right: 3 },
        onEvent(name: string, callback: () => void) {
          calls.on.push(name);
          if (!events.has(name)) events.set(name, new Set());
          events.get(name)!.add(callback);
        },
        offEvent(name: string, callback: () => void) {
          calls.off.push(name);
          events.get(name)?.delete(callback);
        },
      };
      if (mode === 'missing') delete sdk.requestFullscreen;
      (window as any).__sdk = {
        sdk,
        calls,
        events,
        emit(name: string) {
          for (const callback of events.get(name) || []) callback();
        },
      };
      (window as any).__cleanupViewport = (window as any).__configureViewport(sdk);
    },
    { mode, options },
  );
}

async function installOrientation(page: Page, type: string, behavior = 'reject') {
  await page.evaluate(
    ({ type, behavior }) => {
      const orientation = new EventTarget() as any;
      const state: any = { orientation, locks: [] as string[], unlocks: 0 };
      orientation.type = type;
      orientation.lock = (mode: string) => {
        state.locks.push(mode);
        if (behavior === 'pending')
          return new Promise<void>((resolve) => (state.resolve = resolve));
        if (behavior === 'resolve') return Promise.resolve();
        return Promise.reject(new Error('Local browser orientation unsupported'));
      };
      orientation.unlock = () => state.unlocks++;
      Object.defineProperty(window.screen, 'orientation', {
        configurable: true,
        value: orientation,
      });
      (window as any).__orientation = state;
    },
    { type, behavior },
  );
}

test('Viewport: modern fullscreen, old/missing capability fallback, failure and already-fullscreen are bounded', async ({
  page,
}) => {
  await isolatedModule(page);
  for (const [mode, fullscreen, expand] of [
    ['modern', 1, 1],
    ['old', 0, 1],
    ['missing', 0, 1],
    ['throw', 1, 2],
    ['already', 0, 1],
  ] as const) {
    await configureSdk(page, mode);
    const calls = await page.evaluate(() => (window as any).__sdk.calls);
    expect(calls).toMatchObject({ ready: 1, fullscreen, expand });
    expect(calls.on.sort()).toEqual([
      'contentSafeAreaChanged',
      'fullscreenChanged',
      'fullscreenFailed',
      'safeAreaChanged',
      'viewportChanged',
    ]);
    await page.evaluate(() => (window as any).__cleanupViewport());
  }
  await configureSdk(page);
  await page.evaluate(() => (window as any).__sdk.emit('fullscreenFailed'));
  expect(await page.evaluate(() => (window as any).__sdk.calls)).toMatchObject({
    fullscreen: 1,
    expand: 2,
  });
  await page.evaluate(() => {
    (window as any).__sdk.sdk.isFullscreen = true;
    (window as any).__sdk.emit('fullscreenChanged');
  });
  expect(await page.evaluate(() => (window as any).__sdk.calls.fullscreen)).toBe(1);
});

test('Viewport: stable SDK height, safe-area events, keyboard viewport and orientation update real CSS variables', async ({
  page,
}) => {
  await isolatedModule(page);
  await page.evaluate(() => {
    const visual = new EventTarget() as any;
    Object.assign(visual, { height: 800, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
    (window as any).__visual = visual;
  });
  await configureSdk(page);
  const css = () =>
    page.evaluate(() => {
      const style = document.documentElement.style;
      return Object.fromEntries(
        [
          'height',
          'top',
          'bottom-offset',
          'safe-top',
          'safe-bottom',
          'safe-left',
          'safe-right',
        ].map((key) => {
          const name = key === 'height' || key === 'top' ? '--pico-view-' + key : '--pico-' + key;
          return [key, style.getPropertyValue(name)];
        }),
      );
    });
  expect(await css()).toMatchObject({ height: '720px', top: '0px', 'bottom-offset': '124px' });
  expect((await css())['safe-top']).toContain('20px) + 32px');
  await page.evaluate(() => {
    const state = (window as any).__sdk;
    state.sdk.viewportHeight = 300; // An unstable native gesture must not move bottom controls.
    state.emit('viewportChanged');
  });
  expect((await css()).height).toBe('720px');
  await page.evaluate(() => {
    const state = (window as any).__sdk;
    state.sdk.safeAreaInset = { top: -10, bottom: NaN, left: Infinity, right: 12 };
    state.sdk.contentSafeAreaInset = { top: 40, bottom: 8, left: 5, right: 7 };
    state.emit('safeAreaChanged');
    state.emit('contentSafeAreaChanged');
    Object.assign((window as any).__visual, { height: 360, offsetTop: 70 });
    (window as any).__visual.dispatchEvent(new Event('resize'));
  });
  expect(await css()).toMatchObject({ height: '360px', top: '70px', 'bottom-offset': '414px' });
  expect((await css())['safe-left']).toContain('0px) + 5px');
  expect((await css())['safe-right']).toContain('12px) + 7px');
  await page.evaluate(() => {
    (window as any).__sdk.sdk.viewportStableHeight = 390;
    Object.assign((window as any).__visual, { height: 390, offsetTop: 0 });
    window.dispatchEvent(new Event('orientationchange'));
  });
  expect((await css()).height).toBe('390px');
  await page.evaluate(() => {
    (window as any).__visual.offsetTop = 10;
    (window as any).__visual.dispatchEvent(new Event('scroll'));
  });
  expect((await css()).top).toBe('10px');
});

test('Viewport: cleanup removes SDK and DOM listeners and restores prior CSS values and priorities', async ({
  page,
}) => {
  await isolatedModule(page);
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--pico-view-height', '333px', 'important'),
  );
  await configureSdk(page);
  await page.evaluate(() => {
    const queued = [...(window as any).__sdk.events.values()].flatMap((callbacks: any) => [
      ...callbacks,
    ]);
    (window as any).__cleanupViewport();
    for (const callback of queued) callback();
    window.visualViewport?.dispatchEvent(new Event('resize'));
    window.visualViewport?.dispatchEvent(new Event('scroll'));
  });
  const state = await page.evaluate(() => {
    const style = document.documentElement.style;
    const sdk = (window as any).__sdk;
    sdk.sdk.viewportStableHeight = 100;
    sdk.emit('viewportChanged');
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('orientationchange'));
    const pinch = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(pinch, 'touches', { value: [{}, {}] });
    document.dispatchEvent(pinch);
    return {
      on: sdk.calls.on,
      off: sdk.calls.off,
      active: [...sdk.events.values()].reduce(
        (n: number, callbacks: Set<unknown>) => n + callbacks.size,
        0,
      ),
      height: style.getPropertyValue('--pico-view-height'),
      priority: style.getPropertyPriority('--pico-view-height'),
      top: style.getPropertyValue('--pico-view-top'),
      pinchCancelled: pinch.defaultPrevented,
      expand: sdk.calls.expand,
    };
  });
  expect(state.off.sort()).toEqual(state.on.sort());
  expect(state).toMatchObject({
    active: 0,
    height: '333px',
    priority: 'important',
    top: '',
    pinchCancelled: false,
    expand: 1,
  });
});

test('Viewport: only pinch gestures are cancelled; normal wheel and one-touch events remain usable', async ({
  page,
}) => {
  await isolatedModule(page);
  await page.evaluate(
    () => ((window as any).__cleanupViewport = (window as any).__configureViewport()),
  );
  const gestures = await page.evaluate(() => {
    const touch = (count: number, cancelable = true) => {
      const event = new Event('touchmove', { bubbles: true, cancelable });
      Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({})) });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const wheel = (ctrlKey: boolean) => {
      const event = new WheelEvent('wheel', { ctrlKey, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const gesture = new Event('gesturestart', { bubbles: true, cancelable: true });
    document.dispatchEvent(gesture);
    return {
      one: touch(1),
      two: touch(2),
      uncancelable: touch(2, false),
      normalWheel: wheel(false),
      wheelPinch: wheel(true),
      gesture: gesture.defaultPrevented,
    };
  });
  expect(gestures).toEqual({
    one: false,
    two: true,
    uncancelable: false,
    normalWheel: false,
    wheelPinch: true,
    gesture: true,
  });
  await page.mouse.move(100, 100);
  await page.mouse.wheel(400, 0);
  await expect
    .poll(() => page.locator('#horizontal').evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.mouse.move(350, 350);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
});

test('Viewport: normal browser bootstrap retains authenticated navigation and non-zoom metadata', async ({
  page,
}) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/');
  const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
  expect(viewport).toContain('maximum-scale=1');
  expect(viewport).toContain('user-scalable=no');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe(
    'pan-x pan-y',
  );
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('Viewport: SDK failures do not interrupt the existing Telegram authentication request', async ({
  page,
}) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const response = await page.request.get('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBeTruthy();
  const user = await response.json();
  let authCalls = 0;
  await page.route('**/api/auth/telegram', (route) => {
    authCalls++;
    expect(route.request().postDataJSON()).toEqual({ initData: 'local-native-sdk-test' });
    return route.fulfill({ json: { token, user } });
  });
  await page.addInitScript(() => {
    const calls = { ready: 0, expand: 0, fullscreen: 0 };
    (window as any).__nativeCalls = calls;
    (window as any).Telegram = {
      WebApp: {
        initData: 'local-native-sdk-test',
        ready() {
          calls.ready++;
          throw new Error('Local SDK ready failure');
        },
        expand() {
          calls.expand++;
        },
        requestFullscreen() {
          calls.fullscreen++;
          throw new Error('Local native fullscreen unsupported');
        },
        isVersionAtLeast: () => true,
        viewportStableHeight: 700,
        onEvent() {},
        offEvent() {},
      },
    };
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => sessionStorage.removeItem('crm-session'));
  await page.reload();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  expect(authCalls).toBe(1);
  expect(await page.evaluate(() => (window as any).__nativeCalls)).toEqual({
    ready: 1,
    expand: 2,
    fullscreen: 1,
  });
  expect(errors).toEqual([]);
});

test('Viewport: mobile native portrait lock is owned and bounded, while an existing portrait lock is preserved', async ({
  page,
}) => {
  await isolatedModule(page);
  await installOrientation(page, 'portrait-primary');
  await configureSdk(page, 'modern', { platform: 'ios' });
  expect(await page.evaluate(() => (window as any).__sdk.calls.lock)).toBe(1);
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('resize'));
  });
  expect(await page.evaluate(() => (window as any).__sdk.calls.lock)).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-pico-portrait-required', 'false');
  await page.evaluate(() => (window as any).__cleanupViewport());
  expect(await page.evaluate(() => (window as any).__sdk.calls.unlock)).toBe(1);
  await expect(page.locator('html')).not.toHaveAttribute('data-pico-portrait-required');
  await configureSdk(page, 'modern', { platform: 'ios', locked: true });
  await page.evaluate(() => (window as any).__cleanupViewport());
  expect(await page.evaluate(() => (window as any).__sdk.calls)).toMatchObject({
    lock: 0,
    unlock: 0,
  });
  await configureSdk(page, 'modern', { platform: 'android', failLock: true });
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('resize'));
      (window as any).__sdk.emit('safeAreaChanged');
    }
  });
  expect(await page.evaluate(() => (window as any).__sdk.calls.lock)).toBe(1);
  await page.evaluate(() => (window as any).__cleanupViewport());
  expect(await page.evaluate(() => (window as any).__sdk.calls.unlock)).toBe(0);
});

test('Viewport: prelocked native landscape is released once and portrait transition acquires only the new lease', async ({
  page,
}) => {
  await isolatedModule(page);
  await installOrientation(page, 'landscape-primary');
  await configureSdk(page, 'modern', { platform: 'android', locked: true });
  await expect(page.locator('html')).toHaveAttribute('data-pico-portrait-required', 'true');
  expect(await page.evaluate(() => (window as any).__sdk.calls)).toMatchObject({
    lock: 0,
    unlock: 1,
  });
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('resize'));
  });
  expect(await page.evaluate(() => (window as any).__sdk.calls.unlock)).toBe(1);
  await page.evaluate(() => {
    (window as any).__orientation.orientation.type = 'portrait-primary';
    (window as any).__orientation.orientation.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-pico-portrait-required', 'false');
  expect(await page.evaluate(() => (window as any).__sdk.calls)).toMatchObject({
    lock: 1,
    unlock: 1,
  });
  await page.evaluate(() => {
    const visual = window.visualViewport as any;
    Object.defineProperty(visual, 'height', { configurable: true, value: 200 });
    visual.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-pico-portrait-required', 'false');
  await page.evaluate(() => (window as any).__cleanupViewport());
  expect(await page.evaluate(() => (window as any).__sdk.calls.unlock)).toBe(2);
});

test('Viewport: browser portrait promise cleanup, rejected lock and old header-color compatibility are safe', async ({
  page,
}) => {
  await isolatedModule(page);
  await installOrientation(page, 'portrait-primary', 'pending');
  await configureSdk(page, 'modern', { platform: 'ios' });
  expect(await page.evaluate(() => (window as any).__orientation.locks)).toEqual(['portrait']);
  await page.evaluate(() => {
    (window as any).__cleanupViewport();
    (window as any).__orientation.resolve();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__orientation.unlocks)).toBe(1);
  await expect(page.locator('html')).not.toHaveAttribute('data-pico-portrait-required');
  await installOrientation(page, 'landscape-primary', 'reject');
  await configureSdk(page, 'modern', { platform: 'ios', version: '6.1' });
  await expect(page.locator('html')).toHaveAttribute('data-pico-portrait-required', 'true');
  expect(await page.evaluate(() => (window as any).__sdk.calls)).toMatchObject({
    lock: 0,
    header: ['bg_color'],
    fullscreen: 0,
  });
  await page.evaluate(() => (window as any).__cleanupViewport());
  await installOrientation(page, 'portrait-primary', 'resolve');
  await configureSdk(page, 'modern', { platform: 'android', version: '6.9' });
  await expect.poll(() => page.evaluate(() => (window as any).__orientation.locks.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__sdk.calls)).toMatchObject({
    lock: 0,
    header: ['#f5f7ff'],
    fullscreen: 0,
  });
  await page.evaluate(() => (window as any).__cleanupViewport());
  expect(await page.evaluate(() => (window as any).__orientation.unlocks)).toBe(1);
});
