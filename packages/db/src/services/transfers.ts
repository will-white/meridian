import { and, gte, inArray, isNull, lte, or, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addDays, pairTransfers, type IsoDate } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { transaction } from "../schema/index.js";

export interface PairTransfersInDbOptions {
  /** Only consider rows dated on or after this (minus the pairing window). */
  since?: IsoDate;
  until?: IsoDate;
  maxDays?: number;
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

/** Undo a pair (user says "this is not a transfer"). Clears both legs. */
export async function unpairTransfer(tx: DbOrTx, transactionId: string): Promise<void> {
  const [row] = await tx.select({ pairId: transaction.transferPairId }).from(transaction).where(eq(transaction.id, transactionId));
  const pairId = row?.pairId;
  await tx
    .update(transaction)
    .set({ transferPairId: null, isTransfer: false, updatedAt: new Date() })
    .where(pairId ? or(eq(transaction.transferPairId, pairId), eq(transaction.id, transactionId)) : eq(transaction.id, transactionId));
}
