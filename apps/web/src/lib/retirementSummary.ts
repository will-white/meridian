import { roundDivHalfAway, STORED_PERCENTILES, successBp, type PathStory, type RunPathResponse, type SimRunView, type SimSummary, type StrategyKind } from "@meridian/shared";
import type { FanChartInput } from "../components/charts/retirementOptions.js";
import { money, shortDate } from "./format.js";
import { successTone, type SuccessTone } from "./retirement.js";
import { successText } from "./retirementCard.js";
import { ageLabel, countText, ordinal, percentText, returnModelLabel, wholeDollars } from "./retirementFormat.js";

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

// ---- The path story in sentences (§3.12, §5.5 item 5) ----

const BUCKET_PLURAL: Record<PathStory["depletion"][number]["bucket"], string> = {
  taxable: "the taxable accounts",
  pre_tax: "the pre-tax accounts",
  roth: "the Roth accounts",
  hsa: "the HSA",
  cash: "the cash accounts",
};

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${countText(n)} times`);

/** "−1.8%" or "+3.1%" from truncated basis points (the shared `realReturnBp`). */
function signedRate(bp: number): string {
  const text = percentText(Math.abs(bp));
  return bp < 0 ? `−${text}` : `+${text}`;
}

/** "91 and 88" from the ages of the people alive. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The shared `pathStory` record as the Results page's sentences (§3.12): "The money ran out in
 * 2053, at ages 91 and 88." or "Every year of spending was funded; the plan ended with $1,115,486
 * in today's dollars."; "Markets returned −1.8% a year after inflation over the first 10 retirement
 * years; the median path had +3.1%."; "The taxable accounts were empty by 2037, the pre-tax accounts
 * by 2049, the Roth accounts by 2053."; then the strategy's cuts and raises, the years below plan
 * and the largest tax bill.
 */
export function pathStoryText(story: PathStory, strategy?: StrategyKind | string): string[] {
  const out: string[] = [];
  if (story.outcome === "failed" && story.failureYear !== undefined) {
    const ages = story.failureAges ?? [];
    out.push(`The money ran out in ${story.failureYear}${ages.length === 0 ? "" : `, at ${ages.length === 1 ? "age" : "ages"} ${andList(ages.map(String))}`}.`);
  } else {
    out.push(`Every year of spending was funded; the plan ended with ${wholeDollars(story.endingRealCents)} in today's dollars.`);
  }
  const own = story.first10.realReturnBp;
  if (own !== undefined) {
    const median = story.first10.medianRealReturnBp;
    out.push(`Markets returned ${signedRate(own)} a year after inflation over the first 10 retirement years${median === undefined ? "" : `; the median path had ${signedRate(median)}`}.`);
  }
  if (story.depletion.length > 0) {
    const parts = story.depletion.map((d, i) => (i === 0 ? `${BUCKET_PLURAL[d.bucket]} ${d.bucket === "hsa" ? "was" : "were"} empty by ${d.year}` : `${BUCKET_PLURAL[d.bucket]} by ${d.year}`));
    const sentence = parts.join(", ");
    out.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  const e = story.events;
  if (strategy === "guardrails" && e.cuts + e.raises + e.freezes > 0) {
    const bits: string[] = [];
    if (e.cuts > 0) bits.push(`cut spending ${times(e.cuts)}`);
    if (e.raises > 0) bits.push(`raised it ${times(e.raises)}`);
    if (e.freezes > 0) bits.push(`skipped the inflation raise ${times(e.freezes)}`);
    out.push(`The guardrails ${andList(bits)}.`);
  }
  if (e.bandFloors + e.bandCeilings > 0) out.push(`Discretionary spending was held at the floor in ${countText(e.bandFloors)} and at the ceiling in ${countText(e.bandCeilings)} ${e.bandFloors + e.bandCeilings === 1 ? "year" : "years"}.`);
  if (e.topUps > 0) out.push(`The withdrawal was topped up to pay essentials in ${countText(e.topUps)} ${e.topUps === 1 ? "year" : "years"}.`);
  if (story.belowPlanYears > 0) out.push(`Spending was below the plan in ${countText(story.belowPlanYears)} ${story.belowPlanYears === 1 ? "year" : "years"}.`);
  if (BigInt(story.peakTax.cents) > 0n) out.push(`The largest federal tax bill was ${wholeDollars(story.peakTax.cents)}, in ${story.peakTax.year}.`);
  return out;
}

// ---- The fan's legend and its "Show as table" (§5.5 item 3) ----

/** The HTML legend beside the fan: the two bands, the median and the selected path. */
export function fanLegend(hasOverlay: boolean): Array<{ key: string; label: string }> {
  const items = [
    { key: "outer", label: "10th to 90th percentile" },
    { key: "inner", label: "25th to 75th percentile" },
    { key: "median", label: "Median" },
  ];
  if (hasOverlay) items.push({ key: "path", label: "This path" });
  return items;
}

export interface FanTableRow {
  year: number;
  ages: string;
  p10: string;
  p25: string;
  p50: string;
  p75: string;
  p90: string;
  /** "94%" of all paths still funded at the end of the year (truncated). */
  funded: string;
}

/** The fan as a table ("Show as table", §5.5 item 3) from the same chart input, money as "$1,234.56". */
export function fanTableRows(chart: Pick<FanChartInput, "labels" | "years" | "bands" | "fundedBp" | "axis">, people: readonly SummaryPerson[] = []): FanTableRow[] {
  return chart.years.map((year, i) => ({
    year,
    ages: chart.axis === "year" ? ageLabel(people.map((p) => year - p.birthYear)) : (chart.labels[i] ?? ""),
    p10: money(chart.bands.p10[i] ?? null),
    p25: money(chart.bands.p25[i] ?? null),
    p50: money(chart.bands.p50[i] ?? null),
    p75: money(chart.bands.p75[i] ?? null),
    p90: money(chart.bands.p90[i] ?? null),
    funded: chart.fundedBp?.[i] === undefined ? "—" : percentText(chart.fundedBp[i]!, 0),
  }));
}
