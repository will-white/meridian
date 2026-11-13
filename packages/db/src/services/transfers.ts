import { and, asc, gte, inArray, isNull, lte, ne, notExists, or, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addDays, dayDiff, pairTransfers, type IsoDate, type RuleLike } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, investmentTxn, payee, transaction, transferDismissal } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { applyRulesToRow } from "./rules.js";

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

const dismissalKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Pair unpaired transactions across the household's accounts and persist the pairs.
 * Both legs get the same pair id, `is_transfer`, and lose their category unless locked.
 *
 * Audit a5-ingest-transfers-04: two rows the household unpaired ("transfer · undo") never pair
 * with each other again (`transfer_dismissal`), and a row the household categorized by hand
 * (`category_locked`, a split included) is not a candidate unless it is marked as a transfer:
 * automation never overrides a hand categorization (plan, data model).
 */
export async function pairTransfersInDb(tx: DbOrTx, options: PairTransfersInDbOptions = {}): Promise<number> {
  const maxDays = options.maxDays ?? 3;
  const rows = await tx
    .select({ id: transaction.id, accountId: transaction.accountId, date: transaction.date, amountCents: transaction.amountCents })
    .from(transaction)
    .where(
      and(
        isNull(transaction.transferPairId),
        or(eq(transaction.categoryLocked, false), eq(transaction.isTransfer, true)),
        options.since ? gte(transaction.date, addDays(options.since, -maxDays)) : undefined,
        options.until ? lte(transaction.date, addDays(options.until, maxDays)) : undefined,
        notInvestmentIncomeRow(tx),
      ),
    );
  if (rows.length === 0) return 0;
  // The table holds only pairs the household undid: small enough to read whole.
  const dismissed = new Set((await tx.select({ a: transferDismissal.firstId, b: transferDismissal.secondId }).from(transferDismissal)).map((d) => dismissalKey(d.a, d.b)));
  const pairs = pairTransfers(rows, { maxDays, isDismissed: (a, b) => dismissed.has(dismissalKey(a, b)) });
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

/**
 * Undo a pair (user says "this is not a transfer"). Clears both legs, and records that the two
 * are not one transfer so the next pairing pass leaves them apart (audit a5-ingest-transfers-04).
 */
export async function unpairTransfer(tx: DbOrTx, transactionId: string): Promise<void> {
  const [row] = await tx.select({ pairId: transaction.transferPairId }).from(transaction).where(eq(transaction.id, transactionId));
  const pairId = row?.pairId;
  const legs = pairId ? await tx.select({ id: transaction.id }).from(transaction).where(eq(transaction.transferPairId, pairId)) : [];
  await tx
    .update(transaction)
    .set({ transferPairId: null, isTransfer: false, updatedAt: new Date() })
    .where(pairId ? or(eq(transaction.transferPairId, pairId), eq(transaction.id, transactionId)) : eq(transaction.id, transactionId));
  if (legs.length === 2) {
    const [a, b] = [legs[0]!.id, legs[1]!.id].sort();
    await tx.insert(transferDismissal).values({ firstId: a!, secondId: b! }).onConflictDoNothing();
  }
}

/**
 * Release the transfer partners of rows that are about to be removed (a pending leg the feed
 * dropped, a row the household deletes, an undone import): a pair id must always name two rows
 * (audit a5-ingest-transfers-05). The partner loses its pair and `is_transfer`; when `rules`
 * are given they run on it again, so a rule that marks it a transfer or gives it a category
 * still does, and the next pairing pass may pair it with the leg that replaces the removed one.
 * Returns the released rows with their dates (for the pairing pass's window).
 */
export async function releaseTransferPartners(tx: DbOrTx, removedIds: readonly string[], rules?: readonly RuleLike[]): Promise<Array<{ id: string; date: IsoDate }>> {
  if (removedIds.length === 0) return [];
  const removed = new Set(removedIds);
  const pairIds = new Set<string>();
  for (let i = 0; i < removedIds.length; i += 500) {
    const rows = await tx
      .select({ pairId: transaction.transferPairId })
      .from(transaction)
      .where(and(inArray(transaction.id, removedIds.slice(i, i + 500)), sql`${transaction.transferPairId} is not null`));
    for (const r of rows) pairIds.add(r.pairId!);
  }
  if (pairIds.size === 0) return [];
  const partners = (
    await tx
      .select({
        id: transaction.id,
        accountId: transaction.accountId,
        date: transaction.date,
        amountCents: transaction.amountCents,
        rawDescription: transaction.rawDescription,
        payeeName: sql<string>`coalesce(${payee.name}, '')`,
        payeeAliases: sql<string[]>`coalesce(${payee.aliases}, '[]'::jsonb)`,
        payeeId: transaction.payeeId,
        payeeDefaultCategoryId: payee.defaultCategoryId,
        categoryId: transaction.categoryId,
        categoryLocked: transaction.categoryLocked,
        payeeLocked: transaction.payeeLocked,
      })
      .from(transaction)
      .leftJoin(payee, eq(payee.id, transaction.payeeId))
      .where(inArray(transaction.transferPairId, [...pairIds]))
  ).filter((p) => !removed.has(p.id));
  if (partners.length === 0) return [];
  await tx
    .update(transaction)
    .set({ transferPairId: null, isTransfer: false, updatedAt: new Date() })
    .where(inArray(transaction.id, partners.map((p) => p.id)));
  if (rules && rules.length > 0) {
    for (const p of partners) await applyRulesToRow(tx, rules, { ...p, isTransfer: false });
  }
  return partners.map((p) => ({ id: p.id, date: p.date }));
}

export interface TransferCandidateRow {
  id: string;
  accountId: string;
  accountName: string;
  date: IsoDate;
  amountCents: bigint;
  rawDescription: string;
  isTransfer: boolean;
}

/** How far apart two rows the household pairs by hand may be (a payment that took a week to post). */
export const HAND_PAIR_MAX_DAYS = 14;

/**
 * Audit a5-ingest-transfers-12: the rows a transaction could be paired with by hand: equal and
 * opposite, in another account, within `HAND_PAIR_MAX_DAYS`, not paired already; closest date
 * first. Pairs the household undid are offered too: by hand the household decides.
 */
export async function transferCandidates(tx: DbOrTx, transactionId: string, limit = 20): Promise<TransferCandidateRow[]> {
  const [row] = await tx.select().from(transaction).where(eq(transaction.id, transactionId));
  if (!row) throw new PlanError(404, "not_found", "Transaction not found");
  if (row.amountCents === 0n) return [];
  const rows = await tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      accountName: account.name,
      date: transaction.date,
      amountCents: transaction.amountCents,
      rawDescription: transaction.rawDescription,
      isTransfer: transaction.isTransfer,
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .where(
      and(
        eq(transaction.amountCents, -row.amountCents),
        ne(transaction.accountId, row.accountId),
        isNull(transaction.transferPairId),
        gte(transaction.date, addDays(row.date, -HAND_PAIR_MAX_DAYS)),
        lte(transaction.date, addDays(row.date, HAND_PAIR_MAX_DAYS)),
        notInvestmentIncomeRow(tx),
      ),
    )
    .orderBy(asc(transaction.date), asc(transaction.id));
  return rows.sort((a, b) => Math.abs(dayDiff(a.date, row.date)) - Math.abs(dayDiff(b.date, row.date)) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Audit a5-ingest-transfers-12: the household says two rows are one transfer. Both get one pair
 * id and `is_transfer`; a category automation gave them goes (a hand-picked one stays, as with
 * pairing), and a dismissal between the two is removed. Refused when the rows are in one
 * account, are not equal and opposite, or either is paired already (undo that pair first).
 * Returns the pair id.
 */
export async function pairTransactionsByHand(tx: DbOrTx, firstId: string, secondId: string, audit: AuditContext): Promise<string> {
  if (firstId === secondId) throw new PlanError(400, "same_transaction", "Choose two different transactions");
  const rows = await tx.select().from(transaction).where(inArray(transaction.id, [firstId, secondId]));
  const a = rows.find((r) => r.id === firstId);
  const b = rows.find((r) => r.id === secondId);
  if (!a || !b) throw new PlanError(404, "not_found", "Transaction not found");
  if (a.accountId === b.accountId) throw new PlanError(400, "same_account", "A transfer moves money between two accounts");
  if (a.amountCents !== -b.amountCents || a.amountCents === 0n) throw new PlanError(400, "not_opposite", "The two amounts must be equal and opposite");
  if (a.source === "investment" || b.source === "investment") throw new PlanError(400, "investment_row", "Investment income rows are not transfers");
  if (a.transferPairId !== null || b.transferPairId !== null) throw new PlanError(409, "already_paired", "One of the two is paired already; undo that transfer first");
  const pairId = randomUUID();
  const now = new Date();
  await tx.update(transaction).set({ transferPairId: pairId, isTransfer: true, updatedAt: now }).where(inArray(transaction.id, [a.id, b.id]));
  await tx
    .update(transaction)
    .set({ categoryId: null })
    .where(and(inArray(transaction.id, [a.id, b.id]), eq(transaction.categoryLocked, false)));
  const [lo, hi] = [a.id, b.id].sort();
  await tx.delete(transferDismissal).where(and(eq(transferDismissal.firstId, lo!), eq(transferDismissal.secondId, hi!)));
  for (const r of [a, b]) {
    await writeAudit(tx, {
      ...audit,
      entity: "transaction",
      entityId: r.id,
      action: "update",
      before: { isTransfer: r.isTransfer, transferPairId: null },
      after: { isTransfer: true, transferPairId: pairId },
    });
  }
  return pairId;
}
