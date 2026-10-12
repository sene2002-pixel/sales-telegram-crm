import { test, expect } from '@playwright/test';
import { prepareDemoAuth, navigate } from './helpers';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
});

test('Company labels shorten legal forms while search, editing and stored identity stay complete', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const request = async (path: string, data?: unknown) => {
    const r = await page.request.fetch('/api' + path, {
      method: data ? 'POST' : 'GET',
      data,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.ok()).toBeTruthy();
    return r.json();
  };
  const tag = `${info.project.name}-${Date.now()}`;
  const names = [
    [`Энергия-${tag}`, `ООО «Энергия-${tag}»`],
    [`Сеть-${tag}`, `Акционерное общество «Сеть-${tag}»`],
    [`Сервис-${tag}`, `«Сервис-${tag}», ООО`],
    [`Монтаж-${tag}`, `ООО «Монтаж-${tag}», ООО`],
  ];
  const companies: any[] = [];
  for (const [short, raw] of names)
    companies.push(
      await request('/companies', {
        name: raw,
        divisions: { lv: 1_000_000 },
        potential: 1_000_000,
      }),
    );
  const company = companies[0];
  await request(`/companies/${company.id}/records/project`, {
    data: { name: `ООО Проект-${tag}`, amount: 1_000_000 },
  });
  await request(`/companies/${company.id}/records/task`, {
    data: { text: `Задача-${tag}`, type: 'call', due: '2030-10-15' },
  });
  await page.reload();
  await navigate(page, 'Клиенты');
  for (const [short, raw] of names) {
    await page.getByLabel('Поиск компаний', { exact: true }).fill(raw);
    const row = page
      .locator('.pico-client-accordion')
      .filter({ has: page.locator('strong', { hasText: short }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.pico-client-row strong').first()).toHaveText(short);
  }
  await page.getByLabel('Поиск компаний', { exact: true }).fill(names[0][1]);
  const row = page
    .locator('.pico-client-accordion')
    .filter({ has: page.locator('strong', { hasText: names[0][0] }) });
  await row.locator('.pico-client-row').click();
  await row.getByRole('button', { name: 'Карточка клиента', exact: true }).click();
  const card = page.getByRole('dialog', { name: names[0][0], exact: true });
  await card.getByRole('button', { name: 'Редактировать компанию', exact: true }).click();
  await expect(card.getByLabel('Название', { exact: true })).toHaveValue(names[0][1]);
  await card.getByLabel('Город', { exact: true }).fill('Москва');
  await card.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  await expect(
    card.getByRole('button', { name: 'Редактировать компанию', exact: true }),
  ).toBeVisible();
  const detail = await request(`/companies/${company.id}`);
  expect(detail.company.name).toBe(names[0][1]);
  await card.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await navigate(page, 'Задачи');
  await page.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  const composer = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await composer
    .locator('.pico-picker-row')
    .filter({ hasText: 'Клиент' })
    .getByRole('button')
    .click();
  await composer.getByLabel('Поиск клиента', { exact: true }).fill(names[0][1]);
  await composer
    .locator('.pico-picker-list')
    .getByRole('button')
    .filter({ hasText: names[0][0] })
    .click();
  await expect(composer.locator('.pico-picker-value').filter({ hasText: names[0][0] })).toHaveText(
    names[0][0],
  );
  await composer.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByLabel('Поиск задач', { exact: true }).fill(names[0][1]);
  const task = page.locator('.pico-task-row').filter({ hasText: `Задача-${tag}` });
  await expect(task.locator('small').first()).toContainText(names[0][0]);
  await expect(task.locator('small').first()).not.toContainText('ООО');
  await navigate(page, 'Проекты');
  await page.getByLabel('Поиск проектов', { exact: true }).fill(names[0][1]);
  const project = page.locator('.pico-project-row').filter({ hasText: `ООО Проект-${tag}` });
  await expect(project.locator('summary > span > strong').first()).toHaveText(`ООО Проект-${tag}`);
  await expect(project.locator('summary small').first()).toHaveText(names[0][0]);
});
