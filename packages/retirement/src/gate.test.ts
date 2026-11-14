import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The Phase 4 gate, engine side (spec "Build phases" item 4: "hand-calculated test suite passes; a
// reference scenario lands within tolerance of an independent calculator"; strategies-outputs-web
// §7.5 and §7.10 item 1; seams §11 step 31, its pure part). One file runs the whole gate:
//
// Part A, the hand-calculated suites of the four areas (the union §7.5 asks for): each suite is
// imported below, so its cases run here under their own ids, as they also do in their own file.
// Part B, the reference scenarios R1 to R4: the sheets against the independent calculator
// (`reference/reference-sheets.test.ts`, step 22a) and the calculator's expected files against the
// engine (`reference.test.ts`, step 22b); `reference/sheets.test.ts` keeps the sheets' own status.
//
// Not imported, because none of them is a hand-calculated case or a reference comparison (each runs
// in its own file): T44 (`node/pool.test.ts`, cancellation and the thread harness's errors), T45
// (`loop.properties.test.ts`, seeded random households), T46 (`determinism.test.ts`, the source
// scan) and T47 (`node/perf.test.ts`, run time).
//
// HC-D1 (the inputs design's cases 7 and 11, the resolver of build step 23) runs here from shared's
// `resolve.test.ts`, with case 6 (the contribution aggregation the fixture's baseline rests on); the
// resolver against this engine is `plannerEnv.test.ts`. The rest of the gate is not in this package:
// `apps/api/src/retirementGate.test.ts` (step 31, after Stage B).

// Part A: tax, RMD, Social Security, limits, payroll, yields (tax-rmd-ss §7; HC-T, HC-R, HC-S).
import "./tax/compile.test.js";
import "./tax/federalTax.test.js";
import "./tax/properties.test.js";
import "./tax/penalties.test.js";
import "./tax/rothBasis.test.js";
import "./tax/rmd.test.js";
import "./tax/socialSecurity.test.js";
import "./tax/contributionLimits.test.js";
import "./tax/payroll.test.js";
import "./tax/taxDrag.test.js";
import "./tax/warnings.test.js";
import "./tax/notModelled.test.js";
import "./tax/rulesView.test.js";
import "./tax/functions.test.js";
// Part A: the engine (engine-and-returns §7; HC-E1 T19, HC-E2 T34, HC-E3 T41 and T43).
import "./units.test.js";
import "./detmath.test.js";
import "./selftest.test.js";
import "./version.test.js";
import "./data.test.js";
import "./rng.test.js";
import "./models/lognormal.test.js";
import "./models/estimate.test.js";
import "./models/fixed.test.js";
import "./models/historical.test.js";
import "./models/bootstrap.test.js";
import "./models/parametric.test.js";
import "./models/index.test.js";
import "./mortality.test.js";
import "./clock.test.js";
import "./flows.test.js";
import "./prepare.test.js";
import "./trades.test.js";
import "./loop.test.js";
import "./loop.real.test.js";
import "./aggregate.test.js";
import "./commonRandom.test.js";
import "./node/golden.test.js";
import "./facade.test.js";
// Part A: strategies, the withdrawal order, the outputs (strategies-outputs-web §7.1 to §7.3; HC-W).
import "./strategies/planned.test.js";
import "./strategies/prepare.test.js";
import "./strategies/decide.test.js";
import "./strategies/guardrails.test.js";
import "./strategies/outcome.test.js";
import "./strategies/purity.test.js";
import "./withdrawals/tiers.test.js";
import "./withdrawals/solve.test.js";
import "./withdrawals/plan.test.js";
import "./withdrawals/withdrawals.real.test.js";
import "./withdrawals/withdrawals.sweep.test.js";
import "./results/results.test.js";
// Part A: the shared pure helpers (seams §11 step 3: inputs cases 1 to 5, 14, 16, 17; OUT-1 to
// OUT-3, OUT-6, OUT-7; the VPW table), the frozen input's shape (inputs case 11, its shape) and the
// resolver (step 23: inputs cases 6 to 13 and 18, HC-D1).
import "@meridian/shared/src/retirement/bucket.test.js";
import "@meridian/shared/src/retirement/clock.test.js";
import "@meridian/shared/src/retirement/weights.test.js";
import "@meridian/shared/src/retirement/mergePatch.test.js";
import "@meridian/shared/src/retirement/freeze.test.js";
import "@meridian/shared/src/retirement/percentile.test.js";
import "@meridian/shared/src/retirement/results.test.js";
import "@meridian/shared/src/retirement/strategy.test.js";
import "@meridian/shared/src/retirement/input.test.js";
import "@meridian/shared/src/retirement/contributions.test.js";
import "@meridian/shared/src/retirement/resolve.test.js";
// Part B: R1 to R4.
import "../reference/sheets.test.js";
import "../reference/reference-sheets.test.js";
import "./reference.test.js";

const SELF = new URL(import.meta.url);
const SHARED = new URL("../../shared/", import.meta.url);

/** The suites this file imports, as files (`@meridian/shared/…` is the workspace package). */
function importedSuites(): URL[] {
  const text = readFileSync(SELF, "utf8");
  return [...text.matchAll(/^import "([^"]+\.test\.js)";$/gm)].map(([, spec]) => {
    const ts = spec!.replace(/\.js$/, ".ts");
    return ts.startsWith("@meridian/shared/") ? new URL(ts.slice("@meridian/shared/".length), SHARED) : new URL(ts, SELF);
  });
}

