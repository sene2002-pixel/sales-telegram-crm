import { expect, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';

for (const width of [320, 390, 1440]) {
  test(`Signature photo feedback stays near upload at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    if (width === 1440 && info.project.name === 'mobile') {
      await page.addInitScript(() => {
        Object.defineProperties(screen, {
          width: { configurable: true, value: 1440 },
          height: { configurable: true, value: 2560 },
        });
        Object.defineProperties(screen.orientation, {
          type: { configurable: true, value: 'portrait-primary' },
          angle: { configurable: true, value: 0 },
        });
      });
    }
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    await page.route('**/api/me/signature-drafts', (r) => r.fulfill({ json: [] }));
    let saveRequests = 0;
    let releaseSave!: () => void;
    const saveDelay = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route('**/api/me/letter-signatures', async (r) => {
      if (r.request().method() === 'GET') return r.fulfill({ json: [] });
      saveRequests++;
      await saveDelay;
      await r.fulfill({ status: 503, json: { message: 'Не удалось сохранить подпись' } });
    });
    let requests = 0;
    let releasePhoto!: () => void;
    let photoDelay = new Promise<void>((resolve) => {
      releasePhoto = resolve;
    });
    const recognized = {
      lastName: 'Петров',
      firstName: 'Пётр',
      patronymic: '',
      workPhone: '',
      mobilePhone: '',
      email: 'petr@example.test',
    };
    await page.route('**/api/me/letter-signature/recognize', async (r) => {
      requests++;
      await photoDelay;
      if (requests === 1)
        await r.fulfill({
          status: 503,
          json: { message: 'Не удалось распознать фото. Выберите файл ещё раз.' },
        });
      else await r.fulfill({ json: recognized });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Администратор', exact: true }).click();
    await navigate(page, 'Мой профиль');
    await page.getByRole('button', { name: '+ Добавить подпись', exact: true }).click();
    const editor = page.locator('.pico-signature-editor');
    const upload = editor.getByLabel('Фото визитки', { exact: false });
    const feedback = editor.locator('.signature-photo-feedback');
    const status = feedback.getByRole('status');
    await editor.getByLabel('Фамилия', { exact: true }).fill('Черновик');
    await editor.getByLabel('Имя', { exact: true }).fill('Иван');
    // A person is looking at the uploader, rather than at the submit button below the form.
    await upload.evaluate((el) => el.closest('.field')!.scrollIntoView({ block: 'start' }));
    const photo = {
      name: 'synthetic-card.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([255, 216, 255, 217]),
    };
    await upload.setInputFiles(photo);
    await expect(status).toHaveText('Распознаём визитку…');
    await expect(status).toBeInViewport();
    await expect(upload).toBeDisabled();
    await expect(editor.getByLabel('Фамилия', { exact: true })).toBeDisabled();
    expect(saveRequests).toBe(0);
    // Even form submission while recognition is pending must not start a save.
    await editor.locator('form').evaluate((el) => (el as HTMLFormElement).requestSubmit());
    expect(saveRequests).toBe(0);
    await page.screenshot({
      path: `/tmp/signature-status-pending-${width}-${info.project.name}.png`,
      animations: 'disabled',
    });
    releasePhoto();
    await expect(feedback.getByRole('alert')).toContainText('Не удалось распознать фото');
    await expect(status).toBeEmpty();
    await expect(feedback.getByRole('alert')).toBeInViewport();
    await expect(editor.getByRole('alert')).toHaveCount(1);
    await expect(editor.getByLabel('Фамилия', { exact: true })).toHaveValue('Черновик');
    await expect(upload).toBeEnabled();
    await page.screenshot({
      path: `/tmp/signature-status-error-${width}-${info.project.name}.png`,
      animations: 'disabled',
    });
    photoDelay = new Promise<void>((resolve) => {
      releasePhoto = resolve;
    });
    await upload.setInputFiles(photo);
    await expect(feedback.getByRole('alert')).toHaveCount(0);
    await expect(status).toHaveText('Распознаём визитку…');
    releasePhoto();
    await expect(status).toHaveText('Данные распознаны. Проверьте поля и сохраните изменения.');
    await expect(status).toBeInViewport();
    await expect(editor.getByLabel('Фамилия', { exact: true })).toHaveValue('Петров');
    await expect(editor.getByLabel('Email', { exact: true })).toHaveValue('petr@example.test');
    expect(requests).toBe(2);
    expect(saveRequests).toBe(0);
    await page.screenshot({
      path: `/tmp/signature-status-success-${width}-${info.project.name}.png`,
      animations: 'disabled',
    });
    await upload.setInputFiles({
      name: 'too-large.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await expect(feedback.getByRole('alert')).toHaveText('Загрузите фото до 10 МБ');
    await expect(status).toBeEmpty();
    expect(requests).toBe(2);
    await expect(editor.getByLabel('Фамилия', { exact: true })).toHaveValue('Петров');
    await upload.setInputFiles(photo);
    await expect(status).toContainText('Данные распознаны.');
    await expect(feedback.getByRole('alert')).toHaveCount(0);
    await editor.getByLabel('Фамилия', { exact: true }).fill('Исправлено');
    await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect.poll(() => saveRequests).toBe(1);
    await expect(status).not.toContainText('Распознаём');
    releaseSave();
    await expect(editor.getByRole('alert')).toHaveText('Не удалось сохранить подпись');
    await expect(feedback.getByRole('alert')).toHaveCount(0);
    await expect(editor.getByLabel('Фамилия', { exact: true })).toHaveValue('Исправлено');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
