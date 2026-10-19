import { expect, Page, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
});

async function login(page: Page, role = 'Менеджер') {
  await page.goto('/');
  await page.getByRole('button', { name: role, exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
}

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

async function fixture(page: Page, name: string) {
  const company = await api(page, '/companies', {
    name,
    city: 'Москва',
    industry: 'Генерация',
    potential: 730_000_000,
    divisions: { lv: 210_000_000, mv: 200_000_000, heat: 320_000_000 },
    notes: 'Согласовать график поставки',
  });
  const contact = await api(page, `/companies/${company.id}/records/contact`, {
    data: { name: 'Иванов Сергей', role: 'Руководитель закупок', phone: '+79161234567' },
  });
  return { company, contact };
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(name + '.png') });
}

async function fullWidthAction(page: Page, name: string | RegExp) {
  const dialog = page.getByRole('dialog').last();
  const action = dialog.getByRole('button', { name, exact: true });
  const [box, sheet] = await Promise.all([action.boundingBox(), dialog.boundingBox()]);
  expect(box).not.toBeNull();
  expect(sheet).not.toBeNull();
  const padding = await dialog.evaluate((el) => {
    const style = getComputedStyle(el);
    return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  });
  expect(box!.width).toBeGreaterThanOrEqual(sheet!.width - padding - 2);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
}

