import { expect, Locator, Page, test } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';

async function visibleHeight(locator: Locator) {
  if (!(await locator.count())) return 0;
  return locator.evaluate((element) => {
    let rect = element.getBoundingClientRect();
    if (getComputedStyle(element).display === 'none') return 0;
    let top = rect.top,
      bottom = rect.bottom;
    for (let p = element.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
        const outer = p.getBoundingClientRect();
        top = Math.max(top, outer.top);
        bottom = Math.min(bottom, outer.bottom);
      }
      if (p.classList.contains('pico-client-copy')) break;
    }
    return Math.max(0, bottom - top);
  });
}
async function loginAndSeed(page: Page) {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ body: '' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const prefix = `Высота${Date.now()}`;
  const data = [
    { name: 'ЭЛЕКТРООПТИМА', city: 'Москва', industry: 'Энергетика' },
    { name: 'ЯРОСЛАВСКИЙ БРОЙЛЕР', city: 'Ярославль', industry: 'Производство пищевых продуктов' },
    {
      name: 'Федеральная гидрогенерирующая компания с очень длинным названием для проверки переноса и обрезания текста',
      city: 'Санкт-Петербург и очень длинное уточнение города',
      industry: 'Очень длинное описание отрасли, которое должно быть целиком доступно в данных',
    },
    {
      name: 'Э'.repeat(120),
      city: 'ДлинныйГородБезПробелов'.repeat(4),
      industry: 'ОтрасльБезПробелов'.repeat(5),
    },
    { name: 'АСПР Групп', city: '', industry: '' },
    { name: 'Луч', city: 'Москва', industry: 'Энергетика' },
  ];
  const created = [];
  for (const item of data) {
    const response = await page.request.post('/api/companies', {
      headers,
      data: { ...item, notes: prefix, potential: 999_999_999_999, segment: 'end_client' },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    created.push({ ...item, id: (await response.json()).id });
  }
  await clients(page);
  await action(page, 'Обновить');
  return created;
}
function card(page: Page, name: string) {
  return page
    .locator('.cc-card')
    .filter({ has: page.locator('.pico-client-copy > strong', { hasText: name }) })
    .first();
}
async function verifyRows(page: Page, items: { name: string }[]) {
  const metrics = [];
  for (const item of items) {
    const row = card(page, item.name).locator('.pico-client-row');
    await expect(row).toBeVisible();
    const shape = await row.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      const copy = el.querySelector('.pico-client-copy')!;
      const title = copy.querySelector('strong')!;
      const t = title.getBoundingClientRect();
      const control = (selector: string) => {
        const r = el.querySelector(selector)!.getBoundingClientRect();
        return { x: r.x - bounds.x, centerY: (r.top + r.bottom) / 2 - bounds.top };
      };
      return {
        height: bounds.height,
        copyHeight: copy.getBoundingClientRect().height,
        titleHeight: t.height,
        lineHeight: parseFloat(getComputedStyle(title).lineHeight),
        clamp: getComputedStyle(title).webkitLineClamp,
        badge: control('.icon-badge'),
        money: control('.company-money'),
        arrow: control(':scope > svg'),
        width: bounds.width,
        scrollWidth: el.scrollWidth,
      };
    });
    expect(shape.clamp).toBe('2');
    expect(shape.titleHeight).toBeLessThanOrEqual(shape.lineHeight * 2 + 1);
    expect(shape.scrollWidth).toBeLessThanOrEqual(shape.width + 1);
    metrics.push(shape);
  }
  for (const m of metrics) {
    expect(Math.abs(m.height - metrics[0]!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.copyHeight - metrics[0]!.copyHeight)).toBeLessThanOrEqual(1);
    for (const key of ['badge', 'money', 'arrow'] as const) {
      expect(Math.abs(m[key].x - metrics[0]![key].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(m[key].centerY - metrics[0]![key].centerY)).toBeLessThanOrEqual(1);
    }
  }
  // Full-width short title leaves room for both metadata lines. Long titles
  // consume two lines and must leave only the type/city line, never the industry.
  for (const [index, item] of items.entries()) {
    if (index === 4) continue;
    const row = card(page, item.name).locator('.pico-client-row');
    const titleLines = metrics[index]!.titleHeight / metrics[index]!.lineHeight;
    const metadata = row.locator('.pico-client-metadata > span');
    expect(await visibleHeight(metadata.first())).toBeGreaterThan(10);
    if (titleLines > 1.5) expect(await visibleHeight(metadata.nth(1))).toBeLessThan(1);
    else expect(await visibleHeight(metadata.nth(1))).toBeGreaterThan(10);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
}

test('client cards reserve three lines at every width and keep full data and swipe actions', async ({
  page,
}, info) => {
  const items = await loginAndSeed(page);
  const widths = info.project.name === 'mobile' ? [320, 390] : [320, 390, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(async () => {
        const sizes = await Promise.all(
          items.map(
            async (item) =>
              (await card(page, item.name).locator('.pico-client-row').boundingBox())?.height,
          ),
        );
        return Math.max(...sizes.map((v) => v || 0)) - Math.min(...sizes.map((v) => v || 0));
      })
      .toBeLessThanOrEqual(1);
    await verifyRows(page, items);
    await page.screenshot({
      path: `/tmp/pico-card-height-${info.project.name}-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const long = card(page, items[2]!.name);
  await long.locator('.pico-client-row').click();
  const data = long
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Данные' }) });
  await data.locator('summary').click();
  await expect(data).toContainText(items[2]!.name);
  await expect(data).toContainText(items[2]!.city);
  await expect(data).toContainText(items[2]!.industry);
  for (const value of [items[2]!.name, items[2]!.city, items[2]!.industry]) {
    const field = data.getByText(value, { exact: true }).first();
    await expect(field).toBeVisible();
    const fits = await field.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const bounds = el.closest('button')!.getBoundingClientRect();
      return (
        text.left >= bounds.left - 1 &&
        text.right <= bounds.right + 1 &&
        text.top >= bounds.top - 1 &&
        text.bottom <= bounds.bottom + 1
      );
    });
    expect(fits, `Expanded Data clips ${value}`).toBeTruthy();
  }
  await long.locator('.pico-client-row').click();
  await verifyRows(page, items);
  const swipe = long.locator(':scope > .cc-swipe');
  await swipe.scrollIntoViewIfNeeded();
  await swipe.focus();
  await swipe.press('ArrowLeft');
  await expect(swipe).toHaveClass(/cc-revealed/);
  await expect(swipe.getByRole('button', { name: /Перенести клиента.*в архив/ })).toBeVisible();
  await swipe.press('ArrowRight');
  await expect(swipe).not.toHaveClass(/cc-revealed/);
  await verifyRows(page, items);
});
