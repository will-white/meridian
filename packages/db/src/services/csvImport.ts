import type { MappedRow } from "@meridian/shared";
import type { Db } from "../index.js";
import { ingestTransactions } from "./ingest.js";
import { loadRules } from "./rules.js";
import { pairTransfersInDb } from "./transfers.js";

export interface CsvImportResult {
  created: number;
  updated: number;
  replacedPending: number;
  removedPending: number;
  skipped: number;
  transfersPaired: number;
}

/** Import mapped CSV rows into one account. Rows are posted; dedupe is by content hash. */
export async function importCsvRows(db: Db, options: { accountId: string; rows: readonly MappedRow[]; importLogId?: string }): Promise<CsvImportResult> {
  const rules = await loadRules(db);
  const ingestOptions: Parameters<typeof ingestTransactions>[2] = { accountId: options.accountId, source: "csv", rules };
  if (options.importLogId) ingestOptions.importLogId = options.importLogId;
  const stats = await ingestTransactions(
    db,
    options.rows.map((r) => {
      const item: Parameters<typeof ingestTransactions>[1][number] = {
        externalId: r.externalId,
        date: r.date,
        amountCents: r.amountCents,
        description: r.description,
        pending: false,
      };
      if (r.memo) item.memo = r.memo;
      return item;
    }),
    ingestOptions,
  );
  let transfersPaired = 0;
  if (stats.created > 0) {
    const dates = options.rows.map((r) => r.date).sort();
    const since = dates[0];
    const until = dates[dates.length - 1];
    transfersPaired = await db.transaction((tx) => pairTransfersInDb(tx, since && until ? { since, until } : {}));
  }
  const { insertedIds: _ignored, ...rest } = stats;
  return { ...rest, transfersPaired };
}
