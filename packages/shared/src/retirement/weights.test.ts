import { describe, expect, it } from "vitest";
import { ClassWeights } from "./primitives.js";
import { classWeights, glideWeightsAt } from "./weights.js";

const w = (us_stock: number, intl_stock: number, bonds: number, cash: number, real_estate = 0, other = 0) => ({
  us_stock,
  intl_stock,
  bonds,
  cash,
  real_estate,
  other,
});

describe("4. weights (inputs-and-data §3.4 R4)", () => {
  it("4 classWeights of the design's three splits", () => {
    // 1,850,000 / 712,000 / 0 / 143,200 of 2,705,200: 6838.68, 2631.96, 0, 529.35 → floors 9998;
    // the two largest remainders (.96 intl, .68 US) take the spare points.
    expect(classWeights({ us_stock: 1_850_000n, intl_stock: 712_000n, bonds: 0n, cash: 143_200n, real_estate: 0n, other: 0n })).toEqual(w(6839, 2632, 0, 529));
    expect(classWeights({ us_stock: 851_800n, intl_stock: 151_200n, bonds: 790_000n, cash: 27_000n, real_estate: 0n, other: 0n })).toEqual(w(4680, 831, 4341, 148));
    // 3,134,300 / 863,200 / 790,000 / 170,200 of 4,957,700: 6322.08, 1741.13, 1593.48, 343.30 → floors 9999; bonds takes the spare point.
    expect(classWeights({ us_stock: 3_134_300n, intl_stock: 863_200n, bonds: 790_000n, cash: 170_200n, real_estate: 0n, other: 0n })).toEqual(w(6322, 1741, 1594, 343));
  });

  it("4 all zero → undefined; a negative class → undefined; missing classes count as 0", () => {
    expect(classWeights({ us_stock: 0n, intl_stock: 0n, bonds: 0n, cash: 0n, real_estate: 0n, other: 0n })).toBeUndefined();
    expect(classWeights({})).toBeUndefined();
    expect(classWeights({ us_stock: 1_000n, cash: -1n })).toBeUndefined();
    expect(classWeights({ bonds: 7n })).toEqual(w(0, 0, 10000, 0));
  });

  it("4 every result is a valid ClassWeights", () => {
    const r = classWeights({ us_stock: 1n, intl_stock: 1n, bonds: 1n, cash: 1n, real_estate: 1n, other: 1n });
    // 10000 / 6 = 1666.67 each: floors 9996, the four spare points go to the lowest indices on the tie.
    expect(r).toEqual(w(1667, 1667, 1667, 1667, 1666, 1666));
    expect(ClassWeights.safeParse(r).success).toBe(true);
  });
});

describe("17. glide weights (inputs-and-data §3.9, seams C29)", () => {
  const p2030 = { year: 2030, weights: w(6000, 2000, 1500, 500) };
  const p2033 = { year: 2033, weights: w(4000, 1000, 4000, 1000) };
  const p2040 = { year: 2040, weights: w(4000, 1000, 4000, 1000) };

  it("17 2031 between 2030 and 2033: 5333 / 1667 / 2333 / 667", () => {
    // d 1, span 3: raw 16000, 5000, 7000, 2000 of 30000 → 5333.33, 1666.67, 2333.33, 666.67;
    // floors 9998; the two .67 remainders (intl, cash) take the spare points.
    expect(glideWeightsAt([p2030, p2033], 2031)).toEqual(w(5333, 1667, 2333, 667));
  });

  it("17 2033 between 2030 and 2040: 5400 / 1700 / 2250 / 650 exactly", () => {
    // d 3, span 10: 6000×7 + 4000×3 = 54000, 2000×7 + 1000×3 = 17000, 1500×7 + 4000×3 = 22500, 500×7 + 1000×3 = 6500 of 100000.
    expect(glideWeightsAt([p2030, p2040], 2033)).toEqual(w(5400, 1700, 2250, 650));
  });

  it("17 before the first point and after the last the end points apply; a point's own year gives its weights", () => {
    expect(glideWeightsAt([p2030, p2040], 2026)).toEqual(p2030.weights);
    expect(glideWeightsAt([p2030, p2040], 2030)).toEqual(p2030.weights);
    expect(glideWeightsAt([p2030, p2040], 2040)).toEqual(p2040.weights);
    expect(glideWeightsAt([p2030, p2040], 2072)).toEqual(p2040.weights);
    expect(glideWeightsAt([p2030], 2050)).toEqual(p2030.weights);
    const three = [p2030, { year: 2035, weights: w(5000, 1500, 3000, 500) }, { year: 2045, weights: w(2000, 1000, 6000, 1000) }];
    expect(glideWeightsAt(three, 2035)).toEqual(w(5000, 1500, 3000, 500));
    // 2040 is halfway from 2035 to 2045: (5000 + 2000) / 2 …
    expect(glideWeightsAt(three, 2040)).toEqual(w(3500, 1250, 4500, 750));
  });

  it("17 the result is a fresh, valid ClassWeights; bad paths throw", () => {
    const r = glideWeightsAt([p2030, p2040], 2026);
    expect(r).not.toBe(p2030.weights);
    for (let year = 2028; year <= 2042; year++) expect(ClassWeights.safeParse(glideWeightsAt([p2030, p2033, p2040], year)).success).toBe(true);
    expect(() => glideWeightsAt([], 2030)).toThrow(RangeError);
    expect(() => glideWeightsAt([p2033, p2030], 2031)).toThrow(/ascending/);
    expect(() => glideWeightsAt([p2030, { ...p2030 }], 2031)).toThrow(/ascending/);
    expect(() => glideWeightsAt([p2030, p2040], 2031.5)).toThrow(RangeError);
  });
});
