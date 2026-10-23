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
  await direction.getByRole('textbox', { name: 'Потенциал, млн ₽', exact: true }).fill('90');
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

test('Design fidelity: long card swipe moves whole cell and keeps neutral trash in visible center', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'Администратор');
  const { company } = await fixture(page, `Длинная карточка ${info.project.name}-${Date.now()}`);
  for (let i = 0; i < 4; i++)
    await api(page, `/companies/${company.id}/records/contact`, {
      data: {
        name: `Контакт ${i + 1}`,
        role: 'Руководитель направления закупок оборудования и комплектующих',
        phone: '+79161234567',
        email: `contact${i}@example.com`,
      },
    });
  await page.reload();
  await navigate(page, 'Клиенты');
  const card = page.locator('.cc-card').filter({ hasText: company.name });
  await card.locator('.pico-client-row').click();
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Контакты/ })
    .click();
  await expect(card.locator('.cc-contact')).toHaveCount(5);
  const cell = card.locator(':scope > .cc-swipe');
  const content = cell.locator(':scope > .cc-swipe-content');
  await cell.dispatchEvent('touchstart', {
    touches: [{ identifier: 0, clientX: 300, clientY: 400 }],
  });
  await cell.dispatchEvent('touchmove', {
    touches: [{ identifier: 0, clientX: 295, clientY: 500 }],
  });
  await cell.dispatchEvent('touchend', {
    changedTouches: [{ identifier: 0, clientX: 210, clientY: 410 }],
  });
  await expect(cell).not.toHaveClass(/cc-revealed/);
  await cell.dispatchEvent('touchstart', {
    touches: [{ identifier: 0, clientX: 300, clientY: 400 }],
  });
  await cell.dispatchEvent('touchend', {
    changedTouches: [{ identifier: 0, clientX: 100, clientY: 402 }],
  });
  await expect(cell).toHaveClass(/cc-revealed/);
  await expect
    .poll(() =>
      content.evaluate((el) => {
        const transform = new DOMMatrix(getComputedStyle(el).transform);
        return Math.abs(transform.m41 + 112);
      }),
    )
    .toBeLessThan(1);
  const trash = cell.locator(':scope > .cc-trash-track > .cc-swipe-actions > .cc-trash');
  await expect(trash).toHaveCSS('color', 'rgb(107, 115, 144)');
  await expect(trash).toHaveCSS('width', '56px');
  for (const scroll of [0, 350]) {
    await page.evaluate((y) => window.scrollBy(0, y), scroll);
    await expect
      .poll(async () => {
        return cell.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          const button = el
            .querySelector(':scope > .cc-trash-track > .cc-swipe-actions > .cc-trash')!
            .getBoundingClientRect();
          return Math.abs(
            button.top +
              button.height / 2 -
              (Math.max(0, bounds.top) +
                Math.min(
                  (document.querySelector('.pico-bottom-nav')?.getBoundingClientRect().height ||
                    0) > 0
                    ? document.querySelector('.pico-bottom-nav')!.getBoundingClientRect().top
                    : innerHeight,
                  bounds.bottom,
                )) /
                2,
          );
        });
      })
      .toBeLessThan(2);
  }
  await screenshot(page, 'long-client-swipe-neutral-trash');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await api(page, `/companies/${company.id}`, undefined, 'GET')).company.archived).toBe(
    false,
  );
});

test('Design fidelity: holding allocation replaces estimates and linked customer repeatedly opens inline', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'Администратор');
  const suffix = `${info.project.name}-${Date.now()}`;
  const holding = await api(page, '/companies', {
    name: `Холдинг QA ${suffix}`,
    segment: 'holding',
    potential: 100000000,
    divisions: { lv: 100000000 },
  });
  const child = await api(page, '/companies', {
    name: `Заказчик QA ${suffix}`,
    segment: 'end_client',
    holdingId: holding.id,
    potential: 30000000,
    divisions: { lv: 30000000 },
  });
  await page.reload();
  await navigate(page, 'Клиенты');
  const parent = page
    .locator('.cc-card')
    .filter({ has: page.locator('.pico-client-row strong', { hasText: holding.name }) });
  await parent.locator('.pico-client-row').click();
  await expect(parent.locator('.holding-members')).toContainText('Временная оценка холдинга');
  await parent
    .getByRole('button', { name: 'Распределить временный потенциал', exact: true })
    .click();
  const allocation = parent.locator('.holding-allocation');
  await allocation.getByRole('spinbutton').fill('100');
  await expect(allocation).toContainText('заменят прежние суммы');
  await screenshot(page, 'holding-explicit-allocation');
  await allocation.getByRole('button', { name: 'Подтвердить распределение', exact: true }).click();
  await expect(allocation).toHaveCount(0);
  const saved = await api(page, `/companies/${child.id}`, undefined, 'GET');
  expect(saved.company.potential).toBe(100000000);
  expect(saved.company.divisions.lv).toBe(100000000);
  const cleared = await api(page, `/companies/${holding.id}`, undefined, 'GET');
  expect(cleared.company.potential).toBeNull();
  expect(cleared.company.divisions).toEqual({});
  const customer = page
    .locator('.cc-card')
    .filter({ has: page.locator('.pico-client-row strong', { hasText: child.name }) });
  const link = parent
    .locator('.holding-members')
    .getByRole('button', { name: child.name, exact: true });
  await link.click();
  await expect(customer.locator('.pico-client-row')).toHaveAttribute('aria-expanded', 'true');
  await customer.locator('.pico-client-row').click();
  await expect(customer.locator('.pico-client-row')).toHaveAttribute('aria-expanded', 'false');
  await link.click();
  await expect(customer.locator('.pico-client-row')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await screenshot(page, 'holding-customer-inline');
});

for (const width of [320, 390])
  test(`Design fidelity: final new client sheet matches three states at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    await navigate(page, 'Клиенты');
    await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
    await expect(
      sheet.getByRole('group', { name: 'Категория клиента', exact: true }).getByRole('button'),
    ).toHaveCount(8);
    await screenshot(page, `new-client-start-${width}`);
    await sheet
      .locator('.company-form-accordion > summary')
      .filter({ hasText: /^Потенциал/ })
      .click();
    await expect(sheet.getByRole('spinbutton')).toHaveCount(8);
    await sheet.getByRole('spinbutton').first().fill('2.5');
    await expect(sheet.locator('.company-form-accordion > summary').first()).toContainText(
      '2.5 млн ₽',
    );
    await screenshot(page, `new-client-potential-${width}`);
    await sheet
      .locator('.company-form-accordion > summary')
      .filter({ hasText: /^Дополнительные поля/ })
      .click();
    await sheet.getByLabel('Контакт', { exact: true }).fill('Тестовый контакт');
    await sheet.getByRole('button', { name: /Ещё контакт/ }).click();
    await expect(sheet.getByLabel('Контакт', { exact: true })).toHaveCount(2);
    const footerBefore = await sheet.locator('.company-form-footer').boundingBox();
    await sheet.locator('.company-form-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const footerAfter = await sheet.locator('.company-form-footer').boundingBox();
    expect(footerAfter!.y).toBe(footerBefore!.y);
    expect(footerAfter!.y + footerAfter!.height).toBeLessThanOrEqual(844);
    expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await screenshot(page, `new-client-extra-${width}`);
  });
