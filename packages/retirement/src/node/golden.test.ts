import type { ReturnModelConfigInput, SimInput } from "@meridian/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunSummary, addChunk, createRunSummary } from "../aggregate.js";
import type { SimOutput } from "../facade.js";
import { W, ZERO_YIELDS } from "../loopTestKit.js";
import { prepare } from "../prepare.js";
import { float64Bits } from "../selftest.js";
import { createProductionState, simulateChunk, simulateRun } from "../simulate.js";
import { simulatePath as simulatePathInto } from "../loop.js";
import { account, buildSimInput } from "../testing/index.js";
import { type SimPool, createSimPool, runSimulation } from "./index.js";

// T41 (engine-and-returns §7): golden runs, and chunk and thread invariance (L5).
//
// The T20 household: born 1962, fixed age 94 (Y = 30, 2027 to 2056), 40,000 real from 1,000,000
// in one Roth account at 60/40, no tax (yields 0; a Roth with every withdrawal free), a plan from
// January 2027 (the design's asOf 2027-01-01, f = 1), seed "20261110" (§7: "Seed 20261110
// throughout"). Every run goes through the public facade, `runSimulation` from
// "@meridian/retirement/node", so it uses the production hooks (the strategies' decideSpending and
// the default withdrawal order) and the real tax functions; the lifetime tax of every path is 0.
//
// The design's success counts are the portable assertions, and every one comes out as designed,
// as do the Wilson bounds, the percentiles and path 0's bit patterns (1599167.000970203, bits
// 413866bf003f954e; 670698.7676922221). Build step 20 measured other counts (1,846, 1,732, 8,780,
// 6,846) because its runs used the builder's default seed 1, not 20261110: the design is right.
//
// The digests are NOT the design's (c2b4dbe3, cae5b0c5, 4db78afd, dd3a637f, 5b7fc1d7, 6b3b946c).
// They came from the reference prototype, which is gone (docs/phase-4-plan.md, "Scratch material
// lost"); its ending nominal wealth differs from this engine's in the last bits of some paths
// (for example the default withdrawal order and the stub order already differ there on 202 of the
// first row's 2,000 paths, with every count, failure year and path 0 equal). As the design
// prescribes, they are pinned ONCE from this implementation (build step 21, ENGINE_VERSION 1.0.0,
// DATA_VERSION 2026.11.0) and change only with one of those versions. They held unchanged through
// DATA_VERSION 2026.11.1 (the 2027 plan limits: these households make no contributions) and the
// review fixes of ENGINE_VERSION 1.0.1 (none of them alters a household that is retired from the
// plan's start and pays no tax).

const t20 = (returnModel: ReturnModelConfigInput, paths: number): SimInput =>
  buildSimInput({
    people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 94 } }],
    accounts: [account("roth", "roth", "100000000", { allocation: W(6000, 0, 4000, 0) })],
    spending: { baseAnnualCents: "4000000" },
    returnModel,
    paths,
    seed: 20261110,
    tax: ZERO_YIELDS,
  });

const BOOT10 = { kind: "bootstrap", meanBlockYears: 10 } as const;

/** Path 0's ending wealth in today's dollars, simulated alone on the production state. */
function path0(input: SimInput): number {
  const run = prepare(input);
  const ps = createProductionState(run);
  simulatePathInto(ps, 0);
  return ps.endReal;
}

function sameArray(a: ArrayBufferView, b: ArrayBufferView): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function summariesEqual(a: RunSummary, b: RunSummary): void {
  for (const key of Object.keys(a) as Array<keyof RunSummary>) {
    const x = a[key];
    const y = b[key];
    if (ArrayBuffer.isView(x) && ArrayBuffer.isView(y)) expect(sameArray(x, y), String(key)).toBe(true);
    else expect(x, String(key)).toEqual(y);
  }
}

/** Everything a run outputs except its wall-clock timing, byte for byte. */
function outputsEqual(a: SimOutput, b: SimOutput, what: string): void {
  expect(b.paths, what).toBe(a.paths);
  expect(b.successPaths, what).toBe(a.successPaths);
  for (const key of ["endingRealCents", "depletionYear", "lifetimeTaxRealCents", "lifetimeSpendingRealCents"] as const) {
    expect(sameArray(a[key], b[key]), `${what}: ${key}`).toBe(true);
  }
  expect(b.summary, what).toEqual(a.summary);
  expect(b.fan, what).toEqual(a.fan);
  expect(b.warnings, what).toEqual(a.warnings);
}

