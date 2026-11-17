import { expect, Page, test } from '@playwright/test';
import { prepareDemoAuth } from './helpers';

const invoiceId = '659fc36b-5441-45eb-87ef-1324fede8731';
const termsUrl = 'https://pico.example/terms/v1';
const overview = { id: null, enabled: true, termsUrl, lastPayment: null };
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
  return page.getByRole('dialog');
}

async function login(page: Page) {
  await page.route('**/api/me/pico-stars/invoices/active', async (route) => {
    await route.fulfill({ json: overview });
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
    expect(route.request().postDataJSON()).toEqual({ amount: 75, acceptedTermsUrl: termsUrl });
    await route.fulfill({ status: 201, json: { id: invoiceId, url: invoiceUrl } });
  });
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, async (route) => {
    invoiceReads++;
    await route.fulfill({
      json: { amount: 75, status: paid ? 'paid' : 'pending', canCancel: !paid },
    });
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
  for (const invalid of ['1.5', '100,00', '-50', '10001', '100000']) {
    await amount.fill(invalid);
    await expect(amount).toHaveValue(invalid);
    await expect(amount).toHaveAttribute('aria-invalid', 'true');
    await expect(support.getByRole('button', { name: 'Готово' })).toBeDisabled();
  }
  await amount.fill('10000');
  await expect(support.getByRole('button', { name: 'Готово' })).toBeEnabled();
  await support.getByRole('button', { name: '0', exact: true }).click();
  await expect(amount).toHaveValue('100000');
  await expect(support.getByRole('button', { name: 'Готово' })).toBeDisabled();
  await amount.fill('1');
  await expect(support.getByRole('button', { name: 'Готово' })).toBeEnabled();
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
  await expect(support.getByRole('button', { name: 'Поддержать · 75' })).toBeDisabled();
  await expect(support.getByRole('link', { name: 'Прочитать условия' })).toHaveAttribute(
    'href',
    termsUrl,
  );
  await support.getByRole('checkbox').check();
  await support.getByRole('button', { name: 'Поддержать · 75' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as StarsTestWindow).receivedInvoice))
    .toBe(invoiceUrl);
  await page.evaluate(() => (window as StarsTestWindow).onInvoiceClosed?.('paid'));
  await expect.poll(() => invoiceReads).toBeGreaterThan(0);
  const thanks = page.getByRole('dialog', { name: 'Спасибо!', exact: true });
  await expect(thanks).toHaveCount(0);
  await expect(support.getByRole('status')).toContainText('Ожидаем подтверждение Telegram');
  paid = true;
  await expect(thanks.getByText('Вы отправили 75 звёзд на развитие Pico.')).toBeVisible();
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
  await support.getByRole('checkbox').check();
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
    await route.fulfill({
      json: { amount: 100, status: paid ? 'paid' : 'pending', canCancel: !paid },
    });
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
  await support.getByRole('checkbox').check();
  await support.getByRole('button', { name: 'Поддержать · 100' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as StarsTestWindow).receivedInvoice))
    .toBe(invoiceUrl);
  await page.reload();
  const recovered = await openSupport(page);
  await expect(recovered.getByRole('status')).toContainText('Ожидаем подтверждение Telegram');
  await expect(recovered.getByRole('button', { name: 'Поддержать · 100' })).toHaveCount(0);
  expect(created).toBe(1);
  paid = true;
  const thanks = page.getByRole('dialog', { name: 'Спасибо!', exact: true });
  await expect(thanks.getByText('Вы отправили 100 звёзд на развитие Pico.')).toBeVisible();
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
  await support.getByRole('checkbox').check();
  await support.getByRole('button', { name: 'Поддержать · 100' }).click();
  await expect(support.getByRole('button', { name: 'Поддержать · 100' })).toBeDisabled();
  await page.reload();
  const reopened = await openSupport(page);
  await expect(reopened.getByRole('button', { name: 'Поддержать · 100' })).toBeDisabled();
});

