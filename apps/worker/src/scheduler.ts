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
  purgeExpiredSessions,
  purgeSignInEvents,
  requestPriceRefresh,
  type JobType,
} from "@meridian/db";
import { expectedPriceDate, localClockInTimeZone, toIsoDate, type IsoDate } from "@meridian/shared";
import { DEFAULT_DETECT_HOUR_UTC, priceConfigOf } from "./env.js";
import type { JobContext } from "./jobs/context.js";

/**
 * Queue a sync for every SimpleFIN connection that was last tried longer ago than the
 * interval. Returns how many were queued.
 *
 * The interval runs from the last attempt (`last_attempt_at`), not the last success, so a
 * connection whose sync fails is asked as often as one that works and no more: the tick is
 * every minute, the interval 6 hours. A connection the Bridge refused outright (403, 402:
 * `sync_paused`) is not scheduled at all until a sync started by hand succeeds or it is
 * switched back on. A connection whose last attempt failed gets one attempt per interval
 * instead of the queue's three.
 */
export async function scheduleDueSyncs(ctx: JobContext): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.config.syncIntervalHours * 3600_000);
  const due = await ctx.db
    .select({ id: connection.id, lastSyncAt: connection.lastSyncAt, lastAttemptAt: connection.lastAttemptAt })
    .from(connection)
    .where(
      and(
        eq(connection.type, "simplefin"),
        isNotNull(connection.accessUrlEnc),
        inArray(connection.status, ["ok", "error", "auth_required"]),
        eq(connection.syncPaused, false),
        or(isNull(connection.lastAttemptAt), lt(connection.lastAttemptAt, cutoff)),
      ),
    );
  let queued = 0;
  for (const c of due) {
    const failing = c.lastAttemptAt !== null && (c.lastSyncAt === null || c.lastSyncAt < c.lastAttemptAt);
    const job = await enqueueJob(ctx.db, "simplefin.sync", { connectionId: c.id, scheduled: true }, { dedupe: true, ...(failing ? { maxAttempts: 1 } : {}) });
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

/**
 * Sign-in housekeeping: deletes sessions past their absolute or idle end (every sign-in adds
 * a row; the API only clears a member's own expired ones when they sign in again) and
 * sign-in activity older than its 90-day retention. Plain deletes, safe to repeat.
 */
export async function purgeSignInData(ctx: Pick<JobContext, "db" | "now">): Promise<{ sessions: number; events: number }> {
  const sessions = await purgeExpiredSessions(ctx.db, ctx.now());
  const events = await purgeSignInEvents(ctx.db);
  return { sessions, events };
}

export const SIGN_IN_PURGE_INTERVAL_MS = 3600_000;

/** Wraps a task so it runs at most once per `everyMs` of the context's clock. The first call runs; a failed run is retried on the next call. */
export function atMostEvery<C extends Pick<JobContext, "now">, T>(everyMs: number, task: (ctx: C) => Promise<T>): (ctx: C) => Promise<T | null> {
  let lastRun: number | null = null;
  return async (ctx) => {
    const now = ctx.now().getTime();
    if (lastRun !== null && now - lastRun < everyMs) return null;
    const result = await task(ctx);
    lastRun = now;
    return result;
  };
}

/**
 * Ticks every `everyMs`: queues the due syncs, the daily jobs and the price jobs, then runs the
 * hourly sign-in housekeeping. The housekeeping has its own try block and comes last, so a
 * purge that keeps failing (it is retried on every tick until it works) is logged and never
 * keeps a bank sync or a price job from being queued (audit a2-auth-users N4). The returned
 * function stops the ticks and resolves once a tick in progress has finished.
 */
export function startScheduler(ctx: JobContext, everyMs = 60_000): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | null = null;
  const hourlyPurge = atMostEvery(SIGN_IN_PURGE_INTERVAL_MS, purgeSignInData);
  const tick = async () => {
    try {
      const n = await scheduleDueSyncs(ctx);
      if (n > 0) ctx.log.info(`[scheduler] queued ${n} sync job(s)`);
      const d = await scheduleDailyJobs(ctx);
      if (d > 0) ctx.log.info(`[scheduler] queued ${d} daily job(s)`);
      const p = await schedulePriceJobs(ctx);
      if (p > 0) ctx.log.info(`[scheduler] queued ${p} price job(s)`);
    } catch (err) {
      ctx.log.error(`[scheduler] ${(err as Error).message}`);
    }
    try {
      const purged = await hourlyPurge(ctx);
      if (purged && purged.sessions + purged.events > 0) ctx.log.info(`[scheduler] removed ${purged.sessions} expired session(s) and ${purged.events} old sign-in event(s)`);
    } catch (err) {
      ctx.log.error(`[scheduler] sign-in purge failed: ${(err as Error).message}`);
    }
  };
  const loop = () => {
    if (stopped) return;
    running = tick().finally(() => {
      running = null;
      if (!stopped) setTimeout(loop, everyMs);
    });
  };
  loop();
  return async () => {
    stopped = true;
    await running;
  };
}
