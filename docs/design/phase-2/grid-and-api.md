## summary

Final merged spec for the Phase 2 grid, plan API and dashboard. Shape and persistence follow Design B (flat display-ordered rows, nothing cached, one batch write endpoint, averages as a read-only query, revert via the normal edit path); correctness rules follow Design A where B was looser (audit batch id per request, client `today` with a server sanity bound, explicit recurring status matrix, pace floored to non-negative, 12-month net-worth change by calendar month with new accounts named, category delete with 409 when referenced). Decisions: (1) rollover mode + rollover_start_month live on category (lead decision; spec table deviation flagged). (2) carried-in is never stored: it is recomputed on every GET /plan from each category's rollover start month; no write-back from GET (a viewer's GET must not write; read replicas stay possible), no job. (3) month_plan holds only user-set values (manual|average); absence of a row = auto value (recurring for bills/income, goal contribution for savings, else 0); clearing = deleting the row. (4) Left to spend uses one committed formula for every bucket: committed = max(planned + carriedIn, actual) - max(carriedIn, 0); it equals A's rule under none/surplus_only and is chosen over A's under surplus_and_overspend because the month's LTS then matches cash. (5) To assign = Σ income committed - Σ planned(bills+savings+spending): same inputs, different summary. (6) Flaw accepted from A: a goal's actual counts NET transfers in its linked account (inflows minus outflows), not inflows only, because a round trip would otherwise show progress; stated explicitly as a change to the lead decision. (7) Uncategorized transactions sit in no bucket and do not change LTS; they are surfaced as a per-month {count, cents} in the summary strip and in the dashboard review counts (A's synthetic "other" rows rejected for complexity; bucket_override is not read by the Phase 2 grid, flagged). (8) Integer math: bigint division truncates toward zero everywhere (pace, averages, monthly equivalents); averages divide by months-with-data, clamp at 0. (9) today comes from the client (PWA local date), validated within 2 days of the server clock; the API clock is injectable for tests. (10) audit_log has batch_id, text entity_id (`${month}:${categoryId}` for cells), actions create|update|delete; written by every plan/category/group/goal/recurring/rule service; alert dismissals and transaction edits are not audited. All money bigint cents, wire format decimal strings, months YYYY-MM, dates YYYY-MM-DD. 18 test cases on one seed with every number re-derived by hand.

## dataModel

All new tables in packages/db/src/schema/plan.ts (exported from schema/index.ts); migration 0001_phase2_plan.sql via pnpm db:generate. Months are text 'YYYY-MM' with a CHECK regex (one representation end to end, sorts lexicographically, enumerated in TS); money bigint cents.

category_group (spec)
- id uuid pk default gen_random_uuid(); name text not null; bucket text not null enum BUCKETS; position integer not null default 0; created_at timestamptz default now()
- unique (bucket, name); index (bucket, position)
- A group belongs to one bucket; a category may only sit in a group of its own bucket (service check, 400).

category (additions to Phase 1)
- group_id uuid null references category_group(id) on delete set null  (ungrouped categories render after the bucket's groups; no default-group backfill needed)
- position integer not null default 0
- rollover_mode text not null default 'none' enum ROLLOVER_MODES = none | surplus_only | surplus_and_overspend
- rollover_start_month text null CHECK (~ '^\d{4}-(0[1-9]|1[0-2])$')
- CHECK (rollover_mode = 'none' OR rollover_start_month IS NOT NULL); CHECK (bucket <> 'income' OR rollover_mode = 'none')
- index (group_id, position); index (bucket, position)
- Why on category (not month_plan as the spec table says): lead decision "rollover modes per category"; a per-month mode leaves "which month's mode governs the carry m→m+1" undefined. rollover_start_month (addition): the chain starts there so enabling rollover mid-history does not drag years of unplanned overspend into today. FLAGGED deviation.

month_plan (spec: month, category, planned amount; rollover mode and carried-in amount deliberately absent)
- id uuid pk; month text not null (CHECK regex); category_id uuid not null references category(id) on delete cascade
- planned_cents bigint not null CHECK (>= 0)  — a magnitude in the bucket's direction
- source text not null default 'manual' enum ('manual' | 'average') — how the STORED value came to be
- updated_at timestamptz not null default now()
- unique (category_id, month); index (month)
- A row exists only when the user set a value. No row => virtual planned: recurring auto-fill (bills/income), goal contribution (savings), else 0 (source none). Revert to auto = delete the row. A stored 0 is a real override ("manual $0").
- DEVIATION (flagged): no carried_in_cents column. It is a pure function of (planned, actual, mode, start month) and goes stale on every transaction change; computing it costs one GROUP BY plus O(categories x months). No write from GET: viewers (read-only role) call GET, and a read replica stays possible. If the lead insists, add `carried_in_cents bigint null` as a cache written only by the mutation paths; zero contract impact.

savings_goal (spec: name, target, target date, linked account, monthly contribution)
- id uuid pk; name text not null
- category_id uuid not null unique references category(id) on delete cascade — must be a savings-bucket category (400); one goal per category; goal rows in the grid ARE the category rows, decorated
- target_cents bigint not null CHECK (> 0); target_date date null
- linked_account_id uuid null references account(id) on delete set null
- monthly_contribution_cents bigint not null default 0 CHECK (>= 0) — auto-fills the category's planned cell (source 'goal') from start_month
- start_month text not null (CHECK regex) — addition: progress and auto-fill begin here (default: month created), so an old savings account's history does not count toward a new goal
- starting_cents bigint not null default 0 CHECK (>= 0) — addition: amount already saved when the goal was created
- created_at, updated_at timestamptz; index (linked_account_id)

recurring (owned by the recurring area; columns THIS area depends on): id, payee_id, name, category_id null, account_id null, cadence enum (weekly|biweekly|twice_monthly|monthly|quarterly|semiannual|yearly), expected_cents bigint signed (outflow negative), tolerance_cents bigint >= 0, next_due_date date, first_seen_date date not null (earliest matched transaction for detected items; = next_due_date by default for manual), last_date date null, last_amount_cents bigint null, source enum (detected|manual), status enum (suggested|active|paused|cancelled|dismissed), created_at, updated_at. REFINEMENT to the lead's status list: 'dismissed' keeps the row so detection never re-proposes that payee. Partial index (next_due_date) where status = 'active'; index (status).

alert (lead decision: persisted so it can be dismissed)
- id uuid pk; kind text not null enum (price_increase | new_subscription | missed_charge | trial_converted)
- recurring_id uuid null references recurring(id) on delete cascade; transaction_id uuid null references transaction(id) on delete set null
- dedupe_key text not null (triggering transaction id, or the expected date for missed_charge)
- detail jsonb not null default '{}' (previousCents, currentCents, expectedDate as strings)
- created_at timestamptz default now(); dismissed_at timestamptz null
- unique (kind, recurring_id, dedupe_key) so a nightly rerun inserts ON CONFLICT DO NOTHING and a dismissed alert stays dismissed; partial index (created_at) where dismissed_at is null

audit_log (spec Security: plan, rule and scenario edits keep history)
- id uuid pk; at timestamptz default now(); user_id uuid null references "user"(id) on delete set null
- batch_id uuid not null — one per HTTP request, so a fill-right's N rows or a reorder form one reviewable batch
- entity text not null enum (month_plan | category | category_group | savings_goal | recurring | rule) (scenario joins in Phase 4)
- entity_id text not null — row id, or for month_plan the cell key `${month}:${categoryId}` (stable across delete/recreate)
- action text not null enum (create | update | delete)
- before jsonb null; after jsonb null (the API view of the row, cents as strings)
- index (entity, entity_id, at desc); index (batch_id); index (at desc)
- Writers: setPlanCells (month_plan), category create/update/delete/reorder, category_group CRUD/reorder, savings_goal CRUD, recurring create/update/delete (confirm/pause/cancel/dismiss are updates), rule create/update/delete/reorder (retrofit, one writeAudit call each). Never written when before deep-equals after. Not audited: alert dismissal, transaction edits (ledger, not plan).

job.type enum: + 'recurring.detect' (worker; enqueued with dedupe after every successful sync in apps/worker/src/jobs/sync.ts after applyAccountSet, and nightly at 03:00 by scheduler.ts). No job for carried-in or the dashboard.

transaction: no schema change. bucket_override is NOT read by the Phase 2 grid (a transaction's bucket is its category's bucket); flagged. Optional later index (category_id, date) once history is long; existing transaction_category_idx + transaction_date_idx suffice now.

## algorithm

## Conventions
- transaction.amount_cents: + in, - out. bucketSign(income) = +1; bucketSign(bills|savings|spending) = -1.
- actual(c, m) = bucketSign(c.bucket) x Σ amount_cents over non-transfer transactions with category c and date in m, pending included; when split rows exist they replace the parent (coalesce(split.category_id, t.category_id), coalesce(split.amount_cents, t.amount_cents)). Refunds reduce actual; a month can go negative.
- goalNet(c, m) for a savings category whose goal has linked_account_id A: Σ amount_cents of transactions in A with is_transfer = true in m (NET: inflows minus outflows; change to the lead decision, see resolutions). Added to actual(c, m). The two terms partition on is_transfer, so nothing counts twice.
- pendingCents(c, m) = bucketSign x Σ amount of the same rows where pending = true (reported, already inside actual).
- planned(c, m): month_plan row -> (row.planned_cents, row.source). Else bills/income: Σ over active recurring r with r.category_id = c of |r.expected_cents| x occurrencesInMonth(r, m), source 'recurring' when > 0. Else savings with a goal and m >= goal.start_month: goal.monthly_contribution_cents, source 'goal' (when > 0). Else (0, 'none').
- occurrencesInMonth(r, m): contract on packages/shared/src/recurring.ts (recurring area): due dates stepped from next_due_date forward without bound and backward down to first_seen_date (monthly/quarterly/semiannual/yearly via addMonthsClamped; weekly ±7d; biweekly ±14d; twice_monthly day pairs). Paused/cancelled/suggested/dismissed items contribute nothing.
- Months: SQL filters use date >= 'YYYY-MM-01' AND date < first day of the next month (never '-31').

## Pure engine, packages/shared/src/plan.ts (isomorphic, no DB)
```ts
export type Month = string;                       // YYYY-MM
export type RolloverMode = 'none' | 'surplus_only' | 'surplus_and_overspend';
export type PlanSource = 'manual' | 'average' | 'recurring' | 'goal' | 'none';
// dates.ts additions
export function monthOf(date: IsoDate): Month;                // slice(0,7)
export function addMonths(m: Month, n: number): Month;
export function monthRange(from: Month, to: Month): Month[];  // inclusive
export function monthDiff(a: Month, b: Month): number;        // b - a in months
export function daysInMonth(m: Month): number;                // new Date(Date.UTC(y, mo, 0)).getUTCDate(); 2028-02 -> 29
export function monthStart(m: Month): IsoDate;                // `${m}-01`
export function monthEnd(m: Month): IsoDate;                  // last day
export function addMonthsClamped(date: IsoDate, n: number): IsoDate; // same day n months away, clamped to month end
// money.ts additions — ONE integer rule: bigint `/` truncates toward zero (= floor for non-negative operands)
export function divTrunc(n: bigint, d: bigint): bigint;       // n / d
export function ceilDiv(n: bigint, d: bigint): bigint;        // n >= 0, d > 0: (n + d - 1n) / d
export function carryOut(mode: RolloverMode, remaining: bigint): bigint; // none -> 0n; surplus_only -> max(0n, r); surplus_and_overspend -> r
/** What a row commits against this month's income for left to spend (same formula for every bucket). */
export function committedCents(planned: bigint, carriedIn: bigint, actual: bigint): bigint;
//   = max(planned + carriedIn, actual) - max(carriedIn, 0n)
export function paceCents(leftToSpend: bigint, today: IsoDate): { daysLeft: number; perDayCents: bigint; overCents: bigint };
//   daysLeft = daysInMonth(monthOf(today)) - dayOfMonth(today) + 1 (today counts, >= 1 by construction)
//   perDayCents = leftToSpend >= 0n ? leftToSpend / BigInt(daysLeft) : 0n  (floor: never promises more than exists)
//   overCents = leftToSpend < 0n ? -leftToSpend : 0n
export function annualize(expectedCents: bigint, cadence: Cadence): { yearlyCents: bigint; monthlyEquivalentCents: bigint };
//   perYear = { weekly: 52, biweekly: 26, twice_monthly: 24, monthly: 12, quarterly: 4, semiannual: 2, yearly: 1 }
//   yearlyCents = |expected| x perYear; monthlyEquivalentCents = yearlyCents / 12n (truncate)
export interface PlanInput {
  today: IsoDate; from: Month; to: Month;
  groups: { id; name; bucket; position }[];
  categories: { id; name; bucket; groupId: string|null; position; hidden; rolloverMode; rolloverStartMonth: Month|null }[];
  planRows: { categoryId; month; plannedCents: bigint; source: 'manual'|'average' }[];
  actuals: Map<string, { cents: bigint; pending: bigint; count: number }>;  // key `${categoryId}|${month}`, signed Σ amount (splits applied)
  goalNet: Map<string, { cents: bigint; count: number }>;                   // key `${categoryId}|${month}`, net transfer legs in the linked account
  recurring: { id; categoryId; cadence; nextDueDate; firstSeenDate; expectedCents: bigint }[];  // status active only
  goals: { id; categoryId; name; targetCents; targetDate; linkedAccountId; linkedAccountName; monthlyContributionCents; startMonth; startingCents; createdAt }[];
  uncategorized: Map<Month, { count: number; cents: bigint }>;   // category null, not transfer
}
export function computePlan(input: PlanInput): PlanResult;   // bigint twin of PlanResponse; the route maps to strings
export function goalProgress(goal, actualByMonth: Map<Month, bigint>, currentMonth: Month): GoalProgress;
export function autoPlanned(category, month, recurring, goal): { planned: bigint; source: PlanSource };
```
computePlan:
1. months = monthRange(from, to); currentMonth = monthOf(today).
2. Row order: for bucket in [income, bills, savings, spending]: one bucket row; then the bucket's groups by (position, name), each followed by its categories by (position, name); then ungrouped categories by (position, name). Hidden categories are included with hidden = true (their numbers stay in group/bucket subtotals and LTS).
3. Per category: chainStart = rolloverMode === 'none' ? from : min(rolloverStartMonth, from). carry = 0n. For m in monthRange(chainStart, max(to, currentMonth)): (planned, source) = planRows or autoPlanned; carriedIn = (rolloverMode === 'none' || m <= rolloverStartMonth) ? 0n : carry; actual = bucketSign x actuals + goalNet; remaining = planned + carriedIn - actual; carry = (rolloverMode !== 'none' && m >= rolloverStartMonth) ? carryOut(mode, remaining) : 0n. Emit cells for m in [from, to] with { planned, carriedIn, actual, pending, remaining, source, txnCount, overspent: remaining < 0n }. Chain bounded by 240 months.
4. Group and bucket rows: cells are sums of their member categories' planned/carriedIn/actual/pending/remaining; source 'none'; txnCount summed.
5. MonthSummary per month: committed[bucket] = Σ committedCents(planned, carriedIn, actual) over the bucket's categories (hidden included); leftToSpendCents = committed.income - committed.bills - committed.savings - committed.spending; toAssignCents = committed.income - Σ planned over bills+savings+spending categories (zero-based presentation, same inputs); warning = leftToSpend < 0n; pace = m === currentMonth ? paceCents(leftToSpend, today) : null; uncategorized from input (0/0 when absent).
6. goalProgress(goal): savedCents = startingCents + Σ actual(c, m) for m in [startMonth, currentMonth] (category rows + net linked transfers); remainingToTargetCents = max(0n, target - saved); monthsLeft = targetDate ? max(1, monthDiff(currentMonth, monthOf(targetDate)) + 1) : null; neededPerMonthCents = monthsLeft ? ceilDiv(remainingToTarget, BigInt(monthsLeft)) : null; projectedCompletionMonth = monthlyContribution > 0n && remaining > 0n ? addMonths(currentMonth, Number(ceilDiv(remaining, monthlyContribution))) : (remaining === 0n ? currentMonth : null); onTrack = neededPerMonth !== null && monthlyContribution >= neededPerMonth; progressBp = Number(min(10000n, saved x 10000n / target)).

## Averages (plan from average), packages/db/src/services/plan.ts
planAverages(db, { months: 3|6|12, asOf: Month }): window = [addMonths(asOf, -months), addMonths(asOf, -1)] (the partial current month is excluded). firstLedgerMonth = monthOf(min(transaction.date)); monthsWithData = count of window months >= firstLedgerMonth; 0 -> every average 0n. averageCents(c) = max(0n, divTrunc(Σ_{m in window} actual(c, m) incl. goalNet, BigInt(monthsWithData))). Rule: divide by months that have data (a 12-month average in a 2-month-old ledger is sum/2, and the response says so), truncate toward zero, clamp at 0.

## Net worth (dashboard)
todayCents = Σ over non-closed accounts of the latest balance_snapshot with date <= today (DISTINCT ON (account_id) ORDER BY account_id, date DESC). yearAgoDate = addMonthsClamped(today, -12). yearAgoCents = same query with date <= yearAgoDate; accounts with no snapshot on/before that date contribute 0 and are listed in newAccounts; yearAgoCents and changeCents are null when NO account has a snapshot that old. changeCents = today - yearAgo. Liabilities are negative balances.

## Persistence, packages/db/src/services
```ts
// plan.ts
export async function loadPlanInput(db: DbOrTx, q: { from: Month; to: Month; today: IsoDate }): Promise<PlanInput>;
//  lower bound = monthStart(min(from, every rollover_start_month with mode != none, every goal.start_month)); upper = exclusive start of the month after max(to, currentMonth)
//  SQL actuals: select coalesce(s.category_id, t.category_id) cat, to_char(t.date,'YYYY-MM') m, sum(coalesce(s.amount_cents, t.amount_cents)), sum(case when t.pending then coalesce(s.amount_cents, t.amount_cents) else 0 end), count(*)::int from "transaction" t left join split s on s.transaction_id = t.id where t.is_transfer = false and t.date >= $lo and t.date < $hi and coalesce(s.category_id, t.category_id) is not null group by 1,2
//  SQL goalNet: select g.category_id, to_char(t.date,'YYYY-MM'), sum(t.amount_cents), count(*)::int from "transaction" t join savings_goal g on g.linked_account_id = t.account_id where t.is_transfer = true and t.date >= $lo and t.date < $hi group by 1,2
//  SQL uncategorized: select to_char(date,'YYYY-MM'), count(*)::int, sum(amount_cents) from "transaction" where category_id is null and is_transfer = false and date >= $from1 and date < $toNext group by 1
export async function getPlan(db, q): Promise<PlanResult>;   // computePlan(await loadPlanInput(db, q))
export async function setPlanCells(db: Db, edits: PlanCellEdit[], ctx: { userId: string|null; batchId: string }): Promise<{ changed: number }>;
//  one transaction; per edit: select existing (category_id, month); plannedCents === null -> delete (+audit delete if it existed); else upsert (+audit create/update only when planned or source differ). 400 on unknown category or negative cents. Max 600 edits.
export async function planAverages(db, q: { months: 3|6|12; asOf: Month }): Promise<{ window: { from; to; monthsWithData }; averages: Array<{ categoryId; averageCents: bigint }> }>;
// categoryGroups.ts: createGroup, updateGroup, deleteGroup (categories -> ungrouped via FK), reorderGroups(ids) and reorderCategories({ groupId, ids }) — positions 1..n in the given order, omitted rows keep relative order after (same semantics as rules reorder); group.bucket must equal each listed category's bucket (400).
// categories.ts: deleteCategory -> 409 when any transaction, split, recurring or goal references it; month_plan cascades.
// goals.ts: listGoals, createGoal, updateGoal, deleteGoal — return GoalView with goalProgress over actuals for [startMonth, currentMonth].
// audit.ts: writeAudit(tx, { userId, batchId, entity, entityId, action, before, after }) (skips when before deep-equals after); listAudit(db, { entity?, entityId?, batchId?, limit, cursor? }).
// dashboard.ts: getDashboard(db, { today }): getPlan for [currentMonth, currentMonth] (summary only); projectCashFlow(..., horizonDays 30) via the cash-flow area's loader; billsDue = active recurring with expected_cents < 0 and next_due_date <= today + 14 ordered by next_due_date, overdue = next_due_date < today; net worth; review counts = countUncategorized(), count(recurring.status = 'suggested'), count(alert.dismissed_at is null); sync = max(connection.last_sync_at) and connections with status in (auth_required, error).
```
Recompute strategy: carried-in -> recomputed on every GET /plan from each category's start month; nothing written, no job, no invalidation to get wrong. Mutations return the fresh PlanResponse for the client's range when asked, so one round trip refreshes later months. Dashboard -> computed per request, Cache-Control: no-store; only client-side staleTime 30 s. Clock: app.decorate('now', () => new Date()); today defaults to toIsoDate(app.now()) (UTC, Phase 1 convention) and the PWA always sends its local date, accepted when |dayDiff(serverToday, today)| <= 2 else 400.

## Web, apps/web/src/pages/PlanPage.tsx + components/PlanGrid.tsx
- Data: useQuery({ queryKey: ['plan', from, to], queryFn: () => api<PlanResponse>(`/plan${query({ from, to, today: localToday() })}`), placeholderData: keepPreviousData }). Range in the URL (?from&to); omitted -> server default. "More months" buttons extend by 1 within the 24-month cap.
- Virtualization (@tanstack/react-virtual): rows = data.rows.filter(r => r.kind !== 'category' || !r.hidden || showHidden). useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: i => rows[i].kind === 'category' ? (compact ? 28 : 44) : rows[i].kind === 'bucket' ? 40 : 32, overscan: 8 }); call measure() when compact toggles. Rows absolutely positioned in a div of height getTotalSize(). Sticky bucket header: stickyIndex = greatest i <= virtualItems[0].index with rows[i].kind === 'bucket'; render rows[stickyIndex] once more in a `position: sticky; top: <strip height>` element at the top of the scroll container and hide its virtual copy while stuck. Columns are few (6 default, 24 max): each row is a CSS grid `grid-template-columns: 220px repeat(N, minmax(var(--col), 1fr))` (--col 160px, 96px compact) with the name column `position: sticky; left: 0`. The summary strip is a sibling above the scroll container sharing scrollLeft through one onScroll handler.
- Summary strip per month: month label, committed income/bills/savings/spending, "Left to spend" (or "To assign" when the zeroBased toggle is on; same response, different field), pace line "$92.29/day for 19 days" on the current month (or "over by $X"), uncategorized badge linking to the register; class `warn` when warning.
- Cell: planned / actual / remaining; compact shows remaining only (tooltip with the rest); carriedIn != 0 renders "+$55.00 in" / "-$60.00 in"; remaining < 0 adds class `overspent`; `source` renders a marker (R recurring, G goal, A average) and dims the planned input for virtual values; pendingCents != 0 renders a small "incl. $25.00 pending".
- Keyboard: planned is an `<input inputMode="decimal">` in every category cell. Focus selects the raw decimal; typing a digit on a focused cell starts editing; input accepts "1,234.50", "$12", "12.5" (strip $ and , then parseDecimalToCents; negatives rejected inline). Enter commits and moves down one category row; Shift+Enter up; Tab/Shift+Tab right/left; ArrowUp/Down move rows; Escape reverts; Delete on an empty input commits null (revert to auto); Ctrl/Cmd+Shift+ArrowRight = fill right through the last visible month; Ctrl/Cmd+Shift+A opens plan-from-average (3/6/12). A "..." cell menu offers Fill right, Plan from average, Clear, Rollover (mode + start month), Drill into transactions.
- Mutation + optimistic update: useMutation({ mutationFn: (body: SetPlanCellsBody) => api('/plan/cells', { method: 'PUT', body: { ...body, range: { from, to } } }), onMutate: async body => { await qc.cancelQueries({ queryKey: ['plan'] }); const prev = qc.getQueryData(key); qc.setQueryData(key, d => for each edit patch that category cell: planned = value ?? planned, source = value === null ? 'none' : edit.source, remaining = planned + carriedIn - actual); return { prev } }, onError: (_, __, ctx) => qc.setQueryData(key, ctx.prev), onSuccess: res => res.plan && qc.setQueryData(key, res.plan), onSettled: () => qc.invalidateQueries({ queryKey: ['dashboard'] }) }). Fill right = one edit per visible month after the source month with the displayed (resolved) value, source 'manual'. Plan from average = GET /plan/averages, then edits with source 'average'.
- Drill-down: clicking an actual navigates to `/transactions?categoryId=<id>&from=<YYYY-MM-01>&to=<last day>&transfers=exclude`; goal categories use `?goalId=<goal id>&from&to`; the uncategorized badge uses `?uncategorized=true&from&to`. TransactionsPage reads these filters from the URL (today it keeps them in state only).
- Drag-to-recategorize: a register row is draggable (dataTransfer 'text/meridian-transaction' = id); category rows in the grid and in the drill-down panel are drop targets; drop sends the existing `PATCH /api/transactions/:id { categoryId }` (locks the category), invalidates ['transactions'], ['plan'], ['dashboard'], and offers the Phase 1 "always do this" rule prompt.
- Dashboard page: useQuery(['dashboard'], staleTime 30_000, refetchOnWindowFocus true); ECharts line for cashFlow.points with markPoint at lowPoint and markLine at thresholdCents; cards map 1:1 to DashboardView; review counts link to /transactions?uncategorized=true, /recurring?status=suggested, /alerts.
- Invalidation map: plan cells, categories, groups, goals, recurring, transactions, rules, CSV commit -> ['plan'], ['dashboard'] (+ own list key); alert dismiss -> ['alerts'], ['dashboard']; sync completion (connections poll) -> ['plan'], ['dashboard'], ['transactions']. compact and zeroBased toggles persist in localStorage (try/catch).

