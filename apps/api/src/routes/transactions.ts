import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createManualTransaction, enqueueJob, getTransaction, listTransactions, unlinkTransactionFromRecurring, updateTransaction } from "@meridian/db";
import { CreateManualTransactionBody, TransactionList, TransactionQuery, TransactionView, UpdateTransactionBody, UuidParams } from "@meridian/shared";
import { notFound } from "../lib/errors.js";
import { toTransactionView } from "../views.js";
import { serverToday } from "./plan.js";

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/transactions", { schema: { querystring: TransactionQuery, response: { 200: TransactionList } } }, async (request) => {
    const q = request.query;
    const result = await listTransactions(app.db, {
      limit: q.limit,
      transfers: q.transfers,
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.accountId !== undefined ? { accountId: q.accountId } : {}),
      ...(q.categoryId !== undefined ? { categoryId: q.categoryId } : {}),
      ...(q.uncategorized !== undefined ? { uncategorized: q.uncategorized } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.goalId !== undefined ? { goalId: q.goalId } : {}),
      ...(q.recurringId !== undefined ? { recurringId: q.recurringId } : {}),
    });
    return { items: result.items.map(toTransactionView), nextCursor: result.nextCursor };
  });

  r.get("/transactions/:id", { schema: { params: UuidParams, response: { 200: TransactionView } } }, async (request) => {
    const row = await getTransaction(app.db, request.params.id);
    if (!row) throw notFound("Transaction not found");
    return toTransactionView(row);
  });

  r.patch("/transactions/:id", { schema: { params: UuidParams, body: UpdateTransactionBody, response: { 200: TransactionView } } }, async (request) => {
    const existing = await getTransaction(app.db, request.params.id);
    if (!existing) throw notFound("Transaction not found");
    const b = request.body;
    let row = await updateTransaction(app.db, request.params.id, {
      ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
      ...(b.payeeName !== undefined ? { payeeName: b.payeeName } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.isTransfer !== undefined ? { isTransfer: b.isTransfer } : {}),
      ...(b.tags !== undefined ? { tags: b.tags } : {}),
    });
    // Recurring hook (design C5): a charge that changed payee or became a transfer no longer belongs to its item.
    if (existing.recurringId !== null && row && (row.payeeId !== existing.payeeId || (row.isTransfer && !existing.isTransfer))) {
      const today = await serverToday(app);
      await app.db.transaction((tx) => unlinkTransactionFromRecurring(tx, existing.id, { today, now: app.now() }));
      row = await getTransaction(app.db, existing.id);
    }
    return toTransactionView(row!);
  });

  r.post("/transactions", { schema: { body: CreateManualTransactionBody, response: { 200: TransactionView } } }, async (request) => {
    const b = request.body;
    const row = await createManualTransaction(app.db, {
      accountId: b.accountId,
      date: b.date,
      amountCents: BigInt(b.amountCents),
      payeeName: b.payeeName,
      ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
    });
    // The "match recurring" pipeline step runs for every ingest path; one queued job covers any number of edits.
    await enqueueJob(app.db, "recurring.detect", { reason: "ledger" }, { dedupe: true });
    return toTransactionView(row);
  });
}
