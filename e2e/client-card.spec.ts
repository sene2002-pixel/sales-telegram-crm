import { expect, Locator, Page, test } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';
import { Company, CompanyDetail, companySchema } from '../src/shared/contracts';

async function setup(page: Page) {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ body: '' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
  await clients(page);
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const headers = { Authorization: `Bearer ${token}` };
  const created = await page.request.post('/api/companies', {
    headers,
    data: {
      name: `Integration ${Date.now()}-${test.info().project.name}`,
      city: 'Томск',
      notes: 'Исходная заметка',
      potential: 1_000_000,
      divisions: { lv: 1_000_000 },
    },
  });
  expect(created.ok()).toBeTruthy();
  const company: Company = await created.json();
  const added = await page.request.post(`/api/companies/${company.id}/records/contact`, {
    headers,
    data: {
      data: {
        name: 'Иван Тестовый',
        role: 'Инженер',
        phone: '+79991234567',
        email: 'ivan@example.test',
      },
    },
  });
  expect(added.ok()).toBeTruthy();
  const contact = await added.json();
  await action(page, 'Обновить');
  const card = page.locator('.cc-card').filter({ hasText: company.name });
  await card.locator('.pico-client-row').click();
  await expect(card.locator('.cc-section')).toHaveCount(5);
  async function fresh(): Promise<CompanyDetail> {
    const response = await page.request.get(`/api/companies/${company.id}`, { headers });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async function concurrent(update: Partial<Company>) {
    const before = (await fresh()).company;
    const response = await page.request.patch(`/api/companies/${company.id}`, {
      headers,
      data: {
        version: before.version,
        data: companySchema.strip().parse({ ...before, ...update }),
      },
    });
    expect(response.ok()).toBeTruthy();
    const saved: Company = await response.json();
    const reload = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/companies' && r.request().method() === 'GET',
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await reload;
    await expect(card.locator('.pico-client-metadata')).toContainText(saved.city);
    return saved;
  }
  return { headers, company, contact, card, fresh, concurrent };
}

for (const target of ['notes', 'equipment', 'new-equipment'] as const) {
  test(`${target} keeps its opening snapshot through refresh and repeated conflicts`, async ({
    page,
  }) => {
    const { card, fresh, concurrent, company } = await setup(page);
    let editor: Locator;
    if (target === 'notes') {
      await card
        .locator('.cc-section > summary')
        .filter({ hasText: /^Заметки/ })
        .click();
      await card.getByRole('button', { name: 'Изменить Заметки о клиенте', exact: true }).click();
      editor = card
        .locator('form')
        .filter({ has: page.getByRole('textbox', { name: 'Заметки о клиенте', exact: true }) });
      await editor.getByRole('textbox').fill('Мой незавершённый текст');
    } else if (target === 'equipment') {
      await card.getByRole('button', { name: 'Изменить Выключатели 0,4 кВ', exact: true }).click();
      editor = card
        .locator('.cc-amount-group')
        .filter({ has: page.getByRole('textbox', { name: 'Выключатели 0,4 кВ', exact: true }) });
      await editor.getByRole('textbox').fill('2,5');
    } else {
      await card.getByRole('button', { name: 'Добавить оборудование', exact: true }).click();
      editor = card
        .locator('form')
        .filter({ has: page.getByRole('textbox', { name: 'Потенциал, млн ₽', exact: true }) });
      await editor.getByRole('textbox').fill('2,5');
    }
    const concurrentCompany = await concurrent({
      city: 'Омск',
      notes: 'Параллельная заметка',
      divisions: { lv: 3_000_000 },
      potential: 3_000_000,
    });
    const versions: number[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === `/api/companies/${company.id}` && r.method() === 'PATCH')
        versions.push(r.postDataJSON().version);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/companies/${company.id}` &&
          r.request().method() === 'PATCH',
      );
      if (target === 'equipment') {
        await editor.getByRole('textbox').focus();
        await editor.getByRole('textbox').press('Tab');
      } else {
        await editor
          .getByRole('button', {
            name: target === 'new-equipment' ? 'Добавить' : 'Сохранить',
            exact: true,
          })
          .click();
      }
      expect((await response).status()).toBe(409);
      await expect(editor.getByRole('alert')).toBeVisible();
      await expect(editor.getByRole('textbox')).toHaveValue(
        target === 'notes' ? 'Мой незавершённый текст' : '2,5',
      );
    }
    expect(versions).toEqual([company.version, company.version]);
    const saved = (await fresh()).company;
    expect(saved.version).toBe(concurrentCompany.version);
    expect(saved.notes).toBe('Параллельная заметка');
    expect(saved.divisions).toEqual({ lv: 3_000_000 });
    expect(saved.potential).toBe(3_000_000);
  });
}

async function editSwipe(cell: Locator) {
  await cell.focus();
  await cell.press('ArrowLeft');
  await cell
    .locator(':scope > .cc-trash-track')
    .getByRole('button', { name: /Редактировать/ })
    .click();
}
async function checkSheet(page: Page, sheet: Locator, save: Locator, screenshot: string) {
  await expect(sheet).toHaveClass(/client-sheet/);
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await expect(sheet.locator(':scope > .section-head')).toBeInViewport();
  const bounds = await sheet.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await page.screenshot({ path: screenshot });
}

test('company and contact sheets keep their headers and save reachable; contact retains 429 input', async ({
  page,
}, info) => {
  const { card, company, contact, fresh } = await setup(page);
  await editSwipe(card.locator(':scope > .cc-swipe'));
  const companySheet = page.getByRole('dialog', { name: 'Редактирование карточки', exact: true });
  await companySheet.getByRole('textbox', { name: 'Город', exact: true }).fill('Казань');
  await companySheet.getByText('Дополнительные поля', { exact: true }).click();
  const companySave = companySheet.getByRole('button', { name: 'Сохранить клиента', exact: true });
  // Telegram can report a smaller usable viewport while layout viewport stays tall.
  await page.evaluate(() => {
    const style = document.documentElement.style;
    style.setProperty('--pico-view-height', '460px');
    style.setProperty('--pico-safe-top', '20px');
    style.setProperty('--pico-safe-bottom', '12px');
  });
  expect((await companySheet.boundingBox())!.height).toBeLessThanOrEqual(404);

  await checkSheet(
    page,
    companySheet,
    companySave,
    `/tmp/client-card-integrated-company-${info.project.name}.png`,
  );
  await companySave.click();
  await expect(companySheet).toBeHidden();
  expect((await fresh()).company.city).toBe('Казань');
  await card
    .locator('.cc-section > summary')
    .filter({ hasText: /^Контакты/ })
    .click();
  await editSwipe(
    card
      .locator('.cc-swipe')
      .filter({ has: page.locator('.cc-contact') })
      .last(),
  );
  const sheet = page.getByRole('dialog', { name: 'Контакт', exact: true });
  const phone = sheet.getByRole('textbox', { name: 'Контакт · Телефон', exact: true });
  await phone.fill('+79990001122');
  const save = sheet.getByRole('button', { name: 'Сохранить', exact: true });
  await checkSheet(
    page,
    sheet,
    save,
    `/tmp/client-card-integrated-contact-${info.project.name}.png`,
  );
  await page.route(
    `**/api/records/${contact.id}`,
    async (route) => {
      if (route.request().method() === 'PATCH')
        await route.fulfill({
          status: 429,
          json: { message: 'Слишком много запросов. Повторите позже' },
        });
      else await route.continue();
    },
    { times: 1 },
  );
  await save.click();
  await expect(sheet.getByRole('alert')).toContainText('Слишком много запросов');
  await expect(phone).toHaveValue('+79990001122');
  expect((await fresh()).records.find((r) => r.id === contact.id)?.data.phone).toBe('+79991234567');
  await save.click();
  await expect(sheet).toBeHidden();
  expect((await fresh()).records.find((r) => r.id === contact.id)?.data.phone).toBe('+79990001122');
  expect((await fresh()).company.id).toBe(company.id);
});
