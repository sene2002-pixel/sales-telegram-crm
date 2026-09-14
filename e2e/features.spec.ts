import { test, expect, Page } from '@playwright/test';

async function login(page: Page, role = 'Менеджер') {
  await page.goto('/');
  await page.getByRole('button', { name: role, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Клиенты и компании' })).toBeVisible();
}
async function api(page: Page, path: string, body?: unknown, method = 'POST') {
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const response = await page.request.fetch('/api' + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
const unique = () => `Тест ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
async function company(page: Page, name = unique(), extra: object = {}) {
  return api(page, '/companies', { name, ...extra });
}
async function reload(page: Page) {
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
}

for (const [role, team, access] of [
  ['Менеджер', false, false],
  ['Руководитель', true, false],
  ['Администратор', true, true],
] as const) {
  test(`[UI-01] ${role}: navigation, role guide and administrative controls`, async ({ page }) => {
    await login(page, role);
    await page.getByRole('button', { name: 'Права и помощь' }).click();
    const guide = page.getByRole('dialog', { name: 'Права и помощь' });
    await expect(guide).toContainText(`Ваша роль: ${role}`);
    await expect(
      guide.getByRole('heading', { name: 'Администратор: как добавить сотрудника' }),
    ).toBeVisible();
    await expect(guide).toContainText('Последнего активного администратора нельзя');
    await guide.getByRole('button', { name: 'Закрыть' }).click();
    const button = page.getByRole('navigation').getByRole('button', { name: 'Команда' });
    await expect(button).toHaveCount(team ? 1 : 0);
    if (team) {
      await button.click();
      await expect(page.getByRole('heading', { name: 'Доступ сотрудников' })).toHaveCount(
        access ? 1 : 0,
      );
      await expect(page.getByRole('button', { name: 'Экспорт CSV' })).toBeVisible();
    }
  });
}
test('[UI-02] search, city, segment, division and archive filters', async ({ page }) => {
  await login(page);
  const prefix = unique();
  await company(page, prefix + ' Москва', {
    city: 'Москва',
    segment: 'oem',
    divisions: { lv: 300 },
  });
  await company(page, prefix + ' Казань', {
    city: 'Казань',
    segment: 'contractor',
    divisions: { heat: 500 },
  });
  await company(page, prefix + ' Архив', { archived: true });
  await reload(page);
  await page.getByRole('textbox', { name: 'Поиск компаний' }).fill(prefix);
  await expect(page.locator('.company-card')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Все города' }).selectOption('Москва');
  await expect(page.locator('.company-card')).toHaveCount(1);
  await expect(page.locator('.company-card')).toContainText(prefix + ' Москва');
  await page.getByRole('combobox', { name: 'Все города' }).selectOption('');
  await page.getByRole('combobox', { name: 'Все сегменты' }).selectOption('contractor');
  await expect(page.locator('.company-card')).toContainText(prefix + ' Казань');
  await page.getByRole('combobox', { name: 'Все сегменты' }).selectOption('');
  await page.getByRole('combobox', { name: 'Все направления' }).selectOption('lv');
  await expect(page.locator('.company-card')).toContainText(prefix + ' Москва');
  await page.getByRole('combobox', { name: 'Все направления' }).selectOption('');
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await expect(page.locator('.company-card')).toHaveCount(1);
  await expect(page.locator('.company-card')).toContainText(prefix + ' Архив');
});
test('[UI-03] contact/project/history forms and protected file download/archive', async ({
  page,
}) => {
  await login(page);
  const c = await company(page);
  await reload(page);
  await page.getByRole('heading', { name: c.name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Контакты', exact: true }).click();
  await dialog.getByRole('button', { name: '+ Добавить' }).click();
  await dialog.getByLabel('Имя', { exact: true }).fill('Иван');
  await dialog.getByLabel('Email', { exact: true }).fill('ivan@example.com');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('ivan@example.com');
  await dialog.getByRole('button', { name: 'Изменить', exact: true }).click();
  await dialog.getByLabel('Имя', { exact: true }).fill('Пётр');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('Пётр');
  await dialog.getByRole('button', { name: 'Проекты', exact: true }).click();
  await dialog.getByRole('button', { name: '+ Добавить' }).click();
  await dialog.getByLabel('Название проекта').fill('Поставка');
  await dialog.getByLabel('Сумма, ₽').fill('1200');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('Поставка');
  await dialog.getByRole('button', { name: 'История', exact: true }).click();
  await dialog.getByRole('button', { name: '+ Добавить' }).click();
  await dialog.getByLabel('Результат общения').fill('Согласовали предложение');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('Согласовали предложение');
  await dialog.getByRole('button', { name: 'Файлы', exact: true }).click();
  await dialog.getByLabel('Категория').selectOption('catalog');
  await dialog
    .getByRole('combobox', { name: 'Проект', exact: true })
    .selectOption({ label: 'Поставка' });
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'proposal.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Предложение'),
  });
  await expect(dialog.locator('.records')).toContainText('proposal.txt');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('proposal.txt');
  await dialog.getByRole('button', { name: 'В архив', exact: true }).click();
  await expect(dialog.locator('.records')).not.toContainText('proposal.txt');
});
test('[UI-04] task filters, completion/reopening and calendar with undated tasks', async ({
  page,
}) => {
  await login(page);
  const c = await company(page);
  const title = unique();
  await api(page, `/companies/${c.id}/records/task`, {
    data: { text: title + ' просрочено', due: '2000-01-01' },
  });
  await api(page, `/companies/${c.id}/records/task`, { data: { text: title + ' без срока' } });
  await reload(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Задачи' }).click();
  await page.getByRole('button', { name: 'Просроченные', exact: true }).click();
  await expect(page.locator('.task-row').filter({ hasText: title + ' просрочено' })).toBeVisible();
  await expect(page.locator('.task-row').filter({ hasText: title + ' без срока' })).toHaveCount(0);
  await page
    .locator('.task-row')
    .filter({ hasText: title + ' просрочено' })
    .getByRole('button', { name: 'Выполнить задачу' })
    .click();
  await page.getByRole('button', { name: 'Выполненные', exact: true }).click();
  await page
    .locator('.task-row')
    .filter({ hasText: title + ' просрочено' })
    .getByRole('button', { name: 'Вернуть задачу' })
    .click();
  await page.getByRole('navigation').getByRole('button', { name: 'Календарь' }).click();
  await page.getByLabel('Месяц').fill('2000-01');
  await page
    .locator('.calendar')
    .getByRole('button')
    .filter({ has: page.locator('strong', { hasText: /^1$/ }) })
    .click();
  await expect(page.locator('.task-row').filter({ hasText: title + ' просрочено' })).toBeVisible();
  await expect(page.locator('.task-row').filter({ hasText: title + ' без срока' })).toBeVisible();
});
test('[UI-05] admin creates a user, changes role, blocks and restores access', async ({ page }) => {
  await login(page, 'Администратор');
  await page.getByRole('navigation').getByRole('button', { name: 'Команда' }).click();
  const name = unique(),
    telegramId = String(Date.now());
  await page.getByLabel('Telegram ID').fill(telegramId);
  await page.getByLabel('Имя сотрудника').fill(name);
  await page.getByRole('combobox', { name: 'Роль', exact: true }).selectOption('manager');
  await page.getByRole('button', { name: 'Сохранить сотрудника' }).click();
  await page.getByRole('button', { name: name + ' · активен', exact: true }).click();
  await page.getByRole('combobox', { name: 'Роль', exact: true }).selectOption('supervisor');
  await page.getByLabel('Доступ активен').uncheck();
  await page.getByRole('button', { name: 'Сохранить сотрудника' }).click();
  await page.getByRole('button', { name: name + ' · заблокирован', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Роль', exact: true })).toHaveValue('supervisor');
  await page.getByLabel('Доступ активен').check();
  await page.getByRole('button', { name: 'Сохранить сотрудника' }).click();
  await expect(page.getByRole('button', { name: name + ' · активен', exact: true })).toBeVisible();
});
test('[UI-06] supervisor assigns company and filters by owner', async ({ page }) => {
  await login(page, 'Руководитель');
  const c = await company(page);
  const manager = await page.request.post('/api/auth/dev', { data: { role: 'manager' } });
  expect(manager.ok()).toBeTruthy();
  const id = (await manager.json()).user.id;
  await reload(page);
  await page.getByRole('heading', { name: c.name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Передать компанию').selectOption(id);
  await dialog.getByRole('button', { name: 'Назначить', exact: true }).click();
  await expect(dialog).toContainText('Демо manager');
  await dialog.getByRole('button', { name: 'Изменения', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('company.assigned');
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByLabel('Ответственный', { exact: true }).selectOption(id);
  await page.getByLabel('Поиск компаний').fill(c.name);
  await expect(page.locator('.company-card')).toHaveCount(1);
});
test('[UI-07] text report is queued and cancellable without applying CRM records', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Отчёты' }).click();
  await page.getByLabel('Текст отчёта').fill(unique() + ' итог встречи');
  await page.getByRole('button', { name: 'Подготовить черновик' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('В очереди');
  await dialog.getByRole('button', { name: 'Отменить отчёт' }).click();
  await expect(dialog).toContainText('Отменён');
  await expect(dialog.getByRole('button', { name: 'Подтвердить и сохранить' })).toHaveCount(0);
});
