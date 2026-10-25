import { describe, expect, it } from "vitest";
import type { IsoDate } from "./dates.js";
import { parseFixed8 } from "./decimal.js";
import type { InvestmentTxnType } from "./enums.js";
import { buildLots, type InvestmentTxnInput } from "./lots.js";
import {
  annualize,
  benchmarkOf,
  computePerformance,
  modifiedDietz,
  priceLookup,
  securitiesFlows,
  statementCheck,
  trueTwr,
  valueFullAccount,
  xirr,
  xirrFigure,
  type BenchmarkSeriesInput,
  type ExternalFlowInput,
  type FullAccountValuationInput,
  type PerformanceAccountInput,
  type PerformanceInput,
  type PriceSeriesPoint,
  type PriceSeriesInput,
  type SubPeriod,
} from "./performance.js";

/**
 * The lots design's performance cases (§7: TC11–TC17, TC19, TC21, TC23–TC25, TC32–TC33)
 * re-derived under the Phase 3 plan's names: `fidelity` for `history`, `transferGroupId` for
 * `pairId` on securities rows, flows carrying `accountId` and `source` (seams C36), price points
 * carrying the row's `source` (C29). Rates are asserted with |Δ| ≤ 1e−9 unless a case says
 * otherwise (D31); cents and quantities exactly. The design's figures come from its BigInt
 * reference run; where a figure is re-derived here the derivation is in a comment.
 */

const f = parseFixed8;
const near = (actual: number | null, expected: number, tol = 1e-9) => {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(tol);
};

function txn(o: Partial<InvestmentTxnInput> & { id: string; type: InvestmentTxnType; date: IsoDate; accountId: string }): InvestmentTxnInput {
  return {
    securityId: null,
    sequence: 0,
    quantity: null,
    price: null,
    amountCents: null,
    feeCents: null,
    splitNum: null,
    splitDen: null,
    costBasisCents: null,
    acquiredDate: null,
    transferGroupId: null,
    counterpartyAccountId: null,
    ...o,
  };
}
const buy = (acct: string, id: string, date: IsoDate, sec: string, qty: string, price: string, amount: bigint) =>
  txn({ accountId: acct, id, type: "buy", date, securityId: sec, quantity: f(qty), price: f(price), amountCents: amount, feeCents: 0n });
const sell = (acct: string, id: string, date: IsoDate, sec: string, qty: string, price: string, amount: bigint) =>
  txn({ accountId: acct, id, type: "sell", date, securityId: sec, quantity: -f(qty), price: f(price), amountCents: amount, feeCents: 0n });
const dividend = (acct: string, id: string, date: IsoDate, sec: string | null, amount: bigint) => txn({ accountId: acct, id, type: "dividend", date, securityId: sec, amountCents: amount });
const transferIn = (acct: string, id: string, date: IsoDate, sec: string, qty: string, o: { costBasisCents?: bigint; price?: string; groupId?: string; counterparty?: string } = {}) =>
  txn({
    accountId: acct,
    id,
    type: "transfer",
    date,
    securityId: sec,
    quantity: f(qty),
    amountCents: 0n,
    costBasisCents: o.costBasisCents ?? null,
    price: o.price === undefined ? null : f(o.price),
    transferGroupId: o.groupId ?? null,
    counterpartyAccountId: o.counterparty ?? null,
  });
const transferOut = (acct: string, id: string, date: IsoDate, sec: string, qty: string, price?: string) =>
  txn({ accountId: acct, id, type: "transfer", date, securityId: sec, quantity: -f(qty), amountCents: 0n, price: price === undefined ? null : f(price) });

const pts = (rows: ReadonlyArray<[IsoDate, string]>): PriceSeriesPoint[] => rows.map(([date, close]) => ({ date, close: f(close), source: "provider" }));
const series = (securityId: string, rows: ReadonlyArray<[IsoDate, string]>): PriceSeriesInput => ({ securityId, points: pts(rows) });
const bench = (rows: ReadonlyArray<[IsoDate, string]>, adjusted = false): BenchmarkSeriesInput => ({ securityId: "BENCH", points: pts(rows), adjusted });
const cash = (accountId: string, date: IsoDate, cents: bigint, o: { counterparty?: string; pairId?: string; sourceId?: string } = {}): ExternalFlowInput => ({
  date,
  amountCents: cents,
  kind: "cash",
  source: "ledger",
  accountId,
  counterpartyAccountId: o.counterparty ?? null,
  pairId: o.pairId ?? null,
  sourceId: o.sourceId ?? null,
});

function account(o: Partial<PerformanceAccountInput> & { accountId: string }): PerformanceAccountInput {
  return {
    name: o.accountId,
    type: "brokerage",
    taxTreatment: "taxable",
    fidelity: "full_history",
    lotMethod: "fifo",
    txns: [],
    lotPicks: [],
    cashFlows: [],
    cashAnchors: [],
    valuations: [],
    latestHoldingSnapshot: null,
    ...o,
  };
}

/** The full-account valuation input the engine builds for itself, exposed for the direct valuation cases. */
function fullInput(acct: PerformanceAccountInput, prices: readonly PriceSeriesInput[]): FullAccountValuationInput {
  return {
    accountId: acct.accountId,
    lots: buildLots({ accountId: acct.accountId, lotMethod: acct.lotMethod, txns: acct.txns, lotPicks: acct.lotPicks }),
    priceOn: priceLookup(prices, acct.txns),
    cashFlows: acct.cashFlows,
    cashAnchors: acct.cashAnchors,
  };
}

const perf = (o: Partial<PerformanceInput> & { from: IsoDate; to: IsoDate; accounts: PerformanceAccountInput[] }) =>
  computePerformance({ asOf: o.to, prices: [], benchmark: null, ...o });

const spCents = (s: SubPeriod) => [s.from, s.to, s.beginValueCents, s.flowCents, s.endValueCents, s.skipped];

// ---- Fixtures shared by TC14, TC17, TC24 ----

