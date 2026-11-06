import { expect, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

for (const role of ['supervisor', 'admin'] as const) {
  test(`${role}: team invitation lifecycle, failure recovery and responsive layout`, async ({
    page,
  }, info) => {
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
      route.fulfill({ body: '', contentType: 'application/javascript' }),
    );
    const id = '334a8151-68d5-4cbe-a189-d44609281710';
    const target = '334a8151-68d5-4cbe-a189-d44609281711';
    let items: unknown[] = [],
      failCreate = true;
    await page.route('**/api/team-invitations**', async (route) => {
      if (route.request().url().endsWith('/revoke')) {
        items = [
          {
            id,
            supervisorId: target,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            usedAt: null,
            revokedAt: new Date().toISOString(),
          },
        ];
        return route.fulfill({ json: { ok: true } });
      }
      if (route.request().method() === 'GET') return route.fulfill({ json: items });
      expect(route.request().postDataJSON()).toEqual(
        role === 'admin' ? { supervisorId: target } : {},
      );
      if (failCreate) {
        failCreate = false;
        return route.fulfill({ status: 503, json: { message: 'Сервис временно недоступен' } });
      }
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      items = [
        {
          id,
          supervisorId: target,
          createdAt: new Date().toISOString(),
          expiresAt,
          usedAt: null,
          revokedAt: null,
        },
      ];
      return route.fulfill({
        json: {
          id,
          expiresAt,
          url: 'https://t.me/PicoTestBot?start=invite_fixture-only-not-a-real-token',
        },
      });
    });
    if (role === 'admin')
      await page.route('**/api/users', async (route) => {
        const response = await route.fetch();
        const users = await response.json();
        return route.fulfill({
          json: [
            ...users,
            {
              id: target,
              telegramId: '123456789',
              name: 'Руководитель приглашений',
              role: 'supervisor',
              active: true,
            },
          ],
        });
      });
    await page.goto('/');
    await page
      .getByRole('button', {
        name: role === 'admin' ? 'Администратор' : 'Руководитель',
        exact: true,
      })
      .click();
    await navigate(page, role === 'admin' ? 'Пользователи' : 'Команда');
    const panel = page.getByRole('region', { name: 'Приглашения в команду' });
    await expect(panel.getByText('Приглашений пока нет')).toBeVisible();
    if (role === 'admin') {
      await expect(panel.getByRole('button', { name: 'Создать приглашение' })).toBeDisabled();
      await panel.getByLabel('Команда руководителя').selectOption(target);
    }
    await panel.getByRole('button', { name: 'Создать приглашение' }).click();
    await expect(panel.getByRole('alert')).toHaveText('Сервис временно недоступен');
    await panel.getByRole('button', { name: 'Создать приглашение' }).click();
    const link = panel.getByLabel('Пригласительная ссылка');
    await expect(link).toHaveValue(/https:\/\/t.me\/PicoTestBot/);
    await expect(panel.getByText('Ожидает сотрудника')).toBeVisible();
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('denied');
          },
        },
      }),
    );
    await panel.getByRole('button', { name: 'Скопировать ссылку' }).click();
    await expect(panel.getByRole('status')).toHaveText('Скопируйте выделенную ссылку вручную');
    await expect(link).toBeFocused();
    for (const width of info.project.name === 'mobile' ? [320, 390] : [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBeTruthy();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `/tmp/pico-invitations-${role}-${info.project.name}-${width}.png`,
      });
    }
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('invite_fixture');
    await panel.getByRole('button', { name: 'Отозвать' }).click();
    await expect(link).toHaveCount(0);
    await expect(panel.getByText('Отозвано', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Пригласительная ссылка')).toHaveCount(0);
  });
}
