import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { addMonths, bucketSign, isMonthKey, minMonth, monthEnd, monthKey, monthStart, type Bucket, type IsoDate, type MonthKey } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { category, monthPlan, recurring, savingsGoal, transaction } from "../schema/index.js";
import { PlanError } from "./audit.js";
import { loadAutoPlans, PLANNED_RECURRING_STATUSES } from "./plan.js";
import { getHouseholdSetting, householdToday } from "./settings.js";

/** A charge linked to an item that plans (active, paused, cancelled), with what one occurrence of that item is worth. */
interface LinkedCharge {
  id: string;
  date: IsoDate;
  pending: boolean;
  categoryId: string;
  expectedCents: bigint;
}

const cellKey = (categoryId: string, month: MonthKey): string => `${categoryId}|${month}`;

/** How Postgres prints a uuid[]: what `frozen_charge_ids` is compared with before it is replaced. */
const uuidArrayText = (ids: readonly string[]): string => `{${ids.join(",")}}`;

/** The linked charges dated in [from, to] of every planning item with a category, by (item category, month). */
async function linkedChargesByCell(db: DbOrTx, from: MonthKey, to: MonthKey): Promise<Map<string, LinkedCharge[]>> {
  const rows = await db
    .select({ id: transaction.id, date: transaction.date, pending: transaction.pending, categoryId: recurring.categoryId, expectedCents: recurring.expectedCents })
    .from(transaction)
    .innerJoin(recurring, eq(recurring.id, transaction.recurringId))
    .where(and(inArray(recurring.status, [...PLANNED_RECURRING_STATUSES]), isNotNull(recurring.categoryId), gte(transaction.date, monthStart(from)), lte(transaction.date, monthEnd(to))));
  const out = new Map<string, LinkedCharge[]>();
  for (const r of rows) {
    if (r.categoryId === null) continue;
    const k = cellKey(r.categoryId, monthKey(r.date));
    const list = out.get(k) ?? [];
    list.push({ ...r, categoryId: r.categoryId });
    out.set(k, list);
  }
  return out;
}

/**
 * `plan.close_month`: freeze auto-planned values (what recurring items were paid, goal
 * contributions) into month_plan rows for every completed month in [plan_start_month,
 * through], so closed months never shift when a price changes or an item is paused,
 * cancelled or resumed. Insert-if-missing: a row whose planned_cents is already set (manual,
 * average, or an earlier freeze) is never replaced, so re-runs insert 0 and a missed night is
 * caught up by the next one.
 *
 * Three guards keep the frozen value true to what happened:
 * - Only completed months freeze. `through` is capped at the month before the household's
 *   current one: this month's and later months' values are still moving.
 * - A category's recurring value for a month is left live while one of its active items
 *   still awaits an occurrence due in that month or earlier (overdue, inside the cadence's
 *   grace). The charge may still arrive dated in that month (a sync lags the bank by a day or
 *   two) or in the next one; the row freezes on a later night, once the occurrence is paid or
 *   written off as missed.
 * - It is also left live while a charge linked to one of its items and dated in that month is
 *   still pending: the bank may post it on a later date, in the next month (audit
 *   b1-plan-math, second round). The feed replaces or drops a pending row, so the wait ends.
 *
 * A value frozen from recurring items records the linked charges it counts
 * (`frozen_charge_ids`). A posted charge dated in a closed month that no frozen row counts yet
 * (the next occurrence paid early, dated in the month, that synced after the freeze; a CSV
 * import; a link made later) is added on a later run at its item's expected amount
 * (`extended`), so the month keeps what was paid in it while the occurrences it counted keep
 * their price. Nothing is taken out: a charge that leaves the month or its item stays counted.
 */