test('recovers the server invoice without browser storage and cancels only with server approval', async ({
  page,
}) => {
  await login(page);
  let cancelled = false;
  await page.route('**/api/me/pico-stars/invoices/active', async (route) => {
    await route.fulfill({
      json: {
        ...overview,
        id: cancelled ? null : invoiceId,
        lastPayment: { id: 'earlier-invoice', amount: 50, status: 'paid' },
      },
    });
  });
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, async (route) => {
    await route.fulfill({ json: { amount: 100, status: 'pending', canCancel: true } });
  });
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
  await expect(support.getByRole('heading', { name: 'Последняя оплата' })).toBeVisible();
  await expect(support.getByText('Вы отправили 50 звёзд на развитие Pico.')).toBeVisible();
});

test('without writable browser storage a server-backed invoice still opens in Telegram', async ({
  page,
}) => {
  await page.route('**/api/me/pico-stars/invoices', async (route) => {
    await route.fulfill({ status: 201, json: { id: invoiceId, url: invoiceUrl } });
  });
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, async (route) => {
    await route.fulfill({ json: { amount: 100, status: 'pending', canCancel: true } });
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
  await support.getByRole('checkbox').check();
  await support.getByRole('button', { name: 'Поддержать · 100' }).click();
  await expect(support.getByRole('button', { name: 'Отменить счёт' })).toBeVisible();
  expect(await page.evaluate(() => (window as StarsTestWindow).receivedInvoice)).toBe(invoiceUrl);
  await support.getByRole('button', { name: 'Отменить счёт' }).click();
  await expect(support.getByRole('button', { name: 'Поддержать · 100' })).toBeDisabled();
});

test('fresh session shows the latest settlement, even while new invoices are disabled', async ({
  page,
}) => {
  await login(page);
  let enabled = false;
  let status: 'paid' | 'refunded' = 'paid';
  await page.route('**/api/me/pico-stars/invoices/active', (route) =>
    route.fulfill({
      json: { ...overview, enabled, lastPayment: { id: invoiceId, amount: 1, status } },
    }),
  );
  let panel = await openSupport(page);
  await expect(panel.getByRole('heading', { name: 'Последняя оплата' })).toBeVisible();
  await expect(panel.getByText('Вы отправили 1 звезду на развитие Pico.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Поддержать ещё раз' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'На главную' }).click();
  enabled = true;
  status = 'refunded';
  panel = await openSupport(page);
  await expect(panel.getByText('Сумма возврата — 1 звезда.')).toBeVisible();
  await panel.getByRole('button', { name: 'Поддержать ещё раз' }).click();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Поддержать · 100 звёзд' })).toBeDisabled();
});

test('recovery retries clear obsolete errors and display a reserved invoice with its own amount', async ({
  page,
}, testInfo) => {
  await login(page);
  let attempts = 0;
  await page.route('**/api/me/pico-stars/invoices/active', (route) =>
    ++attempts === 1
      ? route.fulfill({ status: 503, json: { message: 'offline' } })
      : route.fulfill({ json: { ...overview, id: invoiceId } }),
  );
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, (route) =>
    route.fulfill({
      json: { amount: 250, status: 'pending', canCancel: false },
    }),
  );
  const panel = await openSupport(page);
  await expect(panel.getByRole('alert')).toContainText('Не удалось проверить');
  await panel.getByRole('button', { name: 'Проверить предыдущий счёт' }).click();
  await expect(panel.getByRole('status')).toContainText('Счёт на 250 звёзд');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '100 звёзд', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Отменить счёт' })).toHaveCount(0);
  await expect(panel.getByText(/можно обратиться без чека/i)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('восстановленный-счёт.png') });
});

