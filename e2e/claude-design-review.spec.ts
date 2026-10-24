import { test, expect } from '@playwright/test';
import { prepareDemoAuth, navigate, action } from './helpers';

for (const width of [320, 390, 1280]) {
  test(`design review: five sections and new-client sheet at ${width}px`, async ({
    page,
  }, info) => {
    test.skip(
      info.project.name === 'mobile' && width === 1280,
      'Desktop layout is covered by the desktop project',
    );
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Менеджер', exact: true }).click();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
    const headers = { Authorization: `Bearer ${token}` };
    const created = await page.request.post('/api/companies', {
      headers,
      data: {
        name: `ЭНЕРГОКОМПЛЕКТ ${width}-${Date.now()}`,
        city: 'Самара',
        segment: 'integrator',
        industry: 'Производство электрораспределительного оборудования',
        potential: 48_000_000,
        divisions: { lv: 12_000_000, drives_lv: 16_000_000, cells: 20_000_000 },
        notes: 'Компания специализируется на производстве распределительного оборудования.',
      },
    });
    expect(created.ok()).toBeTruthy();
    const company = await created.json();
    const contact = await page.request.post(`/api/companies/${company.id}/records/contact`, {
      headers,
      data: {
        data: {
          name: 'Сергей Михайлович Татаринов',
          role: 'Ген. директор',
          phone: '+7 912 345-67-89',
          email: 's.tatarinov@example.test',
        },
      },
    });
    expect(contact.ok()).toBeTruthy();
    for (const [kind, data] of [
      ['project', { name: 'Амурская ТЭЦ', amount: 4_500_000 }],
      [
        'task',
        {
          text: 'Получить от клиента выгрузку потребности в оборудовании',
          due: new Date().toISOString().slice(0, 10),
        },
      ],
    ] as const) {
      const response = await page.request.post(`/api/companies/${company.id}/records/${kind}`, {
        headers,
        data: { data },
      });
      expect(response.ok()).toBeTruthy();
    }
    await action(page, 'Обновить');
    for (const section of ['Главная', 'Клиенты', 'Проекты', 'Задачи', 'Аналитика']) {
      await navigate(page, section);
      if (section === 'Аналитика') await expect(page.locator('.pico-client-funnel')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({
        path: info.outputPath(`${section}-${width}.png`),
        animations: 'disabled',
      });
    }
    await navigate(page, 'Клиенты');
    await action(page, 'Добавить клиента');
    const sheet = page.getByRole('dialog', { name: 'Новый клиент', exact: true });
    await expect(sheet).toHaveClass(/client-sheet/);
    await expect(sheet.locator('.client-sheet-handle')).toHaveCount(1);
    const heading = sheet.getByRole('heading', { name: 'Новый клиент', exact: true });
    const inn = sheet.getByRole('textbox', { name: 'ИНН', exact: true });
    await expect(heading).toBeInViewport();
    await expect(inn).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`new-client-top-${width}.png`),
      animations: 'disabled',
    });
    await sheet.getByText('Потенциал', { exact: true }).click();
    await sheet.getByText('Дополнительные поля', { exact: true }).click();
    const save = sheet.getByRole('button', { name: 'Сохранить клиента', exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await expect(heading).toBeInViewport();
    expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.screenshot({
      path: info.outputPath(`new-client-expanded-${width}.png`),
      animations: 'disabled',
    });
    await sheet.getByRole('textbox', { name: 'Комментарий', exact: true }).scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await expect(heading).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`new-client-bottom-${width}.png`),
      animations: 'disabled',
    });
    await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const card = page.locator('.cc-card').filter({ hasText: company.name });
    await card.locator('.pico-client-row').click();
    await expect(card.locator('.cc-section')).toHaveCount(5);
    await card
      .locator('.cc-section > summary')
      .filter({ hasText: /^Контакты/ })
      .click();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`client-expanded-${width}.png`),
      animations: 'disabled',
    });
    const contactSwipe = card
      .locator('.cc-swipe')
      .filter({ has: page.locator('.cc-contact') })
      .last();
    await contactSwipe.focus();
    await contactSwipe.press('ArrowLeft');
    await page.screenshot({
      path: info.outputPath(`contact-swipe-${width}.png`),
      animations: 'disabled',
    });
    await contactSwipe
      .locator(':scope > .cc-trash-track')
      .getByRole('button', { name: /Редактировать/ })
      .click();
    const contactSheet = page.getByRole('dialog', { name: 'Контакт', exact: true });
    await expect(
      contactSheet.getByRole('textbox', { name: 'Контакт · ФИО', exact: true }),
    ).toBeVisible();
    const contactSave = contactSheet.getByRole('button', { name: 'Сохранить', exact: true });
    const actions = contactSheet.locator('.cc-editor-actions');
    expect((await contactSave.boundingBox())!.width).toBeCloseTo(
      (await actions.boundingBox())!.width,
      0,
    );
    await page.screenshot({
      path: info.outputPath(`contact-edit-${width}.png`),
      animations: 'disabled',
    });
    await contactSheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const clientSwipe = card.locator(':scope > .cc-swipe');
    await clientSwipe.focus();
    await clientSwipe.press('ArrowLeft');
    await clientSwipe
      .locator(':scope > .cc-trash-track')
      .getByRole('button', { name: /Редактировать/ })
      .click();
    const editSheet = page.getByRole('dialog', { name: 'Редактирование карточки', exact: true });
    await expect(editSheet.getByRole('textbox', { name: 'ИНН', exact: true })).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`client-edit-${width}.png`),
      animations: 'disabled',
    });
    const longCity = 'Комсомольск-на-Амуре, промышленная площадка электротехнического оборудования';
    await editSheet.getByRole('textbox', { name: 'Город', exact: true }).fill(longCity);
    await editSheet.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
    await expect(editSheet).toBeHidden();
    await card
      .locator('.cc-section > summary')
      .filter({ hasText: /^Данные/ })
      .click();
    const city = card.getByRole('button', { name: 'Изменить Город', exact: true });
    await expect(city).toContainText(longCity);
    await city.scrollIntoViewIfNeeded();
    expect(await city.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBeTruthy();
    await page.screenshot({
      path: info.outputPath(`client-long-data-${width}.png`),
      animations: 'disabled',
    });
  });
}
