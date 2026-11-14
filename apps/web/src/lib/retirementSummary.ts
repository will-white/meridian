import { roundDivHalfAway, STORED_PERCENTILES, successBp, type RunPathResponse, type SimRunView, type SimSummary, type StrategyKind } from "@meridian/shared";
import { money, shortDate } from "./format.js";
import { successTone, type SuccessTone } from "./retirement.js";
import { successText } from "./retirementCard.js";
import { ageLabel, countText, ordinal, percentText, returnModelLabel } from "./retirementFormat.js";

/**
 * The Results page's summary (strategies-outputs-web §5.5 items 1, 2 and 4): the run header and its
 * stale banner, the summary strip from `SimSummary`, the failure line and bar list, and the
 * percentile picker with its caption. Rates of counts truncate (C44); the engine's Wilson bounds
 * are shown as stored; money stays cents strings.
 */

/** A person as the summary names ages: the first person's age leads ("age 91" or "ages 91 / 88"). */
export interface SummaryPerson {
  birthYear: number;
}

function agesAt(year: number, people: readonly SummaryPerson[] | undefined): string | undefined {
  if (people === undefined || people.length === 0) return undefined;
  const label = ageLabel(people.map((p) => year - p.birthYear));
  return label.includes("/") ? `ages ${label}` : `age ${label}`;
}

/** One decimal, rounded half away from zero, for the engine's already-rounded Wilson bounds: 9350 → "93.5%". */
function boundText(bp: number): string {
  const tenths = Number(roundDivHalfAway(BigInt(bp), 10n));
  return `${Math.trunc(tenths / 10)}.${Math.abs(tenths % 10)}%`;
}

/** The sentence that says what "funded" means under the run's strategy (§5.5 item 2). */
export function fundedTest(strategy: StrategyKind | string): string {
  if (strategy === "constant_dollar") return "Funded means your planned spending was paid every year.";
  if (strategy === "fixed_percentage" || strategy === "vpw") return "Funded means your essential spending, healthcare and goals were paid every year.";
  return "Funded means the spending the rule called for was paid every year.";
}

/** A model in words, with what the result says about it (plan decision 7: the cohort mode and the first and last start year). */
export function modelText(model: SimSummary["model"]): string {
  switch (model.kind) {
    case "historical": {
      const years = model.firstStartYear !== undefined && model.lastStartYear !== undefined ? `, start years ${model.firstStartYear} to ${model.lastStartYear}` : "";
      if (model.cohortMode === "wrap") return `Historical sequences${years}; a sequence that runs past the last year of the record continues from its first year (wrap-around)`;
      return `Historical sequences${years}, each a complete stretch of history`;
    }
    case "bootstrap":
      return `Block bootstrap of the historical record${model.meanBlockYears === undefined ? "" : `, mean block ${model.meanBlockYears} years`}`;
    case "parametric":
      return model.preset === "conservative" ? "Parametric, conservative future" : model.preset === "custom" ? "Parametric, your own returns and volatilities" : "Parametric, long-run history";
    default:
      return returnModelLabel(model.kind);
  }
}

export interface FailureBar {
  year: number;
  /** "age 91" or "ages 91 / 88" when the people are known. */
  ages?: string;
  count: number;
  /** Width relative to the largest bar, basis points (truncated). */
  widthBp: number;
}

export interface SummaryView {
  hero: string;
  tone: SuccessTone;
  /** "9,402 of 10,000 simulated futures funded the plan" or "64 of 69 historical start years funded the plan". */
  countText: string;
  /** "between 93.5% and 94.5% with this many paths"; absent for the historical and fixed models. */
  intervalText?: string;
  testText: string;
  modelText: string;
  tiles: Array<{ label: string; value: string; note?: string }>;
  /** Absent when no path failed (§5.5 "No failures"). */
  failure?: { text: string; bars: FailureBar[] };
  /** "Percentiles from 500 paths are coarse" below 1,000 paths (not historical). */
  coarseNote?: string;
}

/**
 * The summary strip (§5.5 item 2) from a stored `SimSummary`: the success rate (truncated whole
 * percent) with its tone, the count sentence and Wilson interval, the test in use, the ending-wealth
 * tiles in today's dollars, the full-plan rate for strategies other than constant spending, the
 * failure line ("In the futures that fell short, half had run out by 2053 (age 91); the earliest in
 * 2046") with first failures by year, and the coarse-percentiles note. `people` gives the ages.
 */