test('opening payment with no SDK callback still permits a manual status check, close and recovery', async ({
  page,
}) => {
  await login(page);
  let reserved = false;
  let paid = false;
  let reads = 0;
  let cancels = 0;
  await page.route('**/api/me/pico-stars/invoices/active', (route) =>
    route.fulfill({ json: { ...overview, id: reserved ? invoiceId : null } }),
  );
  await page.route('**/api/me/pico-stars/invoices', (route) => {
    reserved = true;
    return route.fulfill({ status: 201, json: { id: invoiceId, url: invoiceUrl } });
  });
  await page.route('**/api/me/pico-stars/invoices/*/cancel', (route) => {
    cancels++;
    return route.fulfill({ json: { cancelled: false } });
  });
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, (route) => {
    reads++;
    return route.fulfill({
      json: { amount: 500, status: paid ? 'paid' : 'pending', canCancel: false },
    });
  });
  await page.evaluate(() => {
    window.Telegram = {
      WebApp: {
        initData: 'mock',
        openInvoice(_url: string, cb: (status: InvoiceStatus) => void) {
          (window as StarsTestWindow).onInvoiceClosed = cb;
        },
      } as NonNullable<NonNullable<Window['Telegram']>['WebApp']>,
    };
  });
  let panel = await openSupport(page);
  await panel.getByRole('button', { name: '500 звёзд', exact: true }).click();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Поддержать · 500 звёзд' }).click();
  await expect(panel.getByRole('status')).toContainText('500 звёзд');
  const previous = reads;
  await panel.getByRole('button', { name: 'Проверить оплату' }).click();
  await expect.poll(() => reads).toBeGreaterThan(previous);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => (window as StarsTestWindow).onInvoiceClosed?.('cancelled'));
  panel = await openSupport(page);
  await expect(panel.getByRole('status')).toContainText('500 звёзд');
  paid = true;
  await panel.getByRole('button', { name: 'Проверить оплату' }).click();
  await expect(panel.getByText('Вы отправили 500 звёзд на развитие Pico.')).toBeVisible();
  expect(cancels).toBe(0);
});

test('disabled acceptance hides amount entry; changed terms require fresh consent', async ({
  page,
}) => {
  await login(page);
  let enabled = false;
  let currentTerms = termsUrl;
  await page.route('**/api/me/pico-stars/invoices/active', (route) =>
    route.fulfill({ json: { ...overview, enabled, termsUrl: currentTerms } }),
  );
  let panel = await openSupport(page);
  await expect(panel.getByRole('status')).toHaveText('Приём звёзд сейчас недоступен.');
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Закрыть' }).click();
  enabled = true;
  await page.evaluate(() => {
    window.Telegram = {
      WebApp: {
        initData: 'mock',
        openInvoice() {
          throw new Error('unexpected');
        },
      } as NonNullable<NonNullable<Window['Telegram']>['WebApp']>,
    };
  });
  let posted = 0;
  await page.route('**/api/me/pico-stars/invoices', (route) => {
    posted++;
    expect(route.request().postDataJSON().acceptedTermsUrl).toBe(termsUrl);
    currentTerms = 'HTTPS://pico.example/terms/v2';
    return route.fulfill({ status: 412, json: { message: 'terms changed' } });
  });
  panel = await openSupport(page);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Поддержать · 100 звёзд' }).click();
  await expect(panel.getByRole('link', { name: 'Прочитать условия' })).toHaveAttribute(
    'href',
    currentTerms,
  );
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Поддержать · 100 звёзд' })).toBeDisabled();
  expect(posted).toBe(1);
});