/** TC14: account A, full, funded at inception. */
const A = account({
  accountId: "A",
  txns: [buy("A", "b1", "2026-01-02", "VTI", "100", "10", -100000n), buy("A", "b2", "2026-02-01", "VTI", "50", "12", -60000n)],
  cashFlows: [cash("A", "2026-01-02", 100000n), cash("A", "2026-02-01", 60000n)],
});
const VTI_14 = series("VTI", [
  ["2026-01-02", "10"],
  ["2026-01-31", "12"],
  ["2026-02-01", "12"],
  ["2026-02-28", "11"],
]);
const BENCH_14 = bench([
  ["2026-01-01", "100"],
  ["2026-01-02", "100"],
  ["2026-01-31", "110"],
  ["2026-02-01", "110"],
  ["2026-02-28", "105"],
]);

describe("TC11. XIRR, Microsoft's documented example", () => {
  it("brackets [0.3, 0.5] and bisects to Excel's figure", () => {
    const r = xirr([
      { date: "2008-01-01", amountCents: -1000000n },
      { date: "2008-03-01", amountCents: 275000n },
      { date: "2008-10-30", amountCents: 425000n },
      { date: "2009-02-15", amountCents: 325000n },
      { date: "2009-04-01", amountCents: 275000n },
    ]);
    expect(Math.abs(r.rate! - 0.373362535)).toBeLessThan(1e-7); // Excel publishes 0.373362535; the design's run gives 0.373362533
    near(r.rate, 0.373362533);
    expect(r.bracket).toEqual([0.3, 0.5]);
    expect(r.warnings).toEqual([]);
    expect(r.reason).toBeNull();
    expect(r.iterations).toBe(31); // 0.2 / 2^31 ≤ 1e−10 < 0.2 / 2^30
  });
});

describe("TC12. XIRR arithmetic identities", () => {
  it("doubling in exactly one year is a grid hit at r = 1 with 0 iterations", () => {
    const r = xirr([
      { date: "2025-10-14", amountCents: -10000000n },
      { date: "2026-10-14", amountCents: 20000000n },
    ]);
    expect(r.rate).toBe(1);
    expect(r.iterations).toBe(0);
  });
  it("doubling over 730 days is √2 − 1", () => {
    const r = xirr([
      { date: "2024-10-14", amountCents: -10000000n },
      { date: "2026-10-14", amountCents: 20000000n },
    ]);
    near(r.rate, Math.SQRT2 - 1);
    near(r.rate, 0.414213562);
  });
  it("a mid-year contribution at t = 182/365", () => {
    const r = xirr([
      { date: "2025-10-14", amountCents: -10000000n },
      { date: "2026-04-14", amountCents: -5000000n },
      { date: "2026-10-14", amountCents: 20000000n },
    ]);
    near(r.rate, 0.4067006591, 2e-9); // the design's 0.406700659 at 9 places
  });
  it("10 % over 181 days: annualized 0.211912980 and period exactly 0.1 back", () => {
    const fig = xirrFigure("2026-01-01", "2026-07-01", 10000000n, [], 11000000n);
    near(fig.annualized, 0.21191298);
    expect(fig.investedDays).toBe(181);
    near(fig.period, 0.1);
  });
  it("halving in one year is exactly −0.5 (grid hit)", () => {
    const r = xirr([
      { date: "2025-10-14", amountCents: -10000000n },
      { date: "2026-10-14", amountCents: 5000000n },
    ]);
    expect(r.rate).toBe(-0.5);
    expect(r.iterations).toBe(0);
  });
});

describe("TC13. XIRR failure modes and multiple roots", () => {
  it("one-way money is no_sign_change; a single flow is too_few_flows; a total loss is no_bracket", () => {
    expect(
      xirr([
        { date: "2026-01-01", amountCents: -10000000n },
        { date: "2026-07-01", amountCents: -500000n },
        { date: "2026-12-31", amountCents: 0n },
      ]),
    ).toMatchObject({ rate: null, reason: "no_sign_change" });
    expect(xirr([{ date: "2026-01-01", amountCents: -10000000n }])).toMatchObject({ rate: null, reason: "too_few_flows" });
    expect(
      xirr([
        { date: "2025-10-14", amountCents: -10000000n },
        { date: "2026-10-14", amountCents: 1n },
      ]),
    ).toMatchObject({ rate: null, reason: "no_bracket" });
  });
  it("two brackets: the one nearest 10 % is solved and multiple_roots is reported", () => {
    const r = xirr([
      { date: "2025-01-01", amountCents: -10000000n },
      { date: "2025-07-01", amountCents: 23000000n },
      { date: "2026-01-01", amountCents: -13200000n },
    ]);
    expect(r.bracket).toEqual([0.15, 0.2]);
    near(r.rate, 0.17796456);
    expect(r.warnings).toEqual(["multiple_roots"]);
  });
});

