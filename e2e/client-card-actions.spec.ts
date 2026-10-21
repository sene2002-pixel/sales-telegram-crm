import { expect, test, Locator, Page } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';
async function swipe(page: Page, cell: Locator, left = true) {
  await cell.scrollIntoViewIfNeeded();
  const box = (await cell.boundingBox())!;
  const y = Math.max(
    box.y + 5,
    Math.min(page.viewportSize()!.height - 100, box.y + box.height / 2),
  );
  const x = box.x + box.width * (left ? 0.8 : 0.2);
  const end = box.x + box.width * (left ? 0.2 : 0.8);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + ((end - x) * i) / 6, y }],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
for (const { width, role } of [
  { width: 390, role: 'admin' },
  { width: 1440, role: 'admin' },
  { width: 390, role: 'manager' },
])
  test(`deliberate swipe is the only entry to client/contact actions at ${width} for ${role}`, async ({
    page,
  }, info) => {
    test.skip(
      width > 760 && info.project.name === 'mobile',
      'Mobile app intentionally locks landscape orientation',
    );
    await page.setViewportSize({ width, height: 900 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '', contentType: 'application/javascript' }),
    );
    const now = new Date().toISOString();
    let company: any = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'QA Swipe',
      inn: '7707083893',
      city: 'Москва',
      segment: 'end_client',
      industry: '',
      stage: 'new',
      archived: false,
      revenue: null,
      potential: null,
      divisions: { lv: 0 },
      notes: 'QA note',
      ownerId: 'owner',
      ownerName: 'QA',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    let contact: any = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'contact',
      version: 1,
      companyId: company.id,
      data: { name: 'QA Person', role: 'QA Role', phone: '+79990000001', email: 'qa@example.test' },
      createdAt: now,
    };
    let saved = 0;
    let editorConflict = true;
    let fail = true;
    await page.route('**/api/companies**', async (r) => {
      const p = new URL(r.request().url()).pathname;
      if (p === '/api/companies') return r.fulfill({ json: [company] });
      if (p.endsWith('/editor')) {
        const body = r.request().postDataJSON();
        expect(body.contacts[0].id).toBe(contact.id);
        if (editorConflict) {
          editorConflict = false;
          company = { ...company, version: 2 };
          contact = { ...contact, version: 2 };
          return r.fulfill({ status: 409, json: { message: 'QA company conflict' } });
        }
        expect(body.version).toBe(2);
        expect(body.contacts[0].version).toBe(2);
        company = { ...company, ...body.data, version: 2 };
        saved++;
        return r.fulfill({ json: company });
      }
      if (p === `/api/companies/${company.id}`)
        return r.fulfill({ json: { company, records: [contact], audit: [], holdingMembers: [] } });
      return r.continue();
    });
    await page.route(`**/api/records/${contact.id}`, async (r) => {
      if (fail) {
        fail = false;
        return r.fulfill({ status: 400, json: { message: 'QA retry error' } });
      }
      contact = { ...contact, ...r.request().postDataJSON(), version: 2 };
      return r.fulfill({ json: contact });
    });
    await page.goto('/');
    await page
      .getByRole('button', { name: role === 'admin' ? 'Администратор' : 'Менеджер', exact: true })
      .click();
    await navigate(page, 'Клиенты');
    const card = page.locator('.cc-card').filter({ hasText: 'QA Swipe' });
    const outer = card.locator(':scope > .cc-swipe');
    const actions = outer.locator(':scope > .cc-trash-track');
    await card.hover();
    await expect(actions).toBeHidden();
    await outer.focus();
    await expect(actions).toBeHidden();
    await outer.press('ArrowLeft');
    await expect(actions).toBeVisible();
    await outer.press('ArrowRight');
    await expect(actions).toBeHidden();
    if (width > 760) {
      const rect = (await outer.boundingBox())!;
      await page.mouse.move(rect.x + rect.width * 0.8, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(actions).toBeVisible();
      await outer.focus();
      await outer.press('ArrowRight');
      await expect(actions).toBeHidden();
    }
    await card.locator('.pico-client-row').focus();
    await expect(actions).toBeHidden();
    await card.locator('.pico-client-row').click();
    await expect(actions).toBeHidden();
    await expect(card.locator('.cc-section').first()).toContainText('Не указан');
    await card.locator('.pico-client-row').click();
    await swipe(page, outer);
    await expect(actions).toBeVisible();
    await expect(actions.getByRole('button')).toHaveCount(role === 'admin' ? 2 : 1);
    const edit = actions.getByRole('button', { name: /Редактировать/ });
    expect((await edit.boundingBox())!.width).toBe(56);
    await edit.click();
    const sheet = page.getByRole('dialog', { name: 'Редактирование карточки' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'Название', exact: true })).toHaveValue(
      'QA Swipe',
    );
    await sheet.getByText('Дополнительные поля', { exact: true }).click();
    await expect(sheet.getByRole('textbox', { name: 'Контакт', exact: true })).toHaveValue(
      'QA Person',
    );
    await sheet.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
    await expect(sheet.getByRole('alert')).toContainText('QA company conflict');
    await expect(sheet.getByRole('textbox', { name: 'Название', exact: true })).toHaveValue(
      'QA Swipe',
    );
    await sheet.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
    await expect(sheet).toBeHidden();
    expect(saved).toBe(1);
    if ((await card.locator('.pico-client-row').getAttribute('aria-expanded')) === 'false')
      await card.locator('.pico-client-row').click();
    await card
      .locator('summary')
      .filter({ hasText: /^Контакты/ })
      .click();
    const cs = card
      .locator('.cc-swipe')
      .filter({ has: page.locator('.cc-contact') })
      .last();
    await expect(card.locator('.cc-contact-columns > div')).toHaveCount(2);
    await swipe(page, cs);
    await cs
      .locator(':scope > .cc-trash-track')
      .getByRole('button', { name: /Редактировать/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Контакт', exact: true });
    await expect(dialog.getByRole('textbox', { name: 'Контакт · ФИО', exact: true })).toHaveValue(
      'QA Person',
    );
    await dialog.getByRole('textbox', { name: 'Контакт · ФИО', exact: true }).fill('QA Updated');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('QA retry error');
    await expect(dialog.getByRole('textbox', { name: 'Контакт · ФИО', exact: true })).toHaveValue(
      'QA Updated',
    );
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(card.locator('.cc-contact-name')).toContainText('QA Updated');
    await outer.focus();
    await outer.press('ArrowLeft');
    await expect(actions).toBeVisible();
    await outer.press('ArrowRight');
    await expect(actions).toBeHidden();
  });
test('new client validation keeps visible readable errors for INN and equipment', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
    r.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await navigate(page, 'Клиенты');
  await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
  await dialog.getByRole('textbox', { name: 'ИНН', exact: true }).fill('123');
  await dialog.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  const error = dialog.locator('#company-error-inn');
  await expect(error).toBeVisible();
  await expect(error).toHaveCSS('font-size', '12px');
  await expect(error).toHaveCSS('font-weight', '500');
  await dialog.getByRole('textbox', { name: 'ИНН', exact: true }).fill('7707083893');
  await dialog.getByRole('textbox', { name: 'Название', exact: true }).fill('QA validation');
  await dialog.getByText('Потенциал', { exact: true }).click();
  const amount = dialog.getByRole('spinbutton').first();
  await amount.fill('1000001');
  await dialog.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  await expect(dialog.locator('#company-error-divisions')).toBeVisible();
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  await page.screenshot({ path: info.outputPath('new-client-validation.png') });
});
