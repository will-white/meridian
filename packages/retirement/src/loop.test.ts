import { describe, expect, it } from "vitest";
import { dollarsToCents } from "./units.js";
import { IY } from "./flows.js";
import {
  AC,
  SP,
  W,
  YR,
  ZERO_YIELDS,
  ac,
  afterTrades,
  basisOf,
  endOf,
  fixedModel,
  runPath,
  sp,
  ti,
  to,
  ty,
  withBasis,
  yr,
} from "./loopTestKit.js";
import { YEAR_FLAG } from "./loop.js";
import { prepare } from "./prepare.js";
import { PATH_FLAG, createPathState } from "./state.js";
import { simulatePath } from "./loop.js";
import { TI, TO, TY } from "./tax/layout.js";
import { account, buildSimInput, cashAccount, incomeStream } from "./testing/simInput.js";
import { TREATMENT } from "./prepare.js";
import { bracketTaxInto, fixedSocialSecurity, flatTaxInto, noTaxInto, rmdByDivisor, stubHooks, stubTaxFunctions } from "./testing/stubs.js";

// Build step 16: the year loop on stub tax functions written to the real slot layouts
// (engine-and-returns §3.7 to §3.11 and §7 T19 to T22, T24 to T28, T31 to T34; seams §2.3 to §2.6).
// Every case runs through the public path: a SimInput from the builder, prepare(), createPathState()
// with stub hooks (the strategies area's real decideSpending and the reference order solver of
// engine-and-returns §3.9) and stubTaxFunctions(), and simulatePath() with a PathDetail. Unless a
// case says otherwise: one person, a plan from January (f = 1), yields 0, full rebalancing, the
// stub order cash → taxable → pre-tax → Roth → HSA, dollars within 0.005 (toBeCloseTo(x, 2)).
//
// The first-year cases at 52/365 are re-derived for months (seams §10, C14): a November start is
// f = 2/12. The re-derivations are 50-digit decimals by the script
// scratchpad/p4-loopstub/deriv.py (python3 -I), which first reproduces the design's W1 and T25.

const STUB_TAX = { federalTaxInto: flatTaxInto(0.2, 0.1) };
const NO_TAX = { federalTaxInto: noTaxInto };
const close = (x: number, y: number) => expect(x).toBeCloseTo(y, 2);
const closeAll = (xs: number[], ys: number[]) => {
  expect(xs.length).toBe(ys.length);
  xs.forEach((x, i) => close(x, ys[i]!));
};

describe("T19 a fixed historical path, year by year", () => {
  // asOf 2027-01-01, born 1962, fixed age 69 (Y = 5), Roth 600,000 / 400,000 at 60/40, constant
  // real spending 40,000, no tax, complete cohorts (94 with Y = 5), path 45 = cohort 1973.
  const input = buildSimInput({
    people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 69 } }],
    accounts: [account("roth", "roth", "100000000", { allocation: W(6000, 0, 4000, 0) })],
    spending: { baseAnnualCents: "4000000" },
    returnModel: { kind: "historical", cohorts: "complete" },
    tax: ZERO_YIELDS,
  });
  const { ps, detail } = runPath(input, { path: 45, tax: NO_TAX });
  // Year, cpi at the start, spend, after flows (stocks / bonds), end (stocks / bonds), end total, end in today's dollars.
  const table: Array<[number, number, number, number, number, number, number, number]> = [
    [2027, 1.0, 40000.0, 576000.0, 384000.0, 493585.92, 398049.41, 891635.33],
    [2028, 1.087059, 43482.36, 508891.78, 339261.19, 377079.65, 346007.74, 723087.38],
    [2029, 1.221177, 48847.08, 404544.18, 269696.12, 554205.71, 279419.47, 833625.18],
    [2030, 1.305883, 52235.31, 468833.92, 312555.95, 580561.73, 362516.77, 943078.5],
    [2031, 1.369413, 54776.51, 532981.19, 355320.8, 495780.71, 359904.43, 855685.14],
  ];
  const real = [820227.17, 592123.29, 638361.4, 688673.69, 585613.59];

  it("T19 the cohort is 1973 and each year's row is the design's", () => {
    expect(detail.cohortStartYear).toBe(1973);
    table.forEach(([year, cpi, spend, s, b, es, eb, total], t) => {
      expect(detail.sampledYear[t]).toBe(year - 2027 + 1973);
      expect(yr(detail, t, YR.CPI_START)).toBeCloseTo(cpi, 6);
      close(sp(detail, t, SP.NEED), spend);
      closeAll(afterTrades(detail, t, 0).slice(0, 2), [s, b]);
      closeAll(endOf(detail, t, 0).slice(0, 2), [es, eb]);
      close(yr(detail, t, YR.END_TOTAL), total);
      close(yr(detail, t, YR.END_TOTAL_REAL), real[t]!);
    });
  });

  it('T19 success, endReal "58561359" cents, endIdx 4', () => {
    // First row by hand: 1,000,000 − 40,000 = 960,000; 576,000 × 0.856920 = 493,585.92;
    // 384,000 × 1.036587 = 398,049.41; total 891,635.33; ÷ 1.087059 = 820,227.17.
    expect(ps.flags & PATH_FLAG.SUCCESS).toBe(PATH_FLAG.SUCCESS);
    expect(ps.failIdx).toBe(-1);
    expect(ps.endIdx).toBe(4);
    expect(dollarsToCents(ps.endReal)).toBe("58561359");
  });
});

/** Nearest-rank percentile of engine-and-returns §3.12 (the aggregation step owns the real one). */
function percentile(values: number[], pBp: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.max(0, Math.floor((pBp * sorted.length + 9999) / 10000) - 1);
  return sorted[i]!;
}

