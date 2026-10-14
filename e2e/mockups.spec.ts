import { test, expect, Page } from '@playwright/test';
import { prepareDemoAuth, pickInline } from './helpers';
test.beforeEach(async ({ page }) => prepareDemoAuth(page));

async function login(page: Page) {
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
    r.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
}
async function api(page: Page, path: string, data?: unknown, method = 'POST') {
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const r = await page.request.fetch('/api' + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function nav(page: Page, name: string) {
  await page
    .getByRole('navigation')
    .getByRole('button', { name, exact: true })
    .locator('visible=true')
    .first()
    .click();
}
async function fits(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
}

test('Mockups: empty screens explain the next step without fabricated metrics', async ({
  page,
}, info) => {
  for (const path of [
    '/api/companies',
    '/api/records/task',
    '/api/records/project',
    '/api/records/file',
  ]) {
    await page.route('**' + path, (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' }),
    );
  }
  await login(page);
  const onboarding = page.locator('.pico-home-start');
  await expect(onboarding).not.toHaveAttribute('open', '');
  await onboarding.locator(':scope > summary').click();
  await expect(page.getByRole('heading', { name: 'Как работает Pico', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Сегодня', exact: true })).toBeVisible();
  await expect(page.getByText('На сегодня задач нет', { exact: true })).toBeVisible();
  await expect(page.locator('.pico-task-row')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('empty-home.png'), fullPage: true });
  await nav(page, 'Клиенты');
  await expect(
    page.getByRole('heading', { name: 'Начните с первого клиента', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Что будет в карточке клиента', exact: true }),
  ).toBeVisible();
  await nav(page, 'Проекты');
  await expect(page.getByRole('heading', { name: 'Проектов пока нет', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Что будет в карточке проекта', exact: true }),
  ).toBeVisible();
  await nav(page, 'Задачи');
  await expect(page.getByRole('heading', { name: 'Задач пока нет', exact: true })).toBeVisible();
  await nav(page, 'Аналитика');
  await expect(
    page.getByRole('heading', { name: 'Как работает аналитика', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.pico-funnel')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Как считаются показатели', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Воронка продаж', { exact: true })).toBeVisible();
  await expect(page.getByText('Конверсия', { exact: true })).toBeVisible();
  await expect(page.getByText('Потенциал', { exact: true })).toBeVisible();
  await fits(page);
  await page.screenshot({ path: info.outputPath('empty-analytics.png'), fullPage: true });
});

test('Mockups: navigation, calendar and real analytics remain usable on the device', async ({
  page,
}, info) => {
  await login(page);
  const footer = page.getByRole('navigation', { name: 'Основная навигация', exact: true });
  if (info.project.name === 'mobile') {
    await expect(footer).toBeVisible();
    await expect(footer).toHaveCSS('position', 'fixed');
    const boxes = await footer.getByRole('button').evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, right: r.right };
      }),
    );
    expect(boxes).toHaveLength(5);
    expect(Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y))).toBeLessThan(2);
    expect(boxes[4].right).toBeLessThanOrEqual(page.viewportSize()!.width);
  } else await expect(footer).toBeHidden();
  for (const name of ['Главная', 'Клиенты', 'Проекты', 'Задачи', 'Аналитика']) {
    await nav(page, name);
    await fits(page);
    await page.screenshot({ path: info.outputPath(`screen-${name}.png`), fullPage: true });
  }
  await nav(page, 'Задачи');
  await expect(page.locator('.calendar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Добавить задачу', exact: true })).toBeVisible();
  await nav(page, 'Аналитика');
  await page.getByRole('button', { name: 'Период аналитики', exact: true }).click();
  const period = page.getByRole('dialog', { name: 'Период', exact: true });
  await period.getByRole('radio', { name: /^Неделя/ }).click();
  await period.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Период аналитики', exact: true })).toContainText(
    '30 дней',
  );
  await page.getByRole('button', { name: 'Период аналитики', exact: true }).click();
  await period.getByRole('radio', { name: /^Свой период/ }).click();
  await period.getByLabel('Начало периода').fill('2026-01-01');
  await period.getByLabel('Конец периода').fill('2026-12-31');
  await period.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(period).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Период аналитики', exact: true })).toContainText(
    'Свой период',
  );
  await fits(page);
});

test('Mockups: project equipment, participant and typed timed task persist; rejected saves preserve input', async ({
  page,
}, info) => {
  await login(page);
  const suffix = Date.now() + '-' + info.project.name;
  const company = await api(page, '/companies', { name: 'Макет клиент ' + suffix });
  const participant = await api(page, '/companies', { name: 'Участник ' + suffix });
  const contact = await api(page, `/companies/${company.id}/records/contact`, {
    data: { name: 'Иван ' + suffix },
  });
  await page.reload();
  await nav(page, 'Проекты');
  await page.getByRole('button', { name: 'Добавить проект', exact: true }).click();
  const project = page.getByRole('dialog', { name: 'Новый проект', exact: true });
  await pickInline(page, project, 'Заказчик', company.name);
  await project.getByLabel('Название проекта').fill('Поставка ' + suffix);
  await project.getByLabel('Город проекта').fill('Казань');
  await project.getByLabel('Тип объекта').fill('ТЭЦ');
  await project.getByLabel('Дата закупки').fill('2027-03-01');
  await project.getByRole('button', { name: 'Добавить оборудование', exact: true }).click();
  const equipment = page.getByRole('dialog', { name: 'Оборудование', exact: true });
  await equipment
    .getByRole('group', { name: 'Направление', exact: true })
    .getByRole('button', { name: 'Выключатели 0,4 кВ', exact: true })
    .click();
  await equipment.getByLabel('Сумма Выключатели 0,4 кВ, млн ₽', { exact: true }).fill('120');
  await page.keyboard.press('Tab');
  expect(await equipment.evaluate((el) => el.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press('Shift+Tab');
  expect(await equipment.evaluate((el) => el.contains(document.activeElement))).toBeTruthy();
  await equipment.getByRole('button', { name: 'Добавить в проект' }).click();
  await project.getByRole('button', { name: 'Добавить участника', exact: true }).click();
  const member = page.getByRole('dialog', { name: 'Новый участник', exact: true });
  await member
    .locator('.pico-client-picker')
    .getByRole('button')
    .filter({ hasText: participant.name })
    .click();
  await member
    .getByRole('group', { name: 'Роль в проекте', exact: true })
    .getByRole('button', { name: 'Генподрядчик', exact: true })
    .click();
  await member.getByLabel('Следующий шаг').fill('Согласовать график');
  await member.getByRole('button', { name: 'Добавить участника', exact: true }).click();
  await fits(page);
  await page.screenshot({ path: info.outputPath('project-form.png'), fullPage: true });
  await project.getByRole('button', { name: 'Сохранить проект', exact: true }).click();
  await expect(project).toHaveCount(0);
  await page.reload();
  await nav(page, 'Проекты');
  const row = page.locator('.pico-project-row').filter({ hasText: 'Поставка ' + suffix });
  await row.locator(':scope > summary').click();
  await expect(row).toContainText('Выключатели 0,4 кВ');
  await expect(row).toContainText('Генподрядчик');
  await expect(row).toContainText('2027-03-01');
  const saved = await api(page, `/companies/${company.id}`, undefined, 'GET');
  const p = saved.records.find((r: any) => r.kind === 'project');
  expect(p.data.amount).toBe(120000000);
  expect(p.data.participants[0].companyId).toBe(participant.id);
  await nav(page, 'Задачи');
  await page.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  const task = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await pickInline(page, task, 'Клиент', company.name);
  await task.getByLabel('Задача', { exact: true }).fill('Звонок QA ' + suffix);
  await task.getByLabel('Срок', { exact: true }).fill(new Date().toISOString().slice(0, 10));
  await task.getByRole('button', { name: 'Звонок', exact: true }).click();
  await task.getByLabel('Время').fill('12:30');
  await pickInline(page, task, 'Контакт', contact.data.name);
  await pickInline(page, task, 'Проект', p.data.name);
  await page.route(`**/api/companies/${company.id}/records/task`, (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'QA temporary save failure' }),
    }),
  );
  await task.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  await expect(task.getByRole('alert')).toBeVisible();
  await expect(task.getByLabel('Задача', { exact: true })).toHaveValue('Звонок QA ' + suffix);
  await page.unroute(`**/api/companies/${company.id}/records/task`);
  await task.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  await expect(task).toHaveCount(0);
  await page.reload();
  await nav(page, 'Задачи');
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Звонок QA ' + suffix, { exact: true }) })
    .click();
  const detail = page.getByRole('dialog', { name: 'Звонок QA ' + suffix, exact: true });
  await expect(detail).toContainText('12:30');
  await expect(detail).toContainText('Иван ' + suffix);
  await detail.getByRole('button', { name: 'Отложить', exact: true }).click();
  const postpone = page.getByRole('dialog', { name: 'Отложить задачу', exact: true });
  await postpone.getByRole('button', { name: /^Завтра утром/ }).click();
  await postpone.getByLabel('Время', { exact: true }).fill('10:00');
  const postponedDate = await postpone.getByLabel('Дата', { exact: true }).inputValue();
  await postpone.getByRole('button', { name: 'Отложить', exact: true }).click();
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Звонок QA ' + suffix, { exact: true }) })
    .click();
  await expect(detail).toContainText('10:00');
  await detail.getByRole('button', { name: 'Выполнено', exact: true }).click();
  const final = await api(page, `/companies/${company.id}`, undefined, 'GET');
  const t = final.records.find((r: any) => r.kind === 'task');
  expect(t.data).toMatchObject({
    type: 'call',
    time: '10:00',
    due: postponedDate,
    contactId: contact.id,
    done: true,
  });
  expect(t.projectId).toBe(p.id);
});

test('Mockups: inline contact sheets save, retain edits on failure and refresh after reload', async ({
  page,
}, info) => {
  await login(page);
  const company = await api(page, '/companies', {
    name: 'Контакт QA ' + Date.now() + '-' + info.project.name,
  });
  await page.reload();
  await nav(page, 'Клиенты');
  const row = page.locator('.pico-client-accordion').filter({ hasText: company.name });
  await row.locator('.pico-client-row').click();
  await row
    .getByRole('button', { name: 'Добавить контакт · ' + company.name, exact: true })
    .click();
  const form = page.getByRole('dialog', { name: 'Новый контакт', exact: true });
  await form.getByLabel('Имя', { exact: true }).fill('Пётр QA');
  await form.getByLabel('Телефон', { exact: true }).fill('+79991234567');
  await form.getByRole('button', { name: 'Сохранить контакт', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Пётр QA', exact: true });
  await detail.getByRole('button', { name: 'Редактировать', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Редактировать контакт', exact: true });
  await edit.getByLabel('Телефон', { exact: true }).fill('+79997654321');
  await page.route('**/api/records/*', (r) =>
    r.request().method() === 'PATCH'
      ? r.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'QA temporary contact failure' }),
        })
      : r.continue(),
  );
  await edit.getByRole('button', { name: 'Сохранить контакт', exact: true }).click();
  await expect(edit.getByRole('alert')).toBeVisible();
  await expect(edit.getByLabel('Телефон', { exact: true })).toHaveValue('+79997654321');
  await page.unroute('**/api/records/*');
  await edit.getByRole('button', { name: 'Сохранить контакт', exact: true }).click();
  await expect(detail).toContainText('+79997654321');
  await detail.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(row).toContainText('+79997654321');
  await page.reload();
  await nav(page, 'Клиенты');
  await row.locator('.pico-client-row').click();
  await expect(row).toContainText('+79997654321');
  await fits(page);
  await page.screenshot({ path: info.outputPath('inline-contact.png'), fullPage: true });
});

test('Mockups: equipment with unknown amount keeps project total unknown after reload', async ({
  page,
}, info) => {
  await login(page);
  const suffix = Date.now() + '-' + info.project.name;
  const company = await api(page, '/companies', { name: 'Неизвестная сумма ' + suffix });
  await page.reload();
  await nav(page, 'Проекты');
  await page.getByRole('button', { name: 'Добавить проект', exact: true }).click();
  const project = page.getByRole('dialog', { name: 'Новый проект', exact: true });
  await pickInline(page, project, 'Заказчик', company.name);
  await project.getByLabel('Название проекта').fill('Оценка суммы ' + suffix);
  await project.getByRole('button', { name: 'Добавить оборудование', exact: true }).click();
  const equipment = page.getByRole('dialog', { name: 'Оборудование', exact: true });
  await equipment
    .getByRole('group', { name: 'Направление', exact: true })
    .getByRole('button', { name: 'Выключатели 0,4 кВ', exact: true })
    .click();
  await expect(
    equipment.getByLabel('Сумма Выключатели 0,4 кВ, млн ₽', { exact: true }),
  ).toHaveValue('');
  await equipment.getByRole('button', { name: 'Добавить в проект', exact: true }).click();
  await expect(project.getByLabel('Сумма, ₽', { exact: true })).toHaveValue('');
  await project.getByRole('button', { name: 'Добавить оборудование', exact: true }).click();
  await equipment
    .getByRole('group', { name: 'Направление', exact: true })
    .getByRole('button', { name: 'Выключатели 6–35 кВ', exact: true })
    .click();
  await equipment.getByLabel('Сумма Выключатели 6–35 кВ, млн ₽', { exact: true }).fill('1');
  await equipment.getByRole('button', { name: 'Добавить в проект', exact: true }).click();
  await expect(project.getByLabel('Сумма, ₽', { exact: true })).toHaveValue('');
  await project.getByRole('button', { name: 'Сохранить проект', exact: true }).click();
  await expect(project).toHaveCount(0);
  await page.reload();
  await nav(page, 'Проекты');
  const detail = await api(page, `/companies/${company.id}`, undefined, 'GET');
  const saved = detail.records.find((r: any) => r.kind === 'project');
  expect(saved.data.amount).toBeNull();
  expect(saved.data.equipment).toMatchObject([
    { division: 'lv', amount: null },
    { division: 'mv', amount: 1000000 },
  ]);
  const row = page.locator('.pico-project-row').filter({ hasText: 'Оценка суммы ' + suffix });
  await row.locator(':scope > summary').click();
  await expect(row).toContainText('Сумма: —');
});
