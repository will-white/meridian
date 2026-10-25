import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  addDays,
  addMonthsClamped,
  expectedPriceDate,
  isIsoDate,
  mapSymbol,
  priceStatusOf,
  type Fixed8,
  type IsoDate,
  type JobStatus,
  type PriceFetchStatus,
  type PriceProviderId,
  type PriceSource,
  type PriceStatus,
} from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { householdSetting, importLog, job, lotDisposal, price, security } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { fixed8FromDb, fixed8ToDb, qtyFromDb } from "./decimalDb.js";
import { enqueueJob } from "./jobs.js";
import { loadHeldSecurities, requireSecurity } from "./securities.js";
import { getHouseholdSetting, householdToday } from "./settings.js";

/**
 * Prices (prices design §3.5, §3.6, §3.11 under plan decisions 10 and 18; seams C35, C39):
 * the one price writer `upsertPrices` (precedence manual > provider > implied, the suspect
 * flag, batches of 500, `kept` for a no-op), the series and latest-price readers the engines
 * use, the fetch plan the worker's `prices.fetch` job runs, the refresh request every caller
 * goes through (`payload.dedupeKey`), and the status / health reads of the Prices page and
 * the dashboard. Implied rows are written by `holdings.ts` (`rebuildImpliedPrices`) through
 * `upsertPrices`; the manual close is `setManualPrice` in `securities.ts`.
 */

export type PriceRow = typeof price.$inferSelect;

/** Bigint twin of `PriceView`. */
export interface PriceRecord {
  id: string;
  securityId: string;
  date: IsoDate;
  close: Fixed8;
  adjClose: Fixed8 | null;
  source: PriceSource;
  provider: PriceProviderId | null;
  suspect: boolean;
  fetchedAt: Date | null;
  updatedAt: Date;
}

function toRecord(row: PriceRow): PriceRecord {
  return {
    id: row.id,
    securityId: row.securityId,
    date: row.date,
    close: fixed8FromDb(row.close),
    adjClose: qtyFromDb(row.adjClose),
    source: row.source,
    provider: row.provider,
    suspect: row.suspect,
    fetchedAt: row.fetchedAt,
    updatedAt: row.updatedAt,
  };
}

// ---- The one writer ----

export interface PriceUpsertRow {
  securityId: string;
  date: IsoDate;
  close: Fixed8;
  source: PriceSource;
  /** Provider rows: the dividend/split-adjusted close; null keeps an earlier value. */
  adjClose?: Fixed8 | null;
  /** Required on provider rows, must be absent otherwise (`price_provider_shape`). */
  provider?: PriceProviderId | null;
  /** Computed by the fetch job (`flagSuspectBars`); false for implied and manual rows. */
  suspect?: boolean;
  fetchedAt?: Date | null;
}

export interface UpsertPricesResult {
  inserted: number;
  updated: number;
  /** Rows the precedence rule refused or that changed nothing (`updated_at` untouched). */
  kept: number;
}

export const PRICE_UPSERT_BATCH = 500;

/**
 * Insert or replace closes under the precedence rule (§3.6): a row is written when nothing
 * exists for (security, date) or the new source's rank is at least the stored one's AND
 * something differs (close, source, an adjusted close that is not just missing, the suspect
 * flag). Duplicate keys within one call collapse to the last given. A re-fetch that changes
 * nothing reports every row `kept` and moves no timestamp.
 */