describe("T20 engine-level reference on the pinned data", () => {
  // The T19 household with fixed age 94 (Y = 30) and 40,000 real from 1,000,000, no tax.
  const run20 = (stocksBp: number, cohorts: "auto" | "wrap") => {
    const run = prepare(
      buildSimInput({
        people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 94 } }],
        accounts: [account("roth", "roth", "100000000", { allocation: W(stocksBp, 0, 10000 - stocksBp, 0) })],
        spending: { baseAnnualCents: "4000000" },
        returnModel: { kind: "historical", cohorts },
        tax: ZERO_YIELDS,
      }),
    );
    const ps = createPathState(run, stubHooks(), stubTaxFunctions(NO_TAX));
    const ending: number[] = [];
    const failures: Array<[number, number]> = [];
    let success = 0;
    for (let k = 0; k < run.paths; k++) {
      simulatePath(ps, k);
      ending.push(ps.endReal);
      if (ps.flags & PATH_FLAG.SUCCESS) success++;
      else failures.push([ps.market.cohortStartYear, ps.failIdx]);
      // Success implies no shortfall (engine decision 19).
      if (ps.flags & PATH_FLAG.SUCCESS) expect(ps.shortfallReal).toBe(0);
    }
    return { run, ending, failures, success };
  };

  it("T20 60/40, auto: 69 complete cohorts, 65 succeed; failing 1965, 1966, 1968, 1969 in plan years 27, 25, 27, 27", () => {
    const r = run20(6000, "auto");
    expect(r.run.paths).toBe(69);
    expect(r.success).toBe(65);
    expect(r.failures).toEqual([
      [1965, 27],
      [1966, 25],
      [1968, 27],
      [1969, 27],
    ]);
    // Ending wealth in today's dollars, nearest rank: p10 (rank 6) the 1967 path, median (rank 34) the 1951 path, p90 (rank 62).
    close(percentile(r.ending, 1000), 156910.48);
    close(percentile(r.ending, 5000), 1387869.67);
    close(percentile(r.ending, 9000), 3865589.65);
    close(r.ending[1967 - 1928]!, 156910.48);
    close(r.ending[1951 - 1928]!, 1387869.67);
  });

  it("T20 50/50: 64 of 69; failing 1964, 1965, 1966, 1968, 1969 in plan years 29, 26, 24, 27, 27", () => {
    const r = run20(5000, "auto");
    expect(r.success).toBe(64);
    expect(r.failures).toEqual([
      [1964, 29],
      [1965, 26],
      [1966, 24],
      [1968, 27],
      [1969, 27],
    ]);
  });

  it("T20 wrap: 98 paths, 94 succeed, the same four failures", () => {
    const r = run20(6000, "wrap");
    expect(r.run.paths).toBe(98);
    expect(r.success).toBe(94);
    expect(r.failures.map(([y]) => y)).toEqual([1965, 1966, 1968, 1969]);
  });
});

describe("T21 partial first year, fixed model (re-derived for f = 2/12)", () => {
  // The design's asOf 2026-11-10 (52/365) is a plan from November 2026 under C14: f = 2/12.
  // Born 1960, fixed age 68 (2026 to 2028), Roth 500,000 all stocks, 36,500 real, stocks +10%,
  // inflation 3%. By hand (deriv.py): 2026 spend 36,500 × 2/12 = 6,083.33; after 493,916.67;
  // factor 1.10^(1/6) = 1.016011867773; end 501,825.20; cpi[1] = 1.03^(1/6) = 1.004938622031;
  // today's dollars 499,359.05. 2027: spend 36,500 × 1.004938622031 = 36,680.26; after
  // 465,144.94; end 511,659.43; cpi[2] = 1.035086780692; today's dollars 494,315.49. 2028: spend
  // 37,780.67; end 521,266.64; today's dollars 488,929.16 (cpi[3] = 1.066139384113).
  const input = buildSimInput({
    startYear: 2026,
    startMonth: 11,
    people: [{ birthYear: 1960, longevity: { mode: "fixed", age: 68 } }],
    accounts: [account("roth", "roth", "50000000")],
    spending: { baseAnnualCents: "3650000" },
    returnModel: fixedModel([0.1, 0, 0, 0.03]),
    tax: ZERO_YIELDS,
  });
  const { ps, detail } = runPath(input, { tax: NO_TAX });

  it("T21 f = 1/6, the part-year factors, and three years", () => {
    expect(yr(detail, 0, YR.YEAR_FRACTION)).toBe(2 / 12);
    expect(detail.growth[0]).toBeCloseTo(1.016011867773, 11);
    expect(yr(detail, 0, YR.CPI_END)).toBeCloseTo(1.004938622031, 11);
    close(sp(detail, 0, SP.NEED), 6083.33);
    close(afterTrades(detail, 0, 0)[0]!, 493916.67);
    close(yr(detail, 0, YR.END_TOTAL), 501825.2);
    close(yr(detail, 0, YR.END_TOTAL_REAL), 499359.05);
    close(sp(detail, 1, SP.NEED), 36680.26);
    close(afterTrades(detail, 1, 0)[0]!, 465144.94);
    close(yr(detail, 1, YR.END_TOTAL), 511659.43);
    expect(yr(detail, 1, YR.CPI_END)).toBeCloseTo(1.035086780692, 11);
    close(yr(detail, 1, YR.END_TOTAL_REAL), 494315.49);
    close(sp(detail, 2, SP.NEED), 37780.67);
    close(yr(detail, 2, YR.END_TOTAL), 521266.64);
    close(yr(detail, 2, YR.END_TOTAL_REAL), 488929.16);
    close(ps.endReal, 488929.16);
  });
});

