# Home spacing and bottom access

Source: Asana 1220126988541937. Measurable targets: 16px side gutters; counters to Today 20px; headings to cards 8px; cards to Meetings 20px; Meetings to overdue 10px. All five tabs keep their last action accessible above fixed navigation; feed extends under navigation. Mobile navigation has 72px content height plus safe bottom inset; scroll padding adds another 16px.

The Claude visual reference could not be opened (connection reset). Exact textual dimensions are the implementation source; visual equivalence to the inaccessible canvas is not claimed.

Cause: overview bottom margin and first heading top margin each contributed 20px. Home workspace also reserved navigation space outside its inner scrolling feed, ending the feed above the navigation. Fix removes the extra overview margin and external bottom reservation, moving navigation clearance into feed scroll padding. Other tabs receive consistent navigation clearance. No authorization/data/API changes or migration. Rollback is reverting the CSS change.

Implementation and independent source review passed. npm run check: 518 server tests passed, 0 skipped; ops 7/7 and build passed. Persistent browser regression: 5 passed, 1 intentional mobile landscape skip; widths 320/390/1440, safe inset 0/34px, actual 20/8/20/10 spacing, home feed reaches viewport bottom, real overdue action and synthetic last actions remain above navigation and accept clicks on all five tabs. Independent browser QA also passed 5/1. Keyboard hiding override reviewed in source; real iOS keyboard and inaccessible Claude canvas not verified. Logs: /tmp/pico-home-check.log and /tmp/pico-home-spacing-overdue.log. No production changes, publication or Asana Done claim.