describe("T41 golden runs through runSimulation (threads 0)", () => {
  it("T41 bootstrap, mean block 10, 2,000 paths: 1,848 succeed; Wilson [0.911556, 0.934818]; p10 / median / p90 = 92,319.12 / 1,612,693.34 / 4,666,633.54; path 0 bits 413866bf003f954e; digest d35dba24 (re-pinned)", async () => {
    const input = t20(BOOT10, 2000);
    const out = await runSimulation(input, { threads: 0 });
    expect(out.paths).toBe(2000);
    expect(out.successPaths).toBe(1848);
    // Wilson's bounds at the boundary in basis points, half away from zero (C44): 9115.56 → 9116, 9348.18 → 9348.
    expect(out.summary.successCi95Bp).toEqual([9116, 9348]);
    expect(out.summary.endingWealthReal.p10).toBe("9231912");
    expect(out.summary.endingWealthReal.p50).toBe("161269334");
    expect(out.summary.endingWealthReal.p90).toBe("466663354");
    expect(path0(input)).toBe(1599167.000970203);
    expect(float64Bits(path0(input))).toBe("413866bf003f954e");
    expect(out.endingRealCents[0]).toBe(159916700n);
    // No tax anywhere: a Roth with yields 0.
    expect(out.lifetimeTaxRealCents.every((c) => c === 0n)).toBe(true);
    expect(out.summary.digest).toBe("d35dba24");
  }, 60_000);

  it("T41 bootstrap, mean block 5, 2,000 paths: 1,857 succeed; digest ad40b925 (re-pinned)", async () => {
    const out = await runSimulation(t20({ kind: "bootstrap", meanBlockYears: 5 }, 2000), { threads: 0 });
    expect(out.successPaths).toBe(1857);
    expect(out.summary.digest).toBe("ad40b925");
  }, 60_000);

  it("T41 parametric, preset historical, 2,000 paths: 1,766 succeed; path 0 endReal 670698.7676922221; digest 93f5ee99 (re-pinned)", async () => {
    const input = t20({ kind: "parametric", preset: "historical" }, 2000);
    const out = await runSimulation(input, { threads: 0 });
    expect(out.successPaths).toBe(1766);
    expect(path0(input)).toBe(670698.7676922221);
    expect(out.summary.digest).toBe("93f5ee99");
  }, 60_000);

  it("T41 parametric, preset historical, 10,000 paths: 8,753 succeed; Wilson [0.868680, 0.881632]; median 1,506,275.14; p10 0; digest c45a84b8 (re-pinned)", async () => {
    const out = await runSimulation(t20({ kind: "parametric", preset: "historical" }, 10_000), { threads: 0 });
    expect(out.paths).toBe(10_000);
    expect(out.successPaths).toBe(8753);
    // 8686.80 → 8687, 8816.32 → 8816.
    expect(out.summary.successCi95Bp).toEqual([8687, 8816]);
    expect(out.summary.endingWealthReal.p50).toBe("150627514");
    expect(out.summary.endingWealthReal.p10).toBe("0");
    expect(out.summary.digest).toBe("c45a84b8");
  }, 120_000);

  it("T41 parametric, preset conservative, 10,000 paths: 6,858 succeed; median 381,115.41; digest a473e8ba (re-pinned)", async () => {
    const out = await runSimulation(t20({ kind: "parametric", preset: "conservative" }, 10_000), { threads: 0 });
    expect(out.successPaths).toBe(6858);
    expect(out.summary.endingWealthReal.p50).toBe("38111541");
    expect(out.summary.digest).toBe("a473e8ba");
  }, 120_000);

  it("T41 historical, complete: 69 paths, 65 succeed; digest 886d0ed8 (re-pinned)", async () => {
    // settings.paths is at least 100; the historical model replaces it with the 69 complete cohorts (C6).
    const out = await runSimulation(t20({ kind: "historical", cohorts: "complete" }, 100), { threads: 0 });
    expect(out.paths).toBe(69);
    expect(out.successPaths).toBe(65);
    expect(out.summary.successCi95Bp).toBeUndefined();
    expect(out.summary.digest).toBe("886d0ed8");
  }, 60_000);
});

describe("T41 the first row is the same for any chunking and any thread count (L5)", () => {
  const input = t20(BOOT10, 2000);
  const run = prepare(input);
  let reference: SimOutput;
  const pools: SimPool[] = [];

  beforeAll(async () => {
    reference = await runSimulation(input, { threads: 0 });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.close()));
  });

  it("T41 (a) inline in one chunk, (b) in chunks of 250 forward and (c) in chunks of 7 in reverse order give the same run summary bit for bit", () => {
    const one = simulateRun(run, createProductionState(run));
    const by250 = simulateRun(run, createProductionState(run), 250);
    const reverse = createRunSummary(run);
    const ps = createProductionState(run);
    const starts: number[] = [];
    for (let s = 0; s < run.paths; s += 7) starts.push(s);
    for (const s of starts.reverse()) addChunk(reverse, simulateChunk(run, s, Math.min(7, run.paths - s), ps));
    summariesEqual(one, by250);
    summariesEqual(one, reverse);
  }, 60_000);

  it("T41 (e) threads 0 with chunks of 1, 7, 250 (the default), 333 and 2,000 give the same output", async () => {
    for (const chunkPaths of [1, 7, 333, 2000]) {
      outputsEqual(reference, await runSimulation(input, { threads: 0, chunkPaths }), `inline, chunks of ${chunkPaths}`);
    }
    expect(reference.summary.digest).toBe("d35dba24");
    expect(reference.timing.threads).toBe(0);
  }, 120_000);

  for (const threads of [1, 2, 3]) {
    it(`T41 (d) a pool of ${threads} thread${threads === 1 ? "" : "s"}, with chunks of 7, 250 and 333, gives the same output as threads 0`, async () => {
      const pool = createSimPool({ threads });
      pools.push(pool);
      for (const chunkPaths of [250, 7, 333]) {
        const out = await pool.run(input, { chunkPaths });
        outputsEqual(reference, out, `${threads} threads, chunks of ${chunkPaths}`);
        expect(out.timing.threads).toBe(threads);
      }
      expect(pool.liveWorkers).toBe(threads);
    }, 120_000);
  }
});