export async function upsertPrices(tx: DbOrTx, rows: readonly PriceUpsertRow[]): Promise<UpsertPricesResult> {
  const byKey = new Map<string, PriceUpsertRow>();
  for (const r of rows) {
    if (!isIsoDate(r.date)) throw new PlanError(400, "validation", `price date "${r.date}" is not YYYY-MM-DD`);
    if (r.close < 0n) throw new PlanError(400, "validation", "close must not be negative");
    if (r.adjClose !== undefined && r.adjClose !== null && r.adjClose < 0n) throw new PlanError(400, "validation", "adjClose must not be negative");
    const provider = r.provider ?? null;
    if ((r.source === "provider") !== (provider !== null)) throw new PlanError(400, "validation", "provider rows carry a provider id; implied and manual rows never do");
    byKey.set(`${r.securityId}|${r.date}`, r);
  }
  const unique = [...byKey.values()];
  const result: UpsertPricesResult = { inserted: 0, updated: 0, kept: 0 };
  for (let i = 0; i < unique.length; i += PRICE_UPSERT_BATCH) {
    const batch = unique.slice(i, i + PRICE_UPSERT_BATCH);
    const values = batch.map(
      (r) =>
        sql`(${r.securityId}::uuid, ${r.date}::date, ${fixed8ToDb(r.close)}::numeric, ${r.adjClose === undefined || r.adjClose === null ? null : fixed8ToDb(r.adjClose)}::numeric, ${r.source}, ${r.provider ?? null}, ${r.suspect ?? false}, ${r.fetchedAt ? r.fetchedAt.toISOString() : null}::timestamptz, now())`,
    );
    const returned = await tx.execute<{ inserted: boolean }>(sql`
      insert into price (security_id, date, close, adj_close, source, provider, suspect, fetched_at, updated_at)
      values ${sql.join(values, sql`, `)}
      on conflict (security_id, date) do update set
        close = excluded.close,
        adj_close = coalesce(excluded.adj_close, price.adj_close),
        source = excluded.source,
        provider = excluded.provider,
        suspect = excluded.suspect,
        fetched_at = excluded.fetched_at,
        updated_at = now()
      where (case excluded.source when 'manual' then 3 when 'provider' then 2 else 1 end)
         >= (case price.source when 'manual' then 3 when 'provider' then 2 else 1 end)
        and (price.close is distinct from excluded.close
          or price.source <> excluded.source
          or price.adj_close is distinct from coalesce(excluded.adj_close, price.adj_close)
          or price.suspect <> excluded.suspect)
      returning (xmax = 0) as inserted
    `);
    let inserted = 0;
    for (const r of returned) if (r.inserted) inserted++;
    result.inserted += inserted;
    result.updated += returned.length - inserted;
    result.kept += batch.length - returned.length;
  }
  return result;
}

// ---- Reads ----

export async function getPrice(db: DbOrTx, securityId: string, date: IsoDate): Promise<PriceRecord | undefined> {
  const [row] = await db
    .select()
    .from(price)
    .where(and(eq(price.securityId, securityId), eq(price.date, date)));
  return row ? toRecord(row) : undefined;
}

export interface ListPricesQuery {
  from?: IsoDate;
  to?: IsoDate;
  limit?: number;
}

/** A security's closes, newest first (default the last 400). */
export async function listPrices(db: DbOrTx, securityId: string, query: ListPricesQuery = {}): Promise<PriceRecord[]> {
  const rows = await db
    .select()
    .from(price)
    .where(and(eq(price.securityId, securityId), query.from ? sql`${price.date} >= ${query.from}` : undefined, query.to ? lte(price.date, query.to) : undefined))
    .orderBy(desc(price.date))
    .limit(Math.max(1, Math.min(query.limit ?? 400, 5000)));
  return rows.map(toRecord);
}

export interface LatestPriceRecord {
  date: IsoDate;
  close: Fixed8;
  source: PriceSource;
}