describe("T22 partial first year, historical cohort (re-derived for f = 2/12)", () => {
  // November 2026 start (f = 2/12), born 1960, fixed age 67 (Y = 2), Roth 1,000,000 at 60/40,
  // 36,500 real, complete cohorts, path 45 (1973). The 1973 part-year factors at f = 2/12 are
  // T15's (historical.test.ts): stocks 0.917500632445, bonds 1.003964052300, price
  // 1.027218012501. By hand (deriv.py): 2026 spend 6,083.33; after flows 596,350.00 /
  // 397,566.67; end 547,151.50 / 399,142.64; total 946,294.14; today's dollars 921,220.36. 2027
  // (1974, a full year): spend 36,500 × 1.027218012501 = 37,493.46; after flows 545,280.41 /
  // 363,520.27; end 404,042.97 / 370,749.24; total 774,792.21; cpi[2] = 1.027218012501 ×
  // 1.123377 = 1.153953089229; today's dollars 671,424.36.
  const input = buildSimInput({
    startYear: 2026,
    startMonth: 11,
    people: [{ birthYear: 1960, longevity: { mode: "fixed", age: 67 } }],
    accounts: [account("roth", "roth", "100000000", { allocation: W(6000, 0, 4000, 0) })],
    spending: { baseAnnualCents: "3650000" },
    returnModel: { kind: "historical", cohorts: "complete" },
    tax: ZERO_YIELDS,
  });
  const { detail } = runPath(input, { path: 45, tax: NO_TAX });

  it("T22 2026 (part of 1973) and 2027 (1974)", () => {
    expect(detail.sampledYear[0]).toBe(1973);
    expect(detail.growth[0]).toBeCloseTo(0.917500632445, 11);
    expect(detail.growth[1]).toBeCloseTo(1.0039640523, 11);
    expect(detail.priceFactor[0]).toBeCloseTo(1.027218012501, 11);
    close(sp(detail, 0, SP.NEED), 6083.33);
    closeAll(afterTrades(detail, 0, 0).slice(0, 2), [596350.0, 397566.67]);
    closeAll(endOf(detail, 0, 0).slice(0, 2), [547151.5, 399142.64]);
    close(yr(detail, 0, YR.END_TOTAL), 946294.14);
    close(yr(detail, 0, YR.END_TOTAL_REAL), 921220.36);
    close(sp(detail, 1, SP.NEED), 37493.46);
    closeAll(afterTrades(detail, 1, 0).slice(0, 2), [545280.41, 363520.27]);
    closeAll(endOf(detail, 1, 0).slice(0, 2), [404042.97, 370749.24]);
    close(yr(detail, 1, YR.END_TOTAL), 774792.21);
    close(yr(detail, 1, YR.END_TOTAL_REAL), 671424.36);
  });
});

describe("T24 same-year settlement (the three gross-ups of engine-and-returns §3.9)", () => {
  // Stub tax 20% of ordinary income + 10% of gains, yields 0, need 40,000, no income, one year.
  const base = { people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 65 } as const }], spending: { baseAnnualCents: "4000000" }, tax: ZERO_YIELDS };

  it("T24 one pre-tax account: W − 0.2 W = 40,000 → W = 50,000.00, tax 10,000.00, 3 hook calls", () => {
    const { detail } = runPath(buildSimInput({ ...base, accounts: [account("ira", "pre_tax", "100000000")] }), { tax: STUB_TAX });
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 50000);
    close(yr(detail, 0, YR.TAX), 10000);
    expect(Math.abs(yr(detail, 0, YR.NET))).toBeLessThanOrEqual(0.005);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBe(3);
  });

  // The taxable account of §3.8: stocks 700,000 (basis 300,000), bonds 300,000 (basis 290,000),
  // target 60/40. The frozen input carries one basis per account (C18 (b)), so the per-asset basis
  // is set on the prepared run; the starting holdings follow the allocation (70/30) and the target
  // the glide point (60/40 from 2027).
  const taxable = (mode: "full" | "flows_only") =>
    withBasis(
      prepare(
        buildSimInput({
          ...base,
          accounts: [account("brk", "taxable", "100000000", { allocation: W(7000, 0, 3000, 0), glidePath: [{ year: 2027, weights: W(6000, 0, 4000, 0) }] })],
          portfolio: { taxableRebalance: mode },
        }),
      ),
      0,
      [300000, 290000, 0],
    );

  it("T24 the taxable account, full rebalancing: W = 47,337.28, tax 7,337.28, gain 73,372.78, 4 hook calls", () => {
    // Δ_S = 100,000 + 0.6 W, gain (100,000 + 0.6 W) × 4/7, tax 5,714.2857 + 0.0342857 W; W − tax = 40,000.
    const { detail } = runPath(taxable("full"), { tax: STUB_TAX });
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 47337.28);
    close(yr(detail, 0, YR.TAX), 7337.28);
    close(ac(detail, 0, 0, AC.GAIN), 73372.78);
    closeAll(afterTrades(detail, 0, 0), [571597.63, 381065.09, 0]);
    closeAll(basisOf(detail, 0, 0), [244970.41, 371065.09, 0]);
    expect(Math.abs(yr(detail, 0, YR.NET))).toBeLessThanOrEqual(0.005);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBe(4);
  });

  it("T24 the same with flows_only: W = 42,424.24, tax 2,424.24, gain 24,242.42, 6 hook calls", () => {
    // Only stocks are sold: gain W × 4/7, W (1 − 0.0571429) = 40,000.
    const { detail } = runPath(taxable("flows_only"), { tax: STUB_TAX });
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 42424.24);
    close(yr(detail, 0, YR.TAX), 2424.24);
    close(ac(detail, 0, 0, AC.GAIN), 24242.42);
    closeAll(afterTrades(detail, 0, 0), [657575.76, 300000, 0]);
    closeAll(basisOf(detail, 0, 0), [281818.18, 290000, 0]);
    expect(Math.abs(yr(detail, 0, YR.NET))).toBeLessThanOrEqual(0.005);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBe(6);
  });
});

