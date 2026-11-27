import { createHmac, randomInt } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  taskSchema,
  type Actor,
  type Company,
  type CompanyDetail,
  type CrmRecord,
} from '../src/shared/contracts';
import { clients, navigate, prepareDemoAuth } from './helpers';

// These tokens use only the documented local Playwright server's synthetic secret.
function localSession(id: string) {
  const payload = Buffer.from(
    JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const signature = createHmac('sha256', 'e2e-local-secret-not-a-production-secret')
    .update(payload)
    .digest('base64url');
  return payload + '.' + signature;
}

async function request<T>(
  page: Page,
  token: string,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await page.request.fetch('/api' + path, {
    method,
    ...(data === undefined ? {} : { data }),
    headers: { Authorization: 'Bearer ' + token },
  });
  await expect(response, method + ' ' + path).toBeOK();
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

async function enter(page: Page, token: string) {
  await page.evaluate((value) => sessionStorage.setItem('crm-session', value), token);
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function setup(page: Page) {
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = (await page.evaluate(() => sessionStorage.getItem('crm-session')))!;
  const tag = Date.now() + '-' + randomInt(1000, 10000);
  const actor = async (name: string, role: Actor['role'], supervisorId: string | null = null) => {
    const user = await request<Actor>(page, token, '/users', 'POST', {
      telegramId: String(Date.now()) + randomInt(100, 1000),
      name: name + ' ' + tag,
      role,
      active: true,
      supervisorId,
    });
    return { ...user, token: localSession(user.id) };
  };
  const lead = await actor('Руководитель', 'supervisor');
  const former = await actor('Бывший сотрудник', 'manager', lead.id);
  const colleague = await actor('Коллега', 'manager', lead.id);
  const company = (owner: typeof lead, name: string, data: object = {}) =>
    request<Company>(page, owner.token, '/companies', 'POST', { name: name + ' ' + tag, ...data });
  const record = (
    actor: typeof lead,
    company: Company,
    kind: 'project' | 'task',
    data: object,
    options: object = {},
  ) =>
    request<CrmRecord>(page, actor.token, `/companies/${company.id}/records/${kind}`, 'POST', {
      data,
      ...options,
    });
  const detail = (company: Company) =>
    request<CompanyDetail>(page, lead.token, `/companies/${company.id}`);
  return { actor, lead, former, colleague, company, record, detail };
}

function queueButton(page: Page, count: number) {
  return page.getByRole('button', { name: new RegExp(`^Требуют передачи.*\\b${count}$`) });
}

function row(queue: Locator, name: string) {
  return queue.getByRole('button', { name: new RegExp(name) });
}

async function openRemoval(page: Page, member: Actor) {
  const roster = page.getByRole('region', { name: 'Все сотрудники', exact: true });
  if (!(await roster.isVisible()))
    await page.getByRole('button', { name: 'Все сотрудники', exact: true }).click();
  await roster
    .getByRole('group', { name: `Действия: ${member.name}`, exact: true })
    .press('ArrowLeft');
  await roster
    .getByRole('button', { name: `Удалить из команды: ${member.name}`, exact: true })
    .click();
  return page.getByRole('alertdialog', { name: 'Удалить из команды', exact: true });
}

test('Очередь ниже счётчика: компания остаётся после конфликта, задачи истории и коллег не меняются', async ({
  page,
}, info) => {
  const f = await setup(page);
  const first = await f.company(f.former, 'Приоритетная компания', { inn: '7707083893' });
  const second = await f.company(f.former, 'Компания без просрочки');
  await f.company(f.colleague, 'Дубликат у коллеги', { inn: first.inn });
  await f.company(f.former, 'Закрытая компания', { stage: 'closed' });
  const project = await f.record(f.former, first, 'project', {
    name: 'Активный проект',
    stage: 'proposal',
  });
  await f.record(f.former, first, 'project', { name: 'Завершённый проект', stage: 'closed' });
  const open = await f.record(
    f.former,
    first,
    'task',
    { text: 'Просрочена задача бывшего сотрудника', due: '2001-01-01' },
    { projectId: project.id },
  );
  const activeColleague = await f.record(
    f.lead,
    first,
    'task',
    { text: 'Действующая задача руководителя' },
    { assignToSelf: true },
  );
  const closed = await f.record(f.former, first, 'task', {
    text: 'Завершённая задача бывшего сотрудника',
    done: true,
  });
  const otherCompany = await f.company(f.former, 'Компания с отдельной задачей');
  const done = await f.record(f.former, otherCompany, 'task', {
    text: 'Открытая задача на компании коллеги',
    done: true,
  });
  await request(page, f.lead.token, `/companies/${otherCompany.id}/assign`, 'POST', {
    ownerId: f.colleague.id,
    version: otherCompany.version,
  });
  const separate = await request<CrmRecord>(page, f.lead.token, `/records/${done.id}`, 'PATCH', {
    version: done.version,
    data: taskSchema.parse({ text: done.data.text, done: false }),
  });
  expect(separate.assigneeId).toBe(f.former.id);
  await request(page, f.lead.token, `/users/${f.former.id}`, 'DELETE');

  await enter(page, f.lead.token);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 700 });
  await clients(page);
  const entry = queueButton(page, 3);
  await expect(entry).toBeVisible();
  const shownCount = page.getByText(/^Показано:\s*\d+/);
  await expect(shownCount).toBeVisible();
  const beforeCount = (await shownCount.boundingBox())!;
  const button = (await entry.boundingBox())!;
  const list = (await page.locator('.pico-client-list').boundingBox())!;
  expect(beforeCount.y + beforeCount.height).toBeLessThanOrEqual(button.y);
  expect(button.y + button.height).toBeLessThanOrEqual(list.y);
  await page.getByRole('textbox', { name: 'Поиск компаний' }).fill('Ничего такого в базе нет');
  await expect(shownCount).toHaveText(/^Показано:\s*0\b/);
  await expect(entry).toBeVisible();
  await entry.click();
  const queue = page.getByRole('region', { name: 'Требуют передачи', exact: true });
  await expect(queue).toBeVisible();
  await expect(queue.getByRole('button', { name: /^Компании.*2$/ })).toBeVisible();
  const prioritized = row(queue, first.name);
  expect((await prioritized.boundingBox())!.y).toBeLessThan(
    (await row(queue, second.name).boundingBox())!.y,
  );
  await expect(prioritized).toContainText(f.former.name);
  await prioritized.click();
  await expect(queue.getByText('Активный проект', { exact: true })).toBeVisible();
  await expect(queue.getByText('Завершённый проект', { exact: true })).toHaveCount(0);
  await expect(queue.getByText(open.data.text, { exact: true })).toBeVisible();
  await expect(queue.getByText(activeColleague.data.text, { exact: true })).toHaveCount(0);
  if (info.project.name === 'mobile')
    await queue.screenshot({
      path: info.outputPath('client-handoff-queue.png'),
      animations: 'disabled',
    });
  await queue.getByRole('button', { name: 'Назначить ответственного', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: 'Передать компанию', exact: true });
  const recipient = transfer.getByRole('combobox', { name: 'Новый ответственный', exact: true });
  await recipient.selectOption(f.colleague.id);
  await transfer.getByRole('button', { name: 'Передать компанию', exact: true }).click();
  await expect(transfer.getByRole('alert')).toContainText(/ИНН/i);
  await expect(queueButton(page, 3)).toBeVisible();
  expect((await f.detail(first)).company.ownerId).toBe(f.former.id);
  await recipient.selectOption(f.lead.id);
  await transfer.getByRole('button', { name: 'Передать компанию', exact: true }).click();
  await expect(transfer).toHaveCount(0);
  await expect(row(queue, first.name)).toHaveCount(0);
  await expect(queueButton(page, 2)).toBeVisible();
  const assigned = await f.detail(first);
  expect(assigned.company.ownerId).toBe(f.lead.id);
  expect(assigned.records.find((r) => r.id === open.id)).toMatchObject({
    assigneeId: f.lead.id,
    authorId: f.former.id,
    projectId: project.id,
  });
  expect(assigned.records.find((r) => r.id === activeColleague.id)?.version).toBe(
    activeColleague.version,
  );
  expect(assigned.records.find((r) => r.id === closed.id)?.assigneeId).toBe(f.former.id);

  await queue.getByRole('button', { name: /^Отдельные задачи.*1$/ }).click();
  const task = row(queue, separate.data.text);
  if ((await task.getAttribute('aria-expanded')) === 'false') await task.click();
  await queue.getByRole('button', { name: 'Назначить исполнителя', exact: true }).click();
  const taskTransfer = page.getByRole('dialog', { name: 'Передать задачу', exact: true });
  await taskTransfer
    .getByRole('combobox', { name: 'Новый исполнитель', exact: true })
    .selectOption(f.colleague.id);
  await taskTransfer.getByRole('button', { name: 'Передать задачу', exact: true }).click();
  await expect(queue.getByText('Нет отдельных задач к передаче', { exact: true })).toBeVisible();
  await expect(queueButton(page, 1)).toBeVisible();
  const unchangedCompany = await f.detail(otherCompany);
  expect(unchangedCompany.company.ownerId).toBe(f.colleague.id);
  expect(unchangedCompany.records.find((r) => r.id === separate.id)?.assigneeId).toBe(
    f.colleague.id,
  );

  await enter(page, f.colleague.token);
  await clients(page);
  await expect(page.getByRole('button', { name: /^Требуют передачи/ })).toHaveCount(0);
});

test('Удаление предлагает передачу сейчас и очередь на потом, без частичного удаления при конфликте', async ({
  page,
}) => {
  const f = await setup(page);
  const second = await f.actor('Передача позже', 'manager', f.lead.id);
  const immediate = await f.company(f.former, 'Передать при удалении', { inn: '7707083893' });
  await f.company(f.colleague, 'Дубликат для проверки', { inn: immediate.inn });
  const later = await f.company(second, 'Распределить после удаления');
  const owned = await f.record(f.former, immediate, 'task', { text: 'Подхватить после удаления' });

  await enter(page, f.lead.token);
  await navigate(page, 'Команда');
  const dialog = await openRemoval(page, f.former);
  const selected = dialog.getByRole('combobox', { name: 'Новый ответственный', exact: true });
  const apply = dialog.getByRole('button', { name: 'Передать и удалить', exact: true });
  await expect(selected).toHaveValue(f.lead.id);
  await expect(dialog.getByRole('button', { name: 'Удалить и распределить позже' })).toBeVisible();
  await selected.selectOption(f.colleague.id);
  await apply.click();
  await expect(dialog.getByRole('alert')).toContainText(/ИНН/i);
  expect((await f.detail(immediate)).company.ownerId).toBe(f.former.id);
  expect((await request<Actor>(page, f.former.token, '/me')).active).toBe(true);
  await selected.selectOption(f.lead.id);
  await apply.click();
  await expect(dialog).toHaveCount(0);
  const transferred = await f.detail(immediate);
  expect(transferred.company.ownerId).toBe(f.lead.id);
  expect(transferred.records.find((r) => r.id === owned.id)?.assigneeId).toBe(f.lead.id);

  const defer = await openRemoval(page, second);
  await defer.getByRole('button', { name: 'Удалить и распределить позже', exact: true }).click();
  await expect(defer).toHaveCount(0);
  const revoked = await page.request.get('/api/me', {
    headers: { Authorization: 'Bearer ' + second.token },
  });
  expect(revoked.status()).toBe(403);
  expect((await f.detail(later)).company.ownerId).toBe(second.id);
  await clients(page);
  await queueButton(page, 1).click();
  const queue = page.getByRole('region', { name: 'Требуют передачи', exact: true });
  await expect(row(queue, later.name)).toBeVisible();
  await expect(row(queue, immediate.name)).toHaveCount(0);
});