export function summaryView(summary: SimSummary, people?: readonly SummaryPerson[]): SummaryView {
  const paths = summary.paths;
  const bp = paths > 0 ? successBp(summary.successPaths, paths) : 0;
  const historical = summary.model.kind === "historical";
  const view: SummaryView = {
    hero: successText(bp),
    tone: successTone(bp),
    countText: historical
      ? `${countText(summary.successPaths)} of ${countText(paths)} historical start years funded the plan`
      : `${countText(summary.successPaths)} of ${countText(paths)} simulated futures funded the plan`,
    testText: fundedTest(summary.strategy),
    modelText: modelText(summary.model),
    tiles: [
      { label: "Median ending wealth", value: money(summary.endingWealthReal.p50), note: "today's dollars" },
      { label: "10th percentile ending wealth", value: money(summary.endingWealthReal.p10), note: "today's dollars" },
    ],
  };
  const ci = summary.successCi95Bp;
  if (ci !== undefined) view.intervalText = `between ${boundText(ci[0])} and ${boundText(ci[1])} with this many paths`;
  if (summary.strategy !== "constant_dollar" && paths > 0) {
    view.tiles.push({ label: "Never below plan", value: percentText(successBp(summary.fullPlanPaths, paths), 0) });
  }
  const f = summary.failure;
  if (f.paths > 0 && f.firstDepletionYear !== undefined && f.medianDepletionYear !== undefined) {
    const medianAges = agesAt(f.medianDepletionYear, people);
    const text = `In the futures that fell short, half had run out by ${f.medianDepletionYear}${medianAges === undefined ? "" : ` (${medianAges})`}; the earliest in ${f.firstDepletionYear}`;
    const max = Math.max(...f.byYear);
    const bars: FailureBar[] = [];
    f.byYear.forEach((count, t) => {
      if (count <= 0) return;
      const year = summary.startYear + t;
      const bar: FailureBar = { year, count, widthBp: Math.trunc((count * 10_000) / max) };
      const ages = agesAt(year, people);
      if (ages !== undefined) bar.ages = ages;
      bars.push(bar);
    });
    view.failure = { text, bars };
    if (summary.shortfallRealP50OfFailures !== undefined) view.tiles.push({ label: "Median shortfall of the futures that fell short", value: money(summary.shortfallRealP50OfFailures), note: "today's dollars" });
  }
  if (!historical && paths < 1000) view.coarseNote = `Percentiles from ${countText(paths)} paths are coarse`;
  return view;
}

// ---- The run header and its banner (§5.5 item 1) ----

/** "run 11/08/26 · 10,000 paths · seed 1". */
export function runHeaderText(run: Pick<SimRunView, "finishedAt" | "createdAt" | "paths" | "seed">): string {
  return `run ${shortDate(run.finishedAt ?? run.createdAt)} · ${countText(run.paths)} paths · seed ${run.seed}`;
}

/**
 * Why a finished run may no longer describe the plan (§5.5 item 1): the engine or data version
 * moved (against `GET /meta`), or the inputs the scenario would freeze now differ (`current` is
 * false). Null when the run is current.
 */
export function runStaleText(run: Pick<SimRunView, "current" | "engineVersion" | "dataVersion">, meta: { engineVersion: string; dataVersion: string } | undefined): string | null {
  if (meta !== undefined && (run.engineVersion !== meta.engineVersion || run.dataVersion !== meta.dataVersion)) return "The engine or its data was updated";
  if (!run.current) return "Your accounts or profile changed since this run";
  return null;
}

// ---- The percentile picker (§5.5 item 4) ----

export interface PercentileChoice {
  label: string;
  percentile: number;
  selected: boolean;
  stored: boolean;
}

/** "Typical shortfall": `max(1, round(100 × failures ÷ 2 ÷ paths))` (§5.5 item 4), rounded half away from zero in integers. */
export function typicalShortfallPercentile(failures: number, paths: number): number {
  if (paths <= 0) return 1;
  return Math.max(1, Number(roundDivHalfAway(BigInt(100 * failures), BigInt(2 * paths))));
}

/** The chips 5 to 95 (stored), and the shortcuts Worst (1), Best (99) and, when paths failed, Typical shortfall. */
export function percentileChoices(summary: Pick<SimSummary, "paths" | "failure">, selected: number): { chips: PercentileChoice[]; shortcuts: PercentileChoice[] } {
  const stored = new Set<number>(STORED_PERCENTILES);
  const choice = (label: string, percentile: number): PercentileChoice => ({ label, percentile, selected: percentile === selected, stored: stored.has(percentile) });
  const chips = STORED_PERCENTILES.map((p) => choice(String(p), p));
  const shortcuts = [choice("Worst", 1), choice("Best", 99)];
  if (summary.failure.paths > 0) shortcuts.push(choice("Typical shortfall", typicalShortfallPercentile(summary.failure.paths, summary.paths)));
  return { chips, shortcuts };
}

/** A percentile from the URL or the slider: an integer 1 to 99, else the median. */
export function clampPercentile(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : 50;
}

/**
 * The caption under the picker (§5.5 item 4): "Path #4,312, ranked 1,000th of 10,000 by ending
 * wealth. One simulated future, not a forecast, and not the same percentile of every column." With
 * the historical model the path is named by its start year. `rank` is 0-based (`rankIndex`), so
 * the 10th percentile of 10,000 paths is ranked 1,000th; the path number is the engine's own index.
 */
export function pathCaption(path: Pick<RunPathResponse, "pathIndex" | "rank" | "source"> & { table: { historicalStartYear?: number | undefined } }, paths: number): string {
  const start = path.table.historicalStartYear;
  const which = start === undefined ? `Path #${countText(path.pathIndex)}` : `The path that starts in ${start}`;
  const resimulated = path.source === "resimulated" ? " Re-simulated from the run's frozen input." : "";
  return `${which}, ranked ${ordinal(path.rank + 1)} of ${countText(paths)} by ending wealth. One simulated future, not a forecast, and not the same percentile of every column.${resimulated}`;
}
