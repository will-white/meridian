import { describe, expect, it } from "vitest";
import { EngineInputError } from "../errors.js";
import { US_BILLS, US_INFLATION, US_STOCKS } from "../generated/data.js";
import { PURPOSE, seedKey, uniformAt } from "../rng.js";
import { bootstrapIndices } from "./bootstrap.js";
import { compileReturnModel, createMarketPath } from "./index.js";

// Build step 13: the stationary block bootstrap (engine-and-returns §3.5 (c), §7 T11; plan decision
// 6). Expected values are the design's; ref.py in scratchpad p4-rng (an independent Python
// implementation) reproduces every index and uniform below.

const KEY = seedKey(20261110);
const N = 98;
const years = (rows: Int16Array) => Array.from(rows, (i) => 1928 + i);

describe("T11 bootstrap index selection (N = 98, seed 20261110)", () => {
  it("T11 path 0, mean block 10 (p = 0.1): 2007–2014, a new block at 1982–1985, then 1974, 1975", () => {
    // Year 0: start uniform 0.810986 → floor(79.48) = 79 (2007). Years 1–7: decisions 0.622843,
    // 0.903712, 0.501262, 0.801991, 0.577918, 0.342818, 0.375882 are all ≥ 0.1 → next year. Year 8:
    // 0.073413 < 0.1, start 0.558246 → floor(54.71) = 54 (1982). Years 9–11: 0.144596, 0.370339,
    // 0.468951 → next. Year 12: 0.081533, start 0.474322 → floor(46.48) = 46 (1974). Year 13: 0.144629 → 1975.
    const rows = bootstrapIndices(KEY, 0, 14, N, 10);
    expect(Array.from(rows)).toEqual([79, 80, 81, 82, 83, 84, 85, 86, 54, 55, 56, 57, 46, 47]);
    expect(years(rows)).toEqual([2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 1982, 1983, 1984, 1985, 1974, 1975]);
    const decision = (t: number) => Number(uniformAt(KEY, 0, PURPOSE.BOOT, t, 0).toFixed(6));
    const start = (t: number) => Number(uniformAt(KEY, 0, PURPOSE.BOOT, t, 1).toFixed(6));
    expect([1, 2, 3, 4, 5, 6, 7].map(decision)).toEqual([0.622843, 0.903712, 0.501262, 0.801991, 0.577918, 0.342818, 0.375882]);
    expect([8, 9, 10, 11, 12, 13].map(decision)).toEqual([0.073413, 0.144596, 0.370339, 0.468951, 0.081533, 0.144629]);
    expect([0, 8, 12].map(start)).toEqual([0.810986, 0.558246, 0.474322]);
  });

  it("T11 path 0, mean block 5 (p = 0.2): the same through year 8; year 9 restarts at 1949 (0.144596 < 0.2, start 0.223205 → 21)", () => {
    const rows = bootstrapIndices(KEY, 0, 12, N, 5);
    expect(years(rows)).toEqual([2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 1982, 1949, 1950, 1951]);
    expect(Number(uniformAt(KEY, 0, PURPOSE.BOOT, 9, 1).toFixed(6))).toBe(0.223205);
  });

  it("T11 path 7, mean block 5: starts at 1938 (start uniform 0.111365 → 10) and runs unbroken through 1949", () => {
    expect(Number(uniformAt(KEY, 7, PURPOSE.BOOT, 0, 1).toFixed(6))).toBe(0.111365);
    expect(years(bootstrapIndices(KEY, 7, 12, N, 5))).toEqual([1938, 1939, 1940, 1941, 1942, 1943, 1944, 1945, 1946, 1947, 1948, 1949]);
  });

  it("T11 path 1, mean block 4, twelve years: *1980 1981 1982 1983 *2016 2017 … 2023", () => {
    // Year 0: start 0.531158 → 52 (1980); year 4: decision 0.077454 < 0.25, start 0.905000 → 88 (2016).
    expect(Number(uniformAt(KEY, 1, PURPOSE.BOOT, 0, 1).toFixed(6))).toBe(0.531158);
    expect(Number(uniformAt(KEY, 1, PURPOSE.BOOT, 4, 0).toFixed(6))).toBe(0.077454);
    expect(Number(uniformAt(KEY, 1, PURPOSE.BOOT, 4, 1).toFixed(6))).toBe(0.905);
    expect(years(bootstrapIndices(KEY, 1, 12, N, 4))).toEqual([1980, 1981, 1982, 1983, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023]);
  });

  it("T11 unit checks: index 97 with no restart is followed by index 0; mean block 1 restarts every year", () => {
    let wrapsSeen = 0;
    let broken = 0;
    const rows = new Int16Array(40);
    for (let path = 0; path < 2000; path++) {
      bootstrapIndices(KEY, path, 40, N, 30, rows);
      for (let t = 1; t < 40; t++) {
        if (uniformAt(KEY, path, PURPOSE.BOOT, t, 0) < 1 / 30) continue;
        if (rows[t] !== (rows[t - 1]! + 1) % N) broken++;
        if (rows[t - 1] === 97) wrapsSeen += rows[t] === 0 ? 1 : 0;
      }
    }
    expect(broken).toBe(0);
    expect(wrapsSeen).toBeGreaterThan(0);
    const one = bootstrapIndices(KEY, 3, 20, N, 1);
    for (let t = 0; t < 20; t++) expect(one[t]).toBe(Math.floor(uniformAt(KEY, 3, PURPOSE.BOOT, t, 1) * N));
  });

  it("the mean block length is a whole number 1 … 30 (mean_block_invalid otherwise)", () => {
    for (const bad of [0, 31, 2.5, Number.NaN]) {
      expect(() => bootstrapIndices(KEY, 0, 5, N, bad)).toThrow(EngineInputError);
    }
  });
});

