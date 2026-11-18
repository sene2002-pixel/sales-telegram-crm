import { expect, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

const longCompany = 'Североуральская электротехническая компания промышленного оборудования';
const companyNames = Array.from(
  { length: 52 },
  (_, i) => ['ООО «Север»', longCompany][i] ?? 'Партнёр ' + String(i + 1).padStart(2, '0'),
);
const rows = Array.from({ length: 52 }, (_, index) => ({
  id: String(index + 1),
  name: (index % 2 ? 'Денис Громов ' : 'Марина Лесная ') + String(index + 1).padStart(2, '0'),
  role: index === 0 ? 'admin' : index % 3 ? 'manager' : 'supervisor',
  active: true,
  companies: index,
  openTasks: 52 - index,
  overdue: index % 11,
  completed: index + 2,
  interactions: index % 7,
  inactiveCompanies: companyNames
    .slice(index * 2, index * 2 + 2)
    .map((name, i) => ({ id: `company-${index}-${i}`, name })),
}));

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('**/api/me', (route) =>
    route.fulfill({ json: { ...rows[0], telegramId: '90001' } }),
  );
  await page.route('**/api/dashboard?*', (route) => route.fulfill({ json: rows }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await navigate(page, 'Команда');
});

test('Team metrics paginate, filter and sort the complete roster', async ({ page }, info) => {
  const region = page.getByRole('region', { name: 'Показатели команды' });
  const people = region.getByRole('rowheader');
  const size = region.getByRole('combobox', { name: 'Строк на странице' });
  const next = region.getByRole('button', { name: 'Следующая страница' });
  const previous = region.getByRole('button', { name: 'Предыдущая страница' });
  const search = region.getByRole('searchbox', { name: 'Имя, фамилия или роль' });

  await expect(people).toHaveCount(5);
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(people.first()).toContainText(rows[5].name);
  for (const length of [10, 25, 50]) {
    await size.selectOption(String(length));
    await expect(people).toHaveCount(length);
    if (info.project.name === 'mobile')
      await expect(people.first()).toBeInViewport({ ratio: 0.75 });
    await expect(previous).toBeDisabled();
    await next.click();
    if (info.project.name === 'mobile')
      await expect(people.first()).toBeInViewport({ ratio: 0.75 });
  }
  await expect(people).toHaveCount(2);
  await expect(next).toBeDisabled();

  await search.fill('52 громов');
  await expect(people).toHaveCount(1);
  await expect(people.first()).toContainText('Денис Громов 52');
  await search.fill('МЕНЕДЖЕР лесная');
  await expect(people).toHaveCount(
    rows.filter((r) => r.role === 'manager' && r.name.includes('Лесная')).length,
  );
  await region.getByRole('combobox', { name: 'Роль сотрудника' }).selectOption('supervisor');
  await expect(people).toHaveCount(0);
  await expect(
    page.getByRole('table', { name: 'Нет контакта 14 дней' }).getByText('Север', { exact: true }),
  ).toBeVisible();
  await search.fill('');
  await region.getByRole('combobox', { name: 'Роль сотрудника' }).selectOption('');
  await size.selectOption('5');
  await next.click();
  await region.getByRole('combobox', { name: 'Сортировка' }).selectOption('companies');
  await expect(previous).toBeDisabled();
  await expect(people.first()).toContainText(rows[51].name);
  await region.getByRole('button', { name: /Сначала больше/ }).click();
  await expect(people.first()).toContainText(rows[0].name);

  await region.scrollIntoViewIfNeeded();
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  }
  await region.screenshot({ path: info.outputPath('team-metrics.png') });
});