describe("TC14. True TWR, XIRR and benchmark for a full account funded at inception", () => {
  const input = { from: "2026-01-01", to: "2026-02-28", accounts: [A], prices: [VTI_14], benchmark: BENCH_14 };
  it("values the account by priced lots and tracked cash", () => {
    const v = fullInput(A, [VTI_14]);
    const at = (d: IsoDate) => valueFullAccount(v, d);
    expect(at("2026-01-01")).toMatchObject({ valueCents: 0n, cashAnchor: null });
    expect(at("2026-01-02")).toMatchObject({ valueCents: 100000n, securitiesCents: 100000n, cashCents: 0n });
    expect(at("2026-01-31").valueCents).toBe(120000n);
    expect(at("2026-02-01")).toMatchObject({ valueCents: 180000n, cashCents: 0n });
    expect(at("2026-02-28").valueCents).toBe(165000n);
    expect(at("2026-01-20").warnings).toEqual([{ code: "stale_price", securityId: "VTI", date: "2026-01-20", priceDate: "2026-01-02" }]); // 18 days
    expect(at("2026-01-31").warnings).toEqual([]);
  });
  it("chains two sub-periods to 0.1 and reports the investor's flows", () => {
    const r = perf(input);
    const a = r.accounts[0]!;
    expect(a).toMatchObject({ method: "true_twr", startValueCents: 0n, endValueCents: 165000n, openingValue: null, contributionsCents: 160000n, withdrawalsCents: 0n, netFlowsCents: 160000n, growthCents: 5000n });
    expect(a.subPeriods.map(spCents)).toEqual([
      ["2026-01-01", "2026-01-31", 0n, 100000n, 120000n, false],
      ["2026-01-31", "2026-02-28", 120000n, 60000n, 165000n, false],
    ]);
    near(a.subPeriods[0]!.rate, 0.2, 1e-12);
    near(a.subPeriods[1]!.rate, -0.0833333333333, 1e-12);
    near(a.twr.rate, 0.1, 1e-12);
    expect(a.twr.annualized).toBeNull();
    expect(r.days).toBe(58);
    expect(a.xirr.investorFlows).toEqual([
      { date: "2026-01-01", amountCents: 0n },
      { date: "2026-01-02", amountCents: -100000n },
      { date: "2026-02-01", amountCents: -60000n },
      { date: "2026-02-28", amountCents: 165000n },
    ]);
    near(a.xirr.annualized, 0.277776955);
    expect(a.xirr.investedDays).toBe(57);
    near(a.xirr.period, 0.039021388);
    expect(a.flows.map((x) => [x.date, x.amountCents, x.kind, x.internal])).toEqual([
      ["2026-01-02", 100000n, "cash", false],
      ["2026-02-01", 60000n, "cash", false],
    ]);
    expect(a.warnings).toEqual([]);
    // A single-account total is the account.
    expect(r.total).toMatchObject({ method: "true_twr", partialGains: false, excludedInternalFlows: 0, contributionsCents: 160000n, growthCents: 5000n });
    near(r.total.twr.rate, 0.1, 1e-12);
    near(r.total.xirr.annualized, 0.277776955);
  });
  it("shadows the benchmark with one leg per flow", () => {
    const b = perf(input).accounts[0]!.benchmark!;
    expect(b.legs).toEqual([
      { date: "2026-01-01", cents: 0n, price: f("100"), priceDate: "2026-01-01", units: 0n },
      { date: "2026-01-02", cents: 100000n, price: f("100"), priceDate: "2026-01-02", units: f("10") },
      { date: "2026-02-01", cents: 60000n, price: f("110"), priceDate: "2026-02-01", units: f("5.45454545") },
    ]);
    expect(b.legs.reduce((acc, l) => acc + l.units, 0n)).toBe(f("15.45454545"));
    expect(b.shadowValueCents).toBe(162273n); // 15.45454545 × 105 = 1622.7272722…
    expect(b).toMatchObject({ securityId: "BENCH", adjusted: false, startPrice: f("100"), endPrice: f("105") });
    near(b.twr.rate, 0.05, 1e-12);
    expect(b.twr.annualized).toBeNull();
    near(b.xirr.annualized, 0.119029889);
    near(b.xirr.period, 0.01771771);
  });
  it("from 01-31: one sub-period, a 28-day money-weighted figure and a benchmark bought at 110", () => {
    const r = perf({ ...input, from: "2026-01-31" });
    const a = r.accounts[0]!;
    expect(a.subPeriods).toHaveLength(1);
    near(a.twr.rate, -0.0833333333333, 1e-12);
    near(a.xirr.annualized, -0.682708917);
    expect(a.xirr.investedDays).toBe(28);
    near(a.xirr.period, -0.084294818);
    const b = a.benchmark!;
    expect(b.legs.map((l) => l.units)).toEqual([f("10.90909091"), f("5.45454545")]);
    expect(b.shadowValueCents).toBe(171818n);
    near(b.twr.rate, -0.0454545454545, 1e-12);
    near(b.xirr.annualized, -0.458680728);
  });
});

describe("TC15. a flow dated `from` is excluded; a flow dated `to` is counted with its boundary at to − 1", () => {
  const P = account({
    accountId: "P",
    txns: [buy("P", "b1", "2026-01-10", "P", "10", "100", -100000n)],
    cashFlows: [cash("P", "2026-01-10", 100000n), cash("P", "2026-01-31", 50000n), cash("P", "2026-02-28", 10000n)],
  });
  const prices = [
    series("P", [
      ["2026-01-10", "100"],
      ["2026-02-27", "110"],
      ["2026-02-28", "120"],
    ]),
  ];
  it("puts the 01-31 contribution inside the start value", () => {
    const v = fullInput(P, prices);
    expect(valueFullAccount(v, "2026-01-31").valueCents).toBe(150000n);
    expect(valueFullAccount(v, "2026-02-27").valueCents).toBe(160000n);
    expect(valueFullAccount(v, "2026-02-28").valueCents).toBe(180000n);
    const a = perf({ from: "2026-01-31", to: "2026-02-28", accounts: [P], prices }).accounts[0]!;
    expect(a.subPeriods.map(spCents)).toEqual([
      ["2026-01-31", "2026-02-27", 150000n, 0n, 160000n, false],
      ["2026-02-27", "2026-02-28", 160000n, 10000n, 180000n, false],
    ]);
    near(a.subPeriods[0]!.rate, 0.0666666666667, 1e-12);
    near(a.subPeriods[1]!.rate, 0.0588235294118, 1e-12);
    near(a.twr.rate, 0.129411765);
    expect(a.flows.map((x) => [x.date, x.amountCents])).toEqual([["2026-02-28", 10000n]]);
    near(a.xirr.annualized, 4.112001296);
    expect(a.xirr.investedDays).toBe(28);
    near(a.xirr.period, 0.133333333);
  });
  it("cash only: two sub-periods of exactly 0", () => {
    const C = account({ accountId: "C", cashFlows: [cash("C", "2026-01-31", 999999n), cash("C", "2026-02-28", 10000n)] });
    const a = perf({ from: "2026-01-31", to: "2026-02-28", accounts: [C] }).accounts[0]!;
    expect(a.subPeriods.map((s) => s.rate)).toEqual([0, 0]);
    expect(a.twr.rate).toBe(0);
    expect(a.startValueCents).toBe(999999n);
    expect(a.endValueCents).toBe(1009999n);
  });
});

