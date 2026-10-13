## summary

Merged specification for Phase 2 month-plan math (Meridian, /home/user/meridian). One pure engine `computePlan` in packages/shared/src/plan.ts (bigint only, no DB), persistence in packages/db/src/services/plan.ts and goals.ts, Fastify routes under /api/plan, /api/category-groups, /api/goals, one worker job `plan.close_month`.

Conventions. Transaction amounts stay signed (income +, outflow −). Every grid number is a "bucket-natural" bigint (positive is good): planned is a non-negative magnitude; actual = bucketSign(bucket) × Σ signed cents (income +1n, bills/savings/spending −1n), converted exactly once; carriedIn may be negative. One formula per cell for every bucket: available = planned + carriedIn; remaining = available − actual; overspend = max(0, −remaining) (0 for income).

Storage is only what the user types plus a frozen history: `category_group` (bucket lives here), `category` extended (group_id + bucket under a composite FK with ON UPDATE CASCADE so they can never disagree; position; rollover_mode; rollover_from_month), `month_plan` (planned_cents + planned_source, per-month rollover_mode override, carried_in_override_cents, note), `plan_settings` singleton (start_month, zero_based), `savings_goal`, `plan_audit`. Carried-in is NOT stored: it is recomputed on every read by folding the chain forward from plan_settings.start_month (per category no earlier than rollover_from_month); the spec's "carried-in amount" column is the nullable pin `carried_in_override_cents`. Auto-planned values (bills/income from recurring occurrences, savings from goal contributions) are computed live for the current and future months and frozen into month_plan rows with source recurring|goal by the nightly idempotent job `plan.close_month` for completed months, so history never shifts.

