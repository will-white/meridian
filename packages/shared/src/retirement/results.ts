import { z } from "zod";
import { OwnerId, PlanBucket } from "../enums.js";
import { CentsString } from "../wire.js";
import { CohortMode, ParametricPreset, ReturnModelKind } from "./returnModel.js";
import { StrategyKind } from "./strategy.js";
import { TaxFilingStatus, TaxYearDetail } from "./tax.js";

/**
 * Result shapes (strategies-outputs-web §4.2 with seams C37, C43, C45, C46 and F9), stored in
 * `sim_run.summary`, `sim_run.fan` and `sim_run_path.year_table` and returned by the run routes.
 * Stored documents: strict, cents as strings, ratios as integer basis points or ppm, price levels
 * as nine-decimal fixed-point strings, no floats and no nulls (an absent value is an absent key).
 * Money in a year row is nominal; `deflateYearRow` gives today's dollars.
 */

const Cents = CentsString;

/** Digits after the point of a stored price level (seams C43). */
export const PRICE_LEVEL_DECIMALS = 9;
/** The price level at the plan start (today's dollars). */
export const PRICE_LEVEL_ONE = "1.000000000";
/** A price level relative to the plan start as a fixed-point decimal string with nine decimals, e.g. "1.025000000". */
export const PriceLevel = z.string().regex(/^\d{1,12}\.\d{9}$/, "a price level with nine decimals");
export type PriceLevel = z.infer<typeof PriceLevel>;

/** Which life table a run used (engine design §2.6). */
export const MortalityTableId = z.enum(["fixed", "ssa_period", "irs_2010cm_fallback"]);
export type MortalityTableId = z.infer<typeof MortalityTableId>;

/** A depletion year of a path that never ran out, in the `depletion_year` series (seams C46). */
export const NEVER_DEPLETED = -1;

/**
 * The per-path series of `sim_run_series` (inputs §2.4, seams F9): ending wealth in today's cents,
 * the depletion year (−1 = never), and lifetime taxes and spending in today's cents.
 */
export const SimRunSeriesKind = z.enum(["ending_real_cents", "depletion_year", "lifetime_tax_real_cents", "lifetime_spending_real_cents"]);
export type SimRunSeriesKind = z.infer<typeof SimRunSeriesKind>;
/** `i64le`: signed 64-bit little-endian; `i16le`: signed 16-bit little-endian. */
export const SeriesEncoding = z.enum(["i64le", "i16le"]);
export type SeriesEncoding = z.infer<typeof SeriesEncoding>;
export const SERIES_ENCODING: Readonly<Record<SimRunSeriesKind, SeriesEncoding>> = {
  ending_real_cents: "i64le",
  depletion_year: "i16le",
  lifetime_tax_real_cents: "i64le",
  lifetime_spending_real_cents: "i64le",
};

const Wealth5 = z.object({ p10: Cents, p25: Cents, p50: Cents, p75: Cents, p90: Cents, mean: Cents }).strict();

export const SimSummary = z
  .object({
    schemaVersion: z.literal(1),
    /** The engine's effective count (inputs decision 25). */
    paths: z.number().int(),
    successPaths: z.number().int(),
    /** Paths with no below-plan drawdown year (seams C40). */
    fullPlanPaths: z.number().int(),
    /** Wilson 95% bounds in basis points, rounded half away from zero; absent for the historical and fixed models. */
    successCi95Bp: z.tuple([z.number().int(), z.number().int()]).optional(),
    /** Today's dollars, nearest rank; p50 and p10 feed the run list and the dashboard card. */
    endingWealthReal: Wealth5,
    endingWealthNominal: z.object({ p10: Cents, p50: Cents, p90: Cents }).strict(),
    failure: z
      .object({
        paths: z.number().int(),
        /** The earliest depletion year of any path; absent when no path ran out. */
        firstDepletionYear: z.number().int().optional(),
        /** The calendar year at which the running count of depletions first reaches ceil(failures / 2). */
        medianDepletionYear: z.number().int().optional(),
        /** Depletions (first failures) by plan year. */
        byYear: z.array(z.number().int()),
      })
      .strict(),
    lifetimeSpendingRealP50: Cents,
    lifetimeTaxesRealP50: Cents,
    /** Absent when no path failed. */
    shortfallRealP50OfFailures: Cents.optional(),
    model: z
      .object({
        kind: ReturnModelKind,
        requestedPaths: z.number().int(),
        cohortMode: CohortMode.optional(),
        cohortCount: z.number().int().optional(),
        firstStartYear: z.number().int().optional(),
        lastStartYear: z.number().int().optional(),
        meanBlockYears: z.number().int().optional(),
        preset: ParametricPreset.optional(),
      })
      .strict(),
    mortalityTable: MortalityTableId,
    strategy: StrategyKind,
    startYear: z.number().int(),
    /** 1000000 = a full first year. */
    firstYearFractionPpm: z.number().int(),
    /** `DATA_CHECKSUM` of the data the run loaded (seams C11). */
    dataChecksum: z.string().regex(/^[0-9a-f]{64}$/),
    /** The result digest: 8 hex digits, FNV-1a over the per-path endings and failure years (engine decision 31). */
    digest: z.string().regex(/^[0-9a-f]{8}$/, "8 lower-case hex digits"),
  })
  .strict();
