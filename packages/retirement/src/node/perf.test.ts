import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepare } from "../prepare.js";
import { BENCH_MODELS, benchWorkloadInput } from "../testing/index.js";
import { runSimulation } from "./index.js";

// T47 (engine-and-returns §7 and §3.15): the performance guard.
//
// Always: 500 paths × 60 years of the reference workload (`benchWorkloadInput`) inline under 5 s,
// on the production hooks and the real tax functions. It catches order-of-magnitude regressions
// only: under Vitest the engine runs about four times slower than in its own process.
//
// With PERF=1: the budget rows of §3.15, measured by `bench/run.ts` in its own process (an
// assertion on timings or garbage collections inside Vitest would measure Vitest's transforms and
// allocations). The budget is the design's; nothing here is adjusted to the code. As measured at
// build step 21 the time, call and evaluation rows hold and the garbage-collection row does not:
// the year loop with its hooks allocates about 120 bytes per path-year, the tax area's
// `fillPathTables` about 42 and the parametric model's `fillPath` another 158 (boxed doubles
// returned by calls V8 does not inline), so 2,000 paths after warm-up see a few minor collections
// (measured: parametric 2 to 4, bootstrap 0 or 1; docs/phase-4-plan.md, "Step 21"). That row stays
// red until the allocations are removed.

const PERF = process.env.PERF === "1";
const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));

describe("T47 performance guard", () => {
  it("T47 500 paths × 60 years of the reference workload inline under 5 s", async () => {
    const input = benchWorkloadInput(BENCH_MODELS.bootstrap, 500);
    expect(prepare(input).years).toBe(60);
    const t0 = performance.now();
    const out = await runSimulation(input, { threads: 0 });
    const ms = performance.now() - t0;
    expect(out.paths).toBe(500);
    expect(ms).toBeLessThan(5000);
  }, 30_000);
});

interface ModelReport {
  years: number;
  oneThread: { paths: number; pathYears: number; ms: number; usPerPathYear: number };
  counts: { assessCallsPerPathYear: number; maxAssessCallsInAYear: number; taxEvaluationsPerPathYear: number };
  gc: { paths: number; gcCount: number; gcMs: number };
  wallBundled: { threads: number; ms: number; usedThreads: number };
}

describe.skipIf(!PERF)("T47 with PERF=1: the budget rows of §3.15 (bench/run.ts in its own process)", () => {
  let dir = "";
  let workload: Record<string, ModelReport> = {};

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-bench-"));
    // `node --import tsx` rather than the tsx CLI, which opens an IPC pipe in the temporary directory.
    const args = ["--import", "tsx", "bench/run.ts", "--json", "--threads", "3", "--out", dir];
    const out = execFileSync(process.execPath, args, { cwd: PACKAGE_DIR, encoding: "utf8", timeout: 600_000 });
    workload = (JSON.parse(out.trim().split("\n").at(-1)!) as { workload: Record<string, ModelReport> }).workload;
  }, 620_000);

  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  for (const model of Object.keys(BENCH_MODELS)) {
    it(`T47 ${model}: 10,000 paths × 60 years on one thread at most 5 µs per path-year (3 s)`, () => {
      const w = workload[model]!;
      expect(w.years).toBe(60);
      expect(w.oneThread.paths).toBe(10_000);
      expect(w.oneThread.usPerPathYear).toBeLessThanOrEqual(5);
    });

    it(`T47 ${model}: at most 2 s wall on three threads, pool start and aggregation included`, () => {
      expect(workload[model]!.wallBundled.usedThreads).toBe(3);
      expect(workload[model]!.wallBundled.ms).toBeLessThanOrEqual(2000);
    });

    it(`T47 ${model}: at most 24 assess calls in any year and 6 tax evaluations per path-year on average`, () => {
      expect(workload[model]!.counts.maxAssessCallsInAYear).toBeLessThanOrEqual(24);
      expect(workload[model]!.counts.taxEvaluationsPerPathYear).toBeLessThanOrEqual(6);
    });

    it(`T47 ${model}: no garbage collection over 2,000 paths after a 300-path warm-up (not met at step 21)`, () => {
      expect(workload[model]!.gc.paths).toBe(2000);
      expect(workload[model]!.gc.gcCount).toBe(0);
    });
  }
});
