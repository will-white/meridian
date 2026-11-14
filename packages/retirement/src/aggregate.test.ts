import { rankIndex } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import {
  FAN_PERCENTILES_BP,
  type RunSummary,
  addChunk,
  aggregate,
  aliveCounts,
  createRunSummary,
  digest,
  fanBands,
  fanYearsShown,
  percentileIndex,
  percentilePaths,
  wilson95,
} from "./aggregate.js";
import { W, ZERO_YIELDS } from "./loopTestKit.js";
import { prepare } from "./prepare.js";
import { simulateChunk, simulateRun } from "./simulate.js";
import { createPathState } from "./state.js";
import { type SimInputOptions, account, buildSimInput } from "./testing/simInput.js";
import { noTaxInto, stubHooks, stubTaxFunctions } from "./testing/stubs.js";
import { createEngineHooks } from "./withdrawals/plan.js";
import { toFanSeries, toSimSummary } from "./results/summary.js";
import { dollarsToCentsBigInt } from "./units.js";

// Build step 20: aggregation (engine-and-returns §3.11, §3.12 with seams C9, C40, C41, F9).
// Expected values are the design's (§7, T35 to T38 and T40) unless a comment re-derives them.

const cents = (xs: readonly number[]) => BigInt64Array.from(xs.map((x) => BigInt(Math.round(x * 100))));
const NO_TAX = { federalTaxInto: noTaxInto };

describe("T35 percentile index (nearest rank)", () => {
  it("T35 the design's fourteen cases", () => {
    const cases: Array<[number, number, number]> = [
      [1000, 10000, 999],
      [5000, 10000, 4999],
      [9000, 10000, 8999],
      [1000, 98, 9],
      [5000, 98, 48],
      [9000, 98, 88],
      [0, 98, 0],
      [10000, 98, 97],
      [1000, 69, 6],
      [5000, 69, 34],
      [1000, 7, 0],
      [5000, 7, 3],
      [9000, 7, 6],
      [2500, 10094, 2523],
    ];
    for (const [p, n, expected] of cases) expect(percentileIndex(p, n), `${p} of ${n}`).toBe(expected);
  });

  it("T35 for a whole percentile it is the shared rankIndex (the one rank rule, C9)", () => {
    for (const n of [1, 2, 7, 69, 98, 99, 100, 101, 1000, 10094, 100000]) {
      for (let p = 0; p <= 100; p++) expect(percentileIndex(100 * p, n)).toBe(rankIndex(p, n));
    }
  });

  it("refuses a percentile outside 0 … 10000 bp and an empty set", () => {
    expect(() => percentileIndex(-1, 10)).toThrow(RangeError);
    expect(() => percentileIndex(10001, 10)).toThrow(RangeError);
    expect(() => percentileIndex(2.5, 10)).toThrow(RangeError);
    expect(() => percentileIndex(5000, 0)).toThrow(RangeError);
  });
});

