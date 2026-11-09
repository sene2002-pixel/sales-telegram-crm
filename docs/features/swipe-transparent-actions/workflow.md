# Swipe actions without a painted background

The user's latest screenshot/request supersedes the white-rail requirement in Asana1220118748920690: actions must appear directly on their surrounding surface. Source task read: description and linked requirements, no attachments/comments present. This scoped correction changes only the action rail/button paint, not gesture behavior, authorization or deletion.

Design: transparent rail and buttons in normal/hover/active states, same muted22px icons and full-height56px action targets. List background shows behind outer client actions; white card surface remains behind nested equipment/contact/file actions. Keyboard focus indication remains available. Reuse current CSS selectors; no new wrapper, helper or dependency.

Implementation: changed the three final white backgrounds to transparent and clarified their comment. Updated existing screenshot/geometry regression to assert transparency instead of white.

Review passed: actual CSS cascade checked independently, no duplicate/unnecessary code added, keyboard focus preserved. QA1:13 affected swipe/keypad checks passed,1 intentional mobile landscape skip; nested company/contact/equipment/file transparency and hover assertions. QA2:3 independent browser checks at320/390/1440px, including mouse-down active state,56px targets and no horizontal overflow. Both reviewers inspected rendered screenshots; outer actions show list canvas, nested actions preserve the white parent card. Full Node22 check:523 server tests,7 operations tests, TypeScript and production build passed. Physical Telegram was not tested. Rollback: revert CSS and related expectations; no data changes. No push or deployment requested for this correction yet.
