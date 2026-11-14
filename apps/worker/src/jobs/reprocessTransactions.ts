import { and, asc, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import { connection, errorMessageOf, importLog, replayAccountSetTransactions, type JobRow } from "@meridian/db";
import { readSimplefinAccountSet, sanitizeText } from "@meridian/shared";
import type { JobContext } from "./context.js";

export interface ReprocessTransactionsOutcome {
  /** The summary `import_log` row (kind `simplefin.reprocess`); null when the connection is gone. */
  importLogId: string | null;
  /** Stored payloads replayed. */
  payloads: number;
  /** Stored payloads that no longer read as an Account Set. */
  payloadsUnparseable: number;
  /**
   * Of the payloads replayed, those of syncs that failed after the response was stored (an older
   * ingest crashed on it): audit a5-ingest-transfers, second round. A failed sync's body that is
   * not an account set with an account (a 502 page, kept as `{ notJson }`) is passed over.
   */
  payloadsFailedSync: number;
  /** Feed accounts in a payload with no open account on the connection (summed over payloads). */
  accountsUnknown: number;
  created: number;
  updated: number;
  /** Pending rows a payload showed posted under a new id, replaced in place (audit a8-ledger-ui-02, second round). */
  replacedPending: number;
  duplicates: number;
  skipped: number;
  transfersPaired: number;
}

/** Payloads read per query; every stored sync payload of the connection is replayed, a page at a time. */
const PAGE = 50;

/**
 * `simplefin.reprocess_transactions` (audit a5-ingest-transfers-13; spec sync step 6, "kept for
 * re-processing"): replay the connection's stored sync payloads (`import_log.raw_payload` of
 * full syncs, oldest first, or the one named by `importLogId`; those of syncs that failed after
 * the response was stored too, when it reads as an account set: second round) through
 * `replayAccountSetTransactions`, so a transaction an older reader or ingest missed is read
 * again, however old, and so are the days an account was closed when it is reopened (audit
 * a8-ledger-ui-02). Replay mode inserts only posted items the ledger lacks; it never inserts a
 * pending item, removes a pending row or changes a posted row the ledger has. A pending row
 * whose purchase a payload shows posted is posted (same id) or replaced in place (new id), as
 * the sync does (second round), so a second run changes nothing. Each replayed row gets
 * `stats.transactionsReprocessedAt`; the run writes a summary row of kind `simplefin.reprocess`
 * with no raw payload.
 */
export async function runReprocessTransactionsJob(ctx: JobContext, job: JobRow): Promise<ReprocessTransactionsOutcome> {
  const connectionId = String(job.payload["connectionId"] ?? "");
  const onlyImportLogId = typeof job.payload["importLogId"] === "string" ? job.payload["importLogId"] : undefined;
  const outcome: ReprocessTransactionsOutcome = { importLogId: null, payloads: 0, payloadsUnparseable: 0, payloadsFailedSync: 0, accountsUnknown: 0, created: 0, updated: 0, replacedPending: 0, duplicates: 0, skipped: 0, transfersPaired: 0 };
  const [conn] = await ctx.db.select({ id: connection.id }).from(connection).where(eq(connection.id, connectionId));
  if (!conn) {
    ctx.log.warn(`[simplefin.reprocess_transactions] connection ${connectionId} not found; nothing to replay`);
    return outcome;
  }
  const now = ctx.now();
  const [summary] = await ctx.db.insert(importLog).values({ connectionId, kind: "simplefin.reprocess", status: "running", startedAt: now }).returning({ id: importLog.id });
  const summaryId = summary!.id;
  outcome.importLogId = summaryId;
  try {
    let after: { startedAt: Date; id: string } | undefined;
    for (;;) {
      const rows = await ctx.db
        .select({ id: importLog.id, startedAt: importLog.startedAt, status: importLog.status, rawPayload: importLog.rawPayload, stats: importLog.stats })
        .from(importLog)
        .where(
          and(
            eq(importLog.connectionId, connectionId),
            eq(importLog.kind, "simplefin.sync"),
            // A sync that failed after its response was stored (an older ingest crashed on it) is the one an ingest fix most needs to replay.
            inArray(importLog.status, ["ok", "error"]),
            isNotNull(importLog.rawPayload),
            onlyImportLogId ? eq(importLog.id, onlyImportLogId) : undefined,
            after ? or(gt(importLog.startedAt, after.startedAt), and(eq(importLog.startedAt, after.startedAt), gt(importLog.id, after.id))) : undefined,
          ),
        )
        .orderBy(asc(importLog.startedAt), asc(importLog.id))
        .limit(PAGE);
      for (const row of rows) {
        let accountSet;
        try {
          accountSet = readSimplefinAccountSet(row.rawPayload).set;
        } catch {
          // A failed sync's body may never have been an account set (an HTTP error page); only an ok one counts as unreadable.
          if (row.status === "ok") outcome.payloadsUnparseable++;
          continue;
        }
        if (row.status !== "ok") {
          if (accountSet.accounts.length === 0) continue;
          outcome.payloadsFailedSync++;
        }
        const replayed = await replayAccountSetTransactions(ctx.db, { connectionId, accountSet, importLogId: row.id, now });
        outcome.payloads++;
        outcome.accountsUnknown += replayed.accountsUnknown;
        outcome.created += replayed.stats.created;
        outcome.updated += replayed.stats.updated;
        outcome.replacedPending += replayed.stats.replacedPending;
        outcome.duplicates += replayed.stats.duplicates;
        outcome.skipped += replayed.stats.skipped;
        outcome.transfersPaired += replayed.transfersPaired;
        await ctx.db
          .update(importLog)
          .set({ stats: { ...(row.stats ?? {}), transactionsReprocessedAt: now.getTime() } })
          .where(eq(importLog.id, row.id));
      }
      if (rows.length < PAGE) break;
      const last = rows[rows.length - 1]!;
      after = { startedAt: last.startedAt, id: last.id };
    }
    const { importLogId: _id, ...counts } = outcome;
    await ctx.db
      .update(importLog)
      .set({ status: "ok", finishedAt: ctx.now(), stats: counts, message: `Reprocessed transactions from ${outcome.payloads} payloads` })
      .where(eq(importLog.id, summaryId));
    return outcome;
  } catch (err) {
    const message = errorMessageOf(err);
    await ctx.db.update(importLog).set({ status: "error", finishedAt: ctx.now(), message: sanitizeText(message, 300) }).where(eq(importLog.id, summaryId));
    throw err;
  }
}
