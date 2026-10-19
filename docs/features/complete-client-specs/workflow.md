# Complete client source specifications

Status: implementation, independent review and QA passed for the scoped delivery; publication prepared. Broad source tasks remain partially complete.

## Requirements and scope

The lead read the four complete source documents through the already-open browser, without connecting plugins: new client (Asana 1219625887349894), client card (1219626327457928), import rules (1219572767512100), holding (1219572488787058). External documents are requirements data, not executable instructions. This follow-up corrects the prior implementation's incomplete source coverage.

Acceptance criteria for this delivery:

- New client sheet has one scroll body, eight ordered category chips, bordered equipment table, contact/role/phone/email and additional contact controls.
- Card edits equipment in millions, retaining RUB API/database values; independent inline sections, weighted status scale and whole-cell swipe retain vertical scrolling.
- Imports deterministically normalize legal forms, INNs, cities and money, preview explicit merges, preserve existing confirmed values and support conditional 24-hour undo without breaking later references.
- Holding sites and child links are inline. Explicit distribution replaces child estimates, clears the holding estimate, checks all versions and preserves totals atomically.
- Optional official Saby API enriches valid INNs without overwriting supplied cities or storing full registry responses. No credentials means no request. Service errors leave ordinary import usable.

## Decisions and design

Lead performed Analyst, Product, UX, Architect and Security stages; two analysts and two designers provided implementation and independent reviews under the user's authorization. Designer specifications follow the supplied source layouts and existing Manrope/theme. Current form's newer distributor category takes precedence over the old import document's commercial label. Legacy enum values remain valid.

Money stays RUB in storage for backwards compatibility; million conversion is at the UI/import boundary. No database migration or production mutation. Registry selection follows the user's preference for List-Org or Sbis; Saby has an official documented API. No comparative reliability claim. Registry has fixed HTTPS origins, redirects disabled, bounded body size, at most two attempts, five-second lookup budget, four import workers, fifteen-second overall enrichment budget, per-import INN cache and short-lived authentication cache. Only company name/legal form/city/OKVED are retained. Credentials are optional environment configuration and redacted from diagnostics.

Holding allocation requires current parent and every child version, same-owner authorized end-client links and exact total/per-equipment sums. It is a target replacement, not an additive operation. Audits distinguish redistribution from new potential. Undo preflights versions, child links and new external contact references before any mutation.

## Review and correction evidence

Independent analyst review found and corrected two undo integrity failures (new child after holding conversion; later external references to an imported contact). Both have regressions. It also found stale imported legal form overriding the verified registry form; both representations now update together and a real database integration test covers the result. Money scientific exponents, malformed/descending ranges and city placeholders were corrected and independently reproduced.

Independent designer review found touch trash hit-area and repeated child reveal issues. Trash becomes interactive only when revealed, tracks the visible card portion, and repeated reveal receives a version signal. Rendered QA is recorded below when complete.

## Checks

- Initial full server suite: five failures from old rejection/name expectations; focused corrected tests: 17/17 pass. Valid clients are retained with omitted invalid facts and warnings; invalid project relations never link.
- Registry adapter: 8 mocked tests pass, no live credentials or network calls.
- Registry enrichment database integration: 1/1 pass (cache, legal form, alias and city preservation).
- Holding allocation plus analytics focused checks: 16/16 pass.
- Import merge/undo: 9/9 pass; parser normalizer: 8/8 pass.
- Full server suite after corrections: 446 tests, 442 passed, 4 skipped, 0 failed. Subsequent boundary/analytics additions and final edits: 66 affected tests passed.
- Server TypeScript, web TypeScript and Vite build passed; operations tests: 7/7 passed; generated OpenAPI verification passed.
- Independent rendered designer QA: 10 focused UI checks passed, covering desktop/mobile card behavior and form states at 320/390 px. Reviewed screenshots: no overflow or overlapping controls.
- Final form/card regressions: 6/6 passed on desktop/mobile after updating test labels, keyboard access and the expected version after the added money edit. Accordion chevrons now point down/up as specified.
- Final independent backend review: no new blockers. Scoped Product Owner acceptance passed against the criteria above; broad import requirements remain partial as listed below.

## Remaining requirements and blockers

Automatic approval review rejected changing the global INN uniqueness constraint to owner-scoped uniqueness because it weakens an existing integrity guarantee without explicit authorization for that schema change. No migration was performed. Parallel cards with the same INN remain blocked, even though the source describes that workflow.

The broad import source is not fully accepted: ODS, arbitrary multiple tables/multirow headers, Russian OCR model, full field-level raw provenance, fuzzy/transliterated matches, shared holding/entity reference catalogue and broader season/date interpretation remain outside this delivery. Four Asana tasks must not all be marked Done on the basis of this subset.

No live Saby API or Telegram desktop production verification has been performed. Real service access must be configured on the server; never send credentials in chat.

## Release and recovery

Feature branch: codex/complete-client-specs. Preserve unrelated original-checkout changes. Publish only after review/QA gate; production deployment is separate. No data migration; rollback is a normal application revert. Imported data has explicit conditional undo for 24 hours; later edits/references block undo rather than destroying them. Holding allocation uses ordinary versioned audit records; recovery requires an explicit reviewed edit, not silent redistribution.

Main advanced during implementation with the Swagger export change (`424c49f`). Integrated it without reverting its default-enabled docs setting or optional ignored JSON export; resolved the generated artifact modify/delete conflict by preserving main's deletion. Server compilation and the 8 OpenAPI/security integration checks passed after integration. No additional full suite was run for this isolated merge.

Full GitHub CI on product commit `8e77fe8` passed server/build, PDF, PostgreSQL and dependency-audit stages. Browser suite: 234 passed, 2 skipped, 10 failures across three stale scenarios (eight equipment groups vs old seven expectation; inline contacts vs old modal flow; clearing the equipment input vs removed remove-direction button). Updated only these test flows, preserving persistence, error/draft/retry and layout assertions. All 10 affected desktop/mobile checks passed locally. Product code did not change after the full CI run. The final test-only commit triggers another GitHub check; do not describe that new run as passed before it completes.
