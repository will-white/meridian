import { describe, expect, it } from "vitest";
import { detExp, detExpInPlace } from "./detmath.js";
import { doubleFields } from "./doubleFields.js";
import { PURPOSE, invNorm, invNormInPlace, seedKey, uniformAt, uniformsAt } from "./rng.js";
import { float64Bits } from "./selftest.js";
import { createSettleInput, createSpendDecision, createSpendingOutcome, fillNeeds, fillNeedsFor, settleSpending, settleSpendingFor } from "./strategies/index.js";
import { contributionLimitsFrom, contributionLimitsInto } from "./tax/contributionLimits.js";
import { CL_REC, HW_REC, PT_REC, RB, RB_REC, RW_REC, SO, SO_REC, SS_REC, TYI, TYI_REC, TY_REC, progOffset } from "./tax/layout.js";
import { employeePayrollTaxFrom, employeePayrollTaxInto } from "./tax/payroll.js";
import { hsaWithdraw, hsaWithdrawFrom, preTaxPenaltyBase, preTaxPenaltyBaseInto } from "./tax/penalties.js";
import { defaultRmdTables, requiredMinimumDistribution, requiredMinimumDistributionInto } from "./tax/rmd.js";
import {
  addRothContribution,
  addRothContributionFrom,
  addRothConversion,
  addRothConversionFrom,
  rothFreeAmount,
  rothFreeAmountInto,
  rothWithdraw,
  rothWithdrawFrom,
  seedRoth,
  seedRothFrom,
} from "./tax/rothBasis.js";
import { compileSsPlan, resetSsState, socialSecurityYear, socialSecurityYearFrom } from "./tax/socialSecurity.js";
import { assetClassMapRows, blendTaxDrag, compileTaxDrag, taxableYieldsFrom, taxableYieldsInto } from "./tax/taxDrag.js";
import { loadTaxData } from "./tax/taxData.js";
import { pathTables } from "./tax/testKit.js";
import { depositAtWeights, depositAtWeightsFrom } from "./trades.js";

// The allocation-free forms added for the zero-GC budget of engine-and-returns §3.15 (T47's PERF=1
// garbage-collection row): array and out-record forms of functions that return or take doubles,
// because V8 boxes a double that crosses a call it does not inline. Each form must give the same
// bits as the scalar form it stands for, so the T41 digests and R1 to R4 cannot move.

const bits = (xs: ArrayLike<number>) => Array.from(xs, float64Bits);

describe("T3 and T4 the array forms of the generator", () => {
  it("T3 uniformsAt writes uniformAt(key, path, purpose, step, j) for slots 0 … count − 1, bit for bit", () => {
    const key = seedKey("20261110");
    const out = new Float64Array(6);
    for (const [path, step] of [[0, 0], [1, 59], [12345, 7], [4294967295, 65535]] as const) {
      uniformsAt(key, path, PURPOSE.MARKET, step, 4, out);
      const expected = [0, 1, 2, 3].map((j) => uniformAt(key, path, PURPOSE.MARKET, step, j));
      expect(bits(out.subarray(0, 4))).toEqual(bits(expected));
    }
    out.fill(7);
    uniformsAt(key, 3, PURPOSE.BOOT, 2, 2, out);
    expect(Array.from(out.subarray(2))).toEqual([7, 7, 7, 7]);
  });

  it("T4 invNormInPlace replaces values[start … start + count − 1] by invNorm of each, bit for bit (both tails and the centre)", () => {
    const us = [2 ** -53, 1e-10, 0.02425, 0.05, 0.075, 0.3, 0.5, 0.7, 0.925, 0.97575, 1 - 1e-10, 1 - 2 ** -53];
    const values = Float64Array.from([9, ...us, 9]);
    invNormInPlace(values, 1, us.length);
    expect(bits(values.subarray(1, 1 + us.length))).toEqual(bits(us.map(invNorm)));
    expect([values[0], values[us.length + 1]]).toEqual([9, 9]);
  });
});

