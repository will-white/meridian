import { eq } from "drizzle-orm";
import { applyAccountSet, connection, enqueueJob, importLog, requestPriceRefresh, type ConnectionError, type HoldingsStats, type JobRow } from "@meridian/db";
import { addDays, decryptSecret, highWaterMarkAfterSync, syncWindowStart, toIsoDate, type IsoDate, type SyncWindowConfig } from "@meridian/shared";
import { priceConfigOf } from "../env.js";
import { fetchAccounts, SimplefinError } from "../simplefin/client.js";
import type { JobContext } from "./context.js";

export interface SyncOutcome {
  importLogId: string;
  windowStart?: IsoDate;
  accounts: number;
  created: number;
  updated: number;
  replacedPending: number;
  removedPending: number;
  transfersPaired: number;
  errors: number;
  /** Phase 3: holdings written from `account.holdings` / `extra`. */
  holdings: HoldingsStats;
  investmentTxnsLinked: number;
}

export { syncWindowStart };

/**
 * The entry a sync leaves on the connection when the window could not reach back to the
 * high-water mark: the mark is older than the most a sync asks for (a bank unreadable, or the
 * worker off, for longer than the first-sync window less the overlap), so the days between
 * the mark and the window were never requested. Null when the window reaches the mark.
 */
export function syncGapNotice(previous: IsoDate | null, windowStart: IsoDate, config: SyncWindowConfig): ConnectionError | null {
  if (previous === null) return null;
  const from = addDays(previous, 1);
  const to = addDays(windowStart, -1);
  if (from > to) return null;
  return {
    code: "sync.gap",
    message: `The last complete sync was ${previous}. A sync asks the Bridge for at most ${config.initialWindowDays} days, so transactions from ${from} to ${to} were not requested. Import a CSV from the bank for that period if any are missing.`,
  };
}

/**
 * GET /accounts for one connection, store the raw payload, apply it (accounts, balances,
 * holdings, transactions, transfers, investment-row links), update the connection's
 * status, then queue the follow-ups: a recurring run after every full sync, a holdings
 * price fetch when a security was created (only with a provider configured), and the income
 * feed when a synced investment account has one (plan decision 18).
 *
 * The high-water mark moves only when the response was complete (`highWaterMarkAfterSync`):
 * a 200 that carries a connection or account problem, or a stale copy of an account, leaves
 * it where it was, so the window keeps reaching back to the last complete sync. Every run,
 * whether it worked or not, records `last_attempt_at`, which is what the scheduler spaces
 * syncs from; a refusal that retrying cannot fix (403, 402) also pauses scheduled syncs, and
 * a failed run empties `last_errors`, which described the response before it.
 */
