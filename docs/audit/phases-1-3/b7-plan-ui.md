# Audit record: spending plan, goals and dashboard in the web app (b7-plan-ui)

Scope: the Phase 2 Plan page (grid, cells, summary strip, cell menu, category manager, drag to recategorize), the Goals page and the Dashboard page, with the contract, service and view fields they read (`PlanResponse.startMonth`, `DashboardView.sync.attention[].syncPaused`).

Twelve findings were judged real and fixed; one (b7-plan-ui-06) belongs to Phase 4 and is deferred. The decisions are recorded in `docs/phase-2-plan.md`, "Decisions made during the audit", A18 to A26. The grid design (`docs/design/phase-2/grid-and-api.md`: Web, Plan, Dashboard, persistence and edge cases) points to them where its text changed.

Checks: `pnpm typecheck` and `pnpm lint` pass. The suites of every package touched pass with `TEST_DATABASE_URL` set: shared, db, api, web, and worker (which builds on the changed shared package). `pnpm build` passes. The built app (the API serving `apps/web/dist`) was checked in headless Chromium on ports 3491 (the grid-and-api seed moved one month later, today 2026-11-13, plus two connections that need attention) and 3492 (an empty database). The scripts and their output are in the lane's scratch directory, `laneB/b7`: `check-b7.cjs` (46 checks), `check-b7-fresh.cjs` (10 checks), `check-b7-narrow.cjs` (the layout at a 760 px window), `before-browser.txt` (the auditor's probes before and after the fix) and the screenshots `after-*.png`.

Every new test was run against the code before the fix and failed there (logs `before-planAudit.log`, `before-planAuditTsx.log` and `before-api-planUi.log` in the same directory).

## b7-plan-ui-01 (high): fill right copied the value from before the edit

Status: fixed.

What was wrong: Ctrl+Shift+→ in a planned input first committed the typed amount (a mutation whose optimistic patch lands after an awaited `cancelQueries`), then ran fill right, which read the source cell from the rows of the current render, still holding the old value. Typing 123 in Dining's empty December and pressing the shortcut sent two requests: December 12300, then January and February 0, each written as a manual override. Typing 1900 over Rent's automatic 1800 copied 1800 into every later month, hiding the recurring value.

What changed: the commit decision is the pure `resolveCellCommit(text, cell)` (keep, set, clear or invalid), and `cellEdits(row, months, col, commit, { fillRight })` builds the batch from the value being committed: the cell's own edit plus one edit per later visible month, sent as one request. With nothing typed it copies the shown (resolved) value, as the design says; emptying a typed cell and pressing the shortcut sends only the clear (the automatic value it falls back to is the server's). The cell menu's Fill right still copies the row's value, which is fresh by then (the menu waits for writes). `fillRightEdits` takes an explicit amount. Decision A18.

Tests:
- `apps/web/src/lib/planAudit.test.ts`, suite "b7-plan-ui-01: fill right copies the amount just typed":
  - "typing 123 in an empty automatic cell and filling right sends 123.00 for Dec, Jan and Feb in one batch"
  - "typing 1900 over Rent's automatic 1800 copies 1900, never the value from before the edit"
  - "without typing, fill right copies the displayed (resolved) value and leaves the cell itself alone"
  - "an emptied typed cell goes back to automatic and fills nothing (its automatic value is the server's)"
  - "the last visible month has nothing to fill: the typed value alone is sent"
- Browser (`check-b7.cjs`): one PUT with December to February at 12300, stored manual 12300 and shown 123.00; Rent 1900 over 1800 stores 190000 from November to February.

## b7-plan-ui-02 (medium): subtotal cells overflowed into the next month

Status: fixed.

What was wrong: bucket and group subtotal cells laid planned, actual and remaining out in one right-aligned row that did not wrap. Four-digit amounts need about 220 px in a 159 px column, so the planned amount was drawn in the previous month's column and the three values overlapped ("$5,$0000"). The strip's four committed totals had no labels, and their legend in the name column was cut off.

What changed: a subtotal is laid out like a category cell: the planned amount on its own line, then the actual and the remaining with its label ("left", "to come", "extra"), wrapping when the amounts are long; compact mode shows the remaining only. Rows are measured (b7-plan-ui-03), so a wrapped subtotal makes its row taller. Each strip cell names its committed totals on their own lines ("Income", "Bills", "Savings", "Spending"), and the name column's caption wraps. Decision A19.

Tests:
- `apps/web/src/components/plan/planAudit.test.tsx`, suite "b7-plan-ui-02: bucket and group subtotals and the strip are readable":
  - "a subtotal stacks planned over actual and remaining, and labels the remaining like a category cell"
  - "every strip total names its bucket inside the month cell"
