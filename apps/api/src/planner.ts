import {
  CONSERVATIVE_GEOMETRIC_MEANS_BP,
  DATA_VERSION,
  ENGINE_VERSION,
  TAX_DATA_FIRST_YEAR,
  US_SERIES,
  buildRulesView,
  contributionLimit,
  detExp,
  estimateLogMoments,
  federalTaxPreview,
  fullRetirementAgeTable,
  listTaxRuleSets,
  ratioToBp,
  simulatePath,
  socialSecurityPreviewView,
  validateInput,
  type ReturnSeries,
} from "@meridian/retirement";
import type { PlannerPathEngine } from "@meridian/db";
import {
  ParametricParams,
  type FederalTaxPreviewRequest,
  type FederalTaxPreviewResponse,
  type IsoDate,
  type PlannerEnv,
  type RetirementReturnModelsMeta,
  type RetirementRulesView,
  type SocialSecurityPreviewRequest,
  type SocialSecurityPreviewResponse,
} from "@meridian/shared";

/**
 * `app.planner` (docs/design/phase-4/inputs-and-data.md §6.1, tax-rmd-ss §6, seams §2.4, C42,
 * C47): what the API reads of the engine. `env` is the `PlannerEnv` every planner service takes
 * (versions, rule sets, the first tax year, the contribution limit and `validateInput`, seams C13);
 * `simulatePath` re-simulates one path of a finished run for a percentile that was not stored, on
 * the request's own thread (G11: the API never starts worker threads and never runs more than one
 * path per request); the rule set labels, the full-retirement-age table and the return models'
 * facts feed `GET /meta`; `rulesView`, `taxPreview` and `socialSecurityPreview` are routes 22 to 24.
 *
 * `buildApp({ planner })` and `createTestApp({ planner })` inject a fake (test/helpers.ts
 * `fakePlanner`). The engine's own errors from routes 23 and 24 (`TaxDataError`, `TaxInputError`)
 * are mapped by the route handlers.
 */
export interface Planner extends PlannerPathEngine {
  readonly env: PlannerEnv;
  readonly ruleSets: ReadonlyArray<{ id: string; label: string }>;
  readonly fullRetirementAge: ReadonlyArray<{ fromBirthYear: number; toBirthYear: number | null; years: number; months: number }>;
  readonly returnModels: RetirementReturnModelsMeta;
  rulesView(today: IsoDate): RetirementRulesView;
  taxPreview(req: FederalTaxPreviewRequest): FederalTaxPreviewResponse;
  socialSecurityPreview(req: SocialSecurityPreviewRequest): SocialSecurityPreviewResponse;
}

declare module "fastify" {
  interface FastifyInstance {
    planner: Planner;
  }
}

/** The real environment from the engine (the one plannerEnv.test.ts in the engine runs the fixture through). */
export function realPlannerEnv(): PlannerEnv {
  return {
    engineVersion: ENGINE_VERSION,
    dataVersion: DATA_VERSION,
    ruleSets: listTaxRuleSets().map((r) => r.id),
    minStartYear: TAX_DATA_FIRST_YEAR,
    contributionLimit: (year, age, kind) => contributionLimit(year, age, kind),
    validateInput,
  };
}

/** The labels strategies-outputs-web §5.4 gives the two parametric presets. */
export const PRESET_LABELS = { historical: "Long-run history", conservative: "Conservative future" } as const;

const VARIABLES = ["stocks", "bonds", "bills", "inflation"] as const;

function columns(series: ReturnSeries): readonly Float64Array[] {
  return [series.stocks, series.bonds, series.bills, series.inflation];
}

/** The arithmetic mean of one column, summed in index order. */
function arithmeticMean(values: Float64Array): number {
  let s = 0;
  for (let t = 0; t < values.length; t++) s += values[t]!;
  return s / values.length;
}

/** The estimator's innovation correlations in basis points (row-major 4 × 4 to rows). */
function correlationBp(correlation: ArrayLike<number>): number[][] {
  return [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => ratioToBp(correlation[i * 4 + j]!)));
}

