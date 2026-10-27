import { expect, Locator, Page, test } from '@playwright/test';
import { action, clients, navigate, prepareDemoAuth } from './helpers';

async function setup(page: Page, width = 390, platform = 'android', initialHeight = 844) {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(
    ({ platform, initialHeight }) => {
      const callbacks = new Map<string, Set<() => void>>();
      const visual = new EventTarget() as any;
      Object.assign(visual, { height: 844, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
      Object.defineProperty(screen.orientation, 'type', {
        configurable: true,
        value: 'portrait-primary',
      });
      const sdk = {
        initData: '',
        platform,
        viewportStableHeight: initialHeight,
        viewportHeight: initialHeight,
        ready() {},
        expand() {},
        isVersionAtLeast() {
          return false;
        },
        onEvent(name: string, callback: () => void) {
          if (!callbacks.has(name)) callbacks.set(name, new Set());
          callbacks.get(name)!.add(callback);
        },
        offEvent(name: string, callback: () => void) {
          callbacks.get(name)?.delete(callback);
        },
      };
      (window as any).Telegram = { WebApp: sdk };
      (window as any).__keyboard = {
        resize(height: number, nativeOnly = false, top = 0) {
          sdk.viewportHeight = height;
          visual.height = nativeOnly ? 844 : height;
          visual.offsetTop = top;
          visual.dispatchEvent(new Event('resize'));
          callbacks.get('viewportChanged')?.forEach((fn) => fn());
          let keyboard = document.getElementById('synthetic-keyboard');
          if (height === 844) keyboard?.remove();
          else {
            if (!keyboard) {
              keyboard = document.createElement('div');
              keyboard.id = 'synthetic-keyboard';
              document.body.append(keyboard);
            }
            keyboard.textContent = 'Клавиатура · тестовая имитация';
            Object.assign(keyboard.style, {
              position: 'fixed',
              bottom: '0',
              left: '0',
              right: '0',
              height: `${844 - height - top}px`,
              background: '#dce0e8',
              color: '#334155',
              padding: '24px',
              boxSizing: 'border-box',
              zIndex: '10000',
              textAlign: 'center',
            });
          }
        },
      };
    },
    { platform, initialHeight },
  );
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ body: '' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await clients(page);
}
async function resize(page: Page, height: number, nativeOnly = false, top = 0) {
  await page.evaluate(
    ({ height, nativeOnly, top }) => (window as any).__keyboard.resize(height, nativeOnly, top),
    { height, nativeOnly, top },
  );
}
async function visibleField(field: Locator, bottom: number) {
  await expect
    .poll(async () => {
      const box = await field.boundingBox();
      return box && box.y >= 0 && box.y + box.height <= bottom;
    })
    .toBeTruthy();
}
for (const width of [320, 390]) {
  test(`keyboard hides navigation and restores without blur at ${width}`, async ({
    page,
  }, info) => {
    await setup(page, width);
    const nav = page.locator('.pico-bottom-nav');
    const search = page.getByRole('textbox', { name: 'Поиск компаний' });
    await search.focus();
    await expect(nav).toBeVisible(); // hardware keyboard / focus alone
    await resize(page, 780);
    await expect(nav).toBeVisible(); // browser toolbar is not a keyboard
    await resize(page, 430);
    await expect(nav).toBeHidden();
    await visibleField(search, 430);
    await page.screenshot({ path: info.outputPath(`search-keyboard-${width}.png`) });
    await resize(page, 844);
    await expect(search).toBeFocused();
    await expect(nav).toBeVisible();
    await resize(page, 430, true); // Telegram changes live height before browser geometry
    await expect(nav).toBeHidden();
    await resize(page, 844, true);
    await expect(nav).toBeVisible();
    await page.screenshot({ path: info.outputPath(`search-restored-${width}.png`) });
  });
  test(`keyboard keeps deep client fields visible at ${width}`, async ({ page }, info) => {
    await setup(page, width);
    await action(page, 'Добавить клиента');
    const sheet = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
    await sheet.getByText('Дополнительные поля', { exact: true }).click();
    const comment = sheet.getByRole('textbox', { name: 'Комментарий', exact: true });
    await comment.fill('Текст не теряется при открытии и закрытии клавиатуры');
    await resize(page, 390, true, 20);
    await expect(page.locator('.pico-bottom-nav')).toBeHidden();
    await visibleField(comment, 410);
    await expect(sheet.getByRole('heading')).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`new-client-keyboard-${width}.png`) });
    await resize(page, 844);
    await expect(page.locator('.pico-bottom-nav')).toBeVisible();
    await expect(comment).toHaveValue('Текст не теряется при открытии и закрытии клавиатуры');
    await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const response = await page.request.post('/api/companies', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `Keyboard-${Date.now()}-${width}`,
        divisions: { lv: 1_000_000 },
        potential: 1_000_000,
      },
    });
    expect(response.ok()).toBeTruthy();
    const company = await response.json();
    await action(page, 'Обновить');
    const card = page.locator('.cc-card').filter({ hasText: company.name });
    await card.locator('.pico-client-row').click();
    await card.getByRole('button', { name: 'Изменить Выключатели 0,4 кВ', exact: true }).click();
    const amount = card.getByRole('textbox', { name: 'Выключатели 0,4 кВ', exact: true });
    await amount.fill('2,5');
    await resize(page, 390);
    await expect(page.locator('.pico-bottom-nav')).toBeHidden();
    await visibleField(amount, 390);
    await page.screenshot({ path: info.outputPath(`inline-keyboard-${width}.png`) });
    await resize(page, 844);
    await expect(amount).toHaveValue('2,5');
    await expect(page.locator('.pico-bottom-nav')).toBeVisible();
  });
}
test('desktop resize and text focus do not hide primary navigation state', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'Hardware desktop case uses the desktop project');
  await setup(page, 1280, 'tdesktop');
  await page.getByRole('textbox', { name: 'Поиск компаний' }).focus();
  await resize(page, 430);
  await expect(page.locator('html')).toHaveAttribute('data-pico-keyboard-open', 'false');
});