describe("bootstrap market paths", () => {
  it("whole rows are resampled together: path 0 (mean block 10) year 1 is 2008 for every series", () => {
    const model = compileReturnModel({ kind: "bootstrap", meanBlockYears: 10 }, { key: KEY, years: 14, firstYearMonths: 12, requestedPaths: 10000, allFixedLongevity: false });
    expect(model.paths).toBe(10000);
    expect(model.summary).toEqual({ kind: "bootstrap", requestedPaths: 10000, meanBlockYears: 10 });
    expect(model.billRef0).toBe(0.0421);
    const out = createMarketPath(14);
    model.fillPath(0, out);
    expect(Array.from(out.sampledYear)).toEqual([2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 1982, 1983, 1984, 1985, 1974, 1975]);
    // 2008 is data row 80: stocks −36.5523%, bills 1.40%, inflation 0.0914%.
    expect([out.growth[3], out.growth[5], out.priceFactor[1]]).toEqual([1 + US_STOCKS[80]!, 1 + US_BILLS[80]!, 1 + US_INFLATION[80]!]);
    expect(out.growth[3]).toBe(1 - 0.365523);
    expect([out.cohortStartYear, out.wrapped]).toEqual([-1, false]);
  });

  it("common random numbers: a path's first years do not depend on the horizon", () => {
    const short = compileReturnModel({ kind: "bootstrap", meanBlockYears: 5 }, { key: KEY, years: 20, firstYearMonths: 12, requestedPaths: 500, allFixedLongevity: true });
    const long = compileReturnModel({ kind: "bootstrap", meanBlockYears: 5 }, { key: KEY, years: 60, firstYearMonths: 12, requestedPaths: 500, allFixedLongevity: false });
    const a = createMarketPath(20);
    const b = createMarketPath(60);
    for (const k of [0, 123, 499]) {
      short.fillPath(k, a);
      long.fillPath(k, b);
      expect(Array.from(a.growth)).toEqual(Array.from(b.growth.subarray(0, 60)));
      expect(Array.from(a.priceFactor)).toEqual(Array.from(b.priceFactor.subarray(0, 20)));
    }
  });
});