/** The first argument of every `describe`, `it` and `test` call (`.each`, `.skip`, `.todo` … included), as text. */
function caseNames(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const isRunner = (e: ts.Expression): boolean => {
    if (ts.isIdentifier(e)) return e.text === "it" || e.text === "describe" || e.text === "test";
    if (ts.isPropertyAccessExpression(e)) return isRunner(e.expression);
    if (ts.isCallExpression(e)) return isRunner(e.expression); // describe.each([...])("name", …)
    return false;
  };
  const textOf = (e: ts.Expression): string | undefined => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(" ");
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRunner(node.expression)) {
      const first = node.arguments[0];
      const name = first === undefined ? undefined : textOf(first);
      if (name !== undefined) names.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/**
 * The cases strategies-outputs-web §7.5 requires at least, by id: the tax, RMD and Social Security
 * hand cases; HC-E1 (T19 and the 1966 path of R3), HC-E2 (T34), HC-E3 (T41 and T43); HC-W; HC-D1
 * (the resolver's cases 7 and 11).
 */
const REQUIRED = [
  ...range("HC-T", 1, 16),
  ...range("HC-R", 1, 3),
  ...range("HC-S", 1, 3),
  "HC-E1",
  "T19",
  "T34",
  "T41",
  "T43",
  ...range("ST-", 1, 17),
  ...range("WD-", 1, 21),
  ...range("OUT-", 1, 12),
  "HC-D1",
];

describe("the gate covers strategies-outputs-web §7.5", () => {
  it("every required case id names a test in a suite this file runs", () => {
    const names = importedSuites().flatMap((url) => caseNames(readFileSync(url, "utf8"), url.pathname));
    const missing = REQUIRED.filter((id) => {
      const word = new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/-/g, "\\-")}(?![0-9])`);
      return !names.some((n) => word.test(n));
    });
    expect(missing).toEqual([]);
  });

  it("HC-D1 is the resolver's cases 7 (spending resolution) and 11 (full resolution of the fixture), both run here", () => {
    const names = importedSuites()
      .filter((url) => url.pathname.endsWith("/retirement/resolve.test.ts"))
      .flatMap((url) => caseNames(readFileSync(url, "utf8"), url.pathname));
    for (const n of [7, 11]) expect(names.some((name) => name.startsWith(`${n} HC-D1 `)), `case ${n}`).toBe(true);
  });

  it("every imported suite exists, and both halves of R1 to R4's three-way agreement are imported", () => {
    const suites = importedSuites().map((u) => u.pathname);
    for (const path of suites) expect(() => readFileSync(path), path).not.toThrow();
    expect(suites.some((p) => p.endsWith("/reference/reference-sheets.test.ts"))).toBe(true);
    expect(suites.some((p) => p.endsWith("/src/reference.test.ts"))).toBe(true);
    expect(suites.length).toBeGreaterThanOrEqual(60);
  });
});
