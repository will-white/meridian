import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { goalOwnedMonthRanges, monthStart, type IsoDate } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, category, payee, savingsGoal, split, transaction, transactionAlias } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { resolvePayee } from "./payees.js";
import { onBudgetOrFeedCategory } from "./planScope.js";
import { containsPattern, decodeCursor, encodeCursor } from "./queryText.js";
import { setTransactionTags, tagsForTransactions } from "./tags.js";
import { loadRules } from "./rules.js";
import { pairTransfersInDb, releaseTransferPartners, unpairTransfer } from "./transfers.js";

export interface ListTransactionsQuery {
  q?: string;
  accountId?: string;
  /** Rows that count in this category: categorized to it, or split with a line in it. */
  categoryId?: string;
  /** Non-transfer rows with no category and no split lines. */
  uncategorized?: boolean;
  transfers?: "include" | "exclude" | "only";
  from?: IsoDate;
  to?: IsoDate;
  /**
   * Phase 2: a goal's rows: its category's non-transfer rows plus the transfer legs in its
   * linked account for the months the goal owns that account (`goalOwnedMonthRanges`).
   */
  goalId?: string;
  /** Phase 2: charges linked to one recurring item. */
  recurringId?: string;
  /**
   * Only what the spending plan reads (`onBudgetOrFeedCategory`): the drill-down behind a plan
   * cell sets it so the list adds up to the cell's actual.
   */
  planScope?: boolean;
  limit: number;
  cursor?: string;
}

/** One line of a split transaction. */
export interface TransactionSplitRow {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  amountCents: bigint;
  memo: string | null;
}

export interface TransactionListRow {
  id: string;
  accountId: string;
  accountName: string;
  date: IsoDate;
  amountCents: bigint;
  payeeId: string | null;
  payeeName: string | null;
  rawDescription: string;
  memo: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryLocked: boolean;
  pending: boolean;
  isTransfer: boolean;
  transferPairId: string | null;
  notes: string | null;
  source: (typeof transaction.$inferSelect)["source"];
  recurringId: string | null;
  tags: string[];
  /** The split lines that replace this row in the plan (empty when the row is not split). */
  splits: TransactionSplitRow[];
}

/** The (date, id) a page ended on; a cursor this server did not issue is a 400, never a query. */
function transactionCursor(cursor: string): { date: string; id: string } {
  const fields = decodeCursor(cursor, ["date", "uuid"]);
  if (!fields) throw new PlanError(400, "invalid_cursor", "That page marker is not valid; reload the list");
  return { date: fields[0]!, id: fields[1]! };
}

/** The split lines of the given transactions, in a stable order (amount, then id). */
async function splitsForTransactions(db: DbOrTx, ids: readonly string[]): Promise<Map<string, TransactionSplitRow[]>> {
  const out = new Map<string, TransactionSplitRow[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: split.id, transactionId: split.transactionId, categoryId: split.categoryId, categoryName: category.name, amountCents: split.amountCents, memo: split.memo })
    .from(split)
    .leftJoin(category, eq(category.id, split.categoryId))
    .where(inArray(split.transactionId, [...ids]))
    .orderBy(asc(split.transactionId), asc(split.amountCents), asc(split.id));
  for (const { transactionId, ...line } of rows) {
    const list = out.get(transactionId) ?? [];
    list.push(line);
    out.set(transactionId, list);
  }
  return out;
}

const hasSplits = sql`exists (select 1 from ${split} where ${split.transactionId} = ${transaction.id})`;

/** The row counts in the category: categorized to it and not split, or split with a line in it. */
function inCategory(categoryId: string): SQL {
  return sql`((${transaction.categoryId} = ${categoryId} and not ${hasSplits}) or exists (select 1 from ${split} where ${split.transactionId} = ${transaction.id} and ${split.categoryId} = ${categoryId}))`;
}

/** The plan-scope rule for a whole row: on budget, or (via the row or any of its split lines) in the feed category. */
function inPlanScope(): SQL {
  return sql`(${onBudgetOrFeedCategory(sql`${transaction.categoryId}`)} or exists (select 1 from ${split} where ${split.transactionId} = ${transaction.id} and ${onBudgetOrFeedCategory(sql`${split.categoryId}`)}))`;
}