## api

All under /api, session-authenticated; the Phase 1 auth plugin already returns 403 for any non-GET by a viewer. Zod contracts appended to packages/shared/src/api.ts; reuse CentsString, IsoDateString, UuidParams, OkResponse. Views in apps/api/src/views.ts: toPlanView, toGoalView, toRecurringView, toAlertView, toAuditView. Routes: apps/api/src/routes/plan.ts, categories.ts (extended + groups), goals.ts, recurring.ts (recurring + alerts), dashboard.ts, audit.ts, registered in app.ts beside the Phase 1 routes.

## Primitives (enums.ts / api.ts)
MonthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/); RolloverMode = z.enum(['none','surplus_only','surplus_and_overspend']); PlanSource = z.enum(['manual','average','recurring','goal','none']); Cadence = z.enum(['weekly','biweekly','twice_monthly','monthly','quarterly','semiannual','yearly']); RecurringStatus = z.enum(['suggested','active','paused','cancelled','dismissed']); AlertKind = z.enum(['price_increase','new_subscription','missed_charge','trial_converted']); AuditEntity = z.enum(['month_plan','category','category_group','savings_goal','recurring','rule']); JobType gains 'recurring.detect'.

## Plan
GET /plan — PlanQuery { from?: MonthString, to?: MonthString, today?: IsoDateString }. Defaults: today = server date; from = currentMonth - 2, to = currentMonth + 3 (6 columns: last 2, current, next 3); from and to default independently. 400 when from > to, span > 24 months, from < 2000-01, or |today - serverToday| > 2 days.
```
PlanCell = { plannedCents: CentsString, carriedInCents, actualCents, pendingCents, remainingCents, source: PlanSource, txnCount: int, overspent: boolean }
GoalSummary = { id, name, targetCents, targetDate: IsoDateString|null, linkedAccountId: uuid|null, linkedAccountName: string|null, monthlyContributionCents, startMonth: MonthString, startingCents, savedCents, remainingToTargetCents, monthsLeft: int|null, neededPerMonthCents: CentsString|null, projectedCompletionMonth: MonthString|null, onTrack: boolean, progressBp: int }
PlanBucketRow   = { kind: 'bucket',   bucket: Bucket, cells: PlanCell[] }
PlanGroupRow    = { kind: 'group',    bucket, groupId: uuid, name, position: int, cells }
PlanCategoryRow = { kind: 'category', bucket, groupId: uuid|null, categoryId: uuid, name, position: int, hidden: boolean, rolloverMode: RolloverMode, rolloverStartMonth: MonthString|null, goal: GoalSummary|null, cells }
PlanRow = z.discriminatedUnion('kind', [PlanBucketRow, PlanGroupRow, PlanCategoryRow])
PaceView = { daysLeft: int, perDayCents: CentsString, overCents: CentsString }
MonthSummary = { month: MonthString, committed: { income, bills, savings, spending }, planned: { income, bills, savings, spending }, actual: { income, bills, savings, spending }, leftToSpendCents, toAssignCents, warning: boolean, pace: PaceView|null, uncategorized: { count: int, cents: CentsString } }
PlanResponse = { today: IsoDateString, currentMonth: MonthString, from, to, months: MonthString[], rows: PlanRow[], summary: MonthSummary[] }
```
rows is in display order; cells[i] aligns with months[i]; summary[i] likewise. Goals are not separate rows: a savings category row carries `goal`.

