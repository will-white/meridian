import { z } from "zod";
import type { AssetClass } from "../enums.js";
import { bp } from "./primitives.js";

/**
 * Return-model and portfolio settings (engine-and-returns §2.2 and §3.5, with seams C3): stored
 * in `RunSettings`, so integers only. Rates, means, volatilities, persistence and correlations
 * are basis points; the fixed model's series is parts per million (six decimals, the precision of
 * the data file). The engine converts them to fractions once, in `prepare()`.
 */

/** The engine's three simulated assets, in the order of every `[stocks, bonds, bills]` triple. */
export const SIM_ASSETS = ["stocks", "bonds", "bills"] as const;
export const SimAsset = z.enum(SIM_ASSETS);
export type SimAsset = z.infer<typeof SimAsset>;

export const ReturnModelKind = z.enum(["historical", "bootstrap", "parametric", "fixed"]);
export type ReturnModelKind = z.infer<typeof ReturnModelKind>;

/**
 * Historical cohorts (plan decision 7). `auto` (the default) runs complete cycles when every
 * person has a fixed life expectancy and at least 30 complete cohorts exist, wrap-around
 * otherwise; `complete` and `wrap` force one. The result states the mode it used.
 */
export const HistoricalCohorts = z.enum(["auto", "complete", "wrap"]);
export type HistoricalCohorts = z.infer<typeof HistoricalCohorts>;
/** The mode a historical run used (`SimSummary.model.cohortMode`). */
export const CohortMode = z.enum(["complete", "wrap"]);
export type CohortMode = z.infer<typeof CohortMode>;

/** `historical`: estimated from the data file; `conservative`: the engine design's lower means; `custom`: `params`. */
export const ParametricPreset = z.enum(["historical", "conservative", "custom"]);
export type ParametricPreset = z.infer<typeof ParametricPreset>;
/** How a custom mean is read: the arithmetic or the geometric mean of the simple annual return. */
export const MeanKind = z.enum(["arithmetic", "geometric"]);
export type MeanKind = z.infer<typeof MeanKind>;

/** A signed rate in basis points. */
const rateBp = (min: number, max: number) => z.number().int().min(min).max(max);

/** Mean in [−50%, 100%]; volatility (the standard deviation of the simple annual rate) in [0, 100%]. */
const MeanVol = z.object({ meanBp: rateBp(-5000, 10000), volBp: bp(0, 10000) }).strict();

/**
 * The correlation matrix of the four innovations in basis points (−10000 to 10000), in the order
 * stocks, bonds, bills, inflation: 4 × 4, unit diagonal, symmetric. Positive definiteness is the
 * engine's check (`correlation_not_positive_definite`).
 */
export const CorrelationMatrixBp = z
  .array(z.array(rateBp(-10000, 10000)).length(4))
  .length(4)
  .refine((m) => m.every((row, i) => row[i] === 10000), "the diagonal must be 10000 bp")
  .refine((m) => m.every((row, i) => row.every((value, j) => m[j]?.[i] === value)), "the matrix must be symmetric");
export type CorrelationMatrixBp = z.infer<typeof CorrelationMatrixBp>;

/** An initial rate for an AR(1) series, in [−20%, 50%]; absent = the data file's last observed year, exactly. */
const InitialBp = rateBp(-2000, 5000);

export const ParametricParams = z
  .object({
    meanKind: MeanKind,
    stocks: MeanVol,
    bonds: MeanVol,
    bills: MeanVol.extend({ persistenceBp: bp(0, 9500).default(0), initialBp: InitialBp.optional() }).strict(),
    inflation: MeanVol.extend({ persistenceBp: bp(0, 9500), initialBp: InitialBp.optional() }).strict(),
    correlationBp: CorrelationMatrixBp,
  })
  .strict();
export type ParametricParams = z.infer<typeof ParametricParams>;

/** One year of the fixed model, as simple rates in parts per million (above −100%). */
export const FixedReturnRow = z
  .object({
    stocksPpm: rateBp(-999_999, 10_000_000),
    bondsPpm: rateBp(-999_999, 10_000_000),
    billsPpm: rateBp(-999_999, 10_000_000),
    inflationPpm: rateBp(-999_999, 10_000_000),
  })
  .strict();