test('lost create response recovers one invoice and clears the creation error; expiry reveals the earlier receipt', async ({
  page,
}) => {
  await login(page);
  let created = 0;
  let expired = false;
  await page.evaluate(() => {
    window.Telegram = {
      WebApp: {
        initData: 'mock',
        openInvoice() {
          throw new Error('unreachable');
        },
      } as NonNullable<NonNullable<Window['Telegram']>['WebApp']>,
    };
  });
  await page.route('**/api/me/pico-stars/invoices', async (route) => {
    created++;
    await route.abort('failed');
  });
  await page.route('**/api/me/pico-stars/invoices/active', (route) =>
    route.fulfill({
      json: {
        ...overview,
        id: created && !expired ? invoiceId : null,
        lastPayment: expired ? { id: 'earlier', amount: 75, status: 'paid' } : null,
      },
    }),
  );
  let statusAvailable = false;
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, (route) =>
    statusAvailable
      ? route.fulfill({
          json: { amount: 500, status: expired ? 'expired' : 'pending', canCancel: false },
        })
      : route.fulfill({ status: 503, json: { message: 'offline' } }),
  );
  const panel = await openSupport(page);
  await panel.getByRole('button', { name: '500 звёзд', exact: true }).click();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Поддержать · 500 звёзд' }).click();
  await expect(panel.getByRole('status')).toContainText('Не удалось получить статус');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  statusAvailable = true;
  await panel.getByRole('button', { name: 'Проверить оплату' }).click();
  await expect(panel.getByRole('status')).toContainText('Счёт на 500 звёзд.');
  expired = true;
  await panel.getByRole('button', { name: 'Проверить оплату' }).click();
  await expect(panel.getByRole('heading', { name: 'Последняя оплата' })).toBeVisible();
  await expect(panel.getByText('Вы отправили 75 звёзд на развитие Pico.')).toBeVisible();
  expect(created).toBe(1);
});

test('a saved attempt is resolved separately from another last receipt on this device', async ({
  page,
}) => {
  await login(page);
  const earlierId = '12c8846f-f70a-4cc7-a958-4268a1e762fd';
  let savedStatus: 'expired' | 'paid' = 'expired';
  let reads = 0;
  let lastAmount = 75;
  await page.route('**/api/me/pico-stars/invoices/active', (route) =>
    route.fulfill({
      json: {
        ...overview,
        lastPayment: { id: earlierId, amount: lastAmount, status: 'paid' },
      },
    }),
  );
  await page.route(`**/api/me/pico-stars/invoices/${invoiceId}`, (route) => {
    reads++;
    return route.fulfill({ json: { amount: 500, status: savedStatus, canCancel: false } });
  });
  async function saveAttempt(saved = invoiceId) {
    await expect(page.getByRole('group', { name: 'Дополнительные действия' })).toBeVisible();
    await page.evaluate(async (id) => {
      const me = await fetch('/api/me', {
        headers: { Authorization: 'Bearer ' + sessionStorage.getItem('crm-session') },
      });
      const actor = await me.json();
      localStorage.setItem('pico-stars-pending-invoice:' + actor.id, id);
    }, saved);
  }
  await saveAttempt();
  let panel = await openSupport(page);
  await expect(panel.getByText('Вы отправили 75 звёзд на развитие Pico.')).toBeVisible();
  await expect(
    panel.getByText('Счёт на 500 звёзд закрыт без подтверждённой оплаты.'),
  ).toBeVisible();
  expect(reads).toBe(1);
  await panel.getByRole('button', { name: 'На главную' }).click();
  savedStatus = 'paid';
  lastAmount = 250;
  await saveAttempt();
  panel = await openSupport(page);
  await expect(panel.getByRole('heading', { name: 'Последняя оплата' })).toBeVisible();
  await expect(panel.getByText('Вы отправили 250 звёзд на развитие Pico.')).toBeVisible();
  await expect(panel.getByText('Сохранённый счёт на 500 звёзд оплачен.')).toBeVisible();
  expect(reads).toBe(2);
  await panel.getByRole('button', { name: 'На главную' }).click();
  await saveAttempt('invalid-cache-entry');
  panel = await openSupport(page);
  await expect(panel.getByRole('heading', { name: 'Последняя оплата' })).toBeVisible();
  await expect(panel.getByText('Вы отправили 250 звёзд на развитие Pico.')).toBeVisible();
  expect(reads).toBe(2);
});
