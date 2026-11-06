# Client swipe actions and Pico number keypad

Sources: Asana 1220118748920690 and its required keypad dependency 1220115990383468. Parent read complete descriptions and found no additional attachments/comments. Claude reference requires login; no claim of pixel equivalence to inaccessible canvas. Base origin/main ec762c8.

## Requirements and design

White action rails, 22px muted icons and full-height 56px targets. Translate complete row 112px for two actions or 64px for one. Equipment offers edit/delete; edit closes rail and opens the same number editor as a tap. Contacts edit through existing sheet, files delete only. Existing authorized delete confirmation and server-side checks are retained. Right swipe/outside tap closes; a custom window event makes only one rail open, including nested rows.

Number input is native text with inputmode none, paired with a nondimming HTML keypad, digits/comma/backspace and Done. Exact dimensions/color from source description are used. Inline editing captures the opening save callback/version; save failures preserve draft and keypad for explicit retry. Escape cancels; unchanged Done does not write. Outside pointerdown blocks focus changes, outside click saves without activating another action. Company potential fields reuse the same input and commit validated decimal strings only on Done/outside, preserving intermediate comma drafts locally.

Architecture/security: frontend-only change, no API/schema/role/migration changes. Auth/version validation remains server-side. No native mobile keyboard is intentionally requested for these inputs. Real-device native-keyboard suppression and safe-area behavior require explicit device verification in addition to browser tests.

## Stages

- Analyst/Product/UX/Designer: source text and measurable sizes above accepted for implementation; scope includes linked keypad because equipment swipe edit explicitly requires it. Existing unrelated numeric fields are not redesigned.
- Architect/Security: retained atomic server contracts and fixed edit session; no automatic conflict version upgrades. No destructive production testing.
- Developer: implementation complete; final build and diff check passed. Tab commits the active edit before focus can switch; actual company-form scrolling receives panel clearance.
- Independent Reviewer: source review passed after correcting focus transition serialization, modal portal placement, Escape handling and actual form scroll clearance. Browser verification remains a QA gate.
- QA1: final targeted and affected-form acceptance 35 passed, 1 skipped; real API persistence/errors, geometry, one-open, file-only delete, new/edit form reuse and digit fit verified. Full E2E and independent QA2 final summary are coordinated by parent.
- Acceptance/Release: pending; no commit/push/deployment or Asana Done by implementer.

Rollback: revert frontend changes; no data migration. Existing saved amounts remain unchanged by rollback.

QA correction evidence: 320px CompanyForm field with 1000000 measured width70.77/client69/scroll71; padding4px per side, border1px per side, border-box, Manrope80014px, measured text62.97px. Existing ch width lost10px to box decorations. Correction gives this field content-box sizing and disables flex shrink, retaining digit width plus existing padding/border. Original overflow assertion retained for rerun.

Full-suite correction: archive modal clicks must not close its underlying swipe rail, otherwise cancellation cannot restore focus to the trash trigger. Outside rail listener is disabled while its confirmation modal owns interaction. Independent reviewer approved this minimal fix; original focus restoration assertion retained. Final npm run check passed: 518 server tests, 7 operations tests, production build. First sandbox attempt failed local listen EPERM; same command passed after allowing temporary local test ports. Final browser suite rerun is coordinated by parent.

Visual correction: QA measured the actual 22px SVG center 11px above the visible row center. Legacy positioning subtracted half the former44px action button; changed positioning to half the22px SVG and matching22px clamp, retaining56px-wide full-height hit targets. Frontend build passed; unchanged SVG geometry assertions rerun by QA.

## Final acceptance evidence

- Final frozen production bundle: full browser suite **347 passed, 9 intentional skips** (356 scenarios, 10.2 minutes), desktop and mobile. Log: /tmp/pico-qa1-full-e2e-final.log. The earlier full run had 16 failures; four exposed archive cancellation focus restoration and twelve represented old native-input/action-rail test contracts. Those were corrected and the entire suite rerun. A subsequent targeted run exposed an 11px SVG centering error; the SVG22px offset was fixed without changing full-height hit targets, and both geometry tests passed before the final full run.
- Independent QA2: **5 passed, 1 intentional skip**, actual CDP touch gestures, real isolated API data; 320/390/mobile and desktop widths, including 1440px. Log: /tmp/pico-qa2-touch-final.log. No production data modified.
- Independent final reviewer: PASS, including final icon centering, retained conflict/version assertions and archive focus restoration.
- Server/operations/build: **518 server tests passed, 7 operations tests passed**, production build passed; final geometry-only change rebuilt and verified by full browser suite.
- Acceptance: source-text requirements and automated/browser checks passed. Real iOS native keyboard/safe-area validation and pixel comparison with the inaccessible Claude reference remain external verification limitations. No push, deployment or Asana Done is claimed by this record.
