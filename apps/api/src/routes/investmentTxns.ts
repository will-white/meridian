import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createInvestmentTxn,
  deleteInvestmentTxn,
  deleteSnapshot,
  getInvestmentTxn,
  getSnapshot,
  latestSnapshot,
  listInvestmentTxns,
  listSnapshots,
  loadInvestmentAccount,
  requestValuation,
  setManualPositions,
  updateInvestmentTxn,
  type CreateInvestmentTxnInput,
  type ListInvestmentTxnsQuery,
  type ManualPositionInputRecord,
  type UpdateInvestmentTxnInput,
} from "@meridian/db";
import {
  CreateInvestmentTxnBody,
  CreateInvestmentTxnResponse,
  DeleteInvestmentTxnQuery,
  HoldingSnapshotView,
  InvestmentTxnList,
  InvestmentTxnQuery,
  InvestmentTxnView,
  ManualPositionsBody,
  OkResponse,
  parseFixed8,
  PositionsQuery,
  SnapshotDateParams,
  SnapshotSummaryView,
  UpdateInvestmentTxnBody,
  UuidParams,
} from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toHoldingSnapshotView, toInvestmentTxnView, toSnapshotSummaryView } from "../views/investments.js";
import { auditContext, resolveToday, usePlanErrors } from "./plan.js";

/**
 * Investment transactions (imports design §3.10, §4; plan decision 17) and the holding
 * snapshots of an account: list/get/create/update/delete of `investment_txn` rows (a ledger
 * link is set or cleared through `ledgerTransactionId` on PATCH; lot picks live at
 * `PUT /api/investments/txns/:id/lot-picks` in routes/performance.ts), the snapshot reads,
 * the manual positions editor (`PUT …/positions`, source `manual`, optional
 * `statementTotalCents`) and the snapshot delete. Mutations rebuild lots and are audited by
 * the services; the viewer role may only read. A manual transaction changes the lots (and so
 * the chain's value of a lots-basis account), so its create, update and delete request the
 * `investments.valuation` job for every account it touched (plan decision 9), deduped per
 * account like the positions and reconcile commits; the snapshot routes' services do that
 * themselves.
 */

type CreateBody = z.infer<typeof CreateInvestmentTxnBody>;
type UpdateBody = z.infer<typeof UpdateInvestmentTxnBody>;
type ManualBody = z.infer<typeof ManualPositionsBody>;

const picks = (list: ReadonlyArray<{ lotId: string; quantity: string }>) => list.map((p) => ({ lotId: p.lotId, quantity: parseFixed8(p.quantity) }));

function toCreateInput(b: CreateBody): CreateInvestmentTxnInput {
  const base: CreateInvestmentTxnInput = { accountId: b.accountId, date: b.date, type: b.type, ...(b.memo !== undefined ? { memo: b.memo } : {}) };
  switch (b.type) {
    case "buy":
    case "reinvest":
      return {
        ...base,
        securityId: b.securityId,
        quantity: parseFixed8(b.quantity),
        price: parseFixed8(b.price),
        ...(b.amountCents !== undefined ? { amountCents: BigInt(b.amountCents) } : {}),
        ...(b.feeCents !== undefined ? { feeCents: BigInt(b.feeCents) } : {}),
      };
    case "sell":
      return {
        ...base,
        securityId: b.securityId,
        quantity: parseFixed8(b.quantity),
        price: parseFixed8(b.price),
        ...(b.amountCents !== undefined ? { amountCents: BigInt(b.amountCents) } : {}),
        ...(b.feeCents !== undefined ? { feeCents: BigInt(b.feeCents) } : {}),
        ...(b.lotPicks !== undefined ? { lotPicks: picks(b.lotPicks) } : {}),
      };
    case "dividend":
    case "interest":
    case "fee":
      return { ...base, ...(b.securityId !== undefined ? { securityId: b.securityId } : {}), amountCents: BigInt(b.amountCents) };
    case "split":
      return { ...base, securityId: b.securityId, splitNum: b.splitNum, splitDen: b.splitDen, ...(b.quantity !== undefined ? { quantity: parseFixed8(b.quantity) } : {}) };
    case "transfer":
      return {
        ...base,
        direction: b.direction,
        ...(b.securityId !== undefined ? { securityId: b.securityId } : {}),
        ...(b.quantity !== undefined ? { quantity: parseFixed8(b.quantity) } : {}),
        ...(b.amountCents !== undefined ? { amountCents: BigInt(b.amountCents) } : {}),
        ...(b.counterpartyAccountId !== undefined ? { counterpartyAccountId: b.counterpartyAccountId } : {}),
        ...(b.costBasisCents !== undefined ? { costBasisCents: b.costBasisCents === null ? null : BigInt(b.costBasisCents) } : {}),
        ...(b.acquiredDate !== undefined ? { acquiredDate: b.acquiredDate } : {}),
        ...(b.lotPicks !== undefined ? { lotPicks: picks(b.lotPicks) } : {}),
      };
  }
}

