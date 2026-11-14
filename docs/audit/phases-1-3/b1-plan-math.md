# Audit record: Plan math (b1-plan-math)

Scope: the numbers of the spending plan for Phases 2 and 3: auto-planned recurring values and the nightly `plan.close_month`, rollover changes, goals on linked accounts, the drill-down behind a cell (plan scope), split transactions, and the averages.

## First round (commit 817fd5f)

The first round's findings text is not kept; this section is taken from the commit message of 817fd5f ("Audit fixes: plan math"). Its decisions are `docs/phase-2-plan.md` decisions 1, 2, 3, 7, 8, 13 and 14 and "Decisions made during the audit" A1 to A6.

- **p2-01: auto-planned recurring values follow the linked charges.** An occurrence is planned in the month its charge posted, so a paycheck or bill that posts in the neighbouring month no longer skews left to spend and pace; closed months keep only what was paid.
- **p2-13: the first occurrence is planned** through its linked charge instead of being cut off by `first_charge_date`.
- **p2-05: pause, cancel and resume leave the past alone.** Paused and cancelled items keep what was already paid; only active items are planned ahead, from the day they began to be expected; a resume never back-fills; `close_month` freezes completed months only and waits while an item still awaits an occurrence.
- **p2-06: confirmed recurring items plan in their own category in every bucket** (netted in the bucket's direction, a goal's contribution takes precedence); spending-category items are dated cash-flow events and leave their category's spread.
- **p2-04: a rollover change is never retroactive.** A mode or start-month change pins the months that already happened to the old mode (audited), and the engine honours pins before a chain start, so closed months and the current carried-in never move.
- **web-07: one active goal per linked account** (409 `account_linked`, shown in the goal form); each account-month of transfers goes to exactly one goal, also for older data and archived goals.
- **p2-12: drill-downs request plan scope** (on-budget accounts plus the feed), the same predicate as the cell's actual; the dashboard review link does too.
- **p2-09: split transactions count by their lines** in the register filter, drill-down and review count; `PUT /api/transactions/:id/splits` with a split editor on the register; a bank amount change drops a stale split.
- **live-14: averages divide by the months the on-budget ledger covers from the 1st**; no complete month gives zero, writes nothing and warns in the cash flow.

## Second round

An independent reviewer found one first-round item regressed (p2-12, for goals) and raised three new issues (one medium, two low). Each was reproduced at HEAD and is real; each is fixed. No new decision number: decisions 3, A1 and A6 of `docs/phase-2-plan.md` were amended, and migration `0012_frozen_charges` adds `month_plan.frozen_charge_ids`.

Every new test was run against the code before its fix and failed; the outputs are in the lane's scratch directory (`laneB/`): `b1r2-red-drilldown.txt` (the two db drill-down tests), `b1r2-red-closemonth.txt` (the four db close_month tests, run once the result carried its new `extended` count, so that the failures are the behaviour, not the result's shape) and `b1r2-red-migration.txt`.

### Second round, p2-12 (regression): the drill-down behind a goal on an off-budget account is empty

Status: fixed.

What was wrong: the first round made every drill-down request plan scope, goals included (`listPlanTransactions`, and `drillDownQuery` in the web app, whose link the Plan page opens). Plan scope was one whole-row test, `inPlanScope()` (on budget, or the row or a split line in the feed category), applied to the goal's rows as to any others, while the goal's cell counts the transfer legs in its linked account whatever that account's budget flag (`loadGoalNets`). Investment and retirement accounts start off budget, and transfers into them are the main kind of savings goal, so the list behind such a goal's cell was empty: a goal on an off-budget Roth IRA with a 500.00 transfer showed actual 500.00 in 1 transaction and a drill-down of 0 rows.

