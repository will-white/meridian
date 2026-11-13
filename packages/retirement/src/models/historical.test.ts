import type { ReturnModelConfig } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { EngineInputError } from "../errors.js";
import { US_BILLS, US_BONDS, US_INFLATION, US_STOCKS } from "../generated/data.js";
import { compileMortality } from "../mortality.js";
import { seedKey } from "../rng.js";
import { buildHistoryTable } from "./history.js";
import { cohortFor, planCohorts } from "./historical.js";
import { US_SERIES } from "./series.js";
import { compileReturnModel, createMarketPath } from "./index.js";

// Build step 13: historical cohorts and the first-partial-year rule (engine-and-returns §3.5 (b) and
// the year-0 rule, §7 T12, T15; seams C6, C14, C28; plan decision 7). Expected values are the
// design's unless a comment re-derives them (seams §10: T12's mortality rows end at maxAge, T15's
// 52/365 part becomes 2/12 for a November start).

const KEY = seedKey(20261110);
const N = 98;
const plan = (cohorts: "auto" | "complete" | "wrap", years: number, allFixedLongevity: boolean, requestedPaths = 10000) =>
  planCohorts({ cohorts, years, allFixedLongevity, requestedPaths, dataYears: N, firstDataYear: 1928 });
const historical = (cohorts: "auto" | "complete" | "wrap"): ReturnModelConfig => ({ kind: "historical", cohorts });

