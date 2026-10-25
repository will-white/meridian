import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { valuationSeries, valuationSummary, type ValuationSeriesQueryInput, type ValuationSummaryQueryInput } from "@meridian/db";
import { ValuationSeriesQuery, ValuationSeriesResponse, ValuationSummaryQuery, ValuationSummaryResponse } from "@meridian/shared";
import { toValuationSeriesResponse, toValuationSummaryResponse } from "../views/valuation.js";
import { resolveToday, usePlanErrors } from "./plan.js";

/**
 * Valuation routes (prices design §4.1, plan decisions 8 and 12): the household's investment
 * accounts valued by the one chain on `asOf` with day and period change, and the value series
 * for a date range. `asOf` is the date parameter and `accountIds` a comma-separated list (plan
 * decision 17); an unknown, closed or non-investment account is 400 `bad_request`. Reads only.
 */
export async function valuationRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/valuation/summary", { schema: { querystring: ValuationSummaryQuery, response: { 200: ValuationSummaryResponse } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const query: ValuationSummaryQueryInput = {
      today,
      now: app.now(),
      period: q.period,
      ...(q.asOf !== undefined ? { asOf: q.asOf } : {}),
      ...(q.accountIds !== undefined ? { accountIds: q.accountIds } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
    };
    const summary = await valuationSummary(app.db, query);
    reply.header("Cache-Control", "no-store");
    return toValuationSummaryResponse(summary);
  });

  r.get("/valuation/series", { schema: { querystring: ValuationSeriesQuery, response: { 200: ValuationSeriesResponse } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const query: ValuationSeriesQueryInput = {
      from: q.from,
      to: q.to,
      today,
      now: app.now(),
      step: q.step,
      ...(q.accountIds !== undefined ? { accountIds: q.accountIds } : {}),
    };
    const series = await valuationSeries(app.db, query);
    reply.header("Cache-Control", "no-store");
    return toValuationSeriesResponse(series);
  });
}
