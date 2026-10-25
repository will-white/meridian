import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  enqueueJob,
  getHouseholdSetting,
  householdToday,
  importLog,
  job as jobTable,
  price,
  priceFetchPlan,
  priceRefreshDedupeKey,
  requestValuation,
  security,
  upsertPrices,
  type JobRow,
  type PriceFetchPlanEntry,
  type PriceUpsertRow,
} from "@meridian/db";
import { expectedPriceDate, flagSuspectBars, isIsoDate, PROVIDER_BODY_LIMIT, type Fixed8, type IsoDate, type PriceProvider } from "@meridian/shared";
import { priceConfigOf } from "../env.js";
import { createPriceProvider, fetchWithRetries, PriceFeedError, sanitizeProviderMessage } from "../prices/provider.js";
import { sleepOf, type JobContext } from "./context.js";

/**
 * `prices.fetch` (prices design §3.11 under plan decisions 10 and 18): one bounded run of the
 * provider over the fetch plan. Provider failures never fail the job: each security records
 * its own state (`price_fetch_*`, exponential backoff), a persistent 429 defers the rest, an
 * authentication failure stops the run permanently, and only a run where every request died
 * on the network is retried by the queue. What the budget or the clock left over goes to a
 * continuation an hour later (at most five per root run); every completed run chains the
 * valuation job so the computed balance rows follow the new closes.
 */

export interface PricesFetchStats {
  /** Securities attempted in this run. */
  securities: number;
  /** Provider requests made (every retry counts). */
  requests: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsKept: number;
  notFound: number;
  errors: number;
  rateLimited: number;
  deferred: number;
  suspect: number;
}

export interface PricesFetchOutcome {
  importLogId: string;
  reason: string;
  configured: boolean;
  expectedThrough: IsoDate;
  stats: PricesFetchStats;
  message: string;
  continuationJobId: string | null;
  valuationJobId: string | null;
}

export const CONTINUATION_DELAY_MS = 61 * 60_000;
export const MAX_CONTINUATIONS = 5;
export const BACKOFF_BASE_MS = 6 * 3600_000;
export const BACKOFF_CAP_MS = 48 * 3600_000;
const MAX_INVALID_BODIES_KEPT = 5;

/** Per-security backoff after the n-th consecutive failure: 6 h, 12 h, 24 h, 48 h, 48 h, … */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS);
}

