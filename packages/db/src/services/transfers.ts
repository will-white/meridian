import { and, gte, inArray, isNull, lte, ne, notExists, or, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addDays, pairTransfers, type IsoDate } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { investmentTxn, transaction } from "../schema/index.js";

export interface PairTransfersInDbOptions {
  /** Only consider rows dated on or after this (minus the pairing window). */
  since?: IsoDate;
  until?: IsoDate;
  maxDays?: number;
}

/**
 * Phase 3 (plan decision 13, views design §3.13): synthetic income-feed rows and ledger rows
 * linked to an income `investment_txn` (dividend, interest, reinvest, fee) are never pairing
 * or recurring-detection candidates; a row linked to a cash `transfer` still is.
 */
export function notInvestmentIncomeRow(tx: DbOrTx) {
  return and(
    ne(transaction.source, "investment"),
    notExists(
      tx
        .select({ one: sql`1` })
        .from(investmentTxn)
        .where(and(eq(investmentTxn.ledgerTransactionId, transaction.id), inArray(investmentTxn.type, ["dividend", "interest", "reinvest", "fee"]))),
    ),
  );
}

/**
 * Pair unpaired transactions across the household's accounts and persist the pairs.
 * Both legs get the same pair id, `is_transfer`, and lose their category unless locked.
 */
export async function pairTransfersInDb(tx: DbOrTx, options: PairTransfersInDbOptions = {}): Promise<number> {
  const maxDays = options.maxDays ?? 3;
  const rows = await tx
    .select({ id: transaction.id, accountId: transaction.accountId, date: transaction.date, amountCents: transaction.amountCents })
    .from(transaction)
    .where(
      and(
        isNull(transaction.transferPairId),
        options.since ? gte(transaction.date, addDays(options.since, -maxDays)) : undefined,
        options.until ? lte(transaction.date, addDays(options.until, maxDays)) : undefined,
        notInvestmentIncomeRow(tx),
      ),
    );
  const pairs = pairTransfers(rows, { maxDays });
  for (const pair of pairs) {
    const pairId = randomUUID();
    await tx
      .update(transaction)
      .set({ transferPairId: pairId, isTransfer: true, updatedAt: new Date() })
      .where(inArray(transaction.id, [pair.outflowId, pair.inflowId]));
    await tx
      .update(transaction)
      .set({ categoryId: null })
      .where(and(inArray(transaction.id, [pair.outflowId, pair.inflowId]), eq(transaction.categoryLocked, false)));
  }
  return pairs.length;
}

/**
 * Mark ledger rows as transfers the way pairing marks its legs, without a pair: `is_transfer`,
 * and the category goes unless the owner locked it. Rows that are transfers already are left
 * alone. Used when an investment cash transfer is linked to the bank's row of the same money
 * (docs/phase-3-plan.md, audit decision A5): a deposit or a withdrawal the trade history names
 * is a transfer whatever the bank's description says. Returns how many rows changed.
 */
export async function markAsTransfers(tx: DbOrTx, transactionIds: readonly string[]): Promise<number> {
  const ids = [...new Set(transactionIds)];
  let changed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await tx
      .update(transaction)
      .set({ isTransfer: true, updatedAt: new Date() })
      .where(and(inArray(transaction.id, ids.slice(i, i + 500)), eq(transaction.isTransfer, false)))
      .returning({ id: transaction.id });
    if (rows.length === 0) continue;
    changed += rows.length;
    await tx
      .update(transaction)
      .set({ categoryId: null })
      .where(and(inArray(transaction.id, rows.map((r) => r.id)), eq(transaction.categoryLocked, false)));
  }
  return changed;
}

/** Undo a pair (user says "this is not a transfer"). Clears both legs. */
export async function unpairTransfer(tx: DbOrTx, transactionId: string): Promise<void> {
  const [row] = await tx.select({ pairId: transaction.transferPairId }).from(transaction).where(eq(transaction.id, transactionId));
  const pairId = row?.pairId;
  await tx
    .update(transaction)
    .set({ transferPairId: null, isTransfer: false, updatedAt: new Date() })
    .where(pairId ? or(eq(transaction.transferPairId, pairId), eq(transaction.id, transactionId)) : eq(transaction.id, transactionId));
}
