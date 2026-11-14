import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import {
  addDays,
  addMonths,
  dayDiff,
  daysInMonth,
  isIsoDate,
  maxBig,
  monthEnd,
  monthKey,
  projectCashFlow,
  projectedOccurrenceDates,
  validateSchedule,
  type CashFlowAccount,
  type CashFlowCardPayment,
  type CashFlowInput,
  type CashFlowProjectionResponse,
  type CashFlowRecurring,
  type CashFlowResult,
  type CashFlowSeries,
  type CashFlowSpendingMonth,
  type CashFlowSpendingWeight,
  type CashFlowWhatIf,
  type IsoDate,
  type MonthKey,
  type PlanCategoryRowResult,
  type PlanResult,
  type RecurringKind,
  type Schedule,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, category, recurring, split, transaction } from "../schema/index.js";
import { PlanError } from "./audit.js";
import { getPlan, planAverages } from "./plan.js";
import { getHouseholdSetting, householdToday } from "./settings.js";

/**
 * Loader for the cash-flow engine (docs/phase-2-plan.md §14, docs/design/phase-2/cashflow.md
 * "Loader reads"). Six reads, no writes: projected accounts with opening = posted balance +
 * pending, active recurring items mapped to engine items (every bucket: a recurring charge in
 * a spending category is a dated event too), card payment entries with the ledger-derived
 * unpaid part of the last statement, the remaining spending plan per month (current month from the grid's
 * remaining, future months from explicit rows or 3-month averages, each category less the
 * dated charges of its own recurring items so nothing is counted twice), trailing 90-day
 * spending weights, and the household defaults. The engine itself is pure
 * (`projectCashFlow` in @meridian/shared); `projectForHousehold` wires the two together.
 *
 * Documented assumption (one place): SimpleFIN `balance` is the posted balance and excludes
 * pending rows, so pending amounts are added here. `available_cents` is never used (for
 * cards it means remaining credit).
 */

/** Spending weights look back this many days including today (never empty on the 1st). */
export const SPENDING_WEIGHT_DAYS = 90;
/** Future months without an explicit plan row use this average window. */
export const SPENDING_AVERAGE_MONTHS = 3;

export interface LoadCashFlowInputQuery {
  today: IsoDate;
  /** 1..366. */
  horizonDays: number;
  /** Subset of the projected accounts; every id must be an on-budget open account (400 otherwise). */
  accountIds?: string[];
}

/**
 * A planned income, bills or savings amount the projection does not hold because no recurring
 * schedule dates it (a value typed into the grid, a goal contribution without a transfer item).
 * Phase 2 plan, audit decision A14.
 */
export interface UnscheduledPlan {
  month: MonthKey;
  categoryId: string;
  categoryName: string;
  bucket: "income" | "bills" | "savings";
  /** Bucket-natural magnitude (> 0) planned for the month and not forecast. */
  amountCents: bigint;
}

/** The engine's input minus the what-ifs, plus the loader's own notes (merged into the result's warnings). */
export interface CashFlowLoad extends Omit<CashFlowInput, "whatIfs"> {
  warnings: string[];
  /** Planned non-spending amounts without a schedule, by month (also summarised in `warnings`). */
  unscheduled: UnscheduledPlan[];
}

// ---- Helpers ----

function assertToday(today: IsoDate): void {
  if (!isIsoDate(today)) throw new PlanError(400, "validation", "today must be YYYY-MM-DD");
}

function assertHorizon(horizonDays: number): void {
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) throw new PlanError(400, "validation", "horizonDays must be between 1 and 366");
}

