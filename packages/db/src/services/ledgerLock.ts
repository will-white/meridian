import { sql } from "drizzle-orm";
import type { DbOrTx } from "../index.js";

/** Postgres advisory lock that writes to the ledger's rows take one at a time ("MRLG"). */
export const LEDGER_LOCK = 0x4d_52_4c_47;

/**
 * Audit a10-conformance-ledger-01: take the ledger lock for the rest of the current
 * transaction. Everything that decides from the rows it reads whether a row is new, the same
 * purchase as another one, or a leg of a transfer (an ingest from the feed or a CSV file, the
 * pairing pass, pairing by hand, a rule run, folding a feed account, deleting a row, undoing an
 * import) takes it first, so two of them never decide from rows the other has not committed
 * yet: a CSV commit in the API and a sync in the worker on the same days no longer both insert
 * every purchase, and two pairing passes no longer pair one leg twice. The lock is
 * transaction-scoped and re-entrant (a nested savepoint takes it again at no cost), so it must be
 * taken inside a transaction; outside one it is released at once and orders nothing.
 */
export async function lockLedger(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK})`);
}
