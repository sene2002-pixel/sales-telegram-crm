# Mobile keyboard and bottom navigation

Asana: https://app.asana.com/1/1218599458205876/project/1218585786925552/task/1219858734786448

Read in browser: full description, no attachments or added comments. The archived-client filter task was inspected first but left in its original section: removing it depends on the separate closed-clients task and would otherwise lose restore access.

## Requirements and design — agreed

Hide primary bottom navigation while the mobile soft keyboard contracts the viewport during editing. Restore on keyboard dismissal even when focus remains. Scroll obscured active fields inside their real scrolling containers. Cover search, client inline editors, notes, company/contact sheets and task/project forms. Preserve hardware keyboard, desktop, address-bar and orientation behavior.

Two designers independently reviewed the plan; both require viewport contraction rather than focus alone, live Telegram height plus stable baseline, and post-layout inner-sheet scrolling. After each layout iteration both inspect rendered evidence.

Architecture/security: extend the existing viewport coordinator and opt-in root state; no backend, data, permissions or external services. Keep lifecycle cleanup and bounded scheduling. Rollback by reverting the viewport/CSS changes.

Reproduction: current viewport.ts computes a bottom offset on keyboard shrink; CSS positions .pico-bottom-nav at that offset, leaving it above the keyboard.

## Implementation and correction loop

The shared viewport coordinator detects a substantial mobile viewport contraction while editing, using VisualViewport and live Telegram viewportHeight against a stable baseline. It hides navigation with display:none, reclaims the navigation inset and scrolls active fields inside their real form containers. Focus alone and minor browser-toolbar movement keep navigation visible. Native viewport restoration brings navigation back even if focus remains. Lifecycle cleanup restores the previous root attribute and removes focus listeners/cancels queued frames.

Iteration 1: both designers inspected open/restored search, comment sheet and inline equipment screenshots at 320/390 and accepted keyboard behavior. Broader regression found focus-triggered geometry recalculation overwrote independently constrained sheet height. The production focus callback was corrected; existing sheet-height assertions were left intact. Ordinary modal primary actions were also included in the scrolling clearance calculation.

Iteration 2: both designers actually inspected rendered contact/client-edit/notes/task/project fields and narrow search/sheet states and returned PASS. Independent code reviewer approved detection, nested scrolling, geometry preservation, cleanup and the final diff. No further presentation changes followed acceptance.

## Evidence and acceptance

- Read the linked Claude artifact in authenticated Chrome: artboard 24, “Клиенты - правка оборудования (клавиатура без нижнего меню)”; source shows active numeric field above keyboard with no navigation between them. This change intentionally leaves the separate inline numeric-row design bug alone.
- Targeted browser verification: 48 passed, 2 intentional desktop-case skips in mobile project. Covers every requested form category, focus retained on dismissal, native-only viewport contraction, hardware-focus/minor-resize negatives, SDK failures, orientation and cleanup. Existing sheet/conflict checks retained unchanged.
- Server tests: 514 passed, 4 PostgreSQL-only skips (518 total); operations scripts 7 passed; build and production audit passed (zero production vulnerabilities).
- Selected synthetic screenshots under screenshots/. Full iteration evidence at /tmp/pico-keyboard-evidence/. Keyboard rectangle is explicitly labeled as a simulation. Physical iOS/Android OS keyboard behavior was not independently verified on a device.
- Product Owner acceptance: primary navigation absent during simulated keyboard, all active fields stay visible, navigation restores without blur, ordinary focus preserves existing sheet geometry.
- Release: feature branch codex/asana-keyboard-navigation; full CI and main merge pending. Asana task is In Progress until merge verification. No production deployment or database changes.

## Final edge-case correction — iteration 3

Before merge, a new regression reproduced false keyboard detection when Telegram reported a 560px usable window inside an 844px browser host. The baseline now starts at the minimum usable host/visual/stable SDK height, rather than the host maximum. The unchanged failed test now passes, including contraction to 300px and restoration to 560px with focus retained. This also applies on width/orientation reset.

Final keyboard/viewport/client regression selection: 45 passed, 1 intentional desktop-case skip in the mobile project. Build passed again. Independent reviewer approved the baseline correction. Both designers inspected new short-window/no-keyboard and representative positive keyboard screenshots after the correction and returned PASS; three iterations were reviewed in total. Other passed form layouts were preserved.