function clampedDate(month: MonthKey, day: number): IsoDate {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

/** The first date on/after `today` a card paid on `payDay` is paid (31 = last day; clamped per month). */
export function nextPaymentDate(today: IsoDate, payDay: number): IsoDate {
  const month = monthKey(today);
  const sameMonth = clampedDate(month, payDay);
  return sameMonth >= today ? sameMonth : clampedDate(addMonths(month, 1), payDay);
}

/** Statement close for a payment on `payDate`: the latest clamped `statementDay` strictly before it (same rule as the engine). */
export function statementCloseBefore(payDate: IsoDate, statementDay: number): IsoDate {
  const month = monthKey(payDate);
  const sameMonth = clampedDate(month, statementDay);
  return sameMonth < payDate ? sameMonth : clampedDate(addMonths(month, -1), statementDay);
}

function scheduleOf(row: Pick<typeof recurring.$inferSelect, "cadence" | "anchorDay" | "anchorDay2" | "anchorMonth" | "anchorDate">): Schedule {
  return { cadence: row.cadence, anchorDay: row.anchorDay, anchorDay2: row.anchorDay2, anchorMonth: row.anchorMonth, anchorDate: row.anchorDate };
}

/** Kind is derived, never stored: a destination account makes a transfer; else the sign decides. */
export function recurringKind(item: { transferAccountId: string | null; expectedCents: bigint }): RecurringKind {
  if (item.transferAccountId !== null) return "transfer";
  return item.expectedCents >= 0n ? "income" : "bill";
}

// ---- Reads ----

/**
 * The card's balance at the end of `statementDate`, derived from today's opening balance:
 * opening − Σ amount_cents of the card's rows (posted and pending) with statementDate < date ≤ today.
 */
export async function cardStatementBalance(db: DbOrTx, cardAccountId: string, openingCents: bigint, statementDate: IsoDate, today: IsoDate): Promise<bigint> {
  const [row] = await db
    .select({ cents: sql<bigint>`coalesce(sum(${transaction.amountCents}), 0)::bigint` })
    .from(transaction)
    .where(and(eq(transaction.accountId, cardAccountId), gt(transaction.date, statementDate), lte(transaction.date, today)));
  return openingCents - (row?.cents ?? 0n);
}

/**
 * What is still unpaid of the statement that closed on `statementDate`, as a balance (negative =
 * owed): the balance at the close plus every payment and credit (positive row, posted or
 * pending) posted to the card since, through today. Those payments are already in today's
 * balances, so the projection must not pay them again (phase 2 plan, audit decision A7). Equal
 * to opening − Σ of the card's charges (negative rows) after the close: the charges after the
 * close belong to the next statement.
 */
export async function cardUnpaidStatementBalance(db: DbOrTx, cardAccountId: string, openingCents: bigint, statementDate: IsoDate, today: IsoDate): Promise<bigint> {
  const [row] = await db
    .select({ cents: sql<bigint>`coalesce(sum(${transaction.amountCents}), 0)::bigint` })
    .from(transaction)
    .where(and(eq(transaction.accountId, cardAccountId), lt(transaction.amountCents, 0n), gt(transaction.date, statementDate), lte(transaction.date, today)));
  return openingCents - (row?.cents ?? 0n);
}

/**
 * Per account, Σ −amount_cents of non-transfer outflows (splits replace their parent) in
 * spending-bucket categories dated in [from, to], pending included. One GROUP BY; the result
 * keeps `accountIds`' order (the largest-remainder tie order) and omits accounts with no outflow.
 */
export async function spendingWeights(db: DbOrTx, accountIds: readonly string[], from: IsoDate, to: IsoDate): Promise<CashFlowSpendingWeight[]> {
  if (accountIds.length === 0) return [];
  const amount = sql`coalesce(${split.amountCents}, ${transaction.amountCents})`;
  const cat = sql`coalesce(${split.categoryId}, ${transaction.categoryId})`;
  const rows = await db
    .select({ accountId: transaction.accountId, weightCents: sql<bigint>`sum(-(${amount}))::bigint` })
    .from(transaction)
    .leftJoin(split, eq(split.transactionId, transaction.id))
    .innerJoin(category, eq(category.id, cat))
    .where(
      and(
        eq(transaction.isTransfer, false),
        eq(category.bucket, "spending"),
        sql`${amount} < 0`,
        gte(transaction.date, from),
        lte(transaction.date, to),
        inArray(transaction.accountId, [...accountIds]),
      ),
    )
    .groupBy(transaction.accountId);
  const byAccount = new Map(rows.map((r) => [r.accountId, r.weightCents]));
  const out: CashFlowSpendingWeight[] = [];
  for (const accountId of accountIds) {
    const weightCents = byAccount.get(accountId);
    if (weightCents !== undefined && weightCents > 0n) out.push({ accountId, weightCents });
  }
  return out;
}

export interface SpendingRemainingResult {
  months: CashFlowSpendingMonth[];
  /** Months in which at least one spending category had no explicit plan row and used its average. */
  monthsOnAverages: number;
  /** How many complete months the averages rest on; null when no average was needed. 0 means they are all zero. */
  averageMonthsWithData: number | null;
}

/** A recurring outflow in a spending-bucket category that the projection posts as dated events. */
export interface SpendingDatedItem {
  categoryId: string;
  schedule: Schedule;
  nextDueDate: IsoDate;
  /** Signed; only outflows (negative) are taken out of the spread. */
  amountCents: bigint;
}

/**
 * Remaining planned spending (spending bucket only, hidden categories included) per month in
 * [month of today, month of endDate]. Current month: Σ max(0, planned + carriedIn − actual)
 * from the grid; future months: Σ (explicit plan row ? planned : 3-month average as of today).
 *
 * `datedItems` are the spending-category recurring charges the engine posts as dated events.
 * Each category's amount for a month is reduced by the charges of its own items that post in
 * that month (never below 0), so the gym on the 20th is one event of 40.00 and the rest of
 * the Health envelope is spread, instead of the charge being spread and posted.
 */
export async function spendingRemainingByMonth(
  db: DbOrTx,
  today: IsoDate,
  endDate: IsoDate,
  datedItems: readonly SpendingDatedItem[] = [],
  /** The grid over [month of today, month of endDate], when the caller has read it already. */
  preloaded?: PlanResult,
): Promise<SpendingRemainingResult> {
  const currentMonth = monthKey(today);
  const lastMonth = monthKey(endDate);
  const plan = preloaded ?? (await getPlan(db, { from: currentMonth, to: lastMonth, today }));
  const spendingRows = plan.rows.filter((r): r is PlanCategoryRowResult => r.kind === "category" && r.bucket === "spending");

  // Dated charges per (category, month they post in): overdue ones post today.
  const dated = new Map<string, bigint>();
  for (const item of datedItems) {
    if (item.amountCents >= 0n) continue;
    for (const original of projectedOccurrenceDates(item.schedule, item.nextDueDate, today, monthEnd(lastMonth))) {
      const key = `${item.categoryId}|${monthKey(original < today ? today : original)}`;
      dated.set(key, (dated.get(key) ?? 0n) - item.amountCents);
    }
  }

  let averages: Map<string, bigint> | null = null;
  let averageMonthsWithData: number | null = null;
  const months: CashFlowSpendingMonth[] = [];
  let monthsOnAverages = 0;
  for (const [i, month] of plan.months.entries()) {
    let remainingCents = 0n;
    let usedAverage = false;
    for (const row of spendingRows) {
      const cell = row.cells[i];
      if (!cell) continue;
      let cents: bigint;
      if (month === currentMonth) {
        cents = maxBig(0n, cell.remainingCents);
      } else if (cell.hasExplicitPlan) {
        cents = cell.plannedCents;
      } else {
        if (averages === null) {
          const result = await planAverages(db, { months: SPENDING_AVERAGE_MONTHS, today });
          averages = new Map(result.averages.map((a) => [a.categoryId, a.averageCents]));
          averageMonthsWithData = result.window.monthsWithData;
        }
        cents = averages.get(row.categoryId) ?? 0n;
        usedAverage = true;
      }
      remainingCents += maxBig(0n, cents - (dated.get(`${row.categoryId}|${month}`) ?? 0n));
    }
    if (usedAverage) monthsOnAverages++;
    months.push({ month, remainingCents });
  }
  return { months, monthsOnAverages, averageMonthsWithData };
}

/** A recurring item whose occurrences the projection dates, as far as its category's plan is concerned. */
export interface ScheduledPlanItem {
  categoryId: string;
  schedule: Schedule;
  nextDueDate: IsoDate;
  /** Signed like the item's expected amount. */
  amountCents: bigint;
}

const PLAN_BUCKET_ORDER: Record<UnscheduledPlan["bucket"], number> = { income: 0, bills: 1, savings: 2 };

/**
 * The income, bills and savings planned in the grid that no dated recurring event covers (audit
 * decision A14): a typed (or averaged) plan and a goal's contribution. A cell planned
 * automatically from recurring items is their schedule by definition and is skipped (an
 * occurrence it holds that the projection does not post was missed, which its alert reports).
 * Per category and month: what is still expected (the current month: planned less what already
 * happened, never below 0; later months: planned) less the bucket-natural amount of the
 * category's own scheduled occurrences that post in that month (an overdue one posts today;
 * occurrences after the horizon but inside its last month count, since the plan is monthly).
 * A positive rest is not forecast. Pure; ordered by month, bucket, category name.
 */
export function unscheduledPlans(plan: PlanResult, today: IsoDate, scheduled: readonly ScheduledPlanItem[]): UnscheduledPlan[] {
  const currentMonth = monthKey(today);
  const lastMonth = plan.months[plan.months.length - 1];
  if (lastMonth === undefined) return [];
  const rows = plan.rows.filter((r): r is PlanCategoryRowResult & { bucket: UnscheduledPlan["bucket"] } => r.kind === "category" && r.bucket !== "spending");
  const bucketOf = new Map(rows.map((r) => [r.categoryId, r.bucket]));
  const covered = new Map<string, bigint>();
  for (const item of scheduled) {
    const bucket = bucketOf.get(item.categoryId);
    if (bucket === undefined) continue;
    const natural = bucket === "income" ? item.amountCents : -item.amountCents;
    for (const original of projectedOccurrenceDates(item.schedule, item.nextDueDate, today, monthEnd(lastMonth))) {
      const key = `${item.categoryId}|${monthKey(original < today ? today : original)}`;
      covered.set(key, (covered.get(key) ?? 0n) + natural);
    }
  }
  const out: UnscheduledPlan[] = [];
  for (const [i, month] of plan.months.entries()) {
    for (const row of rows) {
      const cell = row.cells[i];
      if (!cell || (cell.source === "recurring" && !cell.hasExplicitPlan)) continue;
      const expected = month === currentMonth ? maxBig(0n, cell.plannedCents - cell.actualCents) : cell.plannedCents;
      const missing = expected - (covered.get(`${row.categoryId}|${month}`) ?? 0n);
      if (missing > 0n) out.push({ month, categoryId: row.categoryId, categoryName: row.name, bucket: row.bucket, amountCents: missing });
    }
  }
  return out.sort(
    (a, b) =>
      (a.month < b.month ? -1 : a.month > b.month ? 1 : 0) ||
      PLAN_BUCKET_ORDER[a.bucket] - PLAN_BUCKET_ORDER[b.bucket] ||
      a.categoryName.localeCompare(b.categoryName) ||
      (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0),
  );
}

/** One warning for the unscheduled amounts, naming each category once. */
export function unscheduledWarning(items: readonly UnscheduledPlan[]): string | null {
  if (items.length === 0) return null;
  const names = [...new Set(items.map((u) => u.categoryName))].join(", ");
  return items.length === 1
    ? `1 planned amount has no recurring schedule and is not in the projection: ${names}`
    : `${items.length} planned amounts have no recurring schedule and are not in the projection: ${names}`;
}

// ---- The loader ----

/**
 * An opening older than this many days is named in the warnings (audit decision A28): a bank
 * often reports the previous close, and a sync may have run last evening, so one or two days
 * behind is normal.
 */
export const STALE_OPENING_DAYS = 2;

const shortDay = (d: IsoDate): string => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(2, 4)}`;

/** "Savings: the projection starts from the balance of 09/15/26; record a newer balance or import its transactions". */
export function staleOpeningWarning(name: string, feed: boolean, balanceDate: IsoDate, rolledRows: number, dataThrough: IsoDate): string {
  if (feed) return `${name}: the projection starts from the bank's balance of ${shortDay(balanceDate)}; sync its connection for a newer one`;
  const rows = rolledRows > 0 ? ` plus ${rolledRows} transaction${rolledRows === 1 ? "" : "s"} through ${shortDay(dataThrough)}` : "";
  return `${name}: the projection starts from the balance of ${shortDay(balanceDate)}${rows}; record a newer balance or import its transactions`;
}