function toUpdateInput(b: UpdateBody): UpdateInvestmentTxnInput {
  return {
    ...(b.type !== undefined ? { type: b.type } : {}),
    ...(b.transferDirection !== undefined ? { transferDirection: b.transferDirection } : {}),
    ...(b.date !== undefined ? { date: b.date } : {}),
    ...(b.securityId !== undefined ? { securityId: b.securityId } : {}),
    ...(b.quantity !== undefined ? { quantity: b.quantity === null ? null : parseFixed8(b.quantity) } : {}),
    ...(b.price !== undefined ? { price: b.price === null ? null : parseFixed8(b.price) } : {}),
    ...(b.amountCents !== undefined ? { amountCents: BigInt(b.amountCents) } : {}),
    ...(b.feeCents !== undefined ? { feeCents: BigInt(b.feeCents) } : {}),
    ...(b.splitNum !== undefined ? { splitNum: b.splitNum } : {}),
    ...(b.splitDen !== undefined ? { splitDen: b.splitDen } : {}),
    ...(b.costBasisCents !== undefined ? { costBasisCents: b.costBasisCents === null ? null : BigInt(b.costBasisCents) } : {}),
    ...(b.acquiredDate !== undefined ? { acquiredDate: b.acquiredDate } : {}),
    ...(b.ledgerTransactionId !== undefined ? { ledgerTransactionId: b.ledgerTransactionId } : {}),
    ...(b.transferGroupId !== undefined ? { transferGroupId: b.transferGroupId } : {}),
    ...(b.memo !== undefined ? { memo: b.memo } : {}),
  };
}

/** The accounts a row's value lives in: its own and, for a paired transfer, the counterparty's. */
function accountsOf(rows: ReadonlyArray<{ accountId: string; counterpartyAccountId: string | null }>): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.accountId);
    if (r.counterpartyAccountId) ids.add(r.counterpartyAccountId);
  }
  return [...ids];
}

function toManualPositions(b: ManualBody): ManualPositionInputRecord[] {
  return b.positions.map((p) => ({
    security: p.security,
    ...(p.quantity !== undefined ? { quantity: p.quantity === null ? null : parseFixed8(p.quantity) } : {}),
    ...(p.price !== undefined ? { price: parseFixed8(p.price) } : {}),
    ...(p.valueCents !== undefined ? { valueCents: BigInt(p.valueCents) } : {}),
    ...(p.costBasisCents !== undefined ? { costBasisCents: p.costBasisCents === null ? null : BigInt(p.costBasisCents) } : {}),
  }));
}

