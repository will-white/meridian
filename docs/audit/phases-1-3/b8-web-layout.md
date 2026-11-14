# Audit record: the web app's shell, layout and PWA (b8-web-layout)

Scope: the web app's shell (`App`, `main.tsx`, `Layout`, the query client, the API client, the auth status), its stylesheet and responsive layout, the service worker and its updates, date formatting of timestamps, and the accessibility checks the shell checklist covers, including the page files those checks exposed (register, Accounts, Connections, the Investments period picker, the dashboard chart, the CSV pickers).

All fifteen findings were judged real and fixed; none was rejected or deferred. The decisions are recorded in `docs/phase-1-plan.md`, "Decisions made during the audit", 83 to 89, and `docs/phase-2-plan.md`, A27. The README describes the update notice.

Checks: `pnpm typecheck` and `pnpm lint` pass; `pnpm --filter @meridian/web test` passes (29 files, 337 tests); `pnpm build` passes. The built app (the API serving `apps/web/dist`) was checked in headless Chromium on port 3491 (the Phase 2 plan seed, an owner, a viewer "kid", long account and payee names) and on 3492 (two builds served one after the other, for the update). The scripts and their output are in the lane's scratch directory, `laneB/b8`: `check-b8.cjs` (the findings' browser checks; `before-browser*.txt` against the build before the fix, `after-browser*.txt` after it), `sw-check.cjs` with `after-sw.txt` (the update offer), `routes.cjs` with `after-routes.txt` (22 routes at 360, 390, 430, 768, 820 and 1280 px in light and dark: no page overflow, one `<main>` with an `<h1>`, a route title, no console or page error), and the screenshots `after_*.png`.

Every new test was run against the code before the fix and failed there (`before-shellAudit.log`: 35 of 38 failed; the 3 that passed are guards against the fix going too far or drifting: a plain date is never shifted, Accounts keeps a list it loaded, and the charts' fallback colour equals the stylesheet's).

All tests named below are in `apps/web/src/components/shellAudit.test.tsx`.

## b8-web-layout-01 (medium): one failed refetch of the auth status replaced the app with "The API is unreachable"

Status: fixed.

What was wrong: App tested `status.isError` before `status.data`. In TanStack Query v5 a failed refetch keeps the data and sets the error, and the auth status had `retry: false`, so one dropped request on a focus refetch (a 502 while the container restarts, a reconnect before the phone's network is up) unmounted the shell and the open page, threw away what was typed, and left a full-screen message with no way back but another focus event.

What changed: App renders from the auth status whenever one was loaded; the full-screen "The API is unreachable" now has **Try again** and appears only when no status was ever loaded. `authStatusQuery()` retries a network error or a 5xx twice like every query (`shouldRetry`), never a 4xx. While the last status refetch failed, the shell shows a notice above the page with the error's text. Decision 83.

Tests:
- Suite "b8-web-layout-01: a failed background refetch of the auth status keeps the app on screen":
  - "renders the signed-in shell and the open page from the last known status, with a small notice"
  - "shows the full-screen message, with a way to try again, only when no status was ever loaded"
  - "retries the auth status after a network error or a 5xx, never after a 4xx"
- Browser (`check-b8.cjs` 01): at 390 px on /accounts with "Beach house" typed, one `/api/auth/status` refetch aborted with `connectionreset`: before, the body was only the unreachable message and the field was gone; after, the nav and the field ("Beach house") stay. A first load with the API unreachable shows the message and **Try again**.

## b8-web-layout-02 (medium): after an expired session the next member saw the previous member's cached data

Status: fixed.

What was wrong: only a sign-out (`showSignedOut`) removed the cached queries. A 401 refreshed the auth status, and the sign-in screen came back, but the owner's sessions, all members' sign-in activity and every page's data stayed cached; a viewer who then signed in on the same tab saw them (rows with Sign out buttons, the owner's session badged "this browser") until their own responses arrived, and for good if those failed.

