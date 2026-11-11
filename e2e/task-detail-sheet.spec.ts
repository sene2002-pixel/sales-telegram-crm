import { expect, Locator, Page, test } from '@playwright/test';
import { taskSchema } from '../src/shared/contracts';
import { action, navigate, prepareDemoAuth } from './helpers';

async function setup(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ body: '' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const api = async (path: string, data?: unknown, method = data ? 'POST' : 'GET') => {
    const response = await page.request.fetch('/api' + path, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
    return response.json();
  };
  const company = await api('/companies', { name: `Клиент задачи QA ${Date.now()}-${width}` });
  const project = await api(`/companies/${company.id}/records/project`, {
    data: { name: `Проект задачи ${company.id}` },
  });
  const contact = await api(`/companies/${company.id}/records/contact`, {
    data: { name: `Контакт задачи ${company.id}`, phone: '+79990000000' },
  });
  const title = `Обсудить техническое предложение с заказчиком, согласовать все условия поставки и следующий шаг по проекту ${company.id}`;
  const task = await api(`/companies/${company.id}/records/task`, {
    projectId: project.id,
    data: { text: title, due: '2099-12-01', time: '12:30', type: 'call', contactId: contact.id },
  });
  await action(page, 'Обновить');
  await navigate(page, 'Задачи');
  await page.getByRole('textbox', { name: 'Поиск задач', exact: true }).fill(title);
  const row = page.locator('.task-row').filter({ hasText: title });
  await expect(row).toBeVisible();
  const open = async () => {
    await row.locator('.task-text').click();
    const sheet = page.getByRole('dialog', { name: title, exact: true });
    await expect(sheet).toBeVisible();
    return sheet;
  };
  const stored = async () =>
    (await api('/records/task')).find((record: any) => record.id === task.id);
  return { api, company, project, contact, task, title, row, open, stored };
}

async function freezeClock(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
}

async function closed(page: Page) {
  await page.getByRole('button', { name: 'Закрытые', exact: true }).click();
}
async function picker(sheet: Locator, label: string) {
  await sheet.getByRole('button', { name: label, exact: true }).click();
  const dialog = sheet.page().getByRole('dialog', { name: `Изменить ${label}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const width of [320, 390, 1440]) {
  test(`Task detail sheet shows grouped fields and saves only confirmed edits at ${width}`, async ({
    page,
  }, info) => {
    test.skip(width === 1440 && info.project.name === 'mobile', 'Portrait-only mobile application');
    const { open, stored, task } = await setup(page, width);
    const sheet = await open();
    await expect(sheet.locator('.pico-task-detail-body')).toBeVisible();
    await expect(sheet.locator('.client-sheet-handle')).toHaveCount(0);
    const title = sheet.getByRole('heading').locator('.pico-modal-title-text');
    const titleGeometry = await title.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        clamp: style.webkitLineClamp,
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight),
      };
    });
    expect(titleGeometry.clamp).toBe('3');
    expect(titleGeometry.height).toBeLessThanOrEqual(titleGeometry.lineHeight * 3 + 1);
    for (const label of ['Дата', 'Время', 'Тип', 'Клиент', 'Проект', 'Контакт', 'Ответственный']) {
      const field = sheet.getByRole('button', { name: label, exact: true });
      await expect(field).toBeVisible();
      expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(sheet.getByRole('button', { name: 'Отложить', exact: true })).toHaveCount(0);
    const remove = sheet.getByRole('button', { name: 'Удалить', exact: true });
    const done = sheet.getByRole('button', { name: 'Выполнено', exact: true });
    const removeBox = (await remove.boundingBox())!;
    const doneBox = (await done.boundingBox())!;
    expect(removeBox.height).toBe(48);
    expect(doneBox.height).toBe(48);
    expect(Math.abs(removeBox.width - doneBox.width)).toBeLessThanOrEqual(1);
    if (width < 760) await expect(page.locator('.pico-bottom-nav')).toBeHidden();
    const time = await picker(sheet, 'Время');
    await time.locator('input[type="time"]').fill('16:45');
    await time.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(time).toHaveCount(0);
    await expect.poll(async () => (await stored()).data.time).toBe('16:45');
    await expect(sheet.getByRole('button', { name: 'Время', exact: true })).toContainText('16:45');
    expect((await stored()).version).toBe(task.version + 1);
    const date = await picker(sheet, 'Дата');
    await date.locator('input[type="date"]').fill('2099-12-25');
    await date.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(date).toHaveCount(0);
    expect((await stored()).data.due).toBe('2099-12-01');
    expect((await stored()).version).toBe(task.version + 1);
    await page.screenshot({
      path: info.outputPath(`task-sheet-${width}.png`),
      animations: 'disabled',
    });
  });
}

test('Completing a task can be undone before the delayed write and then restored from closed tasks', async ({
  page,
}) => {
  const { open, row, stored } = await setup(page);
  await freezeClock(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && /\/api\/records\//.test(request.url())) writes++;
  });
  let sheet = await open();
  await sheet.getByRole('button', { name: 'Выполнено', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row.locator('.task-text strong')).toHaveClass(/done/);
  const undo = page.getByRole('button', { name: 'Отменить', exact: true });
  await expect(undo).toBeVisible();
  const toastIcon = page.locator('.pico-undo-toast > svg');
  await expect(toastIcon).toHaveCSS('width', '22px');
  await expect(toastIcon).toHaveCSS('background-color', 'rgb(31, 122, 234)');
  await expect(toastIcon).toHaveCSS('color', 'rgb(255, 255, 255)');
  expect(writes).toBe(0);
  await page.clock.runFor(2500);
  expect(writes).toBe(0);
  await undo.click();
  await page.clock.runFor(1000);
  await expect(row.locator('.task-text strong')).not.toHaveClass(/done/);
  expect(writes).toBe(0);
  expect((await stored()).data.done).toBe(false);
  sheet = await open();
  await sheet.getByRole('button', { name: 'Выполнено', exact: true }).click();
  await page.clock.runFor(3100);
  await expect.poll(async () => (await stored()).data.done).toBe(true);
  await expect(row).toHaveCount(0);
  await closed(page);
  await expect(row).toBeVisible();
  await expect(row.locator('.cc-swipe')).toHaveCount(0);
  sheet = await open();
  await sheet.getByRole('button', { name: 'Вернуть задачу', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Задача снова в работе');
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await page.clock.runFor(3500);
  expect((await stored()).data.done).toBe(true);
  await expect(row).toBeVisible();
  sheet = await open();
  await sheet.getByRole('button', { name: 'Вернуть задачу', exact: true }).click();
  await page.clock.runFor(3100);
  await expect.poll(async () => (await stored()).data.done).toBe(false);
});

test('Deleting a task is delayed, undoable and retained as deleted in closed tasks', async ({
  page,
}) => {
  const { open, row, stored } = await setup(page);
  await freezeClock(page);
  let sheet = await open();
  await sheet.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect((await stored()).data.deleted).not.toBe(true);
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await page.clock.runFor(3500);
  await expect(row).toBeVisible();
  expect((await stored()).data.deleted).not.toBe(true);
  sheet = await open();
  await sheet.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.clock.runFor(3100);
  await expect.poll(async () => (await stored()).data.deleted).toBe(true);
  expect((await stored()).data.done).toBe(true);
  await closed(page);
  await expect(row).toBeVisible();
  sheet = await open();
  await sheet.getByRole('button', { name: 'Вернуть задачу', exact: true }).click();
  await page.clock.runFor(3100);
  await expect.poll(async () => (await stored()).data.deleted).toBe(false);
  expect((await stored()).data.done).toBe(false);
});

test('Delayed task completion fails safely when the opening record version is stale', async ({
  page,
}) => {
  const { api, open, row, stored, task } = await setup(page);
  const sheet = await open();
  const newer = await api(
    `/records/${task.id}`,
    { version: task.version, data: taskSchema.strip().parse({ ...task.data, time: '17:30' }) },
    'PATCH',
  );
  await freezeClock(page);
  await sheet.getByRole('button', { name: 'Выполнено', exact: true }).click();
  const response = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/records/${task.id}`),
  );
  await page.clock.runFor(3100);
  expect((await response).status()).toBe(409);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(row).toBeVisible();
  await expect(row.locator('.task-text strong')).not.toHaveClass(/done/);
  const current = await stored();
  expect(current.version).toBe(newer.version);
  expect(current.data.done).toBe(false);
  expect(current.data.time).toBe('17:30');
});