export async function investmentTxnRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/investments/txns", { schema: { querystring: InvestmentTxnQuery, response: { 200: InvestmentTxnList } } }, async (request) => {
    const q = request.query;
    const query: ListInvestmentTxnsQuery = {
      limit: q.limit,
      ...(q.accountId !== undefined ? { accountId: q.accountId } : {}),
      ...(q.securityId !== undefined ? { securityId: q.securityId } : {}),
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    };
    const result = await listInvestmentTxns(app.db, query);
    return { items: result.items.map(toInvestmentTxnView), nextCursor: result.nextCursor };
  });

  r.get("/investments/txns/:id", { schema: { params: UuidParams, response: { 200: InvestmentTxnView } } }, async (request) => {
    const row = await getInvestmentTxn(app.db, request.params.id);
    if (!row) throw notFound("Investment transaction not found");
    return toInvestmentTxnView(row);
  });

  /** One or two rows (the mirror leg of an own-account transfer); one audit batch; lots rebuilt. */
  r.post("/investments/txns", { schema: { body: CreateInvestmentTxnBody, response: { 200: CreateInvestmentTxnResponse } } }, async (request) => {
    const today = await resolveToday(app, request.body.today);
    const ctx = auditContext(request);
    const result = await createInvestmentTxn(app.db, toCreateInput(request.body), { ...ctx, today });
    for (const accountId of accountsOf(result.items)) await requestValuation(app.db, { reason: "investment_txn", accountId });
    return { items: result.items.map(toInvestmentTxnView), batchId: ctx.batchId };
  });

  /** `ledgerTransactionId` links or (null) unlinks the ledger row; `transferGroupId: null` unpairs both legs. */
  r.patch("/investments/txns/:id", { schema: { params: UuidParams, body: UpdateInvestmentTxnBody, response: { 200: InvestmentTxnView } } }, async (request) => {
    const today = await resolveToday(app, request.body.today);
    const before = await getInvestmentTxn(app.db, request.params.id);
    const result = await updateInvestmentTxn(app.db, request.params.id, toUpdateInput(request.body), { ...auditContext(request), today });
    // The counterparty before the patch too: `transferGroupId: null` unpairs the legs.
    for (const accountId of accountsOf(before ? [before, result.item] : [result.item])) await requestValuation(app.db, { reason: "investment_txn", accountId });
    return toInvestmentTxnView(result.item);
  });

  r.delete("/investments/txns/:id", { schema: { params: UuidParams, querystring: DeleteInvestmentTxnQuery, response: { 200: OkResponse } } }, async (request) => {
    const before = await getInvestmentTxn(app.db, request.params.id);
    await deleteInvestmentTxn(app.db, request.params.id, { ...(request.query.deleteGroup !== undefined ? { deleteGroup: request.query.deleteGroup } : {}) }, auditContext(request));
    for (const accountId of accountsOf(before ? [before] : [])) await requestValuation(app.db, { reason: "investment_txn", accountId });
    return { ok: true as const };
  });

  // ---- Holding snapshots of an account ----

  r.get("/investments/accounts/:id/snapshots", { schema: { params: UuidParams, response: { 200: z.array(SnapshotSummaryView) } } }, async (request) => {
    await loadInvestmentAccount(app.db, request.params.id);
    return (await listSnapshots(app.db, request.params.id)).map(toSnapshotSummaryView);
  });

  r.get("/investments/accounts/:id/snapshots/:date", { schema: { params: SnapshotDateParams, response: { 200: HoldingSnapshotView } } }, async (request) => {
    await loadInvestmentAccount(app.db, request.params.id);
    const snapshot = await getSnapshot(app.db, request.params.id, request.params.date);
    if (!snapshot) throw notFound(`No snapshot on ${request.params.date}`);
    return toHoldingSnapshotView(snapshot);
  });

  /** The latest snapshot on or before `asOf` (default today). */
  r.get("/investments/accounts/:id/positions", { schema: { params: UuidParams, querystring: PositionsQuery, response: { 200: HoldingSnapshotView } } }, async (request) => {
    const today = await resolveToday(app, request.query.today);
    const asOf = request.query.asOf ?? today;
    if (asOf > today) throw badRequest("asOf must be on or before today", "validation");
    await loadInvestmentAccount(app.db, request.params.id);
    const snapshot = await latestSnapshot(app.db, request.params.id, asOf);
    if (!snapshot) throw notFound(`No positions on or before ${asOf}`);
    return toHoldingSnapshotView(snapshot);
  });

  /** The positions editor: a `manual` snapshot (the top rank, always allowed), audited; the balance row = statementTotalCents ?? Σ positions. */
  r.put("/investments/accounts/:id/positions", { schema: { params: UuidParams, body: ManualPositionsBody, response: { 200: HoldingSnapshotView } } }, async (request) => {
    const b = request.body;
    const today = await resolveToday(app, b.today);
    const result = await setManualPositions(
      app.db,
      {
        accountId: request.params.id,
        asOfDate: b.asOfDate,
        positions: toManualPositions(b),
        ...(b.setBalance !== undefined ? { setBalance: b.setBalance } : {}),
        ...(b.statementTotalCents !== undefined ? { statementTotalCents: BigInt(b.statementTotalCents) } : {}),
      },
      { ...auditContext(request), today },
    );
    return toHoldingSnapshotView(result.snapshot);
  });

  /** csv and manual snapshots only (409 `snapshot_source` for a SimpleFIN set); the balance row of the same date and source goes with it. */
  r.delete("/investments/accounts/:id/snapshots/:date", { schema: { params: SnapshotDateParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteSnapshot(app.db, request.params.id, request.params.date, auditContext(request));
    return { ok: true as const };
  });
}