/** The latest row on or before `asOf` (any source) per security; null entries for securities without one. */
export async function latestPrices(db: DbOrTx, securityIds: readonly string[], asOf?: IsoDate): Promise<Map<string, LatestPriceRecord | null>> {
  const out = new Map<string, LatestPriceRecord | null>(securityIds.map((id) => [id, null]));
  if (securityIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([price.securityId], { securityId: price.securityId, date: price.date, close: price.close, source: price.source })
    .from(price)
    .where(and(inArray(price.securityId, [...new Set(securityIds)]), asOf ? lte(price.date, asOf) : undefined))
    .orderBy(asc(price.securityId), desc(price.date));
  for (const r of rows) out.set(r.securityId, { date: r.date, close: fixed8FromDb(r.close), source: r.source });
  return out;
}

export interface PriceSeriesPoint {
  date: IsoDate;
  close: Fixed8;
  source: PriceSource;
  suspect: boolean;
}

export interface PriceSeries {
  securityId: string;
  /** True when `adjusted` was asked and every point carried an adjusted close. */
  adjusted: boolean;
  /** Ascending, unique dates: the latest close on or before `from` first, then every close in (from, to]. */
  points: PriceSeriesPoint[];
}

/**
 * Close series for the engines: the latest close ≤ `from` (so a window starts valued) then
 * every close in (from, to], ascending. With `adjusted` each point is `adj_close ?? close` and
 * the series says whether every point was adjusted (the benchmark falls back to price return).
 */
export async function loadPriceSeries(db: DbOrTx, securityIds: readonly string[], from: IsoDate, to: IsoDate, opts: { adjusted?: boolean } = {}): Promise<Map<string, PriceSeries>> {
  if (to < from) throw new PlanError(400, "validation", "to must not be before from");
  const ids = [...new Set(securityIds)];
  const out = new Map<string, PriceSeries>(ids.map((id) => [id, { securityId: id, adjusted: false, points: [] }]));
  if (ids.length === 0) return out;
  const anchors = await db
    .selectDistinctOn([price.securityId], { securityId: price.securityId, date: price.date, close: price.close, adjClose: price.adjClose, source: price.source, suspect: price.suspect })
    .from(price)
    .where(and(inArray(price.securityId, ids), lte(price.date, from)))
    .orderBy(asc(price.securityId), desc(price.date));
  const rest = await db
    .select({ securityId: price.securityId, date: price.date, close: price.close, adjClose: price.adjClose, source: price.source, suspect: price.suspect })
    .from(price)
    .where(and(inArray(price.securityId, ids), gt(price.date, from), lte(price.date, to)))
    .orderBy(asc(price.securityId), asc(price.date));
  const fallbacks = new Map<string, boolean>();
  const push = (r: (typeof rest)[number]) => {
    const series = out.get(r.securityId)!;
    let close = fixed8FromDb(r.close);
    if (opts.adjusted) {
      if (r.adjClose === null) fallbacks.set(r.securityId, true);
      else close = fixed8FromDb(r.adjClose);
    }
    series.points.push({ date: r.date, close, source: r.source, suspect: r.suspect });
  };
  for (const r of anchors) push(r);
  for (const r of rest) push(r);
  for (const series of out.values()) series.adjusted = opts.adjusted === true && series.points.length > 0 && !fallbacks.get(series.securityId);
  return out;
}

// ---- Manual price removal ----

export interface DeleteManualPriceOptions {
  /** Queue the refill fetch for that security from the removed date (off when no provider is configured). */
  refill?: boolean;
  now?: Date;
}

/**
 * Remove the owner's close (`DELETE /api/prices/:securityId/:date`): manual rows only
 * (409 `manual_only`), audited as a `security` update, then a `prices.fetch { reason: 'refill' }`
 * keyed `prices:refill:<id>` so the feed fills the hole.
 */
export async function deleteManualPrice(db: Db, securityId: string, date: IsoDate, ctx: AuditContext, opts: DeleteManualPriceOptions = {}): Promise<{ refillJobId: string | null }> {
  let refillJobId: string | null = null;
  await db.transaction(async (tx) => {
    await requireSecurity(tx, securityId);
    const existing = await getPrice(tx, securityId, date);
    if (!existing) throw new PlanError(404, "not_found", `No price for ${date}`);
    if (existing.source !== "manual") throw new PlanError(409, "manual_only", `The ${date} close is a ${existing.source} price; only manual prices can be removed`);
    await tx.delete(price).where(eq(price.id, existing.id));
    await writeAudit(tx, {
      ...ctx,
      entity: "security",
      entityId: securityId,
      action: "update",
      before: { price: { date, close: fixed8ToDb(existing.close), source: "manual" } },
      after: { price: { date, close: null, source: null } },
    });
    if (opts.refill !== false) {
      const req = await requestPriceRefresh(tx, { reason: "refill", securityIds: [securityId], from: date, ...(opts.now ? { now: opts.now } : {}) });
      refillJobId = req.jobId;
    }
  });
  return { refillJobId };
}

// ---- Refresh requests ----

export type PriceFetchReason = "nightly" | "catchup" | "manual" | "holdings" | "reconcile" | "refill" | "continue";

export interface PriceRefreshRequest {
  reason: PriceFetchReason;
  /** Household-local day of a nightly or catch-up run (part of its key). */
  day?: IsoDate;
  securityIds?: readonly string[];
  from?: IsoDate;
  /** Continuations: the root job and the continuation number. */
  rootJobId?: string;
  continuation?: number;
  runAt?: Date;
  maxAttempts?: number;
  now?: Date;
}

export interface PriceRefreshResult {
  jobId: string;
  created: boolean;
  /** A queued `manual` request was pulled forward to now. */
  movedUp: boolean;
  dedupeKey: string;
}

/** The queue key of a request (prices design §6): one job per reason, per day for scheduled runs, per security for refills, per root for continuations. */
export function priceRefreshDedupeKey(req: PriceRefreshRequest): string {
  switch (req.reason) {
    case "nightly":
    case "catchup":
      if (!req.day) throw new PlanError(400, "validation", `${req.reason} runs need a day`);
      return `prices:${req.reason}:${req.day}`;
    case "manual":
      return "prices:manual";
    case "holdings":
      return "prices:holdings";
    case "reconcile":
      return "prices:reconcile";
    case "refill": {
      const ids = [...new Set(req.securityIds ?? [])].sort();
      if (ids.length === 0) throw new PlanError(400, "validation", "A refill names the securities to fetch");
      return `prices:refill:${ids.join(",")}`;
    }
    case "continue":
      if (!req.rootJobId) throw new PlanError(400, "validation", "A continuation names its root job");
      return `prices:continue:${req.rootJobId}`;
  }
}

/**
 * Every price refresh goes through here (plan decision 10; seams C35): the job carries its
 * `dedupeKey` so a queued continuation never swallows a nightly run or a holdings import.
 * A `manual` request while a fetch is running returns that job (`created: false`); one
 * queued under `prices:manual` is pulled forward (`movedUp: true`). Callers gate on the
 * provider being configured; with `PRICE_PROVIDER=none` nothing is queued.
 */
export async function requestPriceRefresh(db: DbOrTx, req: PriceRefreshRequest): Promise<PriceRefreshResult> {
  const now = req.now ?? new Date();
  const dedupeKey = priceRefreshDedupeKey(req);
  if (req.reason === "manual") {
    const [running] = await db
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.type, "prices.fetch"), eq(job.status, "running")))
      .limit(1);
    if (running) return { jobId: running.id, created: false, movedUp: false, dedupeKey };
  }
  const [queued] = await db
    .select({ id: job.id, status: job.status, runAt: job.runAt })
    .from(job)
    .where(and(eq(job.type, "prices.fetch"), inArray(job.status, ["queued", "running"]), sql`${job.payload}->>'dedupeKey' = ${dedupeKey}`))
    .limit(1);
  if (queued) {
    if (req.reason === "manual" && queued.status === "queued") {
      if (queued.runAt.getTime() > now.getTime()) await db.update(job).set({ runAt: now }).where(eq(job.id, queued.id));
      return { jobId: queued.id, created: false, movedUp: true, dedupeKey };
    }
    return { jobId: queued.id, created: false, movedUp: false, dedupeKey };
  }
  const payload: Record<string, unknown> = { reason: req.reason, dedupeKey };
  if (req.day) payload["day"] = req.day;
  if (req.securityIds && req.securityIds.length > 0) payload["securityIds"] = [...new Set(req.securityIds)];
  if (req.from) payload["from"] = req.from;
  if (req.rootJobId) payload["rootJobId"] = req.rootJobId;
  if (req.continuation !== undefined) payload["continuation"] = req.continuation;
  const row = await enqueueJob(db, "prices.fetch", payload, { dedupe: true, runAt: req.runAt ?? now, maxAttempts: req.maxAttempts ?? 5 });
  return { jobId: row.id, created: row.created, movedUp: false, dedupeKey };
}