What changed: `watchMember` (installed by the new `createQueryClient`, which `main.tsx` uses) follows the auth status and, whenever it names someone else than before, drops every query but the status and the sign-in notice before the new status renders: removed when no one is signed in, and when another member is, removed if no page shows them and reset if one does (a removed query tells its observers nothing, so an open page in a tab where another member signed in would keep showing the old rows). A failed or same-member refetch forgets nothing. `useAuthMutation` writes the status, so a sign-in goes through the same watch. Decision 84.

Tests:
- Suite "b8-web-layout-02: what was loaded for one member is never shown to the next":
  - "an expired session (a 401 on any request) forgets the member's data once the status says signed out"
  - "a status that names another member (signed in elsewhere in the same browser) resets what is on screen"
  - "a refetch of the same member's status, or one that fails, forgets nothing"
- Browser (`check-b8.cjs` 02): the owner's "Firefox on iOS" session ends the tab's session; a focus refetch gets the 401 and the sign-in screen; kid signs in with `/api/auth/sessions` and `/activity` slowed by 4 s. Before: 0.5 s after sign-in the nav said "kid" while Settings listed the owner's iPhone session and "Sign in required" (`before-browser-02.txt`). After: neither is shown, then or 5 s later.

## b8-web-layout-03 (medium): timestamps showed their UTC day

Status: fixed.

What was wrong: `shortDate` printed the first ten characters of whatever it got, and four call sites passed timestamps (alerts' `createdAt`, reconciliation history's `createdAt`, the price status's `nextAttemptAt`, the price run's `runAt` and `finishedAt`). An alert created at 17:26 in Denver (00:26 UTC) read "11/14/26" on a browser whose dashboard said "as of 11/13/26".

What changed: `shortDate` shows a calendar date (YYYY-MM-DD) as written and a timestamp as the browser's local calendar date, which is the date the app sends as `today` (phase 2 decision 16, A22). The call sites pass the whole timestamp. Decision A27 (phase 2 plan).

Tests:
- Suite "b8-web-layout-03: a timestamp is shown as its local calendar date":
  - "an alert created at 00:10 UTC on Nov 14 is Nov 13 in Denver, the day the dashboard calls today" (also Tokyo, a positive offset)
  - "a plain calendar date is never shifted, whatever the zone"
- Browser (`check-b8.cjs` 03, zone America/Denver): the alert of 2026-11-14T00:26:40Z showed "11/14/26" before and shows "11/13/26" after.

## b8-web-layout-04 (medium): the register made the whole page scroll sideways on phones and tablets

Status: fixed.

