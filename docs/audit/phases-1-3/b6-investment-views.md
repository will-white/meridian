# Audit record: investment views (b6-investment-views)

Scope: the Phase 3 Portfolio, Allocation (rebalance), Holdings, Performance and Income views, their services (`investmentViews.ts`, `investmentIncome.ts`), routes, mappers and web pages, and the income feed into the plan.

All 16 findings were judged real and fixed; none was rejected or deferred. The decisions are recorded in `docs/phase-3-plan.md`, "Decisions made during the audit", A11 to A17. The views design (`docs/design/phase-3/views-and-api.md` D10, §3.7, §3.8, §3.11, §3.13, §5 and tests 8 and 13) and the prices design (§3.9) point to them where their text changed.

Checks: `pnpm typecheck` and `pnpm lint` pass. The suites of every package touched pass: shared, db, api and web, with `TEST_DATABASE_URL` set, and worker (which uses the changed services). `pnpm build` passes. The built app was checked in headless Chromium on ports 3491 and 3492 against seeded databases (recorded in the lane's scratch directory, `laneB/fix/browser`).

Every new test was run against the code before the fix and failed there.

## b6-investment-views-01 (high): unknown-basis shares counted as gain

Holdings counted the full value of unknown-basis shares as gain, marked the row "full" coverage and inflated the rebalance's taxable gain estimate.

Status: fixed.

What was wrong: `holdingCostBasis` took the lot engine's `costBasisCents`, which covers the known lots only (lots design §3.14). It then set the gain to the whole line's value less that basis, and `holdingsOf` counted any sub-row with a basis as fully covered. Ten VTI shares transferred in without a basis (312,500 cents) appeared as gain: +4,825.00 (+44.67 %) where the engine reports +1,700.00. The row carried no partial marker. The rebalance's taxable-sell estimate started from the same figure. Lots design D12 says such a gain is unknown.

What changed: a sub-row's covered value is now its value less `mulToCents(unknownBasisQuantity, price)`, with the unknown part capped at the line's quantity (`knownBasisValue`). Its gain is that covered value less the basis, which equals the engine's `unrealizedCents`. Such a sub-row makes the row `partial`, and the row sums covered figures only. A value-only line with unknown-basis shares cannot be split, so it counts as uncovered. The rebalance takes the known lots' gain. A sell of such a line says "(not counting N sh whose basis is unknown)". Decision A11.

Tests:
- `packages/db/src/services/investmentViews.audit.test.ts`, suite "audit b6: investment views":
  - "b6-01: shares that arrived without a basis are not gain; the row is partial and the rebalance estimate uses the known lots". By hand: covered value 1,562,500 − 312,500 = 1,250,000; gain 170,000; gainBp 1574; B's sell of 937,990 estimates 102,053, where it was 289,651.
  - "b6-01: the known-basis value of a line, and the sell note without unknown-basis shares".

## b6-investment-views-02 (medium): a reinvested dividend stays fed

A dividend fed into the plan stayed fed after its reinvest row was recorded.

Status: fixed.

What was wrong: `feedAccount` skipped a reinvested dividend only when it decided what to feed. A dividend fed in `create` mode before its reinvest row existed kept its synthetic Dividends row. The plan then counted 22.80 of October income that never arrived as cash.

What changed: the new `unfeedReinvestedDividends` deletes the account's unlocked synthetic rows of dividends that have a reinvest row for the same account, security and date. Every feed pass runs it first and counts it in `deleted`. The investment-transaction writers run it as soon as a reinvest row is written: create, update and the trade import. A deleted or re-dated reinvest row queues a feed pass, which feeds the dividend again. A linked bank row and a synthetic row with a locked category are left alone. An unlinked reinvested dividend now reads `not_fed`. Decision A12.

Tests:
- `packages/db/src/services/investmentIncome.audit.test.ts`, suite "audit b6: investment income":
  - "b6-02: a dividend fed into the plan leaves it when its reinvest row is recorded later, and comes back when that row goes". October plan income goes 2,280 → 0 → 2,280.
  - "b6-02: a feed pass removes a fed row whose reinvest arrived by another path (dividend first, reinvest later)".

## b6-investment-views-03 (medium): inferred cash dropped without a cash security

Without a cash security row, the Holdings table dropped all inferred cash. The weights and the weighted expense ratio were wrong, and the warning was developer text.

Status: fixed.

What was wrong: the lines without a security joined the cash security's row, and were skipped when none existed. That happens when a SimpleFIN brokerage lists positions but no cash line. The rows summed to 4,355,000 of 4,525,200, the expense ratio read 339 ppm instead of 326, and the only trace was "Inferred cash has no cash security row yet; it is counted in residualCents only".

What changed: these lines now form a Cash row of their own, with `securityId` null. The contract `HoldingRowView.securityId` is nullable for this row only. The row counts as a zero-ratio row in the expense ratio. The developer warning is gone. The web keys this row with `holdingRowKey` and never offers it a class editor. A read still creates no security. Decision A13.

Tests:
- `packages/db/src/services/investmentViews.audit.test.ts`: "b6-03: without a cash security the inferred cash is a Cash row of its own, so the rows sum to the total and the expense ratio counts it". Rows sum to 4,525,200; the Cash row is 170,200 (376 bp); the expense ratio is 326 ppm, 1,478 a year.
- `apps/api/src/investmentViews.audit.test.ts`: "b6-03: the Holdings route answers with the inferred-cash row when the household has no cash security". The response contract accepts the row.
- `packages/shared/src/api.investments.test.ts`: "HoldingsView carries an inferred-cash row without a cash security, and its inferred sub-rows (audit b6-03, b6-12)".
- `apps/web/src/lib/investments.test.ts`: "b6-16 and b6-03: no class editor on the cash row (with or without a cash security); a key for the inferred-cash row".

## b6-investment-views-04 (medium): Income "All" drops earlier dividends

Income "All" started at the first valuation date and dropped earlier dividends, so All showed less than YTD.

Status: fixed.

What was wrong: `getInvestmentIncome` bounded `all` by `firstDataDates`, the first valuation date. A Roth whose first statement is 2026-10-09 had dividends from 08-05. YTD showed 92.35 and All showed 0.00.

What changed: the new `firstIncomeDate` finds the first dividend or interest row, or the first ledger row in the feed category. The Income view's `all` starts the day before it when that is earlier than the first data date, because rows are read in `(from, to]`. `partial` compares with the earlier of the two dates. The value views keep the valuation start. Decision A14.

Tests:
- `packages/db/src/services/investmentIncome.audit.test.ts`: "b6-04: All covers every income row, even dividends dated before the account's first statement". All runs from 2026-08-04 and totals 9,235, equal to YTD. The household's All still starts at 2024-03-01.

## b6-investment-views-05 (medium): Portfolio "All" over ten years breaks

Over more than ten years, Portfolio "All" broke the value-over-time chart and the period "why?" panel, both with 400.

Status: fixed.

What was wrong: the page asked `/valuation/series` for the whole period, beyond `MAX_SERIES_DAYS` (3,660), and got a 400. The "why?" period window asked `/changes` for more than its five-year limit and got another 400. Only the stats card, from the Portfolio route's own capped series, had the right note.

What changed: `chartRange` caps the chart at `MAX_SERIES_DAYS`, the same start as the Portfolio's own note ("The value series starts 2016-11-04"). The chart note then says "at most ten years are charted". A period window longer than five years is the period's last five years, by the route's own rule including month-end clamping. The `ChangePanel` shows a note saying so. Decision A16.

Tests:
- `apps/web/src/lib/investments.test.ts`:
  - "b6-05: the chart range never asks the series route for more than MAX_SERIES_DAYS".
  - "b6-05: a period longer than five years is explained over its last five years, with a note".
  - "picks the series step from the range and the chart range from the period": updated for `capped`.
- Browser: `/investments?period=all` with a 2014 first buy draws the chart from 11/04/16 and opens the period "why?" without an error.

## b6-investment-views-06 (low): includeClosed fails or is ignored

`includeClosed` failed on the Portfolio route (400) and was ignored on the Performance route.

Status: fixed.

What was wrong: `getPortfolio` called `valuationSeries` without `includeClosed`, so a closed account gave 400 "… is closed". The GET Performance route never passed `q.includeClosed` to `investmentAccountIds` or `getPerformance`.

What changed: `valuationSeries` takes `includeClosed`, and `getPortfolio` passes it. `GetPerformanceQuery` takes `includeClosed`, and the GET route passes it through both calls. A closed account named in `accountIds` still needs `includeClosed`, per views design D21.

Tests:
- `packages/db/src/services/investmentViews.audit.test.ts`: "b6-06: includeClosed=true values a closed account on the Portfolio, its series included".
- `apps/api/src/investmentViews.audit.test.ts`: "b6-06: includeClosed=true lists a closed account on the Portfolio (no 400) and on the Performance page".

## b6-investment-views-07 (low): negative cash inflates the expense ratio

Negative inferred cash made the weighted expense ratio exceed every holding's ratio.

Status: fixed.

What was wrong: `ppmWeighted` divided by the net total. Take one fund at 0.03 % with a 500,000 margin debit: the page showed 0.05 % (500 ppm), and VTI was "166.7 % of your portfolio".

What changed: the expense ratio and the concentration weights use the rows of positive value. A negative cash row is left out of both sums, and concentration is a row's share of their gross value. The table's weights still sum to 100 % of the net total (D4). The page's caption reads "of the holdings shown". Decision A17.

Tests:
- `packages/db/src/services/investmentViews.audit.test.ts`: "b6-07: negative cash (a margin debit) is left out of the expense ratio and the concentration base". By hand: 300 ppm, 375 a year; VTI at 10,000 bp gross with an `info` note naming the account; weights 16666 and −6666.

## b6-investment-views-08 (low): a carried prior close shown as one day

A day change measured against an older carried close was shown as "since <previous trading day>" with no label.

Status: fixed.

What was wrong: with statement-implied prices only (no provider, the default), the prior trading day has no close, so the 09-09 statement's implied price was carried. The Portfolio showed a month's move as "+$330.00 (+1.85%) since 10/08/26". The prices design's own example asks the view to label this prior. No field on the wire said so.

What changed: shared `dayChange` returns `carriedPrior`. It holds the oldest prior close older than `prior` among the included lines that moved from it to a newer close, with the carried closes' sources. A stale line priced with the same row on both days does not count. `PortfolioDayChangeView` carries it, and `dayChangeSentence` now reads "+$330.00 (+1.85%) since 09/09/26 (implied prices; no close on 10/08/26)". Decision A16.

Tests:
- `packages/shared/src/valuation.test.ts`: "says when the prior close is carried from an older date (audit b6-08: the view labels the prior)". This covers:
  - the design's 10-09 example, carried from the 09-30 implied rows;
  - S2's VFIAX, carried from a 10-09 feed close;
  - a stale line priced with the same row on both days, which moved nothing and is not a carried move.
- Hand numbers updated: `apps/api/src/investmentViews.test.ts`, "GET /investments/portfolio (views test 2): …", and `apps/api/src/valuation.test.ts`, "values the household on 10-13 by the chain with day and 1y period change, zero writes, identical for a viewer". On the seed `carriedPrior` is null: TR2050's only close is used on both days.
- `packages/shared/src/api.investments.test.ts`: the `PortfolioView` and `ValuationSummaryResponse` round-trips carry `carriedPrior`.
- `apps/web/src/lib/investments.test.ts`: "b6-08: a day change measured from a carried close names the close it is measured from".

## b6-investment-views-09 (low): the Day window explains a different change

The Portfolio row's "why?" Day window explained a different change than the day change shown.

Status: fixed.

What was wrong: `changeWindows` ended the day window at the page's as-of date. With prices through 10-13 and the page as of 11-12, the "Day" window covered a month, including a buy.

What changed: the day window now runs from `dayChange.prior` to `dayChange.asOf`, the close the day change was measured at. While the latest close lags the page's as-of date, its note says that the day change prices the as-of date's holdings at those closes. Decision A16.

Tests:
- `apps/web/src/lib/investments.test.ts`:
  - "b6-09: the day window ends at the close the day change was measured at, and says so while prices lag the as-of date".
  - "offers the day and the period windows only when each is a real span": updated.

## b6-investment-views-10 (low): raw engine warning codes

The Performance page showed raw engine warning codes instead of readable text.

Status: fixed.

What was wrong: `engineWarningText` returned `${code}: ${detail ?? date}` for every warning that is not a failure reason, for example "valuation_carried: 2025-11-12".

What changed: the new shared `engineWarningSentence` words every `EngineWarningCode` with the security's ticker or name and the date. The failure reasons read as `returnReasonText` does. `engineWarningText` uses it, so a trade import's rebuild warnings read the same way. `readableOf` passes the record's security names. Decision A15.

Tests:
- `packages/shared/src/investments.test.ts`, "engineWarningSentence (audit b6-10: readable engine warnings)":
  - "reads every warning code as a sentence, never as the code".
  - "names the security and the date".
- `apps/api/src/investmentViews.audit.test.ts`: "b6-10: the Performance page's warnings read as sentences, never as engine codes". A custom period from 2025-11-12 gives "No value is recorded on 2025-11-12; the latest earlier statement or balance was carried to it."

## b6-investment-views-11 (low): the Income account filter disappears

The Income page's account filter disappeared once an account was chosen.

Status: fixed.

What was wrong: the filter's options came from the filtered response's `feed.accounts`. That response lists only the chosen account, so the filter hid itself.

What changed: the options come from `GET /accounts`, as on Holdings, through the shared `investmentAccountOptions`. Holdings uses the same helper. `showAccountFilter` keeps the control while an account is chosen.

Tests:
- `apps/web/src/lib/investments.test.ts`: "b6-11: the account filter lists the household's investment accounts, and stays while one is chosen".
- Browser: after choosing Fidelity Roth IRA the filter is still there, and "All accounts" restores both.

## b6-investment-views-12 (low): Holdings labels trade cash wrongly

Holdings labelled a lots-basis account's trade cash as "reported" and "from balance". The Cash row showed 270 shares for $1,702.

Status: fixed.

What was wrong: the sub-row label used only the line's kind. The lots basis' "Cash (from trades)" has kind `cash` but no security, so it was called "reported". The stat called all inferred cash "from balance". The row's quantity summed only the reported line.

What changed: `HoldingAccountView` gains `lineName` and `inferred`. `holdingLineLabel` reads:
- "reported" for a reported cash position;
- "unlisted (balance − positions)" for the plug;
- "from trades (since the last balance)" for trade cash;
- "transfers since the last balance" for carried flows.

The Cash stat shows the cash row's total with "$270.00 reported · + $1,432.00 inferred (not in the positions list)" (`cashStatText`). The cash row's quantity is its whole value at 1.00 a unit, 1,702 on the seed. Decision A13.

Tests:
- `packages/db/src/services/investmentViews.audit.test.ts`: "b6-12: the Cash row's quantity is its whole value; each sub-row says whether it is reported or inferred, and trade cash is named". This covers the seed and a post-statement buy on the lots basis: −13,050 inferred, "Cash (from trades)" −156,250.
- `apps/web/src/lib/investments.test.ts`: "b6-12: sub-row labels tell reported cash from inferred cash, and the Cash stat says which is which".
- Hand numbers updated:
  - `packages/db/src/services/investmentViews.test.ts`, "holdings rows, coverage, the weighted expense ratio and concentration (test 8)". The cash row's quantity is 1702, and 1432 for B alone.
  - `apps/api/src/performance.test.ts`, "to 06-30: the end value, the holdings, the lots and the gains all describe the ten shares held that day" and "to 10-13: six shares, the cash from the sale and the realized gain". The cash row's quantity is "0" and "600".

## b6-investment-views-13 (low): the gain note printed twice

The rebalance table printed the taxable-sell gain note twice.

Status: fixed.

What was wrong: `RebalanceTable` printed its own estimated-gain sentence and then the server's note, which is the same sentence (views design §3.7).

What changed: the cell prints the server's note once, toned as a warning when a gain may be realized (`tradeNote`).

Tests:
- `apps/web/src/lib/investments.test.ts`: "b6-13: a taxable sell's note is the server's sentence once, toned when a gain may be realized".
- Browser: the 30/30/30/10 targets show one estimated-gain line on the Vanguard Brokerage sell.

## b6-investment-views-14 (low): filtered warnings say "of your portfolio"

Concentration warnings in an account-filtered Holdings view said "of your portfolio".

Status: fixed.

What was wrong: with `accountId` the weights are relative to the account, but the message still said "of your portfolio": AAPL showed as 22.2 % of the portfolio, where it is 13.3 % of the household.

What changed: with `accountId` the message names the account, "AAPL is 22.2% of Vanguard Brokerage (individual stock; flagged above 10%)". Without it the message still says "your portfolio". Decision A17.

Tests:
- `packages/db/src/services/investmentViews.audit.test.ts`: "b6-14: concentration in an account-filtered view names the account the weight is relative to".

## b6-investment-views-15 (low): months without income are left out

Income by month omitted months without income.

Status: fixed.

What was wrong: months were created only for months with rows. The YTD chart and table listed March, June, August, September and October as if they were consecutive.

What changed: every month of the period is listed, and months without income appear as zeros. The page already styles empty months. Decision A14.

Tests:
- `packages/db/src/services/investmentIncome.audit.test.ts`: "b6-15: every month of the period is listed, months without income as zeros". This covers YTD January to October, and a 1-month window touching September and October.
- Hand numbers updated:
  - `packages/db/src/services/investmentIncome.test.ts`, "the ytd income view and the feed in link mode (test 13)" and "create mode, the upgrade pass, idempotency, turning it off, validation (test 14)".
  - `apps/api/src/investmentViews.test.ts`, "GET /investments/income (views test 13): the ytd months, totals, trailing twelve months, yield, rows and the feed block".
  - `apps/api/src/investmentsGate.test.ts`, "a week later: a dividend on the cash row is explained, recorded, and counted once the trade history is in; only then is the statement accepted". The 1-month window lists September at zero.

## b6-investment-views-16 (low): a class editor on the Cash row

Holdings offered a class editor on the Cash row, and its Save always failed.

Status: fixed.

What was wrong: the class action was offered on every row. The cash security is always class cash and never split (views design §2.1), so its Save always failed with `cash_security_reserved`.

What changed: `canEditSecurityClass` hides the action for cash rows, including the inferred-cash row of b6-03, and for viewers.

Tests:
- `apps/web/src/lib/investments.test.ts`: "b6-16 and b6-03: no class editor on the cash row (with or without a cash security); a key for the inferred-cash row".
- Browser: the Cash (USD) row has no "class" button, and VTI still has one.
