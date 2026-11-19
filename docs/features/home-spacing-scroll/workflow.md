# Home spacing and bottom access

Source: Asana 1220126988541937. Side gutters are 16px, from counters to Today is 20px, headings to cards is 8px, cards to Meetings is 20px, and Meetings to overdue is 10px. All five tabs keep their last action accessible above fixed navigation. The feed extends under navigation.

During the initial check the Claude canvas was unavailable, so the implementation used the written dimensions. The follow-up below uses the author’s artboards.

Cause: overview bottom margin and first heading top margin each contributed 20px. Home workspace also reserved navigation space outside its inner scrolling feed, ending the feed above the navigation. Fix removes the extra overview margin and external bottom reservation, moving navigation clearance into feed scroll padding. Other tabs receive consistent navigation clearance. No authorization/data/API changes or migration. Rollback is reverting the CSS change.

Implementation and independent source review passed. npm run check: 518 server tests passed, 0 skipped; ops 7/7 and build passed. Persistent browser regression: 5 passed, 1 intentional mobile landscape skip; widths 320/390/1440, safe inset 0/34px, actual 20/8/20/10 spacing, home feed reaches viewport bottom, real overdue action and synthetic last actions remain above navigation and accept clicks on all five tabs. Independent browser QA also passed 5/1. Keyboard hiding override reviewed in source; real iOS keyboard and inaccessible Claude canvas not verified. Logs: /tmp/pico-home-check.log and /tmp/pico-home-spacing-overdue.log. No production changes, publication or Asana Done claim.

## Высота нижней панели по макету

Артборды «Pico Bot — финал» задают высоту панели 72 px. В эту высоту входят 13 px свободного места под кнопками. В Telegram панель увеличивается на часть системного отступа сверх этих 13 px. При системном отступе 34 px высота составляет 93 px. Панель закреплена у видимого нижнего края, а кнопки высотой 48 px остаются над системной областью. Прокрутка всех пяти разделов использует ту же высоту панели.

✅ Passed. Положение панели, зоны нажатия и прокрутка проверены в Chromium и WebKit. Учтены отступы 0, 13, 34 и 54 px и короткое окно Telegram. Сборка, серверные и эксплуатационные тесты прошли. ❌ Failed. Набор Chromium выявил перекрытие поля email кнопкой сохранения в открытой шторке контакта при клавиатуре. Оно воспроизводится и на исходном `main` (`2573c57`).
