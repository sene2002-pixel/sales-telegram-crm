import { expect, test } from '@playwright/test';
import { clients, prepareDemoAuth } from './helpers';

test('New manager can read the empty client card and start adding a client', async ({
  page,
}, info) => {
  const mobile = info.project.name === 'mobile';
  await prepareDemoAuth(page);
  await page.route('**/api/companies', (route) => route.fulfill({ json: [] }));
  if (mobile) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      (window as typeof window & { Telegram: unknown }).Telegram = {
        WebApp: {
          initData: 'synthetic-empty-client-session',
          platform: 'ios',
          safeAreaInset: { top: 47, bottom: 34, left: 12, right: 18 },
          contentSafeAreaInset: { top: 48 },
        },
      };
    });
    await page.route('**/api/auth/telegram', async (route) => {
      const response = await page.request.post('/api/auth/dev', { data: { role: 'manager' } });
      expect(response.ok()).toBe(true);
      await route.fulfill({ response });
    });
  }
  await page.goto('/');
  if (!mobile) await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await clients(page);

  const empty = page.getByRole('heading', { name: 'Клиентов пока нет', exact: true });
  const guide = page.locator('.pico-guide').filter({
    has: page.getByRole('heading', { name: 'Что будет в карточке клиента', exact: true }),
  });
  await expect(empty).toBeVisible();
  await expect(
    page.getByText('Добавьте первого клиента: щитовика, монтажника или конечного заказчика', {
      exact: true,
    }),
  ).toBeVisible();
  for (const name of ['Все', 'В работе', 'Закрытые', 'Фильтры клиентов'])
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  const add = page.getByRole('button', { name: 'Добавить клиента', exact: true });
  const search = page.getByPlaceholder('Поиск клиента, компании или контакта');
  await expect(search).toBeVisible();
  for (const text of [
    'Бизнес клиента',
    'Чем занимается и с кем работает',
    'Контакты',
    'Кто принимает решение и как связаться',
    'Потенциал',
    'Суммы по оборудованию',
    'Заметки',
    'Итоги встреч и договорённости',
  ])
    await expect(guide.getByText(text, { exact: true })).toBeVisible();

  if (mobile) {
    await expect(page.locator('.app-shell')).toHaveClass(/telegram-native-header/);
  } else {
    await page.screenshot({ path: info.outputPath('clients-empty-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await expect(page.getByRole('button', { name: 'Дополнительное меню' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const footer = page.getByRole('navigation', { name: 'Основная навигация' });
  await expect(async () => {
    const [nav, card] = await Promise.all([footer.boundingBox(), guide.boundingBox()]);
    const gap = nav!.y - card!.y - card!.height;
    expect(gap).toBeGreaterThanOrEqual(16);
    expect(gap).toBeLessThanOrEqual(32);
  }).toPass();
  await expect(search.locator('..')).toHaveCSS('height', '40px');
  await expect(page.getByRole('button', { name: 'Закрытые', exact: true })).toHaveCSS(
    'height',
    '36px',
  );
  await expect(add).toHaveCSS('height', '48px');
  const rows = guide.locator('.pico-guide-row');
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    await expect(row).toHaveCSS('height', '56px');
    await expect(row.locator('strong')).toHaveCSS('font-size', '15px');
    await expect(row.locator('small')).toHaveCSS('font-size', '13px');
  }
  const dimensions = await page.locator('.workspace').evaluate((main) => ({
    documentOverflow: document.scrollingElement!.scrollHeight - innerHeight,
    mainOverflow: main.scrollHeight - main.clientHeight,
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
  }));
  for (const overflow of Object.values(dimensions)) expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('clients-empty-390.png') });

  if (mobile) {
    await page.setViewportSize({ width: 320, height: 568 });
    const last = guide.getByText('Итоги встреч и договорённости', { exact: true });
    await last.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const bounds = (await last.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual((await footer.boundingBox())!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  }
  await search.fill('Неизвестная компания');
  await expect(search).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Нет компаний по выбранным фильтрам' }),
  ).toBeVisible();
  await expect(guide).toHaveCount(0);
  await search.fill('');
  await expect(empty).toBeVisible();
  await expect(guide).toBeVisible();
  await add.click();
  const sheet = page.getByRole('dialog', { name: 'Новый клиент' });
  await expect(sheet.getByLabel('Название', { exact: true })).toBeVisible();
  if (mobile) {
    const viewport = page.viewportSize()!;
    for (const name of ['Сохранить клиента', 'Закрыть']) {
      const button = (await sheet.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(button.x).toBeGreaterThanOrEqual(12);
      expect(button.x + button.width).toBeLessThanOrEqual(viewport.width - 18);
      expect(button.y + button.height).toBeLessThanOrEqual(viewport.height - 34);
    }
  }
});
