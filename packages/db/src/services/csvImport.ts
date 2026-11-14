import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { MappedRow } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { importLog, transaction, transactionAlias } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { findSameTransactions, ingestTransactions, type IncomingTransaction } from "./ingest.js";
import { lockLedger } from "./ledgerLock.js";
import { loadRules } from "./rules.js";
import { pairTransfersInDb, releaseTransferPartners } from "./transfers.js";

export interface CsvImportResult {
  created: number;
  updated: number;
  replacedPending: number;
  removedPending: number;
  skipped: number;
  /** Rows the ledger already had from the feed or by hand (audit a5-ingest-transfers-01), or rows the household deleted. */
  duplicates: number;
  transfersPaired: number;
}

const toIncoming = (r: MappedRow): IncomingTransaction => {
  const item: IncomingTransaction = { externalId: r.externalId, date: r.date, amountCents: r.amountCents, description: r.description, pending: false };
  if (r.memo) item.memo = r.memo;
  return item;
};

/**
 * Import mapped CSV rows into one account. Rows are posted; dedupe is by content hash, then by
 * purchase: a row that is the same purchase as one the feed or the household already has
 * (`findSameTransactions`) is not inserted, and its id is kept so a re-import knows it.
 */
export async function importCsvRows(db: Db, options: { accountId: string; rows: readonly MappedRow[]; importLogId?: string }): Promise<CsvImportResult> {
  const rules = await loadRules(db);
  const ingestOptions: Parameters<typeof ingestTransactions>[2] = { accountId: options.accountId, source: "csv", rules };
  if (options.importLogId) ingestOptions.importLogId = options.importLogId;
  const stats = await ingestTransactions(db, options.rows.map(toIncoming), ingestOptions);
  let transfersPaired = 0;
  // New rows, or legs released because a bank id came back with another amount (a10-conformance-ledger-06), may pair.
  if (stats.created > 0 || stats.releasedTransfers > 0) {
    const dates = [...options.rows.map((r) => r.date), ...(stats.earliestReleased ? [stats.earliestReleased] : [])].sort();
    const since = dates[0];
    const until = dates[dates.length - 1];
    transfersPaired = await db.transaction((tx) => pairTransfersInDb(tx, since && until ? { since, until } : {}));
  }
  const { insertedIds: _ignored, releasedTransfers: _released, earliestReleased: _earliest, ...rest } = stats;
  return { ...rest, transfersPaired };
}

/**
 * The external ids of rows a commit would not insert because the ledger has them (the Import
 * page's duplicates): the same id, an id kept for another row or for a deleted one, or the same
 * purchase from the feed or entered by hand (audit a5-ingest-transfers-01). The same rules as
 * `importCsvRows`, read only.
 */
export async function csvDuplicateIds(db: DbOrTx, accountId: string, rows: readonly MappedRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(rows.map((r) => r.externalId))];
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const known = await db
      .select({ externalId: transaction.externalId })
      .from(transaction)
      .where(and(eq(transaction.accountId, accountId), inArray(transaction.externalId, slice)));
    for (const k of known) if (k.externalId) out.add(k.externalId);
    const aliases = await db
      .select({ externalId: transactionAlias.externalId })
      .from(transactionAlias)
      .where(and(eq(transactionAlias.accountId, accountId), inArray(transactionAlias.externalId, slice)));
    for (const a of aliases) out.add(a.externalId);
  }
  const unknown = rows.filter((r) => !out.has(r.externalId));
  const same = await findSameTransactions(db, accountId, "csv", unknown.map(toIncoming));
  for (const id of same.keys()) out.add(id);
  return out;
}

export interface UndoCsvImportResult {
  /** Rows the import created that were removed. */
  removed: number;
  /** Ids the import had recorded for rows the ledger already had, forgotten again. */
  forgotten: number;
}

/**
 * Audit a5-ingest-transfers-09: take a bank CSV import back out. The rows it created (still CSV
 * rows: one the feed has taken over since is the feed's) are deleted, their transfer partners
 * released, and the ids it recorded for rows the ledger already had are forgotten, so the same
 * file can be imported again (into the right account, or with the right mapping). The import
 * log keeps the file and says when it was undone. 404 for an unknown import, 400 for one that is
 * not a bank CSV, 409 `already_undone`. Audited as `import_log`.
 */
export async function undoCsvImport(db: Db, importLogId: string, audit: AuditContext): Promise<UndoCsvImportResult> {
  return db.transaction(async (tx) => {
    await lockLedger(tx);
    const [log] = await tx.select().from(importLog).where(eq(importLog.id, importLogId));
    if (!log) throw new PlanError(404, "not_found", "Import not found");
    if (log.kind !== "csv") throw new PlanError(400, "not_bank_csv", "Only a bank CSV import can be undone here");
    if (typeof log.stats?.["undoneAt"] === "number") throw new PlanError(409, "already_undone", "This import was undone already");
    const rows = await tx
      .select({ id: transaction.id, date: transaction.date })
      .from(transaction)
      .where(and(eq(transaction.importLogId, importLogId), eq(transaction.source, "csv")));
    const ids = rows.map((r) => r.id);
    const released = await releaseTransferPartners(tx, ids, await loadRules(tx));
    for (let i = 0; i < ids.length; i += 500) await tx.delete(transaction).where(inArray(transaction.id, ids.slice(i, i + 500)));
    const forgotten = await tx
      .delete(transactionAlias)
      .where(and(eq(transactionAlias.importLogId, importLogId), isNotNull(transactionAlias.transactionId)))
      .returning({ id: transactionAlias.id });
    const now = Date.now();
    await tx
      .update(importLog)
      .set({ stats: { ...(log.stats ?? {}), undoneAt: now, rowsRemoved: ids.length } })
      .where(eq(importLog.id, importLogId));
    await writeAudit(tx, { ...audit, entity: "import_log", entityId: importLogId, action: "delete", before: { kind: log.kind, rows: ids.length, ids: forgotten.length }, after: null });
    if (released.length > 0) {
      const dates = released.map((r) => r.date).sort();
      await pairTransfersInDb(tx, { since: dates[0]!, until: dates[dates.length - 1]! });
    }
    return { removed: ids.length, forgotten: forgotten.length };
  });
}
