import { closeMonth, getHouseholdSetting, householdToday, type JobRow } from "@meridian/db";
import { addMonths, isMonthKey, minMonth, monthKey, type IsoDate, type MonthKey } from "@meridian/shared";
import type { JobContext } from "./context.js";

export interface CloseMonthOutcome {
  today: IsoDate;
  through: MonthKey;
  inserted: number;
  /** Frozen cells that gained a linked charge dated in their month that reached the ledger later. */
  extended: number;
}

/**
 * `plan.close_month`: freeze auto-planned values (recurring occurrences, goal
 * contributions) into month_plan rows for every completed month through the month
 * before the household's current one. An optional `through` in the payload is honoured
 * but never reaches the current month. Idempotent and insert-if-missing, so a missed
 * night is caught up by the next one and manual or averaged rows are never overwritten;
 * a cell it froze from recurring items gains a charge dated in its month that reached the
 * ledger later (`closeMonth` in @meridian/db).
 */
export async function runCloseMonthJob(ctx: JobContext, job: JobRow): Promise<CloseMonthOutcome> {
  const setting = await getHouseholdSetting(ctx.db);
  const today = householdToday(setting, ctx.now());
  const lastCompleted = addMonths(monthKey(today), -1);
  const requested = job.payload["through"];
  const through = typeof requested === "string" && isMonthKey(requested) ? minMonth(requested, lastCompleted) : lastCompleted;
  const result = await closeMonth(ctx.db, through, { today });
  return { today, through: result.through, inserted: result.inserted, extended: result.extended };
}
