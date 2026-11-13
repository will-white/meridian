import { describe, expect, it } from "vitest";
import { RB, RB_REC, RW, RW_REC, TO } from "./layout.js";
import {
  addRothContribution,
  addRothConversion,
  mergeRothAtDeath,
  rothFiveYearMet,
  rothFreeAmount,
  rothRollYear,
  rothWithdraw,
  seedRoth,
} from "./rothBasis.js";
import { loadTaxData } from "./taxData.js";
import { pathTables, taxInput, taxOn } from "./testKit.js";

// tax-rmd-ss §3.7.3 and tests E4 to E8 and E10 (§7); rothFreeAmount of seams C34. Amounts are
// whole dollars and asserted exactly where the arithmetic is exact in float64, tax totals within
// 0.005 (tax-rmd-ss decision 50).

const published = pathTables(loadTaxData(), { startYear: 2026, years: 2 });
const near = (actual: number, expected: number, label = "") =>
  expect(Math.abs(actual - expected), `${label} ${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);

/** The five layers CONV0 … CONV4 of the record at `off`. */
const layers = (st: Float64Array, off = 0) => Array.from(st.subarray(off + RB.CONV0, off + RB.CONV4 + 1));

/** `rothWithdraw` on the record, returning [taxable, penaltyBase, fromBasis, fromConversions, fromEarnings]. */
function withdraw(st: Float64Array, amount: number, earlyFrac: number, year: number, off = 0): number[] {
  const out = new Float64Array(RW_REC);
  rothWithdraw(st, off, amount, earlyFrac, year, out);
  return Array.from(out);
}

/**
 * Runs a person's record from `from` through `to`: in each year the start-of-year roll (not in the
 * first year), then that year's conversion, if any.
 */
function runYears(st: Float64Array, from: number, to: number, conversions: Record<number, number>): void {
  for (let y = from; y <= to; y++) {
    if (y > from) rothRollYear(st, 0);
    const c = conversions[y];
    if (c !== undefined) addRothConversion(st, 0, c, y);
  }
}

/**
 * E4's state in 2030: regular contributions 30,000 (from 2018, so the clock is met), conversions of
 * 20,000 in 2024 and 15,000 in 2028. The 2024 layer joined BASIS_FREE on 1 January 2029 (2024 + 5);
 * the 2028 layer is CONV2 in 2030 (CONV4 in 2028, CONV3 in 2029).
 */
function e4State(): Float64Array {
  const st = new Float64Array(RB_REC);
  addRothContribution(st, 0, 30000, 2018);
  runYears(st, 2024, 2030, { 2024: 20000, 2028: 15000 });
  return st;
}

/** E5(d)'s state in 2027: BASIS_FREE 30,000, CONV0 20,000 (made 2023), CONV2 15,000 (made 2025). */
function e5dState(): Float64Array {
  const st = new Float64Array(RB_REC);
  addRothContribution(st, 0, 30000, 2015);
  runYears(st, 2023, 2027, { 2023: 20000, 2025: 15000 });
  return st;
}

describe("the RB record (§3.7.3)", () => {
  it("E4 the state is built by the yearly roll: BASIS_FREE 50,000 and the 2028 conversion in CONV2", () => {
    const st = e4State();
    expect(st[RB.BASIS_FREE]).toBe(50000);
    expect(layers(st)).toEqual([0, 0, 15000, 0, 0]);
    expect(st[RB.FIRST_YEAR]).toBe(2018);
    expect(rothFiveYearMet(st, 0, 2030)).toBe(true);
  });

  it("E5(d) the state is built by the yearly roll: BASIS_FREE 30,000, CONV0 20,000, CONV2 15,000", () => {
    const st = e5dState();
    expect(st[RB.BASIS_FREE]).toBe(30000);
    expect(layers(st)).toEqual([20000, 0, 15000, 0, 0]);
  });

  it("seeding: entered basis, empty layers, and an existing funded Roth's clock already met", () => {
    const st = new Float64Array(RB_REC).fill(7);
    seedRoth(st, 0, 25000, true, 2027);
    expect(Array.from(st)).toEqual([25000, 0, 0, 0, 0, 0, 2022, 0]);
    // FIRST_YEAR = 2027 − 5: met from the first plan year.
    expect(rothFiveYearMet(st, 0, 2027)).toBe(true);
    expect(rothFiveYearMet(st, 0, 2026)).toBe(false);
    // No funded account (absent or synthetic): the clock starts with the first in-plan funding.
    seedRoth(st, 0, 0, false, 2027);
    expect(st[RB.FIRST_YEAR]).toBe(0);
    expect(rothFiveYearMet(st, 0, 2040)).toBe(false);
    addRothContribution(st, 0, 0, 2027);
    expect(st[RB.FIRST_YEAR]).toBe(0);
    addRothContribution(st, 0, 1000, 2028);
    expect(st[RB.FIRST_YEAR]).toBe(2028);
    expect(st[RB.BASIS_FREE]).toBe(1000);
    // A later funding does not move the clock.
    addRothConversion(st, 0, 5000, 2029);
    expect(st[RB.FIRST_YEAR]).toBe(2028);
    expect(st[RB.CONV4]).toBe(5000);
  });
});

describe("E4 and E5 Roth ordering (Publication 590-B)", () => {
  it("E4 70,000 at 50 in 2030: 50,000 basis, 15,000 of the 2028 conversion, 5,000 earnings; taxable 5,000, base 20,000", () => {
    const st = e4State();
    expect(withdraw(st, 70000, 1, 2030)).toEqual([5000, 20000, 50000, 15000, 5000]);
    expect(st[RB.BASIS_FREE]).toBe(0);
    expect(layers(st)).toEqual([0, 0, 0, 0, 0]);
  });

  it("E4 in a 2026 single return with wages 50,000: AGI 55,000; taxable 38,900; 4,420 + 2,000 = 6,420.00", () => {
    const [taxable, base] = withdraw(e4State(), 70000, 1, 2030);
    // 38,900 − 12,400 = 26,500 at 12%: 1,240 + 3,180 = 4,420; additional tax 10% × 20,000.
    const r = taxOn(published, 2026, 0, taxInput({ WAGES: 50000, ROTH_TAXABLE: taxable!, PEN10_BASE: base! }));
    near(r[TO.AGI]!, 55000);
    near(r[TO.TAXABLE_INCOME]!, 38900);
    near(r[TO.INCOME_TAX]!, 4420);
    near(r[TO.PEN10]!, 2000);
    near(r[TO.TOTAL]!, 6420.0);
  });

  it("E5(a) at 60 (earlyFrac 0), FIRST_YEAR 2022: taxable 0, base 0", () => {
    const st = e4State();
    st[RB.FIRST_YEAR] = 2022;
    expect(withdraw(st, 70000, 0, 2030).slice(0, 2)).toEqual([0, 0]);
  });

  it("E5(b) at 60, FIRST_YEAR 2027 (2030 is before 2032): taxable 5,000, base 0", () => {
    const st = e4State();
    st[RB.FIRST_YEAR] = 2027;
    expect(withdraw(st, 70000, 0, 2030).slice(0, 2)).toEqual([5000, 0]);
  });

  it("E5(c) 59½ in July (earlyFrac 0.5), clock met: taxable 2,500, base 10,000", () => {
    expect(withdraw(e4State(), 70000, 0.5, 2030).slice(0, 2)).toEqual([2500, 10000]);
  });

  it("E5(d) 60,000 at 50 in 2027: 30,000 basis and 30,000 conversions; taxable 0, base 30,000 (additional tax 3,000)", () => {
    const st = e5dState();
    expect(withdraw(st, 60000, 1, 2027)).toEqual([0, 30000, 30000, 30000, 0]);
    expect(st[RB.BASIS_FREE]).toBe(0);
    // The oldest layer first: CONV0's 20,000, then 10,000 of CONV2's 15,000.
    expect(layers(st)).toEqual([0, 0, 5000, 0, 0]);
    near(taxOn(published, 2027, 0, taxInput({ PEN10_BASE: 30000 }))[TO.PEN10]!, 3000);
  });

  it("E5(e) 80,000 instead: 30,000 basis, 35,000 conversions, 15,000 earnings; taxable 15,000, base 50,000", () => {
    expect(withdraw(e5dState(), 80000, 1, 2027)).toEqual([15000, 50000, 30000, 35000, 15000]);
  });

  it("a withdrawal of 0 changes nothing; a record at an offset touches only its own slots", () => {
    const st = e4State();
    const before = Array.from(st);
    expect(withdraw(st, 0, 1, 2030)).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(st)).toEqual(before);
    const two = new Float64Array(2 * RB_REC);
    two.set(e4State(), 0);
    two.set(e5dState(), RB_REC);
    withdraw(two, 60000, 1, 2027, RB_REC);
    expect(Array.from(two.subarray(0, RB_REC))).toEqual(before);
    expect(layers(two, RB_REC)).toEqual([0, 0, 5000, 0, 0]);
  });
});

describe("E6 and E7 the five-year clock and the roll", () => {
  it("E6 a first conversion of 40,000 in 2027; in 2030 at 61 all 50,000 is withdrawn: taxable 10,000, base 0", () => {
    const st = new Float64Array(RB_REC);
    seedRoth(st, 0, 0, false, 2027);
    runYears(st, 2027, 2030, { 2027: 40000 });
    expect(st[RB.FIRST_YEAR]).toBe(2027);
    expect(layers(st)).toEqual([0, 40000, 0, 0, 0]);
    // 40,000 from the 2027 layer, 10,000 of earnings; 2030 < 2027 + 5, so the earnings are taxable.
    expect(withdraw(st, 50000, 0, 2030)).toEqual([10000, 0, 0, 40000, 10000]);
  });

  it("E6 the same withdrawal in 2032, after the roll has moved the layer into BASIS_FREE: taxable 0", () => {
    const st = new Float64Array(RB_REC);
    runYears(st, 2027, 2032, { 2027: 40000 });
    expect(st[RB.BASIS_FREE]).toBe(40000);
    expect(layers(st)).toEqual([0, 0, 0, 0, 0]);
    expect(withdraw(st, 50000, 0, 2032)).toEqual([0, 0, 40000, 0, 10000]);
  });

  it("E7 rothRollYear at the start of 2028 on E5(d)'s state: BASIS_FREE 50,000, layers 0, 15,000, 0, 0, 0", () => {
    const st = e5dState();
    rothRollYear(st, 0);
    expect(st[RB.BASIS_FREE]).toBe(50000);
    expect(layers(st)).toEqual([0, 15000, 0, 0, 0]);
    expect(st[RB.FIRST_YEAR]).toBe(2015);
  });
});

describe("E8 mergeRothAtDeath", () => {
  it("E8 survivor (10,000; 0, 0, 0, 0, 5,000; 2020) absorbs deceased (30,000; 0, 15,000, 0, 0, 0; 2015)", () => {
    const st = new Float64Array(2 * RB_REC);
    st.set([10000, 0, 0, 0, 0, 5000, 2020, 0], 0);
    st.set([30000, 0, 15000, 0, 0, 0, 2015, 0], RB_REC);
    mergeRothAtDeath(st, 0, RB_REC);
    expect(Array.from(st.subarray(0, RB_REC))).toEqual([40000, 0, 15000, 0, 0, 5000, 2015, 0]);
    // The decedent's record is emptied, so nothing is counted twice.
    expect(Array.from(st.subarray(RB_REC))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("E8 FIRST_YEAR is the smaller non-zero year", () => {
    const st = new Float64Array(2 * RB_REC);
    st[RB.FIRST_YEAR] = 0;
    st[RB_REC + RB.FIRST_YEAR] = 2015;
    mergeRothAtDeath(st, 0, RB_REC);
    expect(st[RB.FIRST_YEAR]).toBe(2015);
    st[RB_REC + RB.FIRST_YEAR] = 0;
    st[RB.FIRST_YEAR] = 2020;
    mergeRothAtDeath(st, 0, RB_REC);
    expect(st[RB.FIRST_YEAR]).toBe(2020);
    // The survivor at offset 8 absorbing a decedent at offset 0.
    st.fill(0);
    st.set([1000, 0, 0, 0, 0, 0, 2030, 0], 0);
    st.set([2000, 0, 0, 0, 0, 0, 2025, 0], RB_REC);
    mergeRothAtDeath(st, RB_REC, 0);
    expect(Array.from(st.subarray(RB_REC))).toEqual([3000, 0, 0, 0, 0, 0, 2025, 0]);
  });
});

describe("E10 a scheduled conversion", () => {
  it("E10 joint, both 62, 2026, pension 30,000: tax 0; with a 60,000 conversion 6,440.00, no additional tax, CONV4 60,000", () => {
    near(taxOn(published, 2026, 1, taxInput({ PENSION: 30000 }))[TO.TOTAL]!, 0);
    // AGI 90,000; taxable 90,000 − 32,200 = 57,800; 2,480 + 12% × (57,800 − 24,800 = 33,000) = 6,440.
    const r = taxOn(published, 2026, 1, taxInput({ PENSION: 30000, ROTH_CONV: 60000 }));
    near(r[TO.AGI]!, 90000);
    near(r[TO.TAXABLE_INCOME]!, 57800);
    near(r[TO.PEN10]!, 0);
    near(r[TO.TOTAL]!, 6440.0);
    const st = new Float64Array(RB_REC);
    addRothConversion(st, 0, 60000, 2026);
    expect(st[RB.CONV4]).toBe(60000);
    expect(st[RB.FIRST_YEAR]).toBe(2026);
  });
});

describe("C34 rothFreeAmount", () => {
  // E4's state in 2030 (BASIS_FREE 50,000; CONV2 15,000; clock met) with a Roth balance of 100,000.
  it("C34 early (any earlyFrac above 0): only BASIS_FREE, 50,000", () => {
    expect(rothFreeAmount(e4State(), 0, 100000, 1, 2030)).toBe(50000);
    expect(rothFreeAmount(e4State(), 0, 100000, 0.5, 2030)).toBe(50000);
  });

  it("C34 not early, clock met: everything, 100,000", () => {
    expect(rothFreeAmount(e4State(), 0, 100000, 0, 2030)).toBe(100000);
  });

  it("C34 not early, clock not met (FIRST_YEAR 2027): basis and conversions, 65,000; earnings are taxable", () => {
    const st = e4State();
    st[RB.FIRST_YEAR] = 2027;
    expect(rothFreeAmount(st, 0, 100000, 0, 2030)).toBe(65000);
  });

  it("C34 never more than the balance", () => {
    expect(rothFreeAmount(e4State(), 0, 40000, 1, 2030)).toBe(40000);
    const st = e4State();
    st[RB.FIRST_YEAR] = 2027;
    expect(rothFreeAmount(st, 0, 60000, 0, 2030)).toBe(60000);
    expect(rothFreeAmount(st, 0, 0, 0, 2030)).toBe(0);
  });

  it("C34 the strategies design's example: single, 57, 2027, Roth 80,000 with 30,000 of basis, 30,000 free", () => {
    const st = new Float64Array(RB_REC);
    seedRoth(st, 0, 30000, true, 2027);
    expect(rothFreeAmount(st, 0, 80000, 1, 2027)).toBe(30000);
  });
});

/** mulberry32: a small seeded generator for the property tests (deterministic, test only). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("properties of the ordering", () => {
  it("conservation, and the free amount is free while a cent more is not (2,000 seeded records)", () => {
    const next = rng(20261113);
    const out = new Float64Array(RW_REC);
    const whole = (max: number) => Math.round(next() * max);
    for (let i = 0; i < 2000; i++) {
      const st = new Float64Array(RB_REC);
      st[RB.BASIS_FREE] = whole(100000);
      for (let k = RB.CONV0; k <= RB.CONV4; k++) st[k] = next() < 0.5 ? 0 : whole(50000);
      st[RB.FIRST_YEAR] = next() < 0.2 ? 0 : 2020 + whole(10);
      const year = 2026 + whole(10);
      const balance = whole(400000);
      const earlyFrac = [0, 0, 1, 0.5, 2 / 12][whole(4)]!;
      const held = st[RB.BASIS_FREE]! + layers(st).reduce((s, v) => s + v, 0);

      // Withdrawing an arbitrary amount: the parts add up and the record falls by basis plus conversions.
      const amount = whole(balance);
      const copy = st.slice();
      rothWithdraw(copy, 0, amount, earlyFrac, year, out);
      expect(out[RW.FROM_BASIS]! + out[RW.FROM_CONVERSIONS]! + out[RW.FROM_EARNINGS]!).toBe(amount);
      const left = copy[RB.BASIS_FREE]! + layers(copy).reduce((s, v) => s + v, 0);
      expect(held - left).toBe(out[RW.FROM_BASIS]! + out[RW.FROM_CONVERSIONS]!);
      expect(copy[RB.FIRST_YEAR]).toBe(st[RB.FIRST_YEAR]);

      // The free amount leaves with no tax and no additional tax.
      const free = rothFreeAmount(st, 0, balance, earlyFrac, year);
      expect(free).toBeGreaterThanOrEqual(0);
      expect(free).toBeLessThanOrEqual(balance);
      rothWithdraw(st.slice(), 0, free, earlyFrac, year, out);
      expect(out[RW.TAXABLE]).toBe(0);
      expect(out[RW.PENALTY_BASE]).toBe(0);
      // A cent more costs something whenever the free amount is less than the balance.
      if (free < balance) {
        rothWithdraw(st.slice(), 0, free + 0.01, earlyFrac, year, out);
        expect(out[RW.TAXABLE]! + out[RW.PENALTY_BASE]!).toBeGreaterThan(0);
      }
    }
  });
});
