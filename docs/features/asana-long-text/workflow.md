# Long values and client Data layout — 29 October 2026

Source: [Asana bug 1219862827428322](https://app.asana.com/1/1218599458205876/project/1218585786925552/task/1219862827428322). Complete description, comments and attachment sections read in the authenticated browser; no attachments or additional comments. Claude's linked artifact/invitation is currently unavailable (confirmed during the preceding bug); visual acceptance uses the explicit Asana specification, without claiming source-artboard pixel comparison.

## Requirements and design

Client Data: full-width INN and legal name, then equal category/city columns (category left), then full-width website. Long displayed values wrap without overlap; short city/category/phone values use one-line ellipsis, with complete values available in the editor. Long editable company/person/role/project/task/note values grow vertically with minimum 38px and padding 9px 12px. Lists retain two-line titles and fixed money/icons. Preserve stored identity, legal-form abbreviation in list headers, permissions, validation and existing save/conflict handling.

Two analysts independently inspected scope, current code and regression coverage. They identified positional `nth-child` layout and one-line native inputs as the causes. Two designers specified semantic grid spans, wrapped growing text controls and bounded list copy. Architecture/security: one reusable controlled textarea, measured after value/width changes with a cleaned-up ResizeObserver; no backend, API, permission, migration or production-data change. Names retain one-line data semantics: pasted line breaks become spaces; Enter does not submit unexpectedly, and composing input remains supported. Notes retain real line breaks. Rollback: revert this PR.

## Implementation and reviews

- Replaced positional Data layout with explicit compact/full-width placement, including holding-specific extra fields. Added category chevron.
- Added GrowingTextarea for long values; kept native numeric, date, email, telephone and compact city/select controls. Width changes and reopening hidden sections recalculate height; shortening the value shrinks it again.
- Long unbroken list titles wrap within the existing two-line clamp; trailing money/icons cannot shrink.
- Independent code reviewers found two issues in iteration 1 (inline-name line breaks and composing Enter); both corrected and re-reviewed.
- Both designers inspected 15 rendered states at 320/390/1440 in iteration 1. They requested top alignment of the short phone beside a long contact role.
- Iteration 2 applies that alignment. Both designers inspected nine updated contact/project/task states and passed. Selected final screenshots are in `screenshots/`.
- Existing multiple-contact regression found implicit label lookup unstable after replacing inputs with textareas. Explicit accessible names now match visible labels. Existing assertions were preserved.

## QA evidence

New `e2e/long-text-fields.spec.ts` uses the supplied legal-name example plus long unbroken content. It checks geometry, wrapping, height growth and shrink, line-break normalization, name save/reopen, contact label/value proximity, project/task two-line titles, and company/project/task editor rendering. The extra-wide layout runs only in the desktop project.

- Initial focused run: 5 passed, 1 intentional mobile/desktop-only skip.
- Final long-text + existing design-fidelity run: 27 passed, 1 intentional skip.
- Existing card, action, keyboard and legal-name cases passed in the broader first run; the four multiple-contact failures were corrected in production and verified by the final design-fidelity run.
- First full server run: 513 passed, 4 skipped, one unchanged supervisor-assignment test returned 404. Its isolated roles suite rerun passed (90 passed, 1 PostgreSQL-only skip). Final complete `npm run check` passed: 514 server tests, 4 PostgreSQL-only skips, 7 ops tests and production build. No server changes were needed.
- Production build passed. Local server health passed before browser tests. Full GitHub CI is a merge gate; final results are on the PR.

Physical-device testing and inaccessible Claude source pixel comparison were not performed. Screenshots establish appearance in the tested Chromium sizes, not universal device coverage.
