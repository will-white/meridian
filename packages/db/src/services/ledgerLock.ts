import { sql } from "drizzle-orm";
import type { DbOrTx } from "../index.js";

/** Postgres advisory lock that writes to the ledger's rows take one at a time ("MRLG"). */
export const LEDGER_LOCK = 0x4d_52_4c_47;

/** What `lockLedger` throws, under the lock-order check, in a transaction that wrote before taking it. */
export const LEDGER_LOCK_ORDER_MESSAGE = "The ledger lock was taken after this transaction had written; take it first";

let checkOrder = false;

/**
 * Audit a10-conformance-ledger-01, second round: turn on (the test harness does) the check that a
 * transaction takes the ledger lock before its first write. A transaction that writes rows and
 * then waits for the lock can deadlock with one that holds the lock and needs those rows: a trades
 * commit that marks a bank row a transfer and then ingests its cash rows, against a pairing pass
 * that pairs the same bank row. With the check on, `lockLedger` refuses to be taken late
 * (`LEDGER_LOCK_ORDER_MESSAGE`), so every path the suites run proves its order. Off in the apps:
 * there it would only turn a rare deadlock into a certain error.
 */
export function setLedgerLockOrderCheck(on: boolean): void {
  checkOrder = on;
}

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
 *
 * Second round: a transaction that takes it takes it before it writes anything (rows of any
 * table), so it never holds a row another lock holder waits for while it waits for the lock.
 * A transaction that writes and then calls something that takes the lock (an ingest, the pairing
 * pass) takes it at its start (`setLedgerLockOrderCheck` checks this in the tests).
 */
export async function lockLedger(tx: DbOrTx): Promise<void> {
  if (checkOrder) {
    const [state] = await tx.execute<{ wrote: boolean; held: boolean }>(sql`
      select pg_current_xact_id_if_assigned() is not null as wrote,
             exists (
               select 1 from pg_locks
               where pid = pg_backend_pid() and locktype = 'advisory' and granted
                 and classid = 0 and objid::text::bigint = ${LEDGER_LOCK} and objsubid = 1
             ) as held`);
    if (state?.wrote && !state.held) throw new Error(LEDGER_LOCK_ORDER_MESSAGE);
  }
  await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK})`);
}
