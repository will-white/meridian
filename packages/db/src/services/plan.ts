import { and, asc, eq, gte, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import {
  addMonths,
  assignGoalNets,
  averageWindow,
  bucketSign,
  computePlan,
  firstFullLedgerMonth,
  isMonthKey,
  maxMonth,
  minMonth,
  monthDiff,
  monthEnd,
  monthKey,
  monthRange,
  monthStart,
  planAverage,
  recurringPlanCounts,
  toIsoDate,
  type AccountTransferNetInput,
  type ActualInput,
  type AutoPlanInput,
  type Bucket,
  type ComputePlanInput,
  type GoalAccountLink,
  type GoalInput,
  type GoalNetInput,
  type IsoDate,
  type MonthKey,
  type MonthPlanRowInput,
  type PlanCategoryInput,
  type PlanGroupInput,
  type PlanResult,
  type RolloverMode,
  type Schedule,
  type UncategorizedInput,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, category, categoryGroup, monthPlan, recurring, savingsGoal, split, transaction } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { onBudgetOrFeedCategory } from "./planScope.js";
import { getHouseholdSetting } from "./settings.js";
import { listTransactions, type ListTransactionsQuery, type TransactionListRow } from "./transactions.js";

/**
 * Persistence for the spending plan: loads the pure engine's inputs (one GROUP BY
 * over the ledger, month_plan rows, recurring occurrences, goals), writes plan
 * cells with audit, and serves averages and drill-downs. Carried-in is never
 * stored; every read re-folds the chains (docs/phase-2-plan.md §2).
 */

export const MAX_PLAN_MONTHS = 24;
export const MAX_PLAN_EDITS = 600;

export interface PlanRangeQuery {
  from: MonthKey;
  to: MonthKey;
  today: IsoDate;
}

// ---- Loaders ----

function assertMonth(m: string, what: string): void {
  if (!isMonthKey(m)) throw new PlanError(400, "validation", `${what} must be YYYY-MM`);
}

function scheduleOf(row: typeof recurring.$inferSelect): Schedule {
  return { cadence: row.cadence, anchorDay: row.anchorDay, anchorDay2: row.anchorDay2, anchorMonth: row.anchorMonth, anchorDate: row.anchorDate };
}

async function loadGroups(db: DbOrTx): Promise<PlanGroupInput[]> {
  return db
    .select({ id: categoryGroup.id, name: categoryGroup.name, bucket: categoryGroup.bucket, position: categoryGroup.position, hidden: categoryGroup.hidden })
    .from(categoryGroup);
}

async function loadCategories(db: DbOrTx): Promise<PlanCategoryInput[]> {
  return db
    .select({
      id: category.id,
      name: category.name,
      bucket: category.bucket,
      groupId: category.groupId,
      position: category.position,
      hidden: category.hidden,
      rolloverMode: category.rolloverMode,
      rolloverFromMonth: category.rolloverFromMonth,
      goalId: savingsGoal.id,
    })
    .from(category)
    .leftJoin(savingsGoal, eq(savingsGoal.categoryId, category.id));
}

async function loadGoals(db: DbOrTx): Promise<GoalInput[]> {
  return db
    .select({
      id: savingsGoal.id,
      categoryId: savingsGoal.categoryId,
      name: savingsGoal.name,
      targetCents: savingsGoal.targetCents,
      targetDate: savingsGoal.targetDate,
      linkedAccountId: savingsGoal.linkedAccountId,
      linkedAccountName: account.name,
      monthlyContributionCents: savingsGoal.monthlyContributionCents,
      startMonth: savingsGoal.startMonth,
      startingCents: savingsGoal.startingCents,
      status: savingsGoal.status,
    })
    .from(savingsGoal)
    .leftJoin(account, eq(account.id, savingsGoal.linkedAccountId))
    .orderBy(asc(savingsGoal.createdAt), asc(savingsGoal.id));
}

async function loadRows(db: DbOrTx, fromMonth: MonthKey, toMonth: MonthKey): Promise<MonthPlanRowInput[]> {
  const rows = await db
    .select()
    .from(monthPlan)
    .where(and(gte(monthPlan.month, fromMonth), sql`${monthPlan.month} <= ${toMonth}`));
  return rows.map((r) => ({
    categoryId: r.categoryId,
    month: r.month,
    plannedCents: r.plannedCents,
    plannedSource: r.plannedSource,
    rolloverMode: r.rolloverMode,
    carriedInOverrideCents: r.carriedInOverrideCents,
    note: r.note,
  }));
}

/** Categorized non-transfer rows (splits replace their parent), signed, per (category, month). [lo, hi) are dates. */
async function loadActuals(db: DbOrTx, lo: IsoDate, hi: IsoDate): Promise<ActualInput[]> {
  const cat = sql<string>`coalesce(${split.categoryId}, ${transaction.categoryId})`;
  const month = sql<string>`to_char(${transaction.date}, 'YYYY-MM')`;
  const amount = sql`coalesce(${split.amountCents}, ${transaction.amountCents})`;
  return db
    .select({
      categoryId: cat,
      month,
      signedCents: sql<bigint>`sum(${amount})::bigint`,
      pendingSignedCents: sql<bigint>`sum(case when ${transaction.pending} then ${amount} else 0 end)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .leftJoin(split, eq(split.transactionId, transaction.id))
    .where(and(eq(transaction.isTransfer, false), gte(transaction.date, lo), lt(transaction.date, hi), isNotNull(cat), onBudgetOrFeedCategory(cat)))
    .groupBy(cat, month);
}

/** The goals' link data in creation order (the tie order of `goalForAccountMonth`). */
async function loadGoalLinks(db: DbOrTx): Promise<GoalAccountLink[]> {
  return db
    .select({ id: savingsGoal.id, linkedAccountId: savingsGoal.linkedAccountId, startMonth: savingsGoal.startMonth, status: savingsGoal.status })
    .from(savingsGoal)
    .orderBy(asc(savingsGoal.createdAt), asc(savingsGoal.id));
}

/**
 * Net transfer legs (+ in, − out) per goal and month. The legs of a linked account are summed
 * once per (account, month) and handed to the one goal that owns that account in that month
 * (`assignGoalNets`), so two goals that share an account never both count the same transfer.
 */
async function loadGoalNets(db: DbOrTx, lo: IsoDate, hi: IsoDate, goals: readonly GoalAccountLink[]): Promise<GoalNetInput[]> {
  const accountIds = [...new Set(goals.map((g) => g.linkedAccountId).filter((id): id is string => id !== null))];
  if (accountIds.length === 0) return [];
  const month = sql<string>`to_char(${transaction.date}, 'YYYY-MM')`;
  const nets: AccountTransferNetInput[] = await db
    .select({
      accountId: transaction.accountId,
      month,
      signedCents: sql<bigint>`sum(${transaction.amountCents})::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(transaction)
    .where(and(eq(transaction.isTransfer, true), inArray(transaction.accountId, accountIds), gte(transaction.date, lo), lt(transaction.date, hi)))
    .groupBy(transaction.accountId, month);
  return assignGoalNets(nets, goals);
}

/** Uncategorized non-transfer rows (a split parent is categorized through its splits). */
async function loadUncategorized(db: DbOrTx, lo: IsoDate, hi: IsoDate): Promise<UncategorizedInput[]> {
  const month = sql<string>`to_char(${transaction.date}, 'YYYY-MM')`;
  return db
    .select({ month, count: sql<number>`count(*)::int`, signedCents: sql<bigint>`sum(${transaction.amountCents})::bigint` })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .where(
      and(
        sql`${transaction.categoryId} is null`,
        eq(transaction.isTransfer, false),
        gte(transaction.date, lo),
        lt(transaction.date, hi),
        notExists(db.select({ one: sql`1` }).from(split).where(eq(split.transactionId, transaction.id))),
        onBudgetOrFeedCategory(sql`${transaction.categoryId}`),
      ),
    )
    .groupBy(month);
}

export interface LoadAutoPlansQuery {
  from: MonthKey;
  to: MonthKey;
  /** Decides which months are completed (only what was paid stays planned) and which are still ahead. */
  today: IsoDate;
  /** Every category's bucket: the sign that turns an item's expected amount into a planned magnitude. */
  categories: ReadonlyArray<{ id: string; bucket: Bucket }>;
  goals: ReadonlyArray<Pick<GoalInput, "categoryId" | "monthlyContributionCents" | "startMonth" | "targetDate" | "status">>;
}

/** Items the user confirmed at some point; suggestions and dismissed series never plan. */
const PLANNED_RECURRING_STATUSES = ["active", "paused", "cancelled"] as const;

/**
 * Auto-planned values per (category, month) in [from, to] (docs/phase-2-plan.md decisions 3
 * and 13).
 *
 * Recurring: every confirmed item plans in its own category, whatever the bucket. Its
 * occurrences come from `recurringPlanCounts`: a linked charge plans in the month it posted,
 * an active item's unpaid occurrences are planned ahead from the day it began to be expected,
 * and a completed month keeps only what was paid in it. Each occurrence adds the item's
 * expected amount in the bucket's direction (an outflow in a bills, savings or spending
 * category, an inflow in an income category); an item running the other way (a recurring
 * refund in a spending category) nets against the category's other items, and a month whose
 * net is not positive plans nothing.
 *
 * Goals: an active goal contributes monthly_contribution_cents from start_month through the
 * target month. Where a goal plans a month, recurring items in its category are not added on
 * top (the recurring transfer that funds a goal is the same money).
 */
export async function loadAutoPlans(db: DbOrTx, q: LoadAutoPlansQuery): Promise<AutoPlanInput[]> {
  const out: AutoPlanInput[] = [];
  if (q.from > q.to) return out;
  const bucketOf = new Map(q.categories.map((c) => [c.id, c.bucket]));
  const key = (categoryId: string, month: MonthKey): string => `${categoryId}|${month}`;

  const goalKeys = new Set<string>();
  for (const g of q.goals) {
    if (g.status !== "active" || g.monthlyContributionCents <= 0n) continue;
    const last = g.targetDate === null ? q.to : minMonth(q.to, monthKey(g.targetDate));
    const first = maxMonth(q.from, g.startMonth);
    if (first > last) continue;
    for (const m of monthRange(first, last)) {
      out.push({ categoryId: g.categoryId, month: m, cents: g.monthlyContributionCents, source: "goal" });
      goalKeys.add(key(g.categoryId, m));
    }
  }

  const items = await db
    .select()
    .from(recurring)
    .where(and(inArray(recurring.status, [...PLANNED_RECURRING_STATUSES]), isNotNull(recurring.categoryId)));
  if (items.length === 0) return out;
  const links = await db
    .select({ recurringId: transaction.recurringId, date: transaction.date })
    .from(transaction)
    .where(
      inArray(
        transaction.recurringId,
        items.map((i) => i.id),
      ),
    );
  const chargeDates = new Map<string, IsoDate[]>();
  for (const l of links) {
    if (l.recurringId === null) continue;
    const list = chargeDates.get(l.recurringId) ?? [];
    list.push(l.date);
    chargeDates.set(l.recurringId, list);
  }

  const byKey = new Map<string, bigint>();
  for (const item of items) {
    const categoryId = item.categoryId;
    const bucket = categoryId === null ? undefined : bucketOf.get(categoryId);
    if (categoryId === null || bucket === undefined || item.status === "suggested" || item.status === "dismissed") continue;
    const naturalCents = bucketSign(bucket) * item.expectedCents;
    if (naturalCents === 0n) continue;
    const counts = recurringPlanCounts(
      {
        schedule: scheduleOf(item),
        status: item.status,
        expectedFrom: item.missedFromDate ?? item.firstChargeDate ?? monthStart(monthKey(toIsoDate(item.createdAt))),
        nextDueDate: item.nextDueDate,
        chargeDates: chargeDates.get(item.id) ?? [],
      },
      { from: q.from, to: q.to, today: q.today },
    );
    for (const [month, n] of counts) {
      const k = key(categoryId, month);
      byKey.set(k, (byKey.get(k) ?? 0n) + naturalCents * BigInt(n));
    }
  }
  for (const [k, cents] of byKey) {
    if (cents <= 0n || goalKeys.has(k)) continue;
    const [categoryId, month] = k.split("|") as [string, string];
    out.push({ categoryId, month, cents, source: "recurring" });
  }
  return out;
}

/**
 * Everything computePlan needs for [from, to], with actuals from the earliest
 * chain/goal start through the current month. No span limit here (goal history
 * can reach back years); `getPlan` applies the grid's 24-month cap.
 */
export async function loadPlanInput(db: DbOrTx, q: PlanRangeQuery): Promise<ComputePlanInput> {
  assertMonth(q.from, "from");
  assertMonth(q.to, "to");
  if (q.from > q.to) throw new PlanError(400, "validation", "from must not be after to");

  const setting = await getHouseholdSetting(db, q.today);
  const currentMonth = monthKey(q.today);
  const groups = await loadGroups(db);
  const categories = await loadCategories(db);
  const goals = await loadGoals(db);

  let loMonth = minMonth(q.from, setting.planStartMonth);
  for (const g of goals) loMonth = minMonth(loMonth, g.startMonth);
  const hiMonth = maxMonth(q.to, currentMonth);
  const lo = monthStart(loMonth);
  const hi = monthStart(addMonths(hiMonth, 1));

  const rows = await loadRows(db, loMonth, hiMonth);
  const actuals = await loadActuals(db, lo, hi);
  const goalNets = await loadGoalNets(db, lo, hi, goals);
  const uncategorized = await loadUncategorized(db, monthStart(q.from), monthStart(addMonths(q.to, 1)));
  const autoPlans = await loadAutoPlans(db, { from: loMonth, to: hiMonth, today: q.today, categories, goals });

  return {
    startMonth: setting.planStartMonth,
    from: q.from,
    to: q.to,
    today: q.today,
    zeroBased: setting.zeroBased,
    groups,
    categories,
    rows,
    actuals,
    goalNets,
    autoPlans,
    goals,
    uncategorized,
  };
}

/** The range rules every grid read shares: valid month keys, at most 24 months, from 2000-01 on. */
export function assertPlanRange(from: MonthKey, to: MonthKey): void {
  assertMonth(from, "from");
  assertMonth(to, "to");
  if (from <= to && monthDiff(from, to) + 1 > MAX_PLAN_MONTHS) throw new PlanError(400, "validation", `At most ${MAX_PLAN_MONTHS} months`);
  if (from < "2000-01") throw new PlanError(400, "validation", "from must be 2000-01 or later");
}

/** The grid for [from, to] (at most 24 months, from 2000-01 on): computePlan over loadPlanInput. */
export async function getPlan(db: DbOrTx, q: PlanRangeQuery): Promise<PlanResult> {
  assertPlanRange(q.from, q.to);
  return computePlan(await loadPlanInput(db, q));
}

// ---- Writes ----

export interface PlanCellEditInput {
  month: MonthKey;
  categoryId: string;
  /** undefined = untouched; null = clear (the auto value shows through); else the explicit magnitude. */
  plannedCents?: bigint | null;
  /** How the stored value came to be; default manual. */
  source?: "manual" | "average";
  /** Per-month override of the carry OUT of this month; null clears it. */
  rolloverMode?: RolloverMode | null;
  /** Pins this month's carried-in; null clears it. */
  carriedInOverrideCents?: bigint | null;
  note?: string | null;
}

type MonthPlanRow = typeof monthPlan.$inferSelect;

interface CellState {
  plannedCents: bigint | null;
  plannedSource: MonthPlanRow["plannedSource"];
  rolloverMode: RolloverMode | null;
  carriedInOverrideCents: bigint | null;
  note: string | null;
}

/** Audit shape of a plan cell: the stored columns, cents as strings. */
export function planCellAuditJson(row: CellState) {
  return {
    plannedCents: row.plannedCents === null ? null : row.plannedCents.toString(),
    source: row.plannedSource,
    rolloverMode: row.rolloverMode,
    carriedInOverrideCents: row.carriedInOverrideCents === null ? null : row.carriedInOverrideCents.toString(),
    note: row.note,
  };
}

const cellKey = (month: MonthKey, categoryId: string): string => `${month}:${categoryId}`;

/**
 * Apply plan cell edits inside the caller's transaction, in the caller's audit batch. Per
 * edit: the row is upserted with the patched columns, deleted when every nullable column
 * ends up null, and audited (create/update/delete) only when something changed.
 * Errors: 404 unknown category, 400 `before_plan_start`, 400 `income_no_rollover`.
 */
export async function applyPlanCellEdits(tx: DbOrTx, edits: readonly PlanCellEditInput[], ctx: AuditContext & { today?: IsoDate }): Promise<{ changed: number }> {
  if (edits.length === 0) return { changed: 0 };
  const setting = await getHouseholdSetting(tx, ctx.today);
  const ids = [...new Set(edits.map((e) => e.categoryId))];
  const cats = await tx.select({ id: category.id, bucket: category.bucket }).from(category).where(inArray(category.id, ids));
  const bucketOf = new Map(cats.map((c) => [c.id, c.bucket]));
  const audit: AuditContext = { userId: ctx.userId, batchId: ctx.batchId };
  let changed = 0;

  for (const edit of edits) {
    const bucket = bucketOf.get(edit.categoryId);
    if (!bucket) throw new PlanError(404, "not_found", "Category not found");
    if (edit.month < setting.planStartMonth) throw new PlanError(400, "before_plan_start", `Month ${edit.month} is before the plan start month ${setting.planStartMonth}`);
    const setsRollover = edit.rolloverMode !== undefined && edit.rolloverMode !== null;
    const setsOverride = edit.carriedInOverrideCents !== undefined && edit.carriedInOverrideCents !== null;
    if (bucket === "income" && (setsRollover || setsOverride)) throw new PlanError(400, "income_no_rollover", "Income categories cannot roll over");

    const [existing] = await tx
      .select()
      .from(monthPlan)
      .where(and(eq(monthPlan.categoryId, edit.categoryId), eq(monthPlan.month, edit.month)));

    const next: CellState = {
      plannedCents: edit.plannedCents === undefined ? (existing?.plannedCents ?? null) : edit.plannedCents,
      plannedSource: edit.plannedCents === undefined ? (existing?.plannedSource ?? null) : edit.plannedCents === null ? null : (edit.source ?? "manual"),
      rolloverMode: edit.rolloverMode === undefined ? (existing?.rolloverMode ?? null) : edit.rolloverMode,
      carriedInOverrideCents: edit.carriedInOverrideCents === undefined ? (existing?.carriedInOverrideCents ?? null) : edit.carriedInOverrideCents,
      note: edit.note === undefined ? (existing?.note ?? null) : edit.note === null ? null : edit.note.trim() || null,
    };
    const empty = next.plannedCents === null && next.rolloverMode === null && next.carriedInOverrideCents === null && next.note === null;
    const entityId = cellKey(edit.month, edit.categoryId);

    if (empty) {
      if (!existing) continue;
      await tx.delete(monthPlan).where(eq(monthPlan.id, existing.id));
      await writeAudit(tx, { ...audit, entity: "month_plan", entityId, action: "delete", before: planCellAuditJson(existing), after: null });
      changed++;
      continue;
    }
    if (!existing) {
      await tx.insert(monthPlan).values({ categoryId: edit.categoryId, month: edit.month, ...next });
      await writeAudit(tx, { ...audit, entity: "month_plan", entityId, action: "create", before: null, after: planCellAuditJson(next) });
      changed++;
      continue;
    }
    const before = planCellAuditJson(existing);
    const after = planCellAuditJson(next);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    await tx.update(monthPlan).set({ ...next, updatedAt: new Date() }).where(eq(monthPlan.id, existing.id));
    await writeAudit(tx, { ...audit, entity: "month_plan", entityId, action: "update", before, after });
    changed++;
  }
  return { changed };
}

/**
 * Apply plan cell edits in one transaction and one audit batch (see `applyPlanCellEdits`).
 * Errors: 404 unknown category, 400 `before_plan_start`, 400 `income_no_rollover`,
 * 400 `validation` (negative cents, bad month, too many edits).
 */
export async function setPlanCells(db: Db, edits: readonly PlanCellEditInput[], ctx: AuditContext & { today?: IsoDate }): Promise<{ changed: number }> {
  if (edits.length === 0) return { changed: 0 };
  if (edits.length > MAX_PLAN_EDITS) throw new PlanError(400, "validation", `At most ${MAX_PLAN_EDITS} edits per call`);
  for (const e of edits) {
    assertMonth(e.month, "month");
    if (e.plannedCents !== undefined && e.plannedCents !== null && e.plannedCents < 0n) throw new PlanError(400, "validation", "plannedCents must not be negative");
  }
  return db.transaction((tx) => applyPlanCellEdits(tx, edits, ctx));
}

// ---- Averages ----

export interface PlanAveragesInput {
  months: 3 | 6 | 12;
  /** Window = [asOf − months, asOf − 1]; defaults to the month of `today`. */
  asOf?: MonthKey;
  today: IsoDate;
}

export interface PlanAveragesResult {
  window: { from: MonthKey; to: MonthKey; monthsWithData: number };
  averages: Array<{ categoryId: string; averageCents: bigint }>;
}

/**
 * Every category's average bucket-natural actual (goal nets included) over the window,
 * divided by the window months the plan's ledger covers in full, truncated toward zero and
 * clamped at 0. The ledger here is what the plan reads (on-budget accounts): its earliest
 * month counts only when its first transaction is dated the 1st (`firstFullLedgerMonth`), so
 * the partial month a first sync brings in never drags the averages down, and a brokerage's
 * older history never adds empty months to the divisor.
 */
export async function planAverages(db: DbOrTx, q: PlanAveragesInput): Promise<PlanAveragesResult> {
  const asOf = q.asOf ?? monthKey(q.today);
  assertMonth(asOf, "asOf");
  const window = averageWindow(asOf, q.months);
  const [earliest] = await db
    .select({ min: sql<string | null>`min(${transaction.date})::text` })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .where(eq(account.onBudget, true));
  const firstLedgerMonth = firstFullLedgerMonth(earliest?.min ?? null);
  const monthsWithData = firstLedgerMonth === null ? 0 : monthRange(window.from, window.to).filter((m) => m >= firstLedgerMonth).length;

  const categories = await loadCategories(db);
  const lo = monthStart(window.from);
  const hi = monthStart(addMonths(window.to, 1));
  const actuals = await loadActuals(db, lo, hi);
  const goalNets = await loadGoalNets(db, lo, hi, await loadGoalLinks(db));

  const byCategory = new Map<string, Map<MonthKey, bigint>>();
  const add = (categoryId: string, month: MonthKey, cents: bigint) => {
    const m = byCategory.get(categoryId) ?? new Map<MonthKey, bigint>();
    m.set(month, (m.get(month) ?? 0n) + cents);
    byCategory.set(categoryId, m);
  };
  const goalCategory = new Map(categories.filter((c) => c.goalId !== null).map((c) => [c.goalId!, c.id]));
  const bucketOf = new Map(categories.map((c) => [c.id, c.bucket]));
  for (const a of actuals) {
    const bucket = bucketOf.get(a.categoryId);
    if (!bucket) continue;
    add(a.categoryId, a.month, bucketSign(bucket) * a.signedCents);
  }
  for (const g of goalNets) {
    const categoryId = goalCategory.get(g.goalId);
    if (categoryId) add(categoryId, g.month, g.signedCents);
  }

  const averages = categories.map((c) => ({
    categoryId: c.id,
    averageCents: planAverage(byCategory.get(c.id) ?? new Map(), window, firstLedgerMonth).cents,
  }));
  return { window: { ...window, monthsWithData }, averages };
}

// ---- Drill-down ----

export interface PlanTransactionsQuery {
  month: MonthKey;
  /** The category's non-transfer rows in the month. */
  categoryId?: string;
  /** The goal's rows: its category plus transfer legs in its linked account. */
  goalId?: string;
  /** Uncategorized non-transfer rows in the month. */
  uncategorized?: boolean;
  limit?: number;
  cursor?: string;
}

/**
 * The register rows behind a cell (category, goal, or the uncategorized badge), in the plan's
 * scope: the same on-budget rule and split handling as the cell's actual. A goal's rows are
 * its category's rows plus the transfer legs in its linked account for the months the goal
 * owns that account (`goalOwnedMonthRanges`).
 */
export async function listPlanTransactions(db: DbOrTx, q: PlanTransactionsQuery): Promise<{ items: TransactionListRow[]; nextCursor: string | null }> {
  assertMonth(q.month, "month");
  const base: ListTransactionsQuery = {
    from: monthStart(q.month),
    to: monthEnd(q.month),
    limit: q.limit ?? 200,
    planScope: true,
    ...(q.cursor ? { cursor: q.cursor } : {}),
  };
  if (q.goalId) return listTransactions(db, { ...base, goalId: q.goalId });
  if (q.uncategorized) return listTransactions(db, { ...base, uncategorized: true });
  if (q.categoryId) return listTransactions(db, { ...base, categoryId: q.categoryId, transfers: "exclude" });
  throw new PlanError(400, "validation", "categoryId, goalId or uncategorized is required");
}
