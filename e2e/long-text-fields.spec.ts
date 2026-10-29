import { expect, Locator, test } from '@playwright/test';
import { action, clients, navigate, prepareDemoAuth } from './helpers';

const legalName = 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «ЭНЕРГОКОМПЛЕКТ»';
const longWord = 'Энергопромышленнаяинфраструктура'.repeat(5);
async function fits(control: Locator) {
  await expect
    .poll(() => control.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(1);
}
for (const width of [320, 390, 1440]) {
  test(`long values grow and Data keeps its semantic grid at ${width}`, async ({ page }, info) => {
    test.skip(width > 760 && info.project.name === 'mobile', 'Desktop layout uses desktop project');
    await page.setViewportSize({ width, height: 900 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
    await clients(page);
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const headers = { Authorization: `Bearer ${token}` };
    const created = await page.request.post('/api/companies', {
      headers,
      data: {
        name: `${legalName} ${Date.now()}`,
        city: 'Петропавловск-Камчатский',
        website: `https://example.test/${longWord}`,
        notes: longWord,
        divisions: { lv: 12_000_000 },
        potential: 12_000_000,
      },
    });
    expect(created.ok()).toBeTruthy();
    const company = await created.json();
    const contactResponse = await page.request.post(
      `/api/companies/${company.id}/records/contact`,
      {
        headers,
        data: {
          data: {
            name: longWord,
            role: longWord,
            phone: '+79991234567',
            email: 'test@example.test',
          },
        },
      },
    );
    expect(contactResponse.ok()).toBeTruthy();
    for (const [kind, data] of [
      ['project', { name: longWord, amount: 12_000_000 }],
      ['task', { text: longWord }],
    ] as const) {
      const response = await page.request.post(`/api/companies/${company.id}/records/${kind}`, {
        headers,
        data: { data },
      });
      expect(response.ok()).toBeTruthy();
    }
    await action(page, 'Обновить');
    // Search the unique suffix; list display intentionally abbreviates legal forms.
    await page.getByRole('textbox', { name: 'Поиск компаний' }).fill(company.name.slice(-13));
    const card = page.locator('.cc-card').filter({ hasText: 'ЭНЕРГОКОМПЛЕКТ' });
    await card.locator('.pico-client-row').click();
    await card
      .locator('summary')
      .filter({ hasText: /^Данные/ })
      .click();
    const data = card.locator('.cc-data');
    const field = (name: string) =>
      data.getByRole('button', { name: `Изменить ${name}`, exact: true });
    await expect(field('Название')).toHaveText(company.name);
    const grid = (await data.boundingBox())!;
    for (const name of ['ИНН', 'Название', 'Сайт']) {
      const bounds = (await field(name).boundingBox())!;
      expect(bounds.width).toBeCloseTo(grid.width, 0);
    }
    const category = (await field('Категория').boundingBox())!;
    const city = (await field('Город').boundingBox())!;
    expect(category.y).toBeCloseTo(city.y, 0);
    expect(category.width).toBeCloseTo(city.width, 0);
    expect(category.x).toBeLessThan(city.x);
    await expect(field('Город').locator('span')).toHaveCSS('text-overflow', 'ellipsis');
    for (const button of [field('Название'), field('Сайт')]) {
      expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    }
    await data.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/pico-long-text-evidence/data-${width}-${info.project.name}.png`,
    });
    await field('Название').click();
    const editor = data.getByRole('textbox', { name: 'Название', exact: true });
    await expect(editor).toHaveValue(company.name);
    await editor.fill(longWord);
    await fits(editor);
    const tall = (await editor.boundingBox())!.height;
    await editor.fill('Короткое');
    await expect.poll(async () => (await editor.boundingBox())!.height).toBeLessThan(tall);
    await editor.fill(company.name + '\nНовый');
    await expect(editor).toHaveValue(company.name + ' Новый');
    await editor.press('Enter');
    await expect(editor).toBeVisible();
    await editor.fill(company.name);
    await data.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await field('Название').click();
    await expect(data.getByRole('textbox', { name: 'Название', exact: true })).toHaveValue(
      company.name,
    );
    await data.getByRole('button', { name: 'Отмена', exact: true }).click();
    await card
      .locator('summary')
      .filter({ hasText: /^Контакты/ })
      .click();
    const contact = card.locator('.cc-contact');
    expect(await contact.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    const phoneCell = contact.locator('.cc-contact-columns > div').last();
    const labelBounds = (await phoneCell.locator('span').first().boundingBox())!;
    const valueBounds = (await phoneCell.locator('span').last().boundingBox())!;
    expect(valueBounds.y - labelBounds.y - labelBounds.height).toBeLessThanOrEqual(3);
    await contact.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/pico-long-text-evidence/contact-${width}-${info.project.name}.png`,
    });
    await action(page, 'Добавить клиента');
    const sheet = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
    const name = sheet.getByRole('textbox', { name: 'Название', exact: true });
    await name.fill(legalName);
    await fits(name);
    await sheet.getByText('Дополнительные поля', { exact: true }).click();
    await sheet.getByRole('textbox', { name: 'Контакт', exact: true }).fill(longWord);
    await sheet.getByRole('textbox', { name: 'Должность', exact: true }).fill(longWord);
    const notes = sheet.getByRole('textbox', { name: 'Комментарий', exact: true });
    await notes.fill((longWord + '\n').repeat(4));
    await fits(notes);
    await notes.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/pico-long-text-evidence/company-form-${width}-${info.project.name}.png`,
    });
    await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await navigate(page, 'Проекты');
    const projectTitle = page
      .locator('.pico-project-row .pico-two-lines')
      .filter({ hasText: longWord })
      .first();
    await expect(projectTitle).toBeVisible();
    expect(
      await projectTitle.evaluate(
        (el) =>
          el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1,
      ),
    ).toBeTruthy();
    await expect(projectTitle).toHaveCSS('overflow-wrap', 'anywhere');
    await page.screenshot({
      path: `/tmp/pico-long-text-evidence/project-list-${width}-${info.project.name}.png`,
    });
    await action(page, 'Добавить проект');
    const project = page.getByRole('dialog').last();
    const projectName = project.getByRole('textbox', { name: 'Название проекта', exact: true });
    await projectName.fill(longWord);
    await fits(projectName);
    await page.screenshot({
      path: `/tmp/pico-long-text-evidence/project-form-${width}-${info.project.name}.png`,
    });
    await project.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await navigate(page, 'Задачи');
    const taskTitle = page
      .locator('.pico-task-row .pico-two-lines')
      .filter({ hasText: longWord })
      .first();
    await expect(taskTitle).toBeVisible();
    expect(
      await taskTitle.evaluate(
        (el) =>
          el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `/tmp/pico-long-text-evidence/task-list-${width}-${info.project.name}.png`,
    });
    await action(page, 'Добавить задачу');
    const task = page.getByRole('dialog').last();
    const taskName = task.getByRole('textbox', { name: 'Задача', exact: true });
    await taskName.fill(longWord);
    await fits(taskName);
    await page.screenshot({
      path: `/tmp/pico-long-text-evidence/task-form-${width}-${info.project.name}.png`,
    });
    await task.getByRole('button', { name: 'Закрыть', exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  });
}