/** A goal's rows; `false` when the goal does not exist. */
async function goalRowsFilter(db: DbOrTx, goalId: string): Promise<SQL> {
  const goals = await db
    .select({ id: savingsGoal.id, categoryId: savingsGoal.categoryId, linkedAccountId: savingsGoal.linkedAccountId, startMonth: savingsGoal.startMonth, status: savingsGoal.status })
    .from(savingsGoal)
    .orderBy(asc(savingsGoal.createdAt), asc(savingsGoal.id));
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return sql`false`;
  const categorized = sql`(${transaction.isTransfer} = false and ${inCategory(goal.categoryId)})`;
  const ranges = goal.linkedAccountId === null ? [] : goalOwnedMonthRanges(goals, goalId);
  if (goal.linkedAccountId === null || ranges.length === 0) return categorized;
  const owned = ranges.map((r) => {
    // [from, to) in months → dates; an open end has no bound.
    const lower = r.from === null ? sql`true` : gte(transaction.date, monthStart(r.from));
    const upper = r.to === null ? sql`true` : lt(transaction.date, monthStart(r.to));
    return sql`(${lower} and ${upper})`;
  });
  const transfers = sql`(${transaction.isTransfer} = true and ${transaction.accountId} = ${goal.linkedAccountId} and (${sql.join(owned, sql` or `)}))`;
  return sql`(${categorized} or ${transfers})`;
}