export async function closeMonth(db: Db, through: MonthKey, opts: { today?: IsoDate } = {}): Promise<{ inserted: number; extended: number; through: MonthKey }> {
  if (!isMonthKey(through)) throw new PlanError(400, "validation", "through must be YYYY-MM");
  const setting = await getHouseholdSetting(db, opts.today);
  const today = opts.today ?? householdToday(setting);
  const last = minMonth(through, addMonths(monthKey(today), -1));
  if (last < setting.planStartMonth) return { inserted: 0, extended: 0, through };

  const categories = await db.select({ id: category.id, bucket: category.bucket }).from(category);
  const bucketOf = new Map<string, Bucket>(categories.map((c) => [c.id, c.bucket]));
  const goals = await db
    .select({
      categoryId: savingsGoal.categoryId,
      monthlyContributionCents: savingsGoal.monthlyContributionCents,
      startMonth: savingsGoal.startMonth,
      targetDate: savingsGoal.targetDate,
      status: savingsGoal.status,
    })
    .from(savingsGoal);
  const autoPlans = await loadAutoPlans(db, { from: setting.planStartMonth, to: last, today, categories, goals });
  const charges = await linkedChargesByCell(db, setting.planStartMonth, last);

  // Per category, the earliest occurrence an active item still waits for.
  const awaiting = await db
    .select({ categoryId: recurring.categoryId, nextDueDate: sql<string>`min(${recurring.nextDueDate})::text` })
    .from(recurring)
    .where(and(eq(recurring.status, "active"), isNotNull(recurring.categoryId), isNotNull(recurring.nextDueDate)))
    .groupBy(recurring.categoryId);
  const awaitedFrom = new Map<string, IsoDate>();
  for (const a of awaiting) if (a.categoryId !== null) awaitedFrom.set(a.categoryId, a.nextDueDate);

  // One value per (category, month); the engine sums duplicates the same way.
  const byKey = new Map<string, { categoryId: string; month: MonthKey; cents: bigint; source: "recurring" | "goal" }>();
  for (const a of autoPlans) {
    if (a.cents <= 0n) continue;
    const k = cellKey(a.categoryId, a.month);
    if (a.source === "recurring") {
      const awaited = awaitedFrom.get(a.categoryId);
      if (awaited !== undefined && awaited <= monthEnd(a.month)) continue;
      if ((charges.get(k) ?? []).some((c) => c.pending)) continue;
    }
    const prev = byKey.get(k);
    byKey.set(k, prev ? { ...prev, cents: prev.cents + a.cents } : { categoryId: a.categoryId, month: a.month, cents: a.cents, source: a.source });
  }
  const values = [...byKey.values()].map((v) => ({
    categoryId: v.categoryId,
    month: v.month,
    plannedCents: v.cents,
    plannedSource: v.source,
    frozenChargeIds: v.source === "recurring" ? (charges.get(cellKey(v.categoryId, v.month)) ?? []).map((c) => c.id).sort() : null,
  }));

  let inserted = 0;
  let extended = 0;
  await db.transaction(async (tx) => {
    const chunk = 500;
    for (let i = 0; i < values.length; i += chunk) {
      const rows = await tx
        .insert(monthPlan)
        .values(values.slice(i, i + chunk))
        .onConflictDoUpdate({
          target: [monthPlan.categoryId, monthPlan.month],
          set: { plannedCents: sql`excluded.planned_cents`, plannedSource: sql`excluded.planned_source`, frozenChargeIds: sql`excluded.frozen_charge_ids`, updatedAt: sql`now()` },
          setWhere: sql`${monthPlan.plannedCents} is null`,
        })
        .returning({ id: monthPlan.id });
      inserted += rows.length;
    }
    extended = await extendFrozenRows(tx, setting.planStartMonth, last, charges, bucketOf);
  });
  return { inserted, extended, through };
}

/**
 * Add to each row close_month froze from recurring items the posted charges dated in its month
 * that no frozen row counts yet, at each charge's item's expected amount in the category's
 * direction (a planned value never goes below 0). A pending charge waits until it posts. A row
 * changed meanwhile (the compare on `frozen_charge_ids`) is left for the next run.
 */
async function extendFrozenRows(tx: DbOrTx, from: MonthKey, to: MonthKey, charges: ReadonlyMap<string, readonly LinkedCharge[]>, bucketOf: ReadonlyMap<string, Bucket>): Promise<number> {
  const frozen = await tx
    .select({ id: monthPlan.id, categoryId: monthPlan.categoryId, month: monthPlan.month, plannedCents: monthPlan.plannedCents, frozenChargeIds: monthPlan.frozenChargeIds })
    .from(monthPlan)
    .where(and(eq(monthPlan.plannedSource, "recurring"), isNotNull(monthPlan.plannedCents), isNotNull(monthPlan.frozenChargeIds)));
  // A charge is counted by one frozen row at most: one whose item or date changed after its freeze is not added again elsewhere.
  const counted = new Set(frozen.flatMap((r) => r.frozenChargeIds ?? []));
  let extended = 0;
  for (const row of frozen) {
    if (row.month < from || row.month > to || row.plannedCents === null || row.frozenChargeIds === null) continue;
    const bucket = bucketOf.get(row.categoryId);
    if (bucket === undefined) continue;
    const late = (charges.get(cellKey(row.categoryId, row.month)) ?? []).filter((c) => !c.pending && !counted.has(c.id));
    if (late.length === 0) continue;
    const next = late.reduce((sum, c) => sum + bucketSign(bucket) * c.expectedCents, row.plannedCents);
    const ids = [...row.frozenChargeIds, ...late.map((c) => c.id)].sort();
    const updated = await tx
      .update(monthPlan)
      .set({ plannedCents: next > 0n ? next : 0n, frozenChargeIds: ids, updatedAt: new Date() })
      .where(and(eq(monthPlan.id, row.id), eq(monthPlan.plannedSource, "recurring"), sql`${monthPlan.frozenChargeIds}::text = ${uuidArrayText(row.frozenChargeIds)}`))
      .returning({ id: monthPlan.id });
    if (updated.length === 0) continue;
    for (const c of late) counted.add(c.id);
    extended++;
  }
  return extended;
}