describe("T25 dividends and coupons taxed in the year, bill interest a year later", () => {
  // Taxable 100,000 / 100,000 / 50,000 with basis equal to value (C18 (b) gives exactly that from
  // one basis of 250,000: the bill slice at value, 200,000 over stocks and bonds by value), target
  // 40/40/20, fixed returns 8% / 3% / 4%, no inflation, no spending, stub tax, two years. The
  // yields (seams §10: the qualified share and the spread stated): dividends 1.3% all qualified;
  // bond interest max(0, billRef + 0.2%) = 4.2% with billRef = 4% (year 0: row 0 of the fixed
  // series; year 1: year 0's full-year bill return), C18. Values by deriv.py (the design's, all
  // reproduced): year 1 W = 0.00388 (250,000 − W) → 966.25; year 2 W = 1,430.25.
  const input = buildSimInput({
    people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 66 } }],
    accounts: [account("brk", "taxable", "25000000", { allocation: W(4000, 0, 4000, 2000), basisCents: "25000000" })],
    returnModel: fixedModel([0.08, 0.03, 0.04, 0]),
    tax: {
      includePayrollTax: false,
      taxDrag: {
        us_stock: { dividendYieldBp: 130, qualifiedShareBp: 10000 },
        intl_stock: { dividendYieldBp: 0 },
        real_estate: { dividendYieldBp: 0 },
        bonds: { interestSpreadBp: 20 },
      },
    },
  });
  const { detail } = runPath(input, { tax: STUB_TAX });

  it("T25 year 1: W = tax = 966.25; dividends 1,294.98, coupons 4,183.77; bill interest 1,992.27 carried untaxed", () => {
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 966.25);
    close(yr(detail, 0, YR.TAX), 966.25);
    close(ty(detail, 0, 0, TY.DIVIDENDS), 1294.98);
    close(ty(detail, 0, 0, TY.QUALIFIED_DIVIDENDS), 1294.98);
    close(ty(detail, 0, 0, TY.INTEREST), 4183.77);
    close(ti(detail, 0, TI.INTEREST), 4183.77);
    close(ac(detail, 0, 0, AC.GAIN), 0);
    closeAll(afterTrades(detail, 0, 0), [99613.5, 99613.5, 49806.75]);
    closeAll(endOf(detail, 0, 0), [107582.58, 102601.9, 51799.02]);
    closeAll(basisOf(detail, 0, 0), [100908.48, 103797.27, 51799.02]);
    close(yr(detail, 0, YR.INTEREST_CARRIED_OUT), 1992.27);
  });

  it("T25 year 2: W = tax = 1,430.25; gain 208.52, dividends 1,354.88, coupons 4,377.29; interest taxed 1,992.27 + 4,377.29", () => {
    close(ac(detail, 1, 0, AC.WITHDRAWAL), 1430.25);
    close(yr(detail, 1, YR.TAX), 1430.25);
    close(ac(detail, 1, 0, AC.GAIN), 208.52);
    close(ty(detail, 1, 0, TY.DIVIDENDS), 1354.88);
    close(ty(detail, 1, 0, TY.INTEREST), 4377.29);
    close(yr(detail, 1, YR.INTEREST_CARRIED_IN), 1992.27);
    close(ti(detail, 1, TI.INTEREST), 1992.27 + 4377.29);
    closeAll(afterTrades(detail, 1, 0), [104221.3, 104221.3, 52110.65]);
    close(yr(detail, 1, YR.INTEREST_CARRIED_OUT), 2084.43);
  });
});

describe("T26 RMD first, surplus reinvested", () => {
  // Age 75 (born 1952), pre-tax 500,000 / 500,000 (50/50), taxable 30,000 / 20,000 with basis
  // 10,000 / 20,000 (60/40, on target; the per-asset basis set on the prepared run, C18 (b)),
  // spending 20,000, stub tax, stub RMD = balance / 25. RMD 40,000; tax 8,000; no withdrawal;
  // surplus 40,000 − 20,000 − 8,000 = 12,000 at 60/40.
  const run = withBasis(
    prepare(
      buildSimInput({
        people: [{ birthYear: 1952, longevity: { mode: "fixed", age: 75 } }],
        accounts: [
          account("ira", "pre_tax", "100000000", { allocation: W(5000, 0, 5000, 0) }),
          account("brk", "taxable", "5000000", { allocation: W(6000, 0, 4000, 0), basisCents: "3000000" }),
        ],
        spending: { baseAnnualCents: "2000000" },
        tax: ZERO_YIELDS,
      }),
    ),
    1,
    [10000, 20000, 0],
  );
  const { detail } = runPath(run, { tax: { ...STUB_TAX, requiredMinimumDistribution: rmdByDivisor(25, 73) } });

  it("T26 RMD 40,000, tax 8,000, no withdrawal, 12,000 saved to the taxable account at 60/40, no gain", () => {
    close(ac(detail, 0, 0, AC.RMD), 40000);
    close(yr(detail, 0, YR.TAX), 8000);
    expect(yr(detail, 0, YR.WITHDRAWAL_TOTAL)).toBe(0);
    close(sp(detail, 0, SP.SURPLUS), 12000);
    close(ac(detail, 0, 1, AC.SURPLUS), 12000);
    closeAll(afterTrades(detail, 0, 1), [37200, 24800, 0]);
    closeAll(basisOf(detail, 0, 1), [17200, 24800, 0]);
    closeAll(afterTrades(detail, 0, 0), [480000, 480000, 0]);
    expect(ac(detail, 0, 1, AC.GAIN)).toBe(0);
  });
});