describe("TC16. Modified Dietz for a balance-only account, carried starts and the opening value", () => {
  const valuations = [
    { date: "2026-01-31", valueCents: 100000n },
    { date: "2026-02-28", valueCents: 130000n },
    { date: "2026-03-31", valueCents: 105000n },
  ];
  const C = account({ accountId: "C", type: "401k", taxTreatment: "pre_tax", fidelity: "balance_only", valuations, cashFlows: [cash("C", "2026-02-10", 20000n), cash("C", "2026-03-31", -30000n)] });
  it("weights the 02-10 flow 19/28 (direct helper and the account block agree)", () => {
    const d = modifiedDietz("2026-01-31", "2026-02-28", C.cashFlows, valuations);
    expect(d.subPeriods).toHaveLength(1);
    near(d.subPeriods[0]!.weightedFlowDollars, 135.714285714);
    near(d.rate, 0.088050314);
    expect(d.annualized).toBeNull();
    const a = perf({ from: "2026-01-31", to: "2026-02-28", accounts: [C] }).accounts[0]!;
    expect(a.method).toBe("modified_dietz");
    near(a.twr.rate, 0.088050314);
    expect(a.twr.annualized).toBeNull();
    expect(a.subPeriods[0]).toMatchObject({ beginCarried: false, endCarried: false });
    expect(a.holdings).toEqual([]);
    expect(a.lots).toEqual([]);
    expect(a.gains).toBeNull();
    expect(a.realized).toBeNull();
  });
  it("chains two sub-periods to 03-31 with a withdrawal on the boundary at weight 1/31", () => {
    const r = perf({ from: "2026-01-31", to: "2026-03-31", accounts: [C] });
    const a = r.accounts[0]!;
    near(a.subPeriods[0]!.rate, 0.088050314);
    near(a.subPeriods[1]!.rate, 0.03875);
    near(a.subPeriods[1]!.weightedFlowDollars, -9.677419355);
    near(a.twr.rate, 0.130212264);
    expect(r.days).toBe(59);
    expect(a.xirr.investorFlows).toEqual([
      { date: "2026-01-31", amountCents: -100000n },
      { date: "2026-02-10", amountCents: -20000n },
      { date: "2026-03-31", amountCents: 30000n },
      { date: "2026-03-31", amountCents: 105000n },
    ]);
    near(a.xirr.annualized, 1.116267732);
    near(a.xirr.period, 0.128824644);
    expect(a).toMatchObject({ startValueCents: 100000n, endValueCents: 105000n, contributionsCents: 20000n, withdrawalsCents: 30000n, netFlowsCents: -10000n, growthCents: 15000n });
  });
  it("carries the start from 01-31 to 02-05 and says so", () => {
    const a = perf({ from: "2026-02-05", to: "2026-02-28", accounts: [C] }).accounts[0]!;
    near(a.subPeriods[0]!.weightedFlowDollars, 165.217391304);
    near(a.twr.rate, 0.085820896);
    expect(a.subPeriods[0]!.beginCarried).toBe(true);
    expect(a.warnings).toEqual([{ code: "valuation_carried", date: "2026-02-05", accountId: "C" }]);
  });
  it("from 01-01: an opening value on 01-31 with a computed (not skipped) first sub-period", () => {
    const r = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [C] });
    const a = r.accounts[0]!;
    expect(a.openingValue).toEqual({ date: "2026-01-31", cents: 100000n });
    expect(a.flows.map((x) => [x.date, x.amountCents, x.kind, x.source, x.internal])).toEqual([
      ["2026-01-31", 100000n, "opening_value", "engine", false],
      ["2026-02-10", 20000n, "cash", "ledger", false],
    ]);
    expect(a.subPeriods.map(spCents)).toEqual([
      ["2026-01-01", "2026-01-31", 0n, 100000n, 100000n, false],
      ["2026-01-31", "2026-02-28", 100000n, 20000n, 130000n, false],
    ]);
    near(a.subPeriods[0]!.weightedFlowDollars, 33.333333333);
    expect(a.subPeriods[0]!.rate).toBe(0);
    near(a.subPeriods[1]!.weightedFlowDollars, 135.714285714);
    near(a.twr.rate, 0.088050314);
    expect(a).toMatchObject({ startValueCents: 0n, endValueCents: 130000n, contributionsCents: 20000n, growthCents: 10000n });
    expect(a.xirr.investorFlows).toEqual([
      { date: "2026-01-01", amountCents: 0n },
      { date: "2026-01-31", amountCents: -100000n },
      { date: "2026-02-10", amountCents: -20000n },
      { date: "2026-02-28", amountCents: 130000n },
    ]);
    near(a.xirr.annualized, 2.030024781);
    expect(a.xirr.investedDays).toBe(28);
    near(a.xirr.period, 0.088761757);
    expect(a.warnings).toEqual([]);
    expect(r.total.openingValue).toEqual({ date: "2026-01-31", cents: 100000n });
  });
  it("a ledger transfer before the first valuation is folded into the opening value", () => {
    const folded = account({ ...C, cashFlows: [cash("C", "2026-01-15", 5000n, { sourceId: "l1" }), ...C.cashFlows] });
    const base = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [C] }).accounts[0]!;
    const a = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [folded] }).accounts[0]!;
    expect(a.flows.find((x) => x.sourceId === "l1")).toMatchObject({ internal: true, internalReason: "before_first_valuation" });
    expect(a.warnings).toEqual([{ code: "flow_before_first_valuation", accountId: "C", date: "2026-01-15", detail: "5000 cents folded into the opening value of 2026-01-31" }]);
    for (const key of ["twr", "subPeriods", "startValueCents", "endValueCents", "contributionsCents", "growthCents", "openingValue"] as const) {
      expect(a[key]).toEqual(base[key]);
    }
    expect(a.xirr.annualized).toBe(base.xirr.annualized);
  });
  it("no valuation on or before `to` → no_valuations everywhere", () => {
    const r = perf({ from: "2026-01-01", to: "2026-01-20", accounts: [C] });
    const a = r.accounts[0]!;
    expect(a.twr).toEqual({ rate: null, annualized: null, reason: "no_valuations", reasonDate: "2026-01-20" });
    expect(a.xirr).toMatchObject({ annualized: null, period: null, reason: "no_valuations" });
    expect(a.warnings).toEqual([{ code: "no_valuations", date: "2026-01-20", accountId: "C" }]);
    expect(r.total.twr.reason).toBe("no_valuations");
  });
});