- Browser (`check-b7.cjs`, `check-b7-narrow.cjs`): at four scroll positions every subtotal's planned, actual and remaining lie inside their cell and apart (54 cells each time, also at a 760 px window); every strip cell reads "Income $… Bills $… Savings $… Spending $…"; the caption is not clipped.

## b7-plan-ui-03 (medium): the "+$ in" and "incl. $ pending" notes were hidden behind the next row

Status: fixed.

What was wrong: category rows had a fixed 48 px height while the cell's actual, remaining and notes wrapped to a second line (67 px). Rows are absolutely positioned and opaque, so the next row covered every carried note and the pending note; the notes were readable only in the tooltip.

What changed: the virtualizer measures every row (`measureElement`); the old fixed heights are the minimum. The actual and the remaining share a wrapping line and the notes have their own line, so the row is as tall as its tallest cell. A compact toggle forgets the old sizes and measures the mounted rows again. The sticky bucket header is as tall as its measured row, and the keyboard's scroll padding follows it. Decision A19.

Tests:
- Browser (`check-b7.cjs`): at seven scroll positions each carried and pending note (+$100.00 in, +$55.00 in, +$555.00 in, +$123.00 in, +$246.00 in, incl. $25.00 pending) is the element on top at its own centre, and no cell content runs below its row; the same at a 760 px window (`check-b7-narrow.cjs`). The auditor's probe `p4.cjs` reported every note covered before the fix and every note on top after it (`before-browser.txt`).
- Layout cannot be computed without a browser engine; the rendered structure the CSS stacks is covered by the b7-plan-ui-02 and -11 render tests.

## b7-plan-ui-04 (medium): drag to recategorize could not be done in the app

Status: fixed.

What was wrong: the Plan page's category rows were drop targets, but nothing on the page could be dragged: clicking an actual navigated to the register, whose draggable rows have no drop target. There was no drill-down panel, and a drop (when one was forced) offered no "always do this" prompt.

What changed: clicking an actual, the cell menu's "Show transactions" or a month's uncategorized badge opens a drill-down panel under the grid (`DrillPanel`), which lists the cell's transactions with the register's plan-scope query (`drillDownQuery`, shared with the register link) and shrinks the grid so both stay in view. A row can be dragged onto any category row of the grid, or moved with its category select. A transfer leg or a split row is not movable (`canDragToRecategorize`; the register follows the same rule). A move sends the register's PATCH, refreshes the plan and the panel, says where the row went and offers the register's "always do this" prompt (`RulePrompt`, now shared by both pages) when the row has a payee. "Open in the register" keeps the page link. Decision A20.

Tests:
- `apps/web/src/lib/planAudit.test.ts`, suite "b7-plan-ui-04: the drill-down panel and drag to recategorize":
  - "asks the register for exactly the rows behind the cell, the same query the register link uses"
  - "drags categorized and uncategorized rows, never a transfer leg or a split row"
  - "offers the register's 'always do this' rule after a move, for a transaction with a payee"
- `apps/web/src/components/plan/planAudit.test.tsx`, suite "b7-plan-ui-04: the Plan page's drill-down panel lists draggable transactions":
  - "asks for the cell's rows, lets the owner drag or move the movable ones and links to the register"
  - "a viewer reads the same rows without drag or move"
- Browser (`check-b7.cjs`, a real HTML drag in Chromium): the November uncategorized badge opens the panel on /plan; AMAZON is the only draggable row; dropping it on Shopping sends `PATCH /api/transactions/:id {"categoryId": …}`, Shopping's November actual becomes 4500, the panel empties, the notice says "AMAZON moved to Shopping." and "Always do this" posts the payee rule; clicking Groceries' November actual lists its 3 transactions (its `txnCount`) without leaving the page.

## b7-plan-ui-05 (low): months before the plan start looked editable but refused every edit

Status: fixed.

What was wrong: on a fresh install the plan starts in the current month, so the default grid's two past months are before it. Their inputs accepted typing, and Enter answered `before_plan_start` at the top of the page while the typed value vanished. `PlanResponse` did not carry the start month, so the grid could not know.

What changed: `PlanResult` and `PlanResponse` carry `startMonth` (the household setting, also in the plan a cell write returns). A month before it shows its planned values in read-only inputs whose tooltip says "Before the plan start month (Nov 2026): change it in Settings"; the strip marks the month "before the plan start" with a link to Settings; the cell menu offers no Fill right, average or Clear there, and fill right never reaches such a month. The boot-time default (the first month with transactions, else the current month) is unchanged. Decision A21.

