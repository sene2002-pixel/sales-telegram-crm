import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { companySchema, type Actor, type Company } from '../src/shared/contracts';
import type { TeamStats } from '../src/shared/team-metrics';
import { clients, navigate, openCompany, openCompanySection, prepareDemoAuth } from './helpers';

function actor(number: number, name: string, role: Actor['role'], supervisorId?: string): Actor {
  return {
    id: `f9e50a91-1091-42a2-83b6-f6b35ad00b1${number}`,
    telegramId: String(1000000 + number),
    name,
    role,
    active: true,
    supervisorId,
  };
}

const admin = actor(1, 'Ольга Адмиралова', 'admin');
const supervisor = actor(2, 'Илья Орлов', 'supervisor');
const otherSupervisor = actor(3, 'Марина Белова', 'supervisor');
const own = actor(4, 'Александра Воронцова-Константинопольская', 'manager', supervisor.id);
const foreign = actor(5, 'Денис Николаев', 'manager', otherSupervisor.id);
const unassigned = actor(6, 'Анна Волкова', 'manager');
const denied = 'Доступ изменился. Обновите список.';

async function loginManagement(page: Page, current: Actor) {
  const isAdmin = current.role === 'admin';
  await page.goto('/');
  await page
    .getByRole('button', { name: isAdmin ? 'Администратор' : 'Руководитель', exact: true })
    .click();
  await navigate(page, isAdmin ? 'Пользователи' : 'Команда');
}

async function openManagement(
  page: Page,
  current: Actor,
  target: Actor,
  failure: 'remove' | 'refresh',
) {
  let staff = [admin, supervisor, otherSupervisor, own, foreign, unassigned];
  let failRefresh = false;
  const attempts: string[] = [];
  await prepareDemoAuth(page);
  await page.route('**/api/me', (route) => route.fulfill({ json: current }));
  await page.route('**/api/employee-filter/options', (route) =>
    route.fulfill({
      json: staff
        .filter(
          (person) =>
            current.role === 'admin' ||
            person.id === current.id ||
            person.supervisorId === current.id,
        )
        .map(({ id, name, role }) => ({ id, name, role })),
    }),
  );
  await page.route('**/api/users', async (route) => {
    if (failRefresh) {
      failRefresh = false;
      return route.fulfill({ status: 503, json: { message: 'Список недоступен' } });
    }
    return route.fulfill({ json: staff });
  });
  await page.route('**/api/users/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().method()).toBe('DELETE');
    expect(path).toBe(`/api/users/${target.id}`);
    attempts.push(path);
    if (failure === 'remove' && attempts.length === 1)
      return route.fulfill({ status: 403, json: { message: denied } });
    staff = staff.filter((person) => person.id !== target.id);
    failRefresh = failure === 'refresh';
    return route.fulfill({ status: 204 });
  });
  await loginManagement(page, current);
  return attempts;
}

test('Руководитель удаляет только своего сотрудника после подтверждения', async ({
  page,
}, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 700 });
  const attempts = await openManagement(page, supervisor, own, 'remove');
  await page.getByRole('button', { name: 'Все сотрудники', exact: true }).click();
  const roster = page.getByRole('region', { name: 'Все сотрудники', exact: true });
  const remove = (person: Actor) =>
    roster.getByRole('button', { name: `Удалить из команды: ${person.name}`, exact: true });
  const ownName = roster.getByText(own.name, { exact: true });
  const trigger = remove(own);
  await expect(trigger).toBeVisible();
  for (const person of [admin, supervisor, otherSupervisor, foreign, unassigned])
    await expect(remove(person)).toHaveCount(0);

  const dialog = page.getByRole('alertdialog', { name: 'Удалить из команды', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Отмена', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Удалить сотрудника', exact: true });
  await trigger.click();
  await expect(dialog).toContainText(own.name);
  await expect(cancel).toBeFocused();
  if (info.project.name === 'mobile') {
    for (const control of [cancel, confirm]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    await dialog.screenshot({ path: info.outputPath('team-removal-confirmation.png') });
  }
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(attempts).toHaveLength(0);

  await trigger.click();
  await confirm.click();
  await expect(dialog.getByRole('alert')).toHaveText(denied);
  await expect(ownName).toBeVisible();
  expect(attempts).toHaveLength(1);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(ownName).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: `${own.name}: доступ закрыт.` }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
});

