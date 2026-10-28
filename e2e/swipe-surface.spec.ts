import { expect, Locator, test } from '@playwright/test';
import { action, clients, prepareDemoAuth } from './helpers';
import { companySchema } from '../src/shared/contracts';

async function reveal(row: Locator) {
  await row.scrollIntoViewIfNeeded();
  await row.hover({ position: { x: (await row.boundingBox())!.width - 25, y: 25 } });
  const bounds = (await row.boundingBox())!;
  const page = row.page();
  const y = Math.min(bounds.y + 25, page.viewportSize()!.height - 100);
  await page.mouse.move(bounds.x + bounds.width - 25, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 110, y, { steps: 8 });
  await page.mouse.up();
  await expect(row).toHaveClass(/cc-revealed/);
}
async function close(row: Locator) {
  await row.focus();
  await row.press('Escape');
  await row.evaluate((el) => (el as HTMLElement).blur());
}

for (const width of [320, 390]) {
  test(`swipe moves the complete client surface and nested rows at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Руководитель', exact: true }).click();
    await clients(page);
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const headers = { Authorization: `Bearer ${token}` };
    const response = await page.request.post('/api/companies', {
      headers,
      data: {
        name: `ГРАНДМОТОРС ${Date.now()}`,
        city: 'Москва',
        potential: 12_000_000,
        divisions: { lv: 12_000_000 },
      },
    });
    expect(response.ok()).toBeTruthy();
    const company = await response.json();
    await page.request.post(`/api/companies/${company.id}/records/contact`, {
      headers,
      data: {
        data: {
          name: 'Иван Тестовый',
          phone: '+79991234567',
          role: 'Инженер',
          email: 'ivan@example.test',
        },
      },
    });
    const upload = await page.request.post(`/api/companies/${company.id}/files`, {
      headers,
      multipart: {
        category: 'docs',
        file: {
          name: 'Спецификация.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Test specification'),
        },
      },
    });
    expect(upload.ok()).toBeTruthy();
    await action(page, 'Обновить');
    const card = page.locator('.cc-card').filter({ hasText: company.name });
    const row = card.locator(':scope > .cc-swipe');
    const surface = row.locator(':scope > .cc-swipe-content');
    const before = await surface.boundingBox();
    await expect(row.locator(':scope > .cc-trash-track')).toBeHidden();
    await reveal(row);
    await expect(surface).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -112, 0)');
    await expect(card).toHaveCSS('box-shadow', 'none');
    await expect(card).toHaveCSS('outline-style', 'none');
    await expect(surface).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(surface).toHaveCSS('border-radius', '20px');
    await expect(surface).toHaveCSS('box-shadow', 'rgb(230, 235, 243) 0px 0px 0px 1px inset');
    await expect(row).toHaveCSS('background-color', 'rgb(243, 246, 251)');
    const buttons = row.locator(':scope > .cc-trash-track button');
    await expect(buttons).toHaveCount(2);
    for (const button of await buttons.all()) {
      await expect(button).toHaveCSS('width', '56px');
      await expect(button).toHaveCSS('color', 'rgb(107, 115, 144)');
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    const after = await surface.boundingBox();
    expect(after!.width).toBe(before!.width);
    expect(after!.x).toBeCloseTo(before!.x - 112, 0);
    await page.screenshot({
      path: `/tmp/pico-swipe-evidence/collapsed-${width}-${info.project.name}.png`,
    });
    await close(row);
    await expect(surface).toHaveCSS('transform', 'none');
    await card.locator('.pico-client-row').click();
    await expect(card.locator('.cc-section')).toHaveCount(5);
    await reveal(row);
    await expect(surface).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -112, 0)');
    await page.screenshot({
      path: `/tmp/pico-swipe-evidence/expanded-${width}-${info.project.name}.png`,
    });
    await close(row);
    await card
      .locator('.cc-section > summary')
      .filter({ hasText: /^Контакты/ })
      .click();
    const contact = card
      .locator('.cc-swipe')
      .filter({ has: page.locator('.cc-contact') })
      .last();
    await reveal(contact);
    await expect(contact.locator(':scope > .cc-swipe-content')).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, -112, 0)',
    );
    await expect(row).not.toHaveClass(/cc-revealed/);
    await expect(surface).toHaveCSS('transform', 'none');
    await page.screenshot({
      path: `/tmp/pico-swipe-evidence/contact-${width}-${info.project.name}.png`,
    });
    await close(contact);
    const equipment = card
      .locator('.cc-swipe')
      .filter({ has: page.locator('.cc-equipment') })
      .last();
    await reveal(equipment);
    await expect(equipment.locator(':scope > .cc-swipe-content')).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, -56, 0)',
    );
    await expect(equipment.locator(':scope > .cc-trash-track button')).toHaveCSS('width', '56px');
    await page.screenshot({
      path: `/tmp/pico-swipe-evidence/equipment-${width}-${info.project.name}.png`,
    });

    await close(equipment);
    await card
      .locator('.cc-section > summary')
      .filter({ hasText: /^Файлы/ })
      .click();
    const file = card
      .locator('.cc-swipe')
      .filter({ has: page.locator('.cc-file') })
      .last();
    await reveal(file);
    await expect(file.locator(':scope > .cc-swipe-content')).toHaveCSS(
      'transform',
      'matrix(1, 0, 0, 1, -56, 0)',
    );
    await expect(file.locator(':scope > .cc-trash-track button')).toHaveCSS('width', '56px');
    await page.screenshot({
      path: `/tmp/pico-swipe-evidence/file-${width}-${info.project.name}.png`,
    });
    await close(file);
    // Keyboard alternative remains available with a visible focus indicator.
    await row.focus();
    await row.press('ArrowLeft');
    await expect(row).toHaveClass(/cc-revealed/);
    await expect(buttons.first()).toHaveAttribute('tabindex', '0');
    await close(row);
    // Closing is a business stage, independent from archiving.
    const latest = await (
      await page.request.get(`/api/companies/${company.id}`, { headers })
    ).json();
    const closed = await page.request.patch(`/api/companies/${company.id}`, {
      headers,
      data: {
        version: latest.company.version,
        data: companySchema.strip().parse({ ...latest.company, stage: 'closed' }),
      },
    });
    expect(closed.ok()).toBeTruthy();
    await action(page, 'Обновить');
    await page.getByRole('button', { name: 'Закрытые', exact: true }).click();
    await expect(card).toBeVisible();
    await reveal(row);
    await expect(surface).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -112, 0)');
    await expect(card).toHaveCSS('box-shadow', 'none');
    await page.screenshot({
      path: `/tmp/pico-swipe-evidence/closed-${width}-${info.project.name}.png`,
    });
  });
}
