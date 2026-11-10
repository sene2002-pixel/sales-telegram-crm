import { expect, Locator, Page, test } from '@playwright/test';
import { action, navigate, prepareDemoAuth } from './helpers';

async function setup(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const api = async (path: string, data?: unknown) => {
    const response = await page.request.fetch('/api' + path, {
      method: data ? 'POST' : 'GET',
      data,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const company = await api('/companies', { name: `Swipe task ${Date.now()}-${width}` });
  const title = `Согласовать предложение ${company.id}`;
  const task = await api(`/companies/${company.id}/records/task`, {
    data: { text: title, due: '2099-12-01', type: 'call' },
  });
  await action(page, 'Обновить');
  await navigate(page, 'Задачи');
  await page.getByRole('textbox', { name: 'Поиск задач', exact: true }).fill(title);
  const swipe = page.getByRole('group', { name: `Действия: задачу «${title}»`, exact: true });
  await expect(swipe).toBeVisible();
  return {
    task,
    title,
    swipe,
    stored: async () => (await api('/records/task')).find((row: any) => row.id === task.id),
  };
}

async function drag(page: Page, cell: Locator, left = true) {
  await cell.scrollIntoViewIfNeeded();
  const box = (await cell.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width * (left ? 0.8 : 0.2);
  const end = box.x + box.width * (left ? 0.2 : 0.8);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + ((end - x) * i) / 6, y }],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

for (const width of [320, 390, 1440]) {
  test(`Task swipe moves the whole cell and reveals transparent actions at ${width}`, async ({
    page,
  }, info) => {
    test.skip(width === 1440 && info.project.name === 'mobile', 'Portrait-only mobile app');
    const { swipe, title } = await setup(page, width);
    const edit = swipe.getByRole('button', {
      name: `Редактировать задачу «${title}»`,
      exact: true,
    });
    const remove = swipe.getByRole('button', { name: `Удалить задачу «${title}»`, exact: true });
    await expect(edit).toBeHidden();
    await expect(remove).toBeHidden();
    const icon = swipe.locator('.checkbox');
    const before = (await icon.boundingBox())!;
    await drag(page, swipe);
    await expect(swipe).toHaveClass(/cc-revealed/);
    await expect(swipe.locator('> .cc-swipe-content')).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, -112, 0)',
    );
    expect(Math.round(before.x - (await icon.boundingBox())!.x)).toBe(112);
    for (const button of [edit, remove]) {
      await expect(button).toBeVisible();
      await expect(button).toHaveCSS('width', '56px');
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(button).toHaveCSS('color', 'rgb(107, 115, 144)');
      await expect(button).toHaveCSS('border-top-width', '0px');
    }
    await page.screenshot({
      path: info.outputPath(`task-swipe-${width}.png`),
      animations: 'disabled',
    });
    await drag(page, swipe, false);
    await expect(swipe).not.toHaveClass(/cc-revealed/);
    await swipe.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(edit).toBeVisible();
    await page.getByRole('heading', { name: 'Задачи', exact: true }).click();
    await expect(edit).toBeHidden();
    await swipe.focus();
    await page.keyboard.press('ArrowLeft');
    await edit.click();
    const sheet = page.getByRole('dialog', { name: title, exact: true });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await swipe.locator('.task-text').click();
    await expect(sheet).toBeVisible();
  });
}

test('Swipe deletion has no confirmation, supports undo, then retains the task in Closed', async ({
  page,
}) => {
  const { swipe, title, stored } = await setup(page, 390);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  let patches = 0,
    deletes = 0;
  page.on('request', (request) => {
    if (/\/api\/records\//.test(request.url())) {
      if (request.method() === 'PATCH') patches++;
      if (request.method() === 'DELETE') deletes++;
    }
  });
  const remove = async () => {
    await swipe.focus();
    await page.keyboard.press('ArrowLeft');
    await swipe.getByRole('button', { name: `Удалить задачу «${title}»`, exact: true }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(swipe).toHaveCount(0);
    await expect(page.locator('.pico-undo-toast')).toContainText('Задача удалена');
    await expect(page.locator('.pico-undo-fill')).toBeVisible();
  };
  await remove();
  await page.clock.runFor(2500);
  expect(patches).toBe(0);
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(swipe).toBeVisible();
  await page.clock.runFor(1000);
  expect(patches).toBe(0);
  expect((await stored()).data.deleted).not.toBe(true);
  await remove();
  await page.clock.runFor(3100);
  await expect.poll(async () => (await stored()).data.deleted).toBe(true);
  expect(patches).toBe(1);
  expect(deletes).toBe(0);
  await page.getByRole('button', { name: 'Закрытые', exact: true }).click();
  const row = page.locator('.task-row').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Удалена');
  await expect(row.locator('xpath=..')).not.toHaveClass(/cc-swipe-content/);
  expect((await stored()).data).toMatchObject({
    text: title,
    due: '2099-12-01',
    type: 'call',
    done: true,
    deleted: true,
  });
});
