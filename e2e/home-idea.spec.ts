import { expect, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mKUAAAAASUVORK5CYII=',
  'base64',
);

test('Home idea handles image removal, saves optional topic and supports admin review', async ({
  page,
}) => {
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Привет/ })).toBeVisible();
  await page.getByRole('button', { name: /^Идея/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Идея', exact: true });
  const submit = sheet.getByRole('button', { name: 'Отправить', exact: true });
  await expect(submit).toBeDisabled();
  await sheet.getByRole('button', { name: 'Главная', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Главная', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const file = sheet.locator('input[type="file"]');
  await file.setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: png });
  await expect(sheet.getByAltText('Прикреплённый скриншот')).toBeVisible();
  await sheet.getByRole('button', { name: 'Убрать скриншот' }).click();
  await expect(sheet.getByAltText('Прикреплённый скриншот')).toHaveCount(0);
  await file.setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: png });
  const idea = 'Обратная связь ' + Date.now();
  await sheet.getByRole('textbox', { name: 'Опишите идею' }).fill(idea);
  await submit.click();
  await expect(sheet.getByText('Спасибо за идею!', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'На главную' }).click();
  await navigate(page, 'Пользователи');
  await page.getByRole('button', { name: 'Загрузить идеи' }).click();
  const review = page.locator('.pico-idea-review').filter({ hasText: idea });
  await expect(review).toContainText('Главная');
  const downloading = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Скачать скриншот' }).click();
  expect(await (await downloading).failure()).toBeNull();
  await review.getByRole('button', { name: 'Отметить внедрение' }).click();
  await expect(review.getByText('Внедрено')).toBeVisible();
});

test('Idea draft survives closing and clears only after successful submission', async ({
  page,
}) => {
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  const open = page.getByRole('button', { name: /^Идея/ });
  await open.click();
  const sheet = page.getByRole('dialog', { name: 'Идея', exact: true });
  await sheet.getByRole('button', { name: 'Главная', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'Опишите идею' }).fill('Черновик идеи');
  await sheet
    .locator('input[type="file"]')
    .setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: png });
  await expect(sheet.getByAltText('Прикреплённый скриншот')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(open).toBeFocused();
  await navigate(page, 'Клиенты');
  await navigate(page, 'Главная');
  const employeeFilter = page.getByRole('combobox', { name: 'Данные сотрудника' });
  await expect(employeeFilter.locator('option')).not.toHaveCount(1);
  const employeeId = await employeeFilter.locator('option').nth(1).getAttribute('value');
  await employeeFilter.selectOption(employeeId!);
  await expect(page.getByRole('region', { name: 'Фильтр сотрудника' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await open.click();
  await expect(sheet.getByRole('textbox', { name: 'Опишите идею' })).toHaveValue('Черновик идеи');
  await expect(sheet.getByRole('button', { name: 'Главная', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(sheet.getByAltText('Прикреплённый скриншот')).toBeVisible();
  await sheet.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'На главную' })).toBeFocused();
  await sheet.getByRole('button', { name: 'На главную' }).click();
  await open.click();
  await expect(sheet.getByRole('textbox', { name: 'Опишите идею' })).toHaveValue('');
  await expect(sheet.getByAltText('Прикреплённый скриншот')).toHaveCount(0);
});

test('Idea can be retried safely after its response is lost', async ({ page }) => {
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  let attempts = 0;
  await page.route('**/api/pico-ideas', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    if (attempts === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: /^Идея/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Идея', exact: true });
  const idea = 'Повтор без дубликата ' + Date.now();
  await sheet.getByRole('textbox', { name: 'Опишите идею' }).fill(idea);
  await sheet.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('Повторите отправку без изменений');
  await expect(sheet.getByRole('textbox', { name: 'Опишите идею' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Идея/ }).click();
  await expect(sheet.getByRole('textbox', { name: 'Опишите идею' })).toHaveValue(idea);
  await sheet.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(sheet.getByText('Спасибо за идею!', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'На главную' }).click();
  await navigate(page, 'Пользователи');
  await page.getByRole('button', { name: 'Загрузить идеи' }).click();
  await expect(page.locator('.pico-idea-review').filter({ hasText: idea })).toHaveCount(1);
});

test('Idea shows a rate limit and preserves the retry explanation after another error', async ({
  page,
}) => {
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  let attempts = 0;
  await page.route('**/api/pico-ideas', async (route) => {
    attempts++;
    await route.fulfill(
      attempts === 1
        ? { status: 429, json: { message: 'Можно отправить до 10 идей в сутки' } }
        : { status: 400, json: { message: 'Ошибка проверки' } },
    );
  });
  await page.getByRole('button', { name: /^Идея/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Идея', exact: true });
  await sheet.getByRole('textbox', { name: 'Опишите идею' }).fill('Идея с лимитом');
  await sheet.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('Можно отправить до 10 идей в сутки');
  await expect(sheet.getByRole('alert')).toContainText('Повторите отправку без изменений позже');
  await sheet.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('Ошибка проверки');
  await expect(sheet.getByRole('alert')).toContainText('Предыдущая отправка могла состояться');
  await expect(sheet.getByRole('textbox', { name: 'Опишите идею' })).toBeDisabled();
  await sheet.getByRole('button', { name: /Изменить идею/ }).click();
  await expect(sheet.getByRole('textbox', { name: 'Опишите идею' })).toBeEditable();
});
