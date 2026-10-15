import { expect, Page, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { clients, navigate, openCompany, prepareDemoAuth } from './helpers';
import { emptyDeal, emptySales } from '../src/shared/sales';

test.beforeEach(async ({ page }) => {
  await prepareDemoAuth(page);
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
});

async function api(page: Page, path: string, data?: unknown, method = 'POST') {
  const token = await page.evaluate(() => sessionStorage.getItem('crm-session'));
  const response = await page.request.fetch('/api' + path, {
    method,
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Администратор', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Привет/ })).toBeVisible();
}

async function portraitTablet(page: Page) {
  // A wide portrait tablet can have a short visible viewport; the orientation guard remains active.
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

async function capture(page: Page, state: string) {
  const info = test.info();
  const requestedWidth = page.viewportSize()!.width;
  if (state === 'route-Файлы') {
    const geometry = await page.evaluate(() => {
      const nav = document.querySelector('.pico-bottom-nav');
      const button = nav?.querySelector('button:last-child');
      const shell = document.querySelector('.app-shell')!;
      const box = button?.getBoundingClientRect();
      return {
        nav: nav?.getBoundingClientRect().toJSON(),
        button: box?.toJSON(),
        hits: box
          ? document
              .elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              .map((x) => x.tagName + '.' + x.className)
          : [],
        root: {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          scrollLeft: document.documentElement.scrollLeft,
        },
        body: {
          clientWidth: document.body.clientWidth,
          scrollWidth: document.body.scrollWidth,
          scrollLeft: document.body.scrollLeft,
        },
        shell: shell.getBoundingClientRect().toJSON(),
        shellStyle: {
          position: getComputedStyle(shell).position,
          zIndex: getComputedStyle(shell).zIndex,
          transform: getComputedStyle(shell).transform,
        },
        viewport: {
          width: visualViewport?.width,
          height: visualViewport?.height,
          offsetLeft: visualViewport?.offsetLeft,
          offsetTop: visualViewport?.offsetTop,
        },
      };
    });
    console.log('FILES_GEOMETRY', JSON.stringify(geometry));
    expect(
      geometry.root.scrollWidth,
      'Files must not expand the root layout viewport',
    ).toBeLessThanOrEqual(geometry.root.clientWidth + 1);
  }
  await page.screenshot({ path: info.outputPath(state + '.png'), animations: 'disabled' });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    `${state}: root must stay within requested viewport`,
  ).toBeLessThanOrEqual(requestedWidth + 1);
  await info.attach(state + '-layout', {
    contentType: 'application/json',
    body: JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"]')].map((el) => ({
          width: el.getBoundingClientRect().width,
          left: el.getBoundingClientRect().left,
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          scrollLeft: el.scrollLeft,
        })),
      ),
    ),
  });
  const inventory = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const root = dialogs.at(-1) || document.querySelector('main') || document.body;
    return [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,summary,a')]
      .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const box = el.getBoundingClientRect();
        const scrollParent = el.closest('.table-wrap,.tabs,.pico-picker-list');
        return {
          tag: el.tagName,
          label: (
            el.getAttribute('aria-label') ||
            el.textContent ||
            el.closest('label')?.textContent ||
            ''
          )
            .trim()
            .slice(0, 160),
          disabled: (el as HTMLButtonElement).disabled || false,
          left: box.left,
          right: box.right,
          viewport: innerWidth,
          horizontalScrollAllowed:
            !!scrollParent && scrollParent.scrollWidth > scrollParent.clientWidth,
        };
      });
  });
  await info.attach(state + '-actions', {
    contentType: 'application/json',
    body: JSON.stringify(inventory, null, 2),
  });
  await writeFile(
    info.outputPath(state + '-coverage.json'),
    JSON.stringify({ state, requestedWidth, elements: inventory }, null, 2),
  );
  for (const item of inventory.filter((item) => !item.horizontalScrollAllowed)) {
    expect(item.left, `${state}: ${item.tag} ${item.label} left`).toBeGreaterThanOrEqual(-1);
    expect(item.right, `${state}: ${item.tag} ${item.label} right`).toBeLessThanOrEqual(
      item.viewport + 1,
    );
  }
}