// ---- The fetch plan ----

export const PRICE_OVERLAP_DAYS_DEFAULT = 3;
export const PRICE_HISTORY_MAX_YEARS_DEFAULT = 20;
/** Securities sold within this many days stay in the fetch set so realized-gain views have prices (seams G9). */
export const DISPOSAL_LOOKBACK_DAYS = 400;
export const NOT_FOUND_RETRY_DAYS = 7;

export interface PriceFetchPlanOptions {
  now: Date;
  /** The household's calendar day (floors the history and dates the disposal lookback). */
  today: IsoDate;
  /** `expectedPriceDate(now)`: every range ends here. */
  expectedThrough: IsoDate;
  /** Restrict to these securities (a manual refresh, a refill, a continuation); they need not be held. */
  securityIds?: readonly string[];
  /** Start every range here instead of the computed one (extends a backfill). */
  from?: IsoDate;
  overlapDays?: number;
  maxYears?: number;
  /** This run's budget: the first `maxRequests` entries are `work`, the rest `deferred`. */
  maxRequests?: number;
}

export interface PriceFetchPlanEntry {
  securityId: string;
  ticker: string;
  providerSymbol: string | null;
  /** `mapSymbol`: the symbol the provider is asked for. */
  symbol: string;
  from: IsoDate;
  to: IsoDate;
  latestProviderDate: IsoDate | null;
  firstNeededDate: IsoDate;
  priceFetchedAt: Date | null;
  priceBackfilledFrom: IsoDate | null;
}

