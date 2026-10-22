import { test, expect, Page } from '@playwright/test';
import { companySchema } from '../src/shared/contracts';
import { prepareDemoAuth, clients, openCompany, openCompanySection } from './helpers';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
    r.fulfill({ body: '', contentType: 'application/javascript' }),
  );
});
async function setup(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const api = async (path: string, data?: unknown, method = data ? 'POST' : 'GET') => {
    const response = await page.request.fetch('/api' + path, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
    return response.json();
  };
  const company = await api('/companies', {
    name: `Concurrency ${Date.now()}`,
    city: 'Казань',
    notes: 'Исходные заметки',
  });
  const contact = await api(`/companies/${company.id}/records/contact`, {
    data: { name: 'Исходный контакт', phone: '+79991112233', role: 'Инженер', email: '' },
  });
  const row = page.locator('.cc-card').filter({ hasText: company.name });
  await page.reload();
  await clients(page);
  return { api, company, contact, row };
}
async function revealEdit(swipe: ReturnType<Page['locator']>) {
  await swipe.focus();
  await swipe.press('ArrowLeft');
  await swipe
    .locator(':scope > .cc-trash-track')
    .getByRole('button', { name: /Редактировать/ })
    .click();
}
for (const mode of ['legacy', 'row', 'contact'] as const)
  test(`Real concurrent ${mode} editor retains stale draft and never overwrites newer facts on retry`, async ({
    page,
  }) => {
    const { api, company, contact, row } = await setup(page);
    if (mode === 'legacy') {
      await openCompany(page, company.name);
      await openCompanySection(page, 'actions');
      await page.getByRole('button', { name: 'Редактировать компанию', exact: true }).click();
    } else if (mode === 'row') await revealEdit(row.locator(':scope > .cc-swipe'));
    else {
      await row.locator('.pico-client-row').click();
      await row
        .locator('.cc-section > summary')
        .filter({ hasText: /^Контакты/ })
        .click();
      await revealEdit(
        row
          .locator('.cc-swipe')
          .filter({ has: page.locator('.cc-contact', { hasText: 'Исходный контакт' }) }),
      );
    }
    const dialog = page.getByRole('dialog');
    const field =
      mode === 'contact'
        ? dialog.getByRole('textbox', { name: 'Контакт · Телефон', exact: true })
        : dialog.getByLabel('Город', { exact: true });
    const draft = mode === 'contact' ? '+79990000001' : 'Москва';
    await field.fill(draft);
    const latest = await api(`/companies/${company.id}`);
    const data = companySchema.parse(
      Object.fromEntries(
        Object.keys(companySchema.shape)
          .filter((k) => k in latest.company)
          .map((k) => [k, latest.company[k]]),
      ),
    );
    await api(
      `/companies/${company.id}`,
      {
        version: latest.company.version,
        data: { ...data, notes: 'Подтверждённые новые заметки B' },
      },
      'PATCH',
    );
    await api(
      `/records/${contact.id}`,
      {
        version: contact.version,
        data: { ...contact.data, phone: '+79998887766', role: 'Новая должность B' },
      },
      'PATCH',
    );
    const save = dialog.getByRole('button', {
      name: mode === 'contact' ? 'Сохранить' : 'Сохранить клиента',
      exact: true,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const conflict = page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && r.status() === 409,
      );
      await save.click();
      await conflict;
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(field).toHaveValue(draft);
    }
    const after = await api(`/companies/${company.id}`);
    expect(after.company.notes).toBe('Подтверждённые новые заметки B');
    expect(after.company.city).toBe('Казань');
    expect(after.records.find((r: any) => r.id === contact.id).data).toMatchObject({
      phone: '+79998887766',
      role: 'Новая должность B',
    });
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    if (mode === 'legacy') {
      await openCompany(page, company.name);
      await openCompanySection(page, 'actions');
      await page.getByRole('button', { name: 'Редактировать компанию', exact: true }).click();
    } else if (mode === 'row') await revealEdit(row.locator(':scope > .cc-swipe'));
    else
      await revealEdit(
        row
          .locator('.cc-swipe')
          .filter({ has: page.locator('.cc-contact', { hasText: 'Исходный контакт' }) }),
      );
    const reopened = page.getByRole('dialog');
    if (mode === 'contact') {
      await expect(
        reopened.getByRole('textbox', { name: 'Контакт · Телефон', exact: true }),
      ).toHaveValue('+79998887766');
      await expect(
        reopened.getByRole('textbox', { name: 'Контакт · Должность', exact: true }),
      ).toHaveValue('Новая должность B');
    } else {
      await expect(reopened.getByLabel('Город', { exact: true })).toHaveValue('Казань');
      await reopened
        .locator('.company-form-accordion > summary')
        .filter({ hasText: /^Дополнительные поля/ })
        .click();
      await expect(reopened.getByLabel('Комментарий', { exact: true })).toHaveValue(
        'Подтверждённые новые заметки B',
      );
    }
  });

test('Legacy company editor saves with 21 contacts without dropping unchanged contacts', async ({
  page,
}) => {
  const { api, company, contact } = await setup(page);
  for (let i = 1; i < 21; i++)
    await api(`/companies/${company.id}/records/contact`, {
      data: { name: `Дополнительный контакт ${i}`, phone: '', role: '', email: '' },
    });
  const before = await api(`/companies/${company.id}`);
  await page.reload();
  await clients(page);
  await openCompany(page, company.name);
  await openCompanySection(page, 'actions');
  await page.getByRole('button', { name: 'Редактировать компанию', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Город', { exact: true }).fill('Москва');
  await dialog
    .locator('.company-form-accordion > summary')
    .filter({ hasText: /^Дополнительные поля/ })
    .click();
  await dialog.locator('input[value="Исходный контакт"]').fill('Изменённый первый контакт');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/companies/${company.id}/editor`) && r.request().method() === 'PATCH',
  );
  await dialog.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  const after = await api(`/companies/${company.id}`);
  expect(after.company.city).toBe('Москва');
  const contacts = after.records.filter((r: any) => r.kind === 'contact');
  expect(contacts).toHaveLength(21);
  expect(contacts.find((r: any) => r.id === contact.id).data.name).toBe(
    'Изменённый первый контакт',
  );
  for (const original of before.records.filter(
    (r: any) => r.kind === 'contact' && r.id !== contact.id,
  ))
    expect(contacts.find((r: any) => r.id === original.id)).toMatchObject({
      version: original.version,
      data: original.data,
    });
});