test('Team CSV uses the same criteria in the browser, Telegram download and bot', async ({
  page,
}) => {
  const region = page.getByRole('region', { name: 'Показатели команды' });
  const exportButton = region.getByRole('button', { name: 'Экспорт CSV', exact: true });
  await region.getByRole('searchbox', { name: 'Имя, фамилия или роль' }).fill('Лесная');
  await region.getByRole('combobox', { name: 'Роль сотрудника' }).selectOption('manager');
  await region.getByRole('combobox', { name: 'Сортировка' }).selectOption('completed');
  await region.getByRole('button', { name: 'Следующая страница' }).click();
  const criteria = { q: 'Лесная', role: 'manager', sort: 'completed', direction: 'desc' };

  await page.route('**/api/dashboard/export?*', (r) =>
    r.fulfill({ contentType: 'text/csv', body: 'CSV' }),
  );
  const browserRequest = page.waitForRequest('**/api/dashboard/export?*');
  await exportButton.click();
  const parameters = new URL((await browserRequest).url()).searchParams;
  expect(Object.fromEntries(parameters)).toEqual({
    ...criteria,
    from: expect.any(String),
    to: expect.any(String),
  });

  await page.evaluate(() => {
    window.Telegram = {
      WebApp: {
        initData: 'test',
        ready() {},
        expand() {},
        isVersionAtLeast: () => true,
        downloadFile() {},
      },
    };
  });
  await page.route('**/api/dashboard/export-link', (r) =>
    r.fulfill({ json: { filename: 'team.csv', url: 'https://crm.example.test/reports/team.csv' } }),
  );
  const linkRequest = page.waitForRequest('**/api/dashboard/export-link');
  await exportButton.click();
  expect((await linkRequest).postDataJSON()).toEqual(Object.fromEntries(parameters));
  await page.route('**/api/dashboard/export-bot', (r) => r.fulfill({ json: { sent: true } }));
  const botRequest = page.waitForRequest('**/api/dashboard/export-bot');
  await region.getByRole('button', { name: 'Получить CSV в боте' }).click();
  expect((await botRequest).postDataJSON()).toEqual(Object.fromEntries(parameters));
});

test('Inactive companies have independent pages of 5, 10, 25 or 50 companies', async ({
  page,
}, info) => {
  const inactive = page.getByRole('region', { name: 'Нет контакта 14 дней', exact: true });
  const table = inactive.getByRole('table', { name: 'Нет контакта 14 дней' });
  const companies = table.locator('tbody').getByRole('row');
  const size = inactive.getByRole('combobox', { name: 'Строк на странице' });
  const previous = inactive.getByRole('button', { name: 'Предыдущая страница' });
  const next = inactive.getByRole('button', { name: 'Следующая страница' });
  const metrics = page.getByRole('region', { name: 'Показатели команды' });

  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  await expect(table.getByRole('columnheader')).toHaveText(['Компания', 'Ответственный']);
  await expect(size).toHaveValue('5');
  await expect(companies).toHaveCount(5);
  await expect(companies.first()).toContainText('Север');
  await expect(companies.first()).toContainText(rows[0].name);
  await expect(companies.nth(1)).toContainText(longCompany);
  await expect(previous).toBeDisabled();
  if (info.project.name === 'mobile')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  await inactive.screenshot({ path: info.outputPath('inactive-companies.png') });

  await metrics.getByRole('button', { name: 'Следующая страница' }).click();
  const firstEmployee = metrics.getByRole('rowheader').first();
  await expect(firstEmployee).toContainText(rows[5].name);
  await next.click();
  await expect(companies.first()).toContainText(companyNames[5]);
  await expect(companies.first()).toContainText(rows[2].name);
  await previous.click();
  await expect(companies.first()).toContainText('Север');
  for (const count of [10, 25, 50]) {
    await size.selectOption(String(count));
    await expect(companies).toHaveCount(count);
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(companies.first()).toContainText(companyNames[count]);
    if (info.project.name === 'mobile')
      await expect(companies.first()).toBeInViewport({ ratio: 0.75 });
  }
  await expect(companies).toHaveCount(2);
  await expect(next).toBeDisabled();
  await expect(inactive.getByText('51–52 из 52')).toBeVisible();
  await expect(firstEmployee).toContainText(rows[5].name);

  await metrics.getByRole('searchbox').fill('Нет такого сотрудника');
  await expect(metrics.getByText('Сотрудники не найдены')).toBeVisible();
  await expect(companies).toHaveCount(2);
  await expect(companies.last()).toContainText(companyNames[51]);
  await expect(companies.last()).toContainText(rows[25].name);
});

test('Inactive companies show an empty state without page controls', async ({ page }) => {
  await navigate(page, 'Главная');
  await page.route('**/api/dashboard?*', (route) =>
    route.fulfill({ json: rows.map((employee) => ({ ...employee, inactiveCompanies: [] })) }),
  );
  await navigate(page, 'Команда');
  const inactive = page.getByRole('region', { name: 'Нет контакта 14 дней', exact: true });
  await expect(inactive.getByText('Таких компаний нет.')).toBeVisible();
  await expect(inactive.getByRole('button')).toHaveCount(0);
  await expect(inactive.getByRole('combobox')).toHaveCount(0);
});
