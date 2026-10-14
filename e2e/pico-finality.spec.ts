import { test, expect } from '@playwright/test';
import { prepareDemoAuth, navigate } from './helpers';

// PDF physical frame: 390x844, 58px system area + 52px native Telegram bar.
// The app therefore receives a 390x734 WebView; we do not draw native chrome twice.
test('final references load real Cyrillic Manrope and retain readable native-frame lists', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 734 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
    r.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  const now = new Date().toISOString();
  const companies = [
    ['ГРАНДМОТОРС', 'Москва', 'Торговля оптовая прочими машинами и оборудованием', 100000000],
    ['ЗОЛОТО СЕЛИГДАРА', 'Алдан', 'Добыча руд и песков драгоценных металлов', null],
    ['Русская медная компания', 'Екатеринбург', 'Металлургия', null],
    ['Стройтрансгаз', 'Москва', 'Строительство', null],
    ['Интер РАО', 'Москва', 'Энергетика', null],
  ].map(([name, city, industry, potential], i) => ({
    id: `reference-${i}`,
    name,
    city,
    industry,
    potential,
    segment: 'end_client',
    stage: 'new',
    divisions: {},
    inn: '',
    notes: '',
    ownerId: 'reference',
    ownerName: 'Алексей',
    archived: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }));
  const month = now.slice(0, 7);
  const record = {
    companyId: 'reference-0',
    companyName: 'Климатика',
    projectId: null,
    authorId: 'reference',
    authorName: 'Алексей',
    assigneeId: null,
    version: 1,
    createdAt: now,
  };
  const projects = [
    {
      ...record,
      id: 'project-reference',
      kind: 'project',
      companyName: 'Федеральная гидрогенерирующая компания — РусГидро',
      data: {
        name: 'Амурская ТЭЦ',
        amount: 4500000,
        stage: 'new',
        city: '',
        objectType: '',
        equipment: [],
        participants: [],
        notes: '',
        due: null,
        purchaseDate: null,
      },
    },
  ];
  let tasks: any[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && path === '/api/companies')
      return route.fulfill({ json: companies });
    if (route.request().method() === 'GET' && /^\/api\/records\//.test(path))
      return route.fulfill({
        json: path.endsWith('/project') ? projects : path.endsWith('/task') ? tasks : [],
      });
    return route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
  const demoToken = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  await page.route('**/api/auth/telegram', (r) => r.fulfill({ json: { token: demoToken } }));
  await page.addInitScript(() => {
    Object.defineProperties(screen, {
      width: { configurable: true, value: 390 },
      height: { configurable: true, value: 844 },
    });
    Object.defineProperties(screen.orientation, {
      type: { configurable: true, value: 'portrait-primary' },
      angle: { configurable: true, value: 0 },
    });
    (window as any).Telegram = {
      WebApp: {
        initData: 'native-frame-test',
        platform: 'ios',
        ready() {},
        expand() {},
        onEvent() {},
        offEvent() {},
        isVersionAtLeast: () => false,
      },
    };
  });
  await page.reload();
  await expect(page.locator('.telegram-native-header')).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('reference-home-empty-native-frame.png'),
  });
  const homeFooter = (await page.locator('.pico-bottom-nav').boundingBox())!;
  const homeEmpty = (await page.locator('.pico-home .pico-empty').last().boundingBox())!;
  expect(homeEmpty.y + homeEmpty.height).toBeLessThanOrEqual(homeFooter.y);
  await page.evaluate(() => document.fonts.ready);
  const font = await page.evaluate(async () => {
    const faces = await document.fonts.load('800 15px Manrope', 'Русская медная компания');
    return faces.map((f) => ({ family: f.family, status: f.status, weight: f.weight }));
  });
  expect(font).toContainEqual({ family: 'Manrope', status: 'loaded', weight: '200 800' });
  const nav = page.locator('.pico-bottom-nav');
  for (const inset of [0, 20, 34, 54]) {
    await page.evaluate(
      (value) => document.documentElement.style.setProperty('--pico-safe-bottom', value + 'px'),
      inset,
    );
    await expect(nav).toHaveCSS('height', `${Math.max(82, 48 + inset)}px`);
    await expect(nav.locator('button > svg').first()).toHaveCSS('width', '24px');
    await expect(nav.locator('button > span').first()).toHaveCSS('font-size', '11px');
    const navBox = (await nav.boundingBox())!;
    for (const button of await nav.locator('button').all()) {
      const buttonBox = (await button.boundingBox())!;
      const labelBox = (await button.locator('span').boundingBox())!;
      expect(buttonBox.height).toBeGreaterThanOrEqual(44);
      expect(buttonBox.width).toBeGreaterThanOrEqual(44);
      expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(navBox.y + navBox.height - inset);
      expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(navBox.y + navBox.height - inset);
    }
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--pico-safe-bottom', '34px'),
  );
  await navigate(page, 'Клиенты');
  await expect(page.locator('.pico-client-row')).toHaveCount(5);
  await expect(page.locator('.pico-client-copy > strong').first()).toHaveCSS('font-size', '15px');
  await expect(page.locator('.pico-client-copy > strong').first()).toHaveCSS('line-height', '20px');
  await expect(page.locator('.company-money').first()).toHaveCSS('width', '72px');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const doc = await cdp.send('DOM.getDocument');
  const node = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '.pico-client-copy > strong',
  });
  const renderedFonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
  expect(renderedFonts.fonts).toEqual([
    expect.objectContaining({
      postScriptName: 'Manrope-ExtraBold',
      isCustomFont: true,
      glyphCount: 11,
    }),
  ]);
  for (const [selector, expectedFace] of [
    ['.pico-client-metadata > span', 'Manrope-Medium'],
    ['.company-money > small', 'Manrope-Regular'],
  ]) {
    const textNode = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    const actual = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: textNode.nodeId });
    expect(actual.fonts).toEqual([
      expect.objectContaining({ postScriptName: expectedFace, isCustomFont: true }),
    ]);
  }
  await cdp.detach();
  const last = (await page.locator('.pico-client-accordion').last().boundingBox())!;
  const footer = (await nav.boundingBox())!;
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('reference-clients-native-frame.png'),
  });
  expect(
    last.y + last.height,
    'five original reference companies fit above navigation in the native WebView',
  ).toBeLessThanOrEqual(footer.y);
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('reference-clients-native-frame.png'),
  });
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 734 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`reference-clients-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 390, height: 734 });
  await navigate(page, 'Проекты');
  const projectIcon = page.locator('.pico-project-row > summary .icon-badge');
  await expect(projectIcon).toHaveCSS('color', 'rgb(245, 168, 28)');
  await expect(projectIcon).toHaveCSS('background-color', 'rgb(255, 243, 219)');
  await expect(projectIcon.locator('svg')).toHaveCSS('stroke', 'rgb(245, 168, 28)');
  await expect(page.locator('.pico-project-row > summary strong')).toHaveCSS('font-size', '15px');
  await expect(page.locator('.pico-project-row > summary small').first()).toHaveCSS(
    '-webkit-line-clamp',
    '2',
  );
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('reference-project-native-frame.png'),
  });
  tasks = [1, 2, 3, 4].flatMap((count) =>
    Array.from({ length: count }, (_, i) => ({
      ...record,
      id: `task-${count}-${i}`,
      kind: 'task',
      data: {
        text:
          i === 0
            ? 'Получить от клиента выгрузку потребности в оборудовании'
            : 'Напомнить проконтролировать оплату счёта',
        type: 'reminder',
        due: `${month}-${String(count + 1).padStart(2, '0')}`,
        done: false,
        time: null,
        contactId: null,
      },
    })),
  );
  await page.reload();
  await navigate(page, 'Задачи');
  for (const count of [1, 2, 3, 4]) {
    const day = `${month}-${String(count + 1).padStart(2, '0')}`;
    await expect(
      page
        .getByRole('button', { name: `${day}, открытых задач: ${count}`, exact: true })
        .locator('.pico-calendar-dots i'),
    ).toHaveCount(Math.min(count, 3));
  }
  await page.getByRole('button', { name: `${month}-03, открытых задач: 2`, exact: true }).click();
  await expect(page.locator('.pico-task-row')).toHaveCount(2);
  await expect(page.locator('.pico-task-row .task-text strong').first()).toHaveCSS(
    'font-size',
    '15px',
  );
  await expect(page.locator('.pico-task-row .task-text strong').first()).toHaveCSS(
    'line-height',
    '20px',
  );
  await expect(page.locator('.pico-task-row .checkbox').first()).toHaveCSS('width', '40px');
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('reference-tasks-populated-native-frame.png'),
  });
  await page.getByRole('button', { name: `${month}-15`, exact: true }).click();
  await expect(page.getByText('Этот день пока свободен', { exact: true })).toBeVisible();
  await expect(page.locator('.pico-task-empty .pico-empty-icon')).toHaveCSS('width', '52px');
  await expect(page.locator('.pico-task-empty h3')).toHaveCSS('font-size', '16px');
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('reference-tasks-empty-native-frame.png'),
  });
  await navigate(page, 'Главная');
  await expect(page.getByRole('button', { name: /Просроченные задачи/ })).toBeVisible();
  await page.getByRole('button', { name: /Просроченные задачи/ }).click();
  await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
  await expect(page.locator('.pico-task-row')).toHaveCount(10);
});
