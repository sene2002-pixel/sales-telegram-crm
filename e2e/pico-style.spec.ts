import { openCompanySection } from './helpers';
import { prepareDemoAuth, saveNewClientAndOpen } from './helpers';
import { clients, navigate, openCompany } from './helpers';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => prepareDemoAuth(page));

for (const width of [375, 1440]) {
  test(`Pico style remains responsive and keeps the letter form compact at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    if (testInfo.project.name === 'mobile' && width === 1440) {
      // Wide portrait tablet with a keyboard-height window; keep portrait-only guard active.
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
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page).toHaveTitle('Pico — CRM');
    await expect(page.getByRole('heading', { name: 'Pico', exact: true })).toBeVisible();
    const avatar = page.getByRole('img', { name: 'Pico — AI-помощник' });
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveAttribute('src', '/brand/pico-avatar.png');
    await expect(avatar).toHaveJSProperty('naturalWidth', 1254);

    await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
    await clients(page);
    await expect(page.getByRole('navigation').getByRole('button', { name: 'Команда' })).toHaveCount(
      0,
    );
    await expect(page.locator(width < 760 ? '.mobile-brand' : '.logo')).toContainText('Pico');
    await expect(page.locator(width < 760 ? '.mobile-brand' : '.logo')).toBeVisible();
    const createCompany = page.getByRole('button', { name: 'Добавить клиента', exact: true });
    await expect(createCompany).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(34, 40, 79)');
    const noOverflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noOverflow()).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`pico-companies-${width}.png`),
      // The real fixture list can exceed Chromium's full-page bitmap limit at 3x DPR.
      // DOM overflow assertions above cover the full document; capture the visible UI.
      fullPage: false,
    });

    await createCompany.click();
    await page.getByLabel('Название', { exact: true }).fill(`Pico ${width} ${Date.now()}`);
    await saveNewClientAndOpen(page);
    const dialog = page.getByRole('dialog');
    const composer = dialog.locator('.letter-composer');
    await expect(composer).not.toHaveClass(/inset/);
    await dialog.getByRole('button', { name: 'Контакты', exact: true }).click();
    await dialog.getByRole('button', { name: '+ Добавить', exact: true }).click();
    await page.getByLabel('Имя', { exact: true }).fill('Тестовый получатель');
    await page.getByRole('button', { name: 'Сохранить контакт', exact: true }).click();
    await openCompanySection(page, 'actions');
    await composer.getByRole('button', { name: 'Создать письмо', exact: true }).click();
    await expect(
      composer.getByRole('combobox', { name: 'Моя подпись', exact: true }),
    ).toBeVisible();
    expect(await composer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const saveBox = (await composer
      .getByRole('button', { name: 'Сформировать PDF и сохранить' })
      .boundingBox())!;
    const cancelBox = (await composer
      .getByRole('button', { name: 'Отмена', exact: true })
      .boundingBox())!;
    expect(Math.abs(saveBox.height - cancelBox.height)).toBeLessThanOrEqual(1);
    if (width === 375) {
      expect(Math.abs(saveBox.width - cancelBox.width)).toBeLessThanOrEqual(1);
      expect(cancelBox.y).toBeGreaterThan(saveBox.y);
    }
    expect(await noOverflow()).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`pico-letter-${width}.png`),
      fullPage: false,
    });
    await composer.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(composer).not.toHaveClass(/inset/);
    expect(errors).toEqual([]);
  });
}
