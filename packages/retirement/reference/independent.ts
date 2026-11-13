// The independent calculator of Phase 4 step 22 (docs/design/phase-4/seams.md §11, plan decision 12).
//
// Written from the committed reference sheets alone (reference/sheets/r1.md to r4.md) by an
// implementer who has not read packages/retirement/src: its own transcription of every tax figure
// (independent/law.ts), its own trade and basis arithmetic and withdrawal tiers
// (independent/deterministic.ts), a bisection gross-up of 200 halvings, its own Social Security
// month loop (independent/socialSecurity.ts) and its own random number generator (mulberry32 with
// Box–Muller, independent/lognormal.ts). It imports nothing from src/; reference-sheets.test.ts
// scans for that.
//
// Run it as a script from packages/retirement:
//   node --import tsx reference/independent.ts            print the summary figures
//   node --import tsx reference/independent.ts --write    regenerate reference/fixtures/*.expected.*
//   node --import tsx reference/independent.ts --check    exit 1 when a fixture is stale
// (`--skip-r4` leaves out the 4,000,000-path run of R4.)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderCsv } from "./independent/columns.js";
import { runDeterministic, type RunResult } from "./independent/deterministic.js";
import {
  DATA_SHA256,
  cohortPath,
  parseReturns,
  percentileRank,
  rankOrder,
  R3_PLAN_YEARS,
  trinityWindowSucceeds,
  type CohortPath,
  type ReturnRow,
} from "./independent/historical.js";
import { lognormalParameters, R4_PARAMETERS, runLognormal, UNIFORMS_PER_PATH, type LognormalRun } from "./independent/lognormal.js";
import { cents, dollars2, money } from "./independent/money.js";
import { R1, R2 } from "./independent/scenarios.js";

export const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const RETURNS_CSV = fileURLToPath(new URL("../data/us-annual-returns.csv", import.meta.url));

export { renderCsv };

export const runR1 = (): RunResult => runDeterministic(R1);
export const runR2 = (): RunResult => runDeterministic(R2);

// ---------------------------------------------------------------------------------------------
// R3

export function loadReturns(path = RETURNS_CSV): { rows: ReturnRow[]; sha256: string } {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== DATA_SHA256) throw new Error(`${path}: SHA-256 ${sha256}, expected the pinned ${DATA_SHA256}`);
  return { rows: parseReturns(bytes.toString("utf8")), sha256 };
}

const R3_SAMPLE_YEARS = [1928, 1929, 1966, 1973, 1982] as const;

function r3Run(rows: readonly ReturnRow[], stockBp: number) {
  const share = stockBp / 10000;
  const n = rows.length - R3_PLAN_YEARS + 1; // complete cohorts: 98 − 30 + 1 = 69
  const paths: CohortPath[] = [];
  for (let k = 0; k < n; k++) paths.push(cohortPath(rows, k, share));
  const successPaths = paths.filter((p) => p.failIndex < 0).length;
  const order = rankOrder(
    paths.map((p) => cents(p.endReal)),
    paths.map((p) => p.failIndex),
  );
  const at = (pct: number): CohortPath => paths[order[percentileRank(pct, n)] as number] as CohortPath;
  return {
    stockBp,
    paths: n,
    firstStartYear: (paths[0] as CohortPath).startYear,
    lastStartYear: (paths[n - 1] as CohortPath).startYear,
    successPaths,
    successBp: Math.floor((successPaths * 10000) / n),
    failures: paths
      .filter((p) => p.failIndex >= 0)
      .map((p) => ({ startYear: p.startYear, failIndex: p.failIndex, shortfallReal: dollars2(p.shortfallReal) })),
    endingReal: {
      p10: dollars2(at(10).endReal),
      p50: dollars2(at(50).endReal),
      p90: dollars2(at(90).endReal),
      startYearOfEach: { p10: at(10).startYear, p50: at(50).startYear, p90: at(90).startYear },
    },
    samples: R3_SAMPLE_YEARS.map((y) => {
      const p = paths[y - 1928] as CohortPath;
      return { startYear: y, endNominal: dollars2(p.endNominal), cpiEnd: Number(p.cpiEnd.toFixed(6)), endReal: dollars2(p.endReal) };
    }),
    pathsDetail: paths.map((p) => ({
      startYear: p.startYear,
      failIndex: p.failIndex,
      shortfallReal: dollars2(p.shortfallReal),
      endNominal: dollars2(p.endNominal),
      endReal: dollars2(p.endReal),
    })),
    paths1966: paths[1966 - 1928] as CohortPath,
  };
}

