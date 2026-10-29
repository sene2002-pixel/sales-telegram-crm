# Inline equipment amounts — 29 October 2026

Source: [Asana task 1219854440720985](https://app.asana.com/1/1218599458205876/project/1218585786925552/task/1219854440720985). Complete description, attachment and comment sections were read in the authenticated browser; no attachments or additional comments. The linked keyboard task 1219858734786448 is already complete in main. The Claude reference was previously confirmed unavailable; acceptance follows the explicit Asana specification, without claiming pixel comparison to inaccessible artboards.

## Requirements and design

Editing must keep the white equipment row at 40px with a 12px radius: label left, amount and million-ruble unit right. The active row has a 1.5px #1F7AEA border. The amount input is transparent, borderless, right-aligned, 14px bold, decimal input mode, with initial caret at the end. Save on loss of focus, update both potential totals, and retain keyboard navigation hiding. Unit typography is unchanged from read mode. Errors appear below the row with the draft preserved.

Two analysts inspected the existing snapshot semantics and test impact. Two designers specified stable geometry and separate error placement. Technical/security decision: a dedicated InlineAmount component only for existing equipment; other InlineValue fields and the add-equipment form remain unchanged. No API, permission, schema, migration or production-data mutation. The original onSave closure/version is frozen when editing begins; retries cannot silently adopt a newer version. Explicit client validation uses the same maximum as the server (1,000,000 million rubles = 10^12 rubles). Rollback: revert this PR.

## Implementation and review

Whole-row click and the native amount button open the editor. Blur saves; Enter commits; Escape cancels. A synchronous request guard prevents concurrent blur/Enter/retry saves, and a closed/cancelled session prevents an unmount blur from resubmitting. Unchanged values close without a request. Pending input is read-only and has an accessible status.

Both independent reviewers found a cancellation race after an Enter-triggered error: clicking cancel could blur the input and resubmit before cancellation. Pointer-down focus preservation and the keyboard cancellation-target guard fix it; a real 429 regression verifies no additional PATCH and unchanged stored value. Both reviewers re-reviewed the final implementation and passed.

Designer iteration 1: both reviewed real read/edit/error screenshots at 320/390. Designer 1 also reviewed two simulated-keyboard screenshots showing the row above the usable viewport and no bottom navigation. Unit typography was confirmed to remain as before; the 14px requirement applies to the input amount. Iteration 2 clarified error units and enabled clicking the label/whole row; designers rechecked the final error states. Screenshots are in `screenshots/`.

## Verification

- Final selected browser run: 31 passed, 1 intentional desktop-only skip in the mobile project. Selection: new amount regression, client-card, client-card-inline, keyboard-navigation, swipe-surface.
- New tests check stable 40px height, unit position, active border, caret end, decimal input, blur persistence and both totals; invalid/blank/negative/over-cap drafts produce no PATCH; zero persists; Escape cancels; Enter error followed by cancel makes no extra PATCH. A deterministic request gate confirms Enter + blur emits only one request.
- Existing stale-version tests were adapted from explicit Save to real blur while preserving repeated 409, opening-version and unchanged-server-data assertions. Existing successful inline save/archive assertions also remain.
- `npm run check`: 514 server tests passed, 4 PostgreSQL-only skips locally; 7 ops tests passed; build passed. Final frontend build also passed after the last UI validation change. Local test server health passed before browser tests.
- First new test run found a test expectation using a decimal dot for the localized header (which correctly uses a comma); corrected the expectation, not production formatting.
- Full GitHub CI is a merge gate; final results are on the PR.

Physical iOS/Android keyboards were not tested. Keyboard screenshots use the existing labeled viewport simulation and do not constitute physical-device evidence.
