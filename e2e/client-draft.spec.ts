import { expect, test, Page } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';

async function setup(page: Page, width = 390) {
  await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ body: '' }));
  await page.addInitScript(() => {
    const listeners = new Set<() => void>();
    (window as any).draftBack = () => [...listeners].forEach((fn) => fn());
    (window as any).Telegram = {
      WebApp: {
        BackButton: {
          show() {},
          hide() {},
          onClick(fn: () => void) {
            listeners.add(fn);
          },
          offClick(fn: () => void) {
            listeners.delete(fn);
          },
        },
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await clients(page);
}
const form = (page: Page) => page.getByRole('dialog', { name: 'Новый клиент', exact: true });
const confirm = (page: Page) =>
  page.getByRole('dialog', { name: 'Закрыть без сохранения?', exact: true });
async function close(page: Page, channel: string, top = form(page)) {
  if (channel === 'x') await top.getByRole('button', { name: 'Закрыть', exact: true }).click();
  if (channel === 'escape') await page.keyboard.press('Escape');
  if (channel === 'telegram') await page.evaluate(() => (window as any).draftBack());
  if (channel === 'backdrop') await top.locator('..').click({ position: { x: 2, y: 2 } });
}

for (const width of [320, 390]) {
  test(`new-client close preserves drafts and discard unlocks scrolling at ${width}`, async ({
    page,
  }, info) => {
    await setup(page, width);
    const initialOverflow = await page.evaluate(() => document.body.style.overflow);
    let posts = 0;
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/companies' && req.method() === 'POST') posts++;
    });
    for (const channel of ['x', 'escape', 'backdrop', 'telegram']) {
      await action(page, 'Добавить клиента');
      await close(page, channel);
      await expect(form(page)).toHaveCount(0);
      await expect(confirm(page)).toHaveCount(0);
      await action(page, 'Добавить клиента');
      const name = form(page).getByRole('textbox', { name: 'Название', exact: true });
      await name.fill('Сохранить черновик ' + channel);
      await close(page, channel);
      await expect(confirm(page)).toBeVisible();
      await expect(
        confirm(page).getByRole('button', { name: 'Продолжить заполнение', exact: true }),
      ).toBeFocused();
      await page.screenshot({
        animations: 'disabled',
        path: `/tmp/pico-draft-evidence/confirm-${channel}-${width}-${info.project.name}.png`,
      });
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        expect(await confirm(page).evaluate((el) => el.contains(document.activeElement))).toBe(
          true,
        );
      }
      // Every dismissal of the upper dialog keeps the original form and its input.
      await close(page, channel, confirm(page));
      await expect(confirm(page)).toHaveCount(0);
      await expect(name).toHaveValue('Сохранить черновик ' + channel);
      await close(page, channel);
      await confirm(page)
        .getByRole('button', { name: 'Продолжить заполнение', exact: true })
        .click();
      await expect(name).toHaveValue('Сохранить черновик ' + channel);
      await close(page, channel);
      await confirm(page).getByRole('button', { name: 'Удалить черновик', exact: true }).click();
      await expect(form(page)).toHaveCount(0);
      await expect(confirm(page)).toHaveCount(0);
      expect(await page.evaluate(() => document.body.style.overflow)).toBe(initialOverflow);
    }
    expect(posts).toBe(0);
    await action(page, 'Добавить клиента');
    const name = form(page).getByRole('textbox', { name: 'Название', exact: true });
    await expect(name).toHaveValue('');
    await name.fill('Временное');
    await name.fill('');
    await close(page, 'escape');
    await expect(form(page)).toHaveCount(0);
    await expect(confirm(page)).toHaveCount(0);
  });
}

test('contacts and equipment are drafts; errors and pending saves never lose input or duplicate writes', async ({
  page,
}) => {
  await setup(page);
  await action(page, 'Добавить клиента');
  const sheet = form(page);
  await sheet
    .locator('.company-form-accordion > summary')
    .filter({ hasText: /^Дополнительные поля/ })
    .click();
  const contact = sheet.getByRole('textbox', { name: 'Контакт', exact: true });
  await contact.fill('Тестовый контакт');
  await close(page, 'escape');
  await expect(confirm(page)).toBeVisible();
  await confirm(page).getByRole('button', { name: 'Продолжить заполнение', exact: true }).click();
  await expect(contact).toHaveValue('Тестовый контакт');
  await contact.fill('');
  await close(page, 'escape');
  await expect(sheet).toHaveCount(0);
  await action(page, 'Добавить клиента');
  await sheet
    .locator('.company-form-accordion > summary')
    .filter({ hasText: /^Потенциал/ })
    .click();
  await sheet.getByRole('spinbutton', { name: 'Выключатели 0,4 кВ', exact: true }).fill('12.5');
  await close(page, 'escape');
  await expect(confirm(page)).toBeVisible();
  await confirm(page).getByRole('button', { name: 'Продолжить заполнение', exact: true }).click();
  await expect(
    sheet.getByRole('spinbutton', { name: 'Выключатели 0,4 кВ', exact: true }),
  ).toHaveValue('12.5');
  const name = sheet.getByRole('textbox', { name: 'Название', exact: true });
  const value = 'Черновик после ошибки ' + Date.now();
  await name.fill(value);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/companies', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    calls++;
    if (calls === 1) return route.fulfill({ status: 429, json: { message: 'Повторите позже' } });
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  await sheet.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('Повторите позже');
  await expect(name).toHaveValue(value);
  await close(page, 'escape');
  await confirm(page).getByRole('button', { name: 'Продолжить заполнение', exact: true }).click();
  await sheet.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Сохраняем…', exact: true })).toBeDisabled();
  await sheet.locator('form').evaluate((el) => {
    el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  for (const channel of ['x', 'escape', 'backdrop', 'telegram']) {
    await close(page, channel);
    await expect(sheet).toBeVisible();
    await expect(confirm(page)).toHaveCount(0);
  }
  expect(calls).toBe(2);
  release();
  await expect(sheet).toHaveCount(0);
  await expect(confirm(page)).toHaveCount(0);
  await expect(page.locator('.cc-card').filter({ hasText: value })).toBeVisible();
  await action(page, 'Добавить клиента');
  await expect(form(page).getByRole('textbox', { name: 'Название', exact: true })).toHaveValue('');
  await close(page, 'escape');
});

test('session expiry clears both draft dialogs and never shows an old draft to the next actor', async ({
  page,
}) => {
  await setup(page);
  await action(page, 'Добавить клиента');
  await form(page)
    .getByRole('textbox', { name: 'Название', exact: true })
    .fill('Черновик другого пользователя');
  await close(page, 'escape');
  await expect(confirm(page)).toBeVisible();
  await page.route('**/api/me', (route) =>
    route.fulfill({ status: 401, json: { message: 'Сессия истекла' } }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Менеджер', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await page.unroute('**/api/me');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await clients(page);
  await action(page, 'Добавить клиента');
  await expect(form(page).getByRole('textbox', { name: 'Название', exact: true })).toHaveValue('');
  await close(page, 'escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