describe("T12 cohort mapping and path counts (N = 98)", () => {
  it("T12 fixed mortality, Y = 30 → complete, 69 cohorts, start years 1928–1996, 69 paths, path_count_adjusted for 10,000", () => {
    const p = plan("auto", 30, true);
    expect([p.mode, p.cohortCount, p.firstStartYear, p.lastStartYear, p.paths, p.replicates]).toEqual(["complete", 69, 1928, 1996, 69, 1]);
    const model = compileReturnModel(historical("auto"), { key: KEY, years: 30, firstYearMonths: 12, requestedPaths: 10000, allFixedLongevity: true });
    expect(model.paths).toBe(69);
    expect(model.summary).toEqual({ kind: "historical", requestedPaths: 10000, cohortMode: "complete", cohortCount: 69, firstStartYear: 1928, lastStartYear: 1996 });
    expect(model.warnings.map((w) => w.code)).toEqual(["path_count_adjusted"]);
    expect(model.warnings[0]!.message).toContain("69 paths instead of the 10,000 requested");
  });

  it("T12 Y = 61 → complete, 38 cohorts (1928–1965); Y = 75 → auto wraps, 98 cohorts", () => {
    expect([plan("auto", 61, true).mode, plan("auto", 61, true).cohortCount, plan("auto", 61, true).lastStartYear]).toEqual(["complete", 38, 1965]);
    const p75 = plan("auto", 75, true);
    expect([p75.mode, p75.cohortCount, p75.paths]).toEqual(["wrap", 98, 98]);
    // 30 complete cohorts is the least auto accepts: Y = 69 gives exactly 30, Y = 70 gives 29 and wraps.
    expect(plan("auto", 69, true).mode).toBe("complete");
    expect(plan("auto", 70, true).mode).toBe("wrap");
  });

  it("T12 Y = 99 with cohorts 'complete' → historical_horizon_too_long; with 'wrap' → 98 paths", () => {
    let caught: unknown;
    try {
      plan("complete", 99, true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineInputError);
    expect((caught as EngineInputError).code).toBe("historical_horizon_too_long");
    expect(plan("wrap", 99, true).paths).toBe(98);
    // Y = 98 still has one complete cohort.
    expect(plan("complete", 98, true).cohortCount).toBe(1);
  });

  it("T12 path 45 with 69 cohorts → cohort 1973; path 114 → cohort 1973, replicate 1", () => {
    const p = plan("auto", 30, true);
    expect(cohortFor(p, 45)).toEqual({ startIndex: 45, startYear: 1973, replicate: 0, wrapped: false });
    expect(cohortFor(p, 114)).toEqual({ startIndex: 45, startYear: 1973, replicate: 1, wrapped: false });
  });

  it("T12 wrap, start index 92, Y = 8 → 2020, 2021, 2022, 2023, 2024, 2025, 1928, 1929 and the wrapped flag", () => {
    const model = compileReturnModel(historical("wrap"), { key: KEY, years: 8, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true });
    const out = createMarketPath(8);
    model.fillPath(92, out);
    expect(Array.from(out.sampledYear)).toEqual([2020, 2021, 2022, 2023, 2024, 2025, 1928, 1929]);
    expect([out.cohortStartYear, out.replicate, out.wrapped]).toEqual([2020, 0, true]);
    model.fillPath(90, out);
    expect(out.wrapped).toBe(false);
    // 98 paths run for the 100 requested, so the count is reported as adjusted too.
    expect(model.warnings.map((w) => w.code)).toEqual(["historical_wrapped", "path_count_adjusted"]);
    expect(model.warnings[0]!.message).toContain("after 2025 a path continues from 1928");
  });

  // Table mortality (seams C28, re-derived per §10). The design's rows assumed a horizon to the end of
  // an SSA table with M = 119 (Y = 56); the horizon now ends in the year maxAge is attained. A person
  // born 1962 with a plan starting January 2027 is 65 in plan year 0, so with the profile's default
  // maxAge 110 the last possible death is 1962 + 110 − 2027 = 45 and Y = 46.
  const born1962 = (maxAge: number) =>
    compileMortality([{ birthYear: 1962, longevity: { mode: "mortality", sex: "female", adjustYears: 0, maxAge } }], { startYear: 2027, firstYearMonths: 12 });

  it("T12 table mortality, born 1962, start 2027, maxAge 110 (Y = 46): auto → wrap, 98 cohorts × 103 = 10,094 paths", () => {
    const mort = born1962(110);
    expect(mort.years).toBe(46);
    expect(mort.allFixed).toBe(false);
    const model = compileReturnModel(historical("auto"), { key: KEY, years: mort.years, firstYearMonths: 12, requestedPaths: 10000, allFixedLongevity: mort.allFixed });
    // ceil(10000 / 98) = 103 (98 × 102 = 9,996 < 10,000); 98 × 103 = 10,094.
    expect([model.cohorts!.mode, model.cohorts!.cohortCount, model.cohorts!.replicates, model.paths]).toEqual(["wrap", 98, 103, 10094]);
    // Path 10,093: 10,093 mod 98 = 97 → start year 2025; floor(10,093 / 98) = 102.
    const out = createMarketPath(46);
    model.fillPath(10093, out);
    expect([out.cohortStartYear, out.replicate, out.wrapped]).toEqual([2025, 102, true]);
    expect(() => model.fillPath(10094, out)).toThrow(RangeError);
  });

  it("T12 table mortality, maxAge 110: explicit complete → 53 cohorts (1928–1980) × 189 = 10,017 paths", () => {
    // Complete cohorts: 98 − 46 + 1 = 53, start years 1928 … 1980; ceil(10000 / 53) = 189
    // (53 × 188 = 9,964 < 10,000); 53 × 189 = 10,017.
    const p = plan("complete", born1962(110).years, false);
    expect([p.mode, p.cohortCount, p.firstStartYear, p.lastStartYear, p.replicates, p.paths]).toEqual(["complete", 53, 1928, 1980, 189, 10017]);
  });

  it("T12 table mortality, maxAge 110: pathCount = 500 → 588 paths (6 per cohort)", () => {
    // auto wraps under table mortality: ceil(500 / 98) = 6; 98 × 6 = 588.
    const p = plan("auto", born1962(110).years, false, 500);
    expect([p.mode, p.replicates, p.paths]).toEqual(["wrap", 6, 588]);
  });

  it("T12 table mortality, maxAge 119 (Y = 55): explicit complete → 44 cohorts (1928–1971) × 228 = 10,032 paths", () => {
    // Last possible death 1962 + 119 − 2027 = 54, Y = 55; 98 − 55 + 1 = 44 cohorts; ceil(10000 / 44) = 228
    // (44 × 227 = 9,988); 44 × 228 = 10,032.
    const y = born1962(119).years;
    expect(y).toBe(55);
    const p = plan("complete", y, false);
    expect([p.cohortCount, p.lastStartYear, p.replicates, p.paths]).toEqual([44, 1971, 228, 10032]);
  });
});

describe("historical paths replay whole data rows", () => {
  it("T19's cohort: path 45 of 94 complete cohorts (Y = 5) is 1973–1977 with the rows' own factors", () => {
    const model = compileReturnModel(historical("complete"), { key: KEY, years: 5, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true });
    expect(model.cohorts!.cohortCount).toBe(94);
    const out = createMarketPath(5);
    model.fillPath(45, out);
    expect(Array.from(out.sampledYear)).toEqual([1973, 1974, 1975, 1976, 1977]);
    // 1973: stocks −14.3080%, bonds 3.6587%, inflation 8.7059% (T19's first row).
    expect([out.growth[0], out.growth[1], out.priceFactor[0]]).toEqual([1 + -0.14308, 1 + 0.036587, 1 + 0.087059]);
    for (let t = 0; t < 5; t++) {
      const i = 45 + t;
      expect([out.growth[t * 3], out.growth[t * 3 + 1], out.growth[t * 3 + 2], out.priceFactor[t]]).toEqual([
        1 + US_STOCKS[i]!,
        1 + US_BONDS[i]!,
        1 + US_BILLS[i]!,
        1 + US_INFLATION[i]!,
      ]);
      expect([out.billsFull[t], out.inflationFull[t]]).toEqual([US_BILLS[i], US_INFLATION[i]]);
    }
    expect(model.billRef0).toBe(0.0421);
    expect(model.warnings.map((w) => w.code)).toEqual(["path_count_adjusted"]);
    expect(model.warnings[0]!.message).toBe("The historical model runs one path per start year: 94 paths instead of the 100 requested.");
    // Asking for exactly the cohort count adjusts nothing.
    const exact = compileReturnModel(historical("complete"), { key: KEY, years: 5, firstYearMonths: 12, requestedPaths: 94, allFixedLongevity: true });
    expect(exact.warnings).toEqual([]);
  });

  it("a historical model with 100 requested paths and fixed lives runs one path per cohort, and no draw is used", () => {
    const a = compileReturnModel(historical("auto"), { key: KEY, years: 30, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true });
    const b = compileReturnModel(historical("auto"), { key: seedKey(1), years: 30, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true });
    const pa = createMarketPath(30);
    const pb = createMarketPath(30);
    a.fillPath(17, pa);
    b.fillPath(17, pb);
    expect(Array.from(pa.growth)).toEqual(Array.from(pb.growth));
  });
});

describe("T15 year-0 scaling of a history row", () => {
  it("T15 f = 2/12 (a November start), row 1973, the data's mean log returns (re-derived, seams §10)", () => {
    // The design's case is 52/365; under C14 it is f = firstYearMonths / 12 = 2/12, √f = 0.408248290464.
    // Stocks: x = ln(0.856920) = −0.154410713633, m = 0.095471251114; f·m = 0.015911875186;
    // √f·(x − m) = 0.408248290464 × (−0.249881964747) = −0.102013884926; log −0.086102009740;
    // factor e^−0.086102009740 = 0.917500632445. Bonds: x = ln(1.036587) = 0.035933585695,
    // log 0.007391296722 − 0.003435080575 = 0.003956216146 → 1.003964052300. Bills: x = ln(1.070354),
    // log 0.005526722241 + 0.014218921120 = 0.019745643360 → 1.019941878041. Price: x = ln(1.087059),
    // log 0.004984304195 + 0.021869885139 = 0.026854189334 → 1.027218012501. (60-digit decimals,
    // scratchpad p4-rng/deriv.py; the same script reproduces the design's 52/365 values 0.922456,
    // 1.003147, 1.018031, 1.024782.)
    const model = compileReturnModel(historical("complete"), { key: KEY, years: 2, firstYearMonths: 2, requestedPaths: 100, allFixedLongevity: true });
    expect(model.firstYearFraction).toBe(2 / 12);
    const out = createMarketPath(2);
    model.fillPath(45, out);
    expect(out.sampledYear[0]).toBe(1973);
    expect(out.growth[0]).toBeCloseTo(0.917500632445, 11);
    expect(out.growth[1]).toBeCloseTo(1.0039640523, 11);
    expect(out.growth[2]).toBeCloseTo(1.019941878041, 11);
    expect(out.priceFactor[0]).toBeCloseTo(1.027218012501, 11);
    // The full-year rates of year 0 stay the row's (C22's indexInflation, C18's bill reference).
    expect([out.inflationFull[0], out.billsFull[0]]).toEqual([0.087059, 0.070354]);
    // Year 1 (1974) is a full year: the row's own factors, exactly.
    expect([out.growth[3], out.growth[4], out.priceFactor[1]]).toEqual([1 + -0.259018, 1 + 0.019886, 1 + 0.123377]);
  });

  it("T15 with the design's f0 = 52/365 the rule gives 0.922456, 1.003147, 1.018031, 1.024782 (the formula check)", () => {
    const table = buildHistoryTable(US_SERIES, 52 / 365);
    const row = 45 * 4;
    expect(table.grossFirst[row]).toBeCloseTo(0.922456, 6);
    expect(table.grossFirst[row + 1]).toBeCloseTo(1.003147, 6);
    expect(table.grossFirst[row + 2]).toBeCloseTo(1.018031, 6);
    expect(table.grossFirst[row + 3]).toBeCloseTo(1.024782, 6);
  });

  it("T15 with f = 1 the factors are exactly the row's own (no exp/log round trip)", () => {
    const model = compileReturnModel(historical("complete"), { key: KEY, years: 2, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true });
    expect(model.firstYearFraction).toBe(1);
    const out = createMarketPath(2);
    model.fillPath(45, out);
    expect([out.growth[0], out.growth[1], out.growth[2], out.priceFactor[0]]).toEqual([1 + US_STOCKS[45]!, 1 + US_BONDS[45]!, 1 + US_BILLS[45]!, 1 + US_INFLATION[45]!]);
  });
});
