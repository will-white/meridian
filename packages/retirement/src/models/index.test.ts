import type { ReturnModelConfig } from "@meridian/shared";
import { DEFAULT_RETURN_MODEL } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { seedKey } from "../rng.js";
import { compileReturnModel, createMarketPath, firstYearFraction } from "./index.js";

// Build step 13: the compiled-model contract shared by the four kinds (seams C6, C14, C51).

const KEY = seedKey(1);
const opts = (years = 10, firstYearMonths = 12) => ({ key: KEY, years, firstYearMonths, requestedPaths: 300, allFixedLongevity: false });

const MODELS: ReturnModelConfig[] = [
  { kind: "historical", cohorts: "auto" },
  { kind: "bootstrap", meanBlockYears: 10 },
  { kind: "parametric", preset: "historical" },
  { kind: "parametric", preset: "conservative" },
  { kind: "fixed", series: [{ stocksPpm: 50000, bondsPpm: 30000, billsPpm: 20000, inflationPpm: 25000 }] },
];

describe("compileReturnModel", () => {
  it("C14: f = firstYearMonths / 12, with 12 months exactly 1; anything else outside 1 … 12 is refused", () => {
    expect([1, 2, 3, 6, 12].map(firstYearFraction)).toEqual([1 / 12, 2 / 12, 0.25, 0.5, 1]);
    for (const bad of [0, 13, 2.5]) expect(() => firstYearFraction(bad)).toThrow(RangeError);
  });

  it("C51: the default return model of a new scenario compiles (bootstrap, mean block 10)", () => {
    const model = compileReturnModel(DEFAULT_RETURN_MODEL, opts());
    expect(model.summary).toEqual({ kind: "bootstrap", requestedPaths: 300, meanBlockYears: 10 });
  });

  for (const config of MODELS) {
    const label = config.kind === "parametric" ? `parametric ${config.preset}` : config.kind;
    it(`${label}: a path depends only on (model, key, index); the year-0 factors follow f; everything is finite and positive`, () => {
      const full = compileReturnModel(config, opts());
      const part = compileReturnModel(config, opts(10, 3));
      const a = createMarketPath(10);
      const b = createMarketPath(10);
      const c = createMarketPath(10);
      full.fillPath(7, a);
      full.fillPath(3, b);
      full.fillPath(7, b);
      part.fillPath(7, c);
      expect(Array.from(b.growth)).toEqual(Array.from(a.growth));
      expect(Array.from(b.priceFactor)).toEqual(Array.from(a.priceFactor));
      // Only year 0 changes with f; the full-year rates of every year do not.
      expect(Array.from(c.growth.subarray(3))).toEqual(Array.from(a.growth.subarray(3)));
      expect(Array.from(c.inflationFull)).toEqual(Array.from(a.inflationFull));
      expect(Array.from(c.billsFull)).toEqual(Array.from(a.billsFull));
      for (const v of [...a.growth, ...a.priceFactor, ...c.growth, ...c.priceFactor]) expect(v > 0 && Number.isFinite(v)).toBe(true);
      // A part-year moves each factor toward 1 in log terms for the fixed model (no dispersion).
      if (config.kind === "fixed") expect(Math.log(c.growth[0]!)).toBeCloseTo(0.25 * Math.log(a.growth[0]!), 14);
      expect(() => full.fillPath(-1, a)).toThrow(RangeError);
      expect(() => full.fillPath(0, createMarketPath(9))).toThrow(RangeError);
    });
  }

  it("refuses a horizon outside 1 … 120 years and a path count below 1", () => {
    expect(() => compileReturnModel(MODELS[1]!, opts(0))).toThrow(RangeError);
    expect(() => compileReturnModel(MODELS[1]!, opts(121))).toThrow(RangeError);
    expect(() => compileReturnModel(MODELS[1]!, { ...opts(), requestedPaths: 0 })).toThrow(RangeError);
    expect(compileReturnModel(MODELS[1]!, opts(120)).years).toBe(120);
  });
});