test('Task field pickers update type, project, contact and assignee while client opens its card', async ({
  page,
}) => {
  const { api, company, open, stored } = await setup(page);
  const sheet = await open();
  for (const [label, value, read] of [
    ['Тип', 'meeting', (record: any) => record.data.type],
    ['Проект', '', (record: any) => record.projectId ?? ''],
    ['Контакт', '', (record: any) => record.data.contactId ?? ''],
    ['Ответственный', '', (record: any) => record.assigneeId ?? ''],
  ] as const) {
    const editor = await picker(sheet, label);
    await expect(editor.getByRole('combobox', { name: label, exact: true })).toBeEnabled();
    await editor.getByRole('combobox', { name: label, exact: true }).selectOption(value);
    await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(async () => read(await stored())).toBe(value);
  }
  const version = (await stored()).version;
  await sheet.getByRole('button', { name: 'Клиент', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: company.name, exact: true })).toBeVisible();
  expect((await stored()).version).toBe(version);
  expect((await api(`/companies/${company.id}`)).company.name).toBe(company.name);
});

test('Pending task actions survive navigation and Undo still prevents the server write', async ({
  page,
}) => {
  const { open, stored, row } = await setup(page);
  await freezeClock(page);
  let sheet = await open();
  await sheet.getByRole('button', { name: 'Выполнено', exact: true }).click();
  await navigate(page, 'Клиенты');
  const undo = page.getByRole('button', { name: 'Отменить', exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await page.clock.runFor(3500);
  expect((await stored()).data.done).toBe(false);
  await navigate(page, 'Задачи');
  sheet = await open();
  await sheet.getByRole('button', { name: 'Удалить', exact: true }).click();
  await navigate(page, 'Клиенты');
  await page.clock.runFor(3100);
  await expect.poll(async () => (await stored()).data.deleted).toBe(true);
  await navigate(page, 'Задачи');
  await closed(page);
  await expect(row).toBeVisible();
});