describe("TC17. household total: a transfer between two full accounts is internal to the total", () => {
  const A17 = account({
    accountId: "A",
    txns: [buy("A", "a1", "2026-01-02", "VTI", "100", "10", -100000n), sell("A", "a2", "2026-02-01", "VTI", "50", "12", 60000n)],
    cashFlows: [cash("A", "2026-01-02", 100000n, { sourceId: "x1" }), cash("A", "2026-02-01", -50000n, { counterparty: "B", pairId: "p1", sourceId: "a-out" })],
  });
  const B17 = account({
    accountId: "B",
    type: "ira",
    taxTreatment: "pre_tax",
    txns: [buy("B", "b1", "2026-02-02", "VXUS", "10", "50", -50000n)],
    cashFlows: [cash("B", "2026-02-01", 50000n, { counterparty: "A", pairId: "p1", sourceId: "b-in" })],
  });
  const prices = [
    series("VTI", [
      ["2026-01-02", "10"],
      ["2026-01-31", "12"],
      ["2026-02-01", "12"],
      ["2026-02-28", "13"],
    ]),
    series("VXUS", [
      ["2026-02-02", "50"],
      ["2026-02-28", "55"],
    ]),
  ];
  const r = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [A17, B17], prices });
  it("values and returns each account on its own flows", () => {
    const a = r.accounts[0]!;
    const vA = fullInput(A17, prices);
    expect(valueFullAccount(vA, "2026-01-31").valueCents).toBe(120000n);
    expect(valueFullAccount(vA, "2026-02-01")).toMatchObject({ valueCents: 70000n, cashCents: 10000n });
    expect(valueFullAccount(vA, "2026-02-28").valueCents).toBe(75000n);
    near(a.subPeriods[0]!.rate, 0.2, 1e-12);
    near(a.subPeriods[1]!.rate, 0.0714285714286, 1e-12);
    near(a.twr.rate, 0.285714286);
    near(a.xirr.annualized, 4.926841465);
    near(a.xirr.period, 0.320345154);
    expect(a.xirr.investedDays).toBe(57);
    const b = r.accounts[1]!;
    const vB = fullInput(B17, prices);
    expect(valueFullAccount(vB, "2026-02-01").valueCents).toBe(50000n);
    expect(valueFullAccount(vB, "2026-02-28").valueCents).toBe(55000n);
    expect(b.subPeriods.map(spCents)).toEqual([
      ["2026-01-01", "2026-01-31", 0n, 0n, 0n, true],
      ["2026-01-31", "2026-02-28", 0n, 50000n, 55000n, false],
    ]);
    near(b.twr.rate, 0.1, 1e-12);
    near(b.xirr.annualized, 2.627168915);
    expect(b.xirr.investedDays).toBe(27);
    near(b.xirr.period, 0.1);
    // Each account's own flow list is unaware of the total.
    expect(a.flows.every((x) => !x.internal)).toBe(true);
    expect(b.flows.every((x) => !x.internal)).toBe(true);
  });
  it("drops both legs of the pair from the total and chains one sub-period to 0.3", () => {
    const t = r.total;
    expect(t.flows.map((x) => [x.accountId, x.date, x.amountCents, x.internal, x.internalReason])).toEqual([
      ["A", "2026-01-02", 100000n, false, null],
      ["A", "2026-02-01", -50000n, true, "counterparty_in_total"],
      ["B", "2026-02-01", 50000n, true, "counterparty_in_total"],
    ]);
    expect(t.excludedInternalFlows).toBe(2);
    expect(t.subPeriods.map(spCents)).toEqual([["2026-01-01", "2026-02-28", 0n, 100000n, 130000n, false]]);
    near(t.twr.rate, 0.3, 1e-12);
    expect(t.method).toBe("true_twr");
    near(t.xirr.annualized, 4.365834284);
    near(t.xirr.period, 0.3);
    expect(t).toMatchObject({ contributionsCents: 100000n, withdrawalsCents: 0n, partialGains: false, startValueCents: 0n, endValueCents: 130000n, growthCents: 30000n, accountIds: ["A", "B"] });
    expect(t.gains).toMatchObject({ realizedShortCents: 10000n, unrealizedCents: 20000n, openValueCents: 120000n }); // A: sold 50 @ 12 vs 10 → 10000; open 50 VTI (65000 − 50000) + 10 VXUS (55000 − 50000)
  });
});

describe("TC19. empty stretch before the first contribution is skipped; value without a flow is an error", () => {
  it("(a) skips 01-01 → 02-28 and computes the rest", () => {
    const X = account({ accountId: "X", txns: [buy("X", "b1", "2026-03-01", "VTI", "100", "10", -100000n)], cashFlows: [cash("X", "2026-03-01", 100000n)] });
    const r = perf({
      from: "2026-01-01",
      to: "2026-03-31",
      accounts: [X],
      prices: [
        series("VTI", [
          ["2026-03-01", "10"],
          ["2026-03-31", "10.5"],
        ]),
      ],
    });
    const a = r.accounts[0]!;
    expect(a.subPeriods.map(spCents)).toEqual([
      ["2026-01-01", "2026-02-28", 0n, 0n, 0n, true],
      ["2026-02-28", "2026-03-31", 0n, 100000n, 105000n, false],
    ]);
    expect(a.subPeriods[0]!.rate).toBeNull();
    near(a.twr.rate, 0.05, 1e-12);
    expect(r.days).toBe(89);
    expect(a.subPeriods.filter((s) => s.skipped)).toHaveLength(1);
    near(a.xirr.annualized, Math.pow(1.05, 365 / 30) - 1);
    near(a.xirr.annualized, 0.810519216);
    expect(a.xirr.investedDays).toBe(30);
    near(a.xirr.period, 0.05);
  });
  it("(b) a value appearing without a flow is zero_denominator at the sub-period's start", () => {
    const t = trueTwr("2026-01-01", "2026-02-28", [], (d) => (d < "2026-02-01" ? 0n : 5000n));
    expect(t).toMatchObject({ rate: null, annualized: null, reason: "zero_denominator", reasonDate: "2026-01-01" });
    expect(t.subPeriods).toHaveLength(1);
  });
});

