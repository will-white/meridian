import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  accountFidelities,
  defaultAsOf,
  earliestDataDate,
  firstDataDates,
  getAccountChanges,
  getAllocation,
  getHoldings,
  getHouseholdSetting,
  getInvestmentIncome,
  getPerformance,
  getPortfolio,
  getSecurity,
  investmentAccountIds,
  loadPriceSeries,
  periodBounds,
  runInvestmentIncomeFeed,
  uncategorizedRowsInWindow,
  type GetPerformanceQuery,
  type IncomeQueryInput,
  type PeriodBounds,
  type PortfolioQueryInput,
} from "@meridian/db";
import {
  AccountChangesQuery,
  AccountChangesView,
  AllocationQuery,
  AllocationView,
  HoldingsQuery,
  HoldingsView,
  IncomeQuery,
  IncomeView,
  PerformanceQuery,
  PerformanceView,
  PortfolioQuery,
  PortfolioView,
  RunIncomeFeedBody,
  RunIncomeFeedResponse,
  UuidParams,
  type IsoDate,
} from "@meridian/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { toAccountChangesView, toAllocationView, toHoldingsView, toIncomeView, toPerformanceView, toPortfolioView, toRunIncomeFeedResponse, type PerformanceViewExtras } from "../views/investmentViews.js";
import { resolveToday, usePlanErrors } from "./plan.js";

/**
 * The Investments pages' routes (views design §4 "Routes"; plan decisions 12, 13, 16, 17): Portfolio,
 * Allocation, Holdings, Performance (the GET presentation of the engine's `readOnly` POST in
 * `routes/performance.ts`; a test asserts the two agree), Income, "why did it change", and the
 * owner's on-demand income-feed run. `asOf` is the date parameter on every GET (default: the
 * latest close the feed can have, never after today); every view is sent with
 * `Cache-Control: no-store` and writes nothing. The per-account feed setting lives on
 * `PATCH /api/accounts/:id`, the per-security allocation on `routes/securities.ts`.
 */
