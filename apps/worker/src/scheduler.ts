import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  connection,
  countSecuritiesBehind,
  DEFAULT_TIMEZONE,
  enqueueJob,
  getHouseholdSetting,
  isValidTimeZone,
  job,
  priceRefreshDedupeKey,
  requestPriceRefresh,
  type JobType,
} from "@meridian/db";
import { expectedPriceDate, localClockInTimeZone, toIsoDate, type IsoDate } from "@meridian/shared";
import { DEFAULT_DETECT_HOUR_UTC, priceConfigOf } from "./env.js";
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

/** The jobs the daily tick queues, in order (plan decision 18; seams C51). */
export const DAILY_JOB_TYPES: readonly JobType[] = ["recurring.detect", "investments.income_feed", "plan.close_month"];

/**
 * The daily tick (docs/phase-2-plan.md §17; Phase 3 adds the income feed): once per UTC day,
 * at or after `config.detectHourUtc`, queue `recurring.detect`, `investments.income_feed` and
 * `plan.close_month` with `{ reason: 'nightly', day }`. A job already queued for today's UTC
 * day (by `day`) is not queued twice; a job of the same type still queued or running (a
 * sync-triggered detect, say) makes the enqueue a no-op, and the next tick tries again.
 * The income feed shares its enqueuers' key `investments.income_feed`. Returns how many jobs
 * were created.
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
    const payload: Record<string, unknown> = { reason: "nightly", day };
    if (type === "investments.income_feed") payload["dedupeKey"] = "investments.income_feed";
    const created = await enqueueJob(ctx.db, type, payload, { dedupe: true });
    if (created.created) queued++;
  }
  return queued;
}

/** Whether a household-local hour falls in the catch-up window: from the catch-up hour up to (not including) the nightly hour, wrapping past midnight. */
export function inCatchupWindow(hour: number, catchupHour: number, fetchHour: number): boolean {
  if (catchupHour === fetchHour) return false;
  return catchupHour < fetchHour ? hour >= catchupHour && hour < fetchHour : hour >= catchupHour || hour < fetchHour;
}

async function priceJobExists(ctx: JobContext, dedupeKey: string): Promise<boolean> {
  const [existing] = await ctx.db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.type, "prices.fetch"), sql`${job.payload}->>'dedupeKey' = ${dedupeKey}`))
    .limit(1);
  return existing !== undefined;
}

/**
 * The price feed's clock (prices design §3.13; plan decision 10), on the household-local
 * clock rather than the UTC tick: with a provider configured, one nightly `prices.fetch` at
 * or after `PRICE_FETCH_HOUR` keyed `prices:nightly:<local day>` (any job with that key, in
 * any status, means the night is done), and one conditional catch-up in the window from
 * `PRICE_CATCHUP_HOUR` up to the nightly hour, keyed `prices:catchup:<local day>`, queued only
 * when a fetched security is still behind the expected close. `PRICE_PROVIDER=none` never
 * queues. Returns how many jobs were created.
 */
export async function schedulePriceJobs(ctx: JobContext): Promise<number> {
  const prices = priceConfigOf(ctx.config);
  if (prices.provider === null) return 0;
  const now = ctx.now();
  const setting = await getHouseholdSetting(ctx.db);
  const local = localClockInTimeZone(now, isValidTimeZone(setting.timezone) ? setting.timezone : DEFAULT_TIMEZONE);
  let queued = 0;
  if (local.hour >= prices.fetchHour) {
    const key = priceRefreshDedupeKey({ reason: "nightly", day: local.date });
    if (!(await priceJobExists(ctx, key))) {
      const r = await requestPriceRefresh(ctx.db, { reason: "nightly", day: local.date, now });
      if (r.created) queued++;
    }
  }
  if (prices.catchupHour !== null && inCatchupWindow(local.hour, prices.catchupHour, prices.fetchHour)) {
    const key = priceRefreshDedupeKey({ reason: "catchup", day: local.date });
    if (!(await priceJobExists(ctx, key))) {
      const behind = await countSecuritiesBehind(ctx.db, { now, today: local.date, expectedThrough: expectedPriceDate(now) });
      if (behind > 0) {
        const r = await requestPriceRefresh(ctx.db, { reason: "catchup", day: local.date, now });
        if (r.created) queued++;
      }
    }
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
      const p = await schedulePriceJobs(ctx);
      if (p > 0) ctx.log.info(`[scheduler] queued ${p} price job(s)`);
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