export function runR3(path = RETURNS_CSV) {
  const { rows, sha256 } = loadReturns(path);
  const engineRuns = [5000, 7500].map((bp) => r3Run(rows, bp));
  const otherMixes = [10000, 2500, 0].map((bp) => {
    const r = r3Run(rows, bp);
    return { stockBp: bp, paths: r.paths, successPaths: r.successPaths };
  });
  const trinity = (bp: number, last: number) => {
    let successCount = 0;
    for (let k = 0; k <= last - 1928; k++) if (trinityWindowSucceeds(rows, k, bp / 10000)) successCount++;
    const windows = last - 1928 + 1;
    return { stockBp: bp, startYears: [1928, last] as const, windows, successCount, successRate: Number((successCount / windows).toFixed(4)) };
  };
  const p1966 = (engineRuns[0] as ReturnType<typeof r3Run>).paths1966;
  return {
    scenario: "R3",
    sheet: "packages/retirement/reference/sheets/r3.md",
    generatedBy: "packages/retirement/reference/independent.ts",
    dataFile: "packages/retirement/data/us-annual-returns.csv",
    dataSha256: sha256,
    units: "Money in dollars rounded half away from zero to the cent; failIndex is the plan-year index (0 = 2027), −1 for never; cpiEnd to six decimals.",
    plan: { startYear: 2027, planYears: R3_PLAN_YEARS, startBalance: 1_000_000, baseSpending: 40_000 },
    engineConvention: {
      description:
        "Complete cohorts, start years 1928 to 1996 (69 paths). At the start of each year 40,000 × cpi[t] is withdrawn (all that is left when short: the path fails), then the rebalanced account earns s × stocks + (1 − s) × bonds of the year's row, then cpi moves with the same row's inflation.",
      runs: engineRuns.map(({ paths1966: _omit, ...run }) => run),
      otherMixes,
    },
    trinityConvention: {
      description:
        "Start years 1928 to 1966 (39 windows of 30 years ending by 1995). Each year the balance first earns the year's return, then 40,000 × the price level at that year's end is withdrawn; a window fails when a withdrawal exceeds the balance.",
      runs: [5000, 7500, 10000, 2500, 0].map((bp) => trinity(bp, 1966)),
      onAll69Windows: [5000, 7500].map((bp) => trinity(bp, 1996)),
    },
    path1966: p1966.years.map((y) => ({
      dataYear: y.dataYear,
      startBalance: dollars2(y.start),
      need: dollars2(y.need),
      shortfall: dollars2(y.shortfall),
      portfolioReturn: y.portfolioReturn,
      endBalance: dollars2(y.end),
      inflation: y.inflation,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// R4

export const R4_SEED = 1;
export const R4_LARGE_PATHS = 4_000_000;
export const R4_SPREAD_RUNS = 40;
export const R4_SPREAD_PATHS = 10_000;

function summarize(run: LognormalRun) {
  const order = rankOrder(run.endRealCents, run.failIndex);
  const pct = (p: number): number => (run.endRealCents[order[percentileRank(p, run.paths)] as number] as number) / 100;
  return {
    successPaths: run.successPaths,
    successRate: run.successPaths / run.paths,
    p10: pct(10),
    p25: pct(25),
    p50: pct(50),
    p75: pct(75),
    p90: pct(90),
  };
}

/** Uniform offset of the spread run j: the blocks follow the large run's block in the one stream of the seed. */
export const r4SpreadOffset = (j: number): number => R4_LARGE_PATHS * UNIFORMS_PER_PATH + j * R4_SPREAD_PATHS * UNIFORMS_PER_PATH;

export function runR4SpreadRun(j: number) {
  return summarize(runLognormal(R4_SPREAD_PATHS, R4_SEED, r4SpreadOffset(j)));
}

export function runR4(largePaths = R4_LARGE_PATHS) {
  const large = summarize(runLognormal(largePaths, R4_SEED, 0));
  const perRun = Array.from({ length: R4_SPREAD_RUNS }, (_, j) => {
    const r = runR4SpreadRun(j);
    return { run: j, uniformOffset: r4SpreadOffset(j), successPaths: r.successPaths, successRate: r.successRate, medianEndingReal: r.p50 };
  });
  const rates = perRun.map((r) => r.successRate);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / (rates.length - 1));
  const medians = perRun.map((r) => r.medianEndingReal);
  const st = lognormalParameters(R4_PARAMETERS.stocks.meanBp, R4_PARAMETERS.stocks.volBp);
  const inf = lognormalParameters(R4_PARAMETERS.inflation.meanBp, R4_PARAMETERS.inflation.volBp);
  return {
    scenario: "R4",
    sheet: "packages/retirement/reference/sheets/r4.md",
    generatedBy: "packages/retirement/reference/independent.ts",
    units: "Money in today's dollars, rounded to the cent; rates as fractions.",
    parameters: {
      ...R4_PARAMETERS,
      lognormal: { stocks: { mu: st.mu, sigma: st.sigma }, inflation: { mu: inf.mu, sigma: inf.sigma } },
    },
    generator: {
      algorithm: "mulberry32 uniforms u = (x + 0.5) / 2^32; Box–Muller z_S = sqrt(−2 ln u1) cos(2π u2), z_π = sqrt(−2 ln u1) sin(2π u2), one pair per plan year",
      seed: R4_SEED,
      uniformsPerPath: UNIFORMS_PER_PATH,
      layout:
        "One stream of the seed: the large run takes uniforms 0 to paths × 60 − 1; spread run j starts at uniform 4,000,000 × 60 + j × 10,000 × 60 (mulberry32 state = seed + offset × 0x6D2B79F5), so no two runs share a draw.",
    },
    paths: largePaths,
    successPaths: large.successPaths,
    successRate: large.successRate,
    toleranceAbs: 0.015,
    medianEndingReal: large.p50,
    medianToleranceRel: 0.08,
    percentilesEndingReal: { p10: large.p10, p25: large.p25, p50: large.p50, p75: large.p75, p90: large.p90 },
    spread: {
      runs: R4_SPREAD_RUNS,
      pathsPerRun: R4_SPREAD_PATHS,
      successRate: { min: Math.min(...rates), max: Math.max(...rates), mean, sd },
      binomialSd: Math.sqrt((large.successRate * (1 - large.successRate)) / R4_SPREAD_PATHS),
      medianEndingReal: { min: Math.min(...medians), max: Math.max(...medians) },
      perRun,
    },
    design: {
      source: "r4.md §3 (strategies-outputs-web §7.9; seams.md §8 D17): the strategies designer's independent run during design",
      successRate: 0.6997,
      medianEndingReal: 337_500,
      p75EndingReal: 1_005_000,
      spreadSuccessRate: { min: 0.688, max: 0.707, sd: 0.0043 },
      spreadMedianEndingReal: { min: 320_800, max: 358_100 },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Files

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function expectedFiles(opts: { skipR4?: boolean } = {}): Record<string, string> {
  const files: Record<string, string> = {
    "r1.expected.csv": renderCsv(runR1()),
    "r2.expected.csv": renderCsv(runR2()),
    "r3.expected.json": json(runR3()),
  };
  if (opts.skipR4 !== true) files["r4.expected.json"] = json(runR4());
  return files;
}

function summaryLine(run: RunResult): string {
  return [
    `${run.scenario.id}: ${run.success ? "succeeds" : `fails in ${run.depletionYear}`}`,
    `end ${money(run.endNominal)} nominal, ${money(run.endReal)} today`,
    `lifetime tax today ${money(run.lifetimeTaxReal)}`,
    `funded today ${money(run.lifetimeFundedReal)}`,
    `shortfall today ${money(run.lifetimeShortfallReal)}`,
    `at most ${run.maxEvaluations} tax evaluations a year`,
  ].join("; ");
}

function main(argv: readonly string[]): number {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  const skipR4 = argv.includes("--skip-r4");
  if (!write && !check) {
    console.log(summaryLine(runR1()));
    console.log(summaryLine(runR2()));
    const r3 = runR3();
    for (const run of r3.engineConvention.runs) console.log(`r3 ${run.stockBp} bp: ${run.successPaths} of ${run.paths}`);
    for (const run of r3.trinityConvention.runs) console.log(`r3 Trinity ${run.stockBp} bp: ${run.successCount} of ${run.windows}`);
    return 0;
  }
  const files = expectedFiles({ skipR4 });
  let stale = 0;
  for (const [name, text] of Object.entries(files)) {
    const path = `${FIXTURES_DIR}${name}`;
    if (write) {
      writeFileSync(path, text);
      console.log(`wrote ${path}`);
    } else {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = "";
      }
      if (current !== text) {
        stale++;
        console.error(`stale: ${path}`);
      }
    }
  }
  return stale === 0 ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
