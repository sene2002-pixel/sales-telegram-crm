# Swipe card surface bug — 29 October 2026

Source: [Asana bug 1219862791213260](https://app.asana.com/1/1218599458205876/project/1218585786925552/task/1219862791213260), and its linked client-card task 1219626327457928. Both descriptions, attachment sections and comments were read in the authenticated browser. Neither task had attachments or additional comments. The current Claude artifact returns a missing-page screen; the supplied invitation reports unavailable. Visual acceptance therefore follows the explicit Asana geometry/color specification; pixel equality with the currently inaccessible artboards is not claimed.

## Scope and decisions

The client surface (white fill, 20px radius and #E6EBF3 inset border) moves with its content. The stationary wrapper has no card fill/border or focus-within highlight. The action area is #F3F6FB with neutral #6B7390 icons, 22px. Two actions occupy 112px; one occupies 56px. The same component applies to contacts, equipment, files and closed clients. Existing authorization, archiving, confirmation, keyboard operation and visible-portion action centering remain unchanged. No data migration or production data mutation is required. Rollback: revert this PR.

## Implementation and review

- Reproduction passed: the new test failed against main because the stationary article retained its inset border.
- Developer: moved the outer card's visual surface onto its transformed direct child; removed the parent's focus-within outline; corrected the shared single-action width from 64 to 56px.
- Independent Reviewer 1 and Reviewer 2: no blockers in actual CSS cascade/component diff. Their requested file/closed-client coverage was added.
- Designer 1 and Designer 2, iteration 1: movement accepted; keyboard-generated screenshots showed the browser's orange keyboard-focus outline. They requested gesture screenshots, preserving keyboard focus behavior.
- Iteration 2: real mouse drag through Playwright replaced keyboard reveal for visual evidence. Both designers inspected all twelve mobile screenshots (six scenarios at 320/390px) and passed. Production CSS required no further change. Screenshots are in `screenshots/`; the closed-client state is also asserted by selecting its filter in the test.

## Verification

`e2e/swipe-surface.spec.ts` exercises hidden actions, movement/width/color/surface geometry, unchanged content width, collapse/expand, nested contact/equipment/file gestures, keyboard reveal/escape, and the closed-client filter. It creates only isolated test data. A first desktop drag was unstable while layout settled; waiting for the locator's hover actionability before starting the drag corrected the test setup without retries or weaker assertions.

- Focused swipe + existing client-card tests: 12 passed (desktop/mobile Chromium).
- `npm run check`: passed — 514 server tests passed, 4 PostgreSQL-only tests skipped locally; 7 ops tests passed; production build passed. Local test server health check passed before browser tests.
- Full GitHub CI is a required merge gate; its final result is recorded on the PR.

Limitations: physical iOS/Android and inaccessible source-artboard pixel comparison were not performed. Screenshots establish rendered appearance; behavioral assertions establish the listed interactions.
