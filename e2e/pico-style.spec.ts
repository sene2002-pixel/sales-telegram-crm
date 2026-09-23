import { test, expect } from '@playwright/test';

for (const width of [375, 1440]) {
  test(`Pico style remains responsive and keeps the letter form compact at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
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
    await expect(page.getByRole('heading', { name: 'Клиенты и компании' })).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('button', { name: 'Команда' })).toHaveCount(
      0,
    );
    await expect(page.locator(width < 760 ? '.mobile-brand' : '.logo')).toContainText('Pico');
    await expect(page.locator(width < 760 ? '.mobile-brand' : '.logo')).toBeVisible();
    const createCompany = page.getByRole('button', { name: '+ Компания', exact: true });
    await expect(createCompany).toHaveCSS('background-color', 'rgb(70, 87, 237)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(25, 36, 77)');
    const noOverflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noOverflow()).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`pico-companies-${width}.png`),
      fullPage: true,
    });

    await createCompany.click();
    await page.getByLabel('Название', { exact: true }).fill(`Pico ${width} ${Date.now()}`);
    await page.getByRole('button', { name: 'Сохранить компанию' }).click();
    const dialog = page.getByRole('dialog');
    const composer = dialog.locator('.letter-composer');
    await expect(composer).not.toHaveClass(/inset/);
    await dialog.getByRole('button', { name: 'Контакты', exact: true }).click();
    await dialog.getByRole('button', { name: '+ Добавить', exact: true }).click();
    await page.getByLabel('Имя', { exact: true }).fill('Тестовый получатель');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await composer.getByRole('button', { name: 'Создать письмо', exact: true }).click();
    await expect(page.getByLabel('Моя подпись', { exact: true })).toBeVisible();
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
      fullPage: true,
    });
    await composer.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(composer).not.toHaveClass(/inset/);
    expect(errors).toEqual([]);
  });
}