PUT /plan/cells — SetPlanCellsBody { edits: PlanCellEdit[] (1..600), range?: { from: MonthString, to: MonthString }, today?: IsoDateString }. PlanCellEdit = { month: MonthString, categoryId: uuid, plannedCents: CentsString (>= 0) | null, source: z.enum(['manual','average']).default('manual') }. null deletes the stored row (value reverts to recurring/goal/none). Response SetPlanCellsResponse { changed: int, batchId: uuid, plan: PlanResponse | null } (plan when range given). This one endpoint serves typing, clearing, fill right (client sends one edit per future month) and plan-from-average (edits labelled 'average'). One audit batch per call; identical values write nothing and audit nothing.

GET /plan/averages — PlanAveragesQuery { months: z.coerce.number().pipe(z.union([z.literal(3), z.literal(6), z.literal(12)])), asOf?: MonthString (default currentMonth) } -> PlanAveragesResponse { window: { from, to, monthsWithData: int }, averages: Array<{ categoryId: uuid, averageCents: CentsString }> } for every category (hidden included). Read-only.

## Categories and groups (extends routes/categories.ts)
GET /categories -> CategoryView[]; CategoryView gains groupId: uuid|null, position: int, rolloverMode, rolloverStartMonth: MonthString|null, goalId: uuid|null; ordered bucket, group position, position, name.
POST /categories — CreateCategoryBody { name, bucket, groupId?: uuid (must match bucket, 400) } -> CategoryView (position = max + 1 in its group/bucket).
PATCH /categories/:id — UpdateCategoryBody { name?, bucket?, hidden?, groupId?: uuid|null, rolloverMode?: RolloverMode, rolloverStartMonth?: MonthString|null }. Rules: bucket change clears groupId when the group's bucket differs, 400 when a goal is attached and the new bucket is not savings, forces rolloverMode 'none' when the new bucket is income; rolloverMode != 'none' on an income category -> 400; rolloverMode != 'none' with no start month -> start month = currentMonth; rolloverMode 'none' clears it. Audited.
DELETE /categories/:id -> OkResponse; 409 when any transaction, split, recurring item or goal references it (month_plan rows cascade). Audited.
POST /categories/reorder — ReorderCategoriesBody { groupId: uuid|null, ids: uuid[] (min 1) } -> CategoryView[]. Moves the listed categories into groupId (or ungrouped) with positions 1..n; 400 when a listed category's bucket differs from the group's; unknown ids ignored; omitted ones keep relative order after.
GET /category-groups -> CategoryGroupView[] { id, name, bucket, position, categoryCount: int }. POST /category-groups — CreateCategoryGroupBody { name (1..100), bucket } (position = max + 1 in bucket; 409 on duplicate). PATCH /category-groups/:id — UpdateCategoryGroupBody { name? } (bucket immutable: move categories instead). DELETE /category-groups/:id -> OkResponse (its categories become ungrouped). POST /category-groups/reorder — ReorderCategoryGroupsBody { bucket: Bucket, ids: uuid[] } -> CategoryGroupView[].

