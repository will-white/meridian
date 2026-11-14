# Audit record: investment engines (b2-investment-engines)

Scope: the Phase 3 valuation chain's cash plug (`valueAccountOn`, `packages/shared/src/valuation.ts`), the timing of flows in true TWR and Modified Dietz (`packages/shared/src/performance.ts`), the price a positions row is stored with and the implied closes derived from it (`statementPrice` in `packages/shared/src/decimal.ts`, `packages/db/src/services/holdings.ts`), and the 0.001-share tolerance in the lot engine's disposals and the lot-pick validation (`packages/shared/src/lots.ts`, `packages/db/src/services/lots.ts`).

## First round (commit ff65eb8)

The first round's findings text is not kept; this section is taken from the commit message of ff65eb8 ("Audit fixes: investment engines"). Its decisions are `docs/phase-3-plan.md`, "Decisions made during the audit", A1 to A4; plan decisions 5, 8, 10 and 11 point to them.

- **p3-02: a balance below the positions is negative cash.** The valuation chain carries it as the "Cash (from balance)" line, with a `negative_residual` warning that says what to do, instead of dropping it, so a margin account keeps its debit on the snapshot, positions and lots bases, and the Portfolio, the Performance page, the reconcile preview and net worth agree; a balance older than the statement still plugs nothing. Margin cases were added to both gate tests; the Portfolio and Holdings pages word a negative inferred cash as subtracted (A1).
- **p3-05: withdrawals leave at the end of their day** in true TWR and Modified Dietz (contributions stay at the start), so an account emptied by an in-kind transfer, by a same-day sale and withdrawal, or by a rollover the day after a balance keeps its real return instead of −100 %, `negative_capital` or `zero_denominator`; sub-periods report the withdrawals separately (`outflowCents`) and the Performance detail shows In and Out columns (A2).
- **p3-04: a positions row is stored with the price its value implies unless the reported price produces that value** (`statementPrice`, used by the CSV mapper, the SimpleFIN holdings parser and the snapshot writer, so the positions editor and the reconcile commit obey it); a 0.00 or mis-mapped price column no longer becomes the security's implied close, and `rebuildImpliedPrices` never derives a close of 0 from a row with a value (A4).
- **p3-09: the 0.001-share tolerance applies to disposals**: a sale or transfer out within it of the whole position disposes of exactly the position (no oversell with an unmatched piece, no dust lot left open), a pick within it of its lot takes the lot, a transfer in accepts source lots within it of the row; a lot a reverse split would round to 0 keeps one unit and its basis until a disposal realizes it (A3).

## Second round

An independent reviewer confirmed the first round's whole-position, reverse-split and transfer-in parts of p3-09 (its shared lots tests and the db test "a 1:3 reverse split's rounding neither oversells nor strands a dust lot" fail before ff65eb8 and pass after it) and left one item open, the lot-pick part of p3-09, plus two new low issues. All three were reproduced and are real; all are fixed. Decisions: `docs/phase-3-plan.md`, A3 and A4 amended in place (marked "second round of the audit"); no new decision number.

