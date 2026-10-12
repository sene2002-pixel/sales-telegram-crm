import { prepareDemoAuth } from './helpers';
import { action, clients, navigate, openCompany } from './helpers';
import { test, expect, Page } from '@playwright/test';

test.beforeEach(async ({ page }) => prepareDemoAuth(page));

// These tests use local demo authentication, not the Telegram client SDK.
test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
});

// Reuse local test sessions instead of hitting the real auth rate limit for every scenario.
// Each role still exercises the UI login on its first use in this worker.
const roleTokens = new Map<string, string>();
async function login(page: Page, role = 'Менеджер') {
  const existing = roleTokens.get(role);
  if (existing)
    await page.addInitScript((token) => sessionStorage.setItem('crm-session', token), existing);
  await page.goto('/');
  if (!existing) await page.getByRole('button', { name: role, exact: true }).click();
  await clients(page);
  roleTokens.set(role, (await page.evaluate(() => sessionStorage.getItem('crm-session')))!);
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
  await action(page, 'Обновить');
}

for (const [role, team, access] of [
  ['Менеджер', false, false],
  ['Руководитель', true, false],
  ['Администратор', true, true],
] as const) {
  test(`[UI-01] ${role}: navigation, role guide and administrative controls`, async ({ page }) => {
    await login(page, role);
    await action(page, 'Права и помощь');
    const guide = page.getByRole('dialog', { name: 'Права и помощь' });
    await expect(guide).toContainText(`Ваша роль: ${role}`);
    await expect(
      guide.getByRole('heading', { name: 'Администратор: как добавить сотрудника' }),
    ).toBeVisible();
    await expect(guide).toContainText('Последнего активного администратора нельзя');
    await guide.getByRole('button', { name: 'Закрыть' }).click();
    const mobile = !(await page.locator('.pico-secondary-nav').isVisible());
    if (mobile)
      await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    const button = page
      .locator(mobile ? '.pico-more-menu' : '.pico-secondary-nav')
      .getByRole('button', { name: 'Команда', exact: true });
    await expect(button).toHaveCount(team ? 1 : 0);
    if (mobile)
      await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    if (team) {
      await navigate(page, 'Команда');
      await expect(page.locator('input[type="date"]')).toHaveCount(0);
      await expect(page.getByText('Текущий месяц · по сегодня', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Все сотрудники', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Все сотрудники' })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Добавить сотрудника', exact: true }),
      ).toHaveCount(access ? 1 : 0);
      if (!access)
        await expect(page.getByRole('button', { name: /^Редактировать / })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Доступ сотрудников' })).toHaveCount(
        access ? 1 : 0,
      );
      await expect(page.getByRole('button', { name: 'Экспорт CSV' })).toBeVisible();
    }
  });
}
test('[UI-02] search, city, segment, division and archive filters', async ({ page }) => {
  await login(page, 'Администратор');
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
  await expect(page.locator('.pico-client-accordion')).toHaveCount(2);
  await page.getByRole('button', { name: 'Фильтры клиентов' }).click();
  await page.getByRole('combobox', { name: 'Все города' }).selectOption('Москва');
  await expect(page.locator('.pico-client-accordion')).toHaveCount(1);
  await expect(page.locator('.pico-client-accordion')).toContainText(prefix + ' Москва');
  await page.getByRole('combobox', { name: 'Все города' }).selectOption('');
  await page
    .getByRole('group', { name: 'Категория клиента', exact: true })
    .getByRole('button', { name: 'Подрядчик', exact: true })
    .click();
  await expect(page.locator('.pico-client-accordion')).toContainText(prefix + ' Казань');
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await page
    .getByRole('group', { name: 'Оборудование', exact: true })
    .getByRole('button', { name: 'Выключатели 0,4 кВ', exact: true })
    .click();
  await expect(page.locator('.pico-client-accordion')).toContainText(prefix + ' Москва');
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await page.getByRole('button', { name: 'Архив компаний', exact: true }).click();
  await expect(page.locator('.pico-client-accordion')).toHaveCount(1);
  await expect(page.locator('.pico-client-accordion')).toContainText(prefix + ' Архив');
});
test('Company archive and restore buttons require confirmation and preserve contacts', async ({
  page,
}) => {
  await login(page, 'Администратор');
  const c = await company(page);
  await api(page, `/companies/${c.id}/records/contact`, { data: { name: 'Сохранённый контакт' } });
  await reload(page);
  await openCompany(page, c.name);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Удалить компанию', exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText('Контакты, задачи и файлы сохранятся');
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Удалить компанию', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Удалить компанию', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Восстановить компанию', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Фильтры клиентов' }).click();
  await page.getByRole('button', { name: 'Архив компаний', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Фильтры клиентов' })
    .getByRole('button', { name: /^Показать/ })
    .click();
  await openCompany(page, c.name);
  await dialog.getByRole('button', { name: 'Восстановить компанию', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Удалить компанию', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Контакты', exact: true }).click();
  await expect(dialog).toContainText('Сохранённый контакт');
});
test('Company archive controls are unavailable to managers', async ({ page }) => {
  await login(page);
  const c = await company(page);
  await reload(page);
  await openCompany(page, c.name);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Удалить компанию', exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole('button', { name: 'Редактировать компанию', exact: true }).click();
  await expect(dialog.getByLabel('В архиве', { exact: true })).toHaveCount(0);
});
test('[UI-03] contact/project/history forms and protected file download/archive', async ({
  page,
}) => {
  await login(page);
  const c = await company(page);
  await reload(page);
  await openCompany(page, c.name);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Контакты', exact: true }).click();
  await dialog.getByRole('button', { name: '+ Добавить' }).click();
  await dialog.getByLabel('Имя', { exact: true }).fill('Иван');
  await dialog.getByLabel('Email', { exact: true }).fill('ivan@example.com');
  await dialog.getByRole('button', { name: 'Сохранить контакт', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('ivan@example.com');
  await dialog.getByRole('button', { name: 'Изменить', exact: true }).click();
  await dialog.getByLabel('Имя', { exact: true }).fill('Пётр');
  await dialog.getByRole('button', { name: 'Сохранить контакт', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('Пётр');
  await dialog.getByRole('button', { name: 'Проекты', exact: true }).click();
  await dialog.getByRole('button', { name: '+ Добавить' }).click();
  await dialog.getByLabel('Название проекта').fill('Поставка');
  await dialog.getByText('Дополнительные поля', { exact: true }).click();
  await dialog.getByLabel('Сумма, ₽').fill('1200');
  await dialog.getByRole('button', { name: 'Сохранить проект', exact: true }).click();
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
  await navigate(page, 'Задачи');
  await page.getByRole('button', { name: 'Фильтры задач' }).click();
  await page.getByRole('button', { name: 'Просроченные', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Фильтры задач' })
    .getByRole('button', { name: /^Показать/ })
    .click();
  await expect(page.locator('.task-row').filter({ hasText: title + ' просрочено' })).toBeVisible();
  await expect(page.locator('.task-row').filter({ hasText: title + ' без срока' })).toHaveCount(0);
  await page
    .locator('.task-row')
    .filter({ hasText: title + ' просрочено' })
    .getByRole('button', { name: 'Выполнить задачу' })
    .click();
  await page.getByRole('button', { name: 'Фильтры задач' }).click();
  await page.getByRole('button', { name: 'Выполненные', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Фильтры задач' })
    .getByRole('button', { name: /^Показать/ })
    .click();
  await page
    .locator('.task-row')
    .filter({ hasText: title + ' просрочено' })
    .getByRole('button', { name: 'Вернуть задачу' })
    .click();
  await navigate(page, 'Календарь');
  await page.getByLabel('Месяц', { exact: true }).fill('2000-01');
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
  await navigate(page, 'Команда');
  const name = unique(),
    telegramId = String(Date.now());
  await expect(page.getByLabel('Telegram ID', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Добавить сотрудника', exact: true }).click();
  await page.getByLabel('Telegram ID', { exact: true }).fill(telegramId);
  await page.getByLabel('Имя сотрудника').fill(name);
  await page.getByRole('combobox', { name: 'Роль', exact: true }).selectOption('manager');
  await page.getByRole('button', { name: 'Создать сотрудника' }).click();
  await page.getByRole('button', { name: 'Редактировать ' + name, exact: true }).click();
  await expect(page.getByLabel('Telegram ID', { exact: true })).toHaveAttribute('readonly', '');
  await page.getByRole('combobox', { name: 'Роль', exact: true }).selectOption('supervisor');
  await page.getByLabel('Доступ активен').uncheck();
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.locator('.employee-row').filter({ hasText: name })).toContainText(
    'заблокирован',
  );
  await page.getByRole('button', { name: 'Редактировать ' + name, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Роль', exact: true })).toHaveValue('supervisor');
  await page.getByLabel('Доступ активен').check();
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.locator('.employee-row').filter({ hasText: name })).toContainText('активен');
  await page.getByRole('button', { name: 'Добавить сотрудника', exact: true }).click();
  await expect(page.getByLabel('Telegram ID', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Имя сотрудника')).toHaveValue('');
  await page.getByLabel('Telegram ID', { exact: true }).fill(telegramId);
  await page.getByLabel('Имя сотрудника').fill('Попытка дубля');
  await page.getByRole('button', { name: 'Создать сотрудника' }).click();
  await expect(page.getByRole('alert')).toContainText('уже существует');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByLabel('Telegram ID', { exact: true })).toHaveCount(0);
});
test('[UI-06] supervisor assigns company and filters by owner', async ({ page }) => {
  await login(page, 'Руководитель');
  const c = await company(page);
  const supervisor = await api(page, '/me', undefined, 'GET');
  const admin = await page.request.post('/api/auth/dev', { data: { role: 'admin' } });
  expect(admin.ok()).toBeTruthy();
  const adminToken = (await admin.json()).token;
  const managerName = `Тестовый менеджер ${Date.now()}`;
  const manager = await page.request.post('/api/users', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      telegramId: String(Date.now()),
      name: managerName,
      role: 'manager',
      active: true,
      supervisorId: supervisor.id,
    },
  });
  expect(manager.ok()).toBeTruthy();
  const id = (await manager.json()).id;
  await reload(page);
  await openCompany(page, c.name);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Передать компанию').selectOption(id);
  await dialog.getByRole('button', { name: 'Назначить', exact: true }).click();
  await expect(dialog).toContainText(managerName);
  await dialog.getByRole('button', { name: 'Изменения', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('company.assigned');
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: 'Фильтры клиентов' }).click();
  await page.getByLabel('Ответственный', { exact: true }).selectOption(id);
  await page
    .getByRole('dialog', { name: 'Фильтры клиентов' })
    .getByRole('button', { name: /^Показать/ })
    .click();
  await page.getByLabel('Поиск компаний').fill(c.name);
  await expect(page.locator('.pico-client-accordion')).toHaveCount(1);
});
test('[UI-07] text report is queued and cancellable without applying CRM records', async ({
  page,
}) => {
  await login(page);
  await navigate(page, 'Отчёты');
  await page.getByLabel('Текст отчёта').fill(unique() + ' итог встречи');
  await page.getByRole('button', { name: 'Подготовить черновик' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('В очереди');
  await dialog.getByRole('button', { name: 'Отменить отчёт' }).click();
  await expect(dialog).toContainText('Отменён');
  await expect(dialog.getByRole('button', { name: 'Подтвердить и сохранить' })).toHaveCount(0);
});

test('[UI-08] compact six-week calendar fits a narrow phone and keeps selection accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await login(page);
  await navigate(page, 'Календарь');
  await page.getByLabel('Месяц', { exact: true }).fill('2026-08');
  const calendar = page.locator('.calendar');
  await expect(calendar.getByRole('button')).toHaveCount(31);
  const box = await calendar.boundingBox();
  expect(box!.height).toBeLessThan(315);
  await calendar.getByRole('button', { name: '2026-08-31', exact: true }).click();
  await expect(calendar.getByRole('button', { name: '2026-08-31', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('compact-calendar.png') });
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click();
  await expect(page.getByLabel('Месяц', { exact: true })).toHaveValue(
    new Date().toISOString().slice(0, 7),
  );
});