Two summary numbers from the same cells, plus the zero-based line: leftToSpendPlannedCents = incomePlanned − billsPlanned − savingsPlanned − spendingPlanned (the spec's literal formula; carried-in excluded); leftToSpendCents (shown on the strip and dashboard, drives the daily pace) = incomeExpected + otherIncomeActual + savingsWithdrawn − Σ committed over outflow rows, where committed(category) = planned + min(carriedIn, 0) + overspend and committed(other row) = actual. Carried-in surplus is never charged twice (it was funded by an earlier month); a carried-in overspend was charged in the month it happened, so this month funds only the rest of the envelope. With no activity both numbers coincide. Zero-based toAssign(m) = toAssign(m−1) − forgivenOverspend(m−1) + incomeActual(m) − Σ planned outflows(m), Actual's semantics (overspend in non-'all' categories is charged to the next month's to-assign; 'all' categories carry it as a negative balance instead).

Daily pace = truncDiv(leftToSpendCents, daysRemaining) with daysRemaining = daysInMonth − day + 1 (today counts; last day → 1). Plan from average = max(0, ceilDiv(Σ actual over counted months, countedMonths)) where the window ends at min(target−1, current−1) and months before the ledger's first transaction month are excluded from the divisor. Goal progress = starting + Σ(contributed − withdrawn) since the goal's start month (or the linked balance under basis 'balance'); contributed follows the lead's rule (categorized outflows + transfer inflows into the linked account), withdrawn (transfer outflows from the linked account + categorized inflows) is added so a withdrawal lowers progress and is added back to left to spend.

Every non-transfer transaction lands in exactly one bucket row: its category's row when the effective bucket matches, otherwise the synthetic "Other" row of the effective bucket (bucket_override, or uncategorized: + → income, − → spending). Bucket totals are the sum of their rows, so money never disappears.

## dataModel

All new tables in packages/db/src/schema/plan.ts (exported from schema/index.ts), migration 0001_phase2_plan.sql (partly hand-written: seed + backfill before NOT NULL and FKs). Money bigint cents. Months stored as `date` first-of-month with CHECK (month = date_trunc('month', month)::date), exposed as 'YYYY-MM' strings.

1. category_group (new; spec table)
- id uuid PK default gen_random_uuid()
- name text NOT NULL
- bucket text NOT NULL CHECK IN ('income','bills','savings','spending')
- position integer NOT NULL DEFAULT 0  -- order within the bucket header (addition: the grid needs a stable row order)
- hidden boolean NOT NULL DEFAULT false  -- effective hidden = group.hidden OR category.hidden
- created_at, updated_at timestamptz NOT NULL DEFAULT now()
- UNIQUE (bucket, name); UNIQUE CONSTRAINT category_group_id_bucket_uq (id, bucket) (a constraint, not an index, so it can be an FK target); INDEX (bucket, position)
Why: the spec's grid rows are "category groups under bucket headers", so a group belongs to exactly one bucket.

2. category (exists: id, name UNIQUE, bucket, hidden, created_at) — extended
- + group_id uuid NOT NULL (backfilled, then NOT NULL)
- bucket text NOT NULL (kept; Phase 1 code keeps reading it) — FOREIGN KEY (group_id, bucket) REFERENCES category_group (id, bucket) ON UPDATE CASCADE ON DELETE RESTRICT. Bucket therefore lives on BOTH, as a hard invariant: a category's bucket must equal its group's; changing a group's bucket cascades to its categories; moving a category to another bucket is one UPDATE that sets group_id and bucket together. No trigger, no drift.
- + position integer NOT NULL DEFAULT 0; INDEX (group_id, position)
- + rollover_mode text NOT NULL DEFAULT 'none' CHECK IN ('none','surplus','all')  -- 'surplus' = carry max(0, remaining); 'all' = carry remaining (may be negative). Forced 'none' for income categories (engine + API).
- + rollover_from_month date NULL CHECK first-of-month  -- the month this category's carry chain starts; NULL = plan_settings.start_month. Set by the service to the current month when the mode changes from 'none' to a carrying mode unless the client passes one; cleared when mode becomes 'none'. Prevents a newly enabled 'all' mode from importing months of unplanned spending as a negative carry.
- + UNIQUE CONSTRAINT category_id_bucket_uq (id, bucket)  -- target of savings_goal's composite FK
- name stays globally unique. DELETE refused (409 'in_use') when transactions, splits, month_plan rows or a goal reference it; UI offers hide or merge.
- Ordering everywhere: BUCKET_ORDER (income, bills, savings, spending), then group.position, group.name, then category.position, category.name; the synthetic "Other" row last in each bucket.

3. month_plan (new; spec table)
- id uuid PK default gen_random_uuid()
- category_id uuid NOT NULL REFERENCES category(id) ON DELETE CASCADE
- month date NOT NULL CHECK first-of-month
- planned_cents bigint NULL CHECK (planned_cents IS NULL OR planned_cents >= 0)  -- bucket-natural magnitude; NULL = no explicit plan, auto source applies
- planned_source text NULL CHECK IN ('manual','average','recurring','goal'); CHECK ((planned_cents IS NULL) = (planned_source IS NULL)). 'manual'/'average' are written by the user's actions; 'recurring'/'goal' rows are written only by plan.close_month (frozen history).
- rollover_mode text NULL CHECK IN ('none','surplus','all')  -- the spec's per-month "rollover mode": NULL = use category.rollover_mode; decides the carry OUT of this month
- carried_in_override_cents bigint NULL  -- the spec's "carried-in amount": NULL = computed by the chain; non-null pins this month's carried-in (seed an envelope, forgive/cover an overspend) and feeds the chain forward
- note text NULL
- updated_at timestamptz NOT NULL DEFAULT now()
- UNIQUE (category_id, month); INDEX (month)
- Invariants: the service deletes a row when every nullable column is NULL (no empty rows); rows for months < plan_settings.start_month are rejected (400); income categories reject rollover_mode and carried_in_override_cents (400).

4. plan_settings (new, singleton; addition) — the rollover chain, the zero-based chain and close_month need a defined origin; deriving it from data would move every carried-in whenever older history is imported.
- id boolean PK DEFAULT true CHECK (id)
- start_month date NOT NULL CHECK first-of-month (seeded with date_trunc('month', now()))
- zero_based boolean NOT NULL DEFAULT false  -- presentation toggle shared by the household: strip shows "to assign" instead of "left to spend"
- updated_at timestamptz

5. savings_goal (new; spec table + justified additions)
- id uuid PK
- name text NOT NULL
- category_id uuid NOT NULL UNIQUE REFERENCES category(id)  -- one goal per category (grid row = goal row)
- category_bucket text NOT NULL DEFAULT 'savings' CHECK (category_bucket = 'savings'), FOREIGN KEY (category_id, category_bucket) REFERENCES category (id, bucket) ON UPDATE CASCADE  -- a goal can only sit on a savings-bucket category; moving that category out of the savings bucket fails at the DB (the cascade would violate the CHECK)
- linked_account_id uuid NULL REFERENCES account(id) ON DELETE SET NULL
- target_cents bigint NOT NULL CHECK (target_cents > 0)
- target_date date NULL  (month granularity in the math: targetMonth = monthKey(target_date))
- starting_cents bigint NOT NULL DEFAULT 0  -- addition: money already saved when the goal is created
- start_month date NOT NULL CHECK first-of-month, default creation month  -- addition: contributions counted from here, so an existing account's history is not double counted with starting_cents
- monthly_contribution_cents bigint NOT NULL DEFAULT 0 CHECK (>= 0)  -- auto planned value for the category, source 'goal'
- progress_basis text NOT NULL DEFAULT 'contributions' CHECK IN ('contributions','balance')  -- addition: 'balance' uses the linked account's balance (interest/growth, direct spending from the account count); 'contributions' = starting + Σ(contributed − withdrawn)
- status text NOT NULL DEFAULT 'active' CHECK IN ('active','completed','archived')
- created_at, updated_at

6. plan_audit (new; spec "edits to plans ... keep history")
- id uuid PK, at timestamptz NOT NULL DEFAULT now(), user_id uuid NULL REFERENCES "user"(id)
- entity text NOT NULL CHECK IN ('month_plan','category','category_group','savings_goal','plan_settings'); entity_id uuid NOT NULL
- action text NOT NULL CHECK IN ('set','clear','fill_right','average','create','update','delete','reorder','close_month')
- before jsonb NULL, after jsonb NULL
- INDEX (entity, entity_id, at)

7. job.type / JobType (packages/shared/src/enums.ts) gains 'plan.close_month'.

8. Existing columns with semantics defined here:
- transaction.bucket_override: a non-transfer row whose override differs from its category's bucket (or an uncategorized row with an override) leaves the category row and is counted in the synthetic "Other" row of the override bucket (actual only). UpdateTransactionBody gains bucketOverride?: Bucket|null.
- split: actuals use split rows when present (COALESCE(split.category_id, t.category_id), COALESCE(split.amount_cents, t.amount_cents)); the ledger area must keep Σ split.amount_cents = transaction.amount_cents and set the parent's category_id NULL.
- transaction.is_transfer: excluded from every bucket row; the only transfer legs that count anywhere are those in a goal's linked account (goal flows).

9. Interface requirement on the recurring area (not owned here): `expectedOccurrences(db, from: MonthKey, to: MonthKey): Promise<Array<{recurringId, categoryId: string|null, date: IsoDate, expectedCents: bigint /* signed */}>>` — occurrences for PAST months too, stable once generated; none while paused or suggested; cancelled items only up to the cancellation date. Recommended implementation: a persisted `recurring_occurrence` table (recurring_id, due_date, expected_cents frozen at generation, status expected|paid|missed|skipped, transaction_id, UNIQUE(recurring_id, due_date)) generated 13 months ahead by the worker and never regenerated for past months. plan.close_month freezes planned values regardless, so the grid stays stable even if occurrences are generated on the fly.

Migration order: create category_group; seed four groups position 0 ('Income','income'), ('Bills & Subscriptions','bills'), ('Savings Goals','savings'), ('Spending','spending'); add category columns nullable; backfill group_id from the group with the same bucket and position by name order within the group; SET NOT NULL; add both unique constraints and the composite FK; add rollover columns; create month_plan, plan_settings (+ seed row), savings_goal, plan_audit. DEFAULT_CATEGORIES in services/categories.ts seeds groups first, then categories with positions.

## algorithm

Pure engine: packages/shared/src/plan.ts and packages/shared/src/months.ts (isomorphic, no DB, no clock; `today` is an input). Persistence: packages/db/src/services/plan.ts, goals.ts, categoryGroups.ts. Integer rules: everything is bigint; the only divisions are truncDiv (daily pace), ceilDiv (plan from average, goal suggestions) and floor via BigInt '/' on non-negative operands (progress basis points); every divisor is > 0n and asserted.

--- months.ts ---
type MonthKey = string  // 'YYYY-MM'
monthKey(date: IsoDate): MonthKey                 // date.slice(0, 7)
monthKeyToDate(m: MonthKey): IsoDate              // m + '-01'
addMonths(m: MonthKey, n: number): MonthKey       // pure y/m arithmetic, no Date objects
monthDiff(a: MonthKey, b: MonthKey): number       // (yb−ya)*12 + (mb−ma)
monthRange(from: MonthKey, to: MonthKey): MonthKey[]   // inclusive ascending
daysInMonth(m: MonthKey): number                  // new Date(Date.UTC(y, mo, 0)).getUTCDate()
daysRemainingInMonth(today: IsoDate): number      // daysInMonth(monthKey(today)) − dayOfMonth(today) + 1 (today counts; last day → 1)
maxMonth(a, b), minMonth(a, b)                    // string comparison works for 'YYYY-MM'

--- plan.ts types ---
type Bucket = 'income'|'bills'|'savings'|'spending'; BUCKET_ORDER = ['income','bills','savings','spending']
type RolloverMode = 'none'|'surplus'|'all'
type PlannedSource = 'manual'|'average'|'recurring'|'goal'|'none'
interface PlanGroupInput { id; name; bucket: Bucket; position: number; hidden: boolean }
interface PlanCategoryInput { id; groupId; name; bucket: Bucket; position; hidden; rolloverMode: RolloverMode; rolloverFromMonth: MonthKey|null; goalId: string|null }
interface MonthPlanRowInput { month: MonthKey; categoryId; plannedCents: bigint|null; plannedSource: Exclude<PlannedSource,'none'>|null; rolloverMode: RolloverMode|null; carriedInOverrideCents: bigint|null }
interface ActualInput { month: MonthKey; categoryId: string|null; categoryBucket: Bucket|null; effectiveBucket: Bucket; signedCents: bigint; count: number }  // pre-aggregated by (month, category, effectiveBucket); transfers excluded; rows categorized to a goal category are NOT here (they arrive as goal flows)
interface GoalFlowInput { month: MonthKey; goalId; contributedCents: bigint; withdrawnCents: bigint }  // both ≥ 0n
interface AutoPlanInput { month: MonthKey; categoryId; cents: bigint; source: 'recurring'|'goal' }     // pre-aggregated per (month, category)
interface GoalInput { id; categoryId; targetCents; targetMonth: MonthKey|null; startingCents; startMonth: MonthKey; monthlyContributionCents; status; progressBasis: 'contributions'|'balance'; linkedAccountBalanceCents: bigint|null }
interface ComputePlanInput { startMonth: MonthKey; fromMonth; toMonth; today: IsoDate; groups; categories; rows; actuals; goalFlows; autoPlans; goals }
interface PlanCell { month; categoryId: string|null /* null = synthetic Other row */; bucket; plannedCents; plannedSource; hasExplicitPlan; carriedInCents; carriedInSource: 'start'|'chain'|'override'|'none'; availableCents; actualCents; withdrawnCents /* 0n unless goal */; remainingCents; overspendCents; committedCents; rolloverMode; rolloverOverridden; transactionCount }
interface BucketTotals { plannedCents; carriedInCents; actualCents; remainingCents; committedCents; otherActualCents }
interface MonthSummary { month; state: 'past'|'current'|'future'; buckets: Record<Bucket, BucketTotals>; uncategorizedCount: number; incomeExpectedCents; overspendCents; savingsWithdrawnCents; leftToSpendPlannedCents; leftToSpendCents; forgivenOverspendCents; priorToAssignCents; toAssignCents; pace: { daysRemaining: number; perDayCents: bigint }|null }
interface PlanResult { months: MonthSummary[]; cells: PlanCell[] }  // fromMonth..toMonth; cells for every category (hidden included) plus Other rows that are non-zero somewhere in the range

--- helpers ---
bucketSign(b: Bucket): 1n | -1n                 // income → 1n, else −1n
truncDiv(a: bigint, n: bigint): bigint          // assert n > 0n; BigInt '/' truncates toward zero: −72000n/19n = −3789n
ceilDiv(a: bigint, n: bigint): bigint           // assert n > 0n; q = a / n; return (a % n !== 0n && a > 0n) ? q + 1n : q   (ceil(−7/3) = −2)
maxBig, minBig, clampBig
carryOut(mode: RolloverMode, remaining: bigint): bigint   // none → 0n; surplus → max(0n, remaining); all → remaining
chainStart(c: PlanCategoryInput, startMonth): MonthKey    // maxMonth(startMonth, c.rolloverFromMonth ?? startMonth)
effectiveRollover(c, row, m, startMonth): RolloverMode    // c.bucket === 'income' || m < chainStart(c) ? 'none' : row?.rolloverMode ?? c.rolloverMode
effectivePlanned(row, auto): { cents; source }            // row?.plannedCents != null → (row.plannedCents, row.plannedSource); else auto ? (auto.cents, auto.source) : (0n, 'none')
monthState(m, currentMonth): 'past'|'current'|'future'
dailyPace(leftToSpendCents: bigint, today: IsoDate): { daysRemaining; perDayCents }   // perDayCents = truncDiv(left, BigInt(daysRemaining)); negative left → negative deficit per day
averageWindow(target: MonthKey, current: MonthKey, n: 3|6|12): { from; to }   // to = minMonth(addMonths(target, −1), addMonths(current, −1)); from = addMonths(to, −(n−1))
planFromAverage(actualByMonth: ReadonlyMap<MonthKey,bigint>, window, dataStartMonth: MonthKey|null): { cents; sumCents; countedMonths; from; to } | null
goalProgress(goal: GoalInput, flows: GoalFlowInput[], plannedCurrentCents: bigint, currentMonth: MonthKey): GoalProgress
fillRight(source: { categoryId; month; plannedCents }, throughMonth): Array<{ categoryId; month; plannedCents; plannedSource: 'manual' }>   // one write per month in (month, throughMonth]
computePlan(input: ComputePlanInput): PlanResult

--- computePlan, step by step ---
1. Guard: startMonth ≤ fromMonth ≤ toMonth, else throw. currentMonth = monthKey(today). M = monthRange(startMonth, toMonth) (chain months); V = monthRange(fromMonth, toMonth) (visible).
2. Index inputs: rowsBy[(m,cat)], autoBy[(m,cat)], goalFlowBy[(m,goalId)], actualsBy[(m,cat)] for entries with categoryId non-null and effectiveBucket === categoryBucket (signed sum, count), otherBy[(m,effectiveBucket)] for every other entry (override differs, or categoryId null), uncategorizedCount[m] for categoryId null.
3. For each category c (every bucket, hidden or not), fold m over M, carrying carryOutPrev (starts 0n):
   a. (plannedCents, plannedSource) = effectivePlanned(rowsBy[(m,c)], autoBy[(m,c)]); hasExplicitPlan = row?.plannedCents != null.
   b. mode = effectiveRollover(c, row, m, startMonth).
   c. carriedIn: if c.bucket === 'income' → (0n, 'none'); else if row?.carriedInOverrideCents != null → (override, 'override'); else if m === chainStart(c) → (0n, 'start'); else if m < chainStart(c) → (0n, 'none'); else → (carryOutPrev, 'chain').
   d. actual: if c.goalId → flow = goalFlowBy[(m, goalId)]; actualCents = flow?.contributedCents ?? 0n; withdrawnCents = flow?.withdrawnCents ?? 0n. Else actualCents = bucketSign(c.bucket) × (actualsBy[(m,c)]?.signedCents ?? 0n); withdrawnCents = 0n.
   e. availableCents = plannedCents + carriedInCents; remainingCents = availableCents − actualCents.
   f. overspendCents = c.bucket === 'income' ? 0n : max(0n, −remainingCents).
   g. committedCents = c.bucket === 'income' ? max(plannedCents, actualCents) : plannedCents + min(carriedInCents, 0n) + overspendCents.   // = max(planned + min(ci,0), actual − max(ci,0)); surplus carried in is never charged again; an overspend carried in was charged in the month it happened
   h. carryOutPrev = carryOut(mode, remainingCents) (income: 0n).
   i. Emit the cell when m ∈ V. Remember per (m,c): plannedCents, forgiven = (c.bucket !== 'income' && mode !== 'all') ? overspendCents : 0n, income actual.
4. Synthetic Other rows: for each (m, bucket) with otherBy entries: cell { categoryId: null, bucket, plannedCents 0n, plannedSource 'none', carriedIn 0n ('none'), actualCents = bucketSign(bucket) × signed sum, remaining = −actual, overspend = bucket === 'income' ? 0n : max(0n, actual), committedCents = bucket === 'income' ? 0n : actualCents, rolloverMode 'none', transactionCount }. Emitted only when non-zero in some visible month.
5. For each m ∈ M build the summary (emit when m ∈ V):
   - buckets[b]: Σ planned, Σ carriedIn, Σ actual (categories + Other), Σ remaining, Σ committed (categories + Other), otherActualCents.
   - incomeExpectedCents = Σ_{income categories} max(planned, actual) + otherActual(income).
   - overspendCents = Σ overspend over outflow categories; savingsWithdrawnCents = Σ withdrawn over goal categories.
   - leftToSpendPlannedCents = planned(income) − planned(bills) − planned(savings) − planned(spending).
   - leftToSpendCents = incomeExpectedCents + savingsWithdrawnCents − committed(bills) − committed(savings) − committed(spending)   (committed totals include the Other rows). Identity: leftToSpend = leftToSpendPlanned + (incomeExpected − incomePlanned) − Σ overspend − Σ_{outflow categories} min(carriedIn, 0) − Σ otherActual(outflow) + savingsWithdrawn; with no activity the two coincide.
   - zero-based chain: priorToAssignCents = (m === startMonth) ? 0n : toAssign(m−1) − forgivenOverspend(m−1); toAssignCents = priorToAssign + incomeActual(m) (Σ actual of income categories + otherActual(income)) − (planned(bills) + planned(savings) + planned(spending)). forgivenOverspendCents(m) = Σ forgiven from 3i + Σ otherActual over outflow buckets (unplanned spending in Other rows behaves like a 'none' category with planned 0).
   - pace = state === 'current' ? dailyPace(leftToSpendCents, today) : null.
6. Return { months, cells }. Pure and deterministic; hidden categories are included (the UI filters) so totals never lose money.

--- Plan from average ---
window = averageWindow(target, current, n). countedMonths = months in [from..to] with m ≥ dataStartMonth (dataStartMonth = month of the earliest non-transfer transaction in the whole ledger, null when the ledger is empty). A counted month with no transactions in the category contributes 0n; months before any ledger data are excluded from the divisor (a 12-month average over 2 months of history divides by 2). countedMonths = 0 → null (API 409 'no_history'). cents = max(0n, ceilDiv(Σ actual over counted months, BigInt(countedMonths))): ceiling so the plan never under-covers the average; clamped at 0 because planned is a magnitude. Actuals are the cells' bucket-natural actualCents (contributed for goal categories). The service writes the row with planned_source 'average' (dryRun returns the preview only).

--- Fill right ---
fillRight copies the source cell's EFFECTIVE plannedCents (what the user sees, whatever its source) as planned_source 'manual' into every month in (month, throughMonth]; other columns untouched; months ≤ source untouched; idempotent upsert; one plan_audit row per changed month. throughMonth > month required; the UI confirms when the source is recurring/goal because the copy will override auto values.

--- Set cell (setPlanCell(db, month, categoryId, patch, userId)) ---
patch.plannedCents: bigint ≥ 0n → planned_source 'manual'; null → clear (auto value returns). patch.rolloverMode: mode or null (clear override). patch.carriedInOverrideCents: bigint or null. patch.note. Income category + rollover/carried-in → 400 'income_no_rollover'. month < start_month → 400 'before_plan_start'. Upsert on (category_id, month); delete the row when every nullable column ends up NULL. Writes plan_audit before/after.

--- Rollover settings (setCategoryRollover(db, id, mode, fromMonth?, today)) ---
mode 'none' → rollover_mode 'none', rollover_from_month NULL. Carrying mode → rollover_mode = mode, rollover_from_month = fromMonth ?? (previous mode was 'none' ? monthKey(today) : keep existing ?? monthKey(today)); fromMonth < start_month → 400. Income category → 400 'income_no_rollover'.

--- Auto plans (autoPlans(db, from, to): AutoPlanInput[]) ---
recurring: occurrences from the recurring area in [from, to] whose category is in bucket 'bills' or 'income' and whose status ≠ 'skipped', grouped by (month, categoryId): cents = Σ |expectedCents|, source 'recurring'. Items in spending/savings categories never auto-plan (spending is manual/average; savings comes from goals).
goal: for each active goal, for every m with goal.startMonth ≤ m ≤ (goal.targetMonth ?? ∞) and monthly_contribution_cents > 0: { categoryId, cents: monthly_contribution_cents, source 'goal' }.
Computed for past months too (used only where close_month has not frozen a row yet, so a missed night never blanks a month).

--- Actuals (monthlyActuals(db, from, toExclusive): ActualInput[]) ---
WITH lines AS (SELECT t.id, t.date, t.account_id, t.bucket_override, COALESCE(s.category_id, t.category_id) AS category_id, COALESCE(s.amount_cents, t.amount_cents) AS amount_cents FROM "transaction" t LEFT JOIN split s ON s.transaction_id = t.id WHERE t.is_transfer = false AND t.date >= :from AND t.date < :toExclusive)
SELECT substr(l.date::text, 1, 7) AS month, l.category_id, c.bucket AS category_bucket, COALESCE(l.bucket_override, c.bucket, CASE WHEN l.amount_cents > 0 THEN 'income' ELSE 'spending' END) AS effective_bucket, SUM(l.amount_cents) AS signed_cents, COUNT(*) AS n FROM lines l LEFT JOIN category c ON c.id = l.category_id WHERE l.category_id IS NULL OR l.category_id NOT IN (SELECT category_id FROM savings_goal) GROUP BY 1, 2, 3, 4.
Pending rows are included (a pending charge is committed money; pending→posted replaces in place so nothing double counts). Rows categorized to a goal category are excluded here and delivered by goalFlows so they count once. dataStartMonth = SELECT substr(min(date)::text,1,7) FROM "transaction" WHERE is_transfer = false.

--- Goal flows (goalFlows(db, goals, from, toExclusive): GoalFlowInput[]) ---
Per goal and month, bucket_override ignored:
contributed = Σ max(0n, −amount) over non-transfer rows (splits expanded) categorized to the goal's category + Σ amount over rows in linked_account_id with is_transfer AND amount > 0   (the lead's rule).
withdrawn = Σ max(0n, amount) over non-transfer rows categorized to the goal's category + Σ (−amount) over rows in linked_account_id with is_transfer AND amount < 0.
Non-transfer rows inside the linked account (interest, fees, direct spending) belong to their own categories and do not touch progress under basis 'contributions'; basis 'balance' captures them. With no linked account only the categorized terms apply.

--- Goal progress (goalProgress) ---
contributedToDate = Σ_{goal.startMonth ≤ m ≤ currentMonth} contributed; withdrawnToDate likewise; savedCents = basis === 'balance' && linkedBalance != null ? linkedBalance : startingCents + contributedToDate − withdrawnToDate; remainingCents = max(0n, target − saved); progressBp = saved <= 0n ? 0 : Number(min(10000n, saved × 10000n / target)) (floor); monthsAfterCurrent = targetMonth ? max(0, monthDiff(currentMonth, targetMonth)) : null; currentShortfall = max(0n, plannedCurrentCents − contributed(currentMonth)); projectedAtTargetCents = monthsAfterCurrent == null ? null : saved + currentShortfall + monthly × BigInt(monthsAfterCurrent); onTrack = projectedAtTarget == null ? null : projectedAtTarget ≥ target; suggestedMonthlyCents = monthsAfterCurrent == null ? null : monthsAfterCurrent > 0 ? ceilDiv(max(0n, target − saved − currentShortfall), BigInt(monthsAfterCurrent)) : remainingCents; projectedCompletionMonth = remaining === 0n ? currentMonth : monthly > 0n ? addMonths(currentMonth, Number(ceilDiv(max(0n, remaining − currentShortfall), monthly))) : null. Invariant to whether this month's contribution has already happened.

--- close_month (worker job 'plan.close_month'; nightly 00:30 and on demand; idempotent) ---
closeMonth(db, throughMonth = previous month): for each m in [start_month, throughMonth] and each category whose effectivePlanned source is 'recurring' or 'goal' and whose month_plan row has planned_cents NULL (or no row): INSERT (month, category_id, planned_cents, planned_source) ON CONFLICT (category_id, month) DO UPDATE SET planned_cents = EXCLUDED.planned_cents, planned_source = EXCLUDED.planned_source WHERE month_plan.planned_cents IS NULL. Returns the inserted count; re-runs insert 0; never touches manual/average rows. Dispatched in apps/worker/src/jobs/index.ts; the scheduler enqueues it daily with dedupe and on the first tick of a new month; the API enqueues it when plan_settings.start_month moves earlier.

--- Read path (getPlanGrid(db, { from, to, today })) ---
Load settings, groups, categories (+goalId), rows in [start_month, to], monthlyActuals in [start_month, to], goalFlows in [start_month, to], autoPlans in [start_month, to], goals with linked balances → computePlan. Default range from = current − 2, to = current + 3; to − from ≤ 24 months. `today` comes from the client (its local calendar date) with the server's UTC date as fallback; months are plain strings so there is no timezone arithmetic. The dashboard card calls the same service over [current, current].

## api

Cents travel as CentsString (decimal integer strings); NonNegCentsString = /^\d+$/; MonthKeyString = /^\d{4}-(0[1-9]|1[0-2])$/. Zod contracts in packages/shared/src/api.ts (section "Plan"); enums RolloverMode (none|surplus|all), PlannedSource (manual|average|recurring|goal|none), ProgressBasis (contributions|balance), GoalStatus in enums.ts.

Views: PlanSettingsView {startMonth, zeroBased, updatedAt}; PlanCellView {month, categoryId: uuid|null, bucket, plannedCents, plannedSource, hasExplicitPlan, carriedInCents, carriedInSource ('start'|'chain'|'override'|'none'), availableCents, actualCents, withdrawnCents, remainingCents, overspendCents, committedCents, rolloverMode, rolloverOverridden, transactionCount: int}; BucketTotalsView {plannedCents, carriedInCents, actualCents, remainingCents, committedCents, otherActualCents}; PaceView {daysRemaining: int, perDayCents}; MonthSummaryView {month, state, buckets: {income, bills, savings, spending}, uncategorizedCount: int, incomeExpectedCents, overspendCents, savingsWithdrawnCents, leftToSpendPlannedCents, leftToSpendCents, forgivenOverspendCents, priorToAssignCents, toAssignCents, pace: PaceView|null}; CategoryGroupView {id, name, bucket, position, hidden}; CategoryView (extended) {id, name, bucket, groupId, position, hidden, rolloverMode, rolloverFromMonth: MonthKeyString|null, goalId: uuid|null}; PlanGridResponse {settings, currentMonth, groups: CategoryGroupView[], categories: CategoryView[], months: MonthSummaryView[], cells: PlanCellView[]}.
Bodies: PlanQuery {from?, to?, today?: IsoDateString}; UpdatePlanSettingsBody {startMonth?, zeroBased?}; PlanCellParams {month, categoryId: uuid}; SetPlanCellBody {plannedCents?: NonNegCentsString|null, rolloverMode?: RolloverMode|null, carriedInOverrideCents?: CentsString|null, note?: string|null} (at least one key); FillRightBody {month, categoryId, throughMonth} (throughMonth > month); FillRightResponse {months: MonthKeyString[]}; PlanFromAverageBody {month, categoryId, months: z.union([z.literal(3), z.literal(6), z.literal(12)]), dryRun?: boolean}; PlanFromAverageResponse {cents, sumCents, countedMonths: int, from, to, applied: boolean}; CloseMonthBody {month?: MonthKeyString}; CloseMonthResponse {inserted: int}; CreateCategoryGroupBody {name: 1..100, bucket}; UpdateCategoryGroupBody {name?, bucket?, hidden?, position?}; ReorderCategoryGroupsBody {bucket, ids: uuid[]}; DeleteCategoryGroupQuery {moveTo?: uuid}; CreateCategoryBody (extended) {name, groupId?: uuid, bucket?: Bucket} (groupId wins; legacy bucket → first group of that bucket); UpdateCategoryBody (extended) {name?, groupId?, bucket?, hidden?, position?, rolloverMode?, rolloverFromMonth?: MonthKeyString|null} (groupId sets bucket atomically; bucket alone moves to that bucket's first group); ReorderCategoriesBody {groupId, ids}; SavingsGoalView {id, name, categoryId, categoryName, linkedAccountId, linkedAccountName, targetCents, targetDate, targetMonth, startingCents, startMonth, monthlyContributionCents, progressBasis, status, progress: {savedCents, contributedToDateCents, withdrawnToDateCents, remainingCents, progressBp: int, monthsAfterCurrent: int|null, projectedAtTargetCents: CentsString|null, onTrack: boolean|null, suggestedMonthlyCents: CentsString|null, projectedCompletionMonth: MonthKeyString|null, linkedBalanceCents: CentsString|null}, history: [{month, contributedCents, withdrawnCents, plannedCents}]}; CreateSavingsGoalBody {name, categoryId?: uuid | newCategory?: {name, groupId?}, linkedAccountId?: uuid|null, targetCents: NonNegCentsString (> 0), targetDate?: IsoDateString|null, startingCents?: CentsString, startMonth?: MonthKeyString (default current), monthlyContributionCents?: NonNegCentsString, progressBasis?}; UpdateSavingsGoalBody {same fields optional + status?}.

Endpoints (apps/api/src/routes/plan.ts, categoryGroups.ts, goals.ts; all behind auth; viewer role read-only, owner writes):
- GET /api/plan?from&to&today → PlanGridResponse (grid, strip, zero-based line). 400 when from > to or range > 24 months.
- GET /api/plan/summary?month&today → MonthSummaryView (dashboard card: leftToSpendCents + pace).
- GET /api/plan/settings → PlanSettingsView; PATCH /api/plan/settings UpdatePlanSettingsBody → PlanSettingsView (startMonth moved earlier enqueues plan.close_month).
- PUT /api/plan/cells/:month/:categoryId SetPlanCellBody → {cell: PlanCellView, months: MonthSummaryView[]} for [month .. month+3]; 400 'before_plan_start', 400 'income_no_rollover', 400 empty body; 404 unknown category.
- DELETE /api/plan/cells/:month/:categoryId → OkResponse (clears plan, rollover override, carried-in override, note; row removed).
- POST /api/plan/fill-right FillRightBody → FillRightResponse.
- POST /api/plan/average PlanFromAverageBody → PlanFromAverageResponse (409 'no_history' when countedMonths = 0; dryRun never writes).
- GET /api/plan/cells/:month/:categoryId/transactions?cursor → TransactionList (drill-in): non-goal category → category_id = c (splits expanded), date in month, is_transfer = false, effective bucket = category bucket; goal category → union of transfer legs in the linked account and non-transfer rows categorized to the category; GET /api/plan/other/:month/:bucket/transactions → the Other row's rows.
- POST /api/plan/close-month CloseMonthBody → CloseMonthResponse (owner only; same code the worker job runs).
- GET /api/category-groups; POST; PATCH /:id; DELETE /:id?moveTo (409 'not_empty' without moveTo when the group has categories); POST /api/category-groups/reorder.
- GET /api/categories (extended view, ordered by bucket, group.position, category.position, name); POST; PATCH /:id (400 'income_no_rollover'; 409 'goal_category' when a bucket change would move a goal's category out of savings, surfaced from the DB CHECK); POST /api/categories/reorder; DELETE /:id (409 'in_use').
- GET /api/goals?today → SavingsGoalView[]; POST; GET /:id; PATCH /:id; DELETE /:id (archives; ?hard=true deletes only when there is no history; the category and its plan rows remain).
- PATCH /api/transactions/:id: UpdateTransactionBody gains bucketOverride?: Bucket|null.
- Worker: job type 'plan.close_month' → closeMonth(ctx.db, addMonths(monthKey(ctx.today()), −1)).

Web (apps/web/src/pages/PlanPage.tsx): virtualized grid over PlanGridResponse (rows: groups under bucket headers, Other row last per bucket, hidden rows collapsed unless showHidden or non-zero in range; columns: months; compact mode shows remaining only); cells call PUT; strip shows leftToSpendCents, or toAssignCents when settings.zeroBased, warning colour when < 0n; pace string "$X/day for the next N days" from pace; "+$ in" note from carriedInCents ≠ 0n; overspend highlight from overspendCents > 0n. Dashboard card reads GET /api/plan/summary. ECharts is not needed in this area.

## edgeCases

- Sign conventions: transaction amounts stay signed (income +, outflow −); planned/actual/remaining are bucket-natural (actual = bucketSign × Σ signed), converted exactly once in computePlan step 3d. A refund in a spending category (+500) lowers that category's actual; a paycheck reversal (−10000) lowers income actual.
- Transfers (is_transfer) never enter any bucket row, including one-legged transfers set by a rule and credit-card payments; the only transfer legs that count anywhere are those in a goal's linked account (goal flows), and rows categorized to a goal category are excluded from monthlyActuals so they count once.
- Month with no plan row: planned = auto value or 0 ('none'); actual still counts; remaining = carriedIn − actual; committed = actual beyond the envelope (all of it when carried-in is 0), so unplanned spending hits left to spend in full. Carried-in flows through a row-less month unchanged (Groceries Nov: available 8155 with no row).
- Chain start: carriedIn(plan_settings.start_month) = override ?? 0; rows before start_month are rejected; a category's own rollover_from_month (set to the current month when a carrying mode is first enabled) makes earlier months behave as 'none' so history is never imported as a negative carry; moving start_month later restarts every chain, moving it earlier includes more history and enqueues close_month.
- Income categories never carry (mode forced 'none', override ignored by the engine, rejected by the API); remaining for income means 'still expected'; incomeExpected uses max(planned, actual) per category so a bonus raises left to spend while an unpaid second paycheck is still expected.
- Overspend in a 'none' or 'surplus' category is forgiven at the category level (carry 0) but charged to that month's left to spend (committed = planned + overspend) and to the zero-based chain (forgivenOverspend reduces next month's to-assign). In an 'all' category it is charged to that month's left to spend once, carried as negative carried-in, and the next month's committed is reduced by the same amount (planned + min(carriedIn, 0)) so it is never charged twice; the zero-based chain does not forgive it (Actual's behaviour: the next month's assignment repays it).
- Carried-in surplus is never charged to left to spend (it was funded by an earlier month's income); a refund larger than the month's spending makes actual negative and remaining exceed available without raising left to spend; the surplus rolls if the mode carries it.
- Carried-in override applies to that month only and feeds forward; clearing it (null) returns the chain; an override on the start month seeds an envelope; an override on an income category is rejected.
- Per-month rollover override (month_plan.rollover_mode) decides the carry OUT of that month only.
- Quarterly/annual recurring items plan only in the month of each occurrence (Water: Aug 9000, Sep 0, Oct 0, Nov 9000, Feb 9000); two occurrences in one month sum; a manual value replaces (never adds to) the auto value for that month only; clearing the cell restores the auto value.
- Recurring items whose category is in spending or savings never auto-plan; paused/suggested/cancelled items contribute no new occurrences; past occurrences plus close_month rows keep history stable after a cancel or price change.
- close_month is idempotent (ON CONFLICT ... WHERE planned_cents IS NULL), never overwrites manual/average rows, inserts 0 on a re-run, and catches up a missed night because it scans every completed month since start_month.
- Plan from average: window ends at min(target−1, current−1) so a partial current month never drags the average down; months before the ledger's first transaction month are excluded from the divisor; counted months with no transactions in the category count as 0; ceilDiv then clamp at 0 (net refunds → 0); 0 counted months → 409 no_history; the result is written as a frozen 'average' row, not kept live.
- Fill right copies the effective (displayed) value as 'manual' into later months only and overrides auto recurring/goal values there (UI confirms when the source cell is recurring/goal); idempotent.
- Daily pace: daysRemaining = daysInMonth − day + 1 (today included); last day → 1 so the pace equals the whole remaining amount; Feb in leap years (2028-02-29 → 1, 2028-02-01 → 29); pace only for the current month; truncation toward zero never promises more than exists; negative left to spend gives a negative deficit per day with a slightly smaller magnitude, never larger.
- Left to spend negative: leftToSpendPlanned < 0 when planned outflows exceed planned income (over-planned); leftToSpend < 0 when overspending/unplanned spending exceeds income; the strip warns on the number it displays (leftToSpend, or toAssign in zero-based mode).
- Uncategorized non-transfer rows land in the Other row of income (amount > 0) or spending (amount < 0); they reduce or raise left to spend in full, count in bucket totals and in the zero-based chain (as unplanned spending / received income), and are surfaced as a review item via uncategorizedCount.
- bucket_override: a row whose override differs from its category's bucket leaves the category row and lands in the override bucket's Other row (actual only); bucket totals still equal the sum of their rows; an override on an uncategorized row also lands in that Other row.
- Splits: actuals use split rows when present (COALESCE); the parent's category must be NULL and splits must sum to the parent (ledger-area invariant); a split with a null category goes to the Other row.
- Pending transactions count in actual; pending→posted replacement keeps the row id so there is no double count; pending rows removed by sync drop out on the next read (nothing is stored).
- Future-dated manual transactions count in their month's actual, so a future month can have actual ≠ 0 and leftToSpend ≠ leftToSpendPlanned.
- Hidden categories and hidden groups stay in the chain, bucket totals, left to spend and to-assign (money never disappears); the UI collapses them unless they are non-zero in the visible range.
- Changing a category's group across buckets rewrites history (its actuals move buckets in every month, its chain is recomputed under the new bucket's sign); the DB refuses it for a goal's category (composite FK + CHECK) and the UI warns; deleting a category with transactions/plans/goal is refused (409 'in_use').
- Goal flows: money moved into the linked account and straight back out in the same month nets to zero progress (contributed 30000, withdrawn 30000); spending funded by a goal withdrawal leaves left to spend unchanged because withdrawn is added back; interest or direct spending inside the linked account does not touch progress under basis 'contributions' (use basis 'balance' for that).
- Goal auto-planned contribution stops after the target month (2027-05 → 30000 'goal'; 2027-06 → 0 'none'); goal with no target date: monthsAfterCurrent, suggested, projectedAtTarget and onTrack are null; contribution 0 with remaining > 0 → projectedCompletionMonth null; goal already reached: remaining 0, progressBp 10000, projectedCompletionMonth = current month; suggestions are invariant to whether this month's contribution has already posted (currentShortfall term).
- Range guard: to − from ≤ 24 months, from ≤ to; computePlan always folds from start_month regardless of `from`, so carried-in for the first visible month is correct; a range entirely in the past or future has pace null everywhere.
- Idempotency: computePlan is pure; setPlanCell/fillRight are upserts; planFromAverage writes the same value for the same window; close_month is insert-if-missing; a re-synced or re-categorized transaction changes every later carried-in on the next read with no job.
- Integer division: only truncDiv (pace), ceilDiv (average, goal suggestions, projected completion) and floor on non-negative operands (progress bp) exist; divisors are asserted > 0n; BigInt '/' truncates toward zero (−72000n / 19n = −3789n).
- `today` is the client's local calendar date with the server's UTC date as fallback; a skewed clock shifts only that client's pace and month state; nothing derived from it is persisted.
- Empty install: no rows, no occurrences, no goals, no transactions → every cell 0/'none', no Other rows, totals 0, leftToSpend 0, toAssign 0, pace {perDayCents 0, daysRemaining n} for the current month.

## testCases

### F0 Fixture F (shared by the computePlan tests)
INPUT: plan_settings.start_month = 2026-08, today = 2026-10-13 (current 2026-10). Groups: Income / Bills & Subscriptions / Savings Goals / Spending. Categories (bucket, rollover_mode, rollover_from_month null): Paycheck (income, none), Rent (bills, none), Electric (bills, none), Water (bills, none), Vacation (savings, none; goal G), Groceries (spending, surplus), Dining (spending, all), Fuel (spending, none), Pets (spending, none), Travel (spending, none). Goal G: category Vacation, linked account SAV, target 600000, target_date 2027-05-31, starting 100000, start_month 2026-08, monthly 30000, active, basis contributions. Recurring occurrences: Paycheck +250000 on the 1st and 15th of every month Aug 2026–Jan 2027; Rent −150000 on the 1st monthly; Electric −12000 on the 10th monthly; Water −9000 on 2026-08-15, 2026-11-15, 2027-02-15. month_plan manual rows: Paycheck Aug/Sep/Oct 500000; Groceries Aug/Sep/Oct 40000; Dining Aug/Sep/Oct 20000; Fuel Aug/Sep/Oct 15000. Transactions (account CHK unless noted, signed cents, non-transfer unless noted): Aug: +250000 Paycheck 08-01, +250000 Paycheck 08-15, −150000 Rent, −11000 Electric, −9000 Water 08-15, −30000 Groceries, −20000 Dining, −9000 Fuel, −7000 Pets, transfer CHK→SAV 30000 on 08-02 (CHK −30000, SAV +30000, both is_transfer). Sep: +250000 Paycheck 09-01, +250000 Paycheck 09-15, −10000 Paycheck 09-16 (reversal), −150000 Rent, −13500 Electric, −12345 Groceries, −20000 Groceries, +500 Groceries (refund), −25000 Dining, −9000 Fuel, −2500 uncategorized 09-20, transfer CHK→SAV 30000 on 09-02. Oct (≤ 10-13): +250000 Paycheck 10-01, −150000 Rent, −35000 Groceries, −15000 Groceries, −5000 Groceries with bucket_override 'bills' 10-05, −10000 Dining, −4000 Fuel, transfer CHK→SAV 30000 on 10-02, credit-card payment CHK −80000 / CC +80000 on 10-09 (is_transfer pair). Nov and later: no transactions.
EXPECTED: Aug cells (planned/source | carriedIn | actual | remaining | committed): Paycheck 500000/manual | 0 | 500000 | 0 | 500000; Rent 150000/recurring | 0 | 150000 | 0 | 150000; Electric 12000/recurring | 0 | 11000 | 1000 | 12000; Water 9000/recurring | 0 | 9000 | 0 | 9000; Vacation 30000/goal | 0 | 30000 | 0 | 30000; Groceries 40000/manual | 0 | 30000 | 10000 | 40000; Dining 20000/manual | 0 | 20000 | 0 | 20000; Fuel 15000/manual | 0 | 9000 | 6000 | 15000; Pets 0/none | 0 | 7000 | −7000 | 7000 (overspend 7000); Travel 0/none | 0 | 0 | 0 | 0. Aug bucket planned: income 500000, bills 171000, savings 30000, spending 75000. Aug leftToSpendPlanned = 500000 − 171000 − 30000 − 75000 = 224000; committed bills 171000, savings 30000, spending 40000+20000+15000+7000 = 82000; leftToSpend = 500000 − 171000 − 30000 − 82000 = 217000 (= 224000 − 7000 overspend).

### T1 Sign convention: spending refund lowers actual, income reversal lowers income
INPUT: Fixture F, Sep: Groceries signed −12345, −20000, +500; Paycheck signed +250000, +250000, −10000.
EXPECTED: Groceries signed sum −31845 → actualCents 31845 (bucketSign −1), transactionCount 3. Paycheck signed sum 490000 → actualCents 490000 (bucketSign +1); remaining = 500000 − 490000 = 10000 (still expected), overspend 0, committed = max(500000, 490000) = 500000.

### T2 Surplus-only carry chains across three months and through a row-less month
INPUT: Fixture F, Groceries (surplus), Aug → Nov.
EXPECTED: Aug: available 40000, actual 30000, remaining 10000, carryOut 10000. Sep: carriedIn 10000 ('chain'), available 50000, actual 31845, remaining 18155, committed 40000, carryOut 18155. Oct: carriedIn 18155, available 58155, actual 50000 (the −5000 override row excluded), remaining 8155, committed 40000. Nov: carriedIn 8155, planned 0/'none' (no row), available 8155, actual 0, remaining 8155, committed 0.

### T3 Overspend carry ('all') goes negative, is charged once, and is not forgiven in the zero-based chain
INPUT: Fixture F, Dining (all), Sep → Nov.
EXPECTED: Sep: available 20000, actual 25000, remaining −5000, overspend 5000, committed 25000, carryOut −5000, forgiven 0. Oct: carriedIn −5000 ('chain'), available 15000, actual 10000, remaining 5000, overspend 0, committed = 20000 + min(−5000, 0) + 0 = 15000, carryOut 5000. Nov: carriedIn 5000, available 5000, committed 0. Over Sep+Oct the Dining charge to left to spend totals 25000 + 15000 = 40000 = 2 × planned.

### T4 Rollover 'none' drops the surplus
INPUT: Fixture F, Fuel (none): Aug remaining 6000, Sep remaining 6000.
EXPECTED: Sep carriedIn 0 and Oct carriedIn 0 (carryOut(none, 6000) = 0); Oct: available 15000, actual 4000, remaining 11000, committed 15000.

### T5 Month with no plan row: unplanned spending is fully committed and forgiven
INPUT: Fixture F, Pets Aug (no row, actual −7000, mode none).
EXPECTED: plannedCents 0, plannedSource 'none', hasExplicitPlan false, carriedIn 0 ('start'), available 0, actual 7000, remaining −7000, overspend 7000, committed 7000, carryOut 0; Aug forgivenOverspendCents = 7000; Sep Pets carriedIn 0.

### T6 Surplus-only with an overrun beyond the envelope forgives the overrun
INPUT: Fixture F plus an extra Oct Groceries transaction −9000 (actual becomes 59000).
EXPECTED: Oct Groceries: available 58155, actual 59000, remaining −845, overspend 845, committed = 40000 + 0 + 845 = 40845, carryOut max(0, −845) = 0 → Nov carriedIn 0, Nov available 0. Oct forgivenOverspendCents = 845; Oct leftToSpendCents = 233000 − 845 = 232155.

### T7 Carried-in override replaces the chain value and feeds forward
INPUT: Fixture F plus month_plan row Dining 2026-10 {carried_in_override_cents: 0}.
EXPECTED: Oct Dining carriedIn 0 (carriedInSource 'override'), available 20000, actual 10000, remaining 10000, committed 20000, carryOut 10000; Nov Dining carriedIn 10000 ('chain'). Oct leftToSpendCents becomes 500000 − 167000 − 30000 − (40000 + 20000 + 15000) = 228000. Without the override: −5000 / 5000 / 5000 and committed 15000.

### T8 Start-month override seeds an envelope; surplus carried in is never charged
INPUT: Fixture F plus Groceries 2026-08 {carried_in_override_cents: 25000}.
EXPECTED: Aug Groceries carriedIn 25000 ('override'), available 65000, actual 30000, remaining 35000, committed 40000 (unchanged) → Sep carriedIn 35000, available 75000, remaining 43155 → Oct carriedIn 43155, available 83155, remaining 33155. Aug/Sep/Oct leftToSpendCents unchanged (217000 / 224000 / 233000).

### T9 Quarterly bill lands only in its month; manual override wins; reset restores auto; goal contribution stops after the target month
INPUT: Fixture F, Water, Rent and Vacation, months Aug 2026–Jun 2027; then PUT /api/plan/cells/2026-11/Rent {plannedCents:'152000'}; then DELETE that cell.
EXPECTED: Water planned: Aug 9000 recurring, Sep 0 none, Oct 0 none, Nov 9000 recurring, Dec 0, Jan 0, Feb 2027 9000 recurring. Bills planned: Oct 150000+12000+0 = 162000; Nov 150000+12000+9000 = 171000. After the manual Rent row: Nov Rent 152000 'manual', hasExplicitPlan true, Nov bills planned 173000. After DELETE: Nov Rent 150000 'recurring', bills 171000. Vacation: 2027-05 30000 'goal'; 2027-06 0 'none'.

### T10 Month summary for a completed month (Sep): planned vs actual-aware left to spend, overspend, Other row
INPUT: Fixture F, month 2026-09.
EXPECTED: planned: income 500000, bills 162000 (Rent 150000 + Electric 12000 + Water 0), savings 30000, spending 75000 → leftToSpendPlannedCents = 500000 − 162000 − 30000 − 75000 = 233000. Other spending row: actual 2500 (the uncategorized −2500), committed 2500, uncategorizedCount 1. committed: bills 150000 + 13500 (Electric overspend 1500) + 0 = 163500; savings 30000; spending 40000 (Groceries) + 25000 (Dining) + 15000 (Fuel) + 0 + 0 + 2500 (Other) = 82500; incomeExpected max(500000, 490000) = 500000; savingsWithdrawn 0 → leftToSpendCents = 500000 − 163500 − 30000 − 82500 = 224000. overspendCents 6500 (1500 + 5000); forgivenOverspendCents 4000 (Electric 1500 + Other spending 2500; Dining is 'all'). Spending bucket actual 31845 + 25000 + 9000 + 2500 = 68345, otherActualCents 2500. Identity: 233000 − 6500 − 2500 = 224000. state 'past', pace null.

### T11 Current month (Oct): bucket override lands in the bills Other row, carry relief, pace
INPUT: Fixture F, month 2026-10, today 2026-10-13.
EXPECTED: Groceries actual 50000 (override row excluded); bills Other row actual 5000, committed 5000; bills bucket actual 150000 + 0 + 0 + 5000 = 155000, otherActualCents 5000. planned: income 500000, bills 162000, savings 30000, spending 75000 → leftToSpendPlannedCents 233000. committed: bills 150000 + 12000 (Electric unpaid, remaining 12000) + 0 + 5000 = 167000; savings 30000; spending 40000 + 15000 (Dining: planned 20000 + carriedIn −5000) + 15000 (Fuel) = 70000; incomeExpected max(500000, 250000) = 500000 → leftToSpendCents = 500000 − 167000 − 30000 − 70000 = 233000 (equals the planned number because the −5000 reassigned to bills and the +5000 Dining carry relief cancel). The credit-card transfer pair changes nothing. pace: daysRemaining = 31 − 13 + 1 = 19; perDayCents = truncDiv(233000, 19) = 12263 (19 × 12263 = 232997, remainder 3). state 'current'.

### T12 Pace on the last day of the month, February and leap years
INPUT: daysRemainingInMonth(today) and dailyPace(233000n, today) for today ∈ {2026-10-31, 2026-11-30, 2026-02-28, 2026-02-01, 2028-02-29, 2028-02-01}; dailyPace(123456n, '2026-10-13'); dailyPace(2900n, '2028-02-01').
EXPECTED: 2026-10-31 → daysRemaining 1, perDayCents 233000; 2026-11-30 → 1, 233000; 2026-02-28 → 1 (2026 is not a leap year), 233000; 2026-02-01 → 28, 233000/28 = 8321 (28 × 8321 = 232988); 2028-02-29 → 1, 233000; 2028-02-01 → 29, 233000/29 = 8034 (29 × 8034 = 232986). dailyPace(123456, 2026-10-13): daysRemaining 19, perDayCents 6497 (19 × 6497 = 123443 ≤ 123456 < 123462). dailyPace(2900, 2028-02-01): 29 days, perDayCents 100.

### T13 Left to spend negative (over-planned month) and negative pace
INPUT: Fixture F plus month_plan row Travel 2026-10 planned 300000 manual; today 2026-10-13.
EXPECTED: Oct spending planned 375000; leftToSpendPlannedCents = 500000 − 162000 − 30000 − 375000 = −67000; leftToSpendCents = 500000 − 167000 − 30000 − (40000 + 15000 + 15000 + 300000) = −67000 (strip warning); toAssignCents = 419000 − 300000 = 119000 (see T15); pace.perDayCents = truncDiv(−67000, 19) = −3526 (toward zero; 19 × 3526 = 66994 ≤ 67000 < 67013).

### T14 Future month with no activity: both left-to-spend numbers coincide; carried-in shown without rows
INPUT: Fixture F, month 2026-11 (no transactions, no rows).
EXPECTED: planned: Paycheck 500000 'recurring' (11-01 + 11-15), Rent 150000, Electric 12000, Water 9000 → bills 171000; Vacation 30000 'goal'; spending 0 → leftToSpendPlannedCents = 500000 − 171000 − 30000 − 0 = 299000; committed = planned for every outflow row (Groceries 0, Dining 0 since carriedIn 5000 ≥ 0), incomeExpected = max(500000, 0) = 500000 → leftToSpendCents = 299000. Groceries carriedIn 8155, available 8155; Dining carriedIn 5000; no Other rows; state 'future', pace null.

### T15 Zero-based to-assign chain (actual income, forgiven overspend incl. Other rows)
INPUT: Fixture F, months Aug–Nov.
EXPECTED: Aug: prior 0, incomeActual 500000, Σ planned(bills + savings + spending) = 171000 + 30000 + 75000 = 276000 → toAssign 224000; forgiven 7000 (Pets). Sep: prior = 224000 − 7000 = 217000; incomeActual 490000; Σ planned 162000 + 30000 + 75000 = 267000 → toAssign 440000; forgiven 1500 (Electric) + 2500 (Other spending) = 4000. Oct: prior = 440000 − 4000 = 436000; incomeActual 250000; Σ planned 267000 → toAssign 419000; forgiven 5000 (Other bills; Dining carries, nothing else overspent). Nov: prior = 419000 − 5000 = 414000; incomeActual 0; Σ planned 171000 + 30000 + 0 = 201000 → toAssign 213000.

### T16 Plan from average with months lacking data and months lacking transactions
INPUT: Fixture F (earliest non-transfer transaction 2026-08-01 → dataStartMonth 2026-08). POST /api/plan/average {month:'2026-11', categoryId: Groceries, months: 3}; again with months: 12; then {month:'2026-11', categoryId: Pets, months: 3}; then {month:'2026-11', categoryId: Travel, months: 3}; then a ledger whose dataStartMonth is 2026-10 with target 2026-10, months 3.
EXPECTED: n=3: window to = min(2026-10, 2026-09) = 2026-09, from = 2026-07; counted months Aug, Sep (Jul < dataStartMonth excluded) → sum 30000 + 31845 = 61845, countedMonths 2, cents = ceilDiv(61845, 2) = 30923 (61845/2 = 30922.5); row Nov Groceries 30923 'average'; Nov Groceries available 30923 + 8155 = 39078. n=12: window 2025-10..2026-09, counted still Aug + Sep → 30923. Pets: Aug 7000, Sep 0 (ledger data exists, no Pets rows) → ceilDiv(7000, 2) = 3500. Travel: 0 + 0 → 0 written as 'average'. dataStartMonth 2026-10, target 2026-10: window 2026-07..2026-09 has no counted months → null → HTTP 409 code 'no_history'. Net-refund case: actualByMonth {Aug: −1000, Sep: 0} → ceilDiv(−1000, 2) = −500 → clamped to 0.

### T17 ceilDiv and truncDiv rules
INPUT: ceilDiv(100001n,3n), ceilDiv(61845n,2n), ceilDiv(−7n,3n), ceilDiv(9n,3n), ceilDiv(0n,5n), ceilDiv(410000n,7n), ceilDiv(410000n,30000n), ceilDiv(650000n,12n); truncDiv(123456n,19n), truncDiv(−72000n,19n), truncDiv(233000n,19n), truncDiv(−67000n,19n), truncDiv(228000n,19n); ceilDiv(1n, 0n).
EXPECTED: 33334; 30923; −2; 3; 0; 58572 (58571 × 7 = 409997 < 410000); 14 (13 × 30000 = 390000 < 410000); 54167 (54166 × 12 = 649992 < 650000); 6497; −3789 (19 × 3789 = 71991); 12263; −3526; 12000 (exact); throws (divisor must be > 0n).

### T18 Fill right copies the effective value as manual and is idempotent
INPUT: Fixture F; POST /api/plan/fill-right {month:'2026-10', categoryId: Groceries, throughMonth:'2027-01'} twice; then fill-right from Rent 2026-10 (source recurring) through 2026-12.
EXPECTED: Rows Groceries 2026-11, 2026-12, 2027-01 = 40000 'manual' (Oct and earlier untouched); second call changes nothing (same rows; response months ['2026-11','2026-12','2027-01'] both times). Nov Groceries available = 40000 + 8155 = 48155. Rent fill: Nov/Dec rows 150000 'manual' (effective value copied even though the source was 'recurring'); Feb 2027 Rent still 150000 'recurring'.

### T19 close_month freezes auto values once and never overwrites manual rows
INPUT: Fixture F; today 2026-10-13; run closeMonth(db, '2026-09') twice; then change the Rent recurring expected amount to 155000 for occurrences from 2026-10-01 on; read Sep and Oct.
EXPECTED: First run inserts for Aug: Rent 150000 'recurring', Electric 12000 'recurring', Water 9000 'recurring', Vacation 30000 'goal'; for Sep: Rent 150000, Electric 12000, Vacation 30000 (Paycheck has manual rows → skipped; Water Sep is 'none' → no row; spending categories never auto-plan) → inserted 7. Second run → inserted 0. After the price change: Sep Rent planned 150000 'recurring' (frozen row, hasExplicitPlan true), Oct Rent 155000 'recurring' (live, hasExplicitPlan false).

### T20 Income category never rolls over even if the column says otherwise; API rejects
INPUT: Fixture F; UPDATE category SET rollover_mode='all' WHERE name='Paycheck' (direct SQL); read Oct. Then PATCH /api/categories/:paycheckId {rolloverMode:'all'} and PUT /api/plan/cells/2026-10/:paycheckId {carriedInOverrideCents:'1000'}.
EXPECTED: Sep Paycheck remaining 10000 but Oct Paycheck carriedIn 0 (effectiveRollover → 'none'), cell rolloverMode reported 'none'. PATCH → 400 code 'income_no_rollover'; PUT → 400 code 'income_no_rollover'.

### T21 Goal progress, suggestion and projected completion (invariant to this month's contribution)
INPUT: Fixture F goal G, today 2026-10-13 (contributions Aug, Sep, Oct = 30000 each; plannedCurrent 30000). Variant: today 2026-10-01 before the Oct transfer (contributed(Oct) = 0).
EXPECTED: contributedToDate 90000, withdrawnToDate 0, saved = 100000 + 90000 = 190000, remaining 410000, progressBp = floor(190000 × 10000 / 600000) = 3166, monthsAfterCurrent = monthDiff(2026-10, 2027-05) = 7, currentShortfall = max(0, 30000 − 30000) = 0, projectedAtTarget = 190000 + 0 + 7 × 30000 = 400000 < 600000 → onTrack false, suggestedMonthlyCents = ceilDiv(410000, 7) = 58572, projectedCompletionMonth = addMonths(2026-10, ceilDiv(410000, 30000) = 14) = 2027-12. Variant: saved 160000, remaining 440000, currentShortfall 30000, projected = 160000 + 30000 + 210000 = 400000, suggested = ceilDiv(440000 − 30000, 7) = 58572 (same), completion = addMonths(2026-10, ceilDiv(440000 − 30000, 30000) = 14) = 2027-12 (same).

### T22 Spending funded from a goal: withdrawal lowers progress and leaves left to spend unchanged
INPUT: Fixture F with today 2026-12-20 and Dec transactions: +250000 Paycheck 12-01, +250000 Paycheck 12-15, −150000 Rent, −12000 Electric, transfer CHK→SAV 30000 on 12-01, transfer SAV→CHK 200000 on 12-15 (SAV −200000, CHK +200000, is_transfer), −200000 Travel 12-16 in CHK. No Nov transactions.
EXPECTED: Dec Vacation: planned 30000 'goal', actual (contributed) 30000, withdrawn 200000, remaining 0, committed 30000. Dec Travel: planned 0, actual 200000, overspend 200000, committed 200000. Dec leftToSpendPlannedCents = 500000 − 162000 − 30000 − 0 = 308000; leftToSpendCents = incomeExpected 500000 + savingsWithdrawn 200000 − 162000 − 30000 − (0 + 0 + 0 + 0 + 200000) = 308000 (unchanged by the funded spending). Goal after Dec: saved = 100000 + 4 × 30000 − 200000 = 20000, remaining 580000. Groceries Dec carriedIn 8155 (Nov remaining 8155 with no row); Dining Dec carriedIn 5000. pace: daysRemaining 31 − 20 + 1 = 12, perDayCents = truncDiv(308000, 12) = 25666 (12 × 25666 = 307992).

### T23 Pending counts once; posting replaces in place
INPUT: Fixture F plus a pending Oct Groceries −3000 on 10-12; then the sync replaces it with the posted row (same id, new external id).
EXPECTED: Oct Groceries actual 53000, remaining 5155, committed 40000 (within available) → leftToSpendCents stays 233000, transactionCount 3. After posting: identical numbers (no double count).

### T24 Reassigned income and uncategorized inflow land in the income Other row
INPUT: Fixture F plus Oct transaction +4000 categorized Fuel with bucket_override 'income', and an uncategorized +1500 on 10-08.
EXPECTED: Fuel Oct actual unchanged 4000 (override row excluded); income Other row actual 4000 + 1500 = 5500, committed 0; incomeExpected = 500000 + 5500 = 505500; uncategorizedCount 1; leftToSpendCents = 505500 − 167000 − 30000 − 70000 = 238500; leftToSpendPlannedCents unchanged 233000; Oct toAssign = 436000 + (250000 + 5500) − 267000 = 424500.

### T25 Month helpers
INPUT: addMonths('2026-10',14), addMonths('2026-12',1), addMonths('2026-01',−1), monthDiff('2026-10','2027-05'), monthDiff('2027-05','2026-10'), monthKey('2026-10-13'), daysInMonth('2028-02'), daysInMonth('2026-02'), daysInMonth('2026-11'), averageWindow('2026-11','2026-10',3), averageWindow('2026-09','2026-10',6), averageWindow('2027-01','2027-01',3).
EXPECTED: '2027-12'; '2027-01'; '2025-12'; 7; −7; '2026-10'; 29; 28; 30; {from:'2026-07', to:'2026-09'}; {from:'2026-03', to:'2026-08'} (to = min(2026-08, 2026-09)); {from:'2026-10', to:'2026-12'} (straddles the year boundary).

### T26 Writes before the plan start and empty rows
INPUT: Fixture F; PUT /api/plan/cells/2026-07/:groceries {plannedCents:'1'}; PUT /api/plan/cells/2026-11/:groceries {plannedCents:'40000'} then PUT the same cell {plannedCents:null}; PUT /api/plan/cells/2026-11/:groceries {plannedCents:'-5'}.
EXPECTED: First → 400 code 'before_plan_start'. Second creates the row (40000 'manual'); third clears planned and, since rollover_mode, carried_in_override_cents and note are null, deletes the row; Nov Groceries back to 0/'none' with carriedIn 8155; plan_audit has 2 rows for that cell (set, clear). Fourth → 400 (NonNegCentsString validation).

### T27 DB consistency constraints
INPUT: INSERT category (name 'X', group_id = Spending group, bucket 'bills'); UPDATE category_group SET bucket='bills' WHERE name='Spending'; INSERT savings_goal on a spending-bucket category; UPDATE category SET group_id = Income group, bucket = 'income' WHERE name = 'Vacation' (has goal G); UPDATE category SET bucket = 'bills' WHERE name = 'Groceries' (group unchanged).
EXPECTED: Insert fails (composite FK (group_id, bucket) → category_group(id, bucket)). Group bucket update succeeds and cascades bucket='bills' to every category in the group. Goal insert fails (FK (category_id, 'savings') → category(id, bucket) has no match). Vacation move fails (cascade would set savings_goal.category_bucket = 'income', violating its CHECK). Groceries bucket-only update fails (FK violation).

### T28 rollover_from_month: enabling 'all' later never imports history as a negative carry
INPUT: Fixture F; PATCH /api/categories/:pets {rolloverMode:'all'} on 2026-10-13 with no rolloverFromMonth; add Oct Pets −3000 on 10-14; read Aug–Nov.
EXPECTED: category.rollover_from_month = 2026-10. Aug Pets: mode effective 'none' (before the chain start), overspend 7000 forgiven, carryOut 0; Sep Pets carriedIn 0 ('none'). Oct Pets: carriedIn 0 ('start'), planned 0, actual 3000, remaining −3000, overspend 3000, committed 3000, carryOut −3000, forgiven 0 (mode 'all'). Nov Pets: carriedIn −3000 ('chain'), available −3000, remaining −3000, overspend 3000, committed = 0 + (−3000) + 3000 = 0. Setting rolloverMode 'none' again clears rollover_from_month.

### T29 Refund larger than spending: negative actual, surplus rolls, left to spend unchanged
INPUT: Fixture F plus one Nov Dining transaction +3000 (refund) and nothing else in Nov.
EXPECTED: Nov Dining: planned 0 'none', carriedIn 5000, actual −3000, available 5000, remaining 8000, overspend 0, committed max(0 + 0, −3000 − 5000) = 0; Nov leftToSpendCents still 299000; Dec Dining carriedIn 8000 (mode 'all' carries the whole remainder).

### T30 Splits attribute by split category; hidden categories stay in totals; empty install
INPUT: (a) Fixture F plus a Nov transaction −10000 with category NULL and splits Groceries −6000, Dining −4000. (b) Fixture F with Fuel hidden = true, read Oct. (c) Fresh install: start_month 2026-11, today 2026-11-01, no rows, no occurrences, no goals, no transactions.
EXPECTED: (a) Nov Groceries actual 6000, remaining 8155 − 6000 = 2155, transactionCount 1; Nov Dining actual 4000, available 5000, remaining 1000; no Other row for Nov; Nov leftToSpendCents 299000 (both within their envelopes). (b) Fuel cell returned with the category flagged hidden; Oct spending planned still 75000, committed 70000, leftToSpendCents still 233000. (c) Every cell 0/'none'/carriedIn 0/actual 0/remaining 0; no Other rows; all bucket totals 0; leftToSpendPlannedCents 0, leftToSpendCents 0, toAssignCents 0; pace {perDayCents 0, daysRemaining 30}.

## risks

- Two left-to-spend flavours (leftToSpendPlannedCents = the spec's literal formula; leftToSpendCents = actual-aware, shown on the strip and dashboard and driving the pace). The spec uses one name; if the lead prefers the strip to show the planned number only the UI binding changes, the engine reports both.
- committed = planned + min(carriedIn, 0) + overspend differs from both designers' formulas (A charged an 'all' overspend twice across two months; B charged a carried surplus twice). It is one line but implementers must not 'simplify' it back to planned + overspend; T3 and T11 pin it.
- Zero-based 'to assign' is a chained value on received income with forgiven overspend charged forward (Actual's model) rather than the plan-only number; future months show negative to-assign until income arrives, which may surprise someone expecting Simplifi-style planning in zero-based mode. The lead's 'same numbers' is honoured (same cells, same actuals).
- Goal withdrawals (withdrawnCents) extend the lead's 'categorized + transfer inflows' rule; the contributed number is exactly the lead's. Linking a goal to a pass-through account (paycheck lands in savings, moved to checking) would make every outbound transfer a withdrawal; the UI should only offer savings/brokerage/retirement account types and the user can set progress_basis 'balance' or edit starting_cents.
- Stability of auto-planned history depends on the recurring area: occurrences must be stable for past months (persisted recurring_occurrence or frozen amounts + ended_on). close_month freezes past planned values as a backstop, but the cash-flow projection and alerts are outside this backstop. If the recurring area emits only future occurrences, past months' bills show planned 0 until close_month has run.
- Recurring items confirmed without a category, or into a spending/savings category, never auto-plan; the confirm flow must require a bills/income category for bill-like items or users will think auto-fill is broken.
- Carried-in computed on every read: each grid/dashboard read re-folds from start_month: O(months × categories) plus one GROUP BY over transactions in range; fine for a household for a decade (~10k cells). If it ever matters, memoise carryOut per (closed month, category); nothing in the API would change.
- Three chain-related knobs (plan_settings.start_month, category.rollover_from_month, month_plan.carried_in_override_cents) can confuse users; the UI should expose start_month in settings only, set rollover_from_month implicitly when a mode is enabled, and show the override as 'adjust carried-in'.
- Changing a category's bucket/group rewrites all history (no versioned bucket); plan_audit records it; the UI must warn.
- bucket_override semantics (Other row) are defined here but no Phase 1 UI sets the column; the transactions PATCH gains bucketOverride, and the Other-row path must be tested even if the UI ships later.
- Composite foreign keys (group_id, bucket) and (category_id, 'savings') need Drizzle foreignKey({...}).onUpdate('cascade') plus unique() constraints (not just indexes); drizzle-kit emits them, but migration 0001 must seed groups and backfill group_id before NOT NULL and the FK, so it is partly hand-written and must be verified against generated SQL.
- `today` comes from the client (local calendar date) with a server fallback; a wrong device clock shifts the pace and month state for that view only; nothing is persisted from it.
- Pending transactions count in actual; a pending hold larger than the final charge temporarily overstates spending until the posted row replaces it; excluding pending would understate spend and disagree with the cash-flow projection.
- Splits are read by the actuals query but the split editor (ledger area) must keep Σ splits = parent and null the parent's category; a violating row would double count. Add a DB-level check in the split service's transaction.
- Income rollover is forced to 'none'; freelancers who want to carry an income shortfall must edit planned amounts.
- ceil rounding for plan-from-average overshoots by at most 1 cent per cell; progress basis points floor; both documented; the UI must format cents with formatCents and never re-round in floats.
- Uncategorized rows now enter bucket totals, left to spend and the zero-based chain via Other rows (Design A kept them out of the chain); an unpaired transfer leg that sync later pairs will move the numbers on the next read, which is correct but visible.

## resolutions

- Rollover mode location (spec: month_plan; lead: per category; A: both; B: category only): category.rollover_mode is the default and month_plan.rollover_mode is a nullable per-month override that decides that month's carry-out. Reason: the spec names the column on month_plan and the lead fixed per-category modes; A's two-level scheme satisfies both at the cost of one nullable column, and B's objection (a per-row mode needs a category fallback anyway) is exactly what the fallback provides.
- Carried-in stored vs computed (spec column; both designs compute): computed on every read by folding from the chain start; the spec's 'carried-in amount' column is month_plan.carried_in_override_cents, a nullable pin (A). Reason: a stored value goes stale on every sync, recategorization, split or plan edit; the override gives the spec's column a real job (seed an envelope, forgive an overspend) instead of being a cache.
- Where the chain starts (A: global plan_settings.start_month; B: per-category rollover_from_month): both. start_month is the global origin (needed by the zero-based chain and close_month, and so that importing older history never moves every carried-in); rollover_from_month (NULL = start_month) is set to the current month when a carrying mode is first enabled. Reason: B's flaw report is correct — with only a global start, switching a category to 'all' after months of unplanned spending imports all of it as a negative carry (T28).
- Left to spend with activity (A: planned + overspend; B: max(available, actual)): committed = planned + min(carriedIn, 0) + max(0, actual − available). Reason: A double-charges an 'all' overspend (charged in the month it happens and again as full planned next month, T3), B double-charges a carried surplus (charged as planned last month and as available this month). The merged rule charges every cent of outflow exactly once across the chain; for a month with no activity and non-negative carry it is the spec's literal formula.
- Zero-based 'to assign' (lead: same numbers as left to spend; A: chained on actual income with forgiven overspend; B: plan-only formula): A's chained value, from the same cells. Reason: the spec says 'Actual's every-dollar-assigned workflow'; a plan-only number loses unassigned money from prior months and never charges overspending, which defeats that workflow. Added: Other rows (uncategorized and reassigned) enter the chain as received income / unplanned spending so every non-transfer row affects to-assign exactly once (A excluded uncategorized rows).
- Uncategorized and bucket_override rows (A: month-level uncategorized net + per-bucket 'reassigned' row; B: synthetic 'Other' row per bucket for both): B's single synthetic Other row per bucket, with uncategorized rows routed by sign (+ income, − spending). Reason: one rule — every non-transfer transaction lands in exactly one bucket row — makes bucket totals equal the sum of their rows and keeps the income/outflow sides symmetric; uncategorizedCount is still reported for the review item.
- Plan-from-average rounding (A: ceilDiv; B: round half away from zero): ceilDiv, then clamp at 0. Reason: a plan seeded from history should never under-cover the average by a cent; planned is a non-negative magnitude (CHECK), so a net-refund average clamps to 0 (B's clamp adopted).
- Plan-from-average window (A: relative to the target month, capped at current−1; B: always the k months before the current month): A's averageWindow(target, current, n). Reason: planning a past month from the months before it is the only sensible reading; the cap keeps a partial current month out either way. B's per-row m3/m6/m12 in the grid response is dropped in favour of POST /api/plan/average with dryRun to keep the grid payload small.
- Fill right (A: server endpoint copying the effective value; B: client builds writes for a batch PUT): A's endpoint, plus a pure fillRight helper for tests. Reason: only the server knows the effective (auto) value reliably, and the audit row per month belongs server side. Single-cell PUT kept; no batch endpoint.
- Goal actual and withdrawals (lead: categorized + transfer inflows; A: adds withdrawn incl. all linked-account rows; B: inflows only): contributed is exactly the lead's number; withdrawn (transfer outflows from the linked account + categorized inflows) is added as a separate figure that reduces progress and is added back to left to spend. Reason: A's flaw report is valid (money moved in and out counts as saved; spending funded from a goal is double-charged, T22). Narrowed from A: non-transfer rows inside the linked account (interest, fees, direct spending) belong to their own categories, not the goal, which removes B's pass-through objection for interest and keeps every transaction in one place; progress_basis 'balance' covers accounts where that matters.
- Frozen history (A: nightly worker job plan.close_month; B: none, recompute past months): A's job. Reason: the spec's bills bucket is 'filled automatically from active recurring items', a price change or cancellation must not rewrite closed months, and the lead's planned_source list ('recurring') implies a stored provenance. The job is idempotent and the only worker work in this area.
- planned_source values (lead: manual | recurring | average | none; A adds 'goal'): 'goal' added. Reason: savings contributions are auto-filled from goals, not recurring items, and a frozen row must say which; 'none' is never stored (it is the computed state of a missing row).
- Audit (spec: edits to plans keep history; A: plan_audit; B: deferred to Polish): plan_audit included now. Reason: the spec lists it under Security and the table is trivial; deferring it means back-filling nothing.
- Rollover mode names: 'none' | 'surplus' | 'all' (A). Reason: shorter enum; the UI labels them 'None / Carry surplus only / Carry surplus and overspend'.
- Income categories (A: rollover forced 'none', API rejects; B: uniform math, UI hides): A. Reason: a carried income 'shortfall' has no meaning in the envelope model and silently rolling income would corrupt left to spend.
- zero_based toggle (A: plan_settings column; B: client-only toggle): server column. Reason: the household shares one plan across devices; the toggle is a plan setting, not a device preference.
- Range limit (A: 24 months; B: 36): 24. Reason: the chain still folds from start_month regardless, so the limit only bounds the response size.
- Both designs missed: the goal's auto-planned contribution must stop after the target month (B mentioned it in passing, A's autoPlans implied it) — now explicit with a test (T9); plan_audit action set gains 'clear'/'reorder'; the Other row needs its own drill-in endpoint; UpdateTransactionBody must gain bucketOverride for the override path to be reachable; a DELETE on a non-empty group needs moveTo (B) and DELETE on a category in use is 409 (A) — both kept.