describe("T27 first death", () => {
  // Born 1947 (fixed 81) and 1950 (fixed 80), plan from 2027: deaths at plan years 1 and 3, the
  // plan ends in 2030. Person 0 owns a pre-tax account (300,000 bonds) and a nominal pension of
  // 30,000 with survivorBp 5000. Taxable accounts, all stocks: joint 400,000 (basis 100,000),
  // person 0's 50,000 (basis 80,000, a loss), person 1's 60,000 (basis 20,000). Spending 30,000;
  // no inflation, returns or tax; the joint account is first in the stub order (account order).
  const accounts = [
    account("joint", "taxable", "40000000", { basisCents: "10000000" }),
    account("own0", "taxable", "5000000", { owner: "p1", basisCents: "8000000" }),
    account("own1", "taxable", "6000000", { owner: "p2", basisCents: "2000000" }),
    account("ira", "pre_tax", "30000000", { allocation: W(0, 0, 10000, 0) }),
  ];
  const input = (state: string) =>
    buildSimInput({
      people: [
        { birthYear: 1947, longevity: { mode: "fixed", age: 81 } },
        { birthYear: 1950, longevity: { mode: "fixed", age: 80 } },
      ],
      accounts,
      incomes: [incomeStream("pension", "pension", "3000000", "2027-01", { personId: "p1", dollars: "nominal", cola: { mode: "none" }, survivorBp: 5000 })],
      spending: { baseAnnualCents: "3000000" },
      tax: ZERO_YIELDS,
      state,
    });

  it("T27 deathIdx [1, 3]; 2027 and 2028 mfj with income 30,000 and no withdrawal", () => {
    const { ps, detail } = runPath(input("CO"), { tax: NO_TAX });
    expect(Array.from(ps.deathIdx)).toEqual([1, 3]);
    expect(detail.rows).toBe(4);
    for (const t of [0, 1]) {
      expect(yr(detail, t, YR.FILING_STATUS)).toBe(1);
      close(yr(detail, t, YR.CASH_INCOME), 30000);
      expect(yr(detail, t, YR.WITHDRAWAL_TOTAL)).toBe(0);
    }
  });

  it("T27 end of 2028: the decedent's accounts pass to the survivor; joint basis 250,000, the loss steps down to 50,000, the survivor's own stays 20,000", () => {
    const { detail } = runPath(input("CO"), { tax: NO_TAX });
    // Joint: 100,000 + 0.5 × (400,000 − 100,000) = 250,000 (CO is not a community-property state).
    expect(basisOf(detail, 1, 0)[0]).toBeCloseTo(250000, 6);
    expect(basisOf(detail, 1, 1)[0]).toBeCloseTo(50000, 6);
    expect(basisOf(detail, 1, 2)[0]).toBeCloseTo(20000, 6);
    // Owners recorded at the start of 2029: the pre-tax account and person 0's taxable account are person 1's.
    expect([0, 1, 2, 3].map((a) => ac(detail, 2, a, AC.OWNER))).toEqual([-1, 1, 1, 1]);
  });

  it("T27 2029: single, income 15,000, 15,000 from the joint account (basis 240,625); 2030: basis 231,250, balance 370,000", () => {
    const { detail } = runPath(input("CO"), { tax: NO_TAX });
    expect(yr(detail, 2, YR.FILING_STATUS)).toBe(0);
    close(yr(detail, 2, YR.CASH_INCOME), 15000);
    close(ac(detail, 2, 0, AC.WITHDRAWAL), 15000);
    expect(yr(detail, 2, YR.WITHDRAWAL_TOTAL)).toBeCloseTo(15000, 6);
    // 250,000 − 15,000 × 250,000 / 400,000 = 240,625; then 240,625 − 15,000 × 240,625 / 385,000 = 231,250.
    close(basisOf(detail, 2, 0)[0]!, 240625);
    expect(yr(detail, 3, YR.FILING_STATUS)).toBe(0);
    close(basisOf(detail, 3, 0)[0]!, 231250);
    close(endOf(detail, 3, 0)[0]!, 370000);
  });

  it("T27 a community-property state (CA): the joint basis becomes 400,000; a share of 0 leaves it at 100,000", () => {
    // C19: the joint share is read from the state of residence; the engine's 'none' setting is not
    // built, so the 0 share is set on the prepared run to show the loop applies the share it is given.
    const ca = runPath(input("CA"), { tax: NO_TAX });
    expect(basisOf(ca.detail, 1, 0)[0]).toBeCloseTo(400000, 6);
    const none = runPath({ ...prepare(input("CO")), jointStepUp: 0 }, { tax: NO_TAX });
    expect(basisOf(none.detail, 1, 0)[0]).toBeCloseTo(100000, 6);
  });
});

