import { and, asc, desc, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import {
  addDays,
  addMonthsClamped,
  isIsoDate,
  monthKey,
  occurrencesInRange,
  paceCents,
  validateSchedule,
  type BucketTotals,
  type ConnectionStatus,
  type DashboardView,
  type IsoDate,
  type MonthKey,
  type PaceResult,
  type Schedule,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, balanceSnapshot, category, connection, recurring } from "../schema/index.js";
import { countOpenAlerts } from "./alerts.js";
import { PlanError } from "./audit.js";
import { projectForHousehold } from "./cashflow.js";
import { getPlan } from "./plan.js";
import { countUncategorized } from "./transactions.js";

/**
 * The dashboard (docs/phase-2-plan.md §15, grid-and-api `DashboardView`): the current
 * month's summary strip, the 30-day combined cash-flow line with its low point, bills due
 * in the next 14 days (plus overdue items), net worth with its 12-month change, the review
 * counts and the sync status. Everything is computed per request from the other services;
 * nothing is cached or written. `getDashboard` returns the bigint twin of the contract and
 * `toDashboardView` maps it to the wire shape.
 */

export const DASHBOARD_HORIZON_DAYS = 30;
export const BILLS_DUE_DAYS = 14;

export interface DashboardPlanBlock {
  month: MonthKey;
  leftToSpendCents: bigint;
  toAssignCents: bigint;
  zeroBased: boolean;
  warning: boolean;
  pace: PaceResult;
  planned: BucketTotals;
  actual: BucketTotals;
  committed: BucketTotals;
  uncategorized: { count: number; cents: bigint };
}

export interface DashboardCashFlowBlock {
  asOf: IsoDate;
  horizonDays: number;
  thresholdCents: bigint;
  points: Array<{ date: IsoDate; cents: bigint }>;
  /** The combined line's minimum; the earliest date on ties. */
  lowPoint: { date: IsoDate; cents: bigint };
  firstBelow: IsoDate | null;
  warnings: string[];
}

export interface BillDue {
  recurringId: string;
  name: string;
  categoryName: string | null;
  accountName: string | null;
  dueDate: IsoDate;
  /** Signed like the ledger (negative). */
  amountCents: bigint;
  overdue: boolean;
}

export interface NetWorthBlock {
  asOf: IsoDate;
  todayCents: bigint;
  yearAgoDate: IsoDate;
  /** Null when no account has a snapshot on/before `yearAgoDate`. */
  yearAgoCents: bigint | null;
  changeCents: bigint | null;
  /** Accounts counted today with no snapshot a year ago (they contribute 0 to `yearAgoCents`). */
  newAccounts: Array<{ id: string; name: string }>;
}

export interface DashboardResult {
  today: IsoDate;
  plan: DashboardPlanBlock;
  cashFlow: DashboardCashFlowBlock;
  billsDue: BillDue[];
  netWorth: NetWorthBlock;
  review: { uncategorized: number; suggestedRecurring: number; alerts: number };
  sync: { lastSyncAt: Date | null; attention: Array<{ connectionId: string; name: string; status: ConnectionStatus }> };
  retirement: null;
}

export interface DashboardQuery {
  today: IsoDate;
}

// ---- Bills due ----

function scheduleOf(row: Pick<typeof recurring.$inferSelect, "cadence" | "anchorDay" | "anchorDay2" | "anchorMonth" | "anchorDate">): Schedule {
  return { cadence: row.cadence, anchorDay: row.anchorDay, anchorDay2: row.anchorDay2, anchorMonth: row.anchorMonth, anchorDate: row.anchorDate };
}

function compareBills(a: BillDue, b: BillDue): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.recurringId < b.recurringId ? -1 : a.recurringId > b.recurringId ? 1 : 0;
}

/**
 * Active outflow items (expected_cents < 0) due in [today, today + days]: every schedule
 * occurrence from max(today, next_due_date) through the window's end, plus one overdue
 * entry per item whose next_due_date is before today. Sorted by due date, then name.
 */
