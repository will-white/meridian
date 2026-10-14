import { and, asc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import {
  addDays,
  addMonths,
  daysInMonth,
  isIsoDate,
  maxBig,
  monthKey,
  projectCashFlow,
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
 * pending, active recurring items mapped to engine items, card payment entries with the
 * ledger-derived statement balance, the remaining spending plan per month (current month
 * from the grid's remaining, future months from explicit rows or 3-month averages), trailing
 * 90-day spending weights, and the household defaults. The engine itself is pure
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

/** The engine's input minus the what-ifs, plus the loader's own notes (merged into the result's warnings). */
export interface CashFlowLoad extends Omit<CashFlowInput, "whatIfs"> {
  warnings: string[];
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
}

/**
 * Remaining planned spending (spending bucket only, hidden categories included) per month in
 * [month of today, month of endDate]. Current month: Σ max(0, planned + carriedIn − actual)
 * from the grid; future months: Σ (explicit plan row ? planned : 3-month average as of today).
 */
export async function spendingRemainingByMonth(db: DbOrTx, today: IsoDate, endDate: IsoDate): Promise<SpendingRemainingResult> {
  const currentMonth = monthKey(today);
  const plan = await getPlan(db, { from: currentMonth, to: monthKey(endDate), today });
  const spendingRows = plan.rows.filter((r): r is PlanCategoryRowResult => r.kind === "category" && r.bucket === "spending");
  let averages: Map<string, bigint> | null = null;
  const months: CashFlowSpendingMonth[] = [];
  let monthsOnAverages = 0;
  for (const [i, month] of plan.months.entries()) {
    let remainingCents = 0n;
    let usedAverage = false;
    for (const row of spendingRows) {
      const cell = row.cells[i];
      if (!cell) continue;
      if (month === currentMonth) {
        remainingCents += maxBig(0n, cell.remainingCents);
      } else if (cell.hasExplicitPlan) {
        remainingCents += cell.plannedCents;
      } else {
        if (averages === null) {
          const result = await planAverages(db, { months: SPENDING_AVERAGE_MONTHS, today });
          averages = new Map(result.averages.map((a) => [a.categoryId, a.averageCents]));
        }
        remainingCents += averages.get(row.categoryId) ?? 0n;
        usedAverage = true;
      }
    }
    if (usedAverage) monthsOnAverages++;
    months.push({ month, remainingCents });
  }
  return { months, monthsOnAverages };
}

// ---- The loader ----

/** Every read the engine needs for `[today, today + horizonDays]`; no writes. */
export async function loadCashFlowInput(db: DbOrTx, q: LoadCashFlowInputQuery): Promise<CashFlowLoad> {
  assertToday(q.today);
  assertHorizon(q.horizonDays);
  const { today } = q;
  const endDate = addDays(today, q.horizonDays);
  const warnings: string[] = [];
  const setting = await getHouseholdSetting(db, today);

  // 1. Projected accounts: on budget, open, optionally a subset; opening = posted balance + pending.
  const allAccounts = await db
    .select({
      id: account.id,
      name: account.name,
      type: account.type,
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
  const accounts: CashFlowAccount[] = projectedRows.map((a) => {
    if (a.balanceCents === null) warnings.push(`account ${a.name} has no known balance`);
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      openingCents: (a.balanceCents ?? 0n) + (pendingBy.get(a.id) ?? 0n),
      balanceDate: a.balanceDate,
      lowBalanceThresholdCents: a.lowBalanceThresholdCents,
    };
  });
  const openingOf = new Map(accounts.map((a) => [a.id, a.openingCents]));
  const cardsWithPaymentDay = new Set(allAccounts.filter((a) => a.type === "credit" && a.paymentDay !== null).map((a) => a.id));

  // 2. Active recurring items as dated events (spending-bucket items are covered by the spread).
  const items = await db
    .select({
      id: recurring.id,
      name: recurring.name,
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
  for (const item of items) {
    if (item.bucket === "spending") continue;
    const kind = recurringKind(item);
    if (kind === "transfer" && item.transferAccountId !== null && cardsWithPaymentDay.has(item.transferAccountId)) continue;
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
  }

  // 3. Card payments for projected credit accounts with a payment day.
  const cardPayments: CashFlowCardPayment[] = [];
  for (const a of projectedRows) {
    if (a.type !== "credit" || a.paymentDay === null || a.paymentFromAccountId === null) continue;
    let knownStatementBalanceCents: bigint | null = null;
    if (a.statementDay !== null) {
      const payDate = nextPaymentDate(today, a.paymentDay);
      const close = statementCloseBefore(payDate, a.statementDay);
      if (payDate <= endDate && close < today) knownStatementBalanceCents = await cardStatementBalance(db, a.id, openingOf.get(a.id) ?? 0n, close, today);
    }
    cardPayments.push({ cardAccountId: a.id, fromAccountId: a.paymentFromAccountId, payDay: a.paymentDay, statementDay: a.statementDay, knownStatementBalanceCents });
  }

  // 4. Remaining spending per month.
  const spending = await spendingRemainingByMonth(db, today, endDate);
  if (spending.monthsOnAverages > 0) {
    const n = spending.monthsOnAverages;
    warnings.push(`${n === 1 ? "1 month uses" : `${n} months use`} ${SPENDING_AVERAGE_MONTHS}-month averages for unplanned spending categories`);
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

/** Load the household's input and run the engine; loader notes come first in `warnings`. No writes. */
export async function projectForHousehold(db: DbOrTx, body: ProjectForHouseholdInput = {}): Promise<CashFlowResult> {
  const setting = await getHouseholdSetting(db, body.today);
  const today = body.today ?? householdToday(setting, body.now);
  const { warnings, ...input } = await loadCashFlowInput(db, {
    today,
    horizonDays: body.horizonDays ?? setting.projectionDefaultDays,
    ...(body.accountIds === undefined ? {} : { accountIds: body.accountIds }),
  });
  const result = projectCashFlow({
    ...input,
    defaultThresholdCents: body.thresholdCents ?? input.defaultThresholdCents,
    whatIfs: body.whatIfs ?? [],
  });
  return { ...result, warnings: [...warnings, ...result.warnings] };
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
export function toCashFlowProjectionView(r: CashFlowResult): CashFlowProjectionResponse {
  const nameOf = new Map(r.accounts.map((a) => [a.accountId, a.name]));
  return {
    today: r.today,
    endDate: r.endDate,
    dates: r.dates,
    accounts: r.accounts.map((a) => ({ ...seriesView(a), accountId: a.accountId, name: a.name, type: a.type, balanceDate: a.balanceDate })),
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
  };
}
