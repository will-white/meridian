import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { MappedRow } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, connection, importLog, transaction, transactionAlias } from "../schema/index.js";
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
      .select({ id: transaction.id, date: transaction.date, accountId: transaction.accountId })
      .from(transaction)
      .where(and(eq(transaction.importLogId, importLogId), eq(transaction.source, "csv")));
    const ids = rows.map((r) => r.id);
    // The log keeps the account it went into, so the Import page's history still names it once its rows are gone (second round).
    if (!namedAccount(log.rawPayload)) {
      const accountId =
        rows[0]?.accountId ?? (await tx.select({ accountId: transactionAlias.accountId }).from(transactionAlias).where(eq(transactionAlias.importLogId, importLogId)).limit(1))[0]?.accountId;
      if (accountId) await tx.update(importLog).set({ rawPayload: sql`coalesce(${importLog.rawPayload}, '{}'::jsonb) || jsonb_build_object('accountId', ${accountId}::text)` }).where(eq(importLog.id, importLogId));
    }
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account a bank CSV import's stored payload names (commits record it since the second round of the audit). */
function namedAccount(rawPayload: unknown): string | null {
  if (typeof rawPayload !== "object" || rawPayload === null) return null;
  const id = (rawPayload as Record<string, unknown>)["accountId"];
  return typeof id === "string" && UUID.test(id) ? id : null;
}

export interface CsvImportHistoryRow {
  id: string;
  startedAt: Date;
  status: string;
  accountId: string | null;
  accountName: string | null;
  profileName: string | null;
  rowsRead: number;
  created: number;
  duplicates: number;
  /** Rows the import created that are still CSV rows: what an undo removes. */
  rowsHeld: number;
  undoneAt: Date | null;
}

/**
 * Audit a5-ingest-transfers, second round: the latest bank CSV imports, newest first, for the
 * Import page's history, so an import can be undone (`undoCsvImport`) after the page that made
 * it is gone: the account it went into (the one its log names, else the account of a row it
 * created or of an id it recorded, for imports made before commits named it), its saved
 * mapping, what it did, the rows it still holds and when it was undone. A handful of queries
 * over the listed imports, whatever the size of the ledger's history.
 */
export async function listCsvImports(db: DbOrTx, limit = 25): Promise<CsvImportHistoryRow[]> {
  const logs = await db
    .select({ id: importLog.id, startedAt: importLog.startedAt, status: importLog.status, stats: importLog.stats, connectionId: importLog.connectionId })
    .from(importLog)
    .where(eq(importLog.kind, "csv"))
    .orderBy(desc(importLog.startedAt), desc(importLog.id))
    .limit(limit);
  if (logs.length === 0) return [];
  const ids = logs.map((l) => l.id);
  const accountOf = new Map<string, string>();
  for (const r of await db.select({ id: importLog.id, accountId: sql<string | null>`${importLog.rawPayload} ->> 'accountId'` }).from(importLog).where(inArray(importLog.id, ids))) {
    const named = namedAccount({ accountId: r.accountId });
    if (named) accountOf.set(r.id, named);
  }
  const unnamed = ids.filter((id) => !accountOf.has(id));
  if (unnamed.length > 0) {
    for (const r of await db.selectDistinctOn([transaction.importLogId], { id: transaction.importLogId, accountId: transaction.accountId }).from(transaction).where(inArray(transaction.importLogId, unnamed))) {
      if (r.id) accountOf.set(r.id, r.accountId);
    }
    const still = unnamed.filter((id) => !accountOf.has(id));
    if (still.length > 0) {
      for (const r of await db.selectDistinctOn([transactionAlias.importLogId], { id: transactionAlias.importLogId, accountId: transactionAlias.accountId }).from(transactionAlias).where(inArray(transactionAlias.importLogId, still))) {
        if (r.id) accountOf.set(r.id, r.accountId);
      }
    }
  }
  const held = new Map(
    (
      await db
        .select({ id: transaction.importLogId, n: sql<number>`count(*)::int` })
        .from(transaction)
        .where(and(inArray(transaction.importLogId, ids), eq(transaction.source, "csv")))
        .groupBy(transaction.importLogId)
    ).map((r) => [r.id, r.n]),
  );
  const accountIds = [...new Set(accountOf.values())];
  const accountNames = new Map(accountIds.length > 0 ? (await db.select({ id: account.id, name: account.name }).from(account).where(inArray(account.id, accountIds))).map((a) => [a.id, a.name]) : []);
  const profileIds = [...new Set(logs.flatMap((l) => (l.connectionId ? [l.connectionId] : [])))];
  const profileNames = new Map(profileIds.length > 0 ? (await db.select({ id: connection.id, name: connection.name }).from(connection).where(inArray(connection.id, profileIds))).map((c) => [c.id, c.name]) : []);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return logs.map((l) => {
    const accountId = accountOf.get(l.id) ?? null;
    return {
      id: l.id,
      startedAt: l.startedAt,
      status: l.status,
      accountId,
      accountName: accountId ? (accountNames.get(accountId) ?? null) : null,
      profileName: l.connectionId ? (profileNames.get(l.connectionId) ?? null) : null,
      rowsRead: num(l.stats?.["rowsRead"]),
      created: num(l.stats?.["created"]),
      duplicates: num(l.stats?.["duplicates"]),
      rowsHeld: held.get(l.id) ?? 0,
      undoneAt: typeof l.stats?.["undoneAt"] === "number" ? new Date(l.stats["undoneAt"]) : null,
    };
  });
}