export type PriceFetchSkipReason = "backoff" | "not_found" | "from_after_to";

export interface PriceFetchPlan {
  expectedThrough: IsoDate;
  work: PriceFetchPlanEntry[];
  deferred: PriceFetchPlanEntry[];
  skipped: Array<{ securityId: string; ticker: string; reason: PriceFetchSkipReason }>;
}

/** The securities the feed keeps priced: held, `always_price`, the benchmark, or sold within 400 days; `provider` mode only. */
async function fetchSetIds(db: DbOrTx, today: IsoDate): Promise<Set<string>> {
  const held = await loadHeldSecurities(db);
  const ids = new Set<string>(held.keys());
  const always = await db.select({ id: security.id }).from(security).where(eq(security.alwaysPrice, true));
  for (const r of always) ids.add(r.id);
  const [setting] = await db.select({ benchmark: householdSetting.benchmarkSecurityId }).from(householdSetting).where(eq(householdSetting.id, 1));
  if (setting?.benchmark) ids.add(setting.benchmark);
  const disposals = await db
    .selectDistinct({ id: lotDisposal.securityId })
    .from(lotDisposal)
    .where(sql`${lotDisposal.date} >= ${addDays(today, -DISPOSAL_LOOKBACK_DAYS)}`);
  for (const r of disposals) ids.add(r.id);
  return ids;
}

/**
 * The fetch plan (§3.11): the fetch set, eligibility (backoff, `not_found` retried weekly or
 * when named or edited), one date range per security (3-day overlap after the latest provider
 * close; a week before the first needed date for a never-backfilled security; floored at
 * `maxYears`), ordered never-fetched and longest-waiting first, split by the run's budget.
 */
