import { describe, expect, it } from "vitest";
import {
  ByBucket,
  FanSeries,
  MortalityTableId,
  NEVER_DEPLETED,
  PRICE_LEVEL_DECIMALS,
  PRICE_LEVEL_ONE,
  PriceLevel,
  SERIES_ENCODING,
  SimRunSeriesKind,
  SimSummary,
  YearRow,
  YearTable,
} from "./results.js";
import { exampleFanSeries, exampleSimSummary, exampleYearRow, exampleYearTable, forbiddenValuePaths } from "./testFixtures.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("SimSummary (strategies-outputs-web §4.2, seams C11, C40, C46)", () => {
  it("OUT-10 (schema side): the example parses unchanged and holds no non-integer number and no null", () => {
    const summary = exampleSimSummary();
    expect(SimSummary.parse(summary)).toEqual(summary);
    expect(forbiddenValuePaths(summary)).toEqual([]);
  });

  it("decision 15: what may be missing is absent, never null", () => {
    // A historical run with no failure: no interval, no depletion year, no shortfall.
    const { successCi95Bp: _ci, shortfallRealP50OfFailures: _shortfall, ...rest } = exampleSimSummary();
    const historical = {
      ...rest,
      successPaths: 69,
      fullPlanPaths: 69,
      paths: 69,
      failure: { paths: 0, byYear: [0, 0] },
      model: { kind: "historical", requestedPaths: 10_000, cohortMode: "complete", cohortCount: 69, firstStartYear: 1928, lastStartYear: 1996 },
    };
    expect(SimSummary.parse(historical)).toEqual(historical);
    expect(ok(SimSummary, { ...exampleSimSummary(), successCi95Bp: null })).toBe(false);
    expect(ok(SimSummary, { ...exampleSimSummary(), shortfallRealP50OfFailures: null })).toBe(false);
    expect(ok(SimSummary, { ...historical, failure: { paths: 0, firstDepletionYear: null, byYear: [] } })).toBe(false);
  });

  it("C46: the failure block names depletion years", () => {
    expect(exampleSimSummary().failure).toEqual({ paths: 2, firstDepletionYear: 2028, medianDepletionYear: 2028, byYear: [0, 0, 1, 1] });
    expect(ok(SimSummary, { ...exampleSimSummary(), failure: { paths: 2, firstYear: 2028, byYear: [] } })).toBe(false);
  });

  it("C11: the data checksum and the digest are in the summary", () => {
    expect(ok(SimSummary, { ...exampleSimSummary(), dataChecksum: "abc" })).toBe(false);
    const { digest: _digest, ...noDigest } = exampleSimSummary();
    expect(ok(SimSummary, noDigest)).toBe(false);
    for (const digest of ["1A2B3C4D", "1a2b3c4", "1a2b3c4d5"]) expect(ok(SimSummary, { ...exampleSimSummary(), digest }), digest).toBe(false);
  });

  it("enumerations and integers", () => {
    const s = exampleSimSummary();
    expect(ok(SimSummary, { ...s, model: { ...s.model, kind: "monte_carlo" } })).toBe(false);
    expect(ok(SimSummary, { ...s, model: { ...s.model, cohortMode: "auto" } })).toBe(false);
    expect(ok(SimSummary, { ...s, model: { ...s.model, meanBlockYears: 10.5 } })).toBe(false);
    expect(ok(SimSummary, { ...s, model: { ...s.model, preset: "optimistic" } })).toBe(false);
    expect(ok(SimSummary, { ...s, mortalityTable: "ssa" })).toBe(false);
    expect(ok(SimSummary, { ...s, strategy: "bucket" })).toBe(false);
    expect(ok(SimSummary, { ...s, firstYearFractionPpm: 250000.5 })).toBe(false);
    expect(ok(SimSummary, { ...s, successCi95Bp: [4902.1, 9433] })).toBe(false);
    expect(ok(SimSummary, { ...s, extra: 1 })).toBe(false);
    expect(MortalityTableId.options).toEqual(["fixed", "ssa_period", "irs_2010cm_fallback"]);
  });
});

describe("FanSeries", () => {
  it("OUT-3's funded shares in a fan: the example parses unchanged; strict; no float", () => {
    const fan = exampleFanSeries();
    expect(FanSeries.parse(fan)).toEqual(fan);
    expect(forbiddenValuePaths(fan)).toEqual([]);
    expect(ok(FanSeries, { ...fan, extra: 1 })).toBe(false);
    expect(ok(FanSeries, { ...fan, real: { ...fan.real, p95: [] } })).toBe(false);
    expect(ok(FanSeries, { ...fan, fundedBp: [10000, 7500.5] })).toBe(false);
    expect(ok(FanSeries, { ...fan, real: { ...fan.real, p50: ["100", null] } })).toBe(false);
  });
});

