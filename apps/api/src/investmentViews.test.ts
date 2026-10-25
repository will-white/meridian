import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountReconciliation, auditLog, balanceSnapshot, holdingSnapshot, job, lot, lotDisposal, price, transaction } from "@meridian/db";
import { INV_SEED_TODAY } from "@meridian/db/testing";
import type {
  AccountChangesView,
  AccountView,
  AllocationView,
  AuthStatus,
  CategoryView,
  HoldingsView,
  HouseholdSettingView,
  IncomeView,
  JobView,
  PerformanceResponse,
  PerformanceView,
  PortfolioView,
  ReturnBlockView,
  RunIncomeFeedResponse,
} from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, viewerCookies, type InvestmentApp } from "./test/investments.js";

/**
 * The Investments pages' routes on the INV seed (views design §4 "Routes", tests 2, 11–13, 17–19;
 * plan decisions 12, 13, 16, 17, 19): Portfolio, Allocation, Holdings, Performance (the GET
 * presentation that must equal the engine's POST), Income, "why did it change", the feed run,
 * the Phase 1/2 route extensions (accounts' investment block and settings, the household
 * settings, reprocess-holdings, auth role), the viewer matrix, `Cache-Control: no-store` on every
 * view and zero writes on the reads. Mutations run last so the reads see the fresh seed.
 */

const TODAY = INV_SEED_TODAY;