export async function priceFetchPlan(db: DbOrTx, opts: PriceFetchPlanOptions): Promise<PriceFetchPlan> {
  const overlapDays = opts.overlapDays ?? PRICE_OVERLAP_DAYS_DEFAULT;
  const maxYears = opts.maxYears ?? PRICE_HISTORY_MAX_YEARS_DEFAULT;
  const named = opts.securityIds ? new Set(opts.securityIds) : null;
  const candidates = await db
    .select()
    .from(security)
    .where(and(eq(security.priceMode, "provider"), eq(security.archived, false), sql`${security.ticker} is not null`));
  const inSet = named ?? (await fetchSetIds(db, opts.today));
  const targets = candidates.filter((s) => inSet.has(s.id));
  const plan: PriceFetchPlan = { expectedThrough: opts.expectedThrough, work: [], deferred: [], skipped: [] };
  if (targets.length === 0) return plan;

  const ids = targets.map((s) => s.id);
  const latestRows = await db
    .select({ securityId: price.securityId, date: sql<string>`max(${price.date})::text` })
    .from(price)
    .where(and(inArray(price.securityId, ids), eq(price.source, "provider")))
    .groupBy(price.securityId);
  const latestProvider = new Map(latestRows.map((r) => [r.securityId, r.date]));
  const neededRows = await db.execute<{ security_id: string; first: string }>(sql`
    select u.security_id, min(u.date)::text as first
    from (
      select security_id, date from holding_snapshot
      union all
      select security_id, date from investment_txn where security_id is not null
    ) u
    where u.security_id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    group by u.security_id
  `);
  const firstNeeded = new Map(neededRows.map((r) => [r.security_id, r.first]));
  const [household] = await db.execute<{ first: string | null }>(sql`
    select min(d)::text as first from (
      select min(date) as d from holding_snapshot
      union all
      select min(date) as d from investment_txn
    ) u
  `);
  const householdFirst = household?.first ?? null;
  const floor = addMonthsClamped(opts.today, -12 * maxYears);
  const nowMs = opts.now.getTime();

  const entries: PriceFetchPlanEntry[] = [];
  for (const s of targets) {
    const ticker = s.ticker!;
    if (s.priceNextAttemptAt && s.priceNextAttemptAt.getTime() > nowMs) {
      plan.skipped.push({ securityId: s.id, ticker, reason: "backoff" });
      continue;
    }
    if (s.priceFetchStatus === "not_found") {
      const fetchedMs = s.priceFetchedAt?.getTime() ?? null;
      const retryDue = fetchedMs === null || nowMs - fetchedMs >= NOT_FOUND_RETRY_DAYS * 86_400_000;
      const edited = fetchedMs !== null && s.updatedAt.getTime() > fetchedMs;
      if (!retryDue && !named?.has(s.id) && !edited) {
        plan.skipped.push({ securityId: s.id, ticker, reason: "not_found" });
        continue;
      }
    }
    const latest = latestProvider.get(s.id) ?? null;
    const firstNeededDate = firstNeeded.get(s.id) ?? householdFirst ?? addDays(opts.today, -365);
    let from: IsoDate;
    if (opts.from) from = opts.from;
    else if (s.priceBackfilledFrom === null) from = addDays(firstNeededDate, -7);
    else from = addDays(latest ?? s.priceBackfilledFrom, -overlapDays);
    if (from < floor) from = floor;
    const to = opts.expectedThrough;
    if (from > to) {
      plan.skipped.push({ securityId: s.id, ticker, reason: "from_after_to" });
      continue;
    }
    entries.push({
      securityId: s.id,
      ticker,
      providerSymbol: s.providerSymbol,
      symbol: mapSymbol({ ticker, providerSymbol: s.providerSymbol }),
      from,
      to,
      latestProviderDate: latest,
      firstNeededDate,
      priceFetchedAt: s.priceFetchedAt,
      priceBackfilledFrom: s.priceBackfilledFrom,
    });
  }
  entries.sort((a, b) => {
    const am = a.priceFetchedAt?.getTime() ?? -1;
    const bm = b.priceFetchedAt?.getTime() ?? -1;
    if (am !== bm) return am - bm;
    return a.ticker.localeCompare(b.ticker) || (a.securityId < b.securityId ? -1 : 1);
  });
  plan.skipped.sort((a, b) => a.ticker.localeCompare(b.ticker) || (a.securityId < b.securityId ? -1 : 1));
  const budget = opts.maxRequests ?? entries.length;
  plan.work = entries.slice(0, Math.max(0, budget));
  plan.deferred = entries.slice(Math.max(0, budget));
  return plan;
}

/** Provider-mode securities in the fetch set, eligible now, whose latest provider close is before `expectedThrough` (the scheduler's catch-up test). */
export async function countSecuritiesBehind(db: DbOrTx, opts: { now: Date; today: IsoDate; expectedThrough: IsoDate }): Promise<number> {
  const plan = await priceFetchPlan(db, opts);
  return plan.work.filter((e) => e.latestProviderDate === null || e.latestProviderDate < opts.expectedThrough).length;
}

// ---- Status and health ----

