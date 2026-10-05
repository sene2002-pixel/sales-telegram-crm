import { test, expect, Page } from '@playwright/test';
import { emptyDeal, emptySales, Fact } from '../src/shared/sales';
const fact = <T>(value: T): Fact<T> => ({ value, certainty: 'confirmed' });
async function api(page: Page, path: string, body: unknown) {
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const r = await page.request.post('/api' + path, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
});
test('SALES-UI-01 five blocks, accessible six-point indicator and dated history', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Клиенты и компании' })).toBeVisible();
  const name = `Sales UI ${Date.now()} ${info.project.name}`;
  const c = await api(page, '/companies', { name, city: 'Москва', segment: 'design_institute' });
  const s = emptySales(),
    d = emptyDeal('Поставка А');
  d.endCustomer = 'Завод';
  d.direction = 'lv';
  d.amount = fact(7000000);
  d.volume = fact('in_work');
  d.equipment = fact('Выключатели');
  d.budget = fact(true);
  d.decisionMaker = fact('Иван');
  d.directAccess = fact(true);
  d.quoteSent = fact(true);
  d.approvalConditions = fact('Аудит');
  d.criteria = fact('Надёжность');
  s.deals = [d];
  s.additionalNeeds = [
    {
      direction: 'heat',
      description: 'Тепловая завеса',
      amount: fact(200000),
      vendor: fact('Hintek'),
      on: '2026-10-01',
    },
  ];
  await api(page, `/companies/${c.id}/records/activity`, {
    data: { text: 'Подтверждённый результат', occurredOn: '2026-10-01', sales: s },
  });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.getByRole('textbox', { name: 'Поиск компаний' }).fill(name);
  await page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog.getByRole('region', { name: 'Пять блоков CRM' })).toBeVisible();
  for (const h of [
    '1. Клиент',
    '2. Годовой потенциал по направлениям',
    '3. Сделки / проекты',
    '4. Дополнительные потребности',
    '5. Договорённости и следующий шаг',
  ])
    await expect(dialog.getByRole('heading', { name: h, exact: true })).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Оценка сделки 6 из 6' })).toBeVisible();
  await expect(dialog).toContainText('Проектный институт');
  await expect(dialog).toContainText('Hintek');
  await dialog.getByText('История пяти блоков (1)', { exact: true }).click();
  await expect(dialog).toContainText('2026-10-01');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('sales-card.png') });
});
test('SALES-UI-02 leader commercial report period and empty state', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Руководитель', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Команда' }).click();
  await page.getByRole('button', { name: 'Коммерческий отчёт руководителю', exact: true }).click();
  await page.getByLabel('Период с', { exact: true }).fill('2020-01-01');
  await page.getByLabel('Период по', { exact: true }).fill('2020-01-02');
  await page.getByRole('button', { name: 'Сформировать коммерческий отчёт', exact: true }).click();
  await expect(page.locator('.commercial-report')).toContainText(
    'Нет структурированных коммерческих данных за период',
  );
  await expect(page.locator('.commercial-report')).toContainText(
    'Подтверждённый объём сделок: 0 руб.',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('commercial-report.png') });
});