describe.skipIf(!TEST_DATABASE_URL)("investment view routes", () => {
  let A: InvestmentApp;
  let B: string;
  let R: string;
  let C: string;

  beforeAll(async () => {
    A = await freshInvestmentApp({ lots: true });
    ({ brokerage: B, roth: R, checking: C } = A.S.accounts);
  });
  afterAll(async () => {
    await A?.t.cleanup();
  });

  const tableCounts = async () => {
    const out: Record<string, number> = {};
    for (const [name, table] of Object.entries({ job, auditLog, lot, lotDisposal, price, balanceSnapshot, holdingSnapshot, accountReconciliation, transaction })) {
      out[name] = (await A.t.db.db.select({ n: count() }).from(table))[0]!.n;
    }
    return out;
  };
  const get = async <T>(url: string): Promise<{ res: Awaited<ReturnType<InvestmentApp["t"]["call"]>>; view: T }> => {
    const res = await A.t.call({ method: "GET", url });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    expect(res.headers["cache-control"], url).toBe("no-store");
    return { res, view: res.json() as T };
  };

  it("GET /investments/portfolio (views test 2): totals, day change, the 1y period change, the account blocks, the series and the validation codes", async () => {
    const before = await tableCounts();
    const { res, view } = await get<PortfolioView>(`/api/investments/portfolio?today=${TODAY}&period=1y`);
    expect(view).toMatchObject({ today: TODAY, asOf: "2026-10-13", totalCents: "4525200", fidelityCounts: { balance_only: 0, positions: 1, full_history: 1 } });
    expect(view.period).toEqual({ kind: "1y", from: "2025-10-13", to: "2026-10-13", days: 365, partial: false, note: null });
    expect(view.dayChange).toEqual({ cents: "36000", asOf: "2026-10-13", prior: "2026-10-12", reason: null, bp: 80, partial: false, excluded: [] });
    expect(view.periodChange).toEqual({
      from: "2025-10-13",
      to: "2026-10-13",
      startCents: "3500000",
      endCents: "4525200",
      changeCents: "1025200",
      changeBp: 2929,
      netFlowsCents: "500000",
      growthCents: "525200",
      growthReason: null,
      incomeCents: "32435",
      uncategorizedRows: 1,
    });
    expect(view.accounts.map((a) => a.accountName)).toEqual(["Fidelity Roth IRA", "Vanguard Brokerage"]);
    const [roth, brokerage] = view.accounts;
    expect(roth).toMatchObject({
      accountId: R,
      type: "roth",
      taxTreatment: "roth",
      fidelity: "positions",
      fidelityNote: null,
      basis: "positions",
      valueCents: "1820000",
      valuationDate: "2026-10-13",
      valuationSource: "computed",
      valuationStale: false,
      positionsDate: "2026-10-09",
      positionsStale: false,
      dayChangeCents: "4000",
      dayChangeBp: 22,
      holdingsCount: 4,
      cashCents: "27000",
      residualCents: "0",
      closed: false,
      investmentIncomeFeed: "off",
      period: { startCents: "1500000", endCents: "1820000", changeCents: "320000", changeBp: 2133, netFlowsCents: "0", growthCents: "320000", incomeCents: "9235", uncategorizedRows: 0 },
      warnings: [],
    });
    expect(brokerage).toMatchObject({
      accountId: B,
      fidelity: "full_history",
      fidelityNote: null,
      basis: "snapshot",
      valueCents: "2705200",
      valuationDate: "2026-10-13",
      valuationSource: "simplefin",
      positionsDate: "2026-10-13",
      dayChangeCents: "32000",
      dayChangeBp: 119,
      holdingsCount: 3,
      cashCents: "0",
      residualCents: "143200",
      investmentIncomeFeed: "link",
      period: { startCents: "2000000", endCents: "2705200", changeCents: "705200", changeBp: 3526, netFlowsCents: "500000", growthCents: "205200", incomeCents: "23200", uncategorizedRows: 1 },
    });
    expect(view.series.step).toBe(1);
    expect(view.series.dates).toHaveLength(366);
    const at = (date: string) => view.series.total[view.series.dates.indexOf(date)];
    expect(at("2025-10-13")).toBe("3500000");
    expect(at("2026-10-08")).toBe("4053200");
    expect(at("2026-10-09")).toBe("4489200");
    expect(at("2026-10-12")).toBe("4489200");
    expect(view.series.total[view.series.total.length - 1]).toBe("4525200");
    const rPoints = view.series.accounts.find((a) => a.accountId === R)!.points;
    expect([rPoints[view.series.dates.indexOf("2026-10-08")], rPoints[view.series.dates.indexOf("2026-10-09")], rPoints[view.series.dates.indexOf("2026-10-12")], rPoints[view.series.dates.indexOf("2026-10-13")]]).toEqual(["1500000", "1810000", "1816000", "1820000"]);
    expect(view.warnings).toContain("1 uncategorized row in Vanguard Brokerage is neither a transfer nor income; mark it if it is a contribution or withdrawal");

    const bad = await A.t.call({ method: "GET", url: `/api/investments/portfolio?today=${TODAY}&period=custom&from=2026-10-13&to=2026-10-12` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "validation" });
    const future = await A.t.call({ method: "GET", url: `/api/investments/portfolio?today=${TODAY}&asOf=2026-10-15` });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ code: "validation" });
    const d12 = (await get<PortfolioView>(`/api/investments/portfolio?today=${TODAY}&asOf=2026-10-12&period=1m`)).view;
    expect(d12.totalCents).toBe("4489200");
    expect(d12.dayChange).toMatchObject({ asOf: "2026-10-12", prior: "2026-10-09", cents: "0", bp: 0 });

    // Deterministic and read-only.
    expect((await get<PortfolioView>(`/api/investments/portfolio?today=${TODAY}&period=1y`)).res.body).toBe(res.body);
    expect(await tableCounts()).toEqual(before);
  });

  it("GET /investments/allocation (views test 5): the six classes in enum order against the 50/25/20/5 targets, drift and the rebalance suggestion", async () => {
    const { view } = await get<AllocationView>(`/api/investments/allocation?today=${TODAY}`);
    expect(view).toMatchObject({ today: TODAY, asOf: "2026-10-13", totalCents: "4525200", classifiedCents: "4525200", unclassifiedCents: "0", targetsSet: true, unclassifiedAccounts: [], warnings: [], accountWarnings: [] });
    expect(view.classes.map((c) => [c.assetClass, c.currentCents, c.currentBp, c.targetBp, c.targetCents, c.driftBp, c.driftCents, c.outOfBand])).toEqual([
      ["us_stock", "2701800", 5970, 5000, "2262600", 970, "439200", true],
      ["intl_stock", "863200", 1907, 2500, "1131300", -593, "-268100", true],
      ["bonds", "790000", 1745, 2000, "905040", -255, "-115040", false],
      ["cash", "170200", 376, 500, "226260", -124, "-56060", false],
      ["real_estate", "0", 0, 0, "0", 0, "0", false],
      ["other", "0", 0, 0, "0", 0, "0", false],
    ]);
    expect(view.classes[0]!.lines.map((l) => [l.ticker ?? l.name, l.accountName, l.cents, l.kind, l.blended]).sort()).toEqual(
      [
        ["AAPL", "Vanguard Brokerage", "600000", "position", false],
        ["VTI", "Fidelity Roth IRA", "625000", "position", false],
        ["VTI", "Vanguard Brokerage", "1250000", "position", false],
        ["Vanguard Target Retirement 2050 Trust", "Fidelity Roth IRA", "226800", "position", true],
      ].sort(),
    );
    expect(view.byTaxTreatment.map((t) => [t.taxTreatment, t.cents, t.bp]).sort()).toEqual([
      ["roth", "1820000", 4021],
      ["taxable", "2705200", 5978],
    ]);
    expect(view.byAccount.map((a) => [a.accountName, a.fidelity, a.cents, a.bp])).toEqual([
      ["Fidelity Roth IRA", "positions", "1820000", 4021],
      ["Vanguard Brokerage", "full_history", "2705200", 5978],
    ]);
    expect(view.rebalance).toMatchObject({ triggered: true, bandBp: 500, minTradeCents: "10000", belowMinimumCents: "0", residual: [] });
    expect(view.rebalance!.trades.map((t) => [t.action, t.assetClass, t.ticker, t.amountCents, t.approxQuantity, t.price])).toEqual([
      ["sell", "us_stock", "VTI", "439200", "14.0544", "312.5"],
      ["buy", "intl_stock", "VXUS", "268100", "37.65449438", "71.2"],
      ["buy", "bonds", "BND", "115040", "15.37967914", "74.8"],
      ["hold_cash", "cash", null, "56060", null, null],
    ]);
    expect(view.rebalance!.notes).toContain("Vanguard Target Retirement 2050 Trust is a blended fund and is held constant");
  });

  it("GET /investments/holdings (views test 8): rows per security with coverage, the weighted expense ratio, concentration, and the accountId restriction", async () => {
    const { view } = await get<HoldingsView>(`/api/investments/holdings?today=${TODAY}`);
    expect(view).toMatchObject({ asOf: "2026-10-13", totalCents: "4525200", holdingsCents: "4382000", cashCents: "27000", residualCents: "143200", excludedAccounts: [], accountWarnings: [], warnings: [] });
    expect(view.rows.map((r) => [r.ticker ?? r.name, r.valueCents, r.weightBp, r.coverage, r.costBasisCents, r.gainCents, r.gainBp, r.expenseRatioPpm])).toEqual([
      ["VTI", "1875000", 4143, "partial", "1080000", "170000", 1574, 300],
      ["BND", "748000", 1652, "none", null, null, null, 300],
      ["VXUS", "712000", 1573, "full", "580000", "132000", 2275, 500],
      ["AAPL", "600000", 1325, "full", "575000", "25000", 434, null],
      ["Vanguard Target Retirement 2050 Trust", "420000", 928, "none", null, null, null, 800],
      ["Cash (USD)", "170200", 376, "full", "170200", "0", 0, null],
    ]);
    const vti = view.rows[0]!;
    expect(vti).toMatchObject({ securityId: A.S.securities.vti, quantity: "60", price: "312.5", priceDate: "2026-10-13", priceSource: "provider", priceStatus: "current", priceStale: false, splits: [], needsReview: false, type: "etf", assetClass: "us_stock" });
    expect(vti.accounts).toEqual([
      expect.objectContaining({ accountId: B, accountName: "Vanguard Brokerage", fidelity: "full_history", kind: "position", quantity: "40", valueCents: "1250000", costBasisCents: "1080000", basisSource: "lots", gainCents: "170000", lotCount: 2, unknownBasisQuantity: "0", priceSource: "statement", snapshotDate: "2026-10-13", snapshotSource: "simplefin", dollarOnly: false }),
      expect.objectContaining({ accountId: R, kind: "position", quantity: "20", valueCents: "625000", costBasisCents: null, basisSource: null, lotCount: null, priceSource: "provider", snapshotDate: "2026-10-09", snapshotSource: "csv" }),
    ]);
    expect(view.rows[4]).toMatchObject({ quantity: "100", price: "42", priceSource: "statement", priceStatus: "implied", splits: [{ assetClass: "us_stock", weightBp: 5400 }, { assetClass: "intl_stock", weightBp: 3600 }, { assetClass: "bonds", weightBp: 1000 }] });
    expect(view.rows[5]!.accounts.map((a) => [a.accountId, a.kind, a.quantity, a.valueCents])).toEqual([
      [B, "cash_plug", null, "143200"],
      [R, "cash", "270", "27000"],
    ]);
    expect(view.weightedExpenseRatio).toEqual({ ppm: 326, coveredBp: 10000, annualCostCents: "1478" });
    expect(view.concentration).toEqual([{ level: "warn", securityId: A.S.securities.aapl, ticker: "AAPL", weightBp: 1325, thresholdBp: 1000, message: "AAPL is 13.3% of your portfolio (individual stock; flagged above 10%)" }]);

    const onlyB = (await get<HoldingsView>(`/api/investments/holdings?today=${TODAY}&accountId=${B}`)).view;
    expect(onlyB.totalCents).toBe("2705200");
    expect(onlyB.rows.map((r) => [r.ticker ?? r.name, r.weightBp, r.coverage])).toEqual([
      ["VTI", 4620, "full"],
      ["VXUS", 2631, "full"],
      ["AAPL", 2217, "full"],
      ["Cash (USD)", 529, "full"],
    ]);
    const unknown = await A.t.call({ method: "GET", url: `/api/investments/holdings?today=${TODAY}&accountId=${C}` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "not_found" });
  });

  it("GET /investments/performance (views test 11): the 1y figures of the engine, the benchmark and the chart series; an unknown or unpriced benchmark", async () => {
    const { view } = await get<PerformanceView>(`/api/investments/performance?today=${TODAY}&period=1y`);
    expect(view).toMatchObject({ today: TODAY, asOf: "2026-10-13", warnings: [] });
    expect(view.period).toEqual({ kind: "1y", from: "2025-10-13", to: "2026-10-13", days: 365, partial: false, note: null });
    // VTI 260 → 309 (10-09) → 312.50 at the total's sub-period boundaries.
    expect(view.benchmark).toEqual({
      securityId: A.S.securities.vti,
      ticker: "VTI",
      name: "Vanguard Total Stock Market ETF",
      adjusted: true,
      series: [
        { date: "2025-10-13", indexBp: 10000 },
        { date: "2026-10-09", indexBp: 11885 },
        { date: "2026-10-13", indexBp: 12019 },
      ],
    });
    expect(view.accounts.map((a) => [a.accountName, a.fidelity, a.fidelityNote])).toEqual([
      ["Fidelity Roth IRA", "positions", null],
      ["Vanguard Brokerage", "full_history", null],
    ]);
    const brokerage = view.accounts.find((a) => a.accountId === B)!.block;
    expect(brokerage).toMatchObject({
      method: "true_twr",
      startValueCents: "2000000",
      endValueCents: "2705200",
      openingValue: null,
      contributionsCents: "500000",
      withdrawalsCents: "0",
      netFlowsCents: "500000",
      growthCents: "205200",
      flowsSource: "ledger",
      uncategorizedRows: 1,
      readable: [],
    });
    expect(brokerage.twr.rate).toBeCloseTo(0.0861681306, 6);
    expect(brokerage.twr.annualized).toBeCloseTo(0.0861681306, 6);
    expect(brokerage.xirr.annualized).toBeCloseTo(0.0913942, 6);
    expect(brokerage.xirr.investedDays).toBe(365);
    expect(brokerage.benchmark).toMatchObject({ shadowValueCents: "2942639", startPrice: "260", endPrice: "312.5", reason: null });
    expect(brokerage.benchmark!.twr).toBeCloseTo(0.2019230769, 6);
    expect(brokerage.benchmark!.excessTwr).toBeCloseTo(0.0861681306 - 0.2019230769, 6);
    expect(brokerage.flows).toEqual([expect.objectContaining({ date: "2026-04-13", amountCents: "500000", kind: "cash", source: "ledger", accountId: B, counterpartyAccountId: C, counterpartyAccountName: "Checking", internal: false })]);
    // 2 000 000 → 2 038 360 (04-12, the day before the flow) → 2 705 200: 10 000 → 10 192 → 10 862.
    expect(brokerage.series).toEqual([
      { date: "2025-10-13", indexBp: 10000 },
      { date: "2026-04-12", indexBp: 10192 },
      { date: "2026-10-13", indexBp: 10862 },
    ]);
    const roth = view.accounts.find((a) => a.accountId === R)!.block;
    expect(roth).toMatchObject({ method: "modified_dietz", startValueCents: "1500000", endValueCents: "1820000", contributionsCents: "0", growthCents: "320000", flowsSource: "none", uncategorizedRows: 0, flows: [] });
    expect(roth.twr.rate).toBeCloseTo(0.2133333, 6);
    expect(roth.benchmark).toMatchObject({ shadowValueCents: "1802885" });
    expect(roth.series).toEqual([
      { date: "2025-10-13", indexBp: 10000 },
      { date: "2026-10-09", indexBp: 12067 },
      { date: "2026-10-13", indexBp: 12133 },
    ]);
    expect(view.total).toMatchObject({ method: "modified_dietz", startValueCents: "3500000", endValueCents: "4525200", contributionsCents: "500000", growthCents: "525200", flowsSource: "ledger", uncategorizedRows: 1 });
    expect(view.total!.twr.rate).toBeCloseTo(0.139543, 6);
    expect(view.total!.xirr.annualized).toBeCloseTo(0.1403348, 6);
    expect(view.total!.benchmark).toMatchObject({ shadowValueCents: "4745524" });
    expect(view.total!.series.map((p) => p.date)).toEqual(["2025-10-13", "2026-10-09", "2026-10-13"]);
    expect(view.total!.series[1]!.indexBp).toBe(11305);
    expect(view.total!.series[2]!.indexBp).toBe(Math.round(10000 * (1 + view.total!.twr.rate!)));

    const unknown = await A.t.call({ method: "GET", url: `/api/investments/performance?today=${TODAY}&period=1y&benchmarkSecurityId=${randomUUID()}` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "not_found" });
    // BND has no close on or before 2025-10-13.
    const bnd = (await get<PerformanceView>(`/api/investments/performance?today=${TODAY}&period=1y&benchmarkSecurityId=${A.S.securities.bnd}`)).view;
    expect(bnd.benchmark).toEqual({ securityId: A.S.securities.bnd, ticker: "BND", name: "Vanguard Total Bond Market ETF", adjusted: false, series: [] });
    for (const block of [bnd.total!, ...bnd.accounts.map((a) => a.block)]) {
      expect(block.benchmark).toEqual({ twr: null, twrAnnualized: null, xirrAnnualized: null, shadowValueCents: null, excessTwr: null, startPrice: null, endPrice: null, reason: "no_benchmark_price" });
      expect(block.readable).toContain("No benchmark price on or before 2025-10-13.");
    }
    const selected = (await get<PerformanceView>(`/api/investments/performance?today=${TODAY}&period=1y&accountIds=${R}`)).view;
    expect(selected.accounts.map((a) => a.accountId)).toEqual([R]);
    expect(selected.total).toMatchObject({ startValueCents: "1500000", endValueCents: "1820000" });
  });

  it("GET /investments/performance (views test 12): a partial 3y period equals the engine's POST for the same range; custom-range validation", async () => {
    const { view } = await get<PerformanceView>(`/api/investments/performance?today=${TODAY}&period=3y`);
    expect(view.period).toMatchObject({ kind: "3y", from: "2023-10-13", to: "2026-10-13", partial: true });
    expect(view.period!.note).toMatch(/^Values begin \d{4}-\d{2}-\d{2}; the period is shorter than requested$/);
    expect(view.warnings).toEqual([view.period!.note]);
    const roth = view.accounts.find((a) => a.accountId === R)!.block;
    expect(roth).toMatchObject({ startValueCents: "0", openingValue: { date: "2025-10-13", cents: "1500000" } });
    expect(roth.flows).toEqual([expect.objectContaining({ date: "2025-10-13", amountCents: "1500000", kind: "opening_value", source: "engine" })]);
    const brokerage = view.accounts.find((a) => a.accountId === B)!.block;
    expect(brokerage.startValueCents).toBe("0");
    expect(brokerage.flows.filter((f) => f.kind === "cash").map((f) => [f.date, f.amountCents])).toEqual([
      ["2024-02-28", "500000"],
      ["2024-06-07", "580000"],
      ["2025-01-14", "575000"],
      ["2026-04-13", "500000"],
    ]);

    // Every figure is the engine's own: the POST with the same from/to/asOf and full detail agrees.
    const post = await A.t.call({ method: "POST", url: "/api/investments/performance", payload: { from: view.period!.from, to: view.period!.to, asOf: view.asOf, today: TODAY, detail: "full" } });
    expect(post.statusCode, post.body).toBe(200);
    const engine = post.json() as PerformanceResponse;
    const figures = (b: ReturnBlockView) => ({
      method: b.method,
      startValueCents: b.startValueCents,
      endValueCents: b.endValueCents,
      openingValue: b.openingValue,
      contributionsCents: b.contributionsCents,
      withdrawalsCents: b.withdrawalsCents,
      netFlowsCents: b.netFlowsCents,
      growthCents: b.growthCents,
      twr: b.twr,
      xirr: b.xirr,
      flows: b.flows,
      warnings: b.warnings,
      // The GET presents an unpriced benchmark as a block with `reason no_benchmark_price` where the engine returns null.
      benchmark:
        b.benchmark === null || b.benchmark.reason === "no_benchmark_price"
          ? null
          : { twr: b.benchmark.twr, twrAnnualized: b.benchmark.twrAnnualized, xirrAnnualized: b.benchmark.xirrAnnualized, shadowValueCents: b.benchmark.shadowValueCents, startPrice: b.benchmark.startPrice, endPrice: b.benchmark.endPrice },
    });
    const engineFigures = (b: PerformanceResponse["accounts"][number] | PerformanceResponse["total"]) => ({
      method: b.method,
      startValueCents: b.startValueCents,
      endValueCents: b.endValueCents,
      openingValue: b.openingValue,
      contributionsCents: b.contributionsCents,
      withdrawalsCents: b.withdrawalsCents,
      netFlowsCents: b.netFlowsCents,
      growthCents: b.growthCents,
      twr: b.twr,
      xirr: b.xirr,
      flows: b.flows,
      warnings: b.warnings,
      benchmark: b.benchmark === null ? null : { twr: b.benchmark.twr.rate, twrAnnualized: b.benchmark.twr.annualized, xirrAnnualized: b.benchmark.xirr.annualized, shadowValueCents: b.benchmark.shadowValueCents, startPrice: b.benchmark.startPrice, endPrice: b.benchmark.endPrice },
    });
    expect(view.accounts.map((a) => a.accountId)).toEqual(engine.accounts.map((a) => a.accountId));
    for (const a of view.accounts) expect(figures(a.block), a.accountName).toEqual(engineFigures(engine.accounts.find((e) => e.accountId === a.accountId)!));
    expect(figures(view.total!)).toEqual(engineFigures(engine.total));
    // VTI has no close on or before 2023-10-13: the engine has no benchmark; the GET names the requested one with an empty series.
    expect(engine.benchmark).toBeNull();
    expect(view.benchmark).toEqual({ securityId: A.S.securities.vti, ticker: "VTI", name: "Vanguard Total Stock Market ETF", adjusted: false, series: [] });
    // The chart series chain the engine's own sub-period rates.
    const chained = (subPeriods: PerformanceResponse["total"]["subPeriods"]) => {
      let cum = 1;
      return [{ date: engine.from, indexBp: 10000 }, ...subPeriods.filter((s) => !s.skipped && s.rate !== null).map((s) => ({ date: s.to, indexBp: Math.round(10000 * (cum *= 1 + s.rate!)) }))];
    };
    expect(view.total!.series).toEqual(chained(engine.total.subPeriods));
    for (const a of view.accounts) expect(a.block.series, a.accountName).toEqual(chained(engine.accounts.find((e) => e.accountId === a.accountId)!.subPeriods));

    const all = (await get<PerformanceView>(`/api/investments/performance?today=${TODAY}&period=all`)).view;
    expect(all.period).toMatchObject({ kind: "all", from: "2024-02-27", to: "2026-10-13", partial: false, note: null });
    for (const url of [
      `/api/investments/performance?today=${TODAY}&period=custom&from=2026-10-13&to=2026-10-12`,
      `/api/investments/performance?today=${TODAY}&period=custom&from=2026-10-01&to=2026-10-15`,
      `/api/investments/performance?today=${TODAY}&period=custom`,
      `/api/investments/performance?today=${TODAY}&asOf=2026-10-15`,
      `/api/investments/performance?today=${TODAY}&accountIds=${C}`,
    ]) {
      const bad = await A.t.call({ method: "GET", url });
      expect(bad.statusCode, url).toBe(400);
    }
  });

  it("GET /investments/income (views test 13): the ytd months, totals, trailing twelve months, yield, rows and the feed block", async () => {
    const { view } = await get<IncomeView>(`/api/investments/income?today=${TODAY}`);
    expect(view).toMatchObject({ today: TODAY, asOf: "2026-10-13", trailing12mCents: "32435", yieldBp: 71, rowsTruncated: false, warnings: [] });
    expect(view.period).toEqual({ kind: "ytd", from: "2025-12-31", to: "2026-10-13", days: 286, partial: false, note: null });
    expect(view.months.map((m) => [m.month, m.dividendsCents, m.interestCents, m.feesCents, m.reinvestedCents, m.totalCents])).toEqual([
      ["2026-03", "8360", "0", "0", "0", "8360"],
      ["2026-06", "4720", "0", "0", "0", "4720"],
      ["2026-08", "2890", "0", "0", "0", "2890"],
      ["2026-09", "13775", "410", "0", "0", "14185"],
      ["2026-10", "2280", "0", "0", "0", "2280"],
    ]);
    expect(view.months[3]!.bySecurity.map((s) => [s.ticker, s.cents])).toEqual([
      ["VTI", "7365"],
      ["VXUS", "4150"],
      ["BND", "2260"],
      [null, "410"],
    ]);
    expect(view.totals).toEqual({ dividendsCents: "32025", interestCents: "410", feesCents: "0", reinvestedCents: "0", totalCents: "32435" });
    expect(view.rows).toHaveLength(11);
    expect(view.rows.find((r) => r.id === A.S.txns["divVtiSep"])).toMatchObject({ date: "2026-09-28", month: "2026-09", accountId: B, ticker: "VTI", kind: "dividend", cents: "4910", reinvested: false, source: "investment_txn", ledgerTransactionId: A.S.ledger["divVtiSep"], linkStatus: "linked", fed: false });
    expect(view.feed.categoryId).toBe(A.S.categories.dividends);
    expect(view.feed.categoryName).toBe("Dividends");
    expect(view.feed.accounts.map((a) => [a.accountName, a.fidelity, a.mode, a.linked, a.created, a.awaiting, a.fed, a.hasLedger, a.suggestedMode])).toEqual([
      ["Fidelity Roth IRA", "positions", "off", 0, 0, 0, 0, false, "create"],
      ["Vanguard Brokerage", "full_history", "link", 7, 0, 0, 0, true, "link"],
    ]);
    const only = (await get<IncomeView>(`/api/investments/income?today=${TODAY}&accountId=${R}&period=1m`)).view;
    expect(only.period).toMatchObject({ kind: "1m", from: "2026-09-13", to: "2026-10-13" });
    expect(only.rows.every((r) => r.accountId === R)).toBe(true);
    expect((await A.t.call({ method: "GET", url: `/api/investments/income?today=${TODAY}&accountId=${C}` })).statusCode).toBe(400);
  });

  it("GET /investments/accounts/:id/changes (views test 10): price and quantity effects sum to the change; validation and 404", async () => {
    const { view: day } = await get<AccountChangesView>(`/api/investments/accounts/${B}/changes?today=${TODAY}&from=2026-10-12&to=2026-10-13`);
    expect(day).toMatchObject({ accountId: B, accountName: "Vanguard Brokerage", fidelity: "full_history", from: "2026-10-12", to: "2026-10-13", residualEffectCents: "0", flows: [], income: [], warnings: [] });
    expect(day.summary).toEqual({ from: "2026-10-12", to: "2026-10-13", startCents: "2673200", endCents: "2705200", changeCents: "32000", changeBp: 119, netFlowsCents: "0", growthCents: "32000", growthReason: null, incomeCents: "0", uncategorizedRows: 0 });
    expect(day.holdings.map((h) => [h.ticker, h.priceEffectCents, h.quantityEffectCents, h.deltaCents])).toEqual([
      ["AAPL", "10000", "0", "10000"],
      ["VTI", "10000", "0", "10000"],
      ["VXUS", "12000", "0", "12000"],
    ]);
    const { view: year } = await get<AccountChangesView>(`/api/investments/accounts/${B}/changes?today=${TODAY}&from=2025-10-13&to=2026-10-13`);
    expect(year.summary).toMatchObject({ startCents: "2000000", endCents: "2705200", changeCents: "705200", netFlowsCents: "500000", growthCents: "205200", incomeCents: "23200", uncategorizedRows: 1 });
    expect(year.flows).toEqual([expect.objectContaining({ date: "2026-04-13", amountCents: "500000", kind: "cash", source: "ledger", counterpartyAccountId: C, counterpartyAccountName: "Checking", internal: false, internalReason: null })]);
    expect(year.income).toHaveLength(7);
    expect(year.holdings.find((h) => h.ticker === "VTI")).toMatchObject({ quantityFrom: "20", priceFrom: "260", valueFromCents: "520000", quantityTo: "40", priceTo: "312.5", valueToCents: "1250000", priceEffectCents: "105000", quantityEffectCents: "625000" });
    const delta = year.holdings.reduce((acc, h) => acc + BigInt(h.deltaCents), 0n) + BigInt(year.residualEffectCents);
    expect(delta).toBe(705200n);
    for (const url of [
      `/api/investments/accounts/${B}/changes?today=${TODAY}&from=2026-10-13&to=2026-10-12`,
      `/api/investments/accounts/${B}/changes?today=${TODAY}&from=2020-10-13&to=2026-10-13`,
      `/api/investments/accounts/${B}/changes?today=${TODAY}&from=2026-10-12&to=2026-10-15`,
    ]) {
      const bad = await A.t.call({ method: "GET", url });
      expect(bad.statusCode, url).toBe(400);
      expect(bad.json()).toMatchObject({ code: "validation" });
    }
    expect((await A.t.call({ method: "GET", url: `/api/investments/accounts/${randomUUID()}/changes?today=${TODAY}&from=2026-10-12&to=2026-10-13` })).statusCode).toBe(404);
  });

  it("GET /accounts carries the derived investment block (plan decision 7) and the Phase 3 settings; GET /auth/status carries the role", async () => {
    const accounts = (await A.t.call({ method: "GET", url: "/api/accounts" })).json() as AccountView[];
    const byId = new Map(accounts.map((a) => [a.id, a]));
    expect(byId.get(B)).toMatchObject({
      lotMethod: "fifo",
      cashInference: "auto",
      investmentIncomeFeed: "link",
      investment: { fidelity: "full_history", fidelityNote: null, positionsMatch: true, lastSnapshotDate: "2026-10-13", lastSnapshotSource: "simplefin", lastTradeDate: "2026-04-14", securityCount: 3, needsReviewCount: 0, lastReconciliation: null },
    });
    expect(byId.get(R)).toMatchObject({
      investmentIncomeFeed: "off",
      investment: { fidelity: "positions", fidelityNote: null, positionsMatch: null, lastSnapshotDate: "2026-10-09", lastSnapshotSource: "csv", lastTradeDate: null, securityCount: 4, needsReviewCount: 0, lastReconciliation: null },
    });
    expect(byId.get(C)).toMatchObject({ lotMethod: "fifo", cashInference: "auto", investmentIncomeFeed: "off", investment: null });

    expect((await A.t.call({ method: "GET", url: "/api/auth/status" })).json() as AuthStatus).toMatchObject({ authenticated: true, role: "owner" });
    expect((await A.t.app.inject({ method: "GET", url: "/api/auth/status", cookies: await viewerCookies(A.t) })).json() as AuthStatus).toMatchObject({ authenticated: true, role: "viewer" });
  });

  it("viewer matrix (views test 18): every GET 200 with the owner's JSON, every mutation 403 viewer; the reads write nothing", async () => {
    const cookies = await viewerCookies(A.t);
    const before = await tableCounts();
    const reads = [
      `/api/investments/portfolio?today=${TODAY}&period=1y`,
      `/api/investments/allocation?today=${TODAY}`,
      `/api/investments/holdings?today=${TODAY}`,
      `/api/investments/performance?today=${TODAY}&period=1y`,
      `/api/investments/income?today=${TODAY}`,
      `/api/investments/accounts/${B}/changes?today=${TODAY}&from=2026-10-12&to=2026-10-13`,
      `/api/valuation/summary?today=${TODAY}&asOf=2026-10-13`,
      `/api/valuation/series?today=${TODAY}&from=2026-10-09&to=2026-10-13`,
      "/api/prices/status",
      `/api/reconcile/history?accountId=${B}`,
      "/api/accounts",
      "/api/settings",
      `/api/dashboard?today=${TODAY}`,
    ];
    for (const url of reads) {
      const owner = await A.t.call({ method: "GET", url });
      const viewer = await A.t.app.inject({ method: "GET", url, cookies });
      expect(owner.statusCode, url).toBe(200);
      expect(viewer.statusCode, url).toBe(200);
      expect(viewer.body, url).toBe(owner.body);
      if (!url.startsWith("/api/accounts") && !url.startsWith("/api/settings")) expect(owner.headers["cache-control"], url).toBe("no-store");
    }
    expect(await tableCounts()).toEqual(before);

    const mutations: InjectOptions[] = [
      { method: "PUT", url: `/api/investments/securities/${A.S.securities.vti}/allocation`, payload: { assetClass: "us_stock", splits: null } },
      { method: "POST", url: "/api/reconcile/commit", payload: { accountId: B, date: "2026-10-13", rows: [], statementTotalCents: "2705200" } },
      { method: "DELETE", url: `/api/reconcile/${randomUUID()}` },
      { method: "POST", url: "/api/investments/income/feed/run", payload: {} },
      { method: "PATCH", url: `/api/accounts/${R}`, payload: { investmentIncomeFeed: "create" } },
      { method: "PATCH", url: `/api/accounts/${B}`, payload: { lotMethod: "specific" } },
      { method: "PATCH", url: "/api/settings", payload: { rebalanceBandBp: 300 } },
      { method: "POST", url: `/api/connections/${A.S.connections.vanguard}/reprocess-holdings` },
      { method: "POST", url: "/api/prices/refresh", payload: {} },
      { method: "PUT", url: `/api/prices/${A.S.securities.vti}/2026-10-09`, payload: { close: "310.02" } },
      { method: "DELETE", url: `/api/prices/${A.S.securities.vti}/2026-10-12` },
    ];
    for (const req of mutations) {
      const res = await A.t.app.inject({ ...req, cookies });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(403);
      expect(res.json()).toMatchObject({ code: "viewer" });
    }
    expect(await tableCounts()).toEqual(before);
  });

  it("POST /connections/:id/reprocess-holdings queues the replay job once per SimpleFIN connection", async () => {
    const res = await A.t.call({ method: "POST", url: `/api/connections/${A.S.connections.vanguard}/reprocess-holdings` });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as JobView;
    expect(view).toMatchObject({ type: "simplefin.reprocess_holdings", status: "queued", payload: { connectionId: A.S.connections.vanguard } });
    const again = (await A.t.call({ method: "POST", url: `/api/connections/${A.S.connections.vanguard}/reprocess-holdings` })).json() as JobView;
    expect(again.id).toBe(view.id);
    const csv = await A.t.call({ method: "POST", url: `/api/connections/${A.S.connections.fidelity}/reprocess-holdings` });
    expect(csv.statusCode).toBe(400);
    expect(csv.json()).toMatchObject({ code: "not_simplefin" });
    expect((await A.t.call({ method: "POST", url: `/api/connections/${randomUUID()}/reprocess-holdings` })).statusCode).toBe(404);
    await A.t.db.db.delete(job).where(eq(job.id, view.id));
  });

  it("the owner's feed run and the account feed setting (views tests 13–14 at the route): categorized 7, then create mode for the Roth, with their error codes", async () => {
    const run = await A.t.call({ method: "POST", url: "/api/investments/income/feed/run", payload: {} });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json() as RunIncomeFeedResponse).toEqual({ categorized: 7, created: 0, upgraded: 0, awaiting: 0, unchanged: 0, deleted: 0 });
    expect((await A.t.call({ method: "POST", url: "/api/investments/income/feed/run", payload: { accountId: B } })).json()).toMatchObject({ categorized: 0, unchanged: 7 });
    const fed = (await get<IncomeView>(`/api/investments/income?today=${TODAY}`)).view;
    expect(fed.rows.filter((r) => r.accountId === B).every((r) => r.fed)).toBe(true);

    const auditsBefore = (await A.t.db.db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.entity, "account"), eq(auditLog.entityId, R))))[0]!.n;
    const create = await A.t.call({ method: "PATCH", url: `/api/accounts/${R}`, payload: { investmentIncomeFeed: "create" } });
    expect(create.statusCode, create.body).toBe(200);
    expect(create.json() as AccountView).toMatchObject({ id: R, investmentIncomeFeed: "create", investment: { fidelity: "positions" } });
    expect((await A.t.db.db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.entity, "account"), eq(auditLog.entityId, R))))[0]!.n).toBe(auditsBefore + 1);
    const synthetic = await A.t.db.db.select().from(transaction).where(and(eq(transaction.accountId, R), eq(transaction.source, "investment")));
    expect(synthetic).toHaveLength(4);
    expect(synthetic.every((t) => t.categoryId === A.S.categories.dividends)).toBe(true);
    expect((await A.t.db.db.select().from(job).where(eq(job.type, "investments.income_feed"))).length).toBeGreaterThanOrEqual(1);
    const off = await A.t.call({ method: "PATCH", url: `/api/accounts/${R}`, payload: { investmentIncomeFeed: "off" } });
    expect(off.statusCode).toBe(200);
    expect((await A.t.db.db.select().from(transaction).where(and(eq(transaction.accountId, R), eq(transaction.source, "investment")))).length).toBe(0);

    const codeOf = async (url: string, payload: Record<string, unknown>) => {
      const res = await A.t.call({ method: "PATCH", url, payload });
      expect(res.statusCode, `${url} ${JSON.stringify(payload)}: ${res.body}`).toBe(400);
      return (res.json() as { code: string }).code;
    };
    expect(await codeOf(`/api/accounts/${C}`, { investmentIncomeFeed: "link" })).toBe("not_investment_account");
    expect(await codeOf(`/api/accounts/${C}`, { lotMethod: "specific" })).toBe("not_investment_account");
    expect(await codeOf(`/api/accounts/${C}`, { cashInference: "off" })).toBe("not_investment_account");
    // Without a household feed category nothing can be enabled, and the run reports it.
    expect((await A.t.call({ method: "PATCH", url: "/api/settings", payload: { investmentIncomeCategoryId: null } })).statusCode).toBe(200);
    expect(await codeOf(`/api/accounts/${R}`, { investmentIncomeFeed: "link" })).toBe("feed_category_required");
    const blocked = await A.t.call({ method: "POST", url: "/api/investments/income/feed/run", payload: {} });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json()).toMatchObject({ code: "feed_category_required" });
    expect((await A.t.call({ method: "PATCH", url: "/api/settings", payload: { investmentIncomeCategoryId: A.S.categories.dividends } })).statusCode).toBe(200);
  });

  it("PATCH /accounts/:id lot method and cash inference: audited as account, the lots rebuilt and the valuation re-queued", async () => {
    const before = await tableCounts();
    const res = await A.t.call({ method: "PATCH", url: `/api/accounts/${B}`, payload: { lotMethod: "specific", cashInference: "off" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json() as AccountView).toMatchObject({ id: B, lotMethod: "specific", cashInference: "off", investment: { fidelity: "full_history", positionsMatch: true } });
    const audits = await A.t.db.db.select().from(auditLog).where(and(eq(auditLog.entity, "account"), eq(auditLog.entityId, B)));
    expect(audits).toEqual([expect.objectContaining({ action: "update", before: { lotMethod: "fifo", cashInference: "auto" }, after: { lotMethod: "specific", cashInference: "off" } })]);
    const valuation = await A.t.db.db.select().from(job).where(and(eq(job.type, "investments.valuation"), eq(job.status, "queued")));
    expect(valuation).toEqual([expect.objectContaining({ payload: { reason: "setting", accountId: B, dedupeKey: `investments.valuation:${B}` } })]);
    expect((await tableCounts())["lot"]).toBe(before["lot"]);
    // The plug is off: B's value on 10-13 drops by the 143 200 "Cash (from balance)" line.
    const offPortfolio = (await get<PortfolioView>(`/api/investments/portfolio?today=${TODAY}&period=1m`)).view;
    expect(offPortfolio.accounts.find((a) => a.accountId === B)).toMatchObject({ valueCents: "2562000", residualCents: "0" });
    // An identical re-patch writes no second audit row; restoring the defaults writes one.
    expect((await A.t.call({ method: "PATCH", url: `/api/accounts/${B}`, payload: { lotMethod: "specific", cashInference: "off" } })).statusCode).toBe(200);
    expect((await A.t.db.db.select().from(auditLog).where(and(eq(auditLog.entity, "account"), eq(auditLog.entityId, B)))).length).toBe(1);
    expect((await A.t.call({ method: "PATCH", url: `/api/accounts/${B}`, payload: { lotMethod: "fifo", cashInference: "auto" } })).json() as AccountView).toMatchObject({ lotMethod: "fifo", cashInference: "auto" });
    expect((await A.t.db.db.select().from(auditLog).where(and(eq(auditLog.entity, "account"), eq(auditLog.entityId, B)))).length).toBe(2);
    expect((await get<PortfolioView>(`/api/investments/portfolio?today=${TODAY}&period=1m`)).view.accounts.find((a) => a.accountId === B)).toMatchObject({ valueCents: "2705200" });
    await A.t.db.db.delete(job).where(eq(job.type, "investments.valuation"));
  });

  it("PATCH /settings: the four investment settings with their validation (benchmark, income bucket, band, minimum trade)", async () => {
    const current = (await A.t.call({ method: "GET", url: "/api/settings" })).json() as HouseholdSettingView;
    expect(current).toMatchObject({ benchmarkSecurityId: A.S.securities.vti, investmentIncomeCategoryId: A.S.categories.dividends, rebalanceBandBp: 500, rebalanceMinTradeCents: "10000" });

    const codeOf = async (payload: Record<string, unknown>) => {
      const res = await A.t.call({ method: "PATCH", url: "/api/settings", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      return (res.json() as { code: string }).code;
    };
    expect(await codeOf({ benchmarkSecurityId: A.S.securities.cash })).toBe("validation");
    expect(await codeOf({ benchmarkSecurityId: randomUUID() })).toBe("validation");
    const groceries = (await A.t.call({ method: "POST", url: "/api/categories", payload: { name: "Groceries", bucket: "spending" } })).json() as CategoryView;
    expect(await codeOf({ investmentIncomeCategoryId: groceries.id })).toBe("not_income_category");
    expect(await codeOf({ investmentIncomeCategoryId: randomUUID() })).toBe("validation");
    expect(await codeOf({ rebalanceBandBp: 6000 })).toBe("validation");
    expect(await codeOf({ rebalanceMinTradeCents: "-1" })).toBe("validation");

    const updated = await A.t.call({ method: "PATCH", url: "/api/settings", payload: { benchmarkSecurityId: A.S.securities.bnd, rebalanceBandBp: 300, rebalanceMinTradeCents: "5000" } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json() as HouseholdSettingView).toMatchObject({ benchmarkSecurityId: A.S.securities.bnd, investmentIncomeCategoryId: A.S.categories.dividends, rebalanceBandBp: 300, rebalanceMinTradeCents: "5000" });
    const allocation = (await get<AllocationView>(`/api/investments/allocation?today=${TODAY}`)).view;
    expect(allocation.rebalance).toMatchObject({ bandBp: 300, minTradeCents: "5000" });
    const performance = (await get<PerformanceView>(`/api/investments/performance?today=${TODAY}&period=1y`)).view;
    expect(performance.benchmark?.ticker).toBe("BND");
    const cleared = (await A.t.call({ method: "PATCH", url: "/api/settings", payload: { benchmarkSecurityId: null } })).json() as HouseholdSettingView;
    expect(cleared.benchmarkSecurityId).toBeNull();
    expect((await get<PerformanceView>(`/api/investments/performance?today=${TODAY}&period=1y`)).view.benchmark).toBeNull();
    const restored = (await A.t.call({ method: "PATCH", url: "/api/settings", payload: { benchmarkSecurityId: A.S.securities.vti, rebalanceBandBp: 500, rebalanceMinTradeCents: "10000" } })).json() as HouseholdSettingView;
    expect(restored).toMatchObject({ benchmarkSecurityId: A.S.securities.vti, rebalanceBandBp: 500, rebalanceMinTradeCents: "10000" });
  });
});