/** Every read the engine needs for `[today, today + horizonDays]`; no writes. */
export async function loadCashFlowInput(db: DbOrTx, q: LoadCashFlowInputQuery): Promise<CashFlowLoad> {
  assertToday(q.today);
  assertHorizon(q.horizonDays);
  const { today } = q;
  const endDate = addDays(today, q.horizonDays);
  const warnings: string[] = [];
  const setting = await getHouseholdSetting(db, today);

  // 1. Projected accounts: on budget, open, optionally a subset; opening = posted balance + pending,
  //    and for an account without a bank feed the rows posted since its balance (audit decision A28).
  const allAccounts = await db
    .select({
      id: account.id,
      name: account.name,
      type: account.type,
      connectionId: account.connectionId,
      onBudget: account.onBudget,
      closed: account.closed,
      balanceCents: account.balanceCents,
      balanceDate: account.balanceDate,
      lowBalanceThresholdCents: account.lowBalanceThresholdCents,
      paymentDay: account.paymentDay,
      paymentFromAccountId: account.paymentFromAccountId,
      statementDay: account.statementDay,
    })
    .from(account)
    .orderBy(asc(account.name), asc(account.id));
  const wanted = q.accountIds === undefined ? null : new Set(q.accountIds);
  const projectedRows = allAccounts.filter((a) => a.onBudget && !a.closed && (wanted === null || wanted.has(a.id)));
  if (wanted !== null) {
    const projectedIds = new Set(projectedRows.map((a) => a.id));
    for (const id of wanted) if (!projectedIds.has(id)) throw new PlanError(400, "bad_request", `Account ${id} is not an on-budget open account`);
  }
  const pendingRows = await db
    .select({ accountId: transaction.accountId, cents: sql<bigint>`sum(${transaction.amountCents})::bigint` })
    .from(transaction)
    .where(eq(transaction.pending, true))
    .groupBy(transaction.accountId);
  const pendingBy = new Map(pendingRows.map((r) => [r.accountId, r.cents]));
  // A balance is the end of its day. A feed's is the bank's and is passed through even when it is old
  // (the cash-flow design); a balance typed by hand knows nothing of the rows imported after it.
  const rolledRows = await db
    .select({
      accountId: transaction.accountId,
      cents: sql<bigint>`sum(${transaction.amountCents})::bigint`,
      rows: sql<number>`count(*)::int`,
      last: sql<string>`max(${transaction.date})::text`,
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .where(and(eq(transaction.pending, false), isNull(account.connectionId), isNotNull(account.balanceCents), gt(transaction.date, account.balanceDate), lte(transaction.date, today)))
    .groupBy(transaction.accountId);
  const rolledBy = new Map(rolledRows.map((r) => [r.accountId, r]));
  const accounts: CashFlowAccount[] = projectedRows.map((a) => {
    if (a.balanceCents === null) warnings.push(`account ${a.name} has no known balance`);
    const rolled = a.balanceCents !== null ? rolledBy.get(a.id) : undefined;
    const rolledForwardCents = rolled ? BigInt(rolled.cents) : 0n;
    const rolledForwardRows = rolled ? Number(rolled.rows) : 0;
    const dataThrough = rolled && a.balanceDate !== null && rolled.last > a.balanceDate ? rolled.last : a.balanceDate;
    if (a.balanceCents !== null && a.balanceDate !== null && dataThrough !== null && dayDiff(dataThrough, today) > STALE_OPENING_DAYS) {
      warnings.push(staleOpeningWarning(a.name, a.connectionId !== null, a.balanceDate, rolledForwardRows, dataThrough));
    }
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      openingCents: (a.balanceCents ?? 0n) + rolledForwardCents + (pendingBy.get(a.id) ?? 0n),
      balanceDate: a.balanceDate,
      rolledForwardCents,
      rolledForwardRows,
      dataThrough,
      lowBalanceThresholdCents: a.lowBalanceThresholdCents,
    };
  });
  const openingOf = new Map(accounts.map((a) => [a.id, a.openingCents]));
  const cardsWithPaymentDay = new Set(allAccounts.filter((a) => a.type === "credit" && a.paymentDay !== null).map((a) => a.id));

  // 2. Active recurring items as dated events, whatever their category's bucket.
  const items = await db
    .select({
      id: recurring.id,
      name: recurring.name,
      categoryId: recurring.categoryId,
      accountId: recurring.accountId,
      transferAccountId: recurring.transferAccountId,
      cadence: recurring.cadence,
      anchorDay: recurring.anchorDay,
      anchorDay2: recurring.anchorDay2,
      anchorMonth: recurring.anchorMonth,
      anchorDate: recurring.anchorDate,
      expectedCents: recurring.expectedCents,
      nextDueDate: recurring.nextDueDate,
      bucket: category.bucket,
    })
    .from(recurring)
    .leftJoin(category, eq(category.id, recurring.categoryId))
    .where(eq(recurring.status, "active"))
    .orderBy(asc(recurring.id));
  const recurringItems: CashFlowRecurring[] = [];
  const spendingDated: SpendingDatedItem[] = [];
  const scheduledForPlan: ScheduledPlanItem[] = [];
  for (const item of items) {
    const kind = recurringKind(item);
    if (kind === "transfer" && item.transferAccountId !== null && cardsWithPaymentDay.has(item.transferAccountId)) {
      // The card payment model forecasts it, so its plan is not "without a schedule".
      if (item.categoryId !== null && item.nextDueDate !== null && validateSchedule(scheduleOf(item)) === null) {
        scheduledForPlan.push({ categoryId: item.categoryId, schedule: scheduleOf(item), nextDueDate: item.nextDueDate, amountCents: item.expectedCents });
      }
      continue;
    }
    if (item.accountId === null) {
      warnings.push(`recurring item ${item.name} has no account and was skipped`);
      continue;
    }
    if (item.nextDueDate === null) {
      warnings.push(`recurring item ${item.name} has no next due date and was skipped`);
      continue;
    }
    const schedule = scheduleOf(item);
    const problem = validateSchedule(schedule);
    if (problem !== null) {
      warnings.push(`recurring item ${item.name} has an invalid schedule (${problem}) and was skipped`);
      continue;
    }
    recurringItems.push({
      id: item.id,
      name: item.name,
      kind,
      accountId: item.accountId,
      transferAccountId: item.transferAccountId,
      schedule,
      nextDueDate: item.nextDueDate,
      amountCents: item.expectedCents,
    });
    if (item.categoryId !== null) scheduledForPlan.push({ categoryId: item.categoryId, schedule, nextDueDate: item.nextDueDate, amountCents: item.expectedCents });
    // A spending-category charge is posted on its date, so it must come out of that category's spread.
    if (item.bucket === "spending" && item.categoryId !== null) {
      spendingDated.push({ categoryId: item.categoryId, schedule, nextDueDate: item.nextDueDate, amountCents: item.expectedCents });
    }
  }

  // 3. Card payments for projected credit accounts with a payment day.
  const cardPayments: CashFlowCardPayment[] = [];
  for (const a of projectedRows) {
    if (a.type !== "credit" || a.paymentDay === null || a.paymentFromAccountId === null) continue;
    let knownStatementBalanceCents: bigint | null = null;
    if (a.statementDay !== null) {
      const payDate = nextPaymentDate(today, a.paymentDay);
      const close = statementCloseBefore(payDate, a.statementDay);
      if (payDate <= endDate && close < today) knownStatementBalanceCents = await cardUnpaidStatementBalance(db, a.id, openingOf.get(a.id) ?? 0n, close, today);
    }
    cardPayments.push({ cardAccountId: a.id, fromAccountId: a.paymentFromAccountId, payDay: a.paymentDay, statementDay: a.statementDay, knownStatementBalanceCents });
  }

  // 4. Remaining spending per month, less the spending-category charges posted as dated events;
  //    and the planned income, bills and savings that no schedule dates (one read of the grid).
  const plan = await getPlan(db, { from: monthKey(today), to: monthKey(endDate), today });
  const spending = await spendingRemainingByMonth(db, today, endDate, spendingDated, plan);
  const unscheduled = unscheduledPlans(plan, today, scheduledForPlan);
  const unscheduledNote = unscheduledWarning(unscheduled);
  if (unscheduledNote !== null) warnings.push(unscheduledNote);
  if (spending.monthsOnAverages > 0) {
    const n = spending.monthsOnAverages;
    if (spending.averageMonthsWithData === 0) {
      warnings.push(`${n === 1 ? "1 month has" : `${n} months have`} unplanned spending categories and there is no complete month of history to average yet: they are projected at 0`);
    } else {
      warnings.push(`${n === 1 ? "1 month uses" : `${n} months use`} ${SPENDING_AVERAGE_MONTHS}-month averages for unplanned spending categories`);
    }
  }

  // 5. Trailing spending weights per projected account.
  const weights = await spendingWeights(
    db,
    accounts.map((a) => a.id),
    addDays(today, -(SPENDING_WEIGHT_DAYS - 1)),
    today,
  );

  // 6. Household defaults.
  return {
    today,
    horizonDays: q.horizonDays,
    accounts,
    recurring: recurringItems,
    cardPayments,
    spendingPlan: spending.months,
    spendingWeights: weights,
    primaryAccountId: setting.primaryAccountId,
    defaultThresholdCents: setting.lowBalanceThresholdCents,
    warnings,
    unscheduled,
  };
}

// ---- Convenience: load + engine ----

export interface ProjectForHouseholdInput {
  /** The client's local date; defaults to the household's calendar date now. */
  today?: IsoDate;
  /** Defaults to household_setting.projection_default_days. */
  horizonDays?: number;
  /** Per-request override of household_setting.low_balance_threshold_cents. */
  thresholdCents?: bigint;
  accountIds?: string[];
  whatIfs?: CashFlowWhatIf[];
  /** Clock for the default `today`; tests inject it. */
  now?: Date;
}

/** The engine's result plus the loader's list of planned amounts the projection does not hold. */
export interface HouseholdCashFlowResult extends CashFlowResult {
  unscheduled: UnscheduledPlan[];
}

/** Load the household's input and run the engine; loader notes come first in `warnings`. No writes. */
export async function projectForHousehold(db: DbOrTx, body: ProjectForHouseholdInput = {}): Promise<HouseholdCashFlowResult> {
  const setting = await getHouseholdSetting(db, body.today);
  const today = body.today ?? householdToday(setting, body.now);
  const { warnings, unscheduled, ...input } = await loadCashFlowInput(db, {
    today,
    horizonDays: body.horizonDays ?? setting.projectionDefaultDays,
    ...(body.accountIds === undefined ? {} : { accountIds: body.accountIds }),
  });
  const result = projectCashFlow({
    ...input,
    defaultThresholdCents: body.thresholdCents ?? input.defaultThresholdCents,
    whatIfs: body.whatIfs ?? [],
  });
  return { ...result, warnings: [...warnings, ...result.warnings], unscheduled };
}

// ---- View ----

function seriesView(s: CashFlowSeries) {
  return {
    openingCents: s.openingCents.toString(),
    thresholdCents: s.thresholdCents === null ? null : s.thresholdCents.toString(),
    points: s.points.map((p) => p.toString()),
    minCents: s.minCents.toString(),
    minDate: s.minDate,
    firstBelowThresholdDate: s.firstBelowThresholdDate,
    alreadyBelow: s.alreadyBelow,
  };
}

/** The wire shape: every bigint as a decimal string, events decorated with their account's name. */
export function toCashFlowProjectionView(r: CashFlowResult & { unscheduled?: UnscheduledPlan[] }): CashFlowProjectionResponse {
  const nameOf = new Map(r.accounts.map((a) => [a.accountId, a.name]));
  return {
    today: r.today,
    endDate: r.endDate,
    dates: r.dates,
    accounts: r.accounts.map((a) => ({
      ...seriesView(a),
      accountId: a.accountId,
      name: a.name,
      type: a.type,
      balanceDate: a.balanceDate,
      rolledForwardCents: a.rolledForwardCents.toString(),
      rolledForwardRows: a.rolledForwardRows,
      dataThrough: a.dataThrough,
    })),
    combined: seriesView(r.combined),
    events: r.events.map((e) => ({
      date: e.date,
      originalDate: e.originalDate,
      accountId: e.accountId,
      accountName: nameOf.get(e.accountId) ?? "",
      amountCents: e.amountCents.toString(),
      kind: e.kind,
      recurringId: e.recurringId,
      label: e.label,
      applied: e.applied,
      overdue: e.overdue,
      moved: e.moved,
    })),
    spreads: r.spreads.map((s) => ({
      month: s.month,
      accountId: s.accountId,
      totalCents: s.totalCents.toString(),
      windowStart: s.windowStart,
      days: s.days,
      baseCents: s.baseCents.toString(),
      extraCentDays: s.extraCentDays,
    })),
    whatIfs: r.whatIfs.map((w) => (w.reason === undefined ? { index: w.index, applied: w.applied } : { index: w.index, applied: w.applied, reason: w.reason })),
    warnings: r.warnings,
    unscheduled: (r.unscheduled ?? []).map((u) => ({ ...u, amountCents: u.amountCents.toString() })),
  };
}