/**
 * Parameters in the custom form's terms from four means and volatilities (fractions), the data's
 * inflation persistence and correlations; bills not persistent and both initial rates absent (the
 * data's last year), as in the engine's presets. Checked with the shared schema.
 */
function paramsFrom(meanKind: "arithmetic" | "geometric", mean: readonly number[], vol: readonly number[], phiInflation: number, correlation: ArrayLike<number>): ParametricParams {
  const mv = (j: number) => ({ meanBp: ratioToBp(mean[j]!), volBp: ratioToBp(vol[j]!) });
  return ParametricParams.parse({
    meanKind,
    stocks: mv(0),
    bonds: mv(1),
    bills: { ...mv(2), persistenceBp: 0 },
    inflation: { ...mv(3), persistenceBp: ratioToBp(phiInflation) },
    correlationBp: correlationBp(correlation),
  });
}

/**
 * The return models' facts for `GET /meta` (C47; seams G2), from the engine's estimator on its
 * return series:
 * - the `historical` preset is the lognormal fitted to the log returns (μ, σ of each log series):
 *   its arithmetic mean `exp(μ + σ²/2) − 1` and simple-return volatility `(1 + A)·sqrt(exp(σ²) − 1)`,
 *   which `lognormalFromArithmetic` maps back to the same μ and σ;
 * - the `conservative` preset is `CONSERVATIVE_GEOMETRIC_MEANS_BP` read as geometric means with the
 *   data's simple-return volatilities (engine-and-returns §3.5 (d));
 * - `historyStartParams` are the data's own arithmetic means and sample standard deviations of the
 *   simple returns, where the custom form starts.
 * Persistence and correlations are the estimator's in all three. Each figure is rounded to the
 * nearest basis point, half away from zero (C44: an engine output).
 */
export function returnModelsMeta(series: ReturnSeries = US_SERIES): RetirementReturnModelsMeta {
  const m = estimateLogMoments(series);
  const cols = columns(series);
  const presetMean: number[] = [];
  const presetVol: number[] = [];
  for (let j = 0; j < VARIABLES.length; j++) {
    const mu = m.mu[j]!;
    const variance = m.sigma[j]! * m.sigma[j]!;
    const growth = detExp(mu + variance / 2);
    presetMean.push(growth - 1);
    presetVol.push(growth * Math.sqrt(detExp(variance) - 1));
  }
  const simpleSd = Array.from(m.simpleSd);
  return {
    presets: [
      { id: "historical", label: PRESET_LABELS.historical, params: paramsFrom("arithmetic", presetMean, presetVol, m.phiInflation, m.correlation) },
      {
        id: "conservative",
        label: PRESET_LABELS.conservative,
        params: paramsFrom(
          "geometric",
          CONSERVATIVE_GEOMETRIC_MEANS_BP.map((v) => v / 10000),
          simpleSd,
          m.phiInflation,
          m.correlation,
        ),
      },
    ],
    historyStartParams: paramsFrom("arithmetic", cols.map(arithmeticMean), simpleSd, m.phiInflation, m.correlation),
    history: { firstYear: series.firstYear, lastYear: series.firstYear + series.stocks.length - 1 },
  };
}

/** The production planner: the engine package itself. Built once per app. */
export function createPlanner(): Planner {
  return {
    env: realPlannerEnv(),
    simulatePath: (input, pathIndex) => simulatePath(input, pathIndex),
    ruleSets: listTaxRuleSets(),
    fullRetirementAge: fullRetirementAgeTable(),
    returnModels: returnModelsMeta(),
    rulesView: (today) => buildRulesView(today),
    taxPreview: (req) => federalTaxPreview(req),
    socialSecurityPreview: (req) => socialSecurityPreviewView(req),
  };
}

let shared: Planner | undefined;

/** The production planner, built on first use and shared by every app in the process (its parts are pure). */
export function defaultPlanner(): Planner {
  shared ??= createPlanner();
  return shared;
}