for (const width of [360, 390, 1440]) {
  test(`UI audit: secondary routes, guide, account, reports, users and team at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width < 761 ? 844 : 900 });
    if (info.project.name === 'mobile' && width === 1440) await portraitTablet(page);
    await login(page);
    await capture(page, 'home');
    if (width < 761) {
      await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
      await capture(page, 'more-menu');
      await page
        .locator('.pico-more-menu')
        .getByRole('button', { name: 'Права и помощь', exact: true })
        .click();
    } else await page.getByRole('button', { name: 'Права и помощь', exact: true }).click();
    await capture(page, 'guide');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    for (const name of ['Клиенты', 'Проекты', 'Задачи', 'Календарь', 'Файлы', 'Аналитика']) {
      await navigate(page, name);
      await capture(page, 'route-' + name);
    }
    await navigate(page, 'Мой профиль');
    await expect(page.getByRole('heading', { name: 'Мой профиль', exact: true })).toBeVisible();
    await capture(page, 'profile');
    await page.getByRole('button', { name: '+ Добавить подпись', exact: true }).click();
    await capture(page, 'signature-create');
    let finishPhoto!: () => void;
    const photoDelay = new Promise<void>((resolve) => {
      finishPhoto = resolve;
    });
    await page.route('**/api/me/letter-signature/recognize', async (route) => {
      await photoDelay;
      await route.fulfill({
        status: 503,
        json: { message: 'Локальная ошибка распознавания визитки' },
      });
    });
    await page.getByLabel('Фото визитки', { exact: false }).setInputFiles({
      name: 'synthetic-card.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([255, 216, 255, 217]),
    });
    await expect(page.getByRole('button', { name: 'Обработка…', exact: true })).toBeDisabled();
    await capture(page, 'signature-photo-loading');
    finishPhoto();
    await expect(page.getByRole('alert')).toContainText('Локальная ошибка распознавания визитки');
    await capture(page, 'signature-photo-error');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await navigate(page, 'Отчёты');
    await capture(page, 'reports');
    await page.getByLabel('Текст отчёта').fill('Локальная синтетическая проверка интерфейса');
    await page.getByRole('button', { name: 'Подготовить черновик', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('В очереди');
    await capture(page, 'report-queued');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Отменить отчёт', exact: true })
      .click();
    await capture(page, 'report-cancelled');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    const queued = (await api(page, '/reports', undefined, 'GET'))[0];
    const reviewSales = emptySales();
    reviewSales.deals = [emptyDeal('Синтетический проект для проверки редактора')];
    await page.route(`**/api/reports/${queued.id}`, (route) =>
      route.fulfill({
        json: {
          ...queued,
          status: 'review',
          version: 1,
          feedback: 'Проверьте факты перед сохранением',
          candidates: [[]],
          transcript: 'Синтетическая транскрипция отчёта',
          draft: {
            warnings: ['Синтетическое предупреждение: проверьте неизвестные сведения'],
            blocks: [
              {
                companyName: 'Компания редактора отчёта',
                inn: null,
                city: 'Москва',
                segment: null,
                stage: null,
                potential: null,
                divisions: [{ key: 'mv', amount: 20_000_000 }],
                summary: 'Согласовать следующий шаг',
                occurredOn: '2026-10-12',
                sales: reviewSales,
                contacts: [
                  { name: 'Получатель отчёта', role: 'Закупки', phone: null, email: null },
                ],
                tasks: [{ text: 'Отправить предложение', due: null }],
              },
            ],
          },
        },
      }),
    );
    await page.locator('.report-row').first().click();
    await expect(page.getByRole('dialog')).toContainText('На подтверждении');
    await capture(page, 'report-review-mocked');
    await page
      .getByRole('dialog')
      .getByText('Исправить структурированные данные', { exact: true })
      .click();
    await page.getByLabel('JSON пяти блоков').fill('{ некорректный JSON }');
    await page.getByRole('button', { name: 'Применить исправление', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Проверьте структуру');
    await capture(page, 'report-review-json-error');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await navigate(page, 'Команда');
    await capture(page, 'team');
    await page.getByRole('button', { name: 'Все сотрудники', exact: true }).click();
    await capture(page, 'team-employees');
    await page.getByRole('button', { name: 'Добавить сотрудника', exact: true }).click();
    await capture(page, 'team-admit-form');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await navigate(page, 'Пользователи');
    await capture(page, 'users');
    await page.locator('.pico-user-row').first().click();
    await capture(page, 'user-edit');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await navigate(page, 'Аналитика');
    await page
      .getByRole('button', { name: 'Коммерческий отчёт руководителю', exact: true })
      .click();
    await capture(page, 'commercial-report-form');
    await page
      .getByRole('button', { name: 'Сформировать коммерческий отчёт', exact: true })
      .click();
    await expect(page.locator('.commercial-report')).toBeVisible();
    await capture(page, 'commercial-report-output');
  });

  test(`UI audit: long client, every detail tab, nested forms, letter and failures at ${width}px`, async ({
    page,
  }, info) => {
    // This scenario captures dozens of states; keep individual actions bounded on slower CI.
    test.setTimeout(90_000);
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(30_000);
    await page.setViewportSize({ width, height: width < 761 ? 844 : 900 });
    if (info.project.name === 'mobile' && width === 1440) await portraitTablet(page);
    await login(page);
    const name = 'Компания_' + 'Оченьдлинноеназвание'.repeat(8) + '-' + Date.now();
    const projectName = 'Реконструкция_' + 'Подстанция'.repeat(13) + '-' + Date.now();
    const taskText = 'Согласовать_' + 'Спецификацию'.repeat(11) + '-' + Date.now();
    const company = await api(page, '/companies', {
      name,
      city: 'Санкт-Петербург',
      industry: 'Генерация',
      potential: 135_000_000,
      divisions: { lv: 15_000_000, mv: 20_000_000, heat: 100_000_000 },
      notes: 'Подтверждённые договорённости. '.repeat(15),
    });
    await api(page, `/companies/${company.id}/records/contact`, {
      data: {
        name: 'Иванов_' + 'Сергей'.repeat(20),
        role: 'Руководитель закупок энергетического оборудования',
        email: 'sales-' + 'x'.repeat(80) + '@example.test',
        phone: '+79991234567',
      },
    });
    await api(page, `/companies/${company.id}/records/project`, {
      data: { name: projectName, amount: 15_000_000 },
    });
    await api(page, `/companies/${company.id}/records/task`, {
      data: { text: taskText, type: 'call' },
    });
    const sales = emptySales();
    const deal = emptyDeal('Проект_' + 'Электроснабжение'.repeat(9));
    deal.amount = { value: 15_000_000, certainty: 'confirmed' };
    deal.criteria = { value: 'Критерии_'.repeat(20), certainty: 'confirmed' };
    sales.deals = [deal];
    await api(page, `/companies/${company.id}/records/activity`, {
      data: { text: 'Согласовали график. '.repeat(40), occurredOn: '2026-10-12', sales },
    });
    await page.reload();
    await navigate(page, 'Проекты');
    const projectRow = page.locator('.pico-project-row').filter({ hasText: projectName });
    await projectRow.locator(':scope > summary').click();
    await capture(page, 'long-project-expanded');
    await projectRow.getByRole('button', { name: 'Изменить проект', exact: true }).click();
    await capture(page, 'long-project-edit');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Добавить участника', exact: true })
      .click();
    const member = page.getByRole('dialog', { name: 'Новый участник', exact: true });
    await member.getByLabel('Поиск клиента').fill(name);
    await member.locator('.pico-picker-list').getByRole('button').filter({ hasText: name }).click();
    await capture(page, 'long-project-participant');
    await member.getByRole('button', { name: 'Добавить участника', exact: true }).click();
    await capture(page, 'long-project-participant-entry');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await navigate(page, 'Задачи');
    await page.locator('.task-text').filter({ hasText: taskText }).click();
    await capture(page, 'long-task-detail');
    await page.getByRole('dialog').getByRole('button', { name: 'Отложить', exact: true }).click();
    await capture(page, 'long-task-postpone');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.locator('.task-text').filter({ hasText: taskText }).click();
    const confirmation = page.waitForEvent('dialog');
    const deletion = page
      .getByRole('dialog')
      .getByRole('button', { name: 'Удалить задачу', exact: true })
      .click();
    const nativeConfirm = await confirmation;
    expect(nativeConfirm.message()).toBe('Удалить задачу?');
    await nativeConfirm.dismiss();
    await deletion;
    await capture(page, 'long-task-delete-cancelled');
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await clients(page);
    await page.getByLabel('Поиск компаний').fill(name);
    await capture(page, 'long-client-list');
    await openCompany(page, name);
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.company-detail-actions')).not.toHaveAttribute('open', '');
    await expect(dialog.locator('.company-detail-summary')).not.toHaveAttribute('open', '');
    await capture(page, 'company-detail-collapsed');
    await dialog.locator('.company-detail-actions > summary').click();
    await dialog.locator('.company-detail-summary > summary').click();
    await expect(dialog.getByRole('button', { name: 'Создать письмо', exact: true })).toBeVisible();
    await capture(page, 'company-detail');
    await dialog.getByRole('button', { name: 'Создать письмо', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Моя подпись', exact: true })).toBeVisible();
    await capture(page, 'letter-create');
    await dialog
      .locator('.letter-composer')
      .getByRole('button', { name: 'Отмена', exact: true })
      .click();
    for (const tab of ['Контакты', 'Проекты', 'Задачи', 'История', 'Файлы', 'Изменения']) {
      await dialog.getByRole('button', { name: tab, exact: true }).click();
      await capture(page, 'detail-' + tab);
      if (!['Файлы', 'Изменения'].includes(tab)) {
        await dialog.getByRole('button', { name: '+ Добавить', exact: true }).click();
        await capture(page, 'detail-new-' + tab);
        await dialog
          .locator('.inset > .section-head')
          .getByRole('button', { name: 'Отмена', exact: true })
          .click();
      }
      if (tab === 'Файлы') {
        await dialog.locator('input[type=file]').setInputFiles({
          name: 'synthetic-audit.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Локальная синтетическая проверка'),
        });
        await expect(dialog.locator('.records')).toContainText('synthetic-audit.txt');
        await capture(page, 'detail-file-uploaded');
        const download = page.waitForEvent('download');
        await dialog.getByRole('button', { name: 'Скачать', exact: true }).click();
        expect((await download).suggestedFilename()).toBe('synthetic-audit.txt');
      }
    }
    await dialog.getByRole('button', { name: 'Редактировать компанию', exact: true }).click();
    await capture(page, 'company-edit');
    await dialog.getByRole('button', { name: 'Скрыть форму', exact: true }).click();
    await dialog.getByRole('button', { name: 'Удалить компанию', exact: true }).click();
    await capture(page, 'archive-confirmation');
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Отмена', exact: true })
      .click();
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.route(`**/api/companies/${company.id}`, (route) =>
      route.fulfill({ status: 503, json: { message: 'Локальная проверка ошибки загрузки' } }),
    );
    await openCompany(page, name);
    await expect(page.getByRole('dialog')).toContainText('Локальная проверка ошибки загрузки');
    await capture(page, 'company-load-error');
  });
}

test('UI audit gaps: remove direction, refresh menu, project client handoff and contextual task creation persist', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 1440, height: 900 });
  await login(page);
  const suffix = info.project.name + '-' + Date.now();
  const company = await api(page, '/companies', {
    name: 'Действия ' + suffix,
    divisions: { lv: 15_000_000, mv: 20_000_000 },
    potential: 35_000_000,
    notes: 'Сохранить факт',
  });
  const project = await api(page, `/companies/${company.id}/records/project`, {
    data: { name: 'Контекст ' + suffix, amount: 15_000_000 },
  });
  const sales = emptySales();
  sales.deals = [emptyDeal('История ' + suffix)];
  await api(page, `/companies/${company.id}/records/activity`, {
    data: { text: 'Проверка истории', occurredOn: '2026-10-12', sales },
  });
  await page.reload();
  await clients(page);
  await openCompany(page, company.name);
  const dialog = page.getByRole('dialog');
  await dialog.locator('.company-detail-actions > summary').click();
  await dialog.getByRole('button', { name: 'Редактировать компанию', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Убрать направление Выключатели 0,4 кВ', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Сохранить клиента', exact: true }).click();
  await page.reload();
  const saved = (await api(page, `/companies/${company.id}`, undefined, 'GET')).company;
  expect(saved.divisions).toEqual({ mv: 20_000_000 });
  expect(saved.notes).toBe('Сохранить факт');
  await navigate(page, 'Проекты');
  const projectRow = page.locator('.pico-project-row').filter({ hasText: project.data.name });
  await projectRow.locator(':scope > summary').click();
  await projectRow
    .getByRole('button', { name: 'Открыть клиента · ' + company.name, exact: true })
    .click();
  await expect(dialog).toContainText(company.name);
  await dialog.locator('.company-detail-summary > summary').click();
  await dialog.getByText('История пяти блоков (1)', { exact: true }).click();
  const history = dialog.locator('details').filter({
    has: page.locator(':scope > summary').filter({ hasText: 'История пяти блоков (1)' }),
  });
  await expect(history).toHaveAttribute('open', '');
  await history.locator(':scope > details > summary').click();
  await expect(history).toContainText('Источник: запись');
  await capture(page, 'gap-sales-history-expanded');
  await dialog.getByRole('button', { name: 'Задачи', exact: true }).click();
  await dialog.getByRole('button', { name: '+ Добавить', exact: true }).click();
  const form = dialog.locator('.form-task');
  await form.getByLabel('Задача', { exact: true }).fill('Контекстная ' + suffix);
  await form.locator('.pico-picker-row').filter({ hasText: 'Проект' }).getByRole('button').click();
  await form
    .locator('.pico-inline-picker')
    .getByRole('button', { name: project.data.name, exact: true })
    .click();
  await form.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
  await expect(dialog.locator('.records')).toContainText('Контекстная ' + suffix);
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const detail = await api(page, `/companies/${company.id}`, undefined, 'GET');
  expect(detail.records.find((r: any) => r.data.text === 'Контекстная ' + suffix).projectId).toBe(
    project.id,
  );
  const refreshed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/companies' && r.request().method() === 'GET',
  );
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Дополнительное меню', exact: true }).click();
    await page
      .locator('.pico-more-menu')
      .getByRole('button', { name: 'Обновить', exact: true })
      .click();
  } else {
    await page
      .locator('.connection-state')
      .getByRole('button', { name: 'Обновить', exact: true })
      .click();
  }
  expect((await refreshed).ok()).toBeTruthy();
  await expect(page.locator('.pico-more-menu')).toHaveCount(0);
  await capture(page, 'gap-menu-refresh-complete');
});

test('UI audit gaps: home onboarding task cancellation and hour/week postponement save actual previews', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 1440, height: 900 });
  await login(page);
  await page.route('**/api/companies', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue(),
  );
  await page.reload();
  await page.locator('.pico-home-start').click();
  await page.getByRole('button', { name: /^Поставить задачу/ }).click();
  await expect(page.getByRole('dialog', { name: 'Новая задача', exact: true })).toBeVisible();
  await page.getByLabel('Задача', { exact: true }).fill('Отменённая из onboarding');
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.unroute('**/api/companies');
  const suffix = info.project.name + '-' + Date.now();
  const company = await api(page, '/companies', { name: 'Перенос ' + suffix });
  const task = await api(page, `/companies/${company.id}/records/task`, {
    data: { text: 'Быстрые сроки ' + suffix, type: 'call' },
  });
  await page.reload();
  await navigate(page, 'Задачи');
  for (const preset of ['Через час', 'Через неделю']) {
    await page.locator('.task-text').filter({ hasText: task.data.text }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Отложить', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Отложить задачу', exact: true });
    await dialog.getByRole('button', { name: new RegExp('^' + preset) }).click();
    const due = await dialog.getByLabel('Дата', { exact: true }).inputValue();
    const time = await dialog.getByLabel('Время', { exact: true }).inputValue();
    expect(due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    const expected = await page.evaluate((preset) => {
      const d = new Date();
      if (preset === 'Через час') d.setHours(d.getHours() + 1);
      else d.setDate(d.getDate() + 7);
      return {
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      };
    }, preset);
    expect(due).toBe(expected.date);
    if (preset === 'Через час') expect(time).toBe(expected.time);
    await capture(page, 'gap-postpone-' + (preset === 'Через час' ? 'hour' : 'week'));
    await dialog.getByRole('button', { name: 'Отложить', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    const stored = (await api(page, `/companies/${company.id}`, undefined, 'GET')).records.find(
      (r: any) => r.id === task.id,
    );
    expect(stored.data).toMatchObject({ due, time, type: 'call', done: false });
    await navigate(page, 'Задачи');
  }
});