describe("T36 ranking and percentile paths (shared rankPaths, C9)", () => {
  it("T36 seven paths → order [3, 1, 6, 2, 5, 0, 4]; p10, p50, p90 are paths 3, 2, 4 with 0, 120, 900", () => {
    const endReal = cents([500, 0, 120, 0, 900, 300, 0]);
    // failIdx [−1, 12, −1, 7, −1, −1, 20] as depletion years of a 2027 start.
    const depletion = Int16Array.from([-1, 12, -1, 7, -1, -1, 20].map((f) => (f < 0 ? -1 : 2027 + f)));
    const r = percentilePaths(endReal, depletion);
    expect(Array.from(r.order)).toEqual([3, 1, 6, 2, 5, 0, 4]);
    expect([r.percentilePathIndex[10], r.percentilePathIndex[50], r.percentilePathIndex[90]]).toEqual([3, 2, 4]);
    expect([r.endingWealthRealQuantiles[10], r.endingWealthRealQuantiles[50], r.endingWealthRealQuantiles[90]]).toEqual([0n, 12000n, 90000n]);
  });

  it("T36 ten paths, re-derived without the shortfall key (seams §10, C9): order [3, 1, 6, 7, 2, 5, 0, 9, 4, 8]", () => {
    // endReal [500000, 0, 250000, 0, 1200000, 250000, 0, 90000, 2000000, 700000], failIdx
    // [−1, 22, −1, 17, −1, −1, 22, 9, −1, −1]. The design's third key (the larger shortfall first,
    // which put path 6 before path 1) is removed by C9: among the paths that end with 0, path 3
    // (year 17) is worst, then paths 1 and 6 (both year 22) in index order. Path 7 broke its floor
    // in year 9 but ends with 90,000 and ranks by that wealth; paths 2 and 5 tie and keep index order.
    const endReal = cents([500000, 0, 250000, 0, 1200000, 250000, 0, 90000, 2000000, 700000]);
    const depletion = Int16Array.from([-1, 22, -1, 17, -1, -1, 22, 9, -1, -1].map((f) => (f < 0 ? -1 : 2027 + f)));
    const r = percentilePaths(endReal, depletion);
    expect(Array.from(r.order)).toEqual([3, 1, 6, 7, 2, 5, 0, 9, 4, 8]);
    // Nearest rank on 10 paths, index ceil(p × 10 / 100) − 1: p1 → 0, p10 → 0, p25 → 2, p50 → 4,
    // p75 → 7, p90 → 8, p99 → 9; [0] → 0, [100] → 9. Only p25 moves against the design (path 6,
    // not 1, at index 2 of the new order).
    const at = (p: number) => r.percentilePathIndex[p];
    expect([at(1), at(10), at(25), at(50), at(75), at(90), at(99), at(0), at(100)]).toEqual([3, 3, 6, 2, 9, 4, 8, 3, 8]);
    r.percentilePathIndex.forEach((k, p) => expect(r.endingWealthRealQuantiles[p]).toBe(endReal[k]));
  });
});

describe("T37 Wilson interval", () => {
  it("T37 the design's six cases to six decimals", () => {
    const cases: Array<[number, number, number, number]> = [
      [8700, 10000, 0.863266, 0.87645],
      [9865, 10000, 0.984044, 0.988582],
      [9257, 10000, 0.920395, 0.930678],
      [30, 100, 0.218949, 0.395849],
      [10000, 10000, 0.999616, 1],
      [0, 50, 0, 0.071348],
    ];
    for (const [k, n, lo, hi] of cases) {
      const [a, b] = wilson95(k, n);
      expect(a, `${k} of ${n}`).toBeCloseTo(lo, 6);
      expect(b, `${k} of ${n}`).toBeCloseTo(hi, 6);
    }
    // Clamped exactly at the ends.
    expect(wilson95(10000, 10000)[1]).toBe(1);
    expect(wilson95(0, 50)[0]).toBe(0);
  });
});

describe("T38 fan chart with deaths", () => {
  // Four paths over four years, NaN after a path's end.
  const rows = [
    [100, 110, 120, 130],
    [90, 80, NaN, NaN],
    [100, 100, 100, NaN],
    [50, 40, 30, 20],
  ];
  const matrix = Float64Array.from(rows.flat());
  const endIdx = Int16Array.from([3, 1, 2, 3]);

  it("T38 alive counts 4, 4, 3, 2", () => {
    expect(aliveCounts(endIdx, 4)).toEqual([4, 4, 3, 2]);
  });

  it("T38 p10 / p25 / p50 / p75 / p90 by year", () => {
    const expected = [
      [50, 50, 90, 100, 100],
      [40, 40, 80, 100, 110],
      [30, 30, 100, 120, 120],
      [20, 20, 20, 130, 130],
    ];
    const bands = fanBands(matrix, endIdx, 4);
    expect(bands.length).toBe(FAN_PERCENTILES_BP.length);
    expected.forEach((year, t) => year.forEach((v, j) => expect(bands[j]![t], `year ${t}, band ${j}`).toBe(BigInt(v * 100))));
  });

  it("a year with no value is null; a path's NaN in its own life (spending in accumulation) is skipped", () => {
    const m = Float64Array.from([NaN, 5, NaN, 7]);
    const bands = fanBands(m, Int16Array.from([1, 1]), 2);
    expect(bands.map((b) => b[0])).toEqual([null, null, null, null, null]);
    expect(bands.map((b) => b[1])).toEqual([500n, 500n, 500n, 700n, 700n]);
  });
});

