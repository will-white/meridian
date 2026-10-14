import { and, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import type { IsoDate } from "@meridian/shared";
import type { Db, DbOrTx } from "../index.js";
import { account, category, payee, savingsGoal, transaction } from "../schema/index.js";
import { resolvePayee } from "./payees.js";
import { setTransactionTags, tagsForTransactions } from "./tags.js";
import { unpairTransfer } from "./transfers.js";

export interface ListTransactionsQuery {
  q?: string;
  accountId?: string;
  categoryId?: string;
  uncategorized?: boolean;
  transfers?: "include" | "exclude" | "only";
  from?: IsoDate;
  to?: IsoDate;
  /** Phase 2: a goal's rows (its category's non-transfer rows plus transfer legs in its linked account). */
  goalId?: string;
  /** Phase 2: charges linked to one recurring item. */
  recurringId?: string;
  limit: number;
  cursor?: string;
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
}

function decodeCursor(cursor: string): { date: string; id: string } | undefined {
  try {
    const [date, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!date || !id) return undefined;
    return { date, id };
  } catch {
    return undefined;
  }
}

function encodeCursor(date: string, id: string): string {
  return Buffer.from(`${date}|${id}`, "utf8").toString("base64url");
}

/** Register query: newest first, keyset-paginated on (date, id). */
export async function listTransactions(db: DbOrTx, query: ListTransactionsQuery): Promise<{ items: TransactionListRow[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const q = query.q?.trim();
  const pattern = q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : undefined;

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
        query.categoryId ? eq(transaction.categoryId, query.categoryId) : undefined,
        query.uncategorized ? and(isNull(transaction.categoryId), eq(transaction.isTransfer, false)) : undefined,
        query.transfers === "exclude" ? eq(transaction.isTransfer, false) : undefined,
        query.transfers === "only" ? eq(transaction.isTransfer, true) : undefined,
        query.from ? gte(transaction.date, query.from) : undefined,
        query.to ? lte(transaction.date, query.to) : undefined,
        query.goalId
          ? sql`exists (select 1 from ${savingsGoal} g where g.id = ${query.goalId}::uuid and ((g.category_id = ${transaction.categoryId} and ${transaction.isTransfer} = false) or (g.linked_account_id is not null and g.linked_account_id = ${transaction.accountId} and ${transaction.isTransfer} = true)))`
          : undefined,
        query.recurringId ? eq(transaction.recurringId, query.recurringId) : undefined,
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
  const tags = await tagsForTransactions(db, page.map((r) => r.id));
  const items: TransactionListRow[] = page.map((r) => ({ ...r, tags: tags.get(r.id) ?? [] }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > query.limit && last ? encodeCursor(last.date, last.id) : null;
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
  const tags = await tagsForTransactions(db, rows.map((r) => r.id));
  return { items: rows.map((r) => ({ ...r, tags: tags.get(r.id) ?? [] })) };
}

export interface TransactionPatch {
  categoryId?: string | null;
  payeeName?: string;
  notes?: string | null;
  isTransfer?: boolean;
  tags?: string[];
}

/** Apply a user edit. Hand-picked category and payee are locked against later automation. */
export async function updateTransaction(db: Db, id: string, patch: TransactionPatch): Promise<TransactionListRow | undefined> {
  await db.transaction(async (tx) => {
    const set: Partial<typeof transaction.$inferInsert> = { updatedAt: new Date() };
    if (patch.categoryId !== undefined) {
      set.categoryId = patch.categoryId;
      set.categoryLocked = true;
    }
    if (patch.payeeName !== undefined) {
      const p = await resolvePayee(tx, patch.payeeName);
      set.payeeId = p.id;
      set.payeeLocked = true;
    }
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.isTransfer === true) set.isTransfer = true;
    if (patch.isTransfer === false) await unpairTransfer(tx, id);
    await tx.update(transaction).set(set).where(eq(transaction.id, id));
    if (patch.tags !== undefined) await setTransactionTags(tx, id, patch.tags);
  });
  return getTransaction(db, id);
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

/** Count of transactions that have a category or are flagged (used by the UI summary). */
export async function countUncategorized(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transaction)
    .where(and(isNull(transaction.categoryId), eq(transaction.isTransfer, false)));
  return row?.n ?? 0;
}

