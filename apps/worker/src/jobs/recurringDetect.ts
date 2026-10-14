import { getHouseholdSetting, householdToday, runRecurringDetection, type DetectionRunStats, type JobRow } from "@meridian/db";
import type { IsoDate } from "@meridian/shared";
import type { JobContext } from "./context.js";

export interface RecurringDetectOutcome extends DetectionRunStats {
  reason: string;
  /** The household's calendar date the run used (docs/phase-2-plan.md §16). */
  today: IsoDate;
}

/**
 * `recurring.detect`: one full detection run (suggestions, matcher, missed/price/trial
 * alerts) with `today` computed in the household time zone. The job is deduped by the
 * enqueuers, so at most one run is queued or running at a time; the run itself is
 * idempotent, so a retry after a crash converges to the same state.
 */
export async function runRecurringDetectJob(ctx: JobContext, job: JobRow): Promise<RecurringDetectOutcome> {
  const now = ctx.now();
  const setting = await getHouseholdSetting(ctx.db);
  const today = householdToday(setting, now);
  const reason = typeof job.payload["reason"] === "string" ? job.payload["reason"] : "unknown";
  const stats = await runRecurringDetection(ctx.db, {
    today,
    now,
    onGroupError: (payeeId, error) => ctx.log.error(`[recurring.detect] payee ${payeeId} skipped: ${error instanceof Error ? error.message : String(error)}`),
  });
  return { reason, today, ...stats };
}