describe("T40 digest (FNV-1a over little-endian bytes)", () => {
  it("T40 [1, 2.5] → 5dd3b45c; with failIdx [−1, 3] → a28ee979; empty → 811c9dc5", () => {
    expect(digest(Float64Array.from([1, 2.5]), new Int16Array(0))).toBe("5dd3b45c");
    expect(digest(Float64Array.from([1, 2.5]), Int16Array.from([-1, 3]))).toBe("a28ee979");
    expect(digest(new Float64Array(0), new Int16Array(0))).toBe("811c9dc5");
  });
});

describe("OUT-5 fan cut (strategies-outputs-web §3.10)", () => {
  it("OUT-5 1,000 paths with alive counts 1000, 400, 99 → two years; 69 paths all alive → no cut", () => {
    expect(fanYearsShown([1000, 400, 99], 1000)).toBe(2);
    expect(fanYearsShown(new Array<number>(30).fill(69), 69)).toBe(30);
    // The threshold is min(100, paths): 100 alive of 1,000 is still shown; one path alone is shown while alive.
    expect(fanYearsShown([1000, 100, 100, 0], 1000)).toBe(3);
    expect(fanYearsShown([1, 1, 0], 1)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the engine.

/** T20's household (engine-and-returns §7): fixed age 94 (Y = 30), 40,000 real from 1,000,000 at 60/40, no tax. */
function t20Input(returnModel: SimInputOptions["returnModel"], paths?: number) {
  return buildSimInput({
    people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 94 } }],
    accounts: [account("roth", "roth", "100000000", { allocation: W(6000, 0, 4000, 0) })],
    spending: { baseAnnualCents: "4000000" },
    ...(returnModel === undefined ? {} : { returnModel }),
    ...(paths === undefined ? {} : { paths }),
    tax: ZERO_YIELDS,
  });
}

function summariesEqual(a: RunSummary, b: RunSummary): void {
  for (const key of Object.keys(a) as Array<keyof RunSummary>) {
    const x = a[key];
    const y = b[key];
    if (ArrayBuffer.isView(x) && ArrayBuffer.isView(y)) {
      expect(Buffer.from(x.buffer, x.byteOffset, x.byteLength).equals(Buffer.from(y.buffer, y.byteOffset, y.byteLength)), String(key)).toBe(true);
    } else {
      expect(x, String(key)).toEqual(y);
    }
  }
}

describe("T20's household through the aggregate (historical, complete cycles)", () => {
  const run = prepare(t20Input({ kind: "historical", cohorts: "auto" }));
  const ps = createPathState(run, stubHooks(), stubTaxFunctions(NO_TAX));
  const result = aggregate(run, simulateRun(run, ps));

  it("69 paths, 65 succeed; Wilson is absent for the historical model; the failures by plan year and their years", () => {
    // T20: failing start years 1965, 1966, 1968, 1969 in plan years 27, 25, 27, 27 of a 2027 start.
    expect(result.paths).toBe(69);
    expect(result.successCount).toBe(65);
    expect(result.fullPlanCount).toBe(65);
    expect(result.successCi95).toBeNull();
    const counts = new Array<number>(30).fill(0);
    counts[25] = 1;
    counts[27] = 3;
    expect(result.failureYearCounts).toEqual(counts);
    expect(Array.from(result.depletionYear).filter((y) => y >= 0)).toEqual([2054, 2052, 2054, 2054]);
    const summary = toSimSummary(result, run.input);
    // First non-zero count in 2052; the running count reaches ceil(4 ÷ 2) = 2 in 2054.
    expect(summary.failure).toEqual({ paths: 4, byYear: counts, firstDepletionYear: 2052, medianDepletionYear: 2054 });
    expect(summary.successCi95Bp).toBeUndefined();
  });

  it("ending wealth p10 / median / p90 are T20's 156,910.48 (1967), 1,387,869.67 (1951), 3,865,589.65, and the percentile paths are those cohorts", () => {
    expect(result.endingWealthReal.p10).toBe(15691048n);
    expect(result.endingWealthReal.p50).toBe(138786967n);
    expect(result.endingWealthReal.p90).toBe(386558965n);
    expect(result.percentilePathIndex[10]).toBe(1967 - 1928);
    expect(result.percentilePathIndex[50]).toBe(1951 - 1928);
    // The four failed paths end with 0 and rank first, by depletion year: 1966 (plan year 25), then 1965, 1968, 1969.
    expect(Array.from(result.order.subarray(0, 4))).toEqual([1966 - 1928, 1965 - 1928, 1968 - 1928, 1969 - 1928]);
    expect(result.percentilePathIndex[0]).toBe(1966 - 1928);
    result.percentilePathIndex.forEach((k, p) => expect(result.endingWealthRealQuantiles[p]).toBe(result.endingRealCents[k]));
  });

  it("the series are the per-path values in cents (C46, F9); the mean is summed in path order", () => {
    const summary = simulateRun(run, ps);
    let mean = 0;
    for (let k = 0; k < 69; k++) {
      expect(result.endingRealCents[k]).toBe(dollarsToCentsBigInt(summary.endReal[k]!));
      expect(result.lifetimeTaxRealCents[k]).toBe(0n);
      expect(result.lifetimeSpendingRealCents[k]).toBe(dollarsToCentsBigInt(summary.spendReal[k]!));
      mean += summary.endReal[k]!;
    }
    expect(result.endingWealthReal.mean).toBe(dollarsToCentsBigInt(mean / 69));
    // Every path is alive for all 30 years: nothing is cut.
    expect(result.aliveCount).toEqual(new Array<number>(30).fill(69));
    expect(result.fanYears).toBe(30);
  });
});

describe("chunk and order invariance of the aggregate (L5)", () => {
  // Bootstrap with mean block 10, 600 paths, T20's household on the production hooks and tax functions.
  const run = prepare(t20Input({ kind: "bootstrap", meanBlockYears: 10 }, 600));
  const hooks = () => createPathState(run, createEngineHooks());

  it("one chunk, chunks of 250 forward, chunks of 7 in reverse order, and a reused state give the same summary and the same result", () => {
    const one = simulateRun(run, hooks());
    const by250 = simulateRun(run, hooks(), 250);
    const reverse = createRunSummary(run);
    const ps = hooks();
    const starts: number[] = [];
    for (let s = 0; s < run.paths; s += 7) starts.push(s);
    for (const s of starts.reverse()) addChunk(reverse, simulateChunk(run, s, Math.min(7, run.paths - s), ps));
    summariesEqual(one, by250);
    summariesEqual(one, reverse);
    const a = aggregate(run, one);
    const b = aggregate(run, reverse);
    expect(toSimSummary(b, run.input)).toEqual(toSimSummary(a, run.input));
    expect(toFanSeries(b)).toEqual(toFanSeries(a));
    expect(b.warnings).toEqual(a.warnings);
    expect(b.digest).toBe(a.digest);
  });

  it("the bootstrap result carries Wilson's interval and the success count it is computed from", () => {
    const result = aggregate(run, simulateRun(run, hooks()));
    expect(result.successCi95).toEqual(wilson95(result.successCount, 600));
    expect(result.successCount).toBeGreaterThan(400);
    expect(result.successCount).toBeLessThan(600);
  });

  it("refuses a summary that is not the whole run", () => {
    expect(() => aggregate(run, simulateChunk(run, 0, 10, hooks()))).toThrow(RangeError);
    // A chunk of a run with another horizon (fixed age 90: 26 plan years).
    const other = prepare(
      buildSimInput({
        people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 90 } }],
        accounts: [account("roth", "roth", "100000000", { allocation: W(6000, 0, 4000, 0) })],
        tax: ZERO_YIELDS,
      }),
    );
    expect(() => addChunk(createRunSummary(run), simulateChunk(other, 0, 1))).toThrow(RangeError);
    expect(() => simulateChunk(run, 595, 10, hooks())).toThrow(RangeError);
  });
});