## Goals
GET /goals -> GoalView[]; GoalView = GoalSummary + { categoryId: uuid, categoryName, createdAt }. POST /goals — CreateGoalBody { name (1..100), categoryId: uuid (savings bucket, no existing goal; else 400/409), targetCents: CentsString (> 0), targetDate?: IsoDateString|null, linkedAccountId?: uuid|null, monthlyContributionCents?: CentsString (>= 0, default '0'), startMonth?: MonthString (default currentMonth), startingCents?: CentsString (>= 0, default '0') } -> GoalView. PATCH /goals/:id — UpdateGoalBody (all optional, same fields incl. nulls; categoryId may change to another savings category without a goal) -> GoalView. DELETE /goals/:id -> OkResponse (category stays; planned reverts to stored rows or 0). All audited.

## Transactions (existing routes; one addition)
TransactionQuery gains goalId?: uuid -> filter `(category_id = goal.category_id and not is_transfer) or (account_id = goal.linked_account_id and is_transfer)`; combines with from/to/limit/cursor. Drill-down URLs: /transactions?categoryId=&from=&to=&transfers=exclude, ?goalId=&from=&to=, ?uncategorized=true&from=&to=. Drag-to-categorize sends the existing PATCH /transactions/:id { categoryId }. No bulk endpoint in Phase 2.

## Recurring and Subscriptions
GET /recurring — RecurringQuery { status?: RecurringStatus (default: all except dismissed), direction?: z.enum(['in','out']), sort?: z.enum(['cost','due','name']).default('due') } -> RecurringList { items: RecurringView[], totals: { yearlyCents, monthlyEquivalentCents } (sums over items) }.
RecurringView = { id, name, payeeId: uuid|null, payeeName: string|null, categoryId: uuid|null, categoryName: string|null, accountId: uuid|null, accountName: string|null, cadence: Cadence, expectedCents: CentsString (signed), toleranceCents, nextDueDate: IsoDateString|null, firstSeenDate: IsoDateString, lastDate: IsoDateString|null, lastAmountCents: CentsString|null, source: z.enum(['detected','manual']), status: RecurringStatus, confidence: number|null, monthlyEquivalentCents, yearlyCents, createdAt }. Subscriptions page = ?status=active&direction=out&sort=cost (yearlyCents desc, then name). Review page = ?status=suggested.
POST /recurring — CreateRecurringBody { name, payeeId?, categoryId, accountId?, cadence, expectedCents, toleranceCents?: default '0', nextDueDate, firstSeenDate?: default nextDueDate } -> RecurringView (source manual, status active).
PATCH /recurring/:id — UpdateRecurringBody { name?, categoryId?, accountId?, cadence?, expectedCents?, toleranceCents?, nextDueDate?, status?: RecurringStatus } -> RecurringView. Transitions: suggested -> active (confirm; edits in the same call) | dismissed; dismissed -> active; active <-> paused; active | paused -> cancelled; cancelled -> active; anything else 409 'invalid status transition'. Confirming requires a categoryId (400 otherwise). Audited (entity recurring, action update).
DELETE /recurring/:id -> OkResponse (manual items only; detected ones are dismissed/cancelled so detection does not re-propose them; 409 otherwise).
POST /recurring/detect -> { jobId } (enqueue 'recurring.detect', dedupe).

## Alerts
GET /alerts — AlertQuery { includeDismissed: z.coerce.boolean().default(false) } -> AlertView[] newest first; AlertView = { id, kind: AlertKind, recurringId: uuid|null, recurringName: string|null, transactionId: uuid|null, detail: z.object({ previousCents: CentsString.optional(), currentCents: CentsString.optional(), expectedDate: IsoDateString.optional() }).passthrough(), createdAt, dismissedAt: string|null }.
POST /alerts/:id/dismiss -> AlertView (idempotent: a second call returns the same dismissedAt). Not audited.

