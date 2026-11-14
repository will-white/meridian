import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createManualTransaction,
  deleteTransaction,
  enqueueJob,
  getTransaction,
  listTransactions,
  pairTransactionsByHand,
  setTransactionSplits,
  transferCandidates,
  unlinkTransactionFromRecurring,
  updateTransaction,
} from "@meridian/db";
import {
  CreateManualTransactionBody,
  OkResponse,
  PairTransactionBody,
  SetTransactionSplitsBody,
  TransactionList,
  TransactionQuery,
  TransactionView,
  TransferCandidateView,
  UpdateTransactionBody,
  UuidParams,
} from "@meridian/shared";
import { notFound } from "../lib/errors.js";
import { toTransactionView } from "../views.js";
import { auditContext, serverToday, usePlanErrors } from "./plan.js";

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

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
      ...(q.planScope !== undefined ? { planScope: q.planScope } : {}),
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

  /**
   * Split a transaction across categories (two or more lines that add up to its amount), or
   * remove the split with an empty list. The lines replace the row in the plan. 400
   * `validation` when the lines do not add up, a line is zero, a category is unknown or the
   * row is a transfer.
   */
  r.put("/transactions/:id/splits", { schema: { params: UuidParams, body: SetTransactionSplitsBody, response: { 200: TransactionView } } }, async (request) => {
    const row = await setTransactionSplits(
      app.db,
      request.params.id,
      request.body.splits.map((s) => ({ categoryId: s.categoryId, amountCents: BigInt(s.amountCents), ...(s.memo !== undefined ? { memo: s.memo } : {}) })),
    );
    if (!row) throw notFound("Transaction not found");
    return toTransactionView(row);
  });

  /**
   * Audit a5-ingest-transfers-09: delete a row (a duplicate, a typo, a row imported by mistake).
   * Its transfer partner is released; a feed or CSV row's ids are remembered as removed so the
   * next sync or a re-import does not bring it back. 400 `investment_row` for an investment row.
   */
  r.delete("/transactions/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    const existing = await getTransaction(app.db, request.params.id);
    if (!existing) throw notFound("Transaction not found");
    if (existing.recurringId !== null) {
      const today = await serverToday(app);
      await app.db.transaction((tx) => unlinkTransactionFromRecurring(tx, existing.id, { today, now: app.now() }));
    }
    if (!(await deleteTransaction(app.db, request.params.id, auditContext(request)))) throw notFound("Transaction not found");
    await enqueueJob(app.db, "recurring.detect", { reason: "ledger" }, { dedupe: true });
    return { ok: true as const };
  });

  /** Audit a5-ingest-transfers-12: the rows this one could be paired with by hand, closest date first. */
  r.get("/transactions/:id/transfer-candidates", { schema: { params: UuidParams, response: { 200: z.array(TransferCandidateView) } } }, async (request) => {
    const rows = await transferCandidates(app.db, request.params.id);
    return rows.map((c) => ({ ...c, amountCents: c.amountCents.toString() }));
  });

  /**
   * Audit a5-ingest-transfers-12: the household says this row and `otherId` are one transfer.
   * 400 when they are in one account or not equal and opposite, 409 `already_paired`.
   */
  r.post("/transactions/:id/pair", { schema: { params: UuidParams, body: PairTransactionBody, response: { 200: TransactionView } } }, async (request) => {
    const ctx = auditContext(request);
    const before = await Promise.all([getTransaction(app.db, request.params.id), getTransaction(app.db, request.body.otherId)]);
    if (!before[0] || !before[1]) throw notFound("Transaction not found");
    await app.db.transaction((tx) => pairTransactionsByHand(tx, request.params.id, request.body.otherId, ctx));
    // Recurring hook (design C5): a charge that became a transfer no longer belongs to its item.
    for (const row of before) {
      if (row!.recurringId !== null) {
        const today = await serverToday(app);
        await app.db.transaction((tx) => unlinkTransactionFromRecurring(tx, row!.id, { today, now: app.now() }));
      }
    }
    return toTransactionView((await getTransaction(app.db, request.params.id))!);
  });

  r.post("/transactions", { schema: { body: CreateManualTransactionBody, response: { 200: TransactionView } } }, async (request) => {
    const b = request.body;
    const row = await createManualTransaction(app.db, {
      accountId: b.accountId,
      date: b.date,
      amountCents: BigInt(b.amountCents),
      today: await serverToday(app),
      payeeName: b.payeeName,
      ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
    });
    // The "match recurring" pipeline step runs for every ingest path; one queued job covers any number of edits.
    await enqueueJob(app.db, "recurring.detect", { reason: "ledger" }, { dedupe: true });
    return toTransactionView(row);
  });
}