describe("TC21. price fallback chain and staleness in valuation", () => {
  const CT = account({ accountId: "CT", txns: [buy("CT", "b1", "2026-01-15", "CT1", "10", "25.5", -25500n)], cashFlows: [cash("CT", "2026-01-15", 25500n)] });
  it("(a) no series: the transaction price, flagged, and stale after 26 days", () => {
    const v = valueFullAccount(fullInput(CT, []), "2026-02-10");
    expect(v.valueCents).toBe(25500n);
    expect(v.warnings).toEqual([
      { code: "price_from_txn", securityId: "CT1", date: "2026-02-10" },
      { code: "stale_price", securityId: "CT1", date: "2026-02-10", priceDate: "2026-01-15" },
    ]);
  });
  it("(b) a close 9 days old is used and flagged stale; (c) a later close is never used", () => {
    const b = valueFullAccount(
      fullInput(CT, [
        series("CT1", [
          ["2026-02-01", "26"],
          ["2026-02-11", "27"],
        ]),
      ]),
      "2026-02-10",
    );
    expect(b.valueCents).toBe(26000n);
    expect(b.warnings).toEqual([{ code: "stale_price", securityId: "CT1", date: "2026-02-10", priceDate: "2026-02-01" }]);
    const c = valueFullAccount(fullInput(CT, [series("CT1", [["2026-02-11", "27"]])]), "2026-02-10");
    expect(c.valueCents).toBe(25500n);
    expect(c.warnings.map((w) => w.code)).toEqual(["price_from_txn", "stale_price"]);
  });
  it("(d) before the first transaction the account is empty; an unpriced security is 0 with no_price", () => {
    expect(valueFullAccount(fullInput(CT, []), "2026-01-01")).toMatchObject({ valueCents: 0n, warnings: [] });
    const NP = account({ accountId: "NP", txns: [...CT.txns, transferIn("NP", "t1", "2026-01-15", "NP1", "5", { costBasisCents: 1000n })], cashFlows: CT.cashFlows });
    const v = valueFullAccount(fullInput(NP, []), "2026-01-16");
    expect(v.valueCents).toBe(25500n);
    // Securities are valued in id order, so CT1's warning precedes NP1's.
    expect(v.warnings).toEqual([
      { code: "price_from_txn", securityId: "CT1", date: "2026-01-16" },
      { code: "no_price", securityId: "NP1", date: "2026-01-16" },
    ]);
  });
  it("staleness boundary: 7 days is current, 8 is stale", () => {
    const S = account({ accountId: "S", txns: [buy("S", "b1", "2026-01-02", "Q", "1", "10", -1000n)] });
    const v = fullInput(S, [series("Q", [["2026-01-02", "10"]])]);
    expect(valueFullAccount(v, "2026-01-09").warnings).toEqual([]);
    expect(valueFullAccount(v, "2026-01-10").warnings).toEqual([{ code: "stale_price", securityId: "Q", date: "2026-01-10", priceDate: "2026-01-02" }]);
  });
});

describe("TC23. securities transfer valued at market on its date; unpriced → 0", () => {
  const closes = [
    series("VXUS", [
      ["2026-01-30", "60.5"],
      ["2026-02-02", "61"],
      ["2026-04-01", "63"],
    ]),
  ];
  it("carries the 01-30 close forward and never looks ahead to 02-02", () => {
    const t1 = transferIn("T", "t1", "2026-02-01", "VXUS", "40", { costBasisCents: 200000n, groupId: "g1", counterparty: "Z" });
    const r = securitiesFlows({ accountId: "T", txns: [t1] }, priceLookup(closes, [t1]));
    expect(r.flows).toEqual([{ date: "2026-02-01", amountCents: 242000n, kind: "securities", source: "investment_txn", accountId: "T", counterpartyAccountId: "Z", pairId: "g1", sourceId: "t1" }]);
    expect(r.warnings).toEqual([]);
  });
  it("prefers the row's own price, and values 0 with a warning when nothing prices it", () => {
    const priced = transferIn("T", "t1", "2026-02-01", "VXUS", "40", { price: "59" });
    expect(securitiesFlows({ accountId: "T", txns: [priced] }, priceLookup(closes, [priced])).flows[0]!.amountCents).toBe(236000n);
    const bare = transferIn("T", "t1", "2026-02-01", "VXUS", "40");
    const none = securitiesFlows({ accountId: "T", txns: [bare] }, priceLookup([], [bare]));
    expect(none.flows[0]!.amountCents).toBe(0n);
    expect(none.warnings).toEqual([{ code: "securities_flow_unpriced", txnId: "t1", securityId: "VXUS", date: "2026-02-01", quantity: f("40") }]);
  });
  it("a transfer out is a negative flow at the close of its date", () => {
    const out = transferOut("T", "t2", "2026-04-01", "VXUS", "40");
    expect(securitiesFlows({ accountId: "T", txns: [out] }, priceLookup(closes, [out])).flows[0]).toMatchObject({ date: "2026-04-01", amountCents: -252000n, kind: "securities" });
  });
  it("an unpriced in-kind position is valued 0 (no_price) so the sub-period with only it is skipped", () => {
    const bare = transferIn("T", "t1", "2026-02-01", "VXUS", "40", { costBasisCents: 200000n });
    const T = account({ accountId: "T", txns: [bare] });
    const r = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [T] });
    const a = r.accounts[0]!;
    expect(a.flows).toEqual([{ date: "2026-02-01", amountCents: 0n, kind: "securities", source: "investment_txn", accountId: "T", counterpartyAccountId: null, pairId: null, sourceId: "t1", internal: false, internalReason: null }]);
    expect(a.subPeriods.map((s) => s.skipped)).toEqual([true, true]);
    expect(a.twr.reason).toBe("no_valuations");
    expect(a.warnings.map((w) => w.code)).toEqual(["securities_flow_unpriced", "no_price", "no_valuations"]);
    expect(a.gains).toMatchObject({ openValueCents: 0n, unrealizedCents: 0n, unpricedSecurityIds: ["VXUS"] });
  });
});

