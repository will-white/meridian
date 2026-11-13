import { describe, expect, it } from "vitest";
import { seedKey } from "../rng.js";
import { compileReturnModel, createMarketPath } from "./index.js";

// Build step 13: the test-only `fixed` model (engine-and-returns decision 30, §3.5 (a), §7 T15's
// fixed-model line; seams C3, C6, C14, C18).

const KEY = seedKey(1);
const rows = [
  { stocksPpm: 100000, bondsPpm: 40000, billsPpm: 30000, inflationPpm: 30000 },
  { stocksPpm: -50000, bondsPpm: 20000, billsPpm: 20000, inflationPpm: 25000 },
];

describe("the fixed model", () => {
  it("plan year t uses row min(t, length − 1); ppm are divided by 1,000,000 once", () => {
    const model = compileReturnModel({ kind: "fixed", series: rows }, { key: KEY, years: 4, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true });
    const out = createMarketPath(4);
    model.fillPath(0, out);
    expect(Array.from(out.growth)).toEqual([1.1, 1.04, 1.03, 0.95, 1.02, 1.02, 0.95, 1.02, 1.02, 0.95, 1.02, 1.02]);
    expect(Array.from(out.priceFactor)).toEqual([1.03, 1.025, 1.025, 1.025]);
    expect(Array.from(out.inflationFull)).toEqual([0.03, 0.025, 0.025, 0.025]);
    expect(Array.from(out.billsFull)).toEqual([0.03, 0.02, 0.02, 0.02]);
    // C18: the year-0 bond-interest reference is row 0's bill rate.
    expect(model.billRef0).toBe(0.03);
  });

  it("C6: one path when every life expectancy is fixed (path_count_adjusted), the requested count otherwise", () => {
    const fixedLives = compileReturnModel({ kind: "fixed", series: rows }, { key: KEY, years: 4, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true });
    expect(fixedLives.paths).toBe(1);
    expect(fixedLives.summary).toEqual({ kind: "fixed", requestedPaths: 100 });
    expect(fixedLives.warnings.map((w) => w.code)).toEqual(["path_count_adjusted"]);
    expect(() => fixedLives.fillPath(1, createMarketPath(4))).toThrow(RangeError);
    const drawn = compileReturnModel({ kind: "fixed", series: rows }, { key: KEY, years: 4, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: false });
    expect(drawn.paths).toBe(100);
    expect(drawn.warnings).toEqual([]);
    const a = createMarketPath(4);
    const b = createMarketPath(4);
    drawn.fillPath(0, a);
    drawn.fillPath(99, b);
    expect(Array.from(a.growth)).toEqual(Array.from(b.growth));
  });

  it("T15 fixed model with f = 2/12: 1.10^(2/12) = 1.016011867773 (re-derived; the design's 52/365 gives 1.013671042)", () => {
    // (1.10)^(1/6) = e^(ln 1.1 / 6) = e^0.015885025 = 1.016011867773; inflation 1.03^(1/6) = 1.004938622031
    // (60-digit decimals, scratchpad p4-rng/deriv.py). With no dispersion the year-0 rule is plain compounding.
    const series = [{ stocksPpm: 100000, bondsPpm: 0, billsPpm: 0, inflationPpm: 30000 }];
    const model = compileReturnModel({ kind: "fixed", series }, { key: KEY, years: 3, firstYearMonths: 2, requestedPaths: 100, allFixedLongevity: true });
    const out = createMarketPath(3);
    model.fillPath(0, out);
    expect(out.growth[0]).toBeCloseTo(1.016011867773, 12);
    expect(out.priceFactor[0]).toBeCloseTo(1.004938622031, 12);
    expect(out.growth[1]).toBe(1);
    // A zero rate stays exactly 1 in the part year; later years are the row's own factors.
    expect([out.growth[3], out.growth[6], out.priceFactor[1], out.inflationFull[0]]).toEqual([1.1, 1.1, 1.03, 0.03]);
    const design = compileReturnModel({ kind: "fixed", series }, { key: KEY, years: 3, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true });
    design.fillPath(0, out);
    expect(out.growth[0]).toBe(1.1);
  });
});