/** Register query: newest first, keyset-paginated on (date, id). */
export async function listTransactions(db: DbOrTx, query: ListTransactionsQuery): Promise<{ items: TransactionListRow[]; nextCursor: string | null }> {
  const cursor = query.cursor !== undefined ? transactionCursor(query.cursor) : undefined;
  const q = query.q?.trim();
  const pattern = q ? containsPattern(q) : undefined;
  const goalFilter = query.goalId ? await goalRowsFilter(db, query.goalId) : undefined;

  const rows = await db
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      accountName: account.name,
      date: transaction.date,
      amountCents: transaction.amountCents,
      payeeId: transaction.payeeId,
      payeeName: payee.name,
      rawDescription: transaction.rawDescription,
      memo: transaction.memo,
      categoryId: transaction.categoryId,
      categoryName: category.name,
      categoryLocked: transaction.categoryLocked,
      pending: transaction.pending,
      isTransfer: transaction.isTransfer,
      transferPairId: transaction.transferPairId,
      notes: transaction.notes,
      source: transaction.source,
      recurringId: transaction.recurringId,
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .leftJoin(category, eq(category.id, transaction.categoryId))
    .where(
      and(
        query.accountId ? eq(transaction.accountId, query.accountId) : undefined,
        query.categoryId ? inCategory(query.categoryId) : undefined,
        query.uncategorized ? and(isNull(transaction.categoryId), eq(transaction.isTransfer, false), sql`not ${hasSplits}`) : undefined,
        query.transfers === "exclude" ? eq(transaction.isTransfer, false) : undefined,
        query.transfers === "only" ? eq(transaction.isTransfer, true) : undefined,
        query.from ? gte(transaction.date, query.from) : undefined,
        query.to ? lte(transaction.date, query.to) : undefined,
        goalFilter,
        query.recurringId ? eq(transaction.recurringId, query.recurringId) : undefined,
        query.planScope ? inPlanScope() : undefined,
        pattern
          ? or(
              ilike(transaction.rawDescription, pattern),
              ilike(payee.name, pattern),
              ilike(transaction.notes, pattern),
              ilike(transaction.memo, pattern),
              ilike(category.name, pattern),
            )
          : undefined,
        cursor ? or(sql`${transaction.date} < ${cursor.date}`, and(eq(transaction.date, cursor.date), sql`${transaction.id} < ${cursor.id}`)) : undefined,
      ),
    )
    .orderBy(desc(transaction.date), desc(transaction.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const ids = page.map((r) => r.id);
  const tags = await tagsForTransactions(db, ids);
  const splits = await splitsForTransactions(db, ids);
  const items: TransactionListRow[] = page.map((r) => ({ ...r, tags: tags.get(r.id) ?? [], splits: splits.get(r.id) ?? [] }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > query.limit && last ? encodeCursor([last.date, last.id]) : null;
  return { items, nextCursor };
}

export async function getTransaction(db: DbOrTx, id: string): Promise<TransactionListRow | undefined> {
  const { items } = await listTransactionsById(db, id);
  return items[0];
}

async function listTransactionsById(db: DbOrTx, id: string) {
  const rows = await db
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      accountName: account.name,
      date: transaction.date,
      amountCents: transaction.amountCents,
      payeeId: transaction.payeeId,
      payeeName: payee.name,
      rawDescription: transaction.rawDescription,
      memo: transaction.memo,
      categoryId: transaction.categoryId,
      categoryName: category.name,
      categoryLocked: transaction.categoryLocked,
      pending: transaction.pending,
      isTransfer: transaction.isTransfer,
      transferPairId: transaction.transferPairId,
      notes: transaction.notes,
      source: transaction.source,
      recurringId: transaction.recurringId,
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .leftJoin(category, eq(category.id, transaction.categoryId))
    .where(eq(transaction.id, id));
  const ids = rows.map((r) => r.id);
  const tags = await tagsForTransactions(db, ids);
  const splits = await splitsForTransactions(db, ids);
  return { items: rows.map((r) => ({ ...r, tags: tags.get(r.id) ?? [], splits: splits.get(r.id) ?? [] })) };
}

export interface TransactionPatch {
  categoryId?: string | null;
  payeeName?: string;
  notes?: string | null;
  isTransfer?: boolean;
  tags?: string[];
}

/** Apply a user edit. Hand-picked category and payee are locked against later automation; picking a category removes a split. */
export async function updateTransaction(db: Db, id: string, patch: TransactionPatch): Promise<TransactionListRow | undefined> {
  await db.transaction(async (tx) => {
    const set: Partial<typeof transaction.$inferInsert> = { updatedAt: new Date() };
    if (patch.categoryId !== undefined) {
      set.categoryId = patch.categoryId;
      set.categoryLocked = true;
      // One category for the whole row replaces a split (the lines would otherwise still win in the plan).
      await tx.delete(split).where(eq(split.transactionId, id));
    }
    if (patch.payeeName !== undefined) {
      const p = await resolvePayee(tx, patch.payeeName);
      set.payeeId = p.id;
      set.payeeLocked = true;
    }
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.isTransfer === true) {
      set.isTransfer = true;
      // A transfer leaves the plan, so a category automation gave it goes, as pairing clears it (audit a5-ingest-transfers-12).
      const [row] = await tx.select({ categoryLocked: transaction.categoryLocked }).from(transaction).where(eq(transaction.id, id));
      if (row && !row.categoryLocked && patch.categoryId === undefined) set.categoryId = null;
    }
    if (patch.isTransfer === false) await unpairTransfer(tx, id);
    await tx.update(transaction).set(set).where(eq(transaction.id, id));
    if (patch.tags !== undefined) await setTransactionTags(tx, id, patch.tags);
  });
  return getTransaction(db, id);
}

/**
 * Audit a5-ingest-transfers-09: the household deletes a row (a duplicate, a manual entry with a
 * typo, a row imported by mistake). A transfer partner is released and may pair again; a row
 * from the feed or a file leaves its ids behind as removed (`transaction_alias` with no row), so
 * the next sync or a re-import does not bring it back. Investment rows belong to the
 * investment flows (400 `investment_row`). Returns false when the row does not exist. Audited
 * as `transaction`.
 */
export async function deleteTransaction(db: Db, id: string, audit: AuditContext): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(transaction).where(eq(transaction.id, id));
    if (!row) return false;
    if (row.source === "investment") throw new PlanError(400, "investment_row", "This row comes from an investment transaction; remove that one instead");
    const released = await releaseTransferPartners(tx, [id], await loadRules(tx));
    // Its own ids and the ids that pointed at it are remembered as removed.
    await tx.update(transactionAlias).set({ transactionId: null }).where(eq(transactionAlias.transactionId, id));
    await tx.delete(transaction).where(eq(transaction.id, id));
    if (row.externalId !== null && (row.source === "simplefin" || row.source === "csv")) {
      await tx
        .insert(transactionAlias)
        .values({ accountId: row.accountId, externalId: row.externalId, transactionId: null, source: row.source })
        .onConflictDoUpdate({ target: [transactionAlias.accountId, transactionAlias.externalId], set: { transactionId: null } });
    }
    await writeAudit(tx, {
      ...audit,
      entity: "transaction",
      entityId: id,
      action: "delete",
      before: { accountId: row.accountId, date: row.date, amountCents: row.amountCents, rawDescription: row.rawDescription, source: row.source, externalId: row.externalId, categoryId: row.categoryId, notes: row.notes },
      after: null,
    });
    if (released.length > 0) {
      const dates = released.map((r) => r.date).sort();
      await pairTransfersInDb(tx, { since: dates[0]!, until: dates[dates.length - 1]! });
    }
    return true;
  });
}

