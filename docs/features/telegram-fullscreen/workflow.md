# Telegram: fullscreen and swipe isolation

Request: remove the large native title header and stop CRM gestures dragging/minimizing the Telegram sheet.

Scope / acceptance: request native fullscreen once on Telegram 8.0+ unless already fullscreen; disable native vertical closing swipes on 7.7+; preserve ordinary CRM scrolling, safe-area offsets, orientation guard and authentication. Old/unsupported clients keep expanded mode. Do not force fullscreen again after an intentional exit or a failed request. Native close/menu controls remain Telegram-owned.

Analysis / product / UX / design: reuse existing viewport lifecycle and safe-area CSS instead of another header or global touch blocker. Content must stay below device/native controls, including changed fullscreen insets. No redesign or data changes.
Architecture / security: SDK calls are guarded; errors must not interrupt auth. Restore swipe capability on cleanup only when this lifecycle disabled it. No server permission, token, API or schema changes. Rollback is reverting this frontend change.

Implementation: replaced the old forced exitFullscreen with a bounded requestFullscreen; added version-gated disableVerticalSwipes and owned cleanup. Updated contradictory native-header tests and compatibility expectations.

Review: two independent reviewers assessed the actual diff; no duplication, unused code or blocking regression found. QA1: 26 viewport/header browser tests passed (desktop/mobile), including SDK failures, versions and owned swipe cleanup. QA2: 6 independent visual browser checks passed; 390px screenshot inspected, no clipping or overlap. Build passed. Full Node22 repository check passed: 523 server tests, 7 operations tests, TypeScript and production build. Product acceptance passed within the browser/mock verification scope. Ready for release; not pushed, merged or deployed. Physical Telegram/iPhone verification remains required: browser SDK mocks cannot demonstrate the native window itself.

SDK reference: https://core.telegram.org/bots/webapps#initializing-mini-apps