What changed: plan scope is no longer one row-level filter on top of the others. With `goalId`, the goal's filter applies it to its categorized rows only (by the per-line rule below) and keeps the transfer legs in the linked account for the months the goal owns it, whatever the account's budget flag, exactly as its cell counts them. The web query is unchanged (it still sends `planScope=true` for a goal, which now means what the goal's cell counts); the register's "As the plan counts it" chip says that a goal's transfers into its linked account are counted. Decision A6 says so.

Tests: db `src/services/transactions.test.ts` "plan scope of a goal on an off-budget account and of split lines" / "lists a goal's transfer legs in its off-budget linked account, as its cell counts them": the goal cell is 600.00 in 2 rows (the IRA leg and an on-budget contribution); `listPlanTransactions` and the register query (`goalId` + `planScope`) list exactly those two, not the Checking leg, an IRA fee categorized to the goal or the goal line of a split IRA row; without plan scope the goal's filter still lists the off-budget rows.

### Second round, new issue N1 (medium): close_month freezes a month with a pending linked charge that then posts in the next month

Status: fixed.

What was wrong: the matcher links pending rows (a pending charge is an occurrence paid, for the live plan), and `close_month` froze a completed month without looking at them. A water bill due on the 30th, pending on Jan 30 and linked on Feb 1, was frozen into January (90.00); when the bank posted it dated Feb 2 (the feed patches the row's date and pending flag in place) it planned in February too, so the two months planned three occurrences for two bills (January 90.00 frozen with nothing paid, February 180.00). Before the first round the nominal-month rule had no double count here.

What changed: `close_month` leaves a category's recurring value for a month live while a charge linked to one of its items (active, paused or cancelled: those that plan) and dated in that month is still pending, because its posted date may move it to the next month. The feed replaces or drops a pending row (pending rows of the account it no longer lists are deleted), so the wait ends; manual and CSV rows are never pending. Once it posts, the month freezes with it if it stayed in the month, and without it if it moved. Decisions 3 and A1 say so.

Tests: db `src/services/planRecurring.test.ts` "close_month and a pending charge at the end of the month": "leaves the month live while the charge is pending, and plans it in the month it posted" (the reviewer's case: nothing frozen on Feb 1; after the Feb 2 posting January plans 0 and February 180.00 with 90.00 paid) and "freezes the month with the charge once it posts on a date inside the month" (pending Feb 28, held on Mar 1, frozen at 180.00 on Mar 2 after it posts the same day).

### Second round, new issue N2 (low): an early payment of next month's occurrence that syncs after the freeze leaves the closed month overspent and the next month with nothing planned

Status: fixed.

What was wrong: the nightly close runs early on the 1st (after `DETECT_HOUR_UTC`, 08:00 UTC), before most of that day's charges sync. Its guard only waits for an occurrence due in or before the month, so January froze at one rent (1,500.00) on Feb 1 while the item awaited Feb 1; the February rent, paid early and dated Jan 30, synced on Feb 2 and was linked to the Feb 1 occurrence. January then planned 1,500.00 against 3,000.00 paid (overspent) and February planned 0, although A1 promises that a charge which syncs a day late is frozen with its month.

What changed: the frozen value now records the linked charges it counts, in `month_plan.frozen_charge_ids` (migration `0012_frozen_charges`, a nullable `uuid[]`), and each run of `close_month` adds to a value it froze from recurring items every posted charge dated in that month that no frozen value counts yet, at its item's expected amount in the category's direction (never below 0), and records it. So the late early payment (or a CSV import, or a link made later) joins the closed month, while the occurrences frozen earlier keep their price. The other suggested fix, delaying the freeze until an occurrence due early in the next month has arrived, was not taken: that charge is where a new price usually arrives (a rent increase on the 1st), so the closed month would then be frozen at the new price, the shift the freeze exists to prevent. Nothing is taken out (a charge counted once stays counted, whatever later happens to its item or date), no value counts a charge another frozen value counts, a pending charge waits until it posts (N1), and a value typed over a frozen one is the owner's: writing `planned_cents` by hand clears the column, and only rows with source `recurring` are extended. An update compares the stored ids first, so two runs at once add a charge once. `close_month` returns `extended` beside `inserted` (`POST /api/plan/close-month`'s `CloseMonthResponse` and the worker's outcome carry it). The migration gives rows frozen before it the charges their category's planning items hold in their month now; a charge that arrived after such a freeze is taken as counted, so those values stay as they were. Decisions 3 and A1 say so.

Tests: db `src/services/planRecurring.test.ts` "close_month and a charge dated in a closed month that syncs after the freeze": "adds an early payment of next month's occurrence to the frozen month at the price it arrived with" (the reviewer's case: frozen at 1,500.00 on Feb 1 with the Jan 2 rent recorded; on Feb 2 `extended: 1`, January 3,000.00 planned and paid, not overspent, February 0, a re-run adds nothing, and a later price change to 1,600.00 moves March only) and "never adds to a value typed over the frozen one, nor a charge another frozen row counts" (a typed Home value is cleared of its ids and not extended; once cleared and frozen again it counts both alarm charges; moving the rent item to Home adds nothing there). db `src/test/frozenChargesMigration.test.ts` "gives each row frozen from recurring items the charges its category's items hold in its month, and nothing to the others": the migrations up to 0011, frozen, typed and note-only rows written, then 0012 (a cancelled item's charge counted, a suggestion's not, a frozen month with no charge `{}`, typed and note-only rows null, values unchanged). The `close_month` result checks in db, api and worker tests gained `extended: 0`.

### Second round, new issue N3 (low): the plan-scope drill-down filters a split row as a whole, while the cell's actual applies plan scope per line

Status: fixed.

What was wrong: `inPlanScope()` admitted a row when it was on budget or when the row or any split line was in the feed category, and the category filter then admitted it for any of its lines; the cell's actual (`loadActuals`) applies `onBudgetOrFeedCategory` to each line's own category. On an off-budget Roth IRA, a +30.00 row split 20.00 feed / 10.00 Shopping left Shopping's cell at 0 in 0 rows while its drill-down listed the row, against A5 and A6.

What changed: with a category, plan scope requires that the row's line in that category be counted by the plan: on budget, or the requested category is the feed (`inCategoryInPlanScope`; every line in the category shares it, so the per-line rule is one test on the category). A goal's categorized rows use the same rule (p2-12 above). Plan scope with no category and no goal (the uncategorized list, or the register after the category filter is removed) keeps the whole-row rule: a row the plan counts anywhere. Decision A6 says so.

Tests: db `src/services/transactions.test.ts` "lists a split row under a line's category only when the plan counts that line": Shopping's cell is 0 in 0 rows and its plan-scope list (drill-down and register) is empty, the plain register filter still finds the row; the feed's cell is 45.00 in 2 lines and its list holds both split rows; plan scope without a category keeps the two split rows and the on-budget contribution.

### Checks

`pnpm typecheck`, `pnpm lint` and `pnpm build` pass. Suites (with `TEST_DATABASE_URL`, prefix `meridian_fix_b_`): shared 52 files and 1013 tests, db 53 and 401, worker 14 and 112, api 42 and 342, web 45 and 535, all passing (outputs `laneB/b1r2-suite-*.txt`). Browser check on the built app (`apps/api/dist/server.js` serving `apps/web/dist` on 127.0.0.1:3491, a fresh database, headless Chromium, `laneB/b1r2-ui-check.cjs`, output `b1r2-ui-check.txt`): with a goal linked to an off-budget Roth IRA and a 500.00 transfer into it, the goal's November cell showed $500.00 ("1 transaction"), clicking it opened the drill-down panel with the IRA leg ($500.00, transfer) (`b1r2-plan-goal-drill.png`); the register page it links to (`goalId`, `planScope=true`) listed that leg under the "As the plan counts it" chip with its new tooltip (`b1r2-register-goal.png`); Shopping's plan-scope list was empty while the plain category list showed the split IRA row ($10.00 of $30.00). No console errors.
