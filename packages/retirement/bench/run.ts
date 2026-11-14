/**
 * The engine's performance measurement (engine-and-returns §3.15; seams F13 and §9 item 18).
 *
 *   pnpm --filter @meridian/retirement bench [-- --paths 10000] [--threads 3] [--json] [--out DIR]
 *
 * Runs in its own process (an always-on GC or timing assertion inside Vitest would measure Vitest's
 * own transforms and allocations). Everything runs on the production hooks and the real tax, RMD,
 * Social Security, payroll and limit functions. It reports, for the reference workload of §3.15
 * (`benchWorkloadInput`: two people, Y = 60, seven accounts, the parametric and bootstrap models):
 *
 * - microseconds per path-year on one thread (inline, after a 300-path warm-up);
 * - `assess` calls per path-year and the most in any one year, and federal tax evaluations per
 *   path-year (counted on a 2,000-path run through wrapping hooks, timed separately);
 * - garbage collections during 2,000 paths after a 300-path warm-up (a `PerformanceObserver`);
 * - wall time on `--threads` threads (default 3) and on the default thread count, pool start and
 *   aggregation included, from a bundled thread entry (esbuild, as production bundles the worker's
 *   `simThread.js`) and, for comparison, from the tsx dev entry;
 *
 * and for the inputs fixture (`fixtureSimInput`, default run settings: bootstrap, 10,000 paths):
 * the inline wall time and microseconds per path-year, and the wall time on `--threads` threads.
 *
 * Budget (§3.15): at most 5 µs per path-year on one thread, at most 2 s wall on three threads, at
 * most 24 `assess` calls in any year, at most 6 tax evaluations per path-year on average, no
 * garbage collection during the simulate phase. `--json` prints the figures for `perf.test.ts`.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtureSimInput } from "@meridian/shared/src/retirement/testFixtures.js";
import type { ReturnModelConfigInput, SimInput } from "@meridian/shared";
import { build } from "esbuild";
import {
  type AssessFn,
  type EngineHooks,
  type PreparedRun,
  TAX_FUNCTIONS,
  type TaxFunctions,
  aggregate,
  createEngineHooks,
  createPathState,
  createProductionState,
  prepare,
  simulateChunk,
  simulateRun,
} from "../src/index.js";
import { createSimPool, defaultThreads, runSimulation } from "../src/node/index.js";
import { BENCH_MODELS, benchWorkloadInput } from "../src/testing/index.js";

interface Args {
  paths: number;
  threads: number;
  json: boolean;
  out: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { paths: 10_000, threads: 3, json: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--paths") args.paths = Number(value());
    else if (a === "--threads") args.threads = Number(value());
    else if (a === "--json") args.json = true;
    else if (a === "--out") args.out = value();
    else if (a === "--") continue;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** Path-years simulated: Σ (endIdx + 1). */
function pathYears(summary: { endIdx: Int16Array }): number {
  let n = 0;
  for (let k = 0; k < summary.endIdx.length; k++) n += summary.endIdx[k]! + 1;
  return n;
}

interface OneThread {
  paths: number;
  pathYears: number;
  ms: number;
  usPerPathYear: number;
  /** `aggregate` of the run summary on the calling thread (part of every run's wall time). */
  aggregateMs: number;
}

function oneThread(run: PreparedRun): OneThread {
  const ps = createProductionState(run);
  simulateChunk(run, 0, Math.min(300, run.paths), ps); // warm-up
  const t0 = performance.now();
  const summary = simulateRun(run, ps);
  const ms = performance.now() - t0;
  const py = pathYears(summary);
  const t1 = performance.now();
  aggregate(run, summary);
  return { paths: run.paths, pathYears: py, ms, usPerPathYear: (ms * 1000) / py, aggregateMs: performance.now() - t1 };
}

interface Counts {
  assessCallsPerPathYear: number;
  maxAssessCallsInAYear: number;
  taxEvaluationsPerPathYear: number;
}

/** Counts `assess` calls (the hook's) and `federalTaxInto` calls (every evaluation: the hook's, the baseline and the record). */
function counts(run: PreparedRun, paths: number): Counts {
  const inner = createEngineHooks();
  let calls = 0;
  let maxCalls = 0;
  let taxCalls = 0;
  let yearCalls = 0;
  const counting: AssessFn = (w, out) => {
    yearCalls++;
    calls++;
    current(w, out);
  };
  let current: AssessFn = () => undefined;
  const hooks: EngineHooks = {
    decideSpending: (view, state, out) => inner.decideSpending(view, state, out),
    planWithdrawals: (view, decision, assess, w) => {
      current = assess;
      yearCalls = 0;
      inner.planWithdrawals(view, decision, counting, w);
      if (yearCalls > maxCalls) maxCalls = yearCalls;
    },
  };
  const tax: TaxFunctions = {
    ...TAX_FUNCTIONS,
    federalTaxInto: (t, o, x, r) => {
      taxCalls++;
      TAX_FUNCTIONS.federalTaxInto(t, o, x, r);
    },
  };
  const ps = createPathState(run, hooks, tax);
  const summary = simulateChunk(run, 0, Math.min(paths, run.paths), ps);
  const py = pathYears(summary);
  return { assessCallsPerPathYear: calls / py, maxAssessCallsInAYear: maxCalls, taxEvaluationsPerPathYear: taxCalls / py };
}

