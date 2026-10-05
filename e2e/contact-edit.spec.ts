import { test, expect } from '@playwright/test';

test('contact edit retains rejected input and reloads the database after successful retry', async ({
  page,
}) => {
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Клиенты и компании' })).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const companyResponse = await page.request.post('/api/companies', {
    headers,
    data: { name: `Contact retry ${Date.now()}` },
  });
  expect(companyResponse.ok()).toBeTruthy();
  const company = await companyResponse.json();
  const contactResponse = await page.request.post(`/api/companies/${company.id}/records/contact`, {
    headers,
    data: { data: { name: 'Иван', role: '', phone: '', email: '' } },
  });
  expect(contactResponse.ok()).toBeTruthy();
  const contact = await contactResponse.json();
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.getByRole('heading', { name: company.name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Контакты', exact: true }).click();
  await dialog.getByRole('button', { name: 'Изменить', exact: true }).click();
  await dialog.getByLabel('Имя', { exact: true }).fill('Пётр');
  let rejected = false;
  await page.route(`**/api/records/${contact.id}`, async (route) => {
    if (route.request().method() === 'PATCH' && !rejected) {
      rejected = true;
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Слишком много запросов. Повторите через минуту' }),
      });
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Слишком много запросов');
  await expect(dialog.getByLabel('Имя', { exact: true })).toHaveValue('Пётр');
  await expect(dialog.locator('.records')).toContainText('Иван');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('Пётр');
  await expect(dialog.getByLabel('Имя', { exact: true })).toHaveCount(0);
  const freshResponse = await page.request.get(`/api/companies/${company.id}`, { headers });
  expect(freshResponse.ok()).toBeTruthy();
  expect((await freshResponse.json()).records.find((r: any) => r.id === contact.id).data.name).toBe(
    'Пётр',
  );
  await dialog.getByRole('button', { name: 'Изменить', exact: true }).click();
  await expect(dialog.getByLabel('Имя', { exact: true })).toHaveValue('Пётр');
});