describe("TC24. mixed household total: a full account plus a balance-only account entering after `from`", () => {
  const C = account({
    accountId: "C",
    type: "401k",
    taxTreatment: "pre_tax",
    fidelity: "balance_only",
    valuations: [
      { date: "2026-01-31", valueCents: 100000n },
      { date: "2026-02-28", valueCents: 130000n },
    ],
    cashFlows: [cash("C", "2026-02-10", 20000n)],
  });
  const r = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [A, C], prices: [VTI_14] });
  it("gives C an opening value and the same block as TC16's last case", () => {
    const c = r.accounts[1]!;
    expect(c.openingValue).toEqual({ date: "2026-01-31", cents: 100000n });
    near(c.twr.rate, 0.088050314);
    near(c.xirr.annualized, 2.030024781);
    expect(c.growthCents).toBe(10000n);
  });
  it("chains Modified Dietz over 01-01, 01-31, 02-28 for the total", () => {
    const t = r.total;
    expect(t.method).toBe("modified_dietz");
    expect(t.subPeriods.map(spCents)).toEqual([
      ["2026-01-01", "2026-01-31", 0n, 200000n, 220000n, false],
      ["2026-01-31", "2026-02-28", 220000n, 80000n, 295000n, false],
    ]);
    near(t.subPeriods[0]!.weightedFlowDollars, 1033.333333333);
    near(t.subPeriods[0]!.rate, 0.193548387);
    near(t.subPeriods[1]!.weightedFlowDollars, 735.714285714);
    near(t.subPeriods[1]!.rate, -0.01703163);
    near(t.twr.rate, 0.173220312);
    near(t.xirr.annualized, 0.660047882);
    expect(t.xirr.investedDays).toBe(57);
    near(t.xirr.period, 0.08236814);
    expect(t).toMatchObject({ openingValue: { date: "2026-01-31", cents: 100000n }, contributionsCents: 180000n, withdrawalsCents: 0n, partialGains: true, excludedInternalFlows: 0, startValueCents: 0n, endValueCents: 295000n });
    expect(t.growthCents).toBe(295000n - 180000n - 100000n);
    expect(t.subPeriods.every((s) => !s.beginCarried && !s.endCarried)).toBe(true);
  });
  it("A's Dietz over the same boundaries equals its true TWR", () => {
    const d = modifiedDietz("2026-01-01", "2026-02-28", A.cashFlows, [
      { date: "2026-01-01", valueCents: 0n },
      { date: "2026-01-31", valueCents: 120000n },
      { date: "2026-02-28", valueCents: 165000n },
    ]);
    near(d.rate, 0.1, 1e-12);
    expect(d.warnings).toEqual([]);
  });
});

describe("TC25. annualization rule", () => {
  it("annualizes at 365 days and above only", () => {
    expect(annualize(0.1, 365)).toBe(0.1);
    near(annualize(0.21, 730), 0.1, 1e-12);
    near(annualize(0.1, 366), 0.099713586);
    expect(annualize(0.1, 364)).toBeNull();
  });
  it("a 59-day XIRR stays annual by definition while its TWR is not annualized", () => {
    const C = account({
      accountId: "C",
      fidelity: "balance_only",
      valuations: [
        { date: "2026-01-31", valueCents: 100000n },
        { date: "2026-03-31", valueCents: 105000n },
      ],
    });
    const a = perf({ from: "2026-01-31", to: "2026-03-31", accounts: [C] }).accounts[0]!;
    expect(a.twr.annualized).toBeNull();
    expect(a.xirr.annualized).not.toBeNull();
    near(a.xirr.period, 0.05);
  });
});

describe("TC32. anchored cash and the statement check", () => {
  const V = account({
    accountId: "V",
    txns: [buy("V", "b1", "2026-01-02", "VTI", "100", "10", -100000n), dividend("V", "d1", "2026-01-20", "VTI", 500n)],
    cashFlows: [cash("V", "2026-01-02", 100000n)],
    cashAnchors: [
      { date: "2026-01-31", balanceCents: 105750n },
      { date: "2026-01-10", balanceCents: 101200n },
    ],
  });
  const prices = [
    series("VTI", [
      ["2026-01-02", "10"],
      ["2026-01-10", "10.1"],
      ["2026-01-31", "10.5"],
    ]),
  ];
  const v = fullInput(V, prices);
  it("re-anchors cash on each reported balance and rolls it forward between them", () => {
    expect(valueFullAccount(v, "2026-01-01")).toMatchObject({ valueCents: 0n, cashAnchor: null });
    expect(valueFullAccount(v, "2026-01-05")).toMatchObject({ valueCents: 100000n, cashAnchor: null });
    expect(valueFullAccount(v, "2026-01-10")).toMatchObject({ valueCents: 101200n, securitiesCents: 101000n, cashCents: 200n, cashAnchor: "2026-01-10" });
    const jan20 = valueFullAccount(v, "2026-01-20");
    expect(jan20).toMatchObject({ valueCents: 101700n, securitiesCents: 101000n, cashCents: 700n, cashAnchor: "2026-01-10" });
    expect(jan20.warnings).toEqual([{ code: "stale_price", securityId: "VTI", date: "2026-01-20", priceDate: "2026-01-10" }]);
    expect(valueFullAccount(v, "2026-01-30").valueCents).toBe(101700n);
    expect(valueFullAccount(v, "2026-01-31")).toMatchObject({ valueCents: 105750n, securitiesCents: 105000n, cashCents: 750n, cashAnchor: "2026-01-31" });
    const unanchored = { ...v, cashAnchors: [] };
    expect(valueFullAccount(unanchored, "2026-01-20").valueCents).toBe(101500n);
    expect(valueFullAccount(unanchored, "2026-01-31").valueCents).toBe(105500n);
  });
  it("returns one sub-period of 5.75 % and the matching money-weighted figure", () => {
    const r = perf({ from: "2026-01-01", to: "2026-01-31", accounts: [V], prices });
    const a = r.accounts[0]!;
    expect(a.subPeriods.map(spCents)).toEqual([["2026-01-01", "2026-01-31", 0n, 100000n, 105750n, false]]);
    near(a.twr.rate, 0.0575, 1e-12);
    near(a.xirr.annualized, 1.021146698);
    expect(a.xirr.investedDays).toBe(29);
    near(a.xirr.period, 0.0575);
    expect(a.holdings.find((h) => h.securityId === null)).toMatchObject({ valueCents: 750n, quantity: f("7.5"), priceSource: "cash", costBasisCents: null });
    expect(a.holdings.find((h) => h.securityId === "VTI")).toMatchObject({ quantity: f("100"), valueCents: 105000n, costBasisCents: 100000n, unrealizedCents: 5000n });
    expect(a.endValueCents).toBe(105750n);
    expect(a.statementCheck).toEqual({ date: "2026-01-31", statementCents: 105750n, securitiesCents: 105000n, impliedCashCents: 750n, trackedCashCents: 700n, trackedFrom: "2026-01-10", differenceCents: 50n });
    expect(a.warnings).toEqual([]);
  });
  it("the check at 01-10 finds 200 cents the ledger did not see", () => {
    expect(statementCheck(v, "2026-01-10")).toEqual({ date: "2026-01-10", statementCents: 101200n, securitiesCents: 101000n, impliedCashCents: 200n, trackedCashCents: 0n, trackedFrom: "inception", differenceCents: 200n });
    expect(statementCheck(v, "2026-01-11")).toBeNull();
    const a = perf({ from: "2026-01-01", to: "2026-01-15", accounts: [V], prices }).accounts[0]!;
    expect(a.statementCheck?.date).toBe("2026-01-10");
    expect(a.warnings).toEqual([{ code: "statement_mismatch", accountId: "V", date: "2026-01-10", diffCents: 200n }]);
  });
});