Each new test was run against the code before its fix and failed there on an assertion or on the route's refusal. The outputs are in the lane's scratch directory (`laneA/`): `b2r2-red-shared.txt` (5 of 57 failing in `src/lots.test.ts`), `b2r2-red-db-lots.txt` (HEAD's engine and service: 1 of 9 failing, the route's 400 `pick_exceeds_lot`), `b2r2-red-db-lots-engine-only.txt` (the service fix with HEAD's engine: the same test fails on the 0.00026667-share piece taken from the second lot), `b2r2-red-db-holdings.txt` (1 of 6 failing); the runs after the fix are the matching `b2r2-green-*.txt`.

### Second round, p3-09 (incomplete): a pick within the tolerance of its lot

Status: fixed.

What was wrong: plan decision A3 says a pick within the tolerance of its lot takes the lot without `pick_exceeds_lot`; the first round only dropped the warning. All three of the reviewer's probes were reproduced on two 1-share lots split 1:3 (0.33333333 shares and 500 cents of basis each), lot method `specific`:

1. The route refused the pick. `validateLotPicks` allowed nothing above the lot's open quantity, so `createInvestmentTxn` for a sale of 0.3336 with a pick of 0.3336 on the first lot answered 400 `pick_exceeds_lot` ("Lot … has 0.33333333 shares open on 2025-09-02, not 0.3336"), and `PUT …/lot-picks` did the same. The engine's tolerance could never be reached through a pick written by the app.
2. A pick a hair below its lot left the dust. A sale of 0.3333 picking 0.3333 left the lot open with 0.00003333 shares and 0 basis (500 − round(500 × 0.3333 / 0.33333333) = 0).
3. A pick a hair above its lot spilled. A stored pick of 0.3338 (0.00046667 above the lot) took the lot without a warning, and the remaining 0.00046667 went FIFO onto the other, unpicked lot: a disposal with 1 cent of proceeds and 1 cent of basis, and that lot dropped to 0.33286666.

What changed:

- Engine (`dispose` in `packages/shared/src/lots.ts`): a pick within `POSITION_TOLERANCE` of its lot, on either side, takes exactly the lot and accounts for the shares it names (`pick.quantity`) of the sale. So a hair below leaves no dust and a hair above takes nothing of another lot. The FIFO remainder is the sale less what the picks named, and `pick_exceeds_sale` compares what a pick names with the part of the sale still unaccounted for. A pick beyond the tolerance behaves as before: capped at the lot with `pick_exceeds_lot` and the rest FIFO, or a partial pick that leaves its shares open.
- The whole-position rule is restated so that the picks cannot defeat it. For the picks, `remaining` starts at the larger of the sale and the position. After the picks, a whole-position row hands every open lot to FIFO. Without that, a sale of 1.0008 against 0.99999999 shares with a pick of 0.3338 would have oversold by 0.00033334, and two picks of 0.3333 would have left two dust pieces.
- Route (`validateLotPicks` in `packages/db/src/services/lots.ts`, used by `POST /api/investments/transactions` and `PUT /api/investments/txns/:id/lot-picks`): a pick may exceed its lot's open quantity as of the sale by up to 0.001 shares. A lot with nothing open as of the sale still takes no pick, however small. Without that guard the tolerance would have let a pick of up to 0.001 shares onto a closed lot. Σ picks ≤ the sale is unchanged.

The reviewer's "count the pick as satisfied" was taken literally: the pick accounts for the shares it names, not for the lot's own quantity. The broker's picked lot and ours differ by the split drift. Counting the pick keeps every other lot where the broker has it (the remainder is the sale less the picks, as the owner entered them), and the drift stays on the picked lot, which closes. Counting the lot instead would have moved that drift onto the FIFO lot.

Tests:

- shared `src/lots.test.ts`, "b2-investment-engines (second round), p3-09: a pick within 0.001 shares of its lot takes exactly the lot and counts as satisfied":
  - "a pick a hair above its lot takes the lot and nothing of the other lot". Sale 0.3338 at 20.00 (668 cents): one disposal of 0.33333333 with basis 500 and gain 168; the other lot is untouched at 0.33333333 and 500; no warning.
  - "a pick a hair below its lot takes the lot". Sale 0.3333 (667 cents): one disposal of 0.33333333 with basis 500 and gain 167; the lot is closed with 0 shares and 0 basis.
  - "is bounded by 0.001 shares on both sides of the lot". Exactly 0.001 above (0.33433333, 669 cents) and below (0.33233333, 665 cents) take the lot. A pick of 0.3345 (0.00116667 above) gives `pick_exceeds_lot` and 0.00116667 FIFO from the other lot, as before. A pick of 0.332 (0.00133333 below) leaves 0.00133333 shares with 2 cents of basis (500 − round(500 × 0.332 / 0.33333333) = 500 − 498).
  - "the FIFO remainder is the sale less the pick, whichever side of its lot the pick is". Sale 0.5 (1,000 cents). With a pick of 0.3338, FIFO takes 0.1662: proceeds 667 and 333 by largest remainder (667.29 and 332.71), basis round(500 × 0.1662 / 0.33333333) = 249, and the second lot keeps 0.16713333 and 251. With a pick of 0.3333, FIFO takes 0.1667: proceeds 667 and 333 (666.62 and 333.38), basis 250, and the second lot keeps 0.16663333 and 250.
  - "a whole-position sale with such picks takes every lot once". Sale 0.6666 with picks of 0.3333 on each lot: two pieces (667 and 666 cents) and no dust. Sale 0.666 whose stored picks name 0.33333333 each: both lots and no `pick_exceeds_sale`. Three lots (Σ 0.99999999) and a sale of 1.0008 with one pick of 0.3338: three pieces of 668, 667 and 667 cents, every lot closed.
  - The property test TC34 (500 seeded histories, picks included) still holds every invariant.
- db `src/services/lots.test.ts`, "b2-investment-engines (second round), p3-09: a pick within 0.001 shares of its lot is accepted on both routes and takes exactly the lot". `createInvestmentTxn` writes the sale of 0.3336 with its pick of 0.3336, and the rebuild gives one disposal (0.33333333, 667, 500, 167) and no warning. Cleared through `setLotPicks`, the sale is FIFO (`needs_lot_pick`) and reaches 0.00026667 into the second lot; picked again the same way, it is the first lot alone. The sale of 0.3333 picking 0.3333 closes the lot. A pick of 0.3345 on the second lot is still 400 `pick_exceeds_lot` ("has 0.33333333 shares open"), and so is a pick of 0.0005 on the lot the earlier sale closed.

### Second round, new issue 1 (low): the area designs still stated the rules A1 to A4 replaced

Status: fixed.

What was wrong: the batch amended only the plan. The plan wins by precedence, so this was not a conformance defect, but other remediation batches edited the area designs in place for their decisions. A reader of these designs still got the old rules and numbers: negative residual dropped, every flow at the start of its day, picks capped at the lot, price as reported.

What changed (each passage now points to its plan decision):

- `docs/design/phase-3/views-and-api.md`:
  - A1: D4; §3.4, including the `negative_residual` sentences and the worked example, re-derived; the `AccountWarnings` sentence; deviation 3; the Design B graft note.
  - Test 9(c), re-derived: R's 10-09 balance at 1,800,000 against 1,810,000 of positions on that date gives a `cash_plug` of −10,000 and the warning with the current message. `totalCents` and `classifiedCents` are both 4,515,200, the cash class is 160,200, and R is valued at 1,810,000 with `residualCents` −10,000, as `investmentViews.test.ts` asserts. Deleting R's `computed` rows, the old setup, now leaves no gap, because the plug is measured on the balance's own date.
  - A2: D12, the `getPerformance` seam and the note on changes forced by the sibling designs.
- `docs/design/phase-3/lots-and-performance.md`:
  - A2: D16; §3.9 boundaries and begin and end (a withdrawal's boundary is its own day, with the withdrawal added back to that close); §3.10 weights (a withdrawal's weight is `dayDiff(date, b₁) / D`); the TC16 worked example and §7 TC16, re-derived to 0.03846154 and a chain of 0.12989840 as `performance.test.ts` asserts; the Design A note.
  - A3: the split step (a lot never rounds to 0); `dispose` (the whole-position rule and the pick rule above); the `PUT …/lot-picks` validation; open question 8.
- `docs/design/phase-3/seams.md`: A3 in seam 5 and C5; A1 in seam 7.
- A4 in `docs/design/phase-3/imports-and-data.md` (the `holding_snapshot.price` column, the element rules' `value_mismatch`, §3.5) and in `docs/design/phase-3/prices-and-valuation.md` (the implied-price paragraph).

Tests: none (documents only). The re-derived numbers are the ones the suites already assert.

### Second round, new issue 2 (low): `rebuildImpliedPrices` healed only a price of 0

Status: fixed.

What was wrong: the rebuild replaced a stored price only when it was exactly 0. A 10-unit row stored before A4 with a mis-mapped price of 1.00 beside a value of 1,234.56 still wrote an implied close of 1.00, which values the fund at about 1/123 of its worth in every other account. Reproduced (`b2r2-red-db-holdings.txt`): the rebuild wrote nothing and the close stayed 1.00.

What changed: the rebuild derives each close as the row's `statementPrice(quantity, price, value)`, as the snapshot writer would store it today. The reported price stands when it produces the value within max(1 cent, 0.5 %); otherwise the close is value ÷ quantity, which covers the 0 case too. A row whose result is 0 beside a non-zero value is still skipped. The stored snapshot row keeps its price: the rebuild writes prices only, the row's value is what counts on its own date, and the next import of that statement stores `statementPrice`.

Tests: db `src/services/holdings.test.ts`, the A4 test extended:

- A legacy row at 1.00 beside 1,234.56, with the 1.00 close it once wrote, heals to 123.456 (`written 1`), and a second run writes nothing.
- A reported 123.45 (10 × 123.45 = 1,234.50, within the tolerance of 1,234.56) still stands as the close.
- The worthless position's 0 beside a value of 0 is still its close.

The tie test "rebuilds implied prices deterministically" had set M2's row to 4,725,001 cents beside 250 units at 37.81, only to make it win the largest-value tie. That is itself a price that does not produce its value, and the rebuild now gives it 189.00004. The row now grows consistently (1,250 units at 37.81 = 47,262.50) and the expectation is unchanged: 37.81 wins.

Checks: `pnpm typecheck` and `pnpm lint` pass. The suites of the packages touched pass (TEST_DATABASE_PREFIX `meridian_fix_a_`): shared 52 files and 1020 tests, db 53 files and 400 tests. api and worker, which use the changed services, also pass: api 42 files and 345 tests, worker 14 files and 116 tests. No app changed, so there was nothing to build or check in a browser.
