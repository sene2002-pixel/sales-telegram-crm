import { expect, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
});

for (const width of [360, 390, 1440]) {
  test(`Layout regression: square equipment badges, aligned greeting and loaded PNG at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 360 ? 640 : 900 });
    if (info.project.name === 'mobile' && width === 1440) {
      // Wide portrait tablet with a keyboard-height window; actual landscape is tested separately.
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
    await page.goto('/');
    await page.getByRole('button', { name: 'Администратор', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const response = await page.request.post('/api/companies', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `Очень длинное название энергетической компании для проверки переноса ${Date.now()}-${width}`,
        potential: 540_000_000,
        divisions: { mv: 160_000_000, drives_mv: 60_000_000, heat: 320_000_000 },
      },
    });
    expect(response.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
    const crown = page.getByRole('button', { name: 'Управление пользователями', exact: true });
    const heading = page.locator('.pico-home-greeting h1');
    const subtitle = page.locator('.pico-home-welcome > .muted');
    const [crownBox, headingBox, subtitleBox] = await Promise.all([
      crown.boundingBox(),
      heading.boundingBox(),
      subtitle.boundingBox(),
    ]);
    expect(crownBox!.x).toBeGreaterThan(headingBox!.x);
    expect(crownBox!.x + crownBox!.width).toBeLessThanOrEqual(
      headingBox!.x + headingBox!.width + 1,
    );
    expect(crownBox!.width).toBeLessThanOrEqual(30);
    expect(crownBox!.y).toBeLessThan(headingBox!.y + headingBox!.height);
    expect(Math.abs(subtitleBox!.x - headingBox!.x)).toBeLessThan(1);
    expect(subtitleBox!.y - headingBox!.y - headingBox!.height).toBeGreaterThanOrEqual(3);
    expect(subtitleBox!.y - headingBox!.y - headingBox!.height).toBeLessThanOrEqual(5);
    if (width <= 760) {
      await expect(page.locator('.mobile-brand')).toBeHidden();
    } else {
      const brand = page.locator('.brand-mark:visible').first();
      await expect(brand).toHaveAttribute('src', '/brand/pico-avatar.png');
      expect(
        await brand.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
      ).toBeTruthy();
    }
    await page.screenshot({ path: info.outputPath(`home-${width}.png`), animations: 'disabled' });
    await crown.click();
    await expect(page.getByRole('heading', { name: 'Пользователи', exact: true })).toBeVisible();
    await navigate(page, 'Аналитика');
    if (width <= 760) {
      const brand = page.locator('.mobile-brand');
      await expect(brand).toHaveText('Pico Bot');
      const box = (await brand.boundingBox())!;
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(1);
    }
    const badges = page.locator('.pico-potential summary .pico-row-icon');
    await expect(badges).toHaveCount(7);
    const boxes = await badges.evaluateAll((elements) =>
      elements.map((el) => {
        const box = el.getBoundingClientRect();
        const svg = el.querySelector('svg')!.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          flexGrow: getComputedStyle(el).flexGrow,
          svgWidth: svg.width,
          svgHeight: svg.height,
        };
      }),
    );
    for (const box of boxes) {
      expect(box.width).toBe(27);
      expect(box.height).toBe(27);
      expect(box.flexGrow).toBe('0');
      expect(box.svgWidth).toBe(16);
      expect(box.svgHeight).toBe(16);
    }
    const amounts = await page
      .locator('.pico-potential summary > strong')
      .evaluateAll((elements) => elements.map((el) => getComputedStyle(el).whiteSpace));
    expect(amounts.every((value) => value === 'nowrap')).toBeTruthy();
    const details = page
      .locator('.pico-potential details')
      .filter({ hasText: 'Выключатели 6–35 кВ' })
      .first();
    await details.locator('summary').click();
    const clientRows = await details.locator('.pico-potential-client').evaluateAll((elements) =>
      elements.map((el) => {
        const name = el.querySelector('span')!.getBoundingClientRect();
        const amount = el.querySelector('strong')!;
        const box = amount.getBoundingClientRect();
        return {
          nameRight: name.right,
          amountLeft: box.left,
          whiteSpace: getComputedStyle(amount).whiteSpace,
        };
      }),
    );
    expect(clientRows.length).toBeGreaterThan(0);
    for (const row of clientRows) {
      expect(row.whiteSpace).toBe('nowrap');
      expect(row.nameRight).toBeLessThanOrEqual(row.amountLeft);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await page.locator('.pico-potential').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`analytics-${width}.png`),
      animations: 'disabled',
    });
    if (width < 761) {
      const navigation = page.getByRole('navigation', { name: 'Основная навигация', exact: true });
      await expect(navigation.getByRole('button')).toHaveCount(5);
      const icon = navigation.getByRole('button', { name: 'Клиенты', exact: true }).locator('svg');
      const box = (await icon.boundingBox())!;
      expect(box.width).toBe(21);
      expect(box.height).toBe(21);
      await navigation.getByRole('button', { name: 'Клиенты', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Клиенты', exact: true })).toBeVisible();
    }
  });
}
