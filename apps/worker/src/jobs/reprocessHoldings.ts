import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  account,
  applySimplefinHoldings,
  connection,
  emptyHoldingsStats,
  getHouseholdSetting,
  householdToday,
  importLog,
  mergeHoldingsStats,
  type ConnectionError,
  type HoldingsStats,
  type JobRow,
} from "@meridian/db";
import { parseSimplefinHoldings, sanitizeText, SimplefinAccountSet, toIsoDate } from "@meridian/shared";
import type { JobContext } from "./context.js";

export interface ReprocessHoldingsOutcome extends HoldingsStats {
  /** The summary `import_log` row (kind `simplefin.reprocess`); null when the connection is gone. */
  importLogId: string | null;
  /** Stored payloads replayed. */
  payloads: number;
  /** Stored payloads that no longer parse as a protocol v2 Account Set. */
  payloadsUnparseable: number;
  /** Feed accounts in a payload with no account row on the connection. */
  accountsUnknown: number;
}

export const REPROCESS_PAYLOAD_CAP = 200;
const MAX_ERRORS_KEPT = 50;

/**
 * `simplefin.reprocess_holdings` (imports design §6; plan decision 18): replay the connection's
 * stored sync payloads (`import_log.raw_payload` of successful syncs and balance refreshes,
 * oldest first, capped at 200, or the one named by `importLogId`) through the holdings parser
 * and `applySimplefinHoldings` with source `simplefin`, so csv and manual snapshots are never
 * replaced. Each replayed row gets `stats.reprocessedAt`; the run writes its own summary row
 * of kind `simplefin.reprocess` with no raw payload (nothing new was fetched). Idempotent.
 */
export async function runReprocessHoldingsJob(ctx: JobContext, job: JobRow): Promise<ReprocessHoldingsOutcome> {
  const connectionId = String(job.payload["connectionId"] ?? "");
  const onlyImportLogId = typeof job.payload["importLogId"] === "string" ? job.payload["importLogId"] : undefined;
  const stats = emptyHoldingsStats();
  const outcome: ReprocessHoldingsOutcome = { importLogId: null, payloads: 0, payloadsUnparseable: 0, accountsUnknown: 0, ...stats };
  const [conn] = await ctx.db.select({ id: connection.id }).from(connection).where(eq(connection.id, connectionId));
  if (!conn) {
    ctx.log.warn(`[simplefin.reprocess_holdings] connection ${connectionId} not found; nothing to replay`);
    return outcome;
  }

  const now = ctx.now();
  const setting = await getHouseholdSetting(ctx.db);
  const household = householdToday(setting, now);
  const utc = toIsoDate(now);
  const today = household > utc ? household : utc;

  const rows = await ctx.db
    .select({ id: importLog.id, rawPayload: importLog.rawPayload, stats: importLog.stats })
    .from(importLog)
    .where(
      and(
        eq(importLog.connectionId, connectionId),
        inArray(importLog.kind, ["simplefin.sync", "simplefin.balances"]),
        eq(importLog.status, "ok"),
        isNotNull(importLog.rawPayload),
        onlyImportLogId ? eq(importLog.id, onlyImportLogId) : undefined,
      ),
    )
    .orderBy(asc(importLog.startedAt), asc(importLog.id))
    .limit(REPROCESS_PAYLOAD_CAP);
  const accounts = await ctx.db
    .select({ id: account.id, externalId: account.externalId, name: account.name, type: account.type })
    .from(account)
    .where(eq(account.connectionId, connectionId));
  const byExternalId = new Map(accounts.filter((a) => a.externalId !== null).map((a) => [a.externalId!, a]));

  const [summary] = await ctx.db.insert(importLog).values({ connectionId, kind: "simplefin.reprocess", status: "running", startedAt: now }).returning({ id: importLog.id });
  const summaryId = summary!.id;
  outcome.importLogId = summaryId;
  const errors: ConnectionError[] = [];
  const pushError = (e: ConnectionError) => {
    if (errors.length < MAX_ERRORS_KEPT) errors.push(e);
  };

  try {
    for (const row of rows) {
      const parsed = SimplefinAccountSet.safeParse(row.rawPayload);
      if (!parsed.success) {
        outcome.payloadsUnparseable++;
        continue;
      }
      for (const sf of parsed.data.accounts) {
        const acct = byExternalId.get(sf.id);
        if (!acct) {
          outcome.accountsUnknown++;
          continue;
        }
        try {
          const applied = await applySimplefinHoldings(ctx.db, {
            accountId: acct.id,
            accountName: acct.name,
            accountType: acct.type,
            simplefinAccountId: sf.id,
            parsed: parseSimplefinHoldings(sf),
            importLogId: row.id,
            today,
          });
          mergeHoldingsStats(stats, applied.stats);
          for (const e of applied.errors) pushError(e);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pushError({ code: "holdings.parse_error", message: sanitizeText(`${acct.name}: ${message}`, 300), accountId: sanitizeText(sf.id, 100) });
        }
      }
      outcome.payloads++;
      await ctx.db
        .update(importLog)
        .set({ stats: { ...(row.stats ?? {}), reprocessedAt: now.getTime() } })
        .where(eq(importLog.id, row.id));
    }
    const message = `Reprocessed holdings from ${outcome.payloads} payloads`;
    const summaryStats: Record<string, number> = { payloads: outcome.payloads, payloadsUnparseable: outcome.payloadsUnparseable, accountsUnknown: outcome.accountsUnknown, ...stats };
    await ctx.db.update(importLog).set({ status: "ok", finishedAt: ctx.now(), stats: summaryStats, errors, message }).where(eq(importLog.id, summaryId));
    return { ...outcome, ...stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db.update(importLog).set({ status: "error", finishedAt: ctx.now(), message: sanitizeText(message, 300), errors }).where(eq(importLog.id, summaryId));
    throw err;
  }
}