Tests:
- `apps/api/src/planUi.audit.test.ts`: "b7-05: GET /plan and the plan a cell write returns carry the plan start month, which moves with the setting".
- `apps/web/src/lib/planAudit.test.ts`: "b7-plan-ui-05: months before the plan start are read-only" > "compares months, with no start month meaning no limit".
- `apps/web/src/components/plan/planAudit.test.tsx`, suite "b7-plan-ui-05 and -10: cells that cannot be edited say so":
  - "a month before the plan start shows a read-only planned value and why"
  - "the strip marks the months before the plan start and links to Settings"
- Browser (`check-b7-fresh.cjs`, empty database): the plan starts in 2026-11; September and October are read-only and say why; the strip links both to Settings; typing in October sends nothing and shows no refusal; November takes an edit; after the start month moves to September, October is editable.

## b7-plan-ui-06 (low): no retirement card on the dashboard

Status: deferred to Phase 4.

The spec's card shows "retirement success rate from the latest saved run", and saved runs are the Phase 4 planner's. The Phase 4 design owns this card: `docs/design/phase-4/strategies-outputs-web.md` §5.8 defines `RetirementCard`, placed after the investments card, with every state including `retirement` null ("Plan your retirement" with a link to the profile for the owner, nothing for a viewer), and `inputs-and-data.md` §4.9 fills `DashboardView.retirement`. A placeholder now would link to a page that does not exist yet and would be replaced by that work. The grid design's `retirement: null // reserved for Phase 4` is the current contract. Recorded under "Deferred" in `docs/phase-2-plan.md`.

## b7-plan-ui-07 (low): the dashboard's date was frozen when the page mounted

Status: fixed.

What was wrong: `DashboardPage` kept `today` in a `useMemo` with no dependencies, so a page left open past midnight kept asking for yesterday (refetches on focus included), showed the old month's left to spend and pace across a month end, and was refused (400 `today_out_of_range`) once that date was more than two days off.

What changed: `useLocalToday()` holds the browser's local date and re-reads it one second after local midnight and whenever the page becomes visible or gains focus (a laptop that slept fires no timer on time). The Dashboard and Plan pages use it, so their query keys move to the new day and refetch. Decision A22.

Tests:
- `apps/web/src/lib/planAudit.test.ts`: "b7-plan-ui-07: the dashboard follows the local date" > "waits until just after the next local midnight".
- Browser (`check-b7-fresh.cjs`, Playwright clock, America/Denver): opened at 23:58 on Nov 13 the dashboard asks for 2026-11-13; five minutes later it has asked for 2026-11-14 and says "as of 11/14/26"; after the clock jumps to Nov 15 (no timers) a visibility change asks for 2026-11-15.

## b7-plan-ui-08 (low): a category's bucket could not be changed nor the category deleted

Status: fixed.

What was wrong: the category manager offered order, rename, group and hidden only. The API's `PATCH /categories/:id {bucket}` and `DELETE /categories/:id` had no caller, and category names are unique, so a category in the wrong bucket could not be recreated in the right one either.

What changed: each category in the manager has a bucket select (confirmed, because the category's past months move with it; for a goal's category only savings can be chosen, as the API requires) and a delete action. A category still referenced is refused with the server's 409 text, which names what uses it and says to hide it instead. Decision A23.

Tests:
- `apps/web/src/components/plan/planAudit.test.tsx`: "b7-plan-ui-08: a category's bucket can be changed and the category deleted" > "each category has a bucket select and a delete action; a goal's category can only stay in savings".
- The route rules are the existing API tests (`apps/api/src/categories.test.ts`).
- Browser (`check-b7.cjs`): a new category Gym moves to bills through the select (`PATCH {"bucket":"bills"}`); Emergency Fund's select offers savings only; deleting Groceries shows "Category is in use by 6 transaction(s); hide it instead"; deleting Gym removes it.

## b7-plan-ui-09 (low): a goal on a hidden category could not be edited

Status: fixed.

What was wrong: the goal form listed savings categories that were not hidden, also when editing, so a goal whose category had been hidden had an empty required select and its form could not be submitted.

What changed: `goalCategoryOptions` lists the visible savings categories without a goal plus the edited goal's own category whatever its state, labelled "(hidden)" when hidden. Decision A23.

Tests:
- `apps/web/src/lib/planAudit.test.ts`: "b7-plan-ui-09: a goal keeps its own category in the form, hidden or not" > "lists free visible savings categories, plus the edited goal's own category marked hidden".
- Browser (`check-b7.cjs`): with Emergency Fund hidden, the goal's form shows "Emergency Fund (hidden)" selected and saving a 600.00 contribution sends the PATCH.

## b7-plan-ui-10 (low): a viewer saw editing controls on the Plan and Goals pages

Status: fixed.

What was wrong: the Plan, Goals and category manager components did not ask for the role, so a viewer could type into planned cells, open the manager, flip zero-based and see New goal, Edit and Delete; every change then failed with 403.

