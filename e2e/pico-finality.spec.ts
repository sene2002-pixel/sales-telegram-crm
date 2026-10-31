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
  // Keep every fixture task overdue even on the first day of a month.
  const localDate = new Date();
  localDate.setDate(1);
  localDate.setMonth(localDate.getMonth() - 1);
  const month = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}`;
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
  await page
    .locator('.pico-home-empty')
    .last()
    .evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }));
  const homeEmpty = (await page.locator('.pico-home-empty').last().boundingBox())!;
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
    await expect(nav).toHaveCSS('height', `${Math.max(72, 59 + inset)}px`);
    await expect(nav.locator('button > svg').first()).toHaveCSS('width', '26px');
    await expect(nav.locator('button > span').first()).toHaveCSS('font-size', '10.5px');
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
    document.documentElement.style.setProperty('--pico-safe-bottom', '0px'),
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
      familyName: expect.stringMatching(/^Manrope(?: |$)/),
      postScriptName: expect.stringMatching(/^Manrope-/),
      isCustomFont: true,
      glyphCount: 11,
    }),
  ]);
  await expect(page.locator('.pico-client-copy > strong').first()).toHaveCSS('font-weight', '800');
  for (const [selector, weight] of [
    ['.pico-client-metadata > span', '500'],
    ['.company-money > small', '400'],
  ]) {
    await expect(page.locator(selector).first()).toHaveCSS('font-weight', weight);
    const textNode = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    const actual = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: textNode.nodeId });
    expect(actual.fonts).toEqual([
      expect.objectContaining({
        familyName: expect.stringMatching(/^Manrope(?: |$)/),
        postScriptName: expect.stringMatching(/^Manrope-/),
        isCustomFont: true,
      }),
    ]);
  }
  // CDP reports the platform face name: FreeType can retain the variable font's
  // base name (ExtraLight) even when rendering wght=800. Verify the real DOM
  // raster instead of treating an OS-specific PostScript name as weight proof.
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.id = 'manrope-raster-proof';
    probe.textContent = 'Ёж Щит Юлия';
    Object.assign(probe.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '2147483647',
      width: '320px',
      height: '80px',
      padding: '0',
      margin: '0',
      border: '0',
      background: 'white',
      color: 'black',
      fontFamily: 'Manrope',
      fontSize: '32px',
      lineHeight: '64px',
      fontSynthesis: 'none',
      fontStyle: 'normal',
      letterSpacing: '0',
      whiteSpace: 'nowrap',
    });
    document.body.append(probe);
  });
  const rasterProbe = page.locator('#manrope-raster-proof');
  const rasterMetrics = [];
  try {
    for (const weight of ['200', '800']) {
      await rasterProbe.evaluate((element, value) => (element.style.fontWeight = value), weight);
      await expect(rasterProbe).toHaveCSS('font-weight', weight);
      await expect(rasterProbe).toHaveCSS('font-synthesis', 'none');
      const probeNode = await cdp.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#manrope-raster-proof',
      });
      const used = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: probeNode.nodeId });
      expect(used.fonts).toEqual([
        expect.objectContaining({
          familyName: expect.stringMatching(/^Manrope(?: |$)/),
          isCustomFont: true,
          glyphCount: expect.any(Number),
        }),
      ]);
      expect(used.fonts[0].glyphCount).toBeGreaterThan(0);
      const png = await rasterProbe.screenshot({ animations: 'disabled' });
      await info.attach(`Manrope-Cyrillic-${weight}`, { body: png, contentType: 'image/png' });
      const pixels = await page.evaluate(
        async (uri) => {
          const image = new Image();
          image.src = uri;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          let left = canvas.width;
          let right = -1;
          for (let i = 0; i < data.length; i += 4) {
            const blackness = (765 - data[i] - data[i + 1] - data[i + 2]) / 765;
            ink += blackness;
            if (blackness > 0.1) {
              const x = (i / 4) % canvas.width;
              left = Math.min(left, x);
              right = Math.max(right, x);
            }
          }
          return { width: canvas.width, height: canvas.height, ink, inkWidth: right - left + 1 };
        },
        `data:image/png;base64,${png.toString('base64')}`,
      );
      expect(pixels.inkWidth).toBeGreaterThan(0);
      rasterMetrics.push({ weight, fonts: used.fonts, ...pixels });
    }
    expect(rasterMetrics[1].width).toBe(rasterMetrics[0].width);
    expect(rasterMetrics[1].height).toBe(rasterMetrics[0].height);
    // Normalize by actual glyph width so wider advances alone cannot pass.
    const densityRatio =
      rasterMetrics[1].ink /
      rasterMetrics[1].inkWidth /
      (rasterMetrics[0].ink / rasterMetrics[0].inkWidth);
    await info.attach('Manrope-variable-raster-proof', {
      body: JSON.stringify({ rasterMetrics, densityRatio }, null, 2),
      contentType: 'application/json',
    });
    expect(
      densityRatio,
      'real wght=800 Cyrillic ink is denser than wght=200 without faux bold',
    ).toBeGreaterThan(1.5);
  } finally {
    await rasterProbe.evaluate((element) => element.remove());
    await cdp.detach();
  }
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
  await page.getByRole('textbox', { name: 'Месяц', exact: true }).fill(month);
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
  await page.getByRole('button', { name: /Просроченные задачи/ }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /Просроченные задачи/ })).toBeVisible();
  await page.getByRole('button', { name: /Просроченные задачи/ }).click();
  await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
  await expect(page.locator('.pico-task-row')).toHaveCount(10);
});
