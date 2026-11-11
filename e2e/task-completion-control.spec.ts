import { expect, test } from '@playwright/test';
import { action, navigate, prepareDemoAuth } from './helpers';

for (const width of [320, 390, 1440]) {
  test(`Task type badges cannot complete tasks at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    if (width === 1440 && info.project.name === 'mobile') {
      await page.addInitScript(() => {
        Object.defineProperties(screen, {
          width: { configurable: true, value: 1440 },
          height: { configurable: true, value: 2560 },
        });
        Object.defineProperties(screen.orientation, {
          type: { configurable: true, value: 'portrait-primary' },
          angle: { configurable: true, value: 0 },
        });
      });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    const due = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    let tasks = ['call', 'meeting', 'email', 'reminder'].map((type) => ({
      id: `badge-${type}`,
      kind: 'task',
      version: 1,
      companyId: 'badge-company',
      companyName: 'Клиент с длинным названием',
      data: {
        text: `Проверить ${type} и согласовать следующий шаг с клиентом`,
        type,
        due,
        time: '12:30',
        contactId: null,
        done: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const patches: any[] = [];
    let failNext = true;
    await page.route('**/api/records/task*', (r) => r.fulfill({ json: tasks }));
    await page.route('**/api/tasks/badge-*/advice', (r) =>
      r.fulfill({ json: { text: 'Проверьте следующий шаг.' } }),
    );
    await page.route('**/api/records/badge-*', async (r) => {
      expect(r.request().method()).toBe('PATCH');
      const body = r.request().postDataJSON();
      patches.push(body);
      if (failNext) {
        failNext = false;
        await r.fulfill({ status: 429, json: { message: 'Повторите позже' } });
        return;
      }
      const id = r.request().url().split('/').pop();
      const current = tasks.find((task) => task.id === id)!;
      if (body.version !== current.version) {
        await r.fulfill({ status: 409, json: { message: 'Запись изменена. Обновите страницу' } });
        return;
      }
      tasks = tasks.map((t) =>
        t.id === id ? { ...t, data: body.data, version: t.version + 1 } : t,
      );
      await r.fulfill({ json: tasks.find((t) => t.id === id) });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Администратор', exact: true }).click();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    // Both Home variants: Today expands actions; Meetings opens details.
    for (const type of ['call', 'meeting']) {
      const row = page.locator('.pico-task-row').filter({ hasText: `Проверить ${type} ` });
      await row.locator('.checkbox').click();
      await expect(row.locator('.pico-task-actions')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await expect(page.locator('.pico-undo-toast')).toHaveCount(0);
    await page.clock.runFor(3500);
    expect(patches).toHaveLength(0);
    const today = page.getByRole('region', { name: 'Сегодня', exact: true });
    await today.locator('.task-text').filter({ hasText: 'Проверить call ' }).click();
    await expect(today.getByRole('button', { name: 'Выполнено', exact: true })).toBeVisible();
    await page.screenshot({
      path: `/tmp/task-completion-home-${width}-${info.project.name}.png`,
      animations: 'disabled',
    });
    await navigate(page, 'Задачи');
    for (const type of ['call', 'meeting', 'email', 'reminder']) {
      const row = page.locator('.task-row').filter({ hasText: `Проверить ${type} ` });
      const badge = row.locator('.checkbox');
      await expect(badge).toHaveJSProperty('tagName', 'SPAN');
      await expect(badge).toHaveAttribute('aria-hidden', 'true');
      await expect(badge).toHaveJSProperty('tabIndex', -1);
      await badge.click();
      await expect(row.locator('.task-text strong')).not.toHaveClass(/done/);
    }
    expect(patches).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/task-completion-list-${width}-${info.project.name}.png`,
      animations: 'disabled',
    });
    const call = page.locator('.task-row').filter({ hasText: 'Проверить call ' });
    await call.locator('.task-text').focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Тип', exact: true })).toBeVisible();
    await expect(dialog).toContainText('Звонок');
    expect(patches).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Выполнено', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(call.locator('.task-text strong')).toHaveClass(/done/);
    expect(patches).toHaveLength(0);
    await page.clock.runFor(2999);
    expect(patches).toHaveLength(0);
    await page.clock.runFor(2);
    await expect(page.getByRole('alert')).toContainText('Повторите позже');
    await expect(call.locator('.checkbox')).not.toHaveClass(/checked/);
    await expect(call.locator('.task-text strong')).not.toHaveClass(/done/);
    expect(patches).toHaveLength(1);
    expect(tasks[0].data.done).toBe(false);

    // A concurrent writer changes version/time. Retrying the stale row must fail,
    // without an automatic version upgrade or overwriting the newer time.
    tasks = tasks.map((task) =>
      task.id === 'badge-call'
        ? { ...task, version: 2, data: { ...task.data, time: '16:00' } }
        : task,
    );
    await call.locator('.task-text').click();
    await dialog.getByRole('button', { name: 'Выполнено', exact: true }).click();
    expect(patches).toHaveLength(1);
    await page.clock.runFor(3001);
    await expect(page.getByRole('alert')).toContainText('Запись изменена');
    await expect(call.locator('.task-text strong')).not.toHaveClass(/done/);
    expect(patches).toHaveLength(2);
    expect(patches[1].version).toBe(1);
    expect(tasks[0].data.done).toBe(false);
    expect(tasks[0].data.time).toBe('16:00');
    await page.clock.runFor(3500);
    expect(patches).toHaveLength(2);

    await action(page, 'Обновить');
    await expect(call).toContainText('16:00');
    await call.locator('.task-text').click();
    await dialog.getByRole('button', { name: 'Выполнено', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.clock.runFor(3001);
    await expect.poll(() => patches.length).toBe(3);
    await expect(call).toHaveCount(0);
    expect(patches[2]).toEqual({ version: 2, data: tasks[0].data });
    expect(patches[2].data).toMatchObject({
      done: true,
      deleted: false,
      due,
      time: '16:00',
      contactId: null,
      type: 'call',
    });
    await page.getByRole('button', { name: 'Фильтры задач' }).click();
    const filters = page.getByRole('dialog', { name: 'Фильтры задач' });
    await filters.getByRole('button', { name: 'Выполненные', exact: true }).click();
    await filters.getByRole('button', { name: /^Показать/ }).click();
    await expect(call.locator('.checkbox')).toHaveClass(/checked/);
    await call.locator('.checkbox').click();
    expect(patches).toHaveLength(3);
    await page.screenshot({
      path: `/tmp/task-completion-done-${width}-${info.project.name}.png`,
      animations: 'disabled',
    });
    await call.locator('.task-text').focus();
    await page.keyboard.press('Space');
    await dialog.getByRole('button', { name: 'Вернуть задачу', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(patches).toHaveLength(3);
    await page.clock.runFor(3001);
    await expect.poll(() => patches.length).toBe(4);
    expect(patches[3]).toEqual({
      version: 3,
      data: { ...patches[2].data, done: false, deleted: false },
    });
  });
}