What was wrong: the register table was not in a `.scroll` box, so its width (891 px at 360 to 768 px, 1,113 px at 820 px with the seed's long account name) widened the page, the nav and the filters with it.

What changed: the register is in a `.scroll` box like every other wide table, so the page never scrolls sideways; at 800 px and below the account name may wrap (`.register-account`) and the category select is at most 9rem, so the table needs less sideways scrolling inside its box (531 px of content in a 330 px box at 360 px, against 891 px of page before). Decision 88.

Tests:
- Suite "b8-web-layout-04: the register scrolls inside its box on a phone":
  - "the register table is inside a .scroll box"
  - "at phone width the account name may wrap and the category select shrinks"
- Browser (`check-b8.cjs` 04): page scrollWidth equals the viewport at 360, 390, 430, 768 and 820 px (before: 891, 891, 891, 891, 1113). Screenshot `after_transactions-360x800-light.png`.

## b8-web-layout-05 (medium): the desktop sidebar could not scroll

Status: fixed.

What was wrong: the sticky sidebar is `100vh` tall with no overflow setting, so in a window shorter than its links (about 650 px, or browser zoom) Settings and Sign out were below the viewport and stayed there whatever was scrolled.

What changed: `.nav` has `overflow-y: auto`; the shell also scrolls the active link into the sidebar when the sidebar scrolls (decision 88).

Tests:
- Suite "b8-web-layout-05: the desktop sidebar scrolls on its own when it is taller than the window": ".nav (sticky, 100vh) has overflow-y: auto"
- Browser (`check-b8.cjs` 05) on /dashboard after scrolling the sidebar: Sign out's bottom edge 484 px in a 500 px window at 1280x500, 585/600 at 1024x600, 435/450 at 960x450 (before: 645 or 646, below the window each time).

## b8-web-layout-06 (medium): the dashboard chart did not shrink when the viewport narrowed

Status: fixed.

What was wrong: `.dash-grid .card { min-width: 0 }` missed the grid item that holds the chart (`div.wide`), whose automatic minimum width was the fixed-pixel canvas ECharts had drawn, so the grid track never narrowed and the chart's ResizeObserver never fired. Rotating a phone to portrait left the dashboard 614 px wide on a 390 px screen until a reload.

What changed: `.dash-grid > * { min-width: 0 }`, and the shared `EChart` wrapper has `min-width: 0` and `contain: inline-size`, so its width comes from its box and never from the canvas inside it (no `overflow: hidden`, which would clip the tooltip). Decision 88.

Tests:
- Suite "b8-web-layout-06: the dashboard chart cannot hold the page wide":
  - "every dashboard grid item may shrink below its content"
  - "the chart wrapper does not take its width from the canvas inside it"
- Browser (`check-b8.cjs` 06): a phone rotated from 844x390 to 390x844 gives page 390/390 and chart 328 px (before: 614/390, chart 567 px); a window narrowed from 1280 to 360 px gives page 360/360 and chart 298 px, and widening to 1100 px grows the chart to 823 px (before: 1050/360, chart 1003 px).

## b8-web-layout-07 (medium): the CSV file pickers could not be reached by keyboard or screen reader

Status: fixed.

What was wrong: `label.file input { display: none }` removed the file input from the focus order and the accessibility tree on the bank, positions and trades imports, so none of them could start without a mouse or touch.

What changed: the input is hidden visually (absolutely positioned, 1 px, `opacity: 0`, clipped) but stays focusable and is named by its label's text ("Choose CSV…"); `label.file:focus-within` draws the focus ring on the label. Decision 89.

Tests:
- Suite "b8-web-layout-07: the CSV file pickers are reachable by keyboard and screen reader": "the file input is hidden visually, not removed (no display: none), and its label shows the focus"
- Browser (`check-b8.cjs` 07): Tab reaches the file input on /import, /import?kind=positions and /import?kind=trades and the label shows a solid outline (before: never reached in 40 presses).

## b8-web-layout-08 (low): no error boundary

Status: fixed.

What was wrong: a render exception unmounted the whole app: a dashboard response without `cashFlow` left an empty `#root`, and reloading the same URL crashed again.

What changed: `ErrorBoundary` (`components/ErrorBoundary.tsx`) wraps the routed page in the shell, keyed on the path, with `PageError` (the message, **Try again**, which drops the cached responses so the page loads afresh, and **Reload**); following another link clears it. `main.tsx` wraps the app in a second boundary (`AppError`, with **Reload**) for errors outside the routes. Decision 86.

Tests:
- Suite "b8-web-layout-08: a page that fails to render leaves the shell usable":
  - "the boundary catches the error and shows it with Try again, and a new route clears it"
  - "the shell wraps the routed page in the boundary, keyed on the path"
- Browser (`check-b8.cjs` 08): with `cashFlow` removed from `/api/dashboard`, the nav stays and the page reads "This page could not be shown … reading 'points'" with **Try again**; clicking Accounts in the nav then shows the Accounts page (before: a white page and no nav).

## b8-web-layout-09 (low): "autoUpdate" never updated an open app

Status: fixed.

What was wrong: the build injected `registerSW.js`, which only registers the worker; the reload on a new worker lives in `virtual:pwa-register`, which the app never imported, and nothing checked for updates while the app stayed open. After a deploy an open app (an installed PWA above all) kept the old build with no reload and no prompt.

What changed: the page registers the worker itself (`lib/swUpdate.ts`, `registerType: "prompt"`, `injectRegister: false`, no new dependency). It checks for a new build when the app comes back into view and hourly; a new worker installed beside the running one shows "A new version of Meridian is ready" with **Reload to use it**, which tells the waiting worker to take over (the generated `sw.js` handles `SKIP_WAITING`) and reloads once it controls the page. A prompt rather than an automatic reload keeps whatever is being typed. The first install offers nothing. Decision 87; README "Quick start".

Tests:
- Suite "b8-web-layout-09: a new build is offered to the open app":
  - "offers the waiting build, activates it on request and reloads once it controls the page"
  - "checks for a new build when the app comes back into view, and on a timer"
  - "the first install (nothing controls the page yet) offers nothing, and a controller change it did not ask for reloads nothing"
  - "the build asks to be offered, not to take over the open page on its own"
- Browser (`sw-check.cjs`, `after-sw.txt`, persistent profile on 3492): build v1 loads and its worker controls the page; the server restarts with build v2 while the app stays open; when the page comes back into view the notice appears and the page has not reloaded on its own (still v1); **Reload to use it** shows v2, and a new window opens v2. The auditor's probe saw v1 stay after 10 s with a single load event.

## b8-web-layout-10 (low): the Investments period picker widened the page on phones

Status: fixed.

What was wrong: `.inv-seg` was an `inline-flex` that could not wrap, so the nine period buttons made /investments, /investments/performance and /investments/income 431 px wide at 360 to 430 px.

What changed: `.inv-seg` wraps and is at most as wide as its row; each button's bottom border separates wrapped rows (clipped on a single row). The import page's file-kind switch uses the same control. Decision 88.

Tests:
- Suite "b8-web-layout-10: the Investments period picker wraps instead of widening the page": ".inv-seg wraps and is never wider than its row"
- Browser (`check-b8.cjs` 10): page scrollWidth equals the viewport on /investments at 360, 390 and 430 px and on /investments/performance and /investments/income at 360 px (before: 431). Screenshot `after_investments-360x800-light.png`.

## b8-web-layout-11 (low): the phone header stretched on short pages, and Sign out and the active link were off-screen

Status: fixed.

What was wrong: at 800 px and below the shell's two implicit rows were stretched to fill `min-height: 100vh`, so a short page (/import) had a 270 px header; the header was one 1,457 px strip in which Sign out (x = 1401) and, on /settings, the active link (x = 1263) were off-screen with no scroll into view.

What changed: the phone shell has `grid-template-rows: auto 1fr`; the header is a grid with the brand and the member with Sign out on the first row and the links in a strip of their own below, which scrolls sideways by itself; the shell scrolls the active link into that strip on every route change (`revealInside`, which moves only the strip, never the page). Decision 88.

Tests:
- Suite "b8-web-layout-11: the phone header is a compact bar":
  - "the shell's rows are the header and the page (a short page does not stretch the header)"
  - "the links scroll in their own strip; the member and Sign out stay in the top row"
  - "the active link is scrolled into its strip, never by scrolling the page"
- Browser (`check-b8.cjs` 11, 390x800): header height 77 px on /import, /dashboard and /settings, the active link and Sign out on screen on all three (before: 270 px on /import, Sign out at x = 1401, the Settings link off-screen). Screenshots `after_import-390x800-light.png`, `after_settings-390x800-dark.png`.

## b8-web-layout-12 (low): light-mode muted text was 4.44:1

Status: fixed.

What was wrong: `--muted: #64748b` on `--bg: #f6f7f9` is 4.44:1, below WCAG AA for normal text (register headers and account names, the dashboard's "as of" line, help text), and 3.5 to 4.4:1 on the plan's tinted rows.

What changed: `--muted: #556274`: 5.79:1 on the page, 6.20:1 on cards and at least 4.59:1 on every tinted plan background (bucket row, group stripe, current month, overspent, overspent current month). Dark mode is unchanged. The charts' light fallback colour follows. Decision 89.

Tests:
- Suite "b8-web-layout-12: light-mode muted text meets WCAG AA":
  - "muted text is at least 4.5:1 on the page, on cards and on the tinted plan rows, in both schemes" (computed from the stylesheet's tokens; before, six backgrounds were below 4.5:1)
  - "the charts' fallback colour is the stylesheet's"

## b8-web-layout-13 (low): network failures showed "Failed to fetch" and pages fell through to empty states

Status: fixed.

What was wrong: a rejected `fetch` reached the page as the browser's own text ("Failed to fetch", "Load failed", "NetworkError…"); a 502 with an empty body read "Request failed (502)"; and Accounts showed "Net worth $0.00" and "No accounts yet", the register "No transactions match", for lists that never loaded. The query retry policy also counted any `ApiError` below 500 as final, which a status-0 error would have been.

What changed: `api()` turns a rejected fetch into `ApiError` status 0, code `network`, "Can't reach Meridian. Check the connection; the app tries again on its own." (a cancelled request stays a cancellation); a 502, 503 or 504 without the API's JSON says the server is not answering. `shouldRetry` retries status 0 and 5xx twice and never a 4xx. Accounts shows the net worth and the empty state, and the register its empty state, only for a list it loaded (a failed refetch keeps the last list and its total). Decision 85.

Tests:
- Suite "b8-web-layout-13: a request that never reached the API says so, and nothing pretends it loaded":
  - "a rejected fetch becomes ApiError 0 'network' with a readable message (a cancelled one stays a cancellation)"
  - "a 502 from the proxy without a JSON body says the server is not answering"
  - "queries retry a network error and a 5xx, not a 4xx"
  - "Accounts shows no net worth and no empty state when the list could not be loaded"
  - "Accounts keeps the last loaded list (and its total) when a refetch fails"
  - "the register shows no 'No transactions match' when the list could not be loaded"
- Browser (`check-b8.cjs` 13, every `/api` call except the auth status refused): /accounts, /transactions and /dashboard read "Can't reach Meridian…" with no "Failed to fetch", "Net worth $0.00", "No accounts yet" or "No transactions match" (before: all four, `before-browser-2.txt`).

## b8-web-layout-14 (low): no page titles, no skip link, an unlabelled main nav, no main landmark when signed out

Status: fixed.

What was wrong: `document.title` was "Meridian" on every route; keyboard users tabbed through 15 links on every page; the main nav had no label while the Investments sub-nav had one; the sign-in screens had no `<main>`.

What changed: `pageTitle(pathname)` (`lib/navigation.ts`, which now also holds the nav and Investments link lists) sets "Transactions · Meridian", "Holdings · Investments · Meridian", "Account · Investments · Meridian"; the sign-in screens set "Sign in · Meridian" and so on. The shell starts with a "Skip to content" link (visible on focus) that focuses `<main id="content" tabindex="-1">`; the nav is labelled "Main"; the signed-out screens, the loading and the unreachable screens are a `<main>`. Decision 89.

Tests:
- Suite "b8-web-layout-14: titles, landmarks and a skip link":
  - "each route has its own document title"
  - "the shell starts with a skip link to the main region and labels its navigation"
  - "the sign-in screens are a main landmark"
- Browser (`check-b8.cjs` 14): titles "Dashboard · Meridian", "Transactions · Meridian", "Holdings · Investments · Meridian", "Settings · Meridian"; the first Tab lands on "Skip to content" and Enter moves the focus to `main#content`; nav labels ["Main"]; the signed-out screen has one `<main>` and the title "Sign in · Meridian". `routes.cjs`: every route has a title of its own.

## b8-web-layout-15 (low): form controls without an accessible name

Status: fixed.

What was wrong: the register's search field and each row's category select, the Accounts rows' type and tax-treatment selects and the add form's name and type, and the Connections name and setup-token fields had a placeholder or options but no name, so a screen reader announced only "combo box" or "edit text".

What changed: each has an `aria-label`: "Search transactions", "Category for <payee or description>", "<account> type", "<account> tax treatment", "Account name", "Account type", "Connection name", "SimpleFIN setup token". Decision 89.

Tests:
- Suite "b8-web-layout-15: every form control has a name":
  - "the register: the search field and each row's category select"
  - "Accounts: each row's type and tax treatment, and the add form"
  - "Connections: the name and the setup token"
- Browser (`check-b8.cjs` 15): 0 controls without a name on /transactions, /accounts, /connections, /dashboard, /plan, /settings, /import and /investments (before: 28, 10 and 2 on the first three).

## Not changed

- The register at phone width scrolls inside its box rather than stacking each row; Category and Amount are a sideways swipe away inside the table at 360 px. A stacked phone layout for the register is a design change (it needs the table's semantics kept under a grid display) and is not needed for the finding, whose defect was the page scrolling.
- The plan grid's 0.35-opacity "⋯" menu glyph (plan-area styling, noted by the auditor and not reported) is unchanged.
