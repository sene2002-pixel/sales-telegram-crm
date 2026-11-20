import { expect, Page, test } from '@playwright/test';
import { prepareDemoAuth } from './helpers';

const invite = `https://t.me/PicoTestBot?start=invite_${'x'.repeat(43)}`;
const nextInvite = `https://t.me/PicoTestBot?start=invite_${'y'.repeat(43)}`;
const finalInvite = `https://t.me/PicoTestBot?start=invite_${'z'.repeat(43)}`;
const bot = 'https://t.me/PicoTestBot';
const note = 'Коллега, Pico + CRM & задачи\nПосмотрите, пожалуйста';
type ShareTestWindow = Window & { clipboardTexts: string[]; telegramLinks: string[] };

async function login(page: Page, role: 'Руководитель' | 'Менеджер' | 'Администратор') {
  await prepareDemoAuth(page);
  await page.addInitScript(() => {
    const state = window as ShareTestWindow;
    state.clipboardTexts = [];
    state.telegramLinks = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => state.clipboardTexts.push(text) },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: role, exact: true }).click();
}

async function openShare(page: Page) {
  await page
    .getByRole('group', { name: 'Дополнительные действия' })
    .getByRole('button', { name: /^Поделиться/ })
    .click();
  return page.getByRole('dialog', { name: 'Поделиться', exact: true });
}

test('supervisor shares one invitation, copies the full message and keeps the draft', async ({
  page,
}) => {
  let created = 0;
  let accepted = false;
  let noMatchingMetadata = false;
  await page.route('**/api/team-invitations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: noMatchingMetadata
          ? []
          : [{ id: '1', usedAt: accepted ? new Date().toISOString() : null, revokedAt: null }],
      });
      return;
    }
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({});
    created++;
    await route.fulfill({
      json: {
        id: String(created),
        url: [invite, nextInvite, finalInvite][created - 1],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  });
  await login(page, 'Руководитель');
  await page.evaluate(() => {
    Object.assign(window, {
      Telegram: {
        WebApp: {
          initData: 'test-only',
          openTelegramLink: (url: string) => (window as ShareTestWindow).telegramLinks.push(url),
        },
      },
    });
  });
  const share = await openShare(page);
  const message = share.getByRole('textbox', { name: 'Коллега получит' });
  await expect(message).toHaveValue(
    'Я веду здесь задачи и клиентов. Возможно, вам тоже будет удобно',
  );
  await message.fill(note);
  await expect(message).toBeFocused();
  expect(created).toBe(0);

  await share.getByRole('button', { name: 'Скопировать сообщение' }).click();
  await expect(share.getByRole('button', { name: 'Сообщение скопировано' })).toBeVisible();
  expect(await page.evaluate(() => (window as ShareTestWindow).clipboardTexts)).toEqual([
    `${note}\n\n${invite}`,
  ]);
  await expect(share).not.toContainText(invite);
  await expect(share.getByRole('button', { name: 'Скопировать сообщение' })).toBeVisible();

  await share.getByRole('button', { name: 'Закрыть' }).click();
  await openShare(page);
  await expect(message).toHaveValue(note);
  await share.getByRole('button', { name: 'Отправить коллеге' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as ShareTestWindow).telegramLinks.length))
    .toBe(1);
  const [url] = await page.evaluate(() => (window as ShareTestWindow).telegramLinks);
  expect(url).toBe(
    `https://t.me/share/url?url=${encodeURIComponent(invite)}&text=${encodeURIComponent(note)}`,
  );
  expect(created).toBe(1);

  accepted = true;
  await share.getByRole('button', { name: 'Скопировать сообщение' }).click();
  await expect(share.getByRole('button', { name: 'Сообщение скопировано' })).toBeVisible();
  expect(await page.evaluate(() => (window as ShareTestWindow).clipboardTexts)).toEqual([
    `${note}\n\n${invite}`,
    `${note}\n\n${nextInvite}`,
  ]);
  expect(created).toBe(2);

  noMatchingMetadata = true;
  await expect(share.getByRole('button', { name: 'Скопировать сообщение' })).toBeVisible();
  await share.getByRole('button', { name: 'Скопировать сообщение' }).click();
  await expect(share.getByRole('button', { name: 'Сообщение скопировано' })).toBeVisible();
  expect(await page.evaluate(() => (window as ShareTestWindow).clipboardTexts.at(-1))).toBe(
    `${note}\n\n${finalInvite}`,
  );
  expect(created).toBe(3);

  await page.reload();
  await openShare(page);
  await expect(message).toHaveValue(note);
});