describe("T28 failure and shortfall", () => {
  // Cash 50,000, spending 40,000 real, inflation 25%, no returns, exempt income 10,000 real from
  // year 2. Year 0 funds 40,000 (10,000 left); year 1 needs 50,000 and has 10,000: shortfall
  // 40,000, the path fails in plan year 1; year 2 needs 62,500 with income 15,625 (shortfall
  // 46,875); year 3: 78,125 − 19,531.25 = 58,593.75. shortfallReal = 40,000 / 1.25 + 46,875 /
  // 1.5625 + 58,593.75 / 1.953125 = 32,000 + 30,000 + 30,000 = 92,000.
  const input = buildSimInput({
    people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 68 } }],
    accounts: [cashAccount("cash", "5000000")],
    incomes: [incomeStream("other", "other", "1000000", "2029-01", { taxableBp: 0 })],
    spending: { baseAnnualCents: "4000000" },
    returnModel: fixedModel([0, 0, 0, 0.25]),
    tax: ZERO_YIELDS,
  });
  const { ps, detail } = runPath(input, { tax: NO_TAX });

  it("T28 success false, failIdx 1, shortfallReal 92,000.00, endReal 0, spending 40,000 / 8,000 / 10,000 / 10,000 real", () => {
    expect(ps.flags & PATH_FLAG.SUCCESS).toBe(0);
    expect(ps.failIdx).toBe(1);
    close(ps.shortfallReal, 92000);
    close(ps.endReal, 0);
    closeAll(Array.from(ps.spendingReal), [40000, 8000, 10000, 10000]);
    closeAll([1, 2, 3].map((t) => sp(detail, t, SP.SHORTFALL)), [40000, 46875, 58593.75]);
    expect(yr(detail, 0, YR.FLAGS) & YEAR_FLAG.FAILED).toBe(0);
    expect(yr(detail, 1, YR.FLAGS) & YEAR_FLAG.FAILED).toBe(YEAR_FLAG.FAILED);
  });
});

describe("T31 accumulation phase", () => {
  // Born 1981, retires January 2028; pre-tax (401k) 100,000 all stocks; salary 150,000 (real +1%)
  // for 2026–2027; employee pre-tax 23,000 and employer 7,500, both indexed to prices; stocks +10%,
  // inflation 3%; stub tax; spending of 110,000 from 2028. Fixed age 50 keeps the plan short.
  const input = (startMonth: number) =>
    buildSimInput({
      startYear: 2026,
      startMonth,
      people: [{ birthYear: 1981, retirementMonth: "2028-01", longevity: { mode: "fixed", age: 50 } }],
      accounts: [account("401k", "pre_tax", "10000000", { type: "401k" })],
      incomes: [incomeStream("salary", "salary", "15000000", "2026-01", { personId: "p1", endMonth: "2028-01", realGrowthBp: 100 })],
      contributions: [{ accountId: "401k", employeeAnnualCents: "2300000", employerAnnualCents: "750000", scaleWith: "inflation", endMonth: "2028-01" }],
      spending: { baseAnnualCents: "11000000", startMonth: "2028-01" },
      returnModel: fixedModel([0.1, 0, 0, 0.03]),
      tax: ZERO_YIELDS,
    });

  it("T31 a full first year: deposit 30,500 → 130,500 → 143,550.00; tax 25,400 reported, equal to the baseline and not drawn; 2027 wages 156,045, deposit 31,415 → 192,461.50, tax 26,471", () => {
    const { detail } = runPath(input(1), { tax: STUB_TAX });
    expect(yr(detail, 0, YR.PHASE)).toBe(0);
    close(ac(detail, 0, 0, AC.DEPOSIT), 30500);
    close(afterTrades(detail, 0, 0)[0]!, 130500);
    close(endOf(detail, 0, 0)[0]!, 143550);
    close(yr(detail, 0, YR.TAX), 25400);
    close(yr(detail, 0, YR.TAX_BASELINE), 25400);
    expect(yr(detail, 0, YR.WITHDRAWAL_TOTAL)).toBe(0);
    expect(sp(detail, 0, SP.NEED)).toBe(0);
    close(detail.income[1 * 10 + IY.WAGES0]!, 156045);
    close(ac(detail, 1, 0, AC.DEPOSIT), 31415);
    close(afterTrades(detail, 1, 0)[0]!, 174965);
    close(endOf(detail, 1, 0)[0]!, 192461.5);
    close(yr(detail, 1, YR.TAX), 26471);
    expect(yr(detail, 1, YR.WITHDRAWAL_TOTAL)).toBe(0);
  });

  it("T31 from November 2026 (re-derived for f = 2/12): 2026 wages 25,000.00, deposit 5,083.33 → 105,083.33 → 106,765.91, tax 4,233.33; 2027 wages 152,248.20, deposit 30,650.63 → 137,416.54 → 151,158.20, tax 25,826.92", () => {
    // By hand (deriv.py): wages 150,000 × 2/12; deposit 30,500 × 2/12; end × 1.1^(1/6) =
    // 1.016011867773; tax 0.2 × (25,000 − 23,000 × 2/12). 2027: cpi 1.03^(1/6) =
    // 1.004938622031; wages 150,000 × cpi × 1.01; deposit 30,500 × cpi; end × 1.1; tax 0.2 ×
    // (wages − 23,000 × cpi).
    const { detail } = runPath(input(11), { tax: STUB_TAX });
    close(detail.income[IY.WAGES0]!, 25000);
    close(ac(detail, 0, 0, AC.DEPOSIT), 5083.33);
    close(afterTrades(detail, 0, 0)[0]!, 105083.33);
    close(endOf(detail, 0, 0)[0]!, 106765.91);
    close(yr(detail, 0, YR.TAX), 4233.33);
    expect(yr(detail, 1, YR.CPI_START)).toBeCloseTo(1.004938622031, 11);
    close(detail.income[1 * 10 + IY.WAGES0]!, 152248.2);
    close(ac(detail, 1, 0, AC.DEPOSIT), 30650.63);
    close(afterTrades(detail, 1, 0)[0]!, 137416.54);
    close(endOf(detail, 1, 0)[0]!, 151158.2);
    close(yr(detail, 1, YR.TAX), 25826.92);
  });
});

