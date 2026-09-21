import { test, expect } from '@playwright/test';
test('letter contact validation and editable signature', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Клиенты и компании' })).toBeVisible();
  const headers = {
    Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem('crm-session'))}`,
  };
  const signatures = await (
    await page.request.get('/api/me/letter-signatures', { headers })
  ).json();
  for (const s of signatures)
    await page.request.delete('/api/me/letter-signatures/' + s.id, { headers });
  await page.getByRole('button', { name: '+ Компания', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Письма ' + Date.now());
  await page.getByRole('button', { name: 'Сохранить компанию' }).click();
  await expect(page.locator('.letter-composer')).not.toHaveClass(/inset/);
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
  const signatureSelect = page.getByRole('combobox', { name: 'Моя подпись', exact: true });
  await expect(signatureSelect).toBeVisible();
  const composer = page.locator('.letter-composer');
  await expect(composer).toHaveClass(/inset/);
  await composer.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(composer).not.toHaveClass(/inset/);
  await expect(signatureSelect).toHaveCount(0);
  await composer.getByRole('button', { name: 'Создать письмо', exact: true }).click();
  await expect(composer).toHaveClass(/inset/);
  await expect(signatureSelect).toBeVisible();
  expect(await composer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const actionButtons = composer.locator('.letter-actions button');
  const primaryBox = (await actionButtons.nth(0).boundingBox())!;
  const cancelBox = (await actionButtons.nth(1).boundingBox())!;
  expect(Math.abs(primaryBox.height - cancelBox.height)).toBeLessThanOrEqual(1);
  const recipientHeight = (await page.getByLabel('Получатель письма').boundingBox())!.height;
  expect((await signatureSelect.boundingBox())!.height).toBeLessThanOrEqual(recipientHeight + 2);
  await signatureSelect.selectOption('add');
  await expect(page.getByRole('heading', { name: 'Добавить подпись' })).toBeVisible();
  await page.getByLabel('Фото визитки', { exact: false }).setInputFiles({
    name: 'card.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([255, 216, 255, 0]),
  });
  await expect(page.getByLabel('Фамилия', { exact: true })).toHaveValue('Петров');
  await page.getByLabel('Фамилия', { exact: true }).fill('Сидоров');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('button', { name: 'Сформировать PDF и сохранить' })).toBeEnabled();
  await expect(page.getByRole('dialog')).toContainText('Сидоров');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Мой профиль', exact: false }).click();
  await page.getByRole('button', { name: 'Редактировать подпись', exact: true }).click();
  await expect(page.getByLabel('Фамилия', { exact: true })).toHaveValue('Сидоров');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  for (const lastName of ['Вторая', 'Третья']) {
    await page.getByRole('button', { name: '+ Добавить подпись', exact: true }).click();
    await page.getByLabel('Фамилия', { exact: true }).fill(lastName);
    await page.getByLabel('Имя', { exact: true }).fill('Иван');
    await page.getByRole('button', { name: 'Сохранить изменения' }).click();
    await expect(page.getByRole('heading', { name: 'Добавить подпись' })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: '+ Добавить подпись', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText('Достигнут лимит:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Удалить подпись', exact: true }).first().click();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Удалить подпись', exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Удалить подпись', exact: true }).first().click();
  await page.getByRole('button', { name: 'Подтвердить удаление' }).click();
  await expect(page.getByRole('button', { name: '+ Добавить подпись', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Удалить подпись', exact: true })).toHaveCount(2);
});