What changed: the Plan page passes `readOnly` to the grid for a viewer: planned values are read-only inputs (the keyboard still walks the grid), the cell menu offers the transactions and shows the rollover setting only, rows are not drop targets, the drill-down panel has no drag or select and no rule prompt, the zero-based switch is disabled, the manager is not offered and the help line says the plan is read-only. The Goals page hides New goal, Edit and Delete. Decision A24.

Tests:
- `apps/web/src/components/plan/planAudit.test.tsx`, suite "b7-plan-ui-05 and -10: cells that cannot be edited say so":
  - "a viewer gets no category manager and no zero-based switch on the Plan page"
  - "a viewer sees the goals without New goal, Edit and Delete"
  - (the read-only cell itself: "a month before the plan start shows a read-only planned value and why", the same `lockedReason` path)
- `apps/web/src/components/plan/planAudit.test.tsx`: "a viewer reads the same rows without drag or move" (b7-plan-ui-04 suite).
- Browser (`check-b7.cjs`, a viewer created through `POST /api/users`): no editable planned input, no manager, zero-based disabled; typing, Enter and Ctrl+Shift+→ send nothing and show no 403, and Enter still moves focus; the cell menu has no Fill right, average or Clear; the drill-down has no draggable row or select; the Goals page shows goals without New goal, Edit or Delete.

## b7-plan-ui-11 (low): compact mode clipped the planned inputs and dropped the strip's totals

Status: fixed.

What was wrong: compact mode kept the planned input beside the remaining in a 120 px column, so 26 of 108 inputs were clipped (Rent's 1800.00 read as "18" beside its marker), and the strip left out its bucket totals.

What changed: a compact cell shows the remaining only (the spec's compact mode). The planned input lies over it, transparent, and appears with the whole value while it has focus (click, Enter, Tab or arrows), so typing and movement work as before; the source marker is left to the tooltip. The strip keeps its named bucket totals in compact mode; a narrow column shortens the bucket's name, never the amount. Decision A19.

Tests:
- `apps/web/src/components/plan/planAudit.test.tsx`, suite "b7-plan-ui-11: compact mode shows remaining, with planned on focus, and keeps the strip's totals":
  - "a compact category cell shows the remaining and keeps the planned input whole for keyboard entry, without the marker"
  - "the compact strip still shows the bucket totals"
- Browser (`check-b7.cjs`): in compact mode all six strip cells show the totals; a focused input shows "1900.00" unclipped at full opacity; the 65 other inputs are transparent; ArrowDown moves to the next row; no row content runs below its row.

## b7-plan-ui-12 (low): the sync card said "needs a new token" for a bank needing re-authentication

Status: fixed.

What was wrong: `auth_required` (the Bridge's `con.auth`) read "needs a new token" on the dashboard, while the remedy (SimpleFIN rules, the Connections page) is to re-authenticate the bank at the Bridge. A connection whose scheduled syncs were paused after a 403 or 402 read only "last sync failed".

What changed: `auth_required` reads "needs re-authentication at the Bridge". `DashboardView.sync.attention` rows carry `syncPaused` (the service lists a paused connection whatever its status), and the card adds "scheduled syncs paused" (`syncAttentionText`). Decision A25.

Tests:
- `apps/api/src/planUi.audit.test.ts`: "b7-12: a connection whose scheduled syncs are paused says so on the dashboard".
- `apps/web/src/components/plan/planAudit.test.tsx`: "b7-plan-ui-12: the dashboard's sync card gives the Bridge's remedy" > "con.auth reads as re-authentication at the Bridge, and a paused connection says scheduled syncs are paused".
- Browser (`check-b7.cjs`): Bank A "needs re-authentication at the Bridge", Bank B "last sync failed · scheduled syncs paused".

## b7-plan-ui-13 (low): an over-long planned amount came back as a wire-level validation error

Status: fixed.

What was wrong: `parseAmountInput` had no bound, so 99999999999999999999 passed the cell's check, was sent, and the page showed "edits/0/plannedCents: cents as a non-negative integer string of at most 15 digits" while the typed value vanished.

What changed: `parseAmountInput` refuses an amount above `MAX_PLANNED_CENTS` (999,999,999,999,999 cents, the 15-digit bound of every request) with "Too large"; leading zeros do not count. The grid shows it inline and sends nothing; the goal form says which field ("Target: Too large"). Decision A26.

Tests:
- `apps/web/src/lib/planAudit.test.ts`, suite "b7-plan-ui-13: an amount the API cannot take is refused in the cell":
  - "allows at most 13 whole-dollar digits (the 15-digit cents bound of the wire)"
  - "the goal form says which field is too large instead of sending it"
- Browser (`check-b7.cjs`): the 20-digit amount shows "Too large" in the cell, no request is sent and no page error appears.
