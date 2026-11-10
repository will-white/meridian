import { and, eq, isNotNull, sql } from "drizzle-orm";
import { addMonths, isMonthKey, minMonth, monthEnd, monthKey, type IsoDate, type MonthKey } from "@meridian/shared";
import type { Db } from "../index.js";
import { category, monthPlan, recurring, savingsGoal } from "../schema/index.js";
import { PlanError } from "./audit.js";
import { loadAutoPlans } from "./plan.js";
import { getHouseholdSetting, householdToday } from "./settings.js";

/**
 * `plan.close_month`: freeze auto-planned values (what recurring items were paid, goal
 * contributions) into month_plan rows for every completed month in [plan_start_month,
 * through], so closed months never shift when a price changes or an item is paused,
 * cancelled or resumed. Insert-if-missing: a row whose planned_cents is already set (manual,
 * average, or an earlier freeze) is never touched, so re-runs insert 0 and a missed night is
 * caught up by the next one.
 *
 * Two guards keep the frozen value true to what happened:
 * - Only completed months freeze. `through` is capped at the month before the household's
 *   current one: this month's and later months' values are still moving.
 * - A category's recurring value for a month is left live while one of its active items
 *   still awaits an occurrence due in that month or earlier (overdue, inside the cadence's
 *   grace). The charge may still arrive dated in that month (a sync lags the bank by a day or
 *   two) or in the next one; the row freezes on a later night, once the occurrence is paid or
 *   written off as missed.
 */
export async function closeMonth(db: Db, through: MonthKey, opts: { today?: IsoDate } = {}): Promise<{ inserted: number; through: MonthKey }> {
  if (!isMonthKey(through)) throw new PlanError(400, "validation", "through must be YYYY-MM");
  const setting = await getHouseholdSetting(db, opts.today);
  const today = opts.today ?? householdToday(setting);
  const last = minMonth(through, addMonths(monthKey(today), -1));
  if (last < setting.planStartMonth) return { inserted: 0, through };

  const categories = await db.select({ id: category.id, bucket: category.bucket }).from(category);
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
    if (a.source === "recurring") {
      const awaited = awaitedFrom.get(a.categoryId);
      if (awaited !== undefined && awaited <= monthEnd(a.month)) continue;
    }
    const key = `${a.categoryId}|${a.month}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, cents: prev.cents + a.cents } : { categoryId: a.categoryId, month: a.month, cents: a.cents, source: a.source });
  }
  const values = [...byKey.values()].map((v) => ({ categoryId: v.categoryId, month: v.month, plannedCents: v.cents, plannedSource: v.source }));
  if (values.length === 0) return { inserted: 0, through };

  let inserted = 0;
  await db.transaction(async (tx) => {
    const chunk = 500;
    for (let i = 0; i < values.length; i += chunk) {
      const rows = await tx
        .insert(monthPlan)
        .values(values.slice(i, i + chunk))
        .onConflictDoUpdate({
          target: [monthPlan.categoryId, monthPlan.month],
          set: { plannedCents: sql`excluded.planned_cents`, plannedSource: sql`excluded.planned_source`, updatedAt: sql`now()` },
          setWhere: sql`${monthPlan.plannedCents} is null`,
        })
        .returning({ id: monthPlan.id });
      inserted += rows.length;
    }
  });
  return { inserted, through };
}
