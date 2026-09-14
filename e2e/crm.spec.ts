import { test, expect } from '@playwright/test';
test('manager creates a company and task, then data survives reload', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Клиенты и компании' })).toBeVisible();
  await page.getByRole('button', { name: '+ Компания', exact: true }).click();
  const name = 'Электрострой ' + testInfo.project.name + ' ' + Date.now();
  await page.getByLabel('Название', { exact: true }).fill(name);
  await page.getByLabel('Город', { exact: true }).fill('Казань');
  await page.getByLabel('Потенциал, ₽', { exact: true }).fill('3000000');
  await page.getByRole('button', { name: 'Сохранить компанию' }).click();
  await expect(page.getByRole('dialog')).toContainText(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: '+ Добавить', exact: true }).click();
  await page.getByLabel('Задача', { exact: true }).fill('Отправить предложение');
  await page.getByLabel('Срок', { exact: true }).fill('2026-09-20');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Отправить предложение');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: name, exact: true })).toBeVisible();
  await page.getByRole('heading', { name: name, exact: true }).click();
  await page.getByRole('button', { name: 'Редактировать компанию' }).click();
  await page.getByLabel('Город', { exact: true }).fill('Москва');
  await page.getByRole('button', { name: 'Сохранить компанию' }).click();
  await expect(page.getByRole('dialog')).toContainText('Москва');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('crm.png'), fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});
test('admin can inspect the team, managers cannot see team navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Команда' }).click();
  await expect(page.getByRole('heading', { name: 'Команда', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Доступ сотрудников' })).toBeVisible();
});
