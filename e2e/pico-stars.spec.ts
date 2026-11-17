import { expect, Page, test } from '@playwright/test';
import { prepareDemoAuth } from './helpers';

const invoiceId = '659fc36b-5441-45eb-87ef-1324fede8731';
const invoiceUrl = 'https://t.me/$synthetic_invoice_link';
type InvoiceStatus = 'paid' | 'cancelled' | 'pending' | 'failed';
type StarsTestWindow = Window & {
  receivedInvoice?: string;
  onInvoiceClosed?: (status: InvoiceStatus) => void;
};

async function openSupport(page: Page) {
  await page
    .getByRole('group', { name: 'Дополнительные действия' })
    .getByRole('button', { name: /^Поддержать/ })
    .click();
  return page.getByRole('dialog', { name: 'Поддержать', exact: true });
}

async function login(page: Page) {
  await page.route('**/api/me/pico-stars/invoices/active', async (route) => {
    await route.fulfill({ json: { id: null } });
  });
  await page.route('**/api/me/pico-stars/invoices/*/cancel', async (route) => {
    await route.fulfill({ json: { cancelled: true } });
  });
  await prepareDemoAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Руководитель', exact: true }).click();
}

test('custom Stars amount uses the Pico keypad and thanks only after a verified receipt', async ({
  page,
}, testInfo) => {
  let paid = false;
  let invoiceReads = 0;
  await page.route('**/api/me/pico-stars/invoices', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ amount: 75 });
    await route.fulfill({ status: 201, json: { id: invoiceId, url: invoiceUrl } });
  });
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, async (route) => {
    invoiceReads++;
    await route.fulfill({ json: { amount: 75, status: paid ? 'paid' : 'pending' } });
  });
  await login(page);
  await page.evaluate(() => {
    const state = window as StarsTestWindow;
    window.Telegram = {
      WebApp: {
        initData: 'mock-native-app',
        ready() {},
        expand() {},
        openInvoice(url: string, callback: (status: InvoiceStatus) => void) {
          state.receivedInvoice = url;
          state.onInvoiceClosed = callback;
        },
      } as NonNullable<NonNullable<Window['Telegram']>['WebApp']>,
    };
  });
  const support = await openSupport(page);
  await expect(support.getByRole('button', { name: '100 звёзд', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(support.getByRole('button', { name: 'Поддержать · 100' })).toBeVisible();
  if (testInfo.project.name === 'mobile')
    await page.screenshot({ path: testInfo.outputPath('поддержать.png') });

  await support.getByRole('button', { name: 'Другое количество' }).click();
  const amount = support.getByRole('textbox', { name: 'Количество звёзд' });
  await expect(support.getByRole('heading', { name: 'Поддержать' })).toHaveCount(0);
  await expect(amount).toBeFocused();
  await expect(amount).toHaveAttribute('inputmode', 'none');
  await expect(support.getByRole('button', { name: 'Запятая' })).toHaveCount(0);
  await expect(support.getByRole('button', { name: 'Готово' })).toBeDisabled();
  await amount.fill('10001');
  await expect(support.getByRole('button', { name: 'Готово' })).toBeDisabled();
  await amount.fill('');
  await support.getByRole('button', { name: '7', exact: true }).click();
  await support.getByRole('button', { name: '5', exact: true }).click();
  await support.getByRole('button', { name: '0', exact: true }).click();
  await support.getByRole('button', { name: 'Стереть', exact: true }).click();
  await expect(amount).toHaveValue('75');
  if (testInfo.project.name === 'mobile')
    await page.screenshot({ path: testInfo.outputPath('клавиатура.png') });
  await support.getByRole('button', { name: 'Готово' }).click();
  await expect(support.getByRole('button', { name: '75 звёзд', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(support.getByRole('button', { name: '100 звёзд', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await support.getByRole('button', { name: 'Поддержать · 75' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as StarsTestWindow).receivedInvoice))
    .toBe(invoiceUrl);
  await page.evaluate(() => (window as StarsTestWindow).onInvoiceClosed?.('paid'));
  await expect.poll(() => invoiceReads).toBeGreaterThan(0);
  const thanks = page.getByRole('dialog', { name: 'Спасибо!', exact: true });
  await expect(thanks).toHaveCount(0);
  await expect(support.getByRole('status')).toContainText('Проверяем оплату');
  paid = true;
  await expect(
    thanks.getByText('Вы отправили 75 звёзд. Они пойдут на новые функции.'),
  ).toBeVisible();
  if (testInfo.project.name === 'mobile')
    await page.screenshot({ path: testInfo.outputPath('спасибо.png') });
  await thanks.getByRole('button', { name: 'На главную' }).click();
  await expect(thanks).toHaveCount(0);
});

test('without Telegram the Stars panel explains how to open it without creating an invoice', async ({
  page,
}) => {
  let created = 0;
  await page.route('**/api/me/pico-stars/invoices', async (route) => {
    created++;
    await route.abort();
  });
  await login(page);
  const support = await openSupport(page);
  await support.getByRole('button', { name: 'Поддержать · 100' }).click();
  await expect(support.getByRole('alert')).toHaveText(
    'Откройте Pico в Telegram, чтобы отправить звёзды.',
  );
  expect(created).toBe(0);
});

test('recovers an invoice when the WebView closes before Telegram calls back', async ({ page }) => {
  let paid = false;
  let created = 0;
  await page.route('**/api/me/pico-stars/invoices', async (route) => {
    created++;
    await route.fulfill({ status: 201, json: { id: invoiceId, url: invoiceUrl } });
  });
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, async (route) => {
    await route.fulfill({ json: { amount: 100, status: paid ? 'paid' : 'pending' } });
  });
  await login(page);
  await page.evaluate(() => {
    window.Telegram = {
      WebApp: {
        initData: 'mock-native-app',
        openInvoice(url: string) {
          (window as StarsTestWindow).receivedInvoice = url;
        },
      } as NonNullable<NonNullable<Window['Telegram']>['WebApp']>,
    };
  });
  const support = await openSupport(page);
  await support.getByRole('button', { name: 'Поддержать · 100' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as StarsTestWindow).receivedInvoice))
    .toBe(invoiceUrl);
  await page.reload();
  const recovered = await openSupport(page);
  await expect(recovered.getByRole('status')).toContainText('Проверяем оплату');
  await expect(recovered.getByRole('button', { name: 'Поддержать · 100' })).toHaveCount(0);
  expect(created).toBe(1);
  paid = true;
  const thanks = page.getByRole('dialog', { name: 'Спасибо!', exact: true });
  await expect(
    thanks.getByText('Вы отправили 100 звёзд. Они пойдут на новые функции.'),
  ).toBeVisible();
  await expect(thanks.getByRole('button', { name: 'На главную' })).toBeFocused();
});

test('cancelled checkout clears recovery state and allows another attempt', async ({ page }) => {
  await page.route('**/api/me/pico-stars/invoices', async (route) => {
    await route.fulfill({ status: 201, json: { id: invoiceId, url: invoiceUrl } });
  });
  await login(page);
  await page.evaluate(() => {
    window.Telegram = {
      WebApp: {
        initData: 'mock-native-app',
        openInvoice(_url: string, callback: (status: InvoiceStatus) => void) {
          callback('cancelled');
        },
      } as NonNullable<NonNullable<Window['Telegram']>['WebApp']>,
    };
  });
  const support = await openSupport(page);
  await support.getByRole('button', { name: 'Поддержать · 100' }).click();
  await expect(support.getByRole('button', { name: 'Поддержать · 100' })).toBeEnabled();
  await page.reload();
  const reopened = await openSupport(page);
  await expect(reopened.getByRole('button', { name: 'Поддержать · 100' })).toBeEnabled();
});

test('recovers the server invoice without browser storage and cancels only with server approval', async ({
  page,
}) => {
  await login(page);
  await page.route('**/api/me/pico-stars/invoices/active', async (route) => {
    await route.fulfill({ json: { id: invoiceId } });
  });
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, async (route) => {
    await route.fulfill({ json: { amount: 100, status: 'pending' } });
  });
  let cancelled = false;
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}/cancel`, async (route) => {
    await route.fulfill({ json: { cancelled } });
  });
  const support = await openSupport(page);
  await expect(support.getByRole('button', { name: 'Отменить счёт' })).toBeVisible();
  await support.getByRole('button', { name: 'Отменить счёт' }).click();
  await expect(support.getByRole('alert')).toContainText('Оплата уже началась');
  await expect(support.getByRole('button', { name: 'Поддержать · 100' })).toHaveCount(0);
  cancelled = true;
  await support.getByRole('button', { name: 'Отменить счёт' }).click();
  await expect(support.getByRole('button', { name: 'Поддержать · 100' })).toBeEnabled();
});

test('storage failure leaves the created invoice recoverable without opening Telegram', async ({
  page,
}) => {
  await page.route('**/api/me/pico-stars/invoices', async (route) => {
    await route.fulfill({ status: 201, json: { id: invoiceId, url: invoiceUrl } });
  });
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, async (route) => {
    await route.fulfill({ json: { amount: 100, status: 'pending' } });
  });
  await login(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('pico-stars-pending-invoice:')) throw new Error('storage blocked');
      return original.call(this, key, value);
    };
    window.Telegram = {
      WebApp: {
        initData: 'mock-native-app',
        openInvoice(url: string) {
          (window as StarsTestWindow).receivedInvoice = url;
        },
      } as NonNullable<NonNullable<Window['Telegram']>['WebApp']>,
    };
  });
  const support = await openSupport(page);
  await support.getByRole('button', { name: 'Поддержать · 100' }).click();
  await expect(support.getByRole('button', { name: 'Отменить счёт' })).toBeVisible();
  expect(await page.evaluate(() => (window as StarsTestWindow).receivedInvoice)).toBeUndefined();
  await support.getByRole('button', { name: 'Отменить счёт' }).click();
  await expect(support.getByRole('button', { name: 'Поддержать · 100' })).toBeEnabled();
});
