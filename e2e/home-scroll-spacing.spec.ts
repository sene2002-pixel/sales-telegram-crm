import { expect, test } from '@playwright/test';
import { navigate, prepareDemoAuth } from './helpers';
for (const width of [320, 390, 1440])
  test(`Home spacing and all tab bottom access ${width}`, async ({ page }, info) => {
    test.skip(width === 1440 && info.project.name === 'mobile', 'Portrait-only mobile app');
    await page.setViewportSize({ width, height: 844 });
    await prepareDemoAuth(page);
    await page.route('https://telegram.org/js/telegram-web-app.js*', (r) =>
      r.fulfill({ body: '' }),
    );
    await page.route('**/api/companies', (r) =>
      r.fulfill({
        json: [
          {
            id: 'company',
            name: 'QA active',
            city: 'Казань',
            stage: 'new',
            archived: false,
            ownerId: 'owner',
            version: 1,
            segment: 'end_client',
            industry: '',
            divisions: {},
            potential: null,
            revenue: null,
            notes: '',
            inn: null,
          },
        ],
      }),
    );
    await page.route('**/api/records/task', (r) =>
      r.fulfill({
        json: [
          {
            id: 'qa-overdue',
            companyId: 'company',
            companyName: 'QA active',
            kind: 'task',
            version: 1,
            data: {
              title: 'QA overdue regression',
              type: 'task',
              due: '2000-01-01',
              done: false,
              notes: '',
            },
            createdAt: '2000-01-01T00:00:00Z',
            updatedAt: '2000-01-01T00:00:00Z',
          },
        ],
      }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Администратор', exact: true }).click();
    await expect(page.locator('.pico-home-feed')).toBeVisible();
    const gap = await page.evaluate(
      () =>
        document.querySelector('.pico-home-block h2')!.getBoundingClientRect().top -
        document.querySelector('.pico-home-overview')!.getBoundingClientRect().bottom,
    );
    expect(gap).toBe(20);
    const homeGeometry = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('.pico-home-block')];
      const rect = (el: Element) => el.getBoundingClientRect();
      return {
        cardGap: rect(blocks[0].children[1]).top - rect(blocks[0].children[0]).bottom,
        meetingGap: rect(blocks[1].children[0]).top - rect(blocks[0].lastElementChild!).bottom,
        feedBottom: rect(document.querySelector('.pico-home-feed')!).bottom,
        overdueGap:
          rect(document.querySelector('.pico-home-feed > .pico-add-row')!).top -
          rect(blocks[1].lastElementChild!).bottom,
      };
    });
    expect(homeGeometry.cardGap).toBe(8);
    expect(homeGeometry.meetingGap).toBe(20);
    expect(homeGeometry.overdueGap).toBe(10);
    if (width <= 760) expect(homeGeometry.feedBottom).toBe(844);
    for (const inset of [0, 34]) {
      await page.evaluate(
        (v) => document.documentElement.style.setProperty('--pico-safe-bottom', `${v}px`),
        inset,
      );
      for (const tab of ['Главная', 'Клиенты', 'Проекты', 'Задачи', 'Аналитика']) {
        await navigate(page, tab);
        const mobile = width <= 760;
        const scroller =
          tab === 'Главная' ? page.locator('.pico-home-feed') : page.locator('.workspace');
        if (mobile) await expect(scroller).toHaveCSS('padding-bottom', `${72 + inset + 16}px`);
        if (mobile)
          await expect(page.locator('.pico-bottom-nav')).toHaveCSS('height', `${72 + inset}px`);
        if (tab === 'Главная') {
          await scroller.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          const overdue = page.getByRole('button', {
            name: 'Просроченные задачи · 1',
            exact: true,
          });
          if (mobile) {
            const nav = await page.locator('.pico-bottom-nav').boundingBox();
            const box = await overdue.boundingBox();
            expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y);
          }
          await overdue.click();
          await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
          await navigate(page, 'Главная');
        }
        // Synthetic long content tests scroll geometry independently of seeded record counts.
        await scroller.evaluate((el) => {
          const spacer = document.createElement('div');
          spacer.id = 'qa-scroll-spacer';
          spacer.style.height = '1500px';
          const last = document.createElement('button');
          last.id = 'qa-last-action';
          last.textContent = 'QA last action';
          last.onclick = () => {
            last.dataset.clicked = 'yes';
          };
          el.append(spacer, last);
          el.scrollTop = el.scrollHeight;
          const documentScroller = document.scrollingElement!;
          documentScroller.scrollTop = documentScroller.scrollHeight;
        });
        const last = page.locator('#qa-last-action');
        await expect
          .poll(async () => {
            const box = await last.boundingBox();
            const nav = mobile ? await page.locator('.pico-bottom-nav').boundingBox() : null;
            return !!box && box.y >= 0 && box.y + box.height <= (nav?.y ?? 844);
          })
          .toBeTruthy();
        await last.click();
        await expect(last).toHaveAttribute('data-clicked', 'yes');
        await page.screenshot({ path: info.outputPath(`bottom-${tab}-${inset}.png`) });
        await scroller.evaluate((el) => {
          el.querySelector('#qa-scroll-spacer')?.remove();
          el.querySelector('#qa-last-action')?.remove();
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBeTruthy();
      }
    }
  });
