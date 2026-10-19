import { expect, Page } from '@playwright/test';
const demoSessions = new Map<string, unknown>();
export async function prepareDemoAuth(page: Page) {
  await page.route('**/api/auth/dev', async (route) => {
    const role = route.request().postDataJSON().role as string;
    const workerCacheKey = `PICO_E2E_DEMO_SESSION_${role}`;
    if (!demoSessions.has(role) && process.env[workerCacheKey])
      demoSessions.set(role, JSON.parse(process.env[workerCacheKey]!));
    if (!demoSessions.has(role)) {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const session = await response.json();
      demoSessions.set(role, session);
      process.env[workerCacheKey] = JSON.stringify(session);
    }
    await route.fulfill({ json: demoSessions.get(role) });
  });
}
export async function navigate(page: Page, name: string) {
  await expect(page.locator('.app-shell')).toBeVisible();
  const primary = page.locator('nav:visible').getByRole('button', { name, exact: true }).first();
  if (await primary.count()) await primary.click();
  else if (await page.locator('.pico-secondary-nav:visible').count())
    await page
      .locator('.pico-secondary-nav:visible')
      .getByRole('button', { name, exact: true })
      .click();
  else {
    await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    await page.locator('.pico-more-menu').getByRole('button', { name, exact: true }).click();
  }
}
export async function clients(page: Page) {
  await navigate(page, 'Клиенты');
  await expect(page.getByRole('heading', { name: 'Клиенты', exact: true })).toBeVisible();
}
export async function openCompany(page: Page, name: string) {
  const row = page
    .locator('.pico-client-accordion')
    .filter({ has: page.locator('strong', { hasText: name }) });
  if ((await row.locator('.pico-client-row').getAttribute('aria-expanded')) !== 'true')
    await row.locator('.pico-client-row').click();
  await row.getByRole('button', { name: 'Задачи и проекты', exact: true }).click();
}

export async function action(page: Page, name: string) {
  const direct = page.getByRole('button', { name, exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    await page.locator('.pico-more-menu').getByRole('button', { name, exact: true }).click();
  }
}

export async function saveNewClientAndOpen(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
  const name = await dialog.getByLabel('Название', { exact: true }).inputValue();
  await dialog.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openCompany(page, name);
}
export async function pickInline(
  page: Page,
  dialog: import('@playwright/test').Locator,
  label: string,
  name: string,
) {
  const row = dialog.locator('.pico-picker-row').filter({
    has: page.locator('.pico-picker-row-label', { hasText: new RegExp('^' + label + '$') }),
  });
  await row.getByRole('button').click();
  await dialog
    .locator('.pico-inline-picker, .pico-client-picker')
    .getByRole('button')
    .filter({ hasText: name })
    .first()
    .click();
}

export async function openCompanySection(page: Page, section: 'summary' | 'actions') {
  const disclosure = page
    .getByRole('dialog')
    .locator(section === 'summary' ? '.company-detail-summary' : '.company-detail-actions');
  if ((await disclosure.getAttribute('open')) === null)
    await disclosure.locator(':scope > summary').click();
}

// Exercise the real session-expiry path without a user-facing logout action.
export async function expireSession(page: Page) {
  await page.route(
    '**/api/me',
    (route) => route.fulfill({ status: 401, json: { message: 'Сессия истекла' } }),
    { times: 1 },
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Pico', exact: true })).toBeVisible();
}