## Dashboard
GET /dashboard — DashboardQuery { today?: IsoDateString } -> DashboardView (computed on request, Cache-Control: no-store):
```
DashboardView = {
  today: IsoDateString,
  plan: { month: MonthString, leftToSpendCents, toAssignCents, warning: boolean, pace: PaceView, committed: { income, bills, savings, spending }, uncategorized: { count, cents } },
  cashFlow: { asOf: IsoDateString, horizonDays: 30, thresholdCents: CentsString, points: Array<{ date: IsoDateString, cents: CentsString }>, lowPoint: { date, cents }, firstBelow: IsoDateString|null },   // the cash-flow area's engine; combined on-budget line; lowPoint tie -> earliest date
  billsDue: Array<{ recurringId, name, categoryName: string|null, accountName: string|null, dueDate: IsoDateString, amountCents: CentsString, overdue: boolean }>,   // active outflows with next_due_date <= today + 14, by dueDate
  netWorth: { asOf: IsoDateString, todayCents, yearAgoDate: IsoDateString, yearAgoCents: CentsString|null, changeCents: CentsString|null, newAccounts: Array<{ id, name }> },
  review: { uncategorized: int, suggestedRecurring: int, alerts: int },
  sync: { lastSyncAt: string|null, attention: Array<{ connectionId, name, status: ConnectionStatus }> },
  retirement: null   // reserved for Phase 4
}
```

## Audit
GET /audit — AuditQuery { entity?: AuditEntity, entityId?: string, batchId?: uuid, limit: default 50 max 200, cursor?: string } -> AuditList { items: AuditEntryView[], nextCursor: string|null }; AuditEntryView = { id, at, userId: uuid|null, username: string|null, batchId, entity, entityId, action: z.enum(['create','update','delete']), before: unknown|null, after: unknown|null }. Revert is client-side: it re-sends `before` through the entity's normal edit endpoint (for month_plan: PUT /plan/cells with the before value, or null when before was null). "Undo this fill-right" = GET /audit?batchId= then one PUT with every cell's before.

## edgeCases

