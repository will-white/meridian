import { describe, expect, it } from "vitest";
import {
  addUp,
  ByBucket,
  deflateCents,
  deflateYearRow,
  deflateYearTable,
  fundedShareBp,
  parsePriceLevel,
  successBp,
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
import { exampleFanSeries, exampleSimSummary, exampleYearRow, exampleYearTable, forbiddenValuePaths, zeroTaxDetail } from "./testFixtures.js";

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

describe("OUT-2 success rounding and OUT-3 fundedShareBp (strategies-outputs-web §3.9, §3.10, seams C44)", () => {
  it("OUT-2 64 of 69 → 9275; 65 of 69 → 9420 (truncated)", () => {
    // 640000 / 69 = 9275.36…, 650000 / 69 = 9420.28…: truncation toward zero.
    expect(successBp(64, 69)).toBe(9275);
    expect(successBp(65, 69)).toBe(9420);
    expect(successBp(0, 10)).toBe(0);
    expect(successBp(10, 10)).toBe(10000);
    // 2 of 3 = 6666.67: truncation, never rounding up.
    expect(successBp(2, 3)).toBe(6666);
    expect(() => successBp(11, 10)).toThrow(RangeError);
    expect(() => successBp(1, 0)).toThrow(RangeError);
  });

  it("OUT-3 4 paths, first failures in plan years 3 and 5 → 10000, 10000, 10000, 7500, 7500, 5000", () => {
    expect(fundedShareBp(4, [0, 0, 0, 1, 0, 1])).toEqual([10000, 10000, 10000, 7500, 7500, 5000]);
  });

  it("fundedShareBp truncates, handles no years, and refuses impossible counts", () => {
    // (3 − 1) × 10000 / 3 = 6666.67 → 6666.
    expect(fundedShareBp(3, [1, 0, 2])).toEqual([6666, 6666, 0]);
    expect(fundedShareBp(10, [])).toEqual([]);
    expect(() => fundedShareBp(2, [1, 2])).toThrow(RangeError);
    expect(() => fundedShareBp(2, [-1])).toThrow(RangeError);
    expect(() => fundedShareBp(0, [0])).toThrow(RangeError);
  });
});

describe("OUT-6 addUp (strategies-outputs-web §3.11 item 5)", () => {
  it("OUT-6 (187355006, [3678820, 90412771, 93263414]) → [3678820, 90412771, 93263415]", () => {
    // The parts sum to 187355005; the missing cent goes to the largest part (the Roth account).
    expect(addUp(187355006n, [3678820n, 90412771n, 93263414n])).toEqual([3678820n, 90412771n, 93263415n]);
  });

  it("OUT-6 equal parts [9346, 9346, 9346] against 28037 → [9345, 9346, 9346]", () => {
    expect(addUp(28037n, [9346n, 9346n, 9346n])).toEqual([9345n, 9346n, 9346n]);
  });

  it("OUT-6 parts that already sum are returned unchanged (as a new array)", () => {
    const parts = [100n, 200n, 300n];
    const out = addUp(600n, parts);
    expect(out).toEqual(parts);
    expect(out).not.toBe(parts);
    expect(addUp(0n, [])).toEqual([]);
  });

  it("the largest absolute value takes the difference, negatives included; a part never changes sign", () => {
    expect(addUp(-5n, [-3n, -1n])).toEqual([-4n, -1n]);
    expect(addUp(2n, [5n, -4n])).toEqual([6n, -4n]);
    // Four parts of 0.5 rounded up to 1 each against a total of 2: the largest (first) part would
    // become −1, so it stops at 0 and the next takes the rest.
    expect(addUp(2n, [1n, 1n, 1n, 1n])).toEqual([0n, 0n, 1n, 1n]);
    expect(() => addUp(1n, [])).toThrow(RangeError);
  });
});

/**
 * R1's last row (2047) as `toYearTable` would write it, from the regenerated sheet
 * packages/retirement/reference/sheets/r1.md (tables r1.income, r1.withdrawals, r1.tax and
 * r1.ending). The strategies design's OUT-7 figure (totalReal 1,115,486.01) is superseded by the
 * regeneration (seams C50, sheet §6); the row's own figure is now 1,114,680.94. The withdrawal and
 * RMD by account carry addUp's cent: 40,408.00 + 16,948.76 = 57,356.76 against the total
 * 57,356.77, so pre-tax A shows 40,408.01. `magiIrmaaCents` is AGI (no tax-exempt interest in R1).
 * Price levels: cpi[20] = 1.6386164402903942 and cpi[21] = 1.679581851297654 written with nine
 * decimals, half away from zero.
 */
function r1Row2047(): YearRow {
  const noParts = { spousal: "0", survivor: "0", withheld: "0" };
  const wd = ["0", "0", "4040801", "1694876", "0"];
  return {
    year: 2047,
    yearFractionPpm: 1_000_000,
    ages: [85, 85],
    alive: [true, true],
    phase: "retirement",
    filingStatus: "married_joint",
    cpiStart: "1.638616440",
    cpiEnd: "1.679581851",
    inflationBp: 250,
    portfolioReturnBp: 500,
    income: { wages: "0", socialSecurity: ["5896800", "3537600"], socialSecurityParts: [noParts, noParts], pensionAnnuity: "1200000", rental: "0", other: "0", total: "10634400" },
    contributions: { employee: "0", employer: "0" },
    spending: { planned: "14911410", funded: "14911410", core: "14911410", healthcare: "0", longTermCare: "0", goals: "0", floor: "14911410", shortfall: "0" },
    strategy: { events: [], withdrawalRateBp: 279 },
    withdrawals: { byAccount: wd, byBucket: { taxable: "0", pre_tax: "5735677", roth: "0", hsa: "0", cash: "0" }, total: "5735677", rmdByAccount: [...wd], rmdTotal: "5735677" },
    conversions: "0",
    investment: { realizedGains: "0", dividends: "0", coupons: "0" },
    tax: {
      ...zeroTaxDetail("married_joint"),
      totalFederalCents: "841475",
      incomeTaxCents: "841475",
      ordinaryTaxCents: "841475",
      agiCents: "13700622",
      taxableIncomeCents: "7710622",
      ordinaryTaxableCents: "7710622",
      taxableSocialSecurityCents: "6764945",
      standardDeductionCents: "5990000",
      magiIrmaaCents: "13700622",
      magiAcaCents: "16370077",
      bracketRateBp: 1200,
    },
    surplusSaved: "617192",
    growth: "8915228",
    ending: {
      byAccount: ["0", "3619465", "63642606", "26694302", "93263414"],
      basisByAccount: ["0", "3076608", "0", "0", "0"],
      byBucket: { taxable: "3619465", pre_tax: "90336908", roth: "93263414", hsa: "0", cash: "0" },
      total: "187219787",
      totalReal: "111468094",
    },
    failed: false,
  };
}
const R1_BUCKETS = ["cash", "taxable", "pre_tax", "pre_tax", "roth"] as const;

describe("OUT-7 deflateYearRow (strategies-outputs-web §3.11, seams C43)", () => {
  it("OUT-7 a flow of 98,400.00 at cpiStart 1.025 → 96,000.00", () => {
    // 9,840,000 × 10^9 / 1,025,000,000 = 9,600,000 exactly.
    expect(deflateCents(9_840_000n, "1.025000000")).toBe(9_600_000n);
    const row = { ...exampleYearRow(), cpiStart: "1.025000000", cpiEnd: "1.050625000" };
    row.spending = { ...row.spending, planned: "9840000", funded: "9840000", core: "9840000", floor: "9840000" };
    const real = deflateYearRow(row);
    expect(real.spending.funded).toBe("9600000");
    expect(real.spending.core).toBe("9600000");
  });

  it("OUT-7 (re-derived) R1's last row keeps totalReal = 1,114,680.94 and its by-account real balances sum to it", () => {
    const row = r1Row2047();
    expect(YearRow.parse(row)).toEqual(row);
    const real = deflateYearRow(row, { startTotalRealCents: 111_937_754n, accountBuckets: R1_BUCKETS });
    expect(YearRow.parse(real)).toEqual(real);
    expect(forbiddenValuePaths(real)).toEqual([]);
    expect(real.ending.totalReal).toBe("111468094");
    expect(real.ending.total).toBe("111468094");
    // Each balance × 10^9 ÷ 1,679,581,851, half away from zero (BigInt, re-derived with exact
    // fractions): 3,619,465 → 2,154,979.6… → 2,154,980; 63,642,606 → 37,891,935.4… → 37,891,935;
    // 26,694,302 → 15,893,420.8… → 15,893,421; 93,263,414 → 55,527,757.6… → 55,527,758. Their sum is
    // 111,468,094, the engine's figure, so addUp has nothing to move.
    expect(real.ending.byAccount).toEqual(["0", "2154980", "37891935", "15893421", "55527758"]);
    expect(real.ending.byAccount.reduce((s, c) => s + BigInt(c), 0n)).toBe(111_468_094n);
    expect(real.ending.byBucket).toEqual({ taxable: "2154980", pre_tax: "53785356", roth: "55527758", hsa: "0", cash: "0" });
    expect(real.ending.basisByAccount).toEqual(["0", "1831770", "0", "0", "0"]);
  });

  it("OUT-7 the 2047 flows at cpiStart 1.638616440, and the roll-forward in today's dollars", () => {
    const real = deflateYearRow(r1Row2047(), { startTotalRealCents: 111_937_754n, accountBuckets: R1_BUCKETS });
    // 5,896,800 → 3,598,646; 3,537,600 → 2,158,894; 1,200,000 → 732,325; total 10,634,400 → 6,489,865 (= the sum).
    expect(real.income).toMatchObject({ socialSecurity: ["3598646", "2158894"], pensionAnnuity: "732325", total: "6489865" });
    // Planned 149,114.10 is 130,000 × 0.7 at the 2047 price level: 91,000.00 in today's dollars.
    expect(real.spending).toMatchObject({ planned: "9100000", funded: "9100000", core: "9100000", floor: "9100000", shortfall: "0" });
    expect(real.withdrawals).toMatchObject({ byAccount: ["0", "0", "2465983", "1034334", "0"], total: "3500317", rmdTotal: "3500317" });
    expect(real.withdrawals.byBucket.pre_tax).toBe("3500317");
    expect(real.tax).toMatchObject({ totalFederalCents: "513528", incomeTaxCents: "513528", ordinaryTaxCents: "513528", agiCents: "8361092", taxableIncomeCents: "4705569" });
    expect(real.surplusSaved).toBe("376654");
    // Growth is the plug: 111,468,094 − (111,937,754 + 0 + 376,654 − 3,500,317) = 2,654,003
    // (26,540.03 of real growth; the nominal 89,152.28 deflated at cpiStart would be 54,407.05).
    expect(real.growth).toBe("2654003");
    const start = 111_937_754n;
    expect(start + BigInt(real.surplusSaved) - BigInt(real.withdrawals.total) + BigInt(real.growth)).toBe(BigInt(real.ending.total));
    // Without the previous row's figure the start is the row's own nominal start deflated:
    // 187,219,787 − 8,915,228 − 617,192 + 5,735,677 = 183,423,044 → 111,937,754, the same here.
    expect(deflateYearRow(r1Row2047()).growth).toBe("2654003");
    // Rates, ages and flags are copied.
    expect(real).toMatchObject({ inflationBp: 250, portfolioReturnBp: 500, ages: [85, 85], cpiStart: "1.638616440", strategy: { withdrawalRateBp: 279 } });
  });

  it("the §3.11 example: three parts of 100.00 at 1.07 deflate to 93.46 each while the total is 280.37; the first shows 93.45", () => {
    // 10,000 × 10^9 / 1,070,000,000 = 9,345.79 → 9,346; 30,000 → 28,037.38 → 28,037.
    const row = { ...exampleYearRow(), cpiStart: "1.070000000", cpiEnd: "1.070000000", alive: [true], ages: [70] };
    row.income = { ...row.income, wages: "10000", socialSecurity: ["10000"], pensionAnnuity: "10000", total: "30000" };
    row.ending = {
      byAccount: ["10000", "10000", "10000"],
      basisByAccount: ["0", "0", "0"],
      byBucket: { taxable: "0", pre_tax: "20000", roth: "10000", hsa: "0", cash: "0" },
      total: "30000",
      totalReal: "28037",
    };
    row.withdrawals = { byAccount: ["0", "0", "0"], byBucket: { taxable: "0", pre_tax: "0", roth: "0", hsa: "0", cash: "0" }, total: "0", rmdByAccount: ["0", "0", "0"], rmdTotal: "0" };
    const real = deflateYearRow(row);
    expect([real.income.wages, ...real.income.socialSecurity, real.income.pensionAnnuity]).toEqual(["9345", "9346", "9346"]);
    expect(real.income.total).toBe("28037");
    expect(real.ending.byAccount).toEqual(["9345", "9346", "9346"]);
    // Without the accounts' buckets, by bucket is its own group: pre-tax 18,692 and Roth 9,346 sum
    // to 28,038, so the larger (pre-tax) gives the cent back.
    expect(real.ending.byBucket).toMatchObject({ pre_tax: "18691", roth: "9346" });
    // With them, by bucket is the sum of the deflated accounts: Roth 9,345, pre-tax 9,346 + 9,346.
    const withBuckets = deflateYearRow(row, { accountBuckets: ["roth", "pre_tax", "pre_tax"] });
    expect(withBuckets.ending.byBucket).toMatchObject({ pre_tax: "18692", roth: "9345" });
  });

  it("a group whose nominal parts do not sum to its total is deflated part by part, not forced", () => {
    const row = { ...exampleYearRow(), cpiStart: "1.070000000" };
    // A shortfall year in which the parts are the planned amounts: 300 + 0 + 0 + 0 ≠ funded 200.
    row.spending = { planned: "30000", funded: "20000", core: "30000", healthcare: "0", longTermCare: "0", goals: "0", floor: "30000", shortfall: "10000" };
    const real = deflateYearRow(row);
    expect(real.spending).toMatchObject({ funded: "18692", core: "28037", shortfall: "9346" });
  });

  it("price levels: nine decimals, above zero", () => {
    expect(parsePriceLevel("1.000000000")).toBe(1_000_000_000n);
    expect(parsePriceLevel("1.025000000")).toBe(1_025_000_000n);
    expect(() => parsePriceLevel("1.025")).toThrow(RangeError);
    expect(() => parsePriceLevel("0.000000000")).toThrow(RangeError);
    expect(deflateCents(-150n, "1.070000000")).toBe(-140n);
    expect(() => deflateYearRow({ ...exampleYearRow(), cpiEnd: "0.000000000" })).toThrow(RangeError);
    expect(() => deflateYearRow(exampleYearRow(), { accountBuckets: ["roth", "cash"] })).toThrow(RangeError);
  });

  it("the input row is not changed, and at a price level of 1 the flows are unchanged", () => {
    const row = exampleYearRow();
    const before = structuredClone(row);
    const real = deflateYearRow(row);
    expect(row).toEqual(before);
    expect(real.withdrawals).toEqual(row.withdrawals);
    expect(real.spending).toEqual(row.spending);
    expect(real.ending.total).toBe("98341463");
  });
});

describe("deflateYearTable (the roll-forward across rows in today's dollars)", () => {
  it("each row starts where the previous row's engine total ended", () => {
    // Row 2 (illustrative, the same rule as exampleYearRow): 41,000.00 withdrawn at the start of
    // 2028, then 5%: (1,008,000.00 − 41,000.00) × 1.05 = 1,015,350.00; growth 48,350.00; today's
    // dollars at 1.050625: 966,424.75 (966,424.7472… half away from zero).
    const table = exampleYearTable();
    const second: YearRow = {
      ...exampleYearRow(),
      year: 2028,
      ages: [66],
      cpiStart: "1.025000000",
      cpiEnd: "1.050625000",
      spending: { planned: "4100000", funded: "4100000", core: "4100000", healthcare: "0", longTermCare: "0", goals: "0", floor: "4100000", shortfall: "0" },
      withdrawals: { byAccount: ["4100000"], byBucket: { taxable: "0", pre_tax: "0", roth: "4100000", hsa: "0", cash: "0" }, total: "4100000", rmdByAccount: ["0"], rmdTotal: "0" },
      growth: "4835000",
      ending: { byAccount: ["101535000"], basisByAccount: ["0"], byBucket: { taxable: "0", pre_tax: "0", roth: "101535000", hsa: "0", cash: "0" }, total: "101535000", totalReal: "96642475" },
    };
    table.rows.push(second);
    expect(YearTable.parse(table)).toEqual(table);
    const real = deflateYearTable(table);
    expect(YearTable.parse(real)).toEqual(real);
    // Row 1: start 1,000,000.00 (cpi 1), withdrawals 40,000.00, end 983,414.63 → growth 23,414.63.
    expect(real.rows[0]!.growth).toBe("2341463");
    // Row 2: start 983,414.63; withdrawals 41,000 ÷ 1.025 = 40,000.00; end 966,424.75 → growth 23,010.12.
    expect(real.rows[1]!.withdrawals.total).toBe("4000000");
    expect(real.rows[1]!.growth).toBe("2301012");
    let previous = BigInt(table.startingTotal);
    for (const row of real.rows) {
      const flows = BigInt(row.contributions.employee) + BigInt(row.contributions.employer) + BigInt(row.surplusSaved) - BigInt(row.withdrawals.total);
      expect(previous + flows + BigInt(row.growth)).toBe(BigInt(row.ending.total));
      previous = BigInt(row.ending.total);
    }
    expect(real.startingTotal).toBe(table.startingTotal);
    expect(deflateYearTable({ ...table, rows: [] }).rows).toEqual([]);
  });
});