test('Design fidelity: typed badges use distinct reference colors and money is compact', async ({
  page,
}, info) => {
  await login(page);
  const suffix = `${info.project.name}-${Date.now()}`;
  const { company } = await fixture(page, 'Интер РАО ' + suffix);
  const due = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  for (const type of ['call', 'meeting', 'email', 'reminder']) {
    await api(page, `/companies/${company.id}/records/task`, {
      data: { text: `${type} ${suffix}`, type, due, time: '12:00' },
    });
  }
  await page.reload();
  await navigate(page, 'Задачи');
  const colors: string[] = [];
  for (const type of ['call', 'meeting', 'email', 'reminder']) {
    const badge = page
      .locator('.task-row')
      .filter({ hasText: `${type} ${suffix}` })
      .locator('.checkbox');
    const [color, background] = await badge.evaluate((el) => [
      getComputedStyle(el).color,
      getComputedStyle(el).backgroundColor,
    ]);
    colors.push(color + '/' + background);
    const rgb = color.match(/\d+/g)!.map(Number);
    if (type === 'call') expect(rgb[1]).toBeGreaterThan(rgb[0]);
    if (type === 'meeting') expect(rgb[2]).toBeGreaterThan(rgb[1]);
    if (type === 'email') expect(rgb[2]).toBeGreaterThan(rgb[0]);
    if (type === 'reminder') expect(rgb[0]).toBeGreaterThan(rgb[2]);
  }
  expect(new Set(colors).size).toBe(4);
  await screenshot(page, 'typed-task-badges');
  await navigate(page, 'Клиенты');
  const row = page.locator('.pico-client-accordion').filter({ hasText: company.name });
  await expect(row).toContainText(/730\s*млн/);
  await row.locator('.pico-client-row').click();
  const sections = row.locator('.cc-section');
  await expect(sections).toHaveCount(5);
  const contacts = sections.filter({
    has: page.locator(':scope > summary', { hasText: /^Контакты/ }),
  });
  const potential = sections.filter({
    has: page.locator(':scope > summary', { hasText: /^Потенциал/ }),
  });
  await contacts.locator(':scope > summary').click();
  await expect(row).toContainText('Иванов Сергей');
  await expect(potential).toHaveAttribute('open', '');
  await expect(contacts).toHaveAttribute('open', '');
  const [above, below] = await Promise.all([potential.boundingBox(), contacts.boundingBox()]);
  expect(below!.y).toBeGreaterThanOrEqual(above!.y + above!.height - 1);
  for (const section of await sections.all()) {
    const header = await section.locator(':scope > summary').boundingBox();
    expect(header!.height).toBeGreaterThanOrEqual(46);
    expect(header!.x + header!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await contacts.locator(':scope > summary').click();
  await expect(potential).toHaveAttribute('open', '');
  await expect(contacts).not.toHaveAttribute('open', '');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await screenshot(page, 'client-independent-sections');
});

test('Design fidelity: period choices have ranges, cancel preserves data and apply spans sheet', async ({
  page,
}) => {
  await login(page);
  await fixture(page, 'Период ' + Date.now());
  await page.reload();
  await navigate(page, 'Аналитика');
  const trigger = page.getByRole('button', { name: 'Период аналитики', exact: true });
  await trigger.click();
  const period = page.getByRole('dialog', { name: 'Период', exact: true });
  await expect(period.getByRole('radio')).toHaveCount(6);
  await expect(period).toContainText(/\d+\s+\p{L}+\s*[—–]\s*\d+/u);
  await period.getByRole('radio', { name: /7 дней/ }).click();
  await screenshot(page, 'analytics-period-ranges');
  await period.getByRole('button', { name: /Закрыть|Отмена/ }).click();
  await expect(trigger).toContainText('Весь период');
  await trigger.click();
  await period.getByRole('radio', { name: /Свой период/ }).click();
  await period.getByLabel('Начало периода').fill('2026-01-01');
  await period.getByLabel('Конец периода').fill('2026-12-31');
  await fullWidthAction(page, 'Применить');
  await period.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(trigger).toContainText('Свой период');
});

test('Design fidelity: compact new forms keep core actions in viewport and task pickers preserve text', async ({
  page,
}, info) => {
  await login(page);
  const { company } = await fixture(page, `Компактный ${info.project.name}-${Date.now()}`);
  await page.reload();
  await navigate(page, 'Клиенты');
  await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Новый клиент', exact: true })
      .getByRole('group', { name: 'Категория клиента' }),
  ).toBeVisible();
  await fullWidthAction(page, 'Сохранить клиента');
  await screenshot(page, 'compact-client-create');
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await navigate(page, 'Проекты');
  await page.getByRole('button', { name: 'Добавить проект', exact: true }).click();
  await expect(page.getByLabel('Название проекта')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Добавить оборудование', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Добавить участника', exact: true })).toBeVisible();
  await fullWidthAction(page, 'Сохранить проект');
  await screenshot(page, 'compact-project-create');
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await navigate(page, 'Задачи');
  await page.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  const task = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  const text = task.getByRole('textbox', { name: 'Задача', exact: true });
  await expect(text).toHaveJSProperty('tagName', 'TEXTAREA');
  await text.fill('Согласовать спецификацию с клиентом');
  await task.getByRole('button', { name: 'Звонок', exact: true }).click();
  await expect(task.getByRole('button', { name: 'Звонок', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await fullWidthAction(page, 'Добавить задачу');
  await screenshot(page, 'compact-task-create');
  await task.locator('.pico-picker-row').filter({ hasText: 'Клиент' }).getByRole('button').click();
  await task.getByLabel('Поиск клиента').fill(company.name);
  await task
    .locator('.pico-picker-list')
    .getByRole('button')
    .filter({ hasText: company.name })
    .click();
  await expect(text).toHaveValue('Согласовать спецификацию с клиентом');
  await task.getByLabel('Время', { exact: true }).fill('10:00');
  await task.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  await expect(task).toHaveCount(0);
  const saved = await api(page, `/companies/${company.id}`, undefined, 'GET');
  expect(saved.records.find((r: any) => r.kind === 'task').data).toMatchObject({
    text: 'Согласовать спецификацию с клиентом',
    type: 'call',
    time: '10:00',
  });
});

test('Design fidelity: inline equipment editor saves split voltage without overwriting facts', async ({
  page,
}, info) => {
  await login(page);
  const { company } = await fixture(page, `Направление ${info.project.name}-${Date.now()}`);
  await page.reload();
  await navigate(page, 'Клиенты');
  const row = page.locator('.pico-client-accordion').filter({ hasText: company.name });
  await row.locator('.pico-client-row').click();
  await row.getByRole('button', { name: 'Добавить оборудование', exact: true }).click();
  const direction = row.locator('.cc-inline-editor');
  const selector = direction.getByRole('combobox', { name: 'Оборудование', exact: true });
  await expect(selector.getByRole('option')).toHaveCount(5);
  await selector.selectOption('drives_mv');
  await direction.getByRole('textbox', { name: 'Потенциал, ₽', exact: true }).fill('90000000');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await screenshot(page, 'client-new-equipment-inline');
  await direction.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(direction).toHaveCount(0);
  await page.reload();
  const saved = (await api(page, `/companies/${company.id}`, undefined, 'GET')).company;
  expect(saved.divisions).toMatchObject({
    lv: 210_000_000,
    mv: 200_000_000,
    heat: 320_000_000,
    drives_mv: 90_000_000,
  });
  expect(saved.notes).toBe('Согласовать график поставки');
});

test('Design fidelity: project supplies, services and participant edit/order persist with legacy equipment', async ({
  page,
}, info) => {
  await login(page);
  const suffix = `${info.project.name}-${Date.now()}`;
  const { company } = await fixture(page, 'Проект ' + suffix);
  const { company: second } = await fixture(page, 'Участник ' + suffix);
  const legacy = await api(page, `/companies/${company.id}/records/project`, {
    data: {
      name: 'Полный проект ' + suffix,
      amount: 3_000_000,
      equipment: [{ division: 'drives', name: 'Старая позиция', amount: 3_000_000 }],
    },
  });
  await page.reload();
  await navigate(page, 'Проекты');
  const row = page.locator('.pico-project-row').filter({ hasText: 'Полный проект ' + suffix });
  await row.locator(':scope > summary').click();
  await row.getByRole('button', { name: 'Изменить проект', exact: true }).click();
  const project = page.getByRole('dialog', { name: 'Изменить проект', exact: true });
  await project.getByRole('button', { name: 'Добавить оборудование', exact: true }).click();
  const equipment = page.getByRole('dialog', { name: 'Оборудование', exact: true });
  for (const [label, amount] of [
    ['ПЧ и УПП 0,4 кВ', '90'],
    ['ДГУ (ДЭС)', '2'],
    ['ПНР', '0.5'],
  ]) {
    await equipment.getByRole('button', { name: label, exact: true }).click();
    await equipment.getByLabel(`Сумма ${label}, млн ₽`).fill(amount);
  }
  await expect(
    equipment.getByRole('group', { name: 'Проектная поставка', exact: true }).getByRole('button'),
  ).toHaveCount(4);
  await expect(
    equipment.getByRole('group', { name: 'Услуги', exact: true }).getByRole('button'),
  ).toHaveCount(3);
  await screenshot(page, 'equipment-supply-service-chips');
  await equipment.getByRole('button', { name: 'Добавить в проект', exact: true }).click();
  for (const [client, role] of [
    [company, 'Заказчик'],
    [second, 'Генподрядчик'],
  ]) {
    await project.getByRole('button', { name: 'Добавить участника', exact: true }).click();
    const member = page.getByRole('dialog', { name: 'Новый участник', exact: true });
    await member.getByLabel('Поиск клиента').fill(client.name);
    await member
      .locator('.pico-picker-list')
      .getByRole('button')
      .filter({ hasText: client.name })
      .click();
    await member
      .getByRole('group', { name: 'Роль в проекте', exact: true })
      .getByRole('button', { name: role, exact: true })
      .click();
    await member.getByLabel('Следующий шаг').fill('Согласовать график');
    await member.getByRole('button', { name: 'Добавить участника', exact: true }).click();
  }
  const participants = project.locator('.pico-participant-entry');
  await participants
    .last()
    .getByRole('button', { name: 'Переместить участника выше', exact: true })
    .click();
  await participants.first().locator('.pico-entry-main').click();
  const edit = page.getByRole('dialog', { name: 'Редактировать участника', exact: true });
  await edit.getByLabel('Следующий шаг').fill('Прислать согласованный график');
  await edit.getByRole('button', { name: 'Сохранить участника', exact: true }).click();
  await screenshot(page, 'project-participants-ordered');
  await project.getByRole('button', { name: 'Сохранить проект', exact: true }).click();
  await expect(project).toHaveCount(0);
  await page.reload();
  const saved = (await api(page, `/companies/${company.id}`, undefined, 'GET')).records.find(
    (r: any) => r.id === legacy.id,
  );
  expect(saved.data.equipment).toContainEqual({
    division: 'drives',
    name: 'Старая позиция',
    amount: 3_000_000,
  });
  expect(saved.data.equipment).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ division: 'drives_lv', amount: 90_000_000 }),
      expect.objectContaining({ division: 'generator', amount: 2_000_000 }),
      expect.objectContaining({ division: 'commissioning', amount: 500_000 }),
    ]),
  );
  expect(saved.data.participants.map((p: any) => p.companyId)).toEqual([second.id, company.id]);
  expect(saved.data.participants[0].nextStep).toBe('Прислать согласованный график');
});

