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
  await row.locator('.pico-client-row').click();
  await row.getByRole('button', { name: 'Карточка клиента', exact: true }).click();
}

export async function action(page: Page, name: string) {
  const direct = page.getByRole('button', { name, exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    await page.locator('.pico-more-menu').getByRole('button', { name, exact: true }).click();
  }
}