describe("T5 the array form of detExp", () => {
  it("T5 detExpInPlace replaces each value by detExp of it, bit for bit (NaN, overflow, underflow and the two-factor scaling included)", () => {
    const xs = [Number.NaN, 0, -0, 1, -1, 0.5, 1e-300, 709.7, 709.79, 800, -708.5, -740, -745.1, -745.3, -1000, 0.0779, -0.312];
    const values = Float64Array.from(xs);
    detExpInPlace(values, 0, xs.length);
    expect(bits(values)).toEqual(bits(xs.map(detExp)));
    const part = Float64Array.from([1, 2, 3]);
    detExpInPlace(part, 1, 1);
    expect(bits(part)).toEqual(bits([1, detExp(2), 3]));
  });
});

describe("doubleFields", () => {
  it("leaves every value of the record as it was, -0 and NaN included", () => {
    const r = { a: 0, b: -0, c: 1.5, d: Number.NaN, e: 7, s: "x" };
    expect(doubleFields(r, ["a", "b", "c", "d", "e"])).toBe(r);
    expect(Object.is(r.a, 0)).toBe(true);
    expect(Object.is(r.b, -0)).toBe(true);
    expect(r.c).toBe(1.5);
    expect(Number.isNaN(r.d)).toBe(true);
    expect(r.e).toBe(7);
    expect(r.s).toBe("x");
    expect(Object.keys(r)).toEqual(["a", "b", "c", "d", "e", "s"]);
  });
});

// The record forms the year loop calls through TAX_FUNCTIONS (tax/functions.ts) and the loop's
// forms of the strategies' settlement and the surplus deposit, against the scalar forms the tests
// of each area pin. The year fraction of a record form is the period's months (periodMonths / 12
// is the loop's f).

const MONTHS = [1, 2, 3, 6, 11, 12];

