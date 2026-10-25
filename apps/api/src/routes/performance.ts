import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getPerformance, listLots, listRealized, rebuildAllLots, setLotPicks, type GetPerformanceQuery, type LotRecord, type PerformanceRecord } from "@meridian/db";
import { LotsQuery, LotsResponse, parseFixed8, PerformanceRequestBody, PerformanceResponse, RealizedGainsQuery, RealizedGainsResponse, RebuildLotsBody, RebuildLotsResponse, SetLotPicksBody, SetLotPicksResponse, UuidParams } from "@meridian/shared";
import { badRequest } from "../lib/errors.js";
import { toLotsResponse, toPerformanceResponse, toRealizedGainsResponse, toRebuildLotsResponse, toSetLotPicksResponse } from "../views/performance.js";
import { auditContext, resolveToday, usePlanErrors } from "./plan.js";

/**
 * The lots area's routes (lots design §4.3, plan decision 17): the engine's performance
 * computation (a `readOnly` POST so the viewer role may call it, like the cash-flow
 * projection), the stored lots valued as of a date, realized gains from `lot_disposal`,
 * specific-lot picks on a sale, and the maintenance rebuild. Every read writes nothing.
 */
export async function performanceRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  /** `detail: full` lots carry the valued columns of the stored lot with the same (stable) id. */
  async function lotDetails(record: PerformanceRecord): Promise<Map<string, LotRecord>> {
    const out = new Map<string, LotRecord>();
    for (const a of record.accounts) {
      if (a.lots.length === 0) continue;
      const lots = await listLots(app.db, { accountId: a.accountId, asOf: record.asOf, includeClosed: true });
      for (const l of lots.lots) out.set(l.id, l);
    }
    return out;
  }

  r.post(
    "/investments/performance",
    { config: { readOnly: true }, schema: { body: PerformanceRequestBody, response: { 200: PerformanceResponse } } },
    async (request, reply) => {
      const b = request.body;
      const today = await resolveToday(app, b.today);
      const query: GetPerformanceQuery = {
        today,
        detail: b.detail,
        now: app.now(),
        ...(b.from !== undefined ? { from: b.from } : {}),
        ...(b.to !== undefined ? { to: b.to } : {}),
        ...(b.asOf !== undefined ? { asOf: b.asOf } : {}),
        ...(b.accountIds !== undefined ? { accountIds: b.accountIds } : {}),
        ...(b.benchmarkSecurityId !== undefined ? { benchmarkSecurityId: b.benchmarkSecurityId } : {}),
      };
      const record = await getPerformance(app.db, query);
      const details = b.detail === "full" ? await lotDetails(record) : new Map<string, LotRecord>();
      reply.header("Cache-Control", "no-store");
      return toPerformanceResponse(record, details);
    },
  );

  r.get("/investments/lots", { schema: { querystring: LotsQuery, response: { 200: LotsResponse } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const asOf = q.asOf ?? today;
    if (asOf > today) throw badRequest("asOf must be on or before today", "validation");
    const result = await listLots(app.db, {
      asOf,
      includeClosed: q.includeClosed,
      ...(q.accountId !== undefined ? { accountId: q.accountId } : {}),
      ...(q.securityId !== undefined ? { securityId: q.securityId } : {}),
    });
    reply.header("Cache-Control", "no-store");
    return toLotsResponse(result);
  });

  r.get("/investments/realized", { schema: { querystring: RealizedGainsQuery, response: { 200: RealizedGainsResponse } } }, async (request, reply) => {
    const q = request.query;
    if (q.to < q.from) throw badRequest("to must be on or after from", "validation");
    const result = await listRealized(app.db, {
      from: q.from,
      to: q.to,
      ...(q.accountId !== undefined ? { accountId: q.accountId } : {}),
      ...(q.securityId !== undefined ? { securityId: q.securityId } : {}),
    });
    reply.header("Cache-Control", "no-store");
    return toRealizedGainsResponse(result);
  });

  /** Replaces the sale's picks (`[]` clears them); audited as `lot_pick`; the account's lots are rebuilt and the sale's warnings returned. */
  r.put("/investments/txns/:id/lot-picks", { schema: { params: UuidParams, body: SetLotPicksBody, response: { 200: SetLotPicksResponse } } }, async (request) => {
    const ctx = auditContext(request);
    const result = await setLotPicks(
      app.db,
      request.params.id,
      request.body.picks.map((p) => ({ lotId: p.lotId, quantity: parseFixed8(p.quantity) })),
      ctx,
    );
    return toSetLotPicksResponse(result, ctx.batchId);
  });

  /** Owner only; idempotent maintenance after a migration or bulk edit. */
  r.post("/investments/lots/rebuild", { schema: { body: RebuildLotsBody, response: { 200: RebuildLotsResponse } } }, async (request) => {
    return toRebuildLotsResponse(await rebuildAllLots(app.db, request.body.accountId));
  });
}