export type SimSummary = z.infer<typeof SimSummary>;

const Bands = z.object({ p10: z.array(Cents), p25: z.array(Cents), p50: z.array(Cents), p75: z.array(Cents), p90: z.array(Cents) }).strict();

export const FanSeries = z
  .object({
    schemaVersion: z.literal(1),
    /** Calendar years shown. */
    years: z.array(z.number().int()),
    /** [person][index]: age attained. */
    ages: z.array(z.array(z.number().int())),
    aliveCount: z.array(z.number().int()),
    /** Share of all paths not yet failed at the end of each year (truncated). */
    fundedBp: z.array(z.number().int()),
    /** Later years omitted: too few paths alive. */
    truncated: z.boolean(),
    /** End-of-year portfolio value. */
    real: Bands,
    nominal: Bands,
    /** Funded spending in today's dollars, from the first drawdown year (index into `years`). */
    spendingFromIndex: z.number().int(),
    spendingReal: Bands,
  })
  .strict();
export type FanSeries = z.infer<typeof FanSeries>;

/** Sums by planner bucket; the keys are the members of `PlanBucket` (seams C45). */
export const ByBucket = z.object({ taxable: Cents, pre_tax: Cents, roth: Cents, hsa: Cents, cash: Cents }).strict();
export type ByBucket = z.infer<typeof ByBucket>;

export const StrategyEvent = z.enum(["freeze", "cut", "raise", "band_floor", "band_ceiling", "cap", "essentials", "topped_up", "rmd_excess"]);
export type StrategyEvent = z.infer<typeof StrategyEvent>;

export const YearPhase = z.enum(["accumulation", "transition", "retirement"]);
export type YearPhase = z.infer<typeof YearPhase>;

/**
 * Parts of one person's benefit in a year (seams C37): the spousal excess, what the widow(er)'s
 * benefit adds over own plus spousal, and the amount the earnings test withheld.
 */
export const SocialSecurityParts = z.object({ spousal: Cents, survivor: Cents, withheld: Cents }).strict();
export type SocialSecurityParts = z.infer<typeof SocialSecurityParts>;

export const YearRow = z
  .object({
    year: z.number().int(),
    yearFractionPpm: z.number().int(),
    ages: z.array(z.number().int()),
    alive: z.array(z.boolean()),
    phase: YearPhase,
    filingStatus: TaxFilingStatus,
    /** Price level at the start and the end of the year. */
    cpiStart: PriceLevel,
    cpiEnd: PriceLevel,
    inflationBp: z.number().int(),
    portfolioReturnBp: z.number().int(),
    income: z
      .object({
        wages: Cents,
        /** Per person. */
        socialSecurity: z.array(Cents),
        /** Per person, in the order of `socialSecurity`. */
        socialSecurityParts: z.array(SocialSecurityParts),
        pensionAnnuity: Cents,
        rental: Cents,
        other: Cents,
        total: Cents,
      })
      .strict(),
    contributions: z.object({ employee: Cents, employer: Cents }).strict(),
    spending: z
      .object({
        planned: Cents,
        funded: Cents,
        core: Cents,
        healthcare: Cents,
        longTermCare: Cents,
        goals: Cents,
        floor: Cents,
        shortfall: Cents,
        /** Gross years only. */
        ruleGross: Cents.optional(),
      })
      .strict(),
    strategy: z
      .object({ events: z.array(StrategyEvent), withdrawalRateBp: z.number().int(), essentialCoverageBp: z.number().int().optional() })
      .strict(),
    /** Gross, RMDs included, conversions excluded. */
    withdrawals: z
      .object({ byAccount: z.array(Cents), byBucket: ByBucket, total: Cents, rmdByAccount: z.array(Cents), rmdTotal: Cents })
      .strict(),
    conversions: Cents,
    investment: z.object({ realizedGains: Cents, dividends: Cents, coupons: Cents }).strict(),
    /** The tax area's detail of the year (seams C37); payroll tax is its own line in it. */
    tax: TaxYearDetail,
    surplusSaved: Cents,
    growth: Cents,
    ending: z
      .object({ byAccount: z.array(Cents), basisByAccount: z.array(Cents), byBucket: ByBucket, total: Cents, totalReal: Cents })
      .strict(),
    /** This year has a shortfall against the floor. */
    failed: z.boolean(),
  })
  .strict();
export type YearRow = z.infer<typeof YearRow>;

export const YearTableAccount = z.object({ id: z.string(), name: z.string(), bucket: PlanBucket, owner: OwnerId }).strict();
export type YearTableAccount = z.infer<typeof YearTableAccount>;

export const YearTable = z
  .object({
    schemaVersion: z.literal(1),
    pathIndex: z.number().int(),
    /** Historical model: "the path that starts in 1966". */
    historicalStartYear: z.number().int().optional(),
    deathYears: z.array(z.number().int()),
    accounts: z.array(YearTableAccount),
    startingTotal: Cents,
    rows: z.array(YearRow),
  })
  .strict();
export type YearTable = z.infer<typeof YearTable>;