export async function createManualTransaction(
  db: Db,
  input: { accountId: string; date: IsoDate; amountCents: bigint; payeeName: string; categoryId?: string | null; notes?: string },
): Promise<TransactionListRow> {
  const id = await db.transaction(async (tx) => {
    const p = await resolvePayee(tx, input.payeeName);
    const [row] = await tx
      .insert(transaction)
      .values({
        accountId: input.accountId,
        source: "manual",
        date: input.date,
        amountCents: input.amountCents,
        payeeId: p.id,
        payeeLocked: true,
        rawDescription: input.payeeName,
        categoryId: input.categoryId ?? p.defaultCategoryId ?? null,
        categoryLocked: input.categoryId !== undefined,
        notes: input.notes ?? null,
      })
      .returning({ id: transaction.id });
    return row!.id;
  });
  return (await getTransaction(db, id))!;
}

/**
 * Count of uncategorized, non-transfer rows (the dashboard's review count): the same rows the
 * plan's uncategorized badge counts. A split transaction is categorized through its lines,
 * so it never asks to be categorized. Phase 3 (plan decision 15): rows of off-budget accounts
 * count only in the household's investment income category, so a brokerage's buys never ask
 * to be categorized.
 */
export async function countUncategorized(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .where(and(isNull(transaction.categoryId), eq(transaction.isTransfer, false), sql`not ${hasSplits}`, onBudgetOrFeedCategory(sql`${transaction.categoryId}`)));
  return row?.n ?? 0;
}

// ---- Splits ----

export const MAX_SPLIT_LINES = 20;

/**
 * Drop a transaction's split lines because its amount changed underneath them (the bank
 * added a tip to a charge it had already sent). Lines that no longer add up to the row would
 * put a wrong number in the plan, so the row goes back to uncategorized and shows up for
 * review. Returns whether there was a split.
 */
export async function dropSplitsAfterAmountChange(tx: DbOrTx, transactionId: string): Promise<boolean> {
  const removed = await tx.delete(split).where(eq(split.transactionId, transactionId)).returning({ id: split.id });
  return removed.length > 0;
}

export interface SplitLineInput {
  categoryId: string;
  /** Signed like the transaction (negative = outflow); never zero. */
  amountCents: bigint;
  memo?: string | null;
}

/**
 * Replace a transaction's split lines. Two or more lines split the row across categories:
 * the lines must add up to the transaction's amount exactly, each needs an existing category
 * and a non-zero amount, and the row's own category is cleared and locked (its lines carry
 * the categories from then on, and rules leave it alone). An empty list removes the split and
 * leaves the row uncategorized. Transfers cannot be split. Returns undefined when the
 * transaction does not exist; rule violations raise PlanError 400 `validation`.
 */
export async function setTransactionSplits(db: Db, id: string, lines: readonly SplitLineInput[]): Promise<TransactionListRow | undefined> {
  if (lines.length === 1) throw new PlanError(400, "validation", "A split needs at least two lines; set the category instead");
  if (lines.length > MAX_SPLIT_LINES) throw new PlanError(400, "validation", `At most ${MAX_SPLIT_LINES} split lines`);
  const found = await db.transaction(async (tx) => {
    const [row] = await tx.select({ id: transaction.id, amountCents: transaction.amountCents, isTransfer: transaction.isTransfer }).from(transaction).where(eq(transaction.id, id));
    if (!row) return false;
    if (lines.length > 0) {
      if (row.isTransfer) throw new PlanError(400, "validation", "A transfer cannot be split");
      let sum = 0n;
      for (const line of lines) {
        if (line.amountCents === 0n) throw new PlanError(400, "validation", "A split line cannot be zero");
        sum += line.amountCents;
      }
      if (sum !== row.amountCents) throw new PlanError(400, "validation", "The split lines must add up to the transaction amount");
      const categoryIds = [...new Set(lines.map((l) => l.categoryId))];
      const known = await tx.select({ id: category.id }).from(category).where(inArray(category.id, categoryIds));
      if (known.length !== categoryIds.length) throw new PlanError(400, "validation", "Category not found");
    }
    await tx.delete(split).where(eq(split.transactionId, id));
    if (lines.length > 0) {
      await tx.insert(split).values(lines.map((l) => ({ transactionId: id, categoryId: l.categoryId, amountCents: l.amountCents, memo: l.memo?.trim() || null })));
      await tx.update(transaction).set({ categoryId: null, categoryLocked: true, updatedAt: new Date() }).where(eq(transaction.id, id));
    } else {
      await tx.update(transaction).set({ updatedAt: new Date() }).where(eq(transaction.id, id));
    }
    return true;
  });
  return found ? getTransaction(db, id) : undefined;
}
