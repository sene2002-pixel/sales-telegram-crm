# Equipment creation sheet

Source: Asana1220127464725943, full description and linked keypad/navigation requirements read by lead; no comments or attachments present. Main baseline65ab6a6. Scope: replace the legacy gray inline EquipmentForm, without changing server contracts or permissions.

## Requirements / design

- Bottom sheet “Новое оборудование”, existing Modal backdrop rgba(34,42,92,.42), white surface/top radius28, handle36×4 and close button; bottom navigation hidden while open. Close, backdrop, Escape, Telegram Back and downward header/handle swipe cancel unsaved work.
- Eight existing primary divisions as single-selection chips; no initial selection; existing amounts including zero disable their types. Hide add action once all eight primary divisions exist. Retain legacy unspecified-voltage equipment separately.
- Potential in millions,48px outlined field,22px/800 value, fixed unit. Native keyboard disabled using inputmode none. Reuse Pico digit/comma/erase keys inline, with no second floating keypad and no implicit save. Long values stay within the input; invalid values cannot submit.
- Add48px full-width primary button disabled until both type and valid amount exist. Saving prevents duplicate submission and dismissal. Errors retain selected type/amount. Explicit Add uses existing company mutation/version and refresh; newly added items append to displayed equipment order. No unrelated cleanup.

## Architecture / security

Reused Modal focus trap, scroll lock and Telegram Back lifecycle; optional swipeToClose is opt-in for this sheet only. Extracted the existing digit grid and key update helper from PicoNumberInput, retaining its existing append/erase/one-decimal behavior and standalone save lifecycle. EquipmentSheet owns only the unsaved controlled amount/type, using the shared grid. The obsolete EquipmentForm was removed.

Company opening snapshot/version stays immutable. Existing PATCH validates data and server authorization;409 refreshes displayed detail but never replaces the draft's original mutation version. A conflict retains unsaved text and asks the user to reopen. No API/schema/data migration or sensitive logging. Rollback is frontend revert; saved division values remain ordinary CRM data.

Implementation and verification:
- Independent reviewer passed the actual diff before QA, including server ACL/version reuse, immutable conflict snapshot, safe busy dismissal, zero-valued existing equipment, scoped Modal change, and shared keypad extraction. Obsolete EquipmentForm removed; no duplicated/unnecessary code found.
- QA1:11 new equipment scenarios passed with1 intentional mobile1440 landscape skip. Real API add/header/list/analytics totals, zero/bounds, no default, duplicate disabling, all8 hideAdd, three cancel paths without PATCH, real concurrent409 preserving draft.
- QA2:3 independent scenarios passed at320/390/1440, real API and genuine CDP touch dismissal on narrow screens; screenshots inspected.
- Existing keypad/inline regression:11 passed,1 intentional mobilelandscape skip. Selection, save failures/conflicts and short-screen clearance preserved.
- Full Node22 check:523 server tests,7 operations tests, TypeScript and production build passed. Format and diff checks passed.
- Designer/lead inspected the actual Claude variantA artboard and rendered320px implementation. Physical Telegram/iPhone remains untested; inputmode none is browser-verified.
Release: ready for review; no push, merge or production deployment performed. Rollback is frontend revert without migrations.

Final visual correction: lead noticed a pale rectangle in the amount input. Independent computed-style probe confirmed a later global .modal input rule overrode its background. Scoped the input selectors to EquipmentSheet; repeated computed-style/PNG review confirms transparent input over white modal and exact settled #1F7AEA selected/add colors. Added a strict input-background assertion; all11 equipment tests passed again (1 intentional skip). Build and diff checks passed afterward. Asana moved to Done and completed after these checks; repository release remains separate.