export async function runSyncJob(ctx: JobContext, job: JobRow): Promise<SyncOutcome> {
  const connectionId = String(job.payload["connectionId"] ?? "");
  const balancesOnly = job.type === "simplefin.balances" || job.payload["balancesOnly"] === true;
  const [conn] = await ctx.db.select().from(connection).where(eq(connection.id, connectionId));
  if (!conn) throw new Error(`connection ${connectionId} not found`);
  if (conn.type !== "simplefin" || !conn.accessUrlEnc) throw new Error(`connection ${connectionId} has no access URL`);
  if (conn.status === "disabled") throw new Error(`connection ${connectionId} is disabled`);

  const today = toIsoDate(ctx.now());
  const fullResync = job.payload["fullResync"] === true;
  // A full resync asks for the whole first-sync window; the mark itself is kept until the response is in.
  const windowStart = balancesOnly ? undefined : syncWindowStart(fullResync ? null : conn.syncedThrough, today, ctx.config);
  const gap = windowStart ? syncGapNotice(conn.syncedThrough, windowStart, ctx.config) : null;
  const kind = balancesOnly ? "simplefin.balances" : "simplefin.sync";
  const [log] = await ctx.db.insert(importLog).values({ connectionId, kind }).returning({ id: importLog.id });
  const importLogId = log!.id;

  try {
    const accessUrl = await decryptSecret(conn.accessUrlEnc, ctx.config.secretsKey);
    const query: Parameters<typeof fetchAccounts>[1] = balancesOnly ? { balancesOnly: true } : { pending: true };
    if (windowStart) query.startDate = windowStart;
    const result = await fetchAccounts(accessUrl, query, ctx.client);

    // Raw payload first, so a crash while applying never loses the data.
    await ctx.db.update(importLog).set({ rawPayload: result.raw as Record<string, unknown> }).where(eq(importLog.id, importLogId));

    const applyOptions: Parameters<typeof applyAccountSet>[1] = { connectionId, importLogId, accountSet: result.set, balancesOnly, now: ctx.now() };
    if (windowStart) applyOptions.windowStart = windowStart;
    const applied = await applyAccountSet(ctx.db, applyOptions);

    const errors = gap ? [...applied.errors, gap] : applied.errors;
    const authError = applied.errors.some((e) => e.code === "con.auth");
    const mark =
      windowStart === undefined
        ? undefined
        : highWaterMarkAfterSync({
            previous: conn.syncedThrough,
            today,
            windowStart,
            incomplete: applied.incomplete,
            accountsCreated: applied.accountsCreated,
            balanceDates: applied.balanceDates,
            config: ctx.config,
          });
    // One instant for both: "the last attempt was the last success" is read off their equality.
    const finishedAt = ctx.now();
    await ctx.db
      .update(connection)
      .set({
        status: authError ? "auth_required" : "ok",
        lastSyncAt: finishedAt,
        lastAttemptAt: finishedAt,
        // The Bridge answered: whatever paused the schedule is over.
        syncPaused: false,
        ...(mark === undefined ? {} : { syncedThrough: mark }),
        lastErrors: errors,
        lastError: authError ? "The Bridge reports this bank connection needs to be re-authenticated." : null,
        updatedAt: finishedAt,
      })
      .where(eq(connection.id, connectionId));

    const stats = {
      accounts: applied.accounts,
      accountsCreated: applied.accountsCreated,
      ...applied.stats,
      transfersPaired: applied.transfersPaired,
      ...applied.holdings,
      investmentTxnsLinked: applied.investmentTxnsLinked,
    };
    await ctx.db
      .update(importLog)
      .set({ status: "ok", finishedAt: ctx.now(), stats, errors, message: balancesOnly ? "Balances refreshed" : `Synced from ${windowStart}` })
      .where(eq(importLog.id, importLogId));

    // Every successful full sync is followed by one recurring run (suggestions, matcher, alerts); balances-only refreshes carry no transactions.
    if (!balancesOnly) await enqueueJob(ctx.db, "recurring.detect", { reason: "sync" }, { dedupe: true });
    // A security the feed introduced needs its closes (plan decision 10); with PRICE_PROVIDER=none nothing is queued.
    if (applied.holdings.securitiesCreated > 0 && priceConfigOf(ctx.config).provider !== null) {
      await requestPriceRefresh(ctx.db, { reason: "holdings", now: ctx.now() });
    }
    // The income feed links or creates the plan's rows for the dividends this sync may have delivered (plan decision 13).
    if (!balancesOnly && applied.incomeFeedAccounts > 0) {
      await enqueueJob(ctx.db, "investments.income_feed", { reason: "sync", dedupeKey: "investments.income_feed" }, { dedupe: true });
    }

    const outcome: SyncOutcome = {
      importLogId,
      accounts: applied.accounts,
      created: applied.stats.created,
      updated: applied.stats.updated,
      replacedPending: applied.stats.replacedPending,
      removedPending: applied.stats.removedPending,
      transfersPaired: applied.transfersPaired,
      errors: errors.length,
      holdings: applied.holdings,
      investmentTxnsLinked: applied.investmentTxnsLinked,
    };
    if (windowStart) outcome.windowStart = windowStart;
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof SimplefinError && err.kind === "forbidden" ? "auth_required" : "error";
    // 403 and 402 do not get better by asking again: the schedule stops until a sync started by hand succeeds.
    const paused = err instanceof SimplefinError && err.permanent;
    await ctx.db
      .update(connection)
      .set({
        status,
        lastError: message,
        // The entries of the last response describe a sync that is no longer the latest one.
        lastErrors: [],
        lastAttemptAt: ctx.now(),
        ...(paused ? { syncPaused: true } : {}),
        updatedAt: ctx.now(),
      })
      .where(eq(connection.id, connectionId));
    await ctx.db.update(importLog).set({ status: "error", finishedAt: ctx.now(), message }).where(eq(importLog.id, importLogId));
    if (paused && !conn.syncPaused) ctx.log.warn(`[sync] connection ${connectionId}: the Bridge refused the request; scheduled syncs are paused until a sync started from the Connections page succeeds`);
    throw err;
  }
}