test('Администратор удаляет сотрудника другой команды и повторяет только обновление списка', async ({
  page,
}) => {
  const attempts = await openManagement(page, admin, foreign, 'refresh');
  const entry = page.getByRole('button', { name: new RegExp(foreign.name) });
  await entry.click();
  const editor = page.getByRole('dialog', { name: 'Пользователь', exact: true });
  await editor.getByRole('button', { name: 'Удалить из команды', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Удалить из команды', exact: true });
  await expect(dialog).toContainText(foreign.name);
  await dialog.getByRole('button', { name: 'Удалить сотрудника', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Не удалось обновить список');
  await dialog.getByRole('button', { name: 'Обновить список', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(entry).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: `${foreign.name}: доступ закрыт.` }),
  ).toBeVisible();
  expect(attempts).toHaveLength(1);
});

test('Клиент бывшего сотрудника остаётся в очереди и его можно назначить себе', async ({
  page,
}) => {
  const name = 'Северный сервис';
  const former = { ...own, name: 'Павел Воронов', active: false };
  const date = '2026-01-01T00:00:00.000Z';
  let company: Company = {
    ...companySchema.parse({ name }),
    id: 'f9e50a91-1091-42a2-83b6-f6b35ad00b17',
    ownerId: former.id,
    ownerName: former.name,
    version: 1,
    createdAt: date,
    updatedAt: date,
  };

  await prepareDemoAuth(page);
  await page.route('**/api/me', (route) => route.fulfill({ json: supervisor }));
  await page.route('**/api/users', (route) => route.fulfill({ json: [supervisor, foreign] }));
  await page.route('**/api/employee-filter/options', (route) =>
    route.fulfill({ json: [supervisor] }),
  );
  await page.route('**/api/dashboard?*', (route) => {
    const stats: TeamStats[] = [supervisor, former].map((person) => ({
      id: person.id,
      name: person.name,
      role: person.role,
      active: person.active,
      ...(person.id === former.id ? { removedFromTeam: true } : {}),
      companies: Number(person.id === company.ownerId),
      openTasks: 0,
      overdue: 0,
      completed: 0,
      interactions: 0,
      inactiveCompanies: person.id === company.ownerId ? [{ id: company.id, name }] : [],
    }));
    return route.fulfill({ json: stats });
  });
  await page.route('**/api/companies', (route) => route.fulfill({ json: [company] }));
  await page.route(`**/api/companies/${company.id}`, (route) =>
    route.fulfill({ json: { company, canManageOwnership: true, records: [], audit: [] } }),
  );
  await page.route(`**/api/companies/${company.id}/assign`, (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ ownerId: supervisor.id, version: 1 });
    company = { ...company, ownerId: supervisor.id, ownerName: supervisor.name, version: 2 };
    return route.fulfill({ json: company });
  });
  await loginManagement(page, supervisor);
  const inactive = page.getByRole('table', { name: 'Нет контакта 14 дней', exact: true });
  const row = inactive.getByRole('row').filter({ has: page.getByRole('rowheader', { name }) });
  await expect(row.getByRole('cell')).toHaveText(`${former.name} (вне команды)`);
  await expect(
    page.getByRole('table', { name: 'Показатели команды', exact: true }).getByText(former.name),
  ).toHaveCount(0);

  await clients(page);
  await openCompany(page, name);
  await openCompanySection(page, 'actions');
  const dialog = page.getByRole('dialog', { name, exact: true });
  const owners = dialog.getByRole('combobox', { name: 'Передать компанию', exact: true });
  const assign = dialog.getByRole('button', { name: 'Назначить', exact: true });
  await expect(owners).toHaveValue(former.id);
  await expect(owners.getByRole('option', { name: former.name })).toHaveJSProperty(
    'disabled',
    true,
  );
  await expect(owners.getByRole('option')).toHaveText([former.name, supervisor.name]);
  await expect(assign).toBeDisabled();
  await owners.selectOption(supervisor.id);
  await assign.click();
  await expect(owners.getByRole('option')).toHaveText([supervisor.name]);
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await navigate(page, 'Команда');
  await expect(row.getByRole('cell')).toHaveText(supervisor.name);
});