describe("T32 scheduled conversion", () => {
  const accounts = [
    account("ira", "pre_tax", "50000000", { allocation: W(6000, 0, 4000, 0) }),
    account("roth", "roth", "10000000"),
    cashAccount("cash", "8000000"),
  ];

  it("T32 50,000 converted in the first year: tax 10,000, cash withdrawal 40,000; pre-tax 270,000 / 180,000, Roth 150,000, cash 40,000", () => {
    const { detail } = runPath(
      buildSimInput({
        accounts,
        rothConversions: [{ personId: "p1", year: 2027, amountCents: "5000000", dollars: "nominal" }],
        spending: { baseAnnualCents: "3000000" },
        tax: ZERO_YIELDS,
      }),
      { tax: STUB_TAX },
    );
    close(yr(detail, 0, YR.CONVERSIONS), 50000);
    close(ti(detail, 0, TI.ROTH_CONV), 50000);
    close(yr(detail, 0, YR.TAX), 10000);
    close(ac(detail, 0, 2, AC.WITHDRAWAL), 40000);
    closeAll(afterTrades(detail, 0, 0), [270000, 180000, 0]);
    close(afterTrades(detail, 0, 1)[0]!, 150000);
    close(afterTrades(detail, 0, 2)[2]!, 40000);
  });

  it("T32 from July 2028 (f = 0.5), 10% to 50,000 and 30% above, annualized: the conversion stays 50,000, need 15,000, tax 10,000, cash withdrawal 25,000, cash 55,000; first_year_lump", () => {
    // Annualized ordinary income 50,000 / 0.5 = 100,000: T = 5,000 + 15,000 = 20,000; tax 0.5 × 20,000 = 10,000.
    const { run, detail } = runPath(
      buildSimInput({
        startYear: 2028,
        startMonth: 7,
        accounts,
        rothConversions: [{ personId: "p1", year: 2028, amountCents: "5000000", dollars: "today" }],
        spending: { baseAnnualCents: "3000000" },
        tax: ZERO_YIELDS,
      }),
      { tax: { federalTaxInto: bracketTaxInto(50000, 0.1, 0.3) } },
    );
    expect(yr(detail, 0, YR.YEAR_FRACTION)).toBe(0.5);
    close(yr(detail, 0, YR.CONVERSIONS), 50000);
    close(sp(detail, 0, SP.NEED), 15000);
    close(yr(detail, 0, YR.TAX), 10000);
    close(ac(detail, 0, 2, AC.WITHDRAWAL), 25000);
    close(afterTrades(detail, 0, 2)[2]!, 55000);
    expect(run.warnings.map((w) => w.code)).toContain("first_year_lump");
  });
});

describe("T33 partial-year lumps", () => {
  // From July 2028 (f = 0.5). Pre-tax 500,000 bonds with stub RMD = balance / 25: 20,000 × 0.5 =
  // 10,000; cash 100,000; spending 40,000 a year plus a goal of 15,000 dated 2028.
  const input = (pension: boolean) =>
    buildSimInput({
      startYear: 2028,
      startMonth: 7,
      people: [{ birthYear: 1950, longevity: { mode: "fixed", age: 78 } }],
      accounts: [account("ira", "pre_tax", "50000000", { allocation: W(0, 0, 10000, 0) }), cashAccount("cash", "10000000")],
      incomes: pension ? [incomeStream("pension", "pension", "6000000", "2028-07", { personId: "p1", taxableBp: 0 })] : [],
      spending: { baseAnnualCents: "4000000", goals: [{ id: "g", name: "goal", year: 2028, amountCents: "1500000", dollars: "today" }] },
      tax: ZERO_YIELDS,
    });
  const RMD = rmdByDivisor(25, 73);

  it("T33 an exempt pension of 60,000 pays 30,000; need = floorNeed = 20,000 + 15,000; RMD 10,000; no withdrawal; 5,000 saved (cash 105,000); pre-tax 490,000", () => {
    const { detail } = runPath(input(true), { tax: { ...NO_TAX, requiredMinimumDistribution: RMD } });
    close(detail.income[IY.CASH]!, 30000);
    close(sp(detail, 0, SP.NEED), 35000);
    close(sp(detail, 0, SP.FLOOR_NEED), 35000);
    close(ac(detail, 0, 0, AC.RMD), 10000);
    expect(yr(detail, 0, YR.WITHDRAWAL_TOTAL)).toBe(0);
    close(sp(detail, 0, SP.SURPLUS), 5000);
    close(afterTrades(detail, 0, 1)[2]!, 105000);
    close(afterTrades(detail, 0, 0)[1]!, 490000);
  });

  it("T33 without the pension, stub tax: tax 0.5 × 0.2 × 20,000 = 2,000; cash withdrawal 35,000 + 2,000 − 10,000 = 27,000; cash 73,000", () => {
    const { detail } = runPath(input(false), { tax: { ...STUB_TAX, requiredMinimumDistribution: RMD } });
    close(yr(detail, 0, YR.TAX), 2000);
    close(ac(detail, 0, 1, AC.WITHDRAWAL), 27000);
    close(afterTrades(detail, 0, 1)[2]!, 73000);
  });
});