describe("YearRow and YearTable (seams C37, C43, C45)", () => {
  it("the example row parses unchanged and holds no float and no null", () => {
    const row = exampleYearRow();
    expect(YearRow.parse(row)).toEqual(row);
    expect(forbiddenValuePaths(row)).toEqual([]);
    // Derivation of the example (illustrative household): (1,000,000.00 − 40,000.00) × 1.05 = 1,008,000.00;
    // today's dollars 100,800,000 cents × 10^9 ÷ 1,025,000,000 = 98,341,463.41 → 98,341,463 (half away from zero).
    expect((100_800_000n * 1_000_000_000n) / 1_025_000_000n).toBe(98_341_463n);
    // Growth is the roll-forward plug: 100,800,000 − (100,000,000 − 4,000,000) = 4,800,000.
    expect(BigInt(row.ending.total) - (100_000_000n - BigInt(row.withdrawals.total))).toBe(BigInt(row.growth));
  });

  it("C43: price levels are nine-decimal fixed-point strings", () => {
    expect(PRICE_LEVEL_DECIMALS).toBe(9);
    expect(ok(PriceLevel, PRICE_LEVEL_ONE)).toBe(true);
    for (const level of ["1.025000000", "0.987654321", "13780.612339822"]) expect(ok(PriceLevel, level), level).toBe(true);
    for (const level of ["1", "1.025", "1.0250000000", "-1.000000000", "1e3", "1.025000000 ", ""]) expect(ok(PriceLevel, level), level).toBe(false);
    expect(ok(YearRow, { ...exampleYearRow(), cpiEnd: 1.025 })).toBe(false);
    expect(ok(YearRow, { ...exampleYearRow(), cpiEnd: "1.025" })).toBe(false);
  });

  it("C45: bucket sums are keyed by the members of PlanBucket", () => {
    const sums = { taxable: "0", pre_tax: "0", roth: "0", hsa: "0", cash: "0" };
    expect(ByBucket.parse(sums)).toEqual(sums);
    expect(ok(ByBucket, { taxable: "0", preTax: "0", roth: "0", hsa: "0", cash: "0" })).toBe(false);
    const { hsa: _hsa, ...four } = sums;
    expect(ok(ByBucket, four)).toBe(false);
  });

  it("C37: the tax block is the tax area's TaxYearDetail; benefits carry their parts", () => {
    const row = exampleYearRow();
    const oldTaxBlock = { total: "0", ordinary: "0", capitalGains: "0", niit: "0", penalties: "0", taxableSocialSecurity: "0", agi: "0", deduction: "0", taxableIncome: "0" };
    expect(ok(YearRow, { ...row, tax: oldTaxBlock })).toBe(false);
    expect(ok(YearRow, { ...row, tax: { ...row.tax, payrollTaxCents: "306000" } })).toBe(true);
    expect(ok(YearRow, { ...row, income: { ...row.income, socialSecurityParts: [{ spousal: "0", survivor: "0" }] } })).toBe(false);
    expect(ok(YearRow, { ...row, income: { ...row.income, socialSecurityParts: [{ spousal: "0", survivor: "0", withheld: "120000" }] } })).toBe(true);
    const { socialSecurityParts: _parts, ...incomeWithout } = row.income;
    expect(ok(YearRow, { ...row, income: incomeWithout })).toBe(false);
  });

  it("strict; enumerations; integers", () => {
    const row = exampleYearRow();
    expect(ok(YearRow, { ...row, extra: 1 })).toBe(false);
    expect(ok(YearRow, { ...row, spending: { ...row.spending, travel: "0" } })).toBe(false);
    expect(ok(YearRow, { ...row, phase: "drawdown" })).toBe(false);
    expect(ok(YearRow, { ...row, strategy: { ...row.strategy, events: ["skip"] } })).toBe(false);
    expect(ok(YearRow, { ...row, strategy: { ...row.strategy, events: ["freeze", "cut", "raise", "band_floor", "band_ceiling", "cap", "essentials", "topped_up", "rmd_excess"] } })).toBe(true);
    expect(ok(YearRow, { ...row, inflationBp: 250.5 })).toBe(false);
    expect(ok(YearRow, { ...row, spending: { ...row.spending, ruleGross: "4000000" } })).toBe(true);
  });

  it("the example table parses unchanged; strict", () => {
    const table = exampleYearTable();
    expect(YearTable.parse(table)).toEqual(table);
    expect(forbiddenValuePaths(table)).toEqual([]);
    expect(YearTable.parse({ ...table, historicalStartYear: 1966 }).historicalStartYear).toBe(1966);
    expect(ok(YearTable, { ...table, accounts: [{ ...table.accounts[0], bucket: "preTax" }] })).toBe(false);
    expect(ok(YearTable, { ...table, accounts: [{ ...table.accounts[0], type: "roth" }] })).toBe(false);
    expect(ok(YearTable, { ...table, schemaVersion: 2 })).toBe(false);
  });
});

describe("per-path series (inputs §2.4, seams F9)", () => {
  it("four kinds with their encodings; −1 is a path that never ran out", () => {
    expect(SimRunSeriesKind.options).toEqual(["ending_real_cents", "depletion_year", "lifetime_tax_real_cents", "lifetime_spending_real_cents"]);
    expect(SERIES_ENCODING).toEqual({ ending_real_cents: "i64le", depletion_year: "i16le", lifetime_tax_real_cents: "i64le", lifetime_spending_real_cents: "i64le" });
    expect(NEVER_DEPLETED).toBe(-1);
  });
});
