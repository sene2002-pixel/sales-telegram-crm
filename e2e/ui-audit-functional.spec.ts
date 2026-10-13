import { openCompanySection } from './helpers';
import { createHmac } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { action, navigate, openCompany, prepareDemoAuth } from './helpers';
import { emptySales } from '../src/shared/sales';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '' }),
  );
});
async function api(page: Page, path: string, data?: unknown, method = 'POST') {
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const response = await page.request.fetch('/api' + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function login(page: Page, role = 'Менеджер') {
  await page.goto('/');
  await page.getByRole('button', { name: role, exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
}
async function isolatedActor(page: Page, role: string) {
  await login(page, 'Администратор');
  const name = `ИсходноеИмя-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const actor = await api(page, '/users', {
    telegramId: String(Date.now()) + String(Math.floor(Math.random() * 100)),
    name,
    role,
    active: true,
  });
  // This signs only the local test server's documented synthetic session key.
  const payload = Buffer.from(
    JSON.stringify({ sub: actor.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const token =
    payload +
    '.' +
    createHmac('sha256', 'e2e-local-secret-not-a-production-secret')
      .update(payload)
      .digest('base64url');
  await page.evaluate((value) => sessionStorage.setItem('crm-session', value), token);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: `Привет, ${name}!`, exact: true })).toBeVisible();
  return { ...actor, name };
}

test('UI audit: own identity and role update replace greeting and revoke administrative navigation immediately', async ({
  page,
}) => {
  const actor = await isolatedActor(page, 'admin');
  await navigate(page, 'Пользователи');
  await page.locator('.pico-user-row').filter({ hasText: actor.name }).click();
  const dialog = page.getByRole('dialog', { name: 'Пользователь', exact: true });
  const name = 'ОбновлённоеИмя-' + Date.now();
  await dialog.getByLabel('Имя сотрудника', { exact: true }).fill(name);
  await dialog.getByRole('combobox', { name: 'Роль', exact: true }).selectOption('manager');
  // The actual last-admin invariant is covered server-side; emulate its rejection without
  // disabling shared local demo administrators used by other independent browser tests.
  await page.route('**/api/users', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          json: { message: 'Нельзя отключить последнего администратора' },
        })
      : route.continue(),
  );
  await dialog.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('последнего администратора');
  await expect(dialog.getByLabel('Имя сотрудника', { exact: true })).toHaveValue(name);
  await expect(dialog.getByRole('combobox', { name: 'Роль', exact: true })).toHaveValue('manager');
  await page.unroute('**/api/users');
  await dialog.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const actual = await api(page, '/me', undefined, 'GET');
  expect(actual).toMatchObject({ name, role: 'manager' });
  await navigate(page, 'Главная');
  await page.screenshot({ path: test.info().outputPath('own-role-after-save.png') });
  await expect(page.getByRole('heading', { name: `Привет, ${name}!`, exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Управление пользователями', exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
  await expect(
    page.locator('.pico-more-menu').getByRole('button', { name: 'Пользователи', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('.pico-more-menu').getByRole('button', { name: 'Команда', exact: true }),
  ).toHaveCount(0);
});

test('UI audit: saved letter stays saved when refreshing fails and cannot submit a duplicate PDF', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  const company = await api(page, '/companies', { name: 'Аудит письма ' + Date.now() });
  await api(page, `/companies/${company.id}/records/contact`, {
    data: { name: 'Получатель', role: 'Директор' },
  });
  const signature = await api(page, '/me/letter-signatures', {
    lastName: 'Аудитов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  });
  await page.reload();
  await navigate(page, 'Клиенты');
  await openCompany(page, company.name);
  const composer = page.getByRole('dialog').locator('.letter-composer');
  await openCompanySection(page, 'actions');
  await composer.getByRole('button', { name: 'Создать письмо', exact: true }).click();
  await composer
    .getByLabel('Подтвердите отрасль компании')
    .selectOption({ label: 'Машиностроение/OEM' });
  await composer
    .getByRole('combobox', { name: 'Моя подпись', exact: true })
    .selectOption(signature.id);
  let postCalls = 0;
  await page.route(`**/api/companies/${company.id}/letters`, async (route) => {
    postCalls++;
    await route.fulfill({ json: {} });
  });
  await page.route(`**/api/companies/${company.id}`, async (route) => {
    if (postCalls > 0)
      await route.fulfill({
        status: 503,
        json: { message: 'Аудит: обновление списка недоступно' },
      });
    else await route.continue();
  });
  const generate = composer.getByRole('button', {
    name: 'Сформировать PDF и сохранить',
    exact: true,
  });
  await generate.click();
  await expect.poll(() => postCalls).toBe(1);
  await expect(composer.getByRole('alert')).toBeVisible();
  if (await generate.isVisible()) await generate.click();
  await page.screenshot({ path: test.info().outputPath('letter-saved-refresh-failure.png') });
  expect(postCalls).toBe(1);
  await expect(generate).toHaveCount(0);
  await expect(composer).toContainText('Письмо сохранено');
});

test('UI audit: logout erases privileged cached data before a different-role login whose refresh fails', async ({
  page,
}) => {
  await login(page, 'Администратор');
  const company = await api(page, '/companies', {
    name: 'Закрытые данные прежней сессии ' + Date.now(),
  });
  await page.reload();
  await navigate(page, 'Клиенты');
  await page.getByLabel('Поиск компаний', { exact: true }).fill(company.name);
  await expect(page.locator('.pico-client-row').filter({ hasText: company.name })).toBeVisible();
  if (await page.getByTitle('Выйти', { exact: true }).isVisible())
    await page.getByTitle('Выйти', { exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    await page
      .locator('.pico-more-menu')
      .getByRole('button', { name: 'Выйти', exact: true })
      .click();
  }
  await expect(page.getByRole('heading', { name: 'Pico', exact: true })).toBeVisible();
  for (const path of [
    '/api/companies',
    '/api/users',
    '/api/records/task',
    '/api/records/file',
    '/api/records/project',
    '/api/records/contact',
  ]) {
    await page.route('**' + path, (route) =>
      route.fulfill({ status: 503, json: { message: 'Аудит: обновление недоступно' } }),
    );
  }
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('обновление недоступно');
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const denied = await page.request.get(`/api/companies/${company.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(denied.status()).toBe(404);
  if (await page.locator('.app-shell').isVisible()) await navigate(page, 'Клиенты');
  await page.screenshot({ path: test.info().outputPath('role-switch-refresh-failed.png') });
  await expect(page.locator('.pico-client-row').filter({ hasText: company.name })).toHaveCount(0);
});

test('UI audit: additional menu closes on Escape and returns keyboard focus to its trigger', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const trigger = page.getByRole('button', { name: 'Дополнительное меню', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.pico-more-menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('heading', { name: /Привет/ }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

for (const role of ['Менеджер', 'Руководитель', 'Администратор']) {
  test(`UI audit: ${role} can reach every permitted route, help, refresh and logout`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page, role);
    for (const [label, heading] of [
      ['Клиенты', 'Клиенты'],
      ['Проекты', 'Проекты'],
      ['Задачи', 'Задачи'],
      ['Аналитика', 'Аналитика'],
      ['Отчёты', 'Отчёты'],
      ['Календарь', 'Календарь'],
      ['Файлы', 'Документы'],
      ['Мой профиль', 'Мой профиль'],
      ...(role !== 'Менеджер' ? [['Команда', 'Команда']] : []),
      ...(role === 'Администратор' ? [['Пользователи', 'Пользователи']] : []),
    ]) {
      await navigate(page, label!);
      await expect(page.getByRole('heading', { name: heading!, exact: true })).toBeVisible();
      if (label === 'Команда') {
        await expect(page.locator('.table-wrap tbody tr').first()).toBeVisible();
        const employees = page.getByRole('button', { name: 'Все сотрудники', exact: true });
        await employees.click();
        await expect(
          page.getByRole('region', { name: 'Все сотрудники', exact: true }),
        ).toBeVisible();
        await employees.click();
        await expect(page.getByRole('region', { name: 'Все сотрудники', exact: true })).toHaveCount(
          0,
        );
        const geometry = await page.evaluate(() => {
          const rect = (element: Element) => {
            const r = element.getBoundingClientRect(),
              style = getComputedStyle(element);
            return {
              tag: element.tagName,
              class: element.className,
              width: r.width,
              x: r.x,
              y: r.y,
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              display: style.display,
              minWidth: style.minWidth,
              overflowX: style.overflowX,
            };
          };
          return {
            viewport: innerWidth,
            root: rect(document.documentElement),
            body: rect(document.body),
            elements: Array.from(
              document.querySelectorAll(
                '.workspace, .pico-bottom-nav, .table-wrap, .panel, .employee-row',
              ),
            ).map(rect),
            bottomPoint: document
              .elementsFromPoint(40, innerHeight - 30)
              .map((element) => element.tagName + '.' + element.className),
          };
        });
        await test.info().attach('team-geometry', {
          body: JSON.stringify(geometry, null, 2),
          contentType: 'application/json',
        });
        await page.screenshot({ path: test.info().outputPath('team-route.png') });
        expect(geometry.root.scrollWidth).toBeLessThanOrEqual(geometry.root.clientWidth + 1);
      }
    }
    await navigate(page, 'Главная');
    await action(page, 'Права и помощь');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await action(page, 'Обновить');
    await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
    if (await page.getByTitle('Выйти', { exact: true }).isVisible())
      await page.getByTitle('Выйти', { exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
      await page
        .locator('.pico-more-menu')
        .getByRole('button', { name: 'Выйти', exact: true })
        .click();
    }
    await expect(page.getByRole('heading', { name: 'Pico', exact: true })).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('UI audit: signature edit failure retains input, retry persists, default and deletion confirmation work', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  const signature = await api(page, '/me/letter-signatures', {
    lastName: 'Аудитов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  });
  await navigate(page, 'Мой профиль');
  await page.getByRole('button', { name: 'Сделать по умолчанию', exact: true }).click();
  await expect(page.getByRole('button', { name: '✓ По умолчанию', exact: true })).toBeDisabled();
  expect(
    (await api(page, '/me/letter-signatures', undefined, 'GET')).find(
      (item: any) => item.id === signature.id,
    ).isDefault,
  ).toBe(true);
  await page.getByRole('button', { name: 'Редактировать подпись', exact: true }).click();
  await page.getByLabel('Фамилия', { exact: true }).fill('Изменённая');
  await page.route(`**/api/me/letter-signatures/${signature.id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, json: { message: 'Аудит: подпись временно недоступна' } })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('подпись временно недоступна');
  await expect(page.getByLabel('Фамилия', { exact: true })).toHaveValue('Изменённая');
  await page.unroute(`**/api/me/letter-signatures/${signature.id}`);
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Подпись сохранена');
  expect((await api(page, '/me/letter-signatures', undefined, 'GET'))[0].lastName).toBe(
    'Изменённая',
  );
  await page.getByRole('button', { name: 'Удалить подпись', exact: true }).click();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(await api(page, '/me/letter-signatures', undefined, 'GET')).toHaveLength(1);
  await page.getByRole('button', { name: 'Удалить подпись', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Подпись удалена');
  expect(await api(page, '/me/letter-signatures', undefined, 'GET')).toHaveLength(0);
});

test('UI audit: report submission failure retains text; successful retry queues once and clears composer', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  await navigate(page, 'Отчёты');
  const text = 'Аудит: обсудили проект, отправить предложение завтра';
  await page.getByRole('textbox', { name: 'Текст отчёта', exact: true }).fill(text);
  await page.route('**/api/reports', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 503, json: { message: 'Аудит: обработка временно недоступна' } })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Подготовить черновик', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('обработка временно недоступна');
  await expect(page.getByRole('textbox', { name: 'Текст отчёта', exact: true })).toHaveValue(text);
  await page.unroute('**/api/reports');
  await page.getByRole('button', { name: 'Подготовить черновик', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Текст отчёта', exact: true })).toHaveValue('');
  const reports = await api(page, '/reports', undefined, 'GET');
  expect(reports).toHaveLength(1);
  expect(reports[0].status).toBe('queued');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('UI audit: calendar month arrows and direct month selection remain consistent', async ({
  page,
}) => {
  await login(page);
  await navigate(page, 'Календарь');
  const month = page.getByLabel('Месяц', { exact: true });
  const initial = await month.inputValue();
  await page.getByRole('button', { name: 'Следующий месяц', exact: true }).click();
  await expect(month).not.toHaveValue(initial);
  await page.getByRole('button', { name: 'Предыдущий месяц', exact: true }).click();
  await expect(month).toHaveValue(initial);
  await month.fill('2027-02');
  await expect(page.locator('.pico-calendar .section-head')).toContainText('февраль 2027');
  expect(await page.locator('.calendar button').count()).toBe(28);
});

test('UI audit: global file download shows an API error and retries the real uploaded attachment', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  const company = await api(page, '/companies', {
    name: 'АудитФайлаСДлиннымНеразрывнымНазваниеКомпании'.repeat(4) + Date.now(),
  });
  const filename = 'audit-long-unbroken-file-name-'.repeat(5) + '.txt';
  await page.reload();
  await navigate(page, 'Клиенты');
  await openCompany(page, company.name);
  const detail = page.getByRole('dialog');
  await detail.getByRole('button', { name: 'Файлы', exact: true }).click();
  await detail.locator('input[type=file]').setInputFiles({
    name: filename,
    mimeType: 'text/plain',
    buffer: Buffer.from('Local isolated UI audit'),
  });
  await expect(detail.locator('.records')).toContainText(filename);
  await page.keyboard.press('Escape');
  await navigate(page, 'Файлы');
  const file = (await api(page, '/records/file', undefined, 'GET')).find(
    (item: any) => item.data.name === filename,
  );
  expect(file).toBeTruthy();
  await page.route(`**/api/files/${file.id}`, (route) =>
    route.fulfill({ status: 503, json: { message: 'Аудит: скачивание временно недоступно' } }),
  );
  await page.getByRole('button', { name: 'Скачать', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('скачивание временно недоступно');
  await expect(page.getByText(filename, { exact: true })).toBeVisible();
  await page.unroute(`**/api/files/${file.id}`);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await download.failure()).toBeNull();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  await navigate(page, 'Аналитика');
  await expect(page.getByRole('heading', { name: 'Аналитика', exact: true })).toBeVisible();
});

test('UI audit: deterministic report review edits rows, retains a rejected save and confirms once', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  const draft = {
    warnings: ['Проверьте сумму'],
    blocks: [
      {
        companyName: 'Локальный черновик',
        inn: null,
        city: 'Казань',
        segment: 'end_client',
        stage: 'dialogue',
        potential: 10,
        divisions: [{ key: 'lv', amount: 10 }],
        summary: 'Результат встречи',
        occurredOn: '2026-10-12',
        contacts: [{ name: 'Иван', role: null, phone: null, email: null }],
        tasks: [{ text: 'Отправить предложение', due: '2026-10-13' }],
        sales: emptySales(),
      },
    ],
  };
  let report: any = {
    id: 'audit-review',
    status: 'review',
    version: 1,
    createdAt: new Date().toISOString(),
    authorName: 'Аудит',
    transcript: 'Локальный исходный текст',
    draft,
    candidates: [[]],
    feedback: 'Локальная рекомендация',
  };
  let reject = true,
    confirms = 0;
  const writes: any[] = [];
  await page.route('**/api/reports', (route) => route.fulfill({ json: [report] }));
  await page.route('**/api/reports/audit-review', async (route) => {
    if (route.request().method() === 'PATCH') {
      writes.push(route.request().postDataJSON());
      if (reject)
        return route.fulfill({ status: 409, json: { message: 'Аудит: конфликт версии' } });
      report = {
        ...report,
        draft: route.request().postDataJSON().draft,
        version: report.version + 1,
      };
    }
    await route.fulfill({ json: report });
  });
  await page.route('**/api/reports/audit-review/confirm', async (route) => {
    confirms++;
    writes.push(route.request().postDataJSON());
    report = { ...report, status: 'saved', version: report.version + 1 };
    await route.fulfill({ json: report });
  });
  await navigate(page, 'Отчёты');
  await page.locator('.report-row').click();
  const dialog = page.getByRole('dialog', { name: 'Проверка отчёта', exact: true });
  await dialog.getByText('Исходная транскрипция', { exact: true }).click();
  await expect(dialog.getByText('Локальный исходный текст', { exact: true })).toBeVisible();
  await dialog.getByText('Исправить структурированные данные', { exact: true }).click();
  const json = dialog.getByRole('textbox', { name: 'JSON пяти блоков', exact: true });
  await json.fill('{');
  await dialog.getByRole('button', { name: 'Применить исправление', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Проверьте структуру');
  await json.fill(JSON.stringify(emptySales()));
  await dialog.getByRole('button', { name: 'Применить исправление', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog
    .getByRole('textbox', { name: 'Результат общения', exact: true })
    .fill('Изменённый результат');
  await dialog.getByRole('button', { name: '+ Направление', exact: true }).click();
  expect(await dialog.getByLabel('Сумма направления', { exact: true }).count()).toBe(2);
  await dialog.getByRole('button', { name: '×', exact: true }).nth(1).click();
  await dialog.getByRole('button', { name: '+ Контакт', exact: true }).click();
  await dialog.getByRole('button', { name: 'Убрать контакт', exact: true }).last().click();
  await dialog.getByRole('button', { name: '+ Задача', exact: true }).click();
  await dialog.getByRole('button', { name: '×', exact: true }).last().click();
  await dialog.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('конфликт версии');
  await expect(dialog.getByRole('textbox', { name: 'Результат общения', exact: true })).toHaveValue(
    'Изменённый результат',
  );
  reject = false;
  await dialog.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(writes[1].draft.blocks[0]).toMatchObject({ summary: 'Изменённый результат' });
  expect(writes[1].draft.blocks[0].contacts).toHaveLength(1);
  expect(writes[1].draft.blocks[0].tasks).toHaveLength(1);
  expect(writes[1].draft.blocks[0].divisions).toHaveLength(1);
  expect(
    await dialog.locator('.report-confirm-actions').evaluate((el) => getComputedStyle(el).position),
  ).toBe('static');
  await dialog.getByRole('button', { name: 'Подтвердить и сохранить', exact: true }).click();
  await expect(dialog).toContainText('Отчёт сохранён');
  await expect(
    dialog.getByRole('button', { name: 'Подтвердить и сохранить', exact: true }),
  ).toHaveCount(0);
  expect(confirms).toBe(1);
  expect(writes[2]).toMatchObject({ version: 2, companyIds: [null] });
});

test('UI audit: deterministic failed-report retry reports failure and closes only after successful acknowledgement', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  const report = {
    id: 'audit-failed',
    status: 'failed',
    version: 1,
    createdAt: new Date().toISOString(),
    authorName: 'Аудит',
    transcript: 'Локальный ошибочный отчёт',
    draft: null,
    candidates: [],
    feedback: '',
    error: 'Локальная ошибка обработки',
  };
  await page.route('**/api/reports', (route) => route.fulfill({ json: [report] }));
  await page.route('**/api/reports/audit-failed', (route) => route.fulfill({ json: report }));
  let reject = true,
    requests = 0;
  await page.route('**/api/reports/audit-failed/retry', (route) => {
    requests++;
    return route.fulfill(
      reject
        ? { status: 503, json: { message: 'Аудит: повтор недоступен' } }
        : { json: { ...report, status: 'queued' } },
    );
  });
  await navigate(page, 'Отчёты');
  await page.locator('.report-row').click();
  const dialog = page.getByRole('dialog', { name: 'Проверка отчёта', exact: true });
  await dialog.getByRole('button', { name: 'Повторить обработку', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('повтор недоступен');
  await expect(dialog).toBeVisible();
  reject = false;
  await dialog.getByRole('button', { name: 'Повторить обработку', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toBe(2);
});

test('UI audit: revoking own access immediately clears the account and cached client data', async ({
  page,
}) => {
  const actor = await isolatedActor(page, 'admin');
  const company = await api(page, '/companies', {
    name: 'Приватный клиент заблокированного администратора ' + Date.now(),
  });
  await page.reload();
  await navigate(page, 'Клиенты');
  await expect(page.locator('.pico-client-row').filter({ hasText: company.name })).toBeVisible();
  await navigate(page, 'Пользователи');
  await page.locator('.pico-user-row').filter({ hasText: actor.name }).click();
  const dialog = page.getByRole('dialog', { name: 'Пользователь', exact: true });
  await dialog.getByLabel('Доступ активен', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const denied = await page.request.get('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect([401, 403]).toContain(denied.status());
  await page.screenshot({ path: test.info().outputPath('own-access-revoked.png') });
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Pico', exact: true })).toBeVisible();
  await expect(page.locator('.pico-client-row').filter({ hasText: company.name })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('crm-session'))).toBeNull();
});

test('UI audit: commercial report validates dates and preserves selected manager through API failure and retry', async ({
  page,
}) => {
  const actor = await isolatedActor(page, 'admin');
  await navigate(page, 'Команда');
  await page.getByRole('button', { name: 'Коммерческий отчёт руководителю', exact: true }).click();
  const from = page.getByLabel('Период с', { exact: true });
  const to = page.getByLabel('Период по', { exact: true });
  const generate = page.getByRole('button', {
    name: 'Сформировать коммерческий отчёт',
    exact: true,
  });
  await from.fill('2026-10-20');
  await to.fill('2026-10-12');
  await expect(generate).toBeDisabled();
  await from.fill('2026-10-01');
  await page
    .getByRole('combobox', { name: 'Данные менеджера', exact: true })
    .selectOption(actor.id);
  await expect(generate).toBeEnabled();
  const queries: string[] = [];
  await page.route('**/api/dashboard/commercial?*', (route) => {
    queries.push(route.request().url());
    return route.fulfill({
      status: 503,
      json: { message: 'Аудит: коммерческий отчёт недоступен' },
    });
  });
  await generate.click();
  await expect(page.getByRole('alert')).toContainText('коммерческий отчёт недоступен');
  await expect(from).toHaveValue('2026-10-01');
  await expect(to).toHaveValue('2026-10-12');
  await expect(page.getByRole('combobox', { name: 'Данные менеджера', exact: true })).toHaveValue(
    actor.id,
  );
  const sent = new URL(queries[0]);
  expect(Object.fromEntries(sent.searchParams)).toEqual({
    from: '2026-10-01',
    to: '2026-10-12',
    authorId: actor.id,
  });
  await page.unroute('**/api/dashboard/commercial?*');
  await generate.click();
  await expect(page.locator('.commercial-report')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Коммерческий отчёт руководителю', exact: true }).click();
  await expect(from).toHaveCount(0);
});

test('UI audit: legacy project and task edits persist; contact deletion cancel and confirm affect only the selected record', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  const company = await api(page, '/companies', { name: 'Аудит старых форм ' + Date.now() });
  const contact = await api(page, `/companies/${company.id}/records/contact`, {
    data: { name: 'Удаляемый контакт', role: 'Директор' },
  });
  const project = await api(page, `/companies/${company.id}/records/project`, {
    data: { name: 'Первоначальный проект', amount: 1000 },
  });
  const task = await api(page, `/companies/${company.id}/records/task`, {
    projectId: project.id,
    data: {
      text: 'Первоначальная задача',
      type: 'call',
      time: '11:10',
      due: '2026-10-13',
      contactId: contact.id,
    },
  });
  await page.reload();
  await navigate(page, 'Клиенты');
  await openCompany(page, company.name);
  const detail = page.getByRole('dialog');
  await detail.getByRole('button', { name: 'Проекты', exact: true }).click();
  await detail.getByRole('button', { name: 'Изменить', exact: true }).click();
  await detail.getByLabel('Название проекта', { exact: true }).fill('Изменённый старый проект');
  await detail.getByRole('button', { name: 'Сохранить проект', exact: true }).click();
  await expect(detail.locator('.records')).toContainText('Изменённый старый проект');
  await detail.getByRole('button', { name: 'Задачи', exact: true }).click();
  await detail.getByRole('button', { name: 'Изменить', exact: true }).click();
  await detail
    .getByRole('textbox', { name: 'Задача', exact: true })
    .fill('Изменённая старая задача');
  await detail.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  await expect(detail.locator('.records')).toContainText('Изменённая старая задача');
  await detail.getByRole('button', { name: 'Контакты', exact: true }).click();
  await detail.getByRole('button', { name: 'Удалить контакт', exact: true }).click();
  await detail.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(
    (await api(page, `/companies/${company.id}`, undefined, 'GET')).records.some(
      (r: any) => r.id === contact.id,
    ),
  ).toBe(true);
  await detail.getByRole('button', { name: 'Удалить контакт', exact: true }).click();
  await detail.getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
  await expect(detail.locator('.records')).not.toContainText('Удаляемый контакт');
  await page.reload();
  const saved = (await api(page, `/companies/${company.id}`, undefined, 'GET')).records;
  expect(saved.some((r: any) => r.id === contact.id)).toBe(false);
  expect(saved.find((r: any) => r.id === project.id).data.name).toBe('Изменённый старый проект');
  expect(saved.find((r: any) => r.id === task.id).data).toMatchObject({
    text: 'Изменённая старая задача',
    type: 'call',
    time: '11:10',
    contactId: contact.id,
  });
});

test('UI audit: task detail and Home inline deletion accept native confirmation and persist after reload', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  const company = await api(page, '/companies', { name: 'Аудит удаления задач ' + Date.now() });
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const first = await api(page, `/companies/${company.id}/records/task`, {
    data: { text: 'Удаление из деталей', due: today, type: 'call' },
  });
  const second = await api(page, `/companies/${company.id}/records/task`, {
    data: { text: 'Удаление с главной', due: today, type: 'reminder' },
  });
  await page.reload();
  await navigate(page, 'Задачи');
  const row = page.locator('.pico-task-row').filter({ hasText: 'Удаление из деталей' });
  await row.locator('button.task-text').click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Открыть клиента', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(company.name);
  await page.keyboard.press('Escape');
  await row.locator('button.task-text').click();
  page.once('dialog', (native) => native.accept());
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Удалить задачу', exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await navigate(page, 'Главная');
  const home = page.locator('.pico-task-row').filter({ hasText: 'Удаление с главной' });
  await home.locator('button.task-text').click();
  page.once('dialog', (native) => native.accept());
  await home.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(home).toHaveCount(0);
  await page.reload();
  const records = (await api(page, `/companies/${company.id}`, undefined, 'GET')).records;
  expect(records.some((r: any) => [first.id, second.id].includes(r.id))).toBe(false);
  await expect(page.locator('.pico-task-row')).toHaveCount(0);
});

test('UI audit: equipment removal and participant down/drag/delete persist with recalculated total and client handoff', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  const companies = [];
  for (const letter of ['A', 'B', 'C'])
    companies.push(await api(page, '/companies', { name: `Участник${letter}-${Date.now()}` }));
  const company = companies[0];
  const project = await api(page, `/companies/${company.id}/records/project`, {
    data: {
      name: 'Редактирование состава проекта',
      amount: 3000000,
      equipment: [
        { division: 'lv', name: 'Удаляемое НКУ', amount: 1000000 },
        { division: 'mv', name: 'Оставляемое КРУ', amount: 2000000 },
      ],
      participants: companies.map((c, i) => ({
        companyId: c.id,
        role: ['Заказчик', 'Генподрядчик', 'Подрядчик'][i],
        contactId: null,
        currentTask: '',
        nextStep: '',
      })),
    },
  });
  await page.reload();
  await navigate(page, 'Проекты');
  const row = page
    .locator('.pico-project-row')
    .filter({ hasText: 'Редактирование состава проекта' });
  await row.locator(':scope > summary').click();
  await row.getByRole('button', { name: 'Изменить проект', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Изменить проект', exact: true });
  await form
    .getByRole('button', { name: 'Убрать оборудование Удаляемое НКУ', exact: true })
    .click();
  await expect(form).toContainText('Итого: 2 млн ₽');
  const participants = form.locator('.pico-participant-entry');
  await participants
    .first()
    .getByRole('button', { name: 'Переместить участника ниже', exact: true })
    .click();
  await expect(participants.first()).toContainText(companies[1].name);
  await participants.last().dragTo(participants.first());
  await expect(participants.first()).toContainText(companies[2].name);
  await participants.first().getByRole('button', { name: 'Убрать участника', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить участника?', exact: true });
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(participants).toHaveCount(3);
  await participants.first().getByRole('button', { name: 'Убрать участника', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
  await expect(participants).toHaveCount(2);
  await form.getByRole('button', { name: 'Сохранить проект', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.reload();
  const saved = (await api(page, `/companies/${company.id}`, undefined, 'GET')).records.find(
    (r: any) => r.id === project.id,
  );
  expect(saved.data.amount).toBe(2000000);
  expect(saved.data.equipment).toEqual([
    { division: 'mv', name: 'Оставляемое КРУ', amount: 2000000 },
  ]);
  expect(saved.data.participants.map((p: any) => p.companyId)).toEqual([
    companies[1].id,
    companies[0].id,
  ]);
  await navigate(page, 'Проекты');
  await row.locator(':scope > summary').click();
  await row.getByRole('button', { name: `Открыть клиента · ${company.name}`, exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(company.name);
});

test('UI audit: deterministic voice draft rejection retains the draft on error and removes it without saving a signature', async ({
  page,
}) => {
  await isolatedActor(page, 'manager');
  let removed = false,
    reject = true,
    deletes = 0;
  const data = {
    lastName: 'Голосов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  await page.route('**/api/me/signature-drafts', (route) =>
    route.fulfill({
      json: removed
        ? []
        : [{ id: 'audit-voice', data, transcript: 'Локальный голосовой черновик' }],
    }),
  );
  await page.route('**/api/me/signature-drafts/audit-voice', (route) => {
    expect(route.request().method()).toBe('DELETE');
    deletes++;
    if (reject)
      return route.fulfill({ status: 503, json: { message: 'Аудит: отклонение недоступно' } });
    removed = true;
    return route.fulfill({ json: { deleted: true } });
  });
  await navigate(page, 'Мой профиль');
  const remove = page.getByRole('button', { name: 'Отклонить черновик', exact: true });
  await remove.click();
  await expect(page.getByRole('alert')).toContainText('отклонение недоступно');
  await expect(remove).toBeEnabled();
  reject = false;
  await remove.click();
  await expect(remove).toHaveCount(0);
  expect(deletes).toBe(2);
  expect(await api(page, '/me/letter-signatures', undefined, 'GET')).toHaveLength(0);
  await page.reload();
  await navigate(page, 'Мой профиль');
  await expect(
    page.getByRole('button', { name: 'Проверить голосовую подпись', exact: true }),
  ).toHaveCount(0);
});

test('UI polish: compact client disclosure, Russian upload status and readable audit preserve real actions', async ({
  page,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await isolatedActor(page, 'manager');
  const company = await api(page, '/companies', { name: 'Полировка ' + Date.now() });
  await api(page, `/companies/${company.id}/records/contact`, {
    data: { name: 'Длинныйконтакт'.repeat(8), email: 'long'.repeat(20) + '@example.test' },
  });
  await page.reload();
  await navigate(page, 'Клиенты');
  await openCompany(page, company.name);
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.company-detail-summary')).not.toHaveAttribute('open');
  await expect(dialog.locator('.company-detail-actions')).not.toHaveAttribute('open');
  const tabBounds = await dialog.locator('.company-detail-tabs button').evaluateAll((elements) =>
    elements.map((el) => {
      const box = el.getBoundingClientRect();
      const parent = el.parentElement!.getBoundingClientRect();
      return (
        box.left >= parent.left - 1 &&
        box.right <= parent.right + 1 &&
        box.height >= 36 &&
        el.scrollWidth <= el.clientWidth + 1
      );
    }),
  );
  expect(tabBounds).toHaveLength(6);
  expect(tabBounds.every(Boolean)).toBeTruthy();
  if (info.project.name === 'desktop') {
    const rows = await dialog
      .locator('.company-detail-tabs button')
      .evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().top));
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(1);
  }
  await expect(dialog.getByRole('button', { name: 'Контакты', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Контакты', exact: true }).click();
  const textBounds = await dialog
    .locator('.company-record-title, .company-contact-values')
    .evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        const p = el.closest('article')!.getBoundingClientRect();
        return { fits: r.right <= p.right + 1, scrollFits: el.scrollWidth <= el.clientWidth + 1 };
      }),
    );
  expect(textBounds.length).toBeGreaterThan(0);
  expect(textBounds.every((value) => value.fits && value.scrollFits)).toBeTruthy();
  await openCompanySection(page, 'actions');
  await expect(
    dialog.getByRole('button', { name: 'Редактировать компанию', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Удалить компанию', exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByLabel('Передать компанию')).toHaveCount(0);
  await dialog.locator('.company-detail-actions > summary').click();
  await expect(
    dialog.getByRole('button', { name: 'Редактировать компанию', exact: true }),
  ).toBeHidden();
  await dialog.getByRole('button', { name: 'Файлы', exact: true }).click();
  await expect(dialog.locator('.pico-file-picker-name')).toHaveText('Файл не выбран');
  await expect(dialog.locator('.pico-file-picker-button')).toContainText('Выбрать файл');
  const filename = 'Документ-проверки.txt';
  await dialog.getByLabel('Загрузить файл · до 10 МБ', { exact: true }).setInputFiles({
    name: filename,
    mimeType: 'text/plain',
    buffer: Buffer.from('Local presentation regression'),
  });
  await expect(dialog.locator('.pico-file-picker-name')).toHaveText(filename);
  await expect(dialog.locator('.records')).toContainText(filename);
  const persisted = await api(page, `/companies/${company.id}`, undefined, 'GET');
  expect(
    persisted.records.some(
      (record: any) => record.kind === 'file' && record.data.name === filename,
    ),
  ).toBeTruthy();
  await dialog.getByRole('button', { name: 'Изменения', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('Клиент добавлен');
  await expect(dialog.locator('.records')).toContainText('Файл добавлен');
  const titles = await dialog.locator('.records article > strong').allTextContents();
  expect(titles.every((title) => !/\b[a-z]+\.[a-z_]+\b/.test(title))).toBeTruthy();
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await navigate(page, 'Мой профиль');
  const profileTitle = page.getByRole('heading', { name: 'Мой профиль', exact: true });
  await expect(profileTitle).toBeVisible();
  const position = await profileTitle.boundingBox();
  expect(position!.y).toBeLessThan(180);
});

test('UI audit: restored session never restores an actor after the second authoritative identity read denies access', async ({
  page,
}) => {
  await isolatedActor(page, 'supervisor');
  let calls = 0;
  await page.route('**/api/me', async (route) => {
    calls++;
    if (calls === 1) await route.continue();
    else
      await route.fulfill({ status: 403, json: { message: 'Локальный отзыв доступа при старте' } });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Администратор', exact: true })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Локальный отзыв доступа');
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => sessionStorage.getItem('crm-session'))).toBeNull();
  await expect(
    page.locator('.pico-client-accordion, .pico-task-row, .pico-scoped-content'),
  ).toHaveCount(0);
});
