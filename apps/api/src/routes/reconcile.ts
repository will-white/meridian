import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { commitReconciliation, deleteReconciliation, listReconciliations, loadValuationInput, previewReconciliation, type ReconcilePreviewInput, type ReconcileRowInput } from "@meridian/db";
import { dayChange, OkResponse, parseFixed8, ReconcileCommitBody, ReconcileCommitResponse, ReconcilePreviewBody, ReconcilePreviewResponse, ReconciliationListQuery, ReconciliationListResponse, UuidParams, type AccountValuation, type IsoDate } from "@meridian/shared";
import { toAccountValuationView, toReconcileCommitResponse, toReconcilePreviewResponse, toReconciliationView, type AccountValuationExtras } from "../views/valuation.js";
import { auditContext, resolveToday, usePlanErrors } from "./plan.js";
import { priceProviderConfigured } from "./securities.js";

/**
 * Reconciliation to a brokerage statement, the Phase 3 gate (prices design §3.10, §4.1; plan
 * decision 14): the preview is a read with a body (`readOnly`, viewer-callable like the cash-flow
 * projection) that writes nothing; the commit is the owner's, one transaction and one audit
 * batch, recording the attempt and, with `accept`, making the statement the app's truth for the
 * date; history lists the account's records newest first; delete removes a record only.
 */

type PreviewBody = z.infer<typeof ReconcilePreviewBody>;

function toRowInput(row: PreviewBody["rows"][number]): ReconcileRowInput {
  return {
    quantity: parseFixed8(row.quantity),
    isCash: row.isCash,
    ...(row.securityId !== undefined ? { securityId: row.securityId } : {}),
    ...(row.ticker !== undefined ? { ticker: row.ticker } : {}),
    ...(row.price !== undefined ? { price: parseFixed8(row.price) } : {}),
    ...(row.valueCents !== undefined ? { valueCents: BigInt(row.valueCents) } : {}),
  };
}

function toPreviewInput(b: PreviewBody): ReconcilePreviewInput {
  return {
    accountId: b.accountId,
    date: b.date,
    rows: b.rows.map(toRowInput),
    ...(b.statementTotalCents !== undefined ? { statementTotalCents: BigInt(b.statementTotalCents) } : {}),
    ...(b.toleranceCents !== undefined ? { toleranceCents: BigInt(b.toleranceCents) } : {}),
  };
}

export async function reconcileRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  /** The two figures `AccountValuationView` carries beyond the chain's own output: the day change and the latest statement check (read-only). */
  async function valuationExtras(app_: AccountValuation, date: IsoDate): Promise<AccountValuationExtras> {
    const input = await loadValuationInput(app.db, { accountIds: [app_.accountId], from: date, to: date, now: app.now() });
    const day = dayChange(input, [app_.accountId], date).accounts.find((a) => a.accountId === app_.accountId) ?? null;
    return { dayChange: day, lastReconciliation: input.fidelities.get(app_.accountId)?.lastReconciliation ?? null };
  }

  r.post("/reconcile/preview", { config: { readOnly: true }, schema: { body: ReconcilePreviewBody, response: { 200: ReconcilePreviewResponse } } }, async (request, reply) => {
    const today = await resolveToday(app, request.body.today);
    const preview = await previewReconciliation(app.db, toPreviewInput(request.body), { today, now: app.now() });
    const app_ = toAccountValuationView(preview.app, await valuationExtras(preview.app, preview.date));
    reply.header("Cache-Control", "no-store");
    return toReconcilePreviewResponse(preview, app_);
  });

  /** Owner. Always records the attempt; `accept` (default true) writes the statement as a manual snapshot and balance row. */
  r.post("/reconcile/commit", { schema: { body: ReconcileCommitBody, response: { 200: ReconcileCommitResponse } } }, async (request) => {
    const b = request.body;
    const today = await resolveToday(app, b.today);
    const result = await commitReconciliation(
      app.db,
      { ...toPreviewInput(b), accept: b.accept, ...(b.note !== undefined ? { note: b.note } : {}) },
      { ...auditContext(request), today, now: app.now(), queuePriceRefresh: priceProviderConfigured(app) },
    );
    const app_ = toAccountValuationView(result.app, await valuationExtras(result.app, result.preview.date));
    return toReconcileCommitResponse(result, app_);
  });

  r.get("/reconcile/history", { schema: { querystring: ReconciliationListQuery, response: { 200: ReconciliationListResponse } } }, async (request, reply) => {
    const items = await listReconciliations(app.db, { accountId: request.query.accountId, limit: request.query.limit });
    reply.header("Cache-Control", "no-store");
    return { items: items.map(toReconciliationView) };
  });

  /** Owner; the record only (the snapshot it wrote stays); audited as a delete. */
  r.delete("/reconcile/:id", { schema: { params: UuidParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteReconciliation(app.db, request.params.id, auditContext(request));
    return { ok: true as const };
  });
}