export interface PriceFeedConfig {
  /** `PRICE_PROVIDER`; null = `none`. */
  provider: PriceProviderId | null;
  fetchHourLocal?: number;
  catchupHourLocal?: number | null;
}

/** Bigint twin of `SecurityPriceStatusView`. */
export interface SecurityPriceStatusRecord {
  securityId: string;
  ticker: string | null;
  name: string;
  priceMode: PriceSource;
  providerSymbol: string | null;
  alwaysPrice: boolean;
  held: boolean;
  /** In the fetch set (held, always priced or the benchmark): the only rows the stale count covers. */
  fetched: boolean;
  latestPriceDate: IsoDate | null;
  latestClose: Fixed8 | null;
  latestSource: PriceSource | null;
  priceStatus: PriceStatus;
  tradingDaysBehind: number;
  fetchStatus: PriceFetchStatus | null;
  fetchMessage: string | null;
  fetchedAt: Date | null;
  failures: number;
  nextAttemptAt: Date | null;
  backfilledFrom: IsoDate | null;
}

export interface PriceRunRecord {
  importLogId: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: "running" | "ok" | "error";
  message: string | null;
  stats: Record<string, number> | null;
}

export interface PricesStatus {
  provider: PriceProviderId | null;
  configured: boolean;
  fetchHourLocal: number;
  catchupHourLocal: number | null;
  timezone: string;
  today: IsoDate;
  expectedDate: IsoDate;
  lastRun: PriceRunRecord | null;
  activeJob: { id: string; status: JobStatus; reason: string; runAt: Date } | null;
  securities: SecurityPriceStatusRecord[];
  counts: { current: number; stale: number; notFound: number; error: number; implied: number; manual: number };
}

/** The latest `prices.fetch` import_log row. */
export async function lastPriceRun(db: DbOrTx): Promise<PriceRunRecord | null> {
  const [row] = await db
    .select({ id: importLog.id, startedAt: importLog.startedAt, finishedAt: importLog.finishedAt, status: importLog.status, message: importLog.message, stats: importLog.stats })
    .from(importLog)
    .where(eq(importLog.kind, "prices.fetch"))
    .orderBy(desc(importLog.startedAt), desc(importLog.id))
    .limit(1);
  if (!row) return null;
  return { importLogId: row.id, startedAt: row.startedAt, finishedAt: row.finishedAt, status: row.status, message: row.message, stats: row.stats ?? null };
}

/**
 * The Prices page (`GET /api/prices/status`): the feed's configuration, the last run, any
 * queued or running job, and one row per non-archived `provider` security plus the held
 * `implied` / `manual` ones (never the cash security), with the user-facing status of
 * `priceStatusOf` on the expected close. `counts.stale` and `counts.current` cover the fetch
 * set only; a provider security nobody holds is listed but not counted as behind.
 */
