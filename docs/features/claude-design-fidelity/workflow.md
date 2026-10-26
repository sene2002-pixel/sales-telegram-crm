# Claude design fidelity

Source: https://claude.ai/artifacts/invite/d86ccbe5-4c7b-498e-9570-17b5c9948c7a
The authenticated Chrome source resolves to Pico Bot - финал, 21 artboards. Source read via browser, including cards, new-client variants, swipe states, contact/client sheets, main, projects, tasks and analytics.

## Requirements and decisions

Analyst/Product/UX: preserve current CRM workflows while matching the five main sections and associated source states. Desktop retains responsive adaptation; native Telegram chrome must not be duplicated. Client trash remains recoverable archive. Inputs, keyboard access, errors, concurrency and pinned save actions must remain usable.
Designer: two independent designers audit before implementation and inspect screenshots after EVERY layout iteration. Blocking findings return to development, followed by new screenshots and both reviews.
Architect/Security: reuse existing components, opt-in sheet wrapper for creation and editing; no backend, permissions, data migrations or network changes. Rollback is reverting this presentation-only diff.

## Iteration 1 — reviewed

Unify New Client with the explicit bottom-sheet used by client editing; support wrapping long data values without fixed-height clipping. Contact editor remains one column, as the browser source confirms. Compare all five sections and sheet top/bottom states on mobile and desktop.

Reviewer and QA passed. Designers requested iteration 2 below.
Release: feature branch codex/claude-design-fidelity, no deployment.

## Review and verification

- Code reviewers 1 and 2 approved the production diff. A proposed replacement of the existing fidelity suite was rejected and corrected: `e2e/design-fidelity.spec.ts` is unchanged; new coverage lives in `e2e/claude-design-review.spec.ts`.
- Designer 1 and 2 rejected the initial evidence because analytics was still loading and expanded/edit states were missing. Capture now waits for loaded analytics, disables animations, seeds real local data, and includes expanded card, swipe, contact/client edit and the bottom of extra fields. Both designers inspected the new screenshots and identified the contact save width mismatch addressed in iteration 2.
- Build passed. Server tests: 514 passed, 4 skipped (518 total). Operations scripts: 7 passed. The initial sandbox server run failed because local listening was forbidden (`EPERM`); the authorized rerun passed.
- Existing browser regression selection: 49 passed, 1 intentional mobile desktop-layout skip. Existing client-card and native-frame fidelity tests: 10 passed. New visual/behavior scenarios: 5 passed, 1 intentional desktop-width skip in the mobile project.
- New coverage verifies a long city value saved through the actual editor wraps without fixed-height clipping. Screenshot capture is evidence for human design review, not automatic pixel comparison.
- Full local iteration evidence: `/tmp/pico-design-evidence/`; selected final synthetic screenshots are committed under `screenshots/`.

## Iteration 2 — passed

Both designers independently identified that contact editing shared the Save row with Cancel, whereas the browser source has full-width Save. Existing-contact editing now uses a single full-width primary action; the sheet retains X and Escape dismissal, and inline new-contact creation retains its Cancel action. The new browser scenario asserts Save width against its container.

Both designers actually inspected new rendered contact screenshots at 320, 390 and 1280 px after the correction and returned PASS. Final targeted browser checks including actual mobile contexts: 28 passed, 2 intentional mobile desktop-layout skips. Build passed again. Independent code reviewer 2 approved the final correction. No further presentation changes followed these reviews.

Source access limitation: the lead read the authenticated Claude source in Chrome (21 artboard descriptions and relevant card/contact visuals). Both designers’ independent Chrome handles stalled, so their comparison used the lead’s confirmed source specifications and the actual rendered screenshots. This is structural visual acceptance, not independent pixel-perfect verification of all 21 source artboards.

Product Owner acceptance: source structure for all five sections is retained; new/edit client sheets share the same explicit container; contact Save spans the sheet; long client values wrap; narrow viewport controls remain reachable. Full-resolution screenshots and rejected/evaluated iteration evidence are retained locally.

Release: PR https://github.com/sene2002-pixel/sales-telegram-crm/pull/23; final CI pending. No deployment or main merge in this follow-up.

## Merge follow-up — 2026-10-26

The user requested merging PR #23 into main. The previous CI run passed all 518 server tests but stopped at the production dependency audit: GHSA-q7qp-rjg7-q26m affects multer below 2.5.0. Update multer to ^2.5.0 and apply the same dependency override to the NestJS adapter, which pins 2.4.0. This avoids a framework downgrade and leaves application code and presentation unchanged. `npm ci` and the production audit pass with zero production vulnerabilities; final tests and CI are required before merging.
