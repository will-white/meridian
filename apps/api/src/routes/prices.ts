import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { deleteManualPrice, listPrices, pricesStatus, rebuildImpliedPrices, requestPriceRefresh, requestValuation, securityPriceStatus, setManualPrice, type ListPricesQuery, type PriceFeedConfig } from "@meridian/db";
import { OkResponse, parseFixed8, PriceHistoryQuery, PriceHistoryResponse, PriceParams, PricesStatusResponse, PriceView, RebuildImpliedPricesResponse, RefreshPricesBody, RefreshPricesResponse, SecurityIdParams, SetPriceBody } from "@meridian/shared";
import { HttpError } from "../lib/errors.js";
import { toPriceHistoryResponse, toPricesStatusResponse, toPriceView } from "../views/valuation.js";
import { auditContext, resolveToday, usePlanErrors } from "./plan.js";
import { priceProviderConfigured } from "./securities.js";

/**
 * Prices routes (prices design §4.1, plan decisions 10 and 17): the Prices page's status, the
 * owner's manual refresh (every refresh goes through `requestPriceRefresh`), a security's price
 * history, and manual closes at `PUT/DELETE /api/prices/:securityId/:date` (the only place a
 * price is set by hand). `PRICE_PROVIDER` is read from the API config for display and the
 * `not_configured` state; the API never fetches a price itself. Every write that changes a
 * close the valuation chain reads (a manual PUT or DELETE, an implied rebuild) requests the
 * household-wide `investments.valuation` job (plan decision 9), deduped by its key: with
 * `PRICE_PROVIDER=none` no fetch run ever chains it, so this is what keeps the computed
 * balance rows and the net worth in step with a hand-set price.
 */

/** The feed's configuration as the API sees it (optional keys only when set, for exactOptionalPropertyTypes). */
export function priceFeedConfig(app: FastifyInstance): PriceFeedConfig {
  const config: PriceFeedConfig = { provider: app.config.priceProvider ?? null };
  if (app.config.priceFetchHour !== undefined) config.fetchHourLocal = app.config.priceFetchHour;
  if (app.config.priceCatchupHour !== undefined) config.catchupHourLocal = app.config.priceCatchupHour;
  return config;
}

export async function priceRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/prices/status", { schema: { response: { 200: PricesStatusResponse } } }, async (_request, reply) => {
    const status = await pricesStatus(app.db, { now: app.now(), ...priceFeedConfig(app) });
    reply.header("Cache-Control", "no-store");
    return toPricesStatusResponse(status);
  });

  /** Owner. A running fetch is returned as is; a queued manual one is pulled forward; else a `prices:manual` job is queued. */
  r.post("/prices/refresh", { schema: { body: RefreshPricesBody, response: { 200: RefreshPricesResponse } } }, async (request) => {
    if (!priceProviderConfigured(app)) throw new HttpError(503, "No price provider is configured (PRICE_PROVIDER=none)", "not_configured");
    const result = await requestPriceRefresh(app.db, {
      reason: "manual",
      now: app.now(),
      ...(request.body.securityIds !== undefined ? { securityIds: request.body.securityIds } : {}),
      ...(request.body.from !== undefined ? { from: request.body.from } : {}),
    });
    return { jobId: result.jobId, created: result.created, movedUp: result.movedUp };
  });

  /** Owner; idempotent maintenance: one implied row per valued position lacking a provider or manual price. */
  r.post("/prices/rebuild-implied", { schema: { response: { 200: RebuildImpliedPricesResponse } } }, async () => {
    const result = await app.db.transaction(async (tx) => {
      const rebuilt = await rebuildImpliedPrices(tx, {});
      await requestValuation(tx, { reason: "rebuild_implied" });
      return rebuilt;
    });
    return { written: result.written };
  });

  r.get("/prices/:securityId", { schema: { params: SecurityIdParams, querystring: PriceHistoryQuery, response: { 200: PriceHistoryResponse } } }, async (request, reply) => {
    const q = request.query;
    const status = await securityPriceStatus(app.db, request.params.securityId, app.now());
    const query: ListPricesQuery = { limit: q.limit, ...(q.from !== undefined ? { from: q.from } : {}), ...(q.to !== undefined ? { to: q.to } : {}) };
    const items = await listPrices(app.db, request.params.securityId, query);
    reply.header("Cache-Control", "no-store");
    return toPriceHistoryResponse({ securityId: request.params.securityId, status, items });
  });

  /** Owner; `date ≤ today` (400 `future_date`), never the cash security (400 `cash_security_reserved`); audited as a `security` update. */
  r.put("/prices/:securityId/:date", { schema: { params: PriceParams, body: SetPriceBody, response: { 200: PriceView } } }, async (request) => {
    const today = await resolveToday(app, request.body.today);
    const record = await setManualPrice(app.db, request.params.securityId, { date: request.params.date, close: parseFixed8(request.body.close) }, { ...auditContext(request), today });
    await requestValuation(app.db, { reason: "manual_price" });
    return toPriceView(record);
  });

  /** Owner; manual rows only (409 `manual_only`); audited; a refill fetch is queued when a provider is configured. */
  r.delete("/prices/:securityId/:date", { schema: { params: PriceParams, response: { 200: OkResponse } } }, async (request) => {
    await deleteManualPrice(app.db, request.params.securityId, request.params.date, auditContext(request), { refill: priceProviderConfigured(app), now: app.now() });
    await requestValuation(app.db, { reason: "manual_price" });
    return { ok: true as const };
  });
}
