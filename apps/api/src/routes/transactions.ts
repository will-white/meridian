import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createManualTransaction, getTransaction, listTransactions, updateTransaction } from "@meridian/db";
import { CreateManualTransactionBody, TransactionList, TransactionQuery, TransactionView, UpdateTransactionBody, UuidParams } from "@meridian/shared";
import { notFound } from "../lib/errors.js";
import { toTransactionView } from "../views.js";

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
    const row = await updateTransaction(app.db, request.params.id, {
      ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
      ...(b.payeeName !== undefined ? { payeeName: b.payeeName } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.isTransfer !== undefined ? { isTransfer: b.isTransfer } : {}),
      ...(b.tags !== undefined ? { tags: b.tags } : {}),
    });
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
    return toTransactionView(row);
  });
}
