import { expect, test } from '@playwright/test';
import type { Actor } from '../src/shared/contracts';
import { navigate, prepareDemoAuth } from './helpers';

test('Team layout keeps all metrics on screen and edits the selected employee in place', async ({
  page,
}, info) => {
  const longName = 'Александра Воронцова-Константинопольская';
  const staff: Actor[] = [
    { id: '1', telegramId: '10001', name: 'Анна Волкова', role: 'manager', active: true },
    { id: '2', telegramId: '10002', name: 'Илья Орлов', role: 'supervisor', active: true },
    { id: '3', telegramId: '10003', name: 'Марина Белова', role: 'admin', active: true },
    { id: '4', telegramId: '10004', name: longName, role: 'manager', active: false },
  ];
  const changedName = 'Анна Соколова';
  let saves = 0;
  let failRefresh = false;
  await prepareDemoAuth(page);
  await page.route('**/api/me', (route) => route.fulfill({ json: staff[2] }));
  await page.route('**/api/users', async (route) => {
    if (route.request().method() === 'GET') {
      if (failRefresh) {
        failRefresh = false;
        return route.fulfill({ status: 503, json: { message: 'Список временно недоступен' } });
      }
      return route.fulfill({ json: staff });
    }
    const update = route.request().postDataJSON();
    expect(update).toMatchObject({ telegramId: '10001', name: changedName });
    if (++saves === 1)
      return route.fulfill({ status: 503, json: { message: 'Не удалось сохранить изменения' } });
    Object.assign(staff[0], update);
    failRefresh = true;
    return route.fulfill({ json: staff[0] });
  });
  await page.route('**/api/dashboard?*', (route) =>
    route.fulfill({
      json: staff.map((person, i) => ({
        ...person,
        companies: 12 - i,
        openTasks: 5 + i,
        overdue: 2 - (i % 3),
        completed: 21 + i,
        interactions: 37 + i,
        inactiveCompanies: [],
      })),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await navigate(page, 'Команда');

  const mobile = info.project.name === 'mobile';
  const table = page.getByRole('table', { name: 'Показатели команды' });
  const metrics = table
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: /Анна Волкова/ }) });
  const period = page.getByText('Текущий месяц · по сегодня', { exact: true });
  const download = page.getByRole('button', { name: 'Экспорт CSV', exact: true });
  const send = page.getByRole('button', { name: 'Получить CSV в боте', exact: true });
  for (const width of mobile ? [320, 390] : [1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const control of [period, download, send]) await expect(control).toBeVisible();
    const [when, first, second] = await Promise.all(
      [period, download, send].map((control) => control.boundingBox()),
    );
    if (!when || !first || !second) throw new Error('Не удалось измерить панель экспорта');
    if (mobile) {
      expect(when.y + when.height).toBeLessThanOrEqual(first.y + 1);
      for (const button of [first, second]) {
        expect(button.height).toBeGreaterThanOrEqual(44);
        expect(button.height).toBeLessThanOrEqual(56);
      }
    }
    expect(first.x + first.width <= second.x + 1 || first.y + first.height <= second.y + 1).toBe(
      true,
    );

    await expect(metrics).toContainText('Анна Волкова');
    await expect(table.getByRole('columnheader')).toHaveCount(6);
    const cells = metrics.getByRole('cell');
    await expect(cells).toHaveCount(5);
    if (mobile) {
      const name = await metrics.getByText('Анна Волкова', { exact: true }).boundingBox();
      const firstMetric = await cells.first().boundingBox();
      expect(Math.abs(name!.x - firstMetric!.x)).toBeLessThanOrEqual(1);
    }
    for (const [i, value] of [12, 5, 2, 21, 37].entries()) {
      const cell = cells.nth(i);
      await expect(cell).toContainText(String(value));
      const box = await cell.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      if (mobile)
        await expect(
          cell.getByText(['Компании', 'Открыто', 'Просрочено', 'Выполнено', 'Контакты'][i], {
            exact: true,
          }),
        ).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  if (mobile) await page.screenshot({ path: info.outputPath('team-overview.png') });

  const toggle = page.getByRole('button', { name: 'Все сотрудники', exact: true });
  await toggle.click();
  const roster = page.getByRole('region', { name: 'Все сотрудники', exact: true });
  const row = (name: string) =>
    roster.getByRole('listitem').filter({ has: page.locator('strong').filter({ hasText: name }) });
  const edit = (name: string) =>
    row(name).getByRole('button', { name: 'Редактировать ' + name, exact: true });
  await expect(row(longName)).toContainText('заблокирован');
  await expect(row('Марина Белова')).toContainText('Вы');
  if (mobile) {
    const pencil = await edit(longName).boundingBox();
    expect(pencil?.width).toBeGreaterThanOrEqual(44);
    expect(pencil?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('team-roster.png') });
  }

  await edit('Илья Орлов').click();
  await expect(row('Илья Орлов').getByLabel('Имя сотрудника')).toHaveValue('Илья Орлов');
  await edit('Анна Волкова').click();
  const selected = row('Анна Волкова');
  const nameInput = selected.getByLabel('Имя сотрудника');
  await expect(
    selected.getByRole('button', { name: 'Закрыть форму сотрудника Анна Волкова', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(nameInput).toHaveValue('Анна Волкова');
  await expect(row('Илья Орлов').getByLabel('Имя сотрудника')).toHaveCount(0);
  if (mobile) {
    for (const label of ['Роль', 'Руководитель']) {
      const control = selected.getByRole('combobox', { name: label, exact: true });
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: info.outputPath('team-editor.png') });
  }
  await nameInput.fill('Черновик');
  page.once('dialog', (dialog) => dialog.dismiss());
  await edit('Илья Орлов').click();
  await expect(nameInput).toHaveValue('Черновик');
  await selected.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(saves).toBe(0);
  await expect(edit('Анна Волкова')).toBeFocused();
  await edit('Анна Волкова').click();
  await expect(nameInput).toHaveValue('Анна Волкова');
  await nameInput.fill(changedName);
  await selected.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(selected.getByRole('alert')).toHaveText('Не удалось сохранить изменения');
  await expect(nameInput).toHaveValue(changedName);
  await selected.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(selected.getByRole('alert')).toContainText('Данные сохранены');
  await selected.getByRole('button', { name: 'Обновить список' }).click();
  await expect(edit(changedName)).toBeVisible();
  await expect(roster.getByLabel('Имя сотрудника')).toHaveCount(0);
  expect(saves).toBe(2);
  if (mobile) {
    await page.setViewportSize({ width: 320, height: 700 });
    await edit(longName).click();
    await expect(row(longName).getByLabel('Имя сотрудника')).toHaveValue(longName);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  }
});
