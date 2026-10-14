import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { connection, enqueueJob, job, type JobType } from "@meridian/db";
import { toIsoDate, type IsoDate } from "@meridian/shared";
import { DEFAULT_DETECT_HOUR_UTC } from "./env.js";
import type { JobContext } from "./jobs/context.js";

/** Queue a sync for every SimpleFIN connection whose last sync is older than the interval. Returns how many were queued. */
export async function scheduleDueSyncs(ctx: JobContext): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.config.syncIntervalHours * 3600_000);
  const due = await ctx.db
    .select({ id: connection.id })
    .from(connection)
    .where(
      and(
        eq(connection.type, "simplefin"),
        isNotNull(connection.accessUrlEnc),
        inArray(connection.status, ["ok", "error", "auth_required"]),
        or(isNull(connection.lastSyncAt), lt(connection.lastSyncAt, cutoff)),
      ),
    );
  let queued = 0;
  for (const c of due) {
    const job = await enqueueJob(ctx.db, "simplefin.sync", { connectionId: c.id, scheduled: true }, { dedupe: true });
    if (job.created) queued++;
  }
  return queued;
}

/** The jobs the daily tick queues, in order. */
export const DAILY_JOB_TYPES: readonly JobType[] = ["recurring.detect", "plan.close_month"];

/**
 * The daily tick (docs/phase-2-plan.md §17): once per UTC day, at or after
 * `config.detectHourUtc`, queue `recurring.detect` and `plan.close_month` with
 * `{ reason: 'nightly', day }`. A job already queued for today's UTC day (by `day`)
 * is not queued twice; a job of the same type still queued or running (a sync-triggered
 * detect, say) makes the enqueue a no-op, and the next tick tries again. Returns how
 * many jobs were created.
 */
export async function scheduleDailyJobs(ctx: JobContext): Promise<number> {
  const now = ctx.now();
  if (now.getUTCHours() < (ctx.config.detectHourUtc ?? DEFAULT_DETECT_HOUR_UTC)) return 0;
  const day: IsoDate = toIsoDate(now);
  let queued = 0;
  for (const type of DAILY_JOB_TYPES) {
    const [existing] = await ctx.db
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.type, type), sql`${job.payload}->>'reason' = 'nightly'`, sql`${job.payload}->>'day' = ${day}`))
      .limit(1);
    if (existing) continue;
    const created = await enqueueJob(ctx.db, type, { reason: "nightly", day }, { dedupe: true });
    if (created.created) queued++;
  }
  return queued;
}

export function startScheduler(ctx: JobContext, everyMs = 60_000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await scheduleDueSyncs(ctx);
      if (n > 0) ctx.log.info(`[scheduler] queued ${n} sync job(s)`);
      const d = await scheduleDailyJobs(ctx);
      if (d > 0) ctx.log.info(`[scheduler] queued ${d} daily job(s)`);
    } catch (err) {
      ctx.log.error(`[scheduler] ${(err as Error).message}`);
    } finally {
      if (!stopped) setTimeout(() => void tick(), everyMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}