test('keyboard scrolling covers contact, client edit, notes, task and project forms', async ({
  page,
}, info) => {
  await setup(page);
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const created = await page.request.post('/api/companies', {
    headers,
    data: { name: `Keyboard-forms-${Date.now()}`, notes: 'Заметки для проверки клавиатуры' },
  });
  expect(created.ok()).toBeTruthy();
  const company = await created.json();
  const contact = await page.request.post(`/api/companies/${company.id}/records/contact`, {
    headers,
    data: { data: { name: 'Тестовый контакт', email: 'keyboard@example.test' } },
  });
  expect(contact.ok()).toBeTruthy();
  await action(page, 'Обновить');
  const card = page.locator('.cc-card').filter({ hasText: company.name });
  await card.locator('.pico-client-row').click();
  const nav = page.locator('.pico-bottom-nav');
  async function check(field: Locator, name: string) {
    await field.fill(`Проверка ${name}`);
    await resize(page, 390, true);
    await expect(nav).toBeHidden();
    await visibleField(field, 390);
    await page.screenshot({ path: info.outputPath(`${name}-keyboard.png`) });
    await resize(page, 844);
    await expect(nav).toBeVisible();
    await expect(field).toHaveValue(`Проверка ${name}`);
  }
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Заметки/ })
    .click();
  await card.getByRole('button', { name: 'Изменить Заметки о клиенте', exact: true }).click();
  await check(card.getByRole('textbox', { name: 'Заметки о клиенте', exact: true }), 'notes');
  await card.getByRole('button', { name: 'Отмена', exact: true }).click();
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Контакты/ })
    .click();
  const swipe = card
    .locator('.cc-swipe')
    .filter({ has: page.locator('.cc-contact') })
    .last();
  await swipe.focus();
  await swipe.press('ArrowLeft');
  await swipe
    .locator(':scope > .cc-trash-track')
    .getByRole('button', { name: /Редактировать/ })
    .click();
  const contactSheet = page.getByRole('dialog', { name: 'Контакт', exact: true });
  // A valid email draft, which must remain visible above the sticky action.
  const email = contactSheet.getByRole('textbox', { name: 'Контакт · E-mail', exact: true });
  await email.fill('keyboard-updated@example.test');
  await resize(page, 390, true);
  await expect(nav).toBeHidden();
  await visibleField(email, 390);
  const emailBox = (await email.boundingBox())!;
  const saveBox = (await contactSheet
    .getByRole('button', { name: 'Сохранить', exact: true })
    .boundingBox())!;
  expect(emailBox.y + emailBox.height).toBeLessThanOrEqual(saveBox.y);
  await page.screenshot({ path: info.outputPath('contact-keyboard.png') });
  await resize(page, 844);
  await expect(email).toHaveValue('keyboard-updated@example.test');
  await contactSheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const clientSwipe = card.locator(':scope > .cc-swipe');
  await clientSwipe.focus();
  await clientSwipe.press('ArrowLeft');
  await clientSwipe
    .locator(':scope > .cc-trash-track')
    .getByRole('button', { name: /Редактировать/ })
    .click();
  const clientSheet = page.getByRole('dialog', { name: 'Редактирование карточки', exact: true });
  await clientSheet.getByText('Дополнительные поля', { exact: true }).click();
  await check(
    clientSheet.getByRole('textbox', { name: 'Комментарий', exact: true }),
    'client-edit',
  );
  await clientSheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await navigate(page, 'Задачи');
  await action(page, 'Добавить задачу');
  const taskSheet = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await check(taskSheet.getByRole('textbox', { name: 'Задача', exact: true }), 'task');
  await taskSheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await navigate(page, 'Проекты');
  await action(page, 'Добавить проект');
  const projectSheet = page.getByRole('dialog', { name: 'Новый проект', exact: true });
  await projectSheet.getByText('Дополнительные поля', { exact: true }).click();
  await check(projectSheet.getByRole('textbox', { name: 'Описание', exact: true }), 'project');
});

test('keyboard baseline starts at the native usable height, not host height', async ({
  page,
}, info) => {
  await setup(page, 390, 'android', 560);
  const search = page.getByRole('textbox', { name: 'Поиск компаний' });
  const nav = page.locator('.pico-bottom-nav');
  await search.focus();
  await expect(page.locator('html')).toHaveAttribute('data-pico-keyboard-open', 'false');
  await expect(nav).toBeVisible();
  await page.screenshot({ path: info.outputPath('native-short-window-no-keyboard.png') });
  await resize(page, 300, true);
  await expect(nav).toBeHidden();
  await page.evaluate(() => {
    const state = (window as any).__keyboard;
    state.resize(560, true);
    document.getElementById('synthetic-keyboard')?.remove();
  });
  await expect(search).toBeFocused();
  await expect(nav).toBeVisible();
});