export async function investmentViewRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  usePlanErrors(app);

  r.get("/investments/portfolio", { schema: { querystring: PortfolioQuery, response: { 200: PortfolioView } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const query: PortfolioQueryInput = {
      today,
      now: app.now(),
      period: q.period,
      ...(q.asOf !== undefined ? { asOf: q.asOf } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.includeClosed !== undefined ? { includeClosed: q.includeClosed } : {}),
    };
    const record = await getPortfolio(app.db, query);
    reply.header("Cache-Control", "no-store");
    return toPortfolioView(record);
  });

  r.get("/investments/allocation", { schema: { querystring: AllocationQuery, response: { 200: AllocationView } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const record = await getAllocation(app.db, { today, now: app.now(), ...(q.asOf !== undefined ? { asOf: q.asOf } : {}), ...(q.includeClosed !== undefined ? { includeClosed: q.includeClosed } : {}) });
    reply.header("Cache-Control", "no-store");
    return toAllocationView(record);
  });

  /** `accountId` restricts the rows; the weights stay relative to the restricted total. */
  r.get("/investments/holdings", { schema: { querystring: HoldingsQuery, response: { 200: HoldingsView } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const record = await getHoldings(app.db, {
      today,
      now: app.now(),
      ...(q.asOf !== undefined ? { asOf: q.asOf } : {}),
      ...(q.accountId !== undefined ? { accountId: q.accountId } : {}),
      ...(q.includeClosed !== undefined ? { includeClosed: q.includeClosed } : {}),
    });
    reply.header("Cache-Control", "no-store");
    return toHoldingsView(record);
  });

  /**
   * The Performance page (views design §3.12): the period preset's bounds end at `asOf`
   * (`all` leaves `from` to the engine's since-inception rule), the engine runs with full detail
   * so the chart series can follow its sub-period boundaries, and the household benchmark applies
   * unless the query names one (404 when unknown; `no_benchmark_price` when it has no close on or
   * before `from`). Every figure is the engine's own; the mapper only presents it.
   */
  r.get("/investments/performance", { schema: { querystring: PerformanceQuery, response: { 200: PerformanceView } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const now = app.now();
    let asOf = q.asOf ?? defaultAsOf(today, now);
    if (q.period === "custom" && q.to !== undefined) asOf = q.to;
    if (asOf > today) throw badRequest(`asOf ${asOf} is after today ${today}`, "validation");

    const ids = await investmentAccountIds(app.db, q.accountIds);
    const fidelities = await accountFidelities(app.db, ids);
    const earliest = earliestDataDate(await firstDataDates(app.db, ids, fidelities));
    let bounds: PeriodBounds | null = null;
    let from: IsoDate | undefined;
    if (q.period !== "all") {
      bounds = periodBounds(q.period, asOf, earliest, { from: q.from ?? null, to: asOf, today });
      if (bounds === null) throw badRequest("A custom period needs from", "validation");
      from = bounds.from;
    }

    const benchmarkSecurityId = q.benchmarkSecurityId ?? (await getHouseholdSetting(app.db, today)).benchmarkSecurityId;
    let benchmark: PerformanceViewExtras["benchmark"] = null;
    if (benchmarkSecurityId !== null) {
      const security = await getSecurity(app.db, benchmarkSecurityId);
      if (!security) throw notFound("Benchmark security not found");
      benchmark = { securityId: security.id, ticker: security.ticker, name: security.name };
    }

    const query: GetPerformanceQuery = { today, now, detail: "full", to: asOf, asOf, accountIds: ids, benchmarkSecurityId, ...(from !== undefined ? { from } : {}) };
    const record = await getPerformance(app.db, query);

    let benchmarkCloses: PerformanceViewExtras["benchmarkCloses"] = [];
    if (benchmarkSecurityId !== null && record.benchmark !== null) {
      const series = (await loadPriceSeries(app.db, [benchmarkSecurityId], record.from, record.to, { adjusted: record.benchmark.adjusted })).get(benchmarkSecurityId);
      benchmarkCloses = (series?.points ?? []).map((p) => ({ date: p.date, close: p.close }));
    }
    const uncategorized = new Map<string, number>();
    uncategorized.set("total", await uncategorizedRowsInWindow(app.db, ids, record.from, record.to));
    for (const id of ids) uncategorized.set(id, await uncategorizedRowsInWindow(app.db, [id], record.from, record.to));
    const fidelityNotes = new Map(ids.map((id) => [id, fidelities.get(id)?.fidelityNote ?? null]));

    reply.header("Cache-Control", "no-store");
    return toPerformanceView(record, { today, periodKind: q.period, period: bounds, benchmark, benchmarkCloses, fidelityNotes, uncategorized });
  });

  r.get("/investments/income", { schema: { querystring: IncomeQuery, response: { 200: IncomeView } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const query: IncomeQueryInput = {
      today,
      now: app.now(),
      period: q.period,
      ...(q.asOf !== undefined ? { asOf: q.asOf } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.accountId !== undefined ? { accountId: q.accountId } : {}),
      ...(q.includeClosed !== undefined ? { includeClosed: q.includeClosed } : {}),
    };
    const record = await getInvestmentIncome(app.db, query);
    reply.header("Cache-Control", "no-store");
    return toIncomeView(record);
  });

  /** Owner; runs inline (bounded: a few hundred rows per account). 400 `feed_category_required` when an enabled account has no household category. */
  r.post("/investments/income/feed/run", { schema: { body: RunIncomeFeedBody.default({}), response: { 200: RunIncomeFeedResponse } } }, async (request) => {
    const accountId = request.body.accountId;
    const result = await runInvestmentIncomeFeed(app.db, { now: app.now(), ...(accountId !== undefined ? { accountIds: [accountId] } : {}) });
    if (result.skipped.length > 0) throw badRequest("Set the household's investment income category first", "feed_category_required");
    return toRunIncomeFeedResponse(result);
  });

  /** Why did it change: `from < to ≤ today`, at most five years (400 `validation`); 404 for an unknown account. */
  r.get("/investments/accounts/:id/changes", { schema: { params: UuidParams, querystring: AccountChangesQuery, response: { 200: AccountChangesView } } }, async (request, reply) => {
    const q = request.query;
    const today = await resolveToday(app, q.today);
    const record = await getAccountChanges(app.db, request.params.id, { from: q.from, to: q.to, today, now: app.now() });
    reply.header("Cache-Control", "no-store");
    return toAccountChangesView(record);
  });
}