describe("the tax area's record forms give the scalar forms' numbers", () => {
  it("requiredMinimumDistributionInto: out[a] = requiredMinimumDistribution(balances[a], …, months / 12), the joint table and the caps included", () => {
    const tables = defaultRmdTables();
    const balances = Float64Array.of(0, -5, 1000, 543210.98, 1e7, 3.5);
    const out = new Float64Array(balances.length).fill(Number.NaN);
    for (const months of MONTHS) {
      for (const [age, start, spouse] of [[72, 73, -1], [73, 73, -1], [75, 73, 60], [80, 75, 69], [100, 73, 99], [125, 73, 15], [74, 73, 64]] as const) {
        for (let a = 0; a < balances.length; a++) {
          requiredMinimumDistributionInto(balances, a, age, start, spouse, months, tables, out);
          expect(float64Bits(out[a]!)).toBe(float64Bits(requiredMinimumDistribution(balances[a]!, age, start, spouse, months / 12, tables)));
        }
      }
    }
  });

  it("rothWithdrawFrom, rothFreeAmountInto, seedRothFrom and the two additions write the records the scalar forms write", () => {
    const amounts = Float64Array.of(0, 1234.56, 40000, 90000.01);
    const early = Float64Array.of(0, 0.25, 1, 0);
    for (let at = 0; at < amounts.length; at++) {
      for (const year of [2027, 2031, 2040]) {
        const a = new Float64Array(RB_REC);
        const b = new Float64Array(RB_REC);
        seedRoth(a, 0, 25000.5, true, 2027);
        seedRothFrom(b, 0, Float64Array.of(25000.5), 0, true, 2027);
        addRothConversion(a, 0, 3000.25, 2028);
        addRothConversionFrom(b, 0, Float64Array.of(3000.25), 0, 2028);
        addRothContribution(a, 0, 7000.75, 2029);
        addRothContributionFrom(b, 0, Float64Array.of(7000.75), 0, 2029);
        expect(bits(b)).toEqual(bits(a));
        const free = new Float64Array(4);
        rothFreeAmountInto(b, 0, amounts, early, at, year, free);
        expect(float64Bits(free[at]!)).toBe(float64Bits(rothFreeAmount(a, 0, amounts[at]!, early[at]!, year)));
        const ra = new Float64Array(RW_REC);
        const rb = new Float64Array(RW_REC);
        rothWithdraw(a, 0, amounts[at]!, early[at]!, year, ra);
        rothWithdrawFrom(b, 0, amounts, early, at, year, rb);
        expect(bits(rb)).toEqual(bits(ra));
        expect(bits(b)).toEqual(bits(a));
        expect(a[RB.BASIS_FREE]).toBeGreaterThanOrEqual(0);
      }
    }
    // In place: the balance in and the free amount out in one slot.
    const st = new Float64Array(RB_REC);
    seedRoth(st, 0, 5000, true, 2020);
    const io = Float64Array.of(3000, 8000);
    rothFreeAmountInto(st, 0, io, Float64Array.of(1, 1), 1, 2030, io);
    expect(Array.from(io)).toEqual([3000, rothFreeAmount(st, 0, 8000, 1, 2030)]);
  });

  it("preTaxPenaltyBaseInto and hsaWithdrawFrom", () => {
    const out = new Float64Array(2);
    const hw = new Float64Array(HW_REC);
    const ref = new Float64Array(HW_REC);
    for (const amount of [-1, 0, 1, 16737.5]) {
      for (const early of [0, 0.25, 1]) {
        for (const [employer, separated] of [[false, false], [true, false], [true, true]] as const) {
          preTaxPenaltyBaseInto(amount, early, employer, separated, out, 1);
          expect(float64Bits(out[1]!)).toBe(float64Bits(preTaxPenaltyBase(amount, early, employer, separated)));
        }
        for (const qualified of [-3, 0, 500.25, 1e6]) {
          hsaWithdraw(amount, qualified, early, ref);
          hsaWithdrawFrom(Float64Array.of(9, amount), Float64Array.of(9, qualified), Float64Array.of(9, early), 1, hw);
          expect(bits(hw)).toEqual(bits(ref));
        }
      }
    }
  });

  it("employeePayrollTaxFrom and contributionLimitsFrom at months / 12, on the real program table", () => {
    const t = pathTables(loadTaxData(), { startYear: 2026, years: 30, inflation: 0.031 });
    const pt = new Float64Array(PT_REC);
    const ref = new Float64Array(PT_REC);
    const cl = new Float64Array(CL_REC);
    const clRef = new Float64Array(CL_REC);
    const wages = new Float64Array(3);
    for (let y = 0; y < 30; y += 7) {
      const o = progOffset(y);
      for (const months of MONTHS) {
        for (const [w0, w1] of [[0, 0], [-10, 5000], [120000.37, 60000], [400000, 300000]] as const) {
          for (const status of [0, 1] as const) {
            wages[1] = w0;
            wages[2] = w1;
            employeePayrollTaxFrom(t.prog, o, wages, 1, status, months, pt);
            employeePayrollTaxInto(t.prog, o, w0, w1, status, months / 12, ref);
            expect(bits(pt)).toEqual(bits(ref));
          }
        }
        for (const age of [0, 49, 50, 55, 61, 64, 70]) {
          contributionLimitsFrom(t.prog, o, age, months, true, months, cl);
          contributionLimitsInto(t.prog, o, age, months / 12, true, months, clRef);
          expect(bits(cl)).toEqual(bits(clRef));
        }
      }
    }
  });

  it("taxableYieldsFrom reads the TYI record", () => {
    const drag = new Float64Array(8);
    blendTaxDrag(compileTaxDrag(), Float64Array.of(6839, 2632, 0, 529, 0, 0), 0, assetClassMapRows(), drag, 0);
    const x = new Float64Array(1 + TYI_REC);
    const ty = new Float64Array(TY_REC);
    const ref = new Float64Array(TY_REC);
    for (const [billRef, f, stock, bond, sb, bb] of [[0.042, 1, 500000, 200000, 300000, 190000], [-0.02, 2 / 12, 1234.5, 99.25, 2000, 50], [0.07, 0.5, 0, 0, 0, 0]] as const) {
      x[1 + TYI.BILL_REF] = billRef;
      x[1 + TYI.YEAR_FRACTION] = f;
      x[1 + TYI.STOCK] = stock;
      x[1 + TYI.BOND] = bond;
      x[1 + TYI.STOCK_BASIS] = sb;
      x[1 + TYI.BOND_BASIS] = bb;
      taxableYieldsFrom(drag, 0, x, 1, ty);
      taxableYieldsInto(drag, 0, billRef, f, stock, bond, sb, bb, ref);
      expect(bits(ty)).toEqual(bits(ref));
    }
  });

  it("socialSecurityYearFrom: thirty years of a couple with the earnings test, a death and the survivor benefit, record and state bit for bit", () => {
    const people = [
      { mode: "estimate", birthYear: 1962, birthMonth: 7, monthlyAtFra: 2400, asOfYear: 2026, claimAgeMonths: 744 },
      { mode: "estimate", birthYear: 1964, birthMonth: 3, monthlyAtFra: 900, asOfYear: 2026, claimAgeMonths: 816 },
    ] as const;
    const plan = compileSsPlan(people, { spousal: true, survivor: true, startYear: 2026 });
    const t = pathTables(loadTaxData(), { startYear: 2026, years: 30, inflation: 0.027 });
    const a = new Float64Array(SS_REC);
    const b = new Float64Array(SS_REC);
    resetSsState(plan, a);
    resetSsState(plan, b);
    const deaths = Float64Array.of(2041, Number.POSITIVE_INFINITY);
    const wages = new Float64Array(4);
    const outA = new Float64Array(SO_REC);
    const outB = new Float64Array(SO_REC);
    let withheld = 0;
    let survivor = 0;
    for (let i = 0; i < 30; i++) {
      const y = 2026 + i;
      const start = i === 0 ? y * 12 + 10 : y * 12;
      const months = i === 0 ? 2 : 12;
      const w0 = i < 6 ? 41000.5 + 1000 * i : 0;
      const w1 = i < 9 ? 52000.25 : 0;
      wages[2] = w0;
      wages[3] = w1;
      socialSecurityYear(plan, a, y, start, months, t.prog, progOffset(i), deaths[0]!, deaths[1]!, w0, w1, outA);
      socialSecurityYearFrom(plan, b, y, start, months, t.prog, progOffset(i), deaths, wages, 2, outB);
      expect(bits(outB), `${y}`).toEqual(bits(outA));
      expect(bits(b), `${y} state`).toEqual(bits(a));
      withheld += outA[SO.WITHHELD]! + outA[SO.WITHHELD + 1]!;
      survivor += outA[SO.SURVIVOR + 1]!;
    }
    // The case reaches the rules it is meant to: the earnings test withheld, and the widow's benefit was paid.
    expect(withheld).toBeGreaterThan(0);
    expect(survivor).toBeGreaterThan(0);
  });
});

