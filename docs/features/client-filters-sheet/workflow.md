# Client filter sheet and seven sorting modes

Source Asana1220118479825464: lead read full description/comments/attachments and both filter/sort artboards; no extra comments or attachments. Base29ac285 retains the preceding equipment/task changes. Scope excludes their further redesign and archived-client controls.

## Requirements / design

Existing bottom sheet lifecycle, white28px top radius,36×4 handle, dimmed backdrop. City and sorting fields are two equal columns with10px gap,40px fields and clipped labels with full accessible sort names. Categories/equipment are multi-select32px chips with6px gaps; no chip checkmarks. Selections apply immediately, preserving existing semantics: OR within each group, AND across groups/city/search/status. Reset clears city/groups and resets alphabetic sorting without closing or clearing search/status. Footer Reset112px and full remaining Show button48px; count updates live.

Seven menu options: alphabetic; potential/updated/progress each descending and ascending. Custom translucent gray rounded menu with white text, selected checkmark, keyboard arrows/Home/End/Escape/Tab and outside dismissal. Menu grows left from the right field and is height-bounded/scrollable or opens above when necessary.

## Architecture / security

Reused Modal and shared taxonomy. Pure matchesClientFilters/compareClients helpers hold OR/AND and deterministic sorting. Alphabetic sorting uses displayed company names; ties use name/id. Unknown potential/progress sorts last in both directions. Holding potential and ClientRow share displayedClientPotential using only supplied visible members; ordinary unknown potential stays unknown. An explicit scoped holdingMembers prop, including an empty array, takes precedence over the detail response; detail members are a fallback only when that prop is absent. This keeps collapsed/expanded card totals aligned with the scoped list sort and never adds hidden children. Progress uses server-provided level order, then server score within level; it never infers progress from manual company stage or fabricates missing scores.

Extracted ClientRow's analytics loader into client-scores.ts: token/session, employeeId and date key, in-flight deduplication only, explicit refresh invalidation, and token check before returning results. Main loads only for progress mode and passes supplied scores to rows. Direction changes reuse known progress. Scope/account reset clears scores and groups; result guards prevent stale responses crossing scope/session generations. Loading/error states are explicit, error offers retry, and Show is disabled until progress is available. No server endpoint/schema/permission changes or new data persistence.

Implementation/build passed. Four meaningful helper cases cover OR/AND/zero, all seven orders/unknowns, authoritative API-level ranking and holding display/sort consistency. Reviewer/QA stages active; no commit/push/deployment by implementer. Rollback is frontend/helper revert; saved CRM data is unaffected.

## Integrated verification and corrections

Independent source/diff review checked every literal visual criterion, multi-selection semantics, shared loader scope/session boundaries and duplication/dead-code hygiene. QA1:9 new filter cases passed with1 intentional mobile1440skip. QA2:3 independent width cases (320×568/390×900/1440×900), exact visual parameters/menu keyboard and all7 real-API orders; direction flips and expanded cards reuse one authoritative score fetch. Authored blue border1.5px verified in CSSOM; Chromium used value may round to1px, recorded explicitly rather than misreported.

QA2 additional probes: analytics503 shows error and disables Show, Retry recovers; a delayed old all-employee response cannot overwrite fresh scoped scores; progress→alphabetic mode followed by real equipment edit updates the row's score. Fixed passing stale providedScore in ordinary modes. Known/unknown values remain explicit. Lead inspected actual Claude filter and sort artboards plus rendered320px menu.

Full Node22 check:529 server tests,7 operations tests, TypeScript/production build passed. Affected legacy filter assertions were updated to new title/custom sort menu/footer layout. Previous task/equipment integration selectors were also corrected, retaining original conflict-version/ACL/persisted-fact checks and strengthening delayed Undo checks. Browser-local today helper prevents new Home-route fixtures drifting at UTC/local midnight.

Full402-case browser run:381 passed,12 intentional skips,9 failures. Six failures were obsolete pre-feature selectors; three timed out before login. Trace proved local assets loaded successfully while external Telegram SDK kept page.goto waiting until the test deadline. Added an external SDK stub only to demo browser E2E fixture (native SDK mock tests retain their own mocks); no production/auth change or timeout increase. Corrected and affected scenarios are rerun below; the initial full run is not claimed green.

Final corrected/previously failing scenario retest:14 passed, including both renamed equipment cases and entry-timeout cases. Final combined new-filter/equipment/task-sheet/native-header/viewport regression after SDK fixture change:67 passed,3 intentional skips (1.7m). Independent review of legacy-test changes confirmed API/ACL/version assertions retained, not weakened; SDK stub does not alter production/auth API behavior. All observed full-run failures have been corrected and separately passed; the entire402-test command was not repeated after corrections. Format/diff checks passed.

Implementation accepted within browser/API scope; no production deployment/push/merge. Asana remains In Progress: native browser automation reported the Mac locked when attempting Done; status was not changed. Branch contains the two preceding checked features.
