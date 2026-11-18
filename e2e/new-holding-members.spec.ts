import { expect, test } from '@playwright/test';
import { Company, companySchema, validInn } from '../src/shared/contracts';
import { clients, prepareDemoAuth } from './helpers';

test('holding membership stays a draft until the form saves successfully', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await clients(page);
  const session = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: 'Bearer ' + session };
  const suffix = Date.now().toString();
  const name = 'Холдинг ' + suffix;
  const prefix = suffix.slice(-9);
  const child = {
    name: 'Юрлицо ' + suffix,
    city: 'Омск',
    inn: Array.from('0123456789', (digit) => prefix + digit).find(validInn)!,
  };
  const existingResponse = await page.request.post('/api/companies', {
    headers,
    data: { name: 'Заказчик ' + suffix, city: 'Тверь', segment: 'end_client' },
  });
  expect(existingResponse.ok()).toBeTruthy();
  const existing: Company = await existingResponse.json();
  const requests: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/companies'))
      requests.push(request.postDataJSON());
  });
  await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый клиент' });
  await dialog.getByLabel('Название', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Холдинг', exact: true }).click();
  const members = dialog.getByRole('region', { name: 'Компании холдинга' });
  await expect(dialog.getByLabel('ИНН', { exact: true })).toBeVisible();
  await members.getByRole('button', { name: 'Добавить компанию' }).click();
  await members.getByLabel('Поиск клиента').fill(existing.name);
  await members.getByRole('button', { name: new RegExp(existing.name) }).click();
  await expect(members.getByRole('listitem')).toHaveCount(1);
  await members.getByRole('button', { name: 'Убрать ' + existing.name + ' из холдинга' }).click();
  await expect(members.getByRole('listitem')).toHaveCount(0);
  await members.getByRole('button', { name: 'Добавить компанию' }).click();
  await members.getByLabel('Поиск клиента').fill(existing.name);
  await members.getByRole('button', { name: new RegExp(existing.name) }).click();
  await members.getByRole('button', { name: 'Добавить компанию' }).click();
  await members.getByRole('button', { name: 'Создать по ИНН' }).click();
  await dialog.getByLabel('ИНН', { exact: true }).fill('123');
  await expect(members.getByLabel('ИНН компании', { exact: true })).toHaveValue('123');
  await members.getByRole('button', { name: 'Добавить в список' }).click();
  await expect(members.getByRole('alert')).toContainText('корректный ИНН');
  await members.getByLabel('ИНН компании', { exact: true }).fill(child.inn);
  await members.getByLabel('Название компании', { exact: true }).fill(child.name);
  await members.getByLabel('Город компании', { exact: true }).fill(child.city);
  await dialog.getByRole('button', { name: 'Сохранить клиента' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Добавьте компанию в список');
  await members.getByRole('button', { name: 'Добавить в список' }).click();
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Заказчик', exact: true }).click();
  await expect(members).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Холдинг', exact: true }).click();
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await members.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('holding-members.png') });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  expect(requests).toHaveLength(0);
  await page.route(
    '**/api/companies',
    (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 503, json: { message: 'Повторите сохранение' } })
        : route.continue(),
    { times: 1 },
  );
  const save = dialog.getByRole('button', { name: 'Сохранить клиента' });
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('Повторите сохранение');
  await expect(members.getByRole('listitem')).toHaveCount(2);
  const changed = await page.request.patch('/api/companies/' + existing.id, {
    headers,
    data: {
      version: existing.version,
      data: companySchema.strip().parse({ ...existing, city: 'Киров' }),
    },
  });
  expect(changed.ok()).toBeTruthy();
  const updated: Company = await changed.json();
  const refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && response.url().endsWith('/api/companies'),
  );
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('Карточка заказчика изменилась');
  await refreshed;
  await expect(members.getByRole('listitem').filter({ hasText: existing.name })).toContainText(
    'Карточка изменилась',
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await members.getByRole('button', { name: 'Убрать ' + existing.name + ' из холдинга' }).click();
  await members.getByRole('button', { name: 'Добавить компанию' }).click();
  await members.getByLabel('Поиск клиента').fill(existing.name);
  await members.getByRole('button', { name: new RegExp(existing.name) }).click();
  await expect(members.getByRole('listitem').filter({ hasText: updated.name })).toContainText(
    updated.city,
  );
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/companies'),
  );
  await save.click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  const holding: Company = await response.json();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(3);
  expect(requests[2]).toMatchObject({
    initialMembers: [child, { id: updated.id, version: updated.version }],
  });
  const list = await page.request.get('/api/companies', { headers });
  expect(list.ok()).toBeTruthy();
  const companies: Company[] = await list.json();
  expect(
    companies
      .filter((c) => c.holdingId === holding.id)
      .map((c) => c.name)
      .sort(),
  ).toEqual([existing.name, child.name].sort());
});