export type FixedReturnRow = z.infer<typeof FixedReturnRow>;

/** The longest fixed series: the engine's horizon cap. */
export const MAX_FIXED_SERIES_YEARS = 120;

const ReturnModelUnion = z.discriminatedUnion("kind", [
  /** Every rolling start year of the US record (engine decision 14). */
  z.object({ kind: z.literal("historical"), cohorts: HistoricalCohorts.default("auto") }).strict(),
  /** The stationary block bootstrap; the mean block length in whole years. */
  z.object({ kind: z.literal("bootstrap"), meanBlockYears: z.number().int().min(1).max(30).default(10) }).strict(),
  /** Correlated lognormal; `params` with the custom preset and only with it. */
  z.object({ kind: z.literal("parametric"), preset: ParametricPreset, params: ParametricParams.optional() }).strict(),
  /**
   * Deterministic, for hand-calculated tests and the reference scenarios R1 and R2 (engine
   * decision 30): plan year t uses row min(t, length − 1). The run-settings form does not offer it.
   */
  z.object({ kind: z.literal("fixed"), series: z.array(FixedReturnRow).min(1).max(MAX_FIXED_SERIES_YEARS) }).strict(),
]);

export const ReturnModelConfig = ReturnModelUnion.superRefine((model, ctx) => {
  if (model.kind !== "parametric") return;
  if (model.preset === "custom" && model.params === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["params"], message: "the custom preset needs its parameters" });
  }
  if (model.preset !== "custom" && model.params !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["params"], message: "parameters are taken only with the custom preset" });
  }
});
export type ReturnModelConfig = z.infer<typeof ReturnModelConfig>;
export type ReturnModelConfigInput = z.input<typeof ReturnModelConfig>;

/** The return model of a new scenario (plan decision 6, seams C51). */
export const DEFAULT_RETURN_MODEL = { kind: "bootstrap", meanBlockYears: 10 } as const satisfies ReturnModelConfig;

/** How taxable accounts are rebalanced each year (plan decision 8): `full` to target, or `flows_only` (no sale beyond what the withdrawal needs). */
export const TaxableRebalance = z.enum(["full", "flows_only"]);
export type TaxableRebalance = z.infer<typeof TaxableRebalance>;

/** One asset class's split onto `[stocks, bonds, bills]` in basis points; the three sum to 10000. */
export const AssetClassMapRow = z
  .tuple([bp(), bp(), bp()])
  .refine(([stocks, bonds, bills]) => stocks + bonds + bills === 10000, "a row must sum to 10000 bp");
export type AssetClassMapRow = z.infer<typeof AssetClassMapRow>;

export const AssetClassMap = z
  .object({
    us_stock: AssetClassMapRow,
    intl_stock: AssetClassMapRow,
    bonds: AssetClassMapRow,
    cash: AssetClassMapRow,
    real_estate: AssetClassMapRow,
    other: AssetClassMapRow,
  })
  .strict();
export type AssetClassMap = z.infer<typeof AssetClassMap>;

/**
 * The map the engine applies when `portfolio.assetClassMap` is absent (engine decision 3): US and
 * international stock, real estate and other → stocks; bonds → bonds; cash → bills. It is engine
 * behaviour: a change bumps `ENGINE_VERSION`.
 */
export const DEFAULT_ASSET_CLASS_MAP = {
  us_stock: [10000, 0, 0],
  intl_stock: [10000, 0, 0],
  bonds: [0, 10000, 0],
  cash: [0, 0, 10000],
  real_estate: [10000, 0, 0],
  other: [10000, 0, 0],
} as const satisfies Record<AssetClass, readonly [number, number, number]>;

export const PortfolioSettings = z
  .object({
    taxableRebalance: TaxableRebalance.default("full"),
    /** Absent = `DEFAULT_ASSET_CLASS_MAP`. */
    assetClassMap: AssetClassMap.optional(),
  })
  .strict();
export type PortfolioSettings = z.infer<typeof PortfolioSettings>;

export const DEFAULT_PORTFOLIO_SETTINGS = { taxableRebalance: "full" } as const satisfies PortfolioSettings;
