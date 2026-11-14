# Audit record: Phase 2 and Phase 3 conformance (b9-conformance-plan-investments)

Scope: what the spending plan, the cash flow and the investment views offer against the spec and the Phase 2 and Phase 3 plans: realized gains and lots in the web app, the cash flow's opening balances, the plan's edit history, the plan's range check and month window, the Portfolio's valuation of a full-history account, annualized returns, and price staleness without a price feed.

All eight findings were judged real and fixed; none was rejected or deferred. The decisions are recorded in `docs/phase-2-plan.md`, "Decisions made during the audit", A29 to A31 (and decision 11), and `docs/phase-3-plan.md`, A18 to A21 (and decisions 8 and 10). The area designs (`docs/design/phase-2/cashflow.md`, `grid-and-api.md`; `docs/design/phase-3/lots-and-performance.md`, `prices-and-valuation.md`, `views-and-api.md`), the README and `.env.example` are updated where the changes made them wrong.

Checks: `pnpm typecheck` and `pnpm lint` pass; the suites pass: shared 48 files, 930 tests (including `packages/shared/src/retirement`); db 48 files, 364 tests; worker 13 files, 110 tests; api 39 files, 315 tests; web 31 files, 353 tests (TEST_DATABASE_PREFIX `meridian_fix_b_`); `pnpm build` passes. The built app (the API serving `apps/web/dist`, `PRICE_PROVIDER=none`) was checked in headless Chromium on port 3493 against `meridian_fix_b_b9chk`, a copy of the auditor's dataset `meridian_fix_b_conf`. The scripts and their output are in the lane's scratch directory, `laneB/b9fix`: `check-b9.cjs` with `after-browser.txt` (findings 01 to 04), `check-b9b.cjs` with `after-browser-b.txt` (05 to 08), `check-b9c.cjs`, `check-b9d.cjs` and `check-b9e.cjs` with their `after-browser-*.txt` (the history's wording, a cell's history and its undo), and the screenshots `after-*.png`.