export async function listBillsDue(db: DbOrTx, q: { today: IsoDate; days?: number }): Promise<BillDue[]> {
  const { today } = q;
  const windowEnd = addDays(today, q.days ?? BILLS_DUE_DAYS);
  const rows = await db
    .select({
      id: recurring.id,
      name: recurring.name,
      categoryName: category.name,
      accountName: account.name,
      cadence: recurring.cadence,
      anchorDay: recurring.anchorDay,
      anchorDay2: recurring.anchorDay2,
      anchorMonth: recurring.anchorMonth,
      anchorDate: recurring.anchorDate,
      expectedCents: recurring.expectedCents,
      nextDueDate: recurring.nextDueDate,
    })
    .from(recurring)
    .leftJoin(category, eq(category.id, recurring.categoryId))
    .leftJoin(account, eq(account.id, recurring.accountId))
    .where(and(eq(recurring.status, "active"), lt(recurring.expectedCents, 0n)));

  const out: BillDue[] = [];
  for (const r of rows) {
    const base = { recurringId: r.id, name: r.name, categoryName: r.categoryName, accountName: r.accountName, amountCents: r.expectedCents };
    const seen = new Set<IsoDate>();
    const push = (dueDate: IsoDate, overdue: boolean): void => {
      if (seen.has(dueDate)) return;
      seen.add(dueDate);
      out.push({ ...base, dueDate, overdue });
    };
    if (r.nextDueDate !== null && r.nextDueDate < today) push(r.nextDueDate, true);
    const schedule = scheduleOf(r);
    if (validateSchedule(schedule) === null) {
      const from = r.nextDueDate !== null && r.nextDueDate > today ? r.nextDueDate : today;
      for (const d of occurrencesInRange(schedule, from, windowEnd)) push(d, false);
    } else if (r.nextDueDate !== null && r.nextDueDate >= today && r.nextDueDate <= windowEnd) {
      push(r.nextDueDate, false);
    }
  }
  return out.sort(compareBills);
}

// ---- Net worth ----

/** Latest balance_snapshot on/before `asOf` per open account. */
async function latestBalances(db: DbOrTx, asOf: IsoDate): Promise<Map<string, bigint>> {
  const rows = await db
    .selectDistinctOn([balanceSnapshot.accountId], { accountId: balanceSnapshot.accountId, balanceCents: balanceSnapshot.balanceCents })
    .from(balanceSnapshot)
    .innerJoin(account, eq(account.id, balanceSnapshot.accountId))
    .where(and(eq(account.closed, false), lte(balanceSnapshot.date, asOf)))
    .orderBy(balanceSnapshot.accountId, desc(balanceSnapshot.date));
  return new Map(rows.map((r) => [r.accountId, r.balanceCents]));
}

function sumValues(m: ReadonlyMap<string, bigint>): bigint {
  let sum = 0n;
  for (const v of m.values()) sum += v;
  return sum;
}

/**
 * Net worth from balance_snapshot over open accounts (liabilities are negative balances):
 * today's latest snapshots versus the latest on/before the same day twelve months earlier
 * (`addMonthsClamped`). Accounts without a snapshot that old contribute 0 and are named;
 * when no account has one, the year-ago figures are null.
 */
export async function netWorth(db: DbOrTx, today: IsoDate): Promise<NetWorthBlock> {
  const yearAgoDate = addMonthsClamped(today, -12);
  const current = await latestBalances(db, today);
  const yearAgo = await latestBalances(db, yearAgoDate);
  const todayCents = sumValues(current);
  if (yearAgo.size === 0) return { asOf: today, todayCents, yearAgoDate, yearAgoCents: null, changeCents: null, newAccounts: [] };
  const yearAgoCents = sumValues(yearAgo);
  const newIds = [...current.keys()].filter((id) => !yearAgo.has(id));
  const newAccounts =
    newIds.length === 0
      ? []
      : await db
          .select({ id: account.id, name: account.name })
          .from(account)
          .where(inArray(account.id, newIds))
          .orderBy(asc(account.name), asc(account.id));
  return { asOf: today, todayCents, yearAgoDate, yearAgoCents, changeCents: todayCents - yearAgoCents, newAccounts };
}

// ---- Review counts and sync ----

async function countSuggestedRecurring(db: DbOrTx): Promise<number> {
  const rows = await db.select({ id: recurring.id }).from(recurring).where(eq(recurring.status, "suggested"));
  return rows.length;
}

async function syncStatus(db: DbOrTx): Promise<DashboardResult["sync"]> {
  const [latest] = await db
    .select({ lastSyncAt: connection.lastSyncAt })
    .from(connection)
    .where(isNotNull(connection.lastSyncAt))
    .orderBy(desc(connection.lastSyncAt))
    .limit(1);
  const attention = await db
    .select({ connectionId: connection.id, name: connection.name, status: connection.status })
    .from(connection)
    .where(inArray(connection.status, ["auth_required", "error"]))
    .orderBy(asc(connection.name), asc(connection.id));
  return { lastSyncAt: latest?.lastSyncAt ?? null, attention };
}

// ---- The dashboard ----