test('Design fidelity: crown opens compact users and admission shows the real Telegram ID', async ({
  page,
}) => {
  await login(page, 'Администратор');
  await page.getByRole('button', { name: 'Управление пользователями', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Пользователи', exact: true })).toBeVisible();
  await expect(page.locator('.pico-users table')).toHaveCount(0);
  const id = String(Date.now());
  await page.getByLabel('Telegram ID').fill(id);
  await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
  await expect(page.locator('.pico-user-row').filter({ hasText: 'ID ' + id })).toBeVisible();
  await screenshot(page, 'compact-admin-users');
});

test('Design fidelity: each filter sheet and postpone keeps its full-width action visible', async ({
  page,
}, info) => {
  await login(page);
  const { company } = await fixture(page, `Фильтры ${info.project.name}-${Date.now()}`);
  const project = await api(page, `/companies/${company.id}/records/project`, {
    data: { name: 'Контекст проекта ' + company.name },
  });
  const due = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  await api(page, `/companies/${company.id}/records/task`, {
    projectId: project.id,
    data: { text: 'Перенос ' + company.name, type: 'call', due, time: '12:00' },
  });
  await page.reload();
  await navigate(page, 'Задачи');
  const todayTask = page.locator('.task-row').filter({ hasText: 'Перенос ' + company.name });
  await expect(todayTask.locator('.task-text small')).toContainText(project.data.name);
  await expect(todayTask.locator('.task-text small')).not.toContainText(due);
  for (const [screen, label] of [
    ['Клиенты', 'Фильтры клиентов'],
    ['Проекты', 'Фильтры проектов'],
    ['Задачи', 'Фильтры задач'],
  ]) {
    await navigate(page, screen);
    await page.getByRole('button', { name: label, exact: true }).click();
    await fullWidthAction(page, /^Показать \(\d+\)$/);
    await screenshot(page, label);
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  }
  await page
    .locator('.task-text')
    .filter({ hasText: 'Перенос ' + company.name })
    .click();
  const detailBadge = page.getByRole('dialog').locator('.pico-detail-type .checkbox');
  await expect(detailBadge).toBeVisible();
  const color = await detailBadge.evaluate((el) => getComputedStyle(el).color);
  const rgb = color.match(/\d+/g)!.map(Number);
  expect(rgb[1]).toBeGreaterThan(rgb[0]);
  await page.getByRole('dialog').getByRole('button', { name: 'Отложить', exact: true }).click();
  const postpone = page.getByRole('dialog', { name: 'Отложить задачу', exact: true });
  const morning = postpone.getByRole('button', { name: /Завтра утром/ });
  await expect(morning).toContainText(/10:00/);
  await morning.click();
  await expect(postpone.getByLabel('Время', { exact: true })).toHaveValue('10:00');
  await fullWidthAction(page, 'Отложить');
  await screenshot(page, 'task-postpone-preview');
});
