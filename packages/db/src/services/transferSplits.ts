import { and, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../index.js";
import { split } from "../schema/index.js";

/**
 * A transfer has no split (Phase 2 plan A5; audit a8-ledger-ui-10). A transfer leaves the plan,
 * so lines that still put its money in categories would be counted by every reader of split
 * lines that does not also test `is_transfer` (the register's category filter listed a paired
 * row as Groceries spending). Every path that makes a row a transfer (the register's mark, a
 * pair by hand or by the sync, a rule's mark, an investment cash link) calls this afterwards:
 * the lines of those rows that are transfers now are removed, as picking one category removes
 * them. Rows that are not transfers keep theirs. Returns how many lines went.
 */
export async function dropTransferSplits(tx: DbOrTx, transactionIds: readonly string[]): Promise<number> {
  const ids = [...new Set(transactionIds)];
  let removed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await tx
      .delete(split)
      // Raw identifiers on purpose: drizzle unqualifies interpolated columns in single-table statements.
      .where(and(inArray(split.transactionId, ids.slice(i, i + 500)), sql`exists (select 1 from "transaction" t where t.id = "split"."transaction_id" and t.is_transfer = true)`))
      .returning({ id: split.id });
    removed += rows.length;
  }
  return removed;
}
