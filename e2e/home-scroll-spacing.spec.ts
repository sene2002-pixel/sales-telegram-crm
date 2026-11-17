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
    await expect(page.locator('.pico-agenda')).toBeVisible();
    const homeGeometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        headingGap: rect('.pico-agenda h2').top - rect('.pico-home-overview').bottom,
        cardHeight: rect('.pico-agenda-panel').height,
        actionGap: rect('.pico-home-actions').top - rect('.pico-agenda-panel').bottom,
      };
    });
    expect(homeGeometry).toEqual({ headingGap: 8, cardHeight: 296, actionGap: 12 });
    for (const inset of [0, 34]) {
      await page.evaluate(
        (v) => document.documentElement.style.setProperty('--pico-safe-bottom', `${v}px`),
        inset,
      );
      for (const tab of ['Главная', 'Клиенты', 'Проекты', 'Задачи', 'Аналитика']) {
        await navigate(page, tab);
        const mobile = width <= 760;
        const scroller = page.locator('.workspace');
        if (mobile) {
          const bottom = 72 + inset + (tab === 'Главная' ? 5 : 16);
          await expect(scroller).toHaveCSS('padding-bottom', `${bottom}px`);
          await expect(page.locator('.pico-bottom-nav')).toHaveCSS('height', `${72 + inset}px`);
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