describe("TC33. XIRR with a contribution, a withdrawal and a loss; a withdrawal larger than the start", () => {
  it("(a) a loss brackets below zero", () => {
    const flows = [cash("W", "2026-03-01", 200000n), cash("W", "2026-09-01", -300000n)];
    const fig = xirrFigure("2026-01-01", "2026-12-31", 1000000n, flows, 850000n);
    expect(fig.investorFlows.map((x) => x.amountCents)).toEqual([-1000000n, -200000n, 300000n, 850000n]);
    near(fig.annualized, -0.046990268);
    expect(fig.investedDays).toBe(364);
    near(fig.period, -0.046864593);
    expect(xirr(fig.investorFlows).bracket).toEqual([-0.1, 0]);
  });
  it("(b) a withdrawal larger than the start is a valid positive IRR with one root", () => {
    const fig = xirrFigure("2026-01-01", "2026-12-31", 1000000n, [cash("W", "2026-06-01", -1200000n)], 0n);
    near(fig.annualized, 0.55381166);
    expect(fig.warnings).toEqual([]);
  });
});

describe("determinism and programming errors", () => {
  const C = account({
    accountId: "C",
    fidelity: "balance_only",
    valuations: [
      { date: "2026-01-31", valueCents: 100000n },
      { date: "2026-02-28", valueCents: 130000n },
    ],
    cashFlows: [cash("C", "2026-02-10", 20000n)],
  });
  it("shuffling accounts, flows and transactions changes no number", () => {
    const base = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [A, C], prices: [VTI_14], benchmark: BENCH_14 });
    const shuffled = perf({
      from: "2026-01-01",
      to: "2026-02-28",
      accounts: [{ ...C }, { ...A, txns: [...A.txns].reverse(), cashFlows: [...A.cashFlows].reverse() }],
      prices: [VTI_14],
      benchmark: BENCH_14,
    });
    expect(shuffled.total).toEqual({ ...base.total, accountIds: ["C", "A"] });
    expect(shuffled.accounts.find((a) => a.accountId === "A")).toEqual(base.accounts[0]);
    expect(perf({ from: "2026-01-01", to: "2026-02-28", accounts: [A, C], prices: [VTI_14], benchmark: BENCH_14 })).toEqual(base);
  });
  it("throws on an unsorted price series, a non-positive period and a duplicate account", () => {
    const unsorted: PriceSeriesInput = {
      securityId: "VTI",
      points: pts([
        ["2026-01-31", "12"],
        ["2026-01-02", "10"],
      ]),
    };
    expect(() => perf({ from: "2026-01-01", to: "2026-02-28", accounts: [A], prices: [unsorted] })).toThrow(/ascending/);
    expect(() => priceLookup([unsorted])).toThrow(/ascending/);
    expect(() => perf({ from: "2026-02-28", to: "2026-02-28", accounts: [A] })).toThrow(/after from/);
    expect(() => trueTwr("2026-02-28", "2026-01-01", [], () => 0n)).toThrow(/after from/);
    expect(() => perf({ from: "2026-01-01", to: "2026-02-28", accounts: [A, { ...A }] })).toThrow(/duplicate account/);
  });
  it("a benchmark without a close on or before `from` is null with no_benchmark_price", () => {
    const r = benchmarkOf("2026-01-01", "2026-02-28", 0n, [], bench([["2026-01-02", "100"]]));
    expect(r.benchmark).toBeNull();
    expect(r.warnings).toEqual([{ code: "no_benchmark_price", securityId: "BENCH", date: "2026-01-01" }]);
    const p = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [A], prices: [VTI_14], benchmark: bench([["2026-01-02", "100"]], true) });
    expect(p.benchmark).toBeNull();
    expect(p.accounts[0]!.benchmark).toBeNull();
    expect(p.warnings.map((w) => w.code)).toEqual(["no_benchmark_price", "no_benchmark_price"]);
  });
  it("an empty selection has no method and no valuations", () => {
    const r = perf({ from: "2026-01-01", to: "2026-02-28", accounts: [] });
    expect(r.total).toMatchObject({ method: null, accountIds: [], startValueCents: 0n, endValueCents: 0n, gains: null, realized: null, income: [] });
    expect(r.total.twr.reason).toBe("no_valuations");
  });
});