test('manager shares the public bot link without an invitation and can retry an unavailable bot', async ({
  page,
}) => {
  let attempts = 0;
  await page.route('**/api/share/bot-link', async (route) => {
    if (++attempts === 1) {
      await route.fulfill({ status: 503, json: { message: 'Бот не настроен' } });
      return;
    }
    await route.fulfill({ json: { url: bot } });
  });
  const invitations: string[] = [];
  await page.route('**/api/team-invitations', async (route) => {
    invitations.push(route.request().method());
    await route.fulfill({ status: 403, json: { message: 'Нет доступа' } });
  });
  await login(page, 'Менеджер');
  const share = await openShare(page);
  await expect(share.getByText('Коллега получит ссылку на бота.', { exact: false })).toBeVisible();
  const copy = share.getByRole('button', { name: 'Скопировать сообщение' });
  await copy.click();
  await expect(share.getByRole('alert')).toHaveText('Бот не настроен');
  await copy.click();
  await expect(share.getByRole('button', { name: 'Сообщение скопировано' })).toBeVisible();
  expect(await page.evaluate(() => (window as ShareTestWindow).clipboardTexts)).toEqual([
    `Я веду здесь задачи и клиентов. Возможно, вам тоже будет удобно\n\n${bot}`,
  ]);
  expect(invitations).toEqual([]);
  expect(attempts).toBe(2);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        },
      },
    });
    document.execCommand = (command) => {
      if (command !== 'copy' || !(document.activeElement instanceof HTMLTextAreaElement))
        return false;
      (window as ShareTestWindow).clipboardTexts.push(document.activeElement.value);
      return true;
    };
  });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(share.getByRole('button', { name: 'Сообщение скопировано' })).toBeFocused();
  expect(await page.evaluate(() => (window as ShareTestWindow).clipboardTexts.length)).toBe(2);
  expect(attempts).toBe(2);
});

test('administrator can share an invitation to their own or a supervisor’s team', async ({
  page,
}) => {
  const supervisorId = 'b8618836-aeb7-4b8e-8f0e-74a09ef8ab1d';
  await page.route('**/api/users', async (route) => {
    const response = await route.fetch();
    const users = await response.json();
    await route.fulfill({
      json: [
        ...users,
        { id: supervisorId, name: 'Выбранный руководитель', role: 'supervisor', active: true },
      ],
    });
  });
  const requested: string[] = [];
  await page.route('**/api/team-invitations', async (route) => {
    requested.push(route.request().postDataJSON().supervisorId);
    await route.fulfill({
      json: { id: '1', url: invite, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
  });
  await login(page, 'Администратор');
  const share = await openShare(page);
  const copy = share.getByRole('button', { name: 'Скопировать сообщение' });
  const team = share.getByLabel('Команда руководителя');
  await expect(team.locator('option:checked')).toHaveText('Моя команда');
  const own = await team.inputValue();
  expect(own).not.toBe(supervisorId);
  await copy.click();
  await expect(share.getByRole('button', { name: 'Сообщение скопировано' })).toBeVisible();
  await team.selectOption(supervisorId);
  await copy.click();
  await expect(share.getByRole('button', { name: 'Сообщение скопировано' })).toBeVisible();
  expect(requested).toEqual([own, supervisorId]);
});

test('Home utility cards preserve their carousel dimensions and reachable last action at 390px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'Руководитель');
  const actions = page.getByRole('group', { name: 'Дополнительные действия' });
  const track = actions.locator('.pico-home-actions-track');
  const cards = track.getByRole('button');
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) {
    await expect(card).toHaveCSS('width', '171px');
    await expect(card).toHaveCSS('height', '108px');
  }
  await expect(track).toHaveCSS('column-gap', '8px');
  const visiblePart = await track.evaluate((element) => {
    const trackBox = element.getBoundingClientRect();
    const lastCard = element.lastElementChild!.getBoundingClientRect();
    return Math.round(trackBox.right - lastCard.left);
  });
  expect(visiblePart).toBe(16);
  const last = actions.getByRole('button', { name: 'Показать действия, страница 2' });
  await last.click();
  await expect(last).toHaveAttribute('aria-current', 'true');
  await expect(cards.last()).toBeInViewport({ ratio: 0.9 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
