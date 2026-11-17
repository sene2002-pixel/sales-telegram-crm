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
