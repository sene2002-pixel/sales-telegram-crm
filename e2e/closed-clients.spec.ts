import { expect, test } from '@playwright/test';
import { action, clients, navigate, prepareDemoAuth } from './helpers';

for (const width of [320, 390]) {
  test(`archived clients are in Closed and restore without losing records at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Администратор', exact: true }).click();
    await clients(page);
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const headers = { Authorization: `Bearer ${token}` };
    const prefix = `Закрытие-${Date.now()}-${width}`;
    const create = async (name: string, extra = {}) => {
      const response = await page.request.post('/api/companies', {
        headers,
        data: { name, city: 'Казань', ...extra },
      });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const current = await create(prefix + ' Новый');
    const old = await create(prefix + ' Старый архив', { archived: true });
    const stageClosed = await create(prefix + ' Закрытая стадия', { stage: 'closed' });
    const contact = await page.request.post(`/api/companies/${current.id}/records/contact`, {
      headers,
      data: { data: { name: 'Сохранённый контакт', phone: '+79991234567' } },
    });
    expect(contact.ok()).toBeTruthy();
    await action(page, 'Обновить');
    const search = page.getByRole('textbox', { name: 'Поиск компаний' });
    await search.fill(prefix);
    const cards = page.locator('.cc-card');
    await expect(cards).toHaveCount(1);
    await page.getByRole('button', { name: 'В работе', exact: true }).click();
    await expect(cards).toHaveCount(1);
    // Archive through the actual card action, including its confirmation.
    const card = cards.filter({ hasText: current.name });
    const swipe = card.locator(':scope > .cc-swipe');
    await swipe.focus();
    await swipe.press('ArrowLeft');
    await swipe.locator(':scope > .cc-trash-track .cc-trash').click();
    await card.getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
    await expect(cards).toHaveCount(0);
    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await expect(cards).toHaveCount(0);
    await page.getByRole('button', { name: 'Закрытые', exact: true }).click();
    await expect(cards).toHaveCount(3);
    await expect(cards.filter({ hasText: old.name })).toBeVisible();
    await expect(cards.filter({ hasText: stageClosed.name })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Закрытые', exact: true })).toHaveCSS(
      'background-color',
      'rgb(31, 122, 234)',
    );
    await page.screenshot({
      path: `/tmp/pico-closed-evidence/closed-${width}-${info.project.name}.png`,
    });
    await page.getByRole('button', { name: 'Фильтры клиентов', exact: true }).click();
    const filters = page.getByRole('dialog', { name: 'Фильтры клиентов', exact: true });
    await expect(filters.getByRole('button', { name: /Архив компаний/ })).toHaveCount(0);
    const sort = filters.getByRole('combobox', { name: 'Сортировка', exact: true });
    await sort.selectOption('updated');
    const reset = filters.getByRole('button', { name: 'Сбросить', exact: true });
    const sortBox = (await sort.boundingBox())!,
      resetBox = (await reset.boundingBox())!;
    expect(resetBox.x).toBeGreaterThan(sortBox.x + sortBox.width);
    expect(Math.abs(sortBox.y + sortBox.height - resetBox.y - resetBox.height)).toBeLessThanOrEqual(
      2,
    );
    await page.screenshot({
      path: `/tmp/pico-closed-evidence/filters-${width}-${info.project.name}.png`,
    });
    await reset.click();
    await expect(sort).toHaveValue('name');
    await filters.getByRole('button', { name: /^Показать/ }).click();
    await expect(cards).toHaveCount(3);
    await card.locator('.pico-client-row').click();
    await card
      .getByRole('button', { name: 'Восстановить компанию', exact: true })
      .evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.screenshot({
      path: `/tmp/pico-closed-evidence/restore-${width}-${info.project.name}.png`,
    });
    await card.getByRole('button', { name: 'Восстановить компанию', exact: true }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('button', { name: 'Восстановить компанию', exact: true }).click();
    await detail
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Подтвердить', exact: true })
      .click();
    await detail.getByRole('button', { name: 'Контакты', exact: true }).click();
    await expect(detail).toContainText('Сохранённый контакт');
    await detail.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'В работе', exact: true }).click();
    await expect(cards).toHaveCount(1);
    await expect(card).toBeVisible();
    await action(page, 'Обновить');
    await expect(card).toBeVisible();
    const final = await (
      await page.request.get(`/api/companies/${current.id}`, { headers })
    ).json();
    expect(final.company.archived).toBe(false);
    expect(
      final.records.some(
        (r: { kind: string; data: { name: string } }) =>
          r.kind === 'contact' && r.data.name === 'Сохранённый контакт',
      ),
    ).toBe(true);
    // The home client counter excludes old archive and the business-closed stage.
    const all = await (await page.request.get('/api/companies', { headers })).json();
    const activeCount = all.filter(
      (c: { archived: boolean; stage: string }) => !c.archived && c.stage !== 'closed',
    ).length;
    await navigate(page, 'Главная');
    await expect(
      page.locator('.pico-summary button').filter({ hasText: 'Клиенты' }).locator('strong'),
    ).toHaveText(String(activeCount));
  });
}