- Month boundary: SQL uses date >= 'YYYY-MM-01' AND date < next month's first day; a transaction dated 2026-09-30 is September, 2026-10-01 is October; 28/29/30/31-day months need no special case.
- Leap year pace: 2028-02-10 -> daysLeft = 29 - 10 + 1 = 20 (daysInMonth via Date.UTC(y, m, 0)). Last day of the month: daysLeft = 1, perDay = leftToSpend; division by zero is impossible by construction.
- Negative left to spend: perDayCents 0 and overCents carries the shortfall; the strip turns warning-colored; never a negative pace.
- Refund larger than spending in a month makes actual negative in bucket direction; remaining exceeds planned; not overspent; surplus_only carries the full surplus. A net-refund month in a zero-planned category commits 0 under none/surplus_only (max(0, actual) floors at 0).
- Manual 0 vs cleared: a month_plan row with planned 0 suppresses the recurring/goal auto value (source manual); plannedCents null deletes the row and the auto source shows through again. A stored row on a category that later gains a recurring item still wins.
- Rollover enabled mid-history: carriedIn is 0 for every month <= rollover_start_month; the start month's remaining is the first carry; earlier overspend (Groceries Aug -7000) never reaches September.
- Rollover mode or start month changed later re-derives every month from the start month on the next read; switching to none zeroes all carries; nothing is stored, so there is nothing to invalidate. Income categories reject any mode but none (400).
- Future months carry forward projected remaining (Nov's unspent 55500 appears as Dec carriedIn): envelope semantics; the UI dims carried notes in future months.
- Hidden categories are returned with hidden=true and filtered by the client; their planned/actual/remaining stay in group and bucket subtotals and in LTS (Old Hobby's 2000 is inside Sep spending committed 84000).
- Uncategorized transactions sit in no bucket and do not change LTS or toAssign; the summary strip's uncategorized {count, cents} and the dashboard review count make them visible; categorizing one moves it into its category's actual on the next read.
- Transfers never appear in any category cell (is_transfer filter runs before grouping), including rule-marked transfers whose other leg is unconnected and card payments; the only path for a transfer into the grid is a goal's linked account, and that path reads is_transfer rows only, so a locked category on a transfer leg cannot double count.
- Goal round trip: +50000 in and -20000 out of the linked account in one month nets to 30000 of progress; 50000 in and 50000 out nets to 0 (net, not inflow-only).
- Goal with targetDate in the past or the current month: monthsLeft = 1 and neededPerMonth = remainingToTarget; no targetDate: monthsLeft and neededPerMonth null; monthlyContribution 0: projectedCompletionMonth null; target reached: remaining 0, projected = currentMonth, progressBp 10000.
- Goal on a non-savings category, a second goal on the same category, or moving a goal's category out of savings -> 400/409.
- Pending transactions count in actual and are reported in pendingCents; posting replaces the row in place (same id), never duplicates; a pending row the bank drops disappears from actual on the next read because actuals are never cached.
- Split transactions: the aggregation uses split rows when present and the parent otherwise, so a split never double-counts; no split UI exists yet (db service test with a hand-inserted split only).
- Quarterly/yearly bills land only in their months via occurrencesInMonth; months before first_seen_date get 0, so history is not filled for bills that did not exist yet. Two recurring items on one category in one month sum.
- Recurring item with status paused/cancelled/dismissed/suggested: no auto-fill, not in bills due, not in cash flow.
- Bills due window: next_due_date <= today + 14 inclusive (10-27 for today 10-13); a bill due 10-28 is absent; a bill with next_due_date < today is included with overdue: true.
- Averages: the partial current month is excluded; monthsWithData counts window months on/after the ledger's first transaction month; no transactions -> monthsWithData 0 and every average '0'; negative sums (net refunds) clamp to 0; truncation toward zero (1549/2 = 774).
- Fill right over a cell holding an 'average' value overwrites it with source manual; fill right never touches months outside the client's visible range because the server only sees edits; a re-run with identical values changes 0 rows and writes 0 audit rows.
- Range: missing from/to default independently (current-2 / current+3); from > to, span > 24 months or an invalid month -> 400; months outside [from, to] are computed for the chain but not returned; pace is null for every month except the current one and null everywhere when the current month is outside the range.
- today validation: the PWA sends its local date; a value more than 2 days from the server's UTC date -> 400 (bad device clock) instead of a wrong month.
- Concurrent edits from two tabs: last write wins per cell; audit_log keeps both with their own batch ids; the optimistic cache is rolled back on error and replaced by the returned plan on success.
- Deleting a group leaves its categories ungrouped (FK set null) at their existing positions; deleting a category that any transaction, split, recurring item or goal references -> 409 (hide instead); deleting an unused category cascades its month_plan rows.
- Reorder into a group of another bucket -> 400; unknown ids are ignored; ids left out keep their relative order after the listed ones.
- Net worth: closed accounts excluded; yearAgoDate = addMonthsClamped(today, -12) (2028-02-29 -> 2027-02-28); accounts with no snapshot on or before that date contribute 0 and are listed in newAccounts; no snapshot that old anywhere -> yearAgoCents and changeCents null.
- Alerts dedupe on (kind, recurring_id, dedupe_key), so a nightly rerun never creates a second missed_charge for the same expected date and a dismissed alert stays dismissed; dismissing twice is a no-op 200.
- Dismissed recurring suggestions keep their row (status dismissed) so detection does not re-propose the payee; GET /recurring omits them unless status=dismissed is asked; a dismissed row can be re-activated.
- Viewer role: every GET under /plan, /dashboard, /recurring, /alerts, /audit is 200; every PUT/POST/PATCH/DELETE is 403 (existing auth plugin).
- Response size: 24 months x ~60 rows ~ 1,440 cells ~ 250 KB JSON worst case; default 6 months ~ 60 KB; columns are never virtualized.

## testCases

### Seed (every API test below starts from a fresh copy; today = 2026-10-13 passed as ?today= / injected clock)
INPUT: Accounts: Checking (checking), Savings (savings), Visa (credit), all on budget. Groups: Paychecks (income, pos 1), Housing (bills, 1), Subscriptions (bills, 2), Everyday (spending, 1). Categories: Paycheck (income, Paychecks, 1); Rent (bills, Housing, 1); Car Insurance (bills, Housing, 2); Netflix (bills, Subscriptions, 1); Internet (bills, Subscriptions, 2); Music (bills, Subscriptions, 3); Emergency Fund (savings, ungrouped, 1); Groceries (spending, Everyday, 1, surplus_and_overspend from 2026-09); Dining (spending, Everyday, 2, surplus_only from 2026-09); Fuel (spending, Everyday, 3, none); Old Hobby (spending, Everyday, 4, hidden); Shopping (spending, ungrouped, 1). Recurring active: Rent -180000 monthly next 2026-11-01 first seen 2026-09-01; Netflix -1549 monthly next 2026-11-05 first seen 2026-09-05; Internet -7999 monthly next 2026-10-20 first seen 2026-09-20; Car Insurance -45000 quarterly next 2026-12-20 first seen 2026-12-20 (manual). Recurring suggested: Spotify -1099 monthly next 2026-10-25 first seen 2026-10-25 category null; Gym -3999 monthly next 2026-10-30 category null. Goal: Emergency Fund target 1000000, target date 2027-09-30, linked Savings, contribution 50000, startMonth 2026-09, startingCents 200000. month_plan: Paycheck 2026-09/10/11 = 500000 manual; Groceries 2026-09/10/11 = 50000 manual; Dining 2026-09/10 = 20000 manual; Fuel 2026-10 = 15000 manual. Transactions (Checking unless noted): 08-20 -7000 Groceries; 09-01 +250000 Paycheck; 09-15 +250000 Paycheck; 09-01 -180000 Rent; 09-05 -1549 Netflix; 09-20 -7999 Internet; 09-03 -30000 Groceries; 09-17 -10000 Groceries; 09-10 -25000 Dining; 09-30 -1000 Dining; 09-20 -6000 Fuel; 09-08 -2000 Old Hobby; 09-02 -50000 Checking / +50000 Savings (transfer pair); 10-01 +250000 Paycheck; 10-01 -180000 Rent; 10-05 -1649 Netflix; 10-02 -35000 Groceries; 10-11 -21000 Groceries; 10-12 +1500 Groceries (refund); 10-09 -12000 Dining; 10-07 -8000 Dining (Visa); 10-03 -3000 Fuel; 10-13 -2500 Fuel (Visa, pending); 10-02 -50000 Checking / +50000 Savings (transfer pair); 10-10 +20000 Checking / -20000 Savings (transfer pair, withdrawal); 10-08 -30000 Checking / +30000 Visa (card payment pair); 10-12 -4500 'AMAZON' (Visa) uncategorized. Alert: price_increase on Netflix {previousCents 1549, currentCents 1649}, not dismissed. balance_snapshot: Checking 2026-10-13 320000 and 2025-10-10 150000; Savings 2026-10-13 300000 and 2025-10-01 200000; Visa 2026-10-13 -45000 only.
EXPECTED: Seed inserts without constraint errors. Hand totals used below (bucket direction): Groceries Aug 7000, Sep 40000, Oct 35000+21000-1500 = 54500; Dining Sep 25000+1000 = 26000, Oct 20000; Fuel Sep 6000, Oct 5500 (pending 2500); Old Hobby Sep 2000; Paycheck Sep 500000, Oct 250000; Rent Sep/Oct 180000; Netflix Sep 1549, Oct 1649; Internet Sep 7999, Oct 0; Emergency Fund Sep 50000, Oct 50000-20000 = 30000 (net transfers); uncategorized Oct 1 row -4500.

### GET /api/plan default range, row order and Groceries chain (surplus_and_overspend)
INPUT: GET /api/plan?today=2026-10-13
EXPECTED: 200; currentMonth '2026-10'; months ['2026-08','2026-09','2026-10','2026-11','2026-12','2027-01']. rows[0] = {kind 'bucket', bucket 'income'}; spending rows in order: bucket, group Everyday, Groceries, Dining, Fuel, Old Hobby (hidden true), Shopping (ungrouped). Groceries cells planned/carriedIn/actual/remaining/source: Aug 0/0/7000/-7000/none (overspent true); Sep 50000/0/40000/10000/manual; Oct 50000/10000/54500/5500/manual (txnCount 3); Nov 50000/5500/0/55500/manual; Dec 0/55500/0/55500/none; Jan 0/55500/0/55500/none.

### Dining (surplus_only), Fuel (none, pending) and month boundary
INPUT: Same call
EXPECTED: Dining: Sep 20000/0/26000/-6000/manual overspent true (the 09-30 row is September); Oct 20000/0/20000/0/manual (carry max(0,-6000) = 0); Nov 0/0/0/0/none. Fuel: Sep 0/0/6000/-6000/none; Oct 15000/0/5500/9500/manual with pendingCents '2500', txnCount 2. Rent Oct actual '180000' (the 10-01 row is October). Old Hobby Sep actual '2000', hidden true.

### Auto-filled bills, goal row and goal summary
INPUT: Same call
EXPECTED: Rent: Aug 0/none (before first seen); Sep 180000/0/180000/0/recurring; Oct 180000/0/180000/0/recurring; Nov, Dec, Jan 180000/0/0/180000/recurring. Netflix Oct 1549/0/1649/-100/recurring overspent true. Internet Oct 7999/0/0/7999/recurring. Car Insurance: Dec 45000/0/0/45000/recurring, every other month 0/none. Music all 0/none. Emergency Fund: Aug 0/none; Sep 50000/0/50000/0/goal; Oct 50000/0/30000/20000/goal (txnCount 2); Nov-Jan 50000/0/0/50000/goal. goal: savedCents '280000' (200000+50000+30000), remainingToTargetCents '720000', monthsLeft 12, neededPerMonthCents '60000', projectedCompletionMonth '2028-01' (ceil(720000/50000) = 15 months after 2026-10), onTrack false, progressBp 2800. Paycheck: Sep 500000/0/500000/0/manual; Oct 500000/0/250000/250000/manual; Nov 500000/0/0/500000/manual; Dec, Jan 0/none.

### Subtotal rows and summary strip (committed, LTS, to assign, pace, uncategorized)
INPUT: Same call
EXPECTED: Spending bucket row planned/carriedIn/actual/remaining: Aug 0/0/7000/-7000; Sep 70000/0/74000/-4000; Oct 85000/10000/80000/15000; Nov 50000/5500/0/55500; Dec 0/55500/0/55500; Jan same. Group Everyday Oct = 85000/10000/80000/15000; group Subscriptions Oct = 9548/0/1649/7899; Housing Oct = 180000/0/180000/0. Bills bucket: Sep 189548/0/189548/0; Oct 189548/0/181649/7899; Nov 189548/0/0/189548; Dec 234548/0/0/234548; Jan 189548. summary.committed: Aug {0,0,0,7000}; Sep {500000, 189548, 50000, 84000}; Oct {500000, 189648, 50000, 85000}; Nov {500000, 189548, 50000, 50000}; Dec {0, 234548, 50000, 0}; Jan {0, 189548, 50000, 0}. leftToSpendCents: Aug '-7000' (warning true), Sep '176452', Oct '175352', Nov '210452', Dec '-284548', Jan '-239548'. toAssignCents: Aug '0', Sep '190452', Oct '175452', Nov '210452', Dec '-284548', Jan '-239548'. pace: Oct {daysLeft 19, perDayCents '9229' (175352/19 = 9229 rem 1), overCents '0'}, all other months null. uncategorized: Oct {count 1, cents '-4500'}, others {0, '0'}.

### PUT /api/plan/cells fill right, one audit batch, idempotent re-run
INPUT: PUT /api/plan/cells { edits: [Dining 2026-11 '20000', Dining 2026-12 '20000', Dining 2027-01 '20000'], range: {from:'2026-08', to:'2027-01'} } twice; GET /api/audit?entity=month_plan
EXPECTED: First call 200 { changed: 3, batchId: <B>, plan: {...} } with Dining Nov/Dec/Jan 20000/0/0/20000/manual; Nov committed.spending '70000', leftToSpendCents '190452', toAssignCents '190452'; Dec leftToSpendCents '-304548'. Audit: 3 new entries, all batchId B, action 'create', entityId '2026-11:<Dining>' / '2026-12:<Dining>' / '2027-01:<Dining>', before null, after { plannedCents: '20000', source: 'manual' }. Second identical call: 200 { changed: 0 }, audit count unchanged.

### Override a recurring bill, then clear to auto; audit delete entry
INPUT: PUT { edits: [Rent 2026-10 '190000'], range } then PUT { edits: [Rent 2026-10 null], range }; GET /api/audit?entity=month_plan&entityId=2026-10:<Rent>
EXPECTED: After override: Rent Oct 190000/0/180000/10000/manual; Oct committed.bills '199648'; leftToSpendCents '165352'; toAssignCents '165452'. After null: { changed: 1 }; Rent Oct back to 180000/0/180000/0/recurring; Oct leftToSpendCents '175352'. Audit for the cell, newest first: 'delete' (before {plannedCents '190000', source 'manual'}, after null) then 'create' (before null, after the same). Negative plannedCents '-100' -> 400 'validation' and no audit row.

### GET /api/plan/averages divides by months with data and truncates
INPUT: GET /api/plan/averages?months=3 (asOf defaults to 2026-10); then ?months=12
EXPECTED: months=3: window { from '2026-07', to '2026-09', monthsWithData 2 } (ledger starts 2026-08). averages: Groceries '23500' ((7000+40000)/2); Dining '13000'; Fuel '3000'; Old Hobby '1000'; Rent '90000'; Netflix '774' (1549/2 truncated); Internet '3999' (7999/2); Paycheck '250000'; Emergency Fund '25000' (net linked transfers count); Car Insurance, Music, Shopping '0'. months=12: window { '2025-10', '2026-09', monthsWithData 2 } with identical averages.

### Average-sourced edit feeds the carry chain
INPUT: PUT { edits: [{ month:'2026-11', categoryId: Groceries, plannedCents:'23500', source:'average' }], range }
EXPECTED: { changed: 1 }. Groceries Nov 23500/5500/0/29000/average; Dec 0/29000/0/29000/none; Jan 0/29000/0/29000/none. Nov committed.spending '23500' (max(29000, 0) - 5500); Nov leftToSpendCents '236952' (500000 - 189548 - 50000 - 23500); toAssignCents '236952'.

### Rollover mode change re-derives carries without moving LTS; income rejects rollover
INPUT: PATCH /api/categories/<Dining> { rolloverMode:'surplus_and_overspend', rolloverStartMonth:'2026-09' } then GET /api/plan; PATCH /api/categories/<Paycheck> { rolloverMode:'surplus_only' }; PATCH <Dining> { rolloverMode:'none' } then GET /api/plan
EXPECTED: Dining cells: Sep 20000/0/26000/-6000; Oct 20000/-6000/20000/-6000; Nov 0/-6000/0/-6000; Dec and Jan 0/-6000/0/-6000. Summary unchanged: Sep '176452', Oct '175352', Nov '210452' (Oct Dining committed = max(14000, 20000) - 0 = 20000 as before; Nov = max(-6000, 0) = 0). Paycheck PATCH -> 400 'Income categories cannot roll over'. After mode none: Dining Oct carriedIn '0', rolloverStartMonth null; CategoryView audit entry action 'update' with before.rolloverMode 'surplus_and_overspend'.

### Drill-down query params (category, goal, uncategorized) and drag-to-categorize
INPUT: GET /api/transactions?categoryId=<Groceries>&from=2026-10-01&to=2026-10-31&transfers=exclude; GET /api/transactions?goalId=<EmergencyFund>&from=2026-10-01&to=2026-10-31; GET /api/transactions?uncategorized=true&from=2026-10-01&to=2026-10-31; PATCH /api/transactions/<AMAZON> { categoryId: <Shopping> }; GET /api/plan
EXPECTED: Groceries list: 3 items newest first: +1500 (10-12), -21000 (10-11), -35000 (10-02); sum -54500 = Oct actual. Goal list: 2 items, both Savings legs with isTransfer true: -20000 (10-10) and +50000 (10-02); sum +30000 = Emergency Fund Oct actual. Uncategorized list: 1 item (AMAZON). After the PATCH (categoryLocked true): Shopping Oct 0/0/4500/-4500/none overspent true; Oct uncategorized {0, '0'}; committed.spending '89500'; leftToSpendCents '170852'; pace {daysLeft 19, perDayCents '8992' (170852/19 = 8992 rem 4), overCents '0'}; toAssignCents unchanged '175452'.

### Goal CRUD and its effect on the plan
INPUT: POST /api/categories { name:'Vacation', bucket:'savings' }; POST /api/goals { name:'Vacation', categoryId:<Vacation>, targetCents:'300000', targetDate:'2027-06-30', monthlyContributionCents:'25000', startMonth:'2026-10' } -> GET /api/plan; DELETE /api/goals/<id> -> GET /api/plan; POST /api/goals { categoryId:<Groceries>, ... }; POST /api/goals { categoryId:<EmergencyFund>, ... }
EXPECTED: POST goal 200 GoalView { savedCents '0', remainingToTargetCents '300000', monthsLeft 9 (monthDiff(2026-10, 2027-06) + 1), neededPerMonthCents '33334' (ceil(300000/9); 9 x 33333 = 299997), projectedCompletionMonth '2027-10' (ceil(300000/25000) = 12 months), onTrack false, progressBp 0 }. Plan: Vacation row in savings (ungrouped, after Emergency Fund) with Oct-Jan planned '25000' source 'goal', Sep 0/none; Oct leftToSpendCents '150352', toAssignCents '150452'. After DELETE: Vacation cells 0/none; Oct leftToSpendCents '175352'. Goal on Groceries -> 400 'Goals need a savings category'; second goal on Emergency Fund -> 409.

### Category group create, reorder across groups, bucket mismatch, delete rules
INPUT: POST /api/category-groups { name:'Transport', bucket:'spending' }; POST /api/categories/reorder { groupId:<Transport>, ids:[<Fuel>] }; GET /api/plan; POST /api/categories/reorder { groupId:<Housing>, ids:[<Fuel>] }; DELETE /api/categories/<Groceries>; DELETE /api/categories/<Shopping>
EXPECTED: Group created with position 2 (Everyday is 1), categoryCount 0. Reorder -> Fuel { groupId <Transport>, position 1 }. Spending rows in order: bucket, group Everyday, Groceries, Dining, Old Hobby, group Transport, Fuel, Shopping; Transport group row Oct cells = Fuel's (15000/0/5500/9500, pendingCents '2500'). Reorder into Housing (bills) -> 400 'Category bucket does not match group'. DELETE Groceries -> 409 (transactions reference it). DELETE Shopping -> 200 { ok: true } and it is absent from the next GET /api/plan; audit entry action 'delete' entity 'category'.

### Recurring list for Subscriptions, confirm and dismiss suggestions, status matrix
INPUT: GET /api/recurring?status=active&direction=out&sort=cost; PATCH /api/recurring/<Spotify> { status:'active', categoryId:<Music> }; GET /api/plan; GET /api/recurring?status=active&direction=out&sort=cost; PATCH /api/recurring/<Gym> { status:'dismissed' }; GET /api/recurring; GET /api/recurring?status=dismissed; PATCH /api/recurring/<Rent> { status:'suggested' }
EXPECTED: First list items in order: Rent yearlyCents '2160000' monthlyEquivalentCents '180000'; Car Insurance '180000'/'15000'; Internet '95988'/'7999'; Netflix '18588'/'1549'; totals { yearlyCents '2454576', monthlyEquivalentCents '204548' }. After confirming Spotify: Music Oct-Jan planned '1099' source 'recurring' (first seen 2026-10-25, so Sep stays 0); Oct committed.bills '190747', leftToSpendCents '174253', toAssignCents '174353'; list now ends with Spotify '13188'/'1099' and totals { '2467764', '205647' }. Gym dismissed: absent from default GET /api/recurring, present with ?status=dismissed; review.suggestedRecurring becomes 0. Rent -> suggested: 409 'invalid status transition'. Audit has 'update' entries for both PATCHes (entity recurring).

### Alerts list and idempotent dismiss
INPUT: GET /api/alerts; POST /api/alerts/<id>/dismiss twice; GET /api/alerts; GET /api/alerts?includeDismissed=true
EXPECTED: First GET: 1 item { kind 'price_increase', recurringName 'Netflix', detail { previousCents '1549', currentCents '1649' }, dismissedAt null }. First dismiss 200 with dismissedAt set; second dismiss 200 with the identical dismissedAt. Second GET: []; includeDismissed -> 1 item. Dashboard review.alerts goes 1 -> 0. No audit_log rows are written.

### GET /api/dashboard computed on request
INPUT: GET /api/dashboard?today=2026-10-13 (fresh seed) twice
EXPECTED: today '2026-10-13'; plan { month '2026-10', leftToSpendCents '175352', toAssignCents '175452', warning false, pace { daysLeft 19, perDayCents '9229', overCents '0' }, committed { income '500000', bills '189648', savings '50000', spending '85000' }, uncategorized { count 1, cents '-4500' } }; billsDue = [{ name 'Internet', dueDate '2026-10-20', amountCents '-7999', overdue false }] only (window ends 2026-10-27; Rent 11-01, Netflix 11-05, Car Insurance 12-20 excluded; suggested Spotify/Gym excluded); netWorth { asOf '2026-10-13', todayCents '575000' (320000 + 300000 - 45000), yearAgoDate '2025-10-13', yearAgoCents '350000' (150000 + 200000 + 0), changeCents '225000', newAccounts [{ name 'Visa' }] }; review { uncategorized 1, suggestedRecurring 2, alerts 1 }; cashFlow.horizonDays 30, points.length 31, points[0].date '2026-10-13' (balances asserted in the cash-flow area's tests); retirement null; response header Cache-Control: no-store. Second call returns identical JSON.

### Range, today validation and viewer role
INPUT: GET /api/plan?from=2026-10&to=2026-09; ?from=2024-01&to=2026-12; ?from=2026-13; ?from=2026-10 only; ?to=2026-10 only; ?today=2026-10-20 (server clock 2026-10-13); viewer session: GET /api/plan, PUT /api/plan/cells, PATCH /api/categories/<Dining>, POST /api/alerts/<id>/dismiss
EXPECTED: from > to -> 400; 36-month span -> 400 'At most 24 months'; '2026-13' -> 400 code 'validation'; from only -> months 2026-10 ... 2027-01; to only -> months 2026-08 ... 2026-10; today 7 days off -> 400 'today is too far from the server date'. Viewer: GET 200; every mutation 403 code 'viewer'.

### Pure helpers (packages/shared/src/plan.test.ts, dates.test.ts, money.test.ts)
INPUT: paceCents(100000n, '2028-02-10'); paceCents(-5000n, '2026-10-31'); daysInMonth('2028-02'), ('2100-02'), ('2026-04'); addMonthsClamped('2028-02-29', -12); monthDiff('2026-10','2027-09'); addMonths('2026-10', 15); ceilDiv(720000n, 12n); ceilDiv(300000n, 9n); divTrunc(1549n, 2n); divTrunc(-7n, 2n); committedCents(50000n, 10000n, 54500n); committedCents(20000n, 0n, 26000n); committedCents(0n, -6000n, 0n); committedCents(0n, 55500n, 0n); carryOut('surplus_only', -6000n); carryOut('surplus_and_overspend', -6000n); annualize(-1599n, 'monthly'); annualize(-2500n, 'biweekly')
EXPECTED: {daysLeft 20, perDayCents 5000n, overCents 0n}; {daysLeft 1, perDayCents 0n, overCents 5000n}; 29, 28, 30; '2027-02-28'; 11; '2028-01'; 60000n; 33334n; 774n; -3n; 50000n; 26000n; 0n; 0n; 0n; -6000n; {yearlyCents 19188n, monthlyEquivalentCents 1599n}; {yearlyCents 65000n, monthlyEquivalentCents 5416n}.

### computePlan engine: hidden rows in totals, refund, carry before start month, goal net (packages/shared/src/plan.test.ts with the seed as a PlanInput fixture)
INPUT: computePlan(fixture) with from 2026-08, to 2027-01, today 2026-10-13
EXPECTED: Sep spending committed 84000n includes Old Hobby 2000n; removing Old Hobby's actual from the fixture gives 82000n and LTS 178452n. Groceries Oct actual 54500n (refund applied); Aug remaining -7000n with carry 0n into Sep (before start month). Emergency Fund Oct actual 30000n from goalNet 50000n - 20000n; with the withdrawal removed, 50000n and remaining 0n. Groceries chain Sep..Jan carriedIn [0n, 10000n, 5500n, 55500n, 55500n]. Running computePlan twice on the same input yields deep-equal results (pure).

## risks

- Left-to-spend formula committed = max(planned + carriedIn, actual) - max(carriedIn, 0) must be the one the plan-math area's engine implements; it equals A's rule under none/surplus_only and differs only under surplus_and_overspend (this spec charges the overspend in the month it happens and tightens the next month's commitment; A charges it never and relies on the negative carry). Every LTS number above encodes this choice; reconcile before writing the engine.
- Deviations from the spec's data-model table: rollover mode (plus rollover_start_month) on category, and no stored carried-in amount. Both are flagged; a carried_in_cents cache column can be added later without changing any contract.
- Change to a lead decision: goal actual counts NET transfer legs in the linked account rather than inflows only. If inflow-only is kept, withdrawals must be categorized to the goal category to reduce progress, and the goalId drill-down filter changes to amount_cents > 0.
- bucket_override (a Phase 1 column) is ignored by the grid; a transaction's bucket is its category's bucket. If the lead wants per-transaction bucket moves, the only clean home is a synthetic per-bucket 'other' row (Design A), which this spec rejected for complexity.
- Auto-fill depends on recurring.first_seen_date and a two-direction occurrencesInMonth from the recurring area; without first_seen_date, past months before next_due_date show planned 0 and spurious overspend.
- monthsWithData as the average divisor may surprise a user expecting a literal 12-month average in the first year; the response's window.monthsWithData exists so the UI can say 'average of 2 months'.
- Carry chain recompute scans non-transfer transactions from the earliest rollover/goal start month on every GET /plan (one GROUP BY; fine at household scale). Add a (category_id, date) index if the grid ever feels slow; the 240-month chain cap bounds the loop.
- The client composes fill-right and plan-from-average edit lists; a future second client must replicate that. The audit batch_id keeps each such action reviewable and revertible as one unit.
- Optimistic updates patch only the edited cell; subtotals, carried-in and LTS arrive with the response's plan (one round trip, ~100 ms on LAN, longer over Tailscale).
- today is trusted from the client within a 2-day bound of the server's UTC date; a device with a badly wrong clock gets a 400 instead of a wrong month. Without the parameter, pace daysLeft can be off by one for a few hours around midnight UTC.
- Dashboard has no server cache (~8 queries plus two pure engines per request). If the cash-flow engine grows, the cashFlow block can move to a job-written snapshot without changing DashboardView.
- Net worth 12-month change is sensitive to newly connected accounts (named in newAccounts) and to accounts SimpleFIN stops reporting (their last snapshot stays in place); stale accounts are not detected.
- Split transactions are handled in the actuals SQL but no UI creates splits yet; that branch is covered only by a db service test with a hand-inserted split.
- The flat row shape couples the grid to server-chosen display order; a collapsible tree view would need the client to derive it from groupId (easy, but not free).

## resolutions

- Response shape: B's flat, display-ordered discriminated-union rows (bucket, group, category) with per-row cells, plus bucket and group subtotal rows, instead of A's nested buckets/groups/other tree. Reason: the grid is virtualized by row index and needs exactly this list; subtotals come precomputed; goals decorate savings category rows (both agreed).
- Carried-in storage: neither A's write-back-from-GET cache nor a job. Recompute on read from each category's rollover_start_month, store nothing (B). Reason: a GET that writes would let the read-only viewer role write and rules out a read replica; the value is a pure function and goes stale on every transaction change; the lead's question ('recompute on read ... or recompute in a job') is answered with 'on read, no write-back'. Flagged as a spec table deviation.
- Rollover mode on category with rollover_start_month (both designs, lead decision). Names follow the lead's words: none | surplus_only | surplus_and_overspend (A's enum over B's shorter one).
- month_plan: row-absent = auto value (B) instead of A's nullable planned_cents. Reason: equivalent semantics, one fewer null state; audit uses the stable `${month}:${categoryId}` key so delete/recreate keeps one history.
- Write endpoints: one PUT /plan/cells (B) for typing, clearing, fill right and plan-from-average, with a read-only GET /plan/averages, instead of A's three server endpoints. Added from A: a batch_id per request in audit_log and an optional `range` that returns the fresh PlanResponse in the same round trip, plus `batchId` in the response for batch revert.
- Left to spend: B's committed = max(planned + carriedIn, actual) - max(carriedIn, 0) for every bucket. A's rule (planned + chargedOverspend, overspend not charged under surplus_and_overspend) is identical under none/surplus_only; under surplus_and_overspend B's keeps the month's LTS equal to cash (the overspend reduces this month, the negative carry reduces next month's commitment). A's test 'Rollover mode changes recompute carried-in on read' was recomputed under this rule.
- To assign: Σ income committed (max(planned, actual) per income row, A) minus Σ planned over bills+savings+spending (both). Reason: the lead's 'same numbers' means the income term is shared with LTS; B's Σ income planned would ignore extra income received.
- Pace: A's non-negative perDayCents plus overCents (B returned a negative pace). Field name daysLeft (B). Division truncates (both).
- Goal actual: A's flaw accepted — net transfer legs in the linked account, not inflows only. Stated explicitly as a change to the lead decision with the reason (a round trip would otherwise show progress). B's startingCents and start_month both kept.
- Uncategorized: B's approach (no bucket, surfaced as summary {count, cents} and dashboard review count) over A's synthetic 'other' rows that charge uncategorized outflows as overspend. Reason: spec formula uses planned spending and 'actual from categorized deposits'; A's approach makes LTS swing with an unreviewed register and adds a row kind. bucket_override consequently unused by the grid (flagged).
- Integer rounding: one rule, bigint truncation toward zero (A), applied to pace, averages and monthly equivalents; B's half-away-from-zero divRound dropped (two rules invite mistakes). Averages divide by monthsWithData (B) rather than the literal N (A); clamp at 0 (both).
- Recurring occurrences bounded below by first_seen_date (B); A's unbounded backward stepping would fill history with bills that did not exist. Status 'dismissed' added (both). Transition matrix from A (explicit 409s) with B's single PATCH { status } instead of a separate dismiss route; DELETE only for manual items (B).
- today: A's client-supplied date (PWA local date) with a 2-day sanity bound, combined with B's injectable server clock as the default and for tests.
- Groups: B's nullable group_id (ungrouped categories render after groups) over A's seeded default group per bucket and NOT NULL backfill. Bucket stays directly editable on PATCH /categories (Phase 1 behaviour, B) with goal/income guards; A's 'move via group' restriction dropped.
- Category delete: A's DELETE with 409 when referenced (B offered none). Reason: unused categories accumulate; the guard keeps the ledger safe.
- Net worth: A's addMonthsClamped(today, -12) and newAccounts list (B used today - 365 days and no list); B's null when nothing that old exists kept. Closed accounts excluded (B).
- Bills due: B's next_due_date <= today + 14 with overdue flag (A's window started at today and would hide an overdue bill).
- Subscriptions: B's GET /recurring?status=active&direction=out&sort=cost plus A's totals, as RecurringList { items, totals }.
- Drill-down: existing from/to date params (B) rather than A's new month param; goalId filter added (both); A's bulk recategorize endpoint dropped (not required by the spec).
- Audit: B's minimal table (text entity_id, create|update|delete, client-side revert) plus A's batch_id and username in the view. Alert dismissals and transaction edits not audited (both).
- Source enum extended by 'goal' (both designs; lead's list had manual|recurring|average|none) — flagged for the lead.
- Both designs missed: pendingCents and txnCount on the cell (spec: 'click actual to drill into its transactions', pending visibility), `warning` on the summary (spec: strip turns warning-colored), planned and actual bucket totals in the summary strip (spec: 'bucket totals'), and `categoryCount` on groups; all added.
