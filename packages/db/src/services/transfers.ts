import { and, asc, gte, inArray, isNull, lte, ne, notExists, or, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { addDays, dayDiff, pairTransfers, type IsoDate, type RuleLike } from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { account, investmentTxn, payee, transaction, transferDismissal } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { lockLedger } from "./ledgerLock.js";
import { applyRulesToRow } from "./rules.js";
import { dropTransferSplits } from "./transferSplits.js";

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
 * automation never overrides a hand categorization (plan, data model). Neither is a row a rule
 * said is not a transfer (`not_transfer`, audit a10-conformance-ledger-03).
 */
export async function pairTransfersInDb(tx: DbOrTx, options: PairTransfersInDbOptions = {}): Promise<number> {
  const maxDays = options.maxDays ?? 3;
  // One pass at a time (a10-conformance-ledger-01): two passes that read the same free legs would pair one leg twice.
  await lockLedger(tx);
  const rows = await tx
    .select({ id: transaction.id, accountId: transaction.accountId, date: transaction.date, amountCents: transaction.amountCents })
    .from(transaction)
    .where(
      and(
        isNull(transaction.transferPairId),
        or(eq(transaction.categoryLocked, false), eq(transaction.isTransfer, true)),
        // A rule said the row is not a transfer (a10-conformance-ledger-03): the rule's choice holds, as a hand categorization does.
        eq(transaction.notTransfer, false),
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
    await dropTransferSplits(tx, [pair.outflowId, pair.inflowId]);
  }
  return pairs.length;
}

export interface MarkAsTransfersOptions {
  /**
   * The household linked the row by hand (`PATCH /api/investments/transactions/:id` with
   * `ledgerTransactionId`): its word, as a hand mark or a hand pairing is, wins over a rule's
   * "not a transfer" (`not_transfer` is cleared) and over a hand categorization (the category
   * stays on the row). Default false: the mark is automation's.
   */
  byHand?: boolean;
}

/**
 * Mark ledger rows as transfers the way pairing marks its legs, without a pair: `is_transfer`,
 * and the category goes unless the owner locked it. Used when an investment cash transfer is
 * linked to the bank's row of the same money (docs/phase-3-plan.md, audit decision A5): a
 * deposit or a withdrawal the trade history names is a transfer whatever the bank's description
 * says. Rows that are transfers already are left alone. An automatic mark (the linker, an
 * import) takes only the rows automatic pairing may take (audit b3-investment-flows, second
 * round): never a row a rule said is not a transfer (`not_transfer`, Phase 1 decision 106) or
 * one the household categorized by hand (`category_locked`, decision 48), so a later rules run
 * finds nothing to reverse; the investment row is then the flow (A5(2)). A mark `byHand` takes
 * those too. Returns how many rows changed.
 */
export async function markAsTransfers(tx: DbOrTx, transactionIds: readonly string[], options: MarkAsTransfersOptions = {}): Promise<number> {
  const ids = [...new Set(transactionIds)];
  const markable = options.byHand
    ? or(eq(transaction.isTransfer, false), eq(transaction.notTransfer, true))
    : and(eq(transaction.isTransfer, false), eq(transaction.notTransfer, false), eq(transaction.categoryLocked, false));
  let changed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await tx
      .update(transaction)
      .set({ isTransfer: true, notTransfer: false, updatedAt: new Date() })
      .where(and(inArray(transaction.id, ids.slice(i, i + 500)), markable))
      .returning({ id: transaction.id });
    if (rows.length === 0) continue;
    changed += rows.length;
    await tx
      .update(transaction)
      .set({ categoryId: null })
      .where(and(inArray(transaction.id, rows.map((r) => r.id)), eq(transaction.categoryLocked, false)));
    await dropTransferSplits(
      tx,
      rows.map((r) => r.id),
    );
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
  return releasePairs(tx, removedIds, rules, false);
}

/**
 * Release whole pairs: every leg of the pairs the given rows belong to, the rows themselves
 * included, loses its pair id and `is_transfer`, and the rules run on it again (when given).
 * For a row that stays but is no longer one leg of an equal and opposite pair: a feed row whose
 * amount changed under the same id (audit a10-conformance-ledger-06), or one a rule says is not
 * a transfer (a10-conformance-ledger-03). Returns every released leg with its date.
 */
export async function releaseTransferPairs(tx: DbOrTx, rowIds: readonly string[], rules?: readonly RuleLike[]): Promise<Array<{ id: string; date: IsoDate }>> {
  return releasePairs(tx, rowIds, rules, true);
}

async function releasePairs(tx: DbOrTx, ids: readonly string[], rules: readonly RuleLike[] | undefined, withSelf: boolean): Promise<Array<{ id: string; date: IsoDate }>> {
  if (ids.length === 0) return [];
  const given = new Set(ids);
  const pairIds = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await tx
      .select({ pairId: transaction.transferPairId })
      .from(transaction)
      .where(and(inArray(transaction.id, ids.slice(i, i + 500)), sql`${transaction.transferPairId} is not null`));
    for (const r of rows) pairIds.add(r.pairId!);
  }
  if (pairIds.size === 0) return [];
  const legs = (
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
        notTransfer: transaction.notTransfer,
      })
      .from(transaction)
      .leftJoin(payee, eq(payee.id, transaction.payeeId))
      .where(inArray(transaction.transferPairId, [...pairIds]))
  ).filter((p) => withSelf || !given.has(p.id));
  if (legs.length === 0) return [];
  await tx
    .update(transaction)
    .set({ transferPairId: null, isTransfer: false, updatedAt: new Date() })
    .where(inArray(transaction.id, legs.map((p) => p.id)));
  if (rules && rules.length > 0) {
    for (const p of legs) await applyRulesToRow(tx, rules, { ...p, isTransfer: false, transferPairId: null });
  }
  return legs.map((p) => ({ id: p.id, date: p.date }));
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
 * pairing), split lines go (a transfer has no split, audit a8-ledger-ui-10), and a dismissal
 * between the two is removed. Refused when the rows are in one
 * account, are not equal and opposite, or either is paired already (undo that pair first).
 * Returns the pair id.
 */
export async function pairTransactionsByHand(tx: DbOrTx, firstId: string, secondId: string, audit: AuditContext): Promise<string> {
  if (firstId === secondId) throw new PlanError(400, "same_transaction", "Choose two different transactions");
  await lockLedger(tx);
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
  // The household's pairing wins over a rule's "not a transfer" (a10-conformance-ledger-03).
  await tx.update(transaction).set({ transferPairId: pairId, isTransfer: true, notTransfer: false, updatedAt: now }).where(inArray(transaction.id, [a.id, b.id]));
  await tx
    .update(transaction)
    .set({ categoryId: null })
    .where(and(inArray(transaction.id, [a.id, b.id]), eq(transaction.categoryLocked, false)));
  // A transfer has no split (audit a8-ledger-ui-10): a split row paired by hand loses its lines.
  await dropTransferSplits(tx, [a.id, b.id]);
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
