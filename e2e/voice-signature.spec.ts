import { test, expect } from '@playwright/test';
test('voice draft opens editable form and only saves on confirmation', async ({ page }) => {
  const data = {
    lastName: 'Голосов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  let saved = false;
  await page.route('**/api/me/signature-drafts', (route) =>
    route.fulfill({
      json: saved ? [] : [{ id: 'voice-test', data, transcript: 'Добавь подпись. Голосов Иван' }],
    }),
  );
  await page.route('**/api/me/signature-drafts/voice-test/save', (route) => {
    expect(route.request().postDataJSON().email).toBe('corrected@example.com');
    saved = true;
    return route.fulfill({ json: { ...data, email: 'corrected@example.com', id: 'saved-voice' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await page.getByRole('button', { name: 'Мой профиль', exact: false }).click();
  await page.getByRole('button', { name: 'Проверить голосовую подпись' }).click();
  await expect(page.getByLabel('Фамилия', { exact: true })).toHaveValue('Голосов');
  expect(saved).toBe(false);
  await page.getByLabel('Email', { exact: true }).fill('corrected@example.com');
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(page.getByText('Подпись сохранена.', { exact: true })).toBeVisible();
  expect(saved).toBe(true);
  await expect(page.getByRole('button', { name: 'Проверить голосовую подпись' })).toHaveCount(0);
});