describe("the loop's forms of the settlement and the surplus deposit", () => {
  it("fillNeedsFor and settleSpendingFor give fillNeeds and settleSpending (shortfall, target and gross years)", () => {
    const s = createSettleInput();
    for (const gross of [Number.NaN, 80000.5]) {
      const d = createSpendDecision();
      d.spend = 60000.25;
      d.floor = 40000;
      d.lump = 1500.5;
      d.lumpFloor = 1500.5;
      d.planned = 62000;
      d.gross = gross;
      for (const f of [2 / 12, 0.5, 1]) {
        for (const net of [-100000, -12.5, 0, 734.21]) {
          for (const rmd of [0, 9000.5, 120000]) {
            for (const drawdown of [false, true]) {
              const a = createSpendingOutcome();
              const b = createSpendingOutcome();
              settleSpending(d, f, drawdown, net, rmd, a);
              s.yearFraction = f;
              s.drawdown = drawdown;
              s.net = net;
              s.rmdTotal = rmd;
              settleSpendingFor(d, s, b);
              expect(b).toEqual(a);
              fillNeeds(d, f, a);
              fillNeedsFor(d, s, b);
              expect(b).toEqual(a);
            }
          }
        }
      }
    }
  });

  it("depositAtWeightsFrom deposits amounts[at] as depositAtWeights deposits the amount", () => {
    const w = Float64Array.of(0.6, 0.3, 0.1);
    for (const taxable of [false, true]) {
      const balA = Float64Array.of(1, 2, 3, 100.5, 200.25, 300);
      const basisA = Float64Array.of(1, 1, 1, 50, 60, 70);
      const balB = Float64Array.from(balA);
      const basisB = Float64Array.from(basisA);
      depositAtWeights(balA, basisA, 3, w, 0, 1234.567, taxable);
      depositAtWeightsFrom(balB, basisB, 3, w, 0, Float64Array.of(0, 1234.567), 1, taxable);
      expect(bits(balB)).toEqual(bits(balA));
      expect(bits(basisB)).toEqual(bits(basisA));
    }
    expect(() => depositAtWeightsFrom(new Float64Array(3), new Float64Array(3), 0, w, 0, Float64Array.of(-1), 0, false)).toThrow(/deposit/);
  });
});