export async function pricesStatus(db: DbOrTx, opts: { now: Date } & PriceFeedConfig): Promise<PricesStatus> {
  const setting = await getHouseholdSetting(db);
  const today = householdToday(setting, opts.now);
  const expectedDate = expectedPriceDate(opts.now);
  const held = await loadHeldSecurities(db);
  const fetchSet = await fetchSetIds(db, today);
  const rows = await db
    .select()
    .from(security)
    .where(and(eq(security.archived, false), sql`${security.type} <> 'cash'`));
  const listed = rows.filter((s) => s.priceMode === "provider" || held.has(s.id));
  const latest = await latestPrices(
    db,
    listed.map((s) => s.id),
  );
  const securities: SecurityPriceStatusRecord[] = listed
    .map((s) => {
      const lp = latest.get(s.id) ?? null;
      const status = priceStatusOf({ type: s.type, priceMode: s.priceMode }, lp?.date ?? null, expectedDate, expectedDate, "missing");
      return {
        securityId: s.id,
        ticker: s.ticker,
        name: s.name,
        priceMode: s.priceMode,
        providerSymbol: s.providerSymbol,
        alwaysPrice: s.alwaysPrice,
        held: held.has(s.id),
        fetched: s.priceMode === "provider" && fetchSet.has(s.id),
        latestPriceDate: lp?.date ?? null,
        latestClose: lp?.close ?? null,
        latestSource: lp?.source ?? null,
        priceStatus: status.priceStatus,
        tradingDaysBehind: status.tradingDaysBehind,
        fetchStatus: s.priceFetchStatus,
        fetchMessage: s.priceFetchMessage,
        fetchedAt: s.priceFetchedAt,
        failures: s.priceFetchFailures,
        nextAttemptAt: s.priceNextAttemptAt,
        backfilledFrom: s.priceBackfilledFrom,
      };
    })
    .sort((a, b) => {
      if (a.ticker !== null && b.ticker === null) return -1;
      if (a.ticker === null && b.ticker !== null) return 1;
      return (a.ticker ?? "").localeCompare(b.ticker ?? "") || a.name.localeCompare(b.name) || (a.securityId < b.securityId ? -1 : 1);
    });
  const counts = { current: 0, stale: 0, notFound: 0, error: 0, implied: 0, manual: 0 };
  for (const s of securities) {
    if (s.priceMode === "implied") counts.implied++;
    if (s.priceMode === "manual") counts.manual++;
    if (s.priceMode !== "provider") continue;
    if (s.fetchStatus === "not_found") counts.notFound++;
    if (s.fetchStatus === "error" || s.fetchStatus === "rate_limited") counts.error++;
    if (!s.fetched) continue;
    if (s.priceStatus === "current") counts.current++;
    else if (s.priceStatus === "stale" || s.priceStatus === "missing") counts.stale++;
  }
  const [active] = await db
    .select({ id: job.id, status: job.status, payload: job.payload, runAt: job.runAt })
    .from(job)
    .where(and(eq(job.type, "prices.fetch"), inArray(job.status, ["queued", "running"])))
    .orderBy(sql`case ${job.status} when 'running' then 0 else 1 end`, asc(job.runAt), asc(job.createdAt))
    .limit(1);
  return {
    provider: opts.provider,
    configured: opts.provider !== null,
    fetchHourLocal: opts.fetchHourLocal ?? 18,
    catchupHourLocal: opts.catchupHourLocal === undefined ? 6 : opts.catchupHourLocal,
    timezone: setting.timezone,
    today,
    expectedDate,
    lastRun: await lastPriceRun(db),
    activeJob: active ? { id: active.id, status: active.status, reason: typeof active.payload["reason"] === "string" ? active.payload["reason"] : "manual", runAt: active.runAt } : null,
    securities,
    counts,
  };
}

export interface PriceFeedHealth {
  configured: boolean;
  provider: PriceProviderId | null;
  expectedDate: IsoDate;
  lastRunAt: Date | null;
  /** Provider-mode securities in the fetch set whose latest close is behind the expected one (or missing). */
  stale: number;
  notFound: number;
  error: number;
}

/** The dashboard's `priceFeed` block (seams C47): the status counts without the per-security rows. */
export async function priceFeedHealth(db: DbOrTx, opts: { now: Date } & PriceFeedConfig): Promise<PriceFeedHealth> {
  const status = await pricesStatus(db, opts);
  return {
    configured: status.configured,
    provider: status.provider,
    expectedDate: status.expectedDate,
    lastRunAt: status.lastRun?.startedAt ?? null,
    stale: status.counts.stale,
    notFound: status.counts.notFound,
    error: status.counts.error,
  };
}

/** The user-facing status of one security's latest close on the expected date (the price-history route). */
export async function securityPriceStatus(db: DbOrTx, securityId: string, now: Date): Promise<{ priceMode: PriceSource; expectedDate: IsoDate; latest: PriceRecord | null; priceStatus: PriceStatus; tradingDaysBehind: number }> {
  const row = await requireSecurity(db, securityId);
  const expectedDate = expectedPriceDate(now);
  const [latestRow] = await db.select().from(price).where(eq(price.securityId, securityId)).orderBy(desc(price.date)).limit(1);
  const latest = latestRow ? toRecord(latestRow) : null;
  const status = priceStatusOf({ type: row.type, priceMode: row.priceMode }, latest?.date ?? null, expectedDate, expectedDate, "missing");
  return { priceMode: row.priceMode, expectedDate, latest, ...status };
}

