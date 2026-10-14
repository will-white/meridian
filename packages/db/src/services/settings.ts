import { eq, sql } from "drizzle-orm";
import { enqueueJob } from "./jobs.js";
import { isMonthKey, localDateInTimeZone, monthKey, type IsoDate, type MonthKey } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { householdSetting, transaction } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";

/**
 * The household_setting singleton (id = 1): plan start month, zero-based toggle,
 * cash-flow defaults and the household time zone. Created on first read.
 */

export type HouseholdSettingRow = typeof householdSetting.$inferSelect;

export const DEFAULT_TIMEZONE = "America/Denver";

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The household's calendar date for an instant (server default for `today`; worker jobs use it too). */
export function householdToday(setting: Pick<HouseholdSettingRow, "timezone">, now: Date = new Date()): IsoDate {
  return localDateInTimeZone(now, isValidTimeZone(setting.timezone) ? setting.timezone : DEFAULT_TIMEZONE);
}

/**
 * Read the singleton, creating it on first use with plan_start_month = the month of
 * the earliest transaction, or the current month when the ledger is empty.
 */
export async function getHouseholdSetting(db: DbOrTx, today?: IsoDate): Promise<HouseholdSettingRow> {
  const [existing] = await db.select().from(householdSetting).where(eq(householdSetting.id, 1));
  if (existing) return existing;
  const [earliest] = await db.select({ min: sql<string | null>`min(${transaction.date})::text` }).from(transaction);
  const planStartMonth = earliest?.min ? monthKey(earliest.min) : monthKey(today ?? localDateInTimeZone(new Date(), DEFAULT_TIMEZONE));
  const [inserted] = await db.insert(householdSetting).values({ id: 1, planStartMonth }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const [row] = await db.select().from(householdSetting).where(eq(householdSetting.id, 1));
  return row!;
}

export interface HouseholdSettingPatch {
  planStartMonth?: MonthKey;
  zeroBased?: boolean;
  lowBalanceThresholdCents?: bigint;
  primaryAccountId?: string | null;
  projectionDefaultDays?: number;
  timezone?: string;
}

/** Audit shape: the view without `updatedAt`, so an unchanged patch writes nothing. */
export function householdSettingAuditJson(row: HouseholdSettingRow) {
  return {
    planStartMonth: row.planStartMonth,
    zeroBased: row.zeroBased,
    lowBalanceThresholdCents: row.lowBalanceThresholdCents.toString(),
    primaryAccountId: row.primaryAccountId,
    projectionDefaultDays: row.projectionDefaultDays,
    timezone: row.timezone,
  };
}

/** Apply a settings patch and audit it (entity household_setting, entity id "1"). */
export async function updateHouseholdSetting(db: Db, patch: HouseholdSettingPatch, ctx: AuditContext & { today?: IsoDate }): Promise<HouseholdSettingRow> {
  if (patch.planStartMonth !== undefined && !isMonthKey(patch.planStartMonth)) throw new PlanError(400, "validation", "planStartMonth must be YYYY-MM");
  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw new PlanError(400, "validation", "Unknown time zone");
  if (patch.projectionDefaultDays !== undefined && (!Number.isInteger(patch.projectionDefaultDays) || patch.projectionDefaultDays < 1 || patch.projectionDefaultDays > 366)) {
    throw new PlanError(400, "validation", "projectionDefaultDays must be between 1 and 366");
  }
  return db.transaction(async (tx) => {
    const before = await getHouseholdSetting(tx, ctx.today);
    const set: Partial<typeof householdSetting.$inferInsert> = {};
    if (patch.planStartMonth !== undefined) set.planStartMonth = patch.planStartMonth;
    if (patch.zeroBased !== undefined) set.zeroBased = patch.zeroBased;
    if (patch.lowBalanceThresholdCents !== undefined) set.lowBalanceThresholdCents = patch.lowBalanceThresholdCents;
    if (patch.primaryAccountId !== undefined) set.primaryAccountId = patch.primaryAccountId;
    if (patch.projectionDefaultDays !== undefined) set.projectionDefaultDays = patch.projectionDefaultDays;
    if (patch.timezone !== undefined) set.timezone = patch.timezone;
    if (Object.keys(set).length === 0) return before;
    const [after] = await tx
      .update(householdSetting)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(householdSetting.id, 1))
      .returning();
    // Months newly inside the plan need their auto values frozen (plan-math design).
    if (set.planStartMonth !== undefined && set.planStartMonth < before.planStartMonth) {
      await enqueueJob(tx, "plan.close_month", { reason: "start_month" }, { dedupe: true });
    }
    await writeAudit(tx, {
      ...ctx,
      entity: "household_setting",
      entityId: "1",
      action: "update",
      before: householdSettingAuditJson(before),
      after: householdSettingAuditJson(after!),
    });
    return after!;
  });
}
