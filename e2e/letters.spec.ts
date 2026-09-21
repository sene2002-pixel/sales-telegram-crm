import { test, expect } from '@playwright/test';
test('letter contact validation and editable signature', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await page.getByRole('button', { name: '+ Компания', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Письма ' + Date.now());
  await page.getByRole('button', { name: 'Сохранить компанию' }).click();
  await page.getByRole('button', { name: 'Создать письмо', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('необходимо добавить хотя бы один контакт');
  await page.getByRole('button', { name: 'Контакты', exact: true }).click();
  await page.getByRole('button', { name: '+ Добавить', exact: true }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Иванов Иван Иванович');
  await page.getByLabel('Должность', { exact: true }).fill('Директор');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.route('**/api/me/letter-signature/recognize', (route) =>
    route.fulfill({
      json: {
        lastName: 'Петров',
        firstName: 'Пётр',
        patronymic: '',
        workPhone: '',
        mobilePhone: '',
        email: '',
      },
    }),
  );
  await page.getByRole('button', { name: 'Создать письмо', exact: true }).click();
  await expect(page.getByLabel('Получатель письма')).not.toHaveValue('');
  await expect(page.getByRole('button', { name: 'Редактировать подпись' })).toHaveCount(0);
  await expect(page.getByLabel('Фамилия', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Мой профиль', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Подпись для писем' })).toBeVisible();
  await page.getByLabel('Фото визитки', { exact: false }).setInputFiles({
    name: 'card.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([255, 216, 255, 0]),
  });
  await expect(page.getByLabel('Фамилия', { exact: true })).toHaveValue('Петров');
  await page.getByLabel('Фамилия', { exact: true }).fill('Сидоров');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('status')).toContainText('Подпись сохранена');
  await page.reload();
  await page.getByRole('button', { name: 'Мой профиль', exact: false }).click();
  await expect(page.getByLabel('Фамилия', { exact: true })).toHaveValue('Сидоров');
});