Every new test was run against the code before the fix (a copy of the worktree with the sources at the batch's base commit and the new tests; logs `before-*.log` in `laneB/b9fix`) and failed there: shared 5 of 12 (the 7 that passed are the with-feed guards, the account valued at `from` and the new pure undo helper's own unit tests), db 3 of 3, api 2 of 8 (the six others are the file's earlier tests and the undo round trip, which uses the routes that already existed), web: the performance cells 3 of 18, the month-window tests 5 of 5 (`before-web-b907.log`), and the two new web test files do not load (the lots drawer, the Realized gains page, the history panel and the opening helpers did not exist).

The work of an earlier, interrupted run of this batch was reviewed before it was kept: its changes for 02, 04, 06, 07 and 08 were kept with two corrections (finding 08's first version reported every provider-mode price as `implied` without a feed, even one dated on the expected close, and marked nothing as fetched; finding 07's window could pass 2199-12), and 01, 03 and 05 were done here.

## b9-conformance-plan-investments-01 (medium): realized gains and the lots themselves were never shown in the web app

Status: fixed.

What was wrong: the spec's full history "unlocks lots and cost basis … unrealized and realized gains" and the lots design's §5 names a Realized gains report and a Holdings lots drawer. No page called `GET /api/investments/realized`; `GET /api/investments/lots` was used only by the lot pick dialog of a sale. Holdings showed "N lots" as plain text.

What changed: a **Realized gains** page (`/investments/realized`, in the Investments sub-nav, title "Realized gains · Investments · Meridian") reads `GET /api/investments/realized` for a calendar year (default this year) or custom dates, and an account filter: short-term, long-term and total realized gains with their proceeds and basis, the unknown-basis proceeds kept out of the totals, one row per sale (date, account, security, shares, acquired, proceeds, basis, gain, term) with "basis unknown" and "no matching purchase" flags, the totals per account, transfers out listed apart ("not a sale, nothing realized"), and the footer "Wash sales are not applied". On Holdings, an account sub-row's lot count is a button that opens the security's **lots drawer** (`GET /api/investments/lots?accountId&securityId&asOf&includeClosed=true`): the open lots at the end of the page's date (acquired and how, shares, cost basis, basis per share, value, gain, term) with their totals, the closed lots collapsed, and the engine's warnings about the security in words. Pure helpers in `apps/web/src/lib/lots.ts`. Phase 3 plan decision A21.

Tests:
- `apps/web/src/components/conformanceAudit.test.tsx`, suite "b9-01: the lots and the realized gains are shown":
  - "the Holdings lots drawer lists the open lots with acquired, shares, basis, basis per share, value, gain and term, and the closed ones collapsed"
  - "the Realized gains page lists every disposal of the year with its proceeds, basis, gain and term, the short and long totals and the wash-sale footer"
  - "the page is in the Investments sub-nav with its own title, and a custom range is the route's (from, to] window"
- Browser (`check-b9.cjs` b9-01): the page lists the auditor's sale "06/01/26 Brokerage VTI 5 10/02/25 $1,500.00 $1,400.00 +$100.00 Short", short-term +$100.00, and the footer; on Holdings, VTI's Brokerage sub-row "2 lots" opens the drawer: 15 sh bought 10/02/25 at a basis of $4,200.00 (+$750.00, long) and 0.06 sh reinvested 12/20/25 ($18.00, +$1.80, short), totals $4,218.00 and +$751.80, the auditor's hand figures. At 390 px the page does not scroll sideways (`after-realized-phone.png`).

## b9-conformance-plan-investments-02 (medium): the cash flow projected from a stale balance with no "as of" cue

Status: fixed.

What was wrong: a manual account's balance is typed on the Accounts page and a bank CSV never changes it, so the projection started from the balance of 10/31 and ignored the 950.00 imported since (the account was already below its threshold); no page showed the date an opening came from.

What changed: for an account without a bank feed the loader adds the posted rows dated after the balance's date through today to the opening (`rolledForwardCents`, `rolledForwardRows`, `dataThrough` on `CashFlowAccount` and the response); a feed account's balance is still passed through. An opening more than two days old is named in the warnings ("Credit Union Checking: the projection starts from the balance of 10/31/26 plus 2 transactions through 11/06/26; record a newer balance or import its transactions", or "…the bank's balance of …; sync its connection" for a feed account). The Cash flow page lists every account's opening with its date and the rows added, marked when stale; the dashboard card says "Starts from balances as of …" (`DashboardView.cashFlow.balancesAsOf`, the oldest). Phase 2 plan decision A29.

Tests:
- `packages/db/src/services/conformance.audit.test.ts`, "b9-02: an account without a feed is rolled forward by the rows dated after its balance; a stale opening is named" (1,000.00 − 800.00 − 150.00 − 5.00 pending = 45.00, rows before and on the balance's day and after today left out, a feed account untouched, the projection and the dashboard on the same opening, a newer typed balance ends the roll-forward).
- `apps/web/src/components/conformanceAudit.test.tsx`, suite "b9-02: the cash flow says where each account starts": "an account's opening note names its balance date and the rows imported since; a stale one is marked", "the dashboard's 30-day card says how old its starting balances are".
- `packages/db/src/services/cashflow.test.ts`, "loads the six reads for a 30-day horizon", carries the three new fields.
- Browser (`check-b9.cjs` b9-02): the auditor's Credit Union Checking opens at $50.00, "balance of 10/31/26 + 2 transactions through 11/06/26 (-$950.00)", already below its threshold; the dashboard card says "Starts from balances as of 11/06/26".

## b9-conformance-plan-investments-03 (medium): plan, category, goal, recurring and settings edits were audited but could not be reviewed or reverted

Status: fixed.

What was wrong: the spec keeps plan edits "so changes can be reviewed and reverted", and the grid-and-api design describes the undo of a fill-right; only the Rules page read `GET /api/audit`.

What changed: **History** on the Plan page, and **History of this cell** in a cell's menu, list the audit entries of plan cells, categories, groups, goals, recurring items and settings, newest first, grouped by request, with who and when, each in words. `GET /api/audit` takes `entities` (a comma-separated list) so the panel is one paginated list. An owner's **Undo** runs `batchUndo` (`packages/shared/src/planHistory.ts`): each updated goal, setting, category, group or recurring item goes back through its own PATCH (newest change first), then one `PUT /plan/cells` puts every cell's `before` back (a created cell is cleared). A batch that created or deleted an entity, changed an order or confirmed or dismissed a suggestion is not undoable from the history, and the panel says why. When later changes touched the same values the owner confirms first. A cell's own history undoes that cell only. A viewer sees the history without Undo. Phase 2 plan decision A30 (and decision 11).

Tests:
- `apps/api/src/plan.extra.test.ts`: "b9-03 GET /audit?entities= lists the plan's history across entities, newest first, and refuses an unknown entity"; "b9-03 undoing a fill-right puts every cell of the batch back as it was, in one new audited batch".
- `packages/shared/src/conformance.audit.test.ts`, suite "b9-03: undoing a batch of the plan's history" (five tests: a cell changed twice in a batch, frozen values and pins, the PATCH bodies, what is blocked and why, newest-first entity reverts).
- `apps/web/src/components/conformanceAudit.test.tsx`, suite "b9-03: the plan's history can be reviewed and undone": "lists the changes of every plan entity grouped by request, with who and when, each in words; an owner can undo a change", "a viewer reviews the same history without the undo; a cell's own history is filtered to it".
- `apps/web/src/lib/conformance.audit.test.ts`, suite "b9-03: the plan's history in words" (two tests).
- Browser (`check-b9.cjs` b9-03, `check-b9e.cjs`): the auditor's fill-right (Dining Nov 2026 – Jan 2027 at $250.00) is one batch of three; Undo puts the three cells back to automatic in one new batch ("Undone: 3 changes put back"); from Dining Dec 2026's menu, Undo of a later fill-right puts back December only.

## b9-conformance-plan-investments-04 (low): PUT /plan/cells wrote and audited its edits before refusing an inverted range

Status: fixed.

What was wrong: `assertPlanRange` checked the 24-month cap only when `from ≤ to`; the inverted range was refused later, by the re-read after the write, so the edit and its audit row stayed while the client rolled back.

What changed: `assertPlanRange` refuses `from` after `to` ("from must not be after to") with the other range rules, before anything is written, as Phase 2 plan decision 8 requires.

Tests:
- `apps/api/src/plan.extra.test.ts`, "b9-04 PUT /plan/cells with an inverted range (from after to) writes and audits nothing".
- Browser/API (`check-b9.cjs` b9-04): 400 "from must not be after to", no audit row, May 2027 still automatic.

## b9-conformance-plan-investments-05 (low): the Portfolio could not value a full-history account before its first statement that the Performance page valued from the same trades

Status: fixed.

What was wrong: the valuation chain priced lots-basis positions only from `price` rows, so before the first statement a full-history account had no value ("no value at 11/13/25", its whole value counted as a flow), while the performance engine priced the same lots from the trades' own prices.

What changed: the loader passes the full-history accounts' trade prices (`ValuationInput.tradePrices`), and `valueAccountOn`'s lots basis uses the performance engine's fallback: the latest close on or before the date, else the account's latest trade price on or before it (`priceSource` `txn`, shown as "trade"). A position with neither stays unpriced. The day change still measures closes only. Phase 3 plan decision A20 (and decision 8). The valuation test 12's fixture now transfers shares in without a price, so its unpriced case is still unpriced.

Tests:
- `packages/db/src/services/conformance.audit.test.ts`, "b9-05: the Portfolio values it from its trades' prices, as the Performance page does, instead of counting it as a flow" (lots basis on 10-13 = 15 × 280 + 50 × 70 + 2,900.00 = 10,600.00; 1y start 10,000.00, growth 1,000.00, no flow; the Performance start and end equal the Portfolio's; the series is drawn before the statement).
- `packages/db/src/services/valuation.test.ts`, test 12, unchanged in what it asserts.
- Browser/API (`check-b9b.cjs` b9-05): the Brokerage's 1y period starts at $10,000.00 with growth $1,019.80 and no flow; the Performance route gives the same start and end for the same window; no "no value at" on the Portfolio.

## b9-conformance-plan-investments-06 (low): a 31-day return was labelled "annualized" when the account entered mid-way through a 1-year period

Status: fixed.

What was wrong: true TWR and Modified Dietz annualized over the request's range, so the Roth, valued from 10/13, showed "+3.95% / +3.95% annualized" in a 1-year view; the XIRR cell showed the annualized 57.88 % for the same reason.

What changed: the chain annualizes over the time the capital was invested (from the close the first computed sub-period starts at), so under 365 days `annualized` is null; the money-weighted cell shows the period figure when the money was invested for under a year; the TWR caption reads "not annualized (under a year of returns)". Phase 3 plan decision A19; the lots design's §3.9 step 4 is amended.

Tests:
- `packages/shared/src/conformance.audit.test.ts`, suite "b9-06: a return is annualized over the time the account was invested, not the request's range" (four tests, true TWR and Modified Dietz, the 365-day boundary).
- `apps/web/src/lib/performanceView.test.ts`: "b9-06: an account that entered 31 days before the end of a 1-year range shows its TWR not annualized", "b9-06: money invested for 31 days of a 1-year range shows the 31-day figure, not an annualized XIRR".
- Browser (`check-b9b.cjs` b9-06): the Roth's row reads "+3.95% not annualized (under a year of returns)" and "+3.95% over 31 days, not annualized (XIRR +57.88% would exaggerate a short period)"; the API's Roth TWR has `annualized: null`.

## b9-conformance-plan-investments-07 (low): the plan's month window only grew

Status: fixed.

What was wrong: ‹ Earlier and Later › added a month to the window and were disabled at 24 months; nothing showed fewer than six months or moved a full window.

What changed: ‹ Earlier and Later › move the window one month and keep its size, and a **Months shown** select picks 1 to 24 columns, keeping the current month in view at the same relative place; the window stays inside 2000-01 to 2199-12. Phase 2 plan decision A31.

Tests:
- `apps/web/src/lib/conformance.audit.test.ts`, suite "b9-07: the plan's month window moves and shrinks as well as grows" (five tests).
- Browser (`check-b9b.cjs` b9-07): 3 months gives Oct – Dec 2026, Earlier moves it to Sep – Nov, 24 months still moves (Sep 2024 – Aug 2026 after three Earlier), and a phone shows one month without sideways scrolling.

## b9-conformance-plan-investments-08 (low): "Prices are 1 trading days behind" on every statement-priced account when no price feed existed

Status: fixed.

What was wrong: with `PRICE_PROVIDER=none` a ticker made a security `provider`-mode, so a statement price was "behind" from the next trading day, the dashboard counted the securities as stale beside "Price feed not configured", and the sentence said "1 trading days".

What changed: the API passes whether a provider is configured to the views (Portfolio, Holdings, Allocation, valuation summary and series, the dashboard block, the price-history route). Without one, a `provider`-mode price older than the expected close reports its row's source (`implied`, or `manual`) instead of `stale`, a close on the expected date stays `current`, no `price_stale` warning is raised and the Prices page counts nothing as stale; values are unchanged. With a provider the warning says "1 trading day". The no-feed notes mention trade prices. Phase 3 plan decision A18 (and decision 10).

Tests:
- `packages/shared/src/conformance.audit.test.ts`, suite "b9-08: no price provider means no price is 'behind'" (three tests).
- `packages/db/src/services/conformance.audit.test.ts`, "b9-08: without a price provider no account is 'behind'; with one, one trading day is singular".
- `apps/web/src/components/dashboard/dashboard.test.ts`, the no-feed note.
- Browser (`check-b9b.cjs` b9-08): no "behind" or "stale" on Portfolio, Holdings, Allocation or the dashboard; the Prices status counts 0 stale.