describe("T34 the whole year W1 (engine-and-returns §3.10)", () => {
  // 2035 (f = 1, cpi 1), born 1960 and 1962 (75 and 73), both alive all year. Joint taxable
  // 330,000 / 130,000 / 40,000 with basis 190,000 / 120,000 / 40,000 (set on the prepared run, C18
  // (b)), target 60/30/10; pre-tax of person 0 200,000 / 200,000 at 50/50; Roth of person 1
  // 100,000 stocks; a nominal pension of 12,000 (ordinary). Stubs: Social Security 30,000 and
  // 20,000 (untaxed), RMD = balance / 24.6 from 75, spending 100,000, tax 15% of ordinary income
  // and 10% of qualified dividends and gains, order taxable → pre-tax → Roth (no cash account).
  // Yields: dividends 1.5% all qualified; bond interest max(0, billRef + 1%) = 4% with billRef = 3%
  // (row 0 of the fixed series; C18, the default spread). Market +10% / +2% / +3%, inflation 4%.
  // deriv.py reproduces every design value below from the closed forms of §3.10.
  const input = (mode: "full" | "flows_only") =>
    buildSimInput({
      startYear: 2035,
      people: [
        { birthYear: 1960, longevity: { mode: "fixed", age: 75 } },
        { birthYear: 1962, longevity: { mode: "fixed", age: 73 } },
      ],
      accounts: [
        account("joint", "taxable", "50000000", { allocation: W(6600, 0, 2600, 800), glidePath: [{ year: 2035, weights: W(6000, 0, 3000, 1000) }] }),
        account("ira", "pre_tax", "40000000", { allocation: W(5000, 0, 5000, 0) }),
        account("roth", "roth", "10000000", { owner: "p2" }),
      ],
      incomes: [incomeStream("pension", "pension", "1200000", "2035-01", { personId: "p1", dollars: "nominal", cola: { mode: "none" } })],
      spending: { baseAnnualCents: "10000000" },
      returnModel: fixedModel([0.1, 0.02, 0.03, 0.04]),
      portfolio: { taxableRebalance: mode },
      tax: {
        includePayrollTax: false,
        taxDrag: {
          us_stock: { dividendYieldBp: 150, qualifiedShareBp: 10000 },
          intl_stock: { dividendYieldBp: 0 },
          real_estate: { dividendYieldBp: 0 },
        },
      },
    });
  const tax = { federalTaxInto: flatTaxInto(0.15, 0.1), requiredMinimumDistribution: rmdByDivisor(24.6, 75), socialSecurityYear: fixedSocialSecurity([30000, 20000]) };
  const w1 = (mode: "full" | "flows_only") => runPath(withBasis(prepare(input(mode)), 0, [190000, 120000, 40000]), { tax });

  it("T34 full rebalancing: RMD 16,260.16; W 29,267.56; tax 7,527.72; gain 20,177.20; dividends 4,236.59; coupons 5,648.79; 4 hook calls", () => {
    const { ps, detail } = w1("full");
    close(ac(detail, 0, 1, AC.RMD), 16260.16);
    close(yr(detail, 0, YR.CASH_INCOME), 62000);
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 29267.56);
    close(yr(detail, 0, YR.WITHDRAWAL_TOTAL), 29267.56);
    close(yr(detail, 0, YR.TAX), 7527.72);
    close(ac(detail, 0, 0, AC.GAIN), 20177.2);
    close(ty(detail, 0, 0, TY.DIVIDENDS), 4236.59);
    close(ty(detail, 0, 0, TY.INTEREST), 5648.79);
    expect(yr(detail, 0, YR.ASSESS_CALLS)).toBe(4);
    closeAll(afterTrades(detail, 0, 0), [282439.46, 141219.73, 47073.24]);
    closeAll(afterTrades(detail, 0, 1), [191869.92, 191869.92, 0]);
    close(afterTrades(detail, 0, 2)[0]!, 100000);
    close(yr(detail, 0, YR.END_TOTAL), 1019977.21);
    close(yr(detail, 0, YR.END_TOTAL_REAL), 980747.31);
    close(ps.endReal, 980747.31);
    closeAll(basisOf(detail, 0, 0), [166853.25, 136868.52, 48485.44]);
    close(yr(detail, 0, YR.INTEREST_CARRIED_OUT), 1412.2);
    expect(to(detail, 0, TO.TOTAL)).toBeCloseTo(yr(detail, 0, YR.TAX), 9);
  });

  it("T34 flows_only: W 28,416.80; tax 6,676.96; gain 12,055.61; dividends 4,523.75; coupons 5,200.00; end 1,022,305.75; basis 178,162.56 / 125,200.00 / 41,200.00", () => {
    const { detail } = w1("flows_only");
    close(ac(detail, 0, 0, AC.WITHDRAWAL), 28416.8);
    close(yr(detail, 0, YR.TAX), 6676.96);
    close(ac(detail, 0, 0, AC.GAIN), 12055.61);
    close(ty(detail, 0, 0, TY.DIVIDENDS), 4523.75);
    close(ty(detail, 0, 0, TY.INTEREST), 5200);
    closeAll(afterTrades(detail, 0, 0), [301583.2, 130000, 40000]);
    close(yr(detail, 0, YR.END_TOTAL), 1022305.75);
    closeAll(basisOf(detail, 0, 0), [178162.56, 125200, 41200]);
  });

  it("T34 the cash identity of the year: income + RMD + withdrawals = funded spending + tax + surplus", () => {
    for (const mode of ["full", "flows_only"] as const) {
      const { detail } = w1(mode);
      const sources = yr(detail, 0, YR.CASH_INCOME) + yr(detail, 0, YR.RMD_TOTAL) + yr(detail, 0, YR.WITHDRAWAL_TOTAL);
      const uses = sp(detail, 0, SP.FUNDED) + yr(detail, 0, YR.TAX) + sp(detail, 0, SP.SURPLUS);
      expect(Math.abs(sources - uses)).toBeLessThan(1e-6);
      close(sp(detail, 0, SP.FUNDED), 100000);
    }
  });
});

describe("the loop's treatment of the stub record", () => {
  it("only the treatments named in TREATMENT exist (the stub order covers all five)", () => {
    expect(Object.values(TREATMENT).sort()).toEqual([0, 1, 2, 3, 4]);
  });
});