/** Garbage collections during `paths` paths after a 300-path warm-up. */
async function gcDuring(run: PreparedRun, paths: number): Promise<{ paths: number; gcCount: number; gcMs: number }> {
  const ps = createProductionState(run);
  simulateChunk(run, 0, 300, ps);
  await new Promise((r) => setImmediate(r));
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  simulateChunk(run, 300, Math.min(paths, run.paths - 300), ps);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
  entries.push(...observer.takeRecords());
  observer.disconnect();
  return { paths, gcCount: entries.length, gcMs: entries.reduce((s, e) => s + e.duration, 0) };
}

/** A self-contained bundle of the thread entry, as the worker app ships `simThread.js` (C10). */
async function bundledThreadEntry(outDir: string): Promise<URL> {
  const outfile = join(outDir, "simThread.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/node/threadEntry.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    logLevel: "warning",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  return pathToFileURL(outfile);
}

async function wall(input: SimInput, threads: number, threadEntry?: URL): Promise<Wall> {
  const t0 = performance.now();
  const out = await runSimulation(input, { threads, ...(threadEntry === undefined ? {} : { threadEntry }) });
  return { threads, ms: performance.now() - t0, usedThreads: out.timing.threads };
}

/** A second run on a pool that is already started: what a Phase 5 grid pays per run after the first (F6). */
async function warmPoolWall(input: SimInput, threads: number, threadEntry: URL): Promise<number> {
  const pool = createSimPool({ threads, threadEntry });
  try {
    await pool.run(input);
    const t0 = performance.now();
    await pool.run(input);
    return performance.now() - t0;
  } finally {
    await pool.close();
  }
}

interface Wall {
  threads: number;
  ms: number;
  usedThreads: number;
}

interface ModelReport {
  years: number;
  oneThread: OneThread;
  counts: Counts;
  gc: { paths: number; gcCount: number; gcMs: number };
  wallBundled: Wall;
  wallDefaultThreads: Wall;
  wallDevEntry: Wall;
  warmPoolWallMs: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ?? mkdtempSync(join(tmpdir(), "meridian-bench-"));
  mkdirSync(outDir, { recursive: true });
  const entry = await bundledThreadEntry(outDir);

  const workload: Record<string, ModelReport> = {};
  for (const [name, model] of Object.entries(BENCH_MODELS) as Array<[string, ReturnModelConfigInput]>) {
    const input = benchWorkloadInput(model, args.paths);
    const run = prepare(input);
    workload[name] = {
      years: run.years,
      oneThread: oneThread(run),
      counts: counts(run, 2000),
      gc: await gcDuring(run, 2000),
      wallBundled: await wall(input, args.threads, entry),
      wallDefaultThreads: await wall(input, defaultThreads(), entry),
      wallDevEntry: await wall(input, args.threads),
      warmPoolWallMs: await warmPoolWall(input, args.threads, entry),
    };
  }

  const fixture = fixtureSimInput();
  const fixtureRun = prepare(fixture);
  const fixtureInline = await wall(fixture, 0);
  const fixtureReport = {
    paths: fixtureRun.paths,
    years: fixtureRun.years,
    model: fixture.settings.returnModel,
    oneThread: oneThread(fixtureRun),
    inlineWallMs: fixtureInline.ms,
    wallBundled: await wall(fixture, args.threads, entry),
  };

  const report = {
    node: process.version,
    parallelism: (await import("node:os")).availableParallelism(),
    defaultThreads: defaultThreads(),
    paths: args.paths,
    workload,
    fixture: fixtureReport,
  };
  if (args.json) {
    console.log(JSON.stringify(report));
    return;
  }
  const f = (x: number, d = 2) => x.toFixed(d);
  console.log(`Node ${report.node}, ${report.parallelism} processors, default threads ${report.defaultThreads}`);
  for (const [name, w] of Object.entries(workload)) {
    const o = w.oneThread;
    const c = w.counts;
    const g = w.gc;
    const b = w.wallBundled;
    const d = w.wallDefaultThreads;
    console.log(
      `reference workload, ${name}: ${o.paths} paths × ${w.years} years; one thread ${f(o.ms, 0)} ms, ${f(o.usPerPathYear)} µs per path-year, aggregation ${f(o.aggregateMs, 0)} ms; ` +
        `assess ${f(c.assessCallsPerPathYear)} calls per path-year (at most ${c.maxAssessCallsInAYear} in a year), ${f(c.taxEvaluationsPerPathYear)} tax evaluations per path-year; ` +
        `${g.gcCount} GCs (${f(g.gcMs)} ms) over ${g.paths} paths after warm-up; wall ${f(b.ms, 0)} ms on ${b.usedThreads} threads (bundled entry), ` +
        `${f(d.ms, 0)} ms on ${d.usedThreads}, ${f(w.wallDevEntry.ms, 0)} ms on ${b.usedThreads} with the tsx dev entry, ${f(w.warmPoolWallMs, 0)} ms for a second run on a started pool`,
    );
  }
  const fo = fixtureReport.oneThread;
  console.log(
    `inputs fixture: ${fo.paths} paths × ${fixtureReport.years} years (${fo.pathYears} path-years); inline ${f(fixtureReport.inlineWallMs, 0)} ms wall, ` +
      `${f(fo.usPerPathYear)} µs per path-year, aggregation ${f(fo.aggregateMs, 0)} ms; ${f(fixtureReport.wallBundled.ms, 0)} ms wall on ${fixtureReport.wallBundled.usedThreads} threads`,
  );
}

await main();