function zeroStats(): PricesFetchStats {
  return { securities: 0, requests: 0, rowsInserted: 0, rowsUpdated: 0, rowsKept: 0, notFound: 0, errors: 0, rateLimited: 0, deferred: 0, suspect: 0 };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

/** The latest stored close before `date` (any source): the predecessor for the suspect rule's first bar. */
async function latestCloseBefore(ctx: JobContext, securityId: string, date: IsoDate | undefined): Promise<{ date: IsoDate; close: Fixed8 } | null> {
  if (!date) return null;
  const [row] = await ctx.db
    .select({ date: price.date, close: price.close })
    .from(price)
    .where(and(eq(price.securityId, securityId), lt(price.date, date)))
    .orderBy(desc(price.date))
    .limit(1);
  if (!row) return null;
  const [whole, frac = ""] = row.close.split(".");
  return { date: row.date, close: BigInt(whole! + frac.padEnd(8, "0").slice(0, 8)) };
}

/**
 * Queue the continuation under the canonical key `prices:continue:<root>`. The running job may
 * itself carry that key (a continuation chaining the next hop), so the dedupe check excludes it;
 * a retry of a job whose continuation is already queued finds that one and queues nothing.
 */
async function queueContinuation(ctx: JobContext, current: JobRow, payload: Record<string, unknown>, runAt: Date): Promise<{ jobId: string; created: boolean }> {
  const dedupeKey = payload["dedupeKey"] as string;
  const [existing] = await ctx.db
    .select({ id: jobTable.id })
    .from(jobTable)
    .where(and(eq(jobTable.type, "prices.fetch"), inArray(jobTable.status, ["queued", "running"]), sql`${jobTable.payload}->>'dedupeKey' = ${dedupeKey}`, ne(jobTable.id, current.id)))
    .orderBy(asc(jobTable.createdAt))
    .limit(1);
  if (existing) return { jobId: existing.id, created: false };
  const row = await enqueueJob(ctx.db, "prices.fetch", payload, { runAt, maxAttempts: 5 });
  return { jobId: row.id, created: true };
}

export async function runPricesFetchJob(ctx: JobContext, job: JobRow): Promise<PricesFetchOutcome> {
  const now = ctx.now();
  const expectedThrough = expectedPriceDate(now);
  const setting = await getHouseholdSetting(ctx.db);
  const today = householdToday(setting, now);
  const payload = job.payload;
  const reason = typeof payload["reason"] === "string" ? payload["reason"] : "manual";
  const securityIds = stringList(payload["securityIds"]);
  const from = typeof payload["from"] === "string" && isIsoDate(payload["from"]) ? payload["from"] : undefined;
  const continuation = typeof payload["continuation"] === "number" ? payload["continuation"] : 0;
  const rootJobId = typeof payload["rootJobId"] === "string" ? payload["rootJobId"] : job.id;
  const prices = priceConfigOf(ctx.config);
  const stats = zeroStats();

  const [log] = await ctx.db.insert(importLog).values({ connectionId: null, kind: "prices.fetch", status: "running", startedAt: now }).returning({ id: importLog.id });
  const importLogId = log!.id;
  const finish = async (status: "ok" | "error", message: string, extra: { rawPayload?: Record<string, unknown> } = {}) => {
    await ctx.db
      .update(importLog)
      .set({ status, finishedAt: ctx.now(), message, stats: { ...stats }, ...(extra.rawPayload ? { rawPayload: extra.rawPayload } : {}) })
      .where(eq(importLog.id, importLogId));
  };
  const outcome = (configured: boolean, message: string, continuationJobId: string | null = null, valuationJobId: string | null = null): PricesFetchOutcome => ({
    importLogId,
    reason,
    configured,
    expectedThrough,
    stats,
    message,
    continuationJobId,
    valuationJobId,
  });

  let provider: PriceProvider | null;
  try {
    provider = createPriceProvider(ctx.config, ctx.client.fetch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish("error", message);
    throw err;
  }
  if (!provider) {
    const message = "Price feed not configured";
    await finish("error", message);
    ctx.log.warn(`[prices.fetch] ${message} (PRICE_PROVIDER=none); nothing fetched`);
    return outcome(false, message);
  }

  const plan = await priceFetchPlan(ctx.db, {
    now,
    today,
    expectedThrough,
    ...(securityIds ? { securityIds } : {}),
    ...(from ? { from } : {}),
    overlapDays: prices.overlapDays,
    maxYears: prices.historyMaxYears,
    maxRequests: prices.maxRequestsPerRun,
  });
  const deferred: PriceFetchPlanEntry[] = [...plan.deferred];
  const sleep = sleepOf(ctx);
  const runStartedAt = now.getTime();
  const invalidBodies: Array<{ symbol: string; body: string }> = [];
  let everyRequestNetworkFailed = true;
  let authMessage: string | null = null;

  for (let i = 0; i < plan.work.length; i++) {
    const entry = plan.work[i]!;
    if (ctx.now().getTime() - runStartedAt > prices.runMaxMs) {
      deferred.push(...plan.work.slice(i));
      break;
    }
    if (i > 0 && prices.requestSpacingMs > 0) await sleep(prices.requestSpacingMs);
    const requestedAt = ctx.now();
    const { result, attempts } = await fetchWithRetries(provider, entry.symbol, { from: entry.from, to: entry.to }, { sleep });
    stats.requests += attempts;
    stats.securities++;
    if (result.ok) {
      everyRequestNetworkFailed = false;
      const bars = result.bars.filter((b) => b.date <= entry.to);
      const flags = flagSuspectBars(bars, await latestCloseBefore(ctx, entry.securityId, bars[0]?.date));
      const rows: PriceUpsertRow[] = bars.map((b, k) => ({
        securityId: entry.securityId,
        date: b.date,
        close: b.close,
        adjClose: b.adjClose,
        source: "provider",
        provider: provider.id,
        suspect: flags[k] ?? false,
        fetchedAt: requestedAt,
      }));
      const written = await upsertPrices(ctx.db, rows);
      stats.rowsInserted += written.inserted;
      stats.rowsUpdated += written.updated;
      stats.rowsKept += written.kept;
      stats.suspect += flags.filter(Boolean).length;
      await ctx.db
        .update(security)
        .set({
          priceFetchedAt: requestedAt,
          priceFetchStatus: "ok",
          priceFetchMessage: null,
          priceFetchFailures: 0,
          priceNextAttemptAt: null,
          priceBackfilledFrom: sql`least(coalesce(${security.priceBackfilledFrom}, ${entry.from}::date), ${entry.from}::date)`,
        })
        .where(eq(security.id, entry.securityId));
      continue;
    }

    const message = sanitizeProviderMessage(result.message);
    if (result.kind === "not_found") {
      everyRequestNetworkFailed = false;
      stats.notFound++;
      await ctx.db.update(security).set({ priceFetchedAt: requestedAt, priceFetchStatus: "not_found", priceFetchMessage: message }).where(eq(security.id, entry.securityId));
      continue;
    }
    if (result.kind === "rate_limited") {
      everyRequestNetworkFailed = false;
      stats.rateLimited++;
      await ctx.db.update(security).set({ priceFetchedAt: requestedAt, priceFetchStatus: "rate_limited", priceFetchMessage: message }).where(eq(security.id, entry.securityId));
      deferred.push(...plan.work.slice(i));
      break;
    }
    if (result.kind === "auth") {
      authMessage = message;
      break;
    }
    // http | network | invalid_response: per-security exponential backoff.
    if (result.kind !== "network") everyRequestNetworkFailed = false;
    stats.errors++;
    if (result.kind === "invalid_response" && result.body && invalidBodies.length < MAX_INVALID_BODIES_KEPT) {
      invalidBodies.push({ symbol: entry.symbol, body: result.body.slice(0, PROVIDER_BODY_LIMIT) });
    }
    const [current] = await ctx.db.select({ failures: security.priceFetchFailures }).from(security).where(eq(security.id, entry.securityId));
    const failures = (current?.failures ?? 0) + 1;
    await ctx.db
      .update(security)
      .set({
        priceFetchedAt: requestedAt,
        priceFetchStatus: "error",
        priceFetchMessage: message,
        priceFetchFailures: failures,
        priceNextAttemptAt: new Date(requestedAt.getTime() + backoffMs(failures)),
      })
      .where(eq(security.id, entry.securityId));
  }

  if (authMessage !== null) {
    await finish("error", authMessage);
    throw new PriceFeedError("auth", authMessage);
  }
  if (stats.securities > 0 && everyRequestNetworkFailed) {
    const message = `${provider.id}: every request failed on the network (${stats.securities} securities, ${stats.requests} requests)`;
    await finish("error", message);
    throw new PriceFeedError("network", message);
  }

  stats.deferred = deferred.length;
  let message = `${provider.id}: ${stats.requests} requests, ${stats.rowsInserted + stats.rowsUpdated} rows; ${stats.deferred} deferred`;
  let continuationJobId: string | null = null;
  if (deferred.length > 0) {
    if (continuation < MAX_CONTINUATIONS) {
      const continuationPayload: Record<string, unknown> = {
        reason: "continue",
        securityIds: [...new Set(deferred.map((d) => d.securityId))],
        continuation: continuation + 1,
        rootJobId,
        dedupeKey: priceRefreshDedupeKey({ reason: "continue", rootJobId }),
      };
      if (from) continuationPayload["from"] = from;
      const queued = await queueContinuation(ctx, job, continuationPayload, new Date(now.getTime() + CONTINUATION_DELAY_MS));
      continuationJobId = queued.jobId;
    } else {
      message += `; continuation limit (${MAX_CONTINUATIONS}) reached, ${deferred.length} securities wait for the next run`;
    }
  }
  await finish("ok", message, invalidBodies.length > 0 ? { rawPayload: { invalidResponses: invalidBodies } } : {});

  // The computed balance rows follow the closes this run wrote (plan decision 9; seams C51).
  const valuation = await requestValuation(ctx.db, { reason: "prices" });
  return outcome(true, message, continuationJobId, valuation.jobId);
}