/** Everything on the dashboard for `today`, computed per request; no writes. */
export async function getDashboard(db: DbOrTx, q: DashboardQuery): Promise<DashboardResult> {
  const { today } = q;
  if (!isIsoDate(today)) throw new PlanError(400, "validation", "today must be YYYY-MM-DD");
  const currentMonth = monthKey(today);

  const plan = await getPlan(db, { from: currentMonth, to: currentMonth, today });
  const summary = plan.summary[0];
  if (!summary) throw new Error(`no plan summary for ${currentMonth}`);
  const planBlock: DashboardPlanBlock = {
    month: summary.month,
    leftToSpendCents: summary.leftToSpendCents,
    toAssignCents: summary.toAssignCents,
    zeroBased: plan.zeroBased,
    warning: summary.warning,
    pace: summary.pace ?? paceCents(summary.leftToSpendCents, today),
    planned: summary.planned,
    actual: summary.actual,
    committed: summary.committed,
    uncategorized: summary.uncategorized,
  };

  const projection = await projectForHousehold(db, { today, horizonDays: DASHBOARD_HORIZON_DAYS });
  const combined = projection.combined;
  const cashFlow: DashboardCashFlowBlock = {
    asOf: today,
    horizonDays: DASHBOARD_HORIZON_DAYS,
    thresholdCents: combined.thresholdCents ?? 0n,
    points: projection.dates.map((date, i) => ({ date, cents: combined.points[i] ?? combined.openingCents })),
    lowPoint: { date: combined.minDate, cents: combined.minCents },
    firstBelow: combined.firstBelowThresholdDate,
    warnings: projection.warnings,
  };

  const billsDue = await listBillsDue(db, { today });
  const worth = await netWorth(db, today);
  const review = {
    uncategorized: await countUncategorized(db),
    suggestedRecurring: await countSuggestedRecurring(db),
    alerts: await countOpenAlerts(db),
  };
  const sync = await syncStatus(db);

  return { today, plan: planBlock, cashFlow, billsDue, netWorth: worth, review, sync, retirement: null };
}

// ---- View ----

function totalsView(t: BucketTotals) {
  return { income: t.income.toString(), bills: t.bills.toString(), savings: t.savings.toString(), spending: t.spending.toString() };
}

/** The wire shape of `DashboardResult`: bigints as decimal strings, timestamps as ISO strings. */
export function toDashboardView(d: DashboardResult): DashboardView {
  return {
    today: d.today,
    plan: {
      month: d.plan.month,
      leftToSpendCents: d.plan.leftToSpendCents.toString(),
      toAssignCents: d.plan.toAssignCents.toString(),
      zeroBased: d.plan.zeroBased,
      warning: d.plan.warning,
      pace: { daysLeft: d.plan.pace.daysLeft, perDayCents: d.plan.pace.perDayCents.toString(), overCents: d.plan.pace.overCents.toString() },
      planned: totalsView(d.plan.planned),
      actual: totalsView(d.plan.actual),
      committed: totalsView(d.plan.committed),
      uncategorized: { count: d.plan.uncategorized.count, cents: d.plan.uncategorized.cents.toString() },
    },
    cashFlow: {
      asOf: d.cashFlow.asOf,
      horizonDays: d.cashFlow.horizonDays,
      thresholdCents: d.cashFlow.thresholdCents.toString(),
      points: d.cashFlow.points.map((p) => ({ date: p.date, cents: p.cents.toString() })),
      lowPoint: { date: d.cashFlow.lowPoint.date, cents: d.cashFlow.lowPoint.cents.toString() },
      firstBelow: d.cashFlow.firstBelow,
      warnings: d.cashFlow.warnings,
    },
    billsDue: d.billsDue.map((b) => ({
      recurringId: b.recurringId,
      name: b.name,
      categoryName: b.categoryName,
      accountName: b.accountName,
      dueDate: b.dueDate,
      amountCents: b.amountCents.toString(),
      overdue: b.overdue,
    })),
    netWorth: {
      asOf: d.netWorth.asOf,
      todayCents: d.netWorth.todayCents.toString(),
      yearAgoDate: d.netWorth.yearAgoDate,
      yearAgoCents: d.netWorth.yearAgoCents === null ? null : d.netWorth.yearAgoCents.toString(),
      changeCents: d.netWorth.changeCents === null ? null : d.netWorth.changeCents.toString(),
      newAccounts: d.netWorth.newAccounts,
      // Phase 3 skeleton: the type breakdown and the investments block arrive with the investments services (step 9).
      breakdown: null,
    },
    review: d.review,
    sync: {
      lastSyncAt: d.sync.lastSyncAt === null ? null : d.sync.lastSyncAt.toISOString(),
      attention: d.sync.attention,
    },
    retirement: null,
    investments: null,
  };
}
