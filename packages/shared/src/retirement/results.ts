import { z } from "zod";
import { roundDivHalfAway } from "../decimal.js";
import { OwnerId, PlanBucket } from "../enums.js";
import { truncDiv } from "../months.js";
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

// ---- Pure helpers on the stored shapes (strategies-outputs-web §3.9 to §3.11, seams C43, C44) ----
// Outside the engine every ratio computed from cents truncates (C44, `truncDiv`), and the today's-
// dollars view is integer arithmetic on the nine-decimal price levels (C43); no float touches money.

/**
 * `addUp(totalCents, parts)`: the parts shown under an engine total (strategies §3.11 item 5). When
 * the rounded parts do not sum to the total, the difference goes to the part with the largest
 * absolute value (the first such part on a tie); parts that already sum are returned unchanged. A
 * part never changes sign: if it would, it stops at 0 and the next-largest part takes the rest
 * (this happens only when many parts round up at a half cent). Returns a new array.
 */
export function addUp(totalCents: bigint, parts: readonly bigint[]): bigint[] {
  const out = [...parts];
  let diff = totalCents - out.reduce((sum, p) => sum + p, 0n);
  if (diff === 0n) return out;
  if (out.length === 0) throw new RangeError(`addUp: no part can take a total of ${totalCents}`);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const order = out.map((_, i) => i).sort((a, b) => {
    const da = abs(out[a]!);
    const db = abs(out[b]!);
    return da === db ? a - b : da > db ? -1 : 1;
  });
  for (const i of order) {
    const part = out[i]!;
    const next = part + diff;
    if (part === 0n || (part > 0n && next >= 0n) || (part < 0n && next <= 0n)) {
      out[i] = next;
      return out;
    }
    out[i] = 0n;
    diff = next;
  }
  const first = order[0]!;
  out[first] = out[first]! + diff;
  return out;
}

function checkPaths(paths: number): void {
  if (!Number.isSafeInteger(paths) || paths < 1) throw new RangeError(`not a path count: ${paths}`);
}

/** The success rate in basis points, truncated (strategies §3.9, C44): 64 of 69 → 9275. */
export function successBp(successPaths: number, paths: number): number {
  checkPaths(paths);
  if (!Number.isSafeInteger(successPaths) || successPaths < 0 || successPaths > paths) throw new RangeError(`successBp: ${successPaths} of ${paths}`);
  return Number(truncDiv(BigInt(successPaths) * 10_000n, BigInt(paths)));
}

/**
 * `FanSeries.fundedBp`: for each plan year t the share of all paths not yet failed at its end,
 * `truncDiv((paths − Σ_{u ≤ t} failureYearCounts[u]) × 10000, paths)` (strategies §3.10).
 */
export function fundedShareBp(paths: number, failureYearCounts: readonly number[]): number[] {
  checkPaths(paths);
  const out: number[] = [];
  let failed = 0;
  for (const [t, count] of failureYearCounts.entries()) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`fundedShareBp: bad count ${count} in plan year ${t}`);
    failed += count;
    if (failed > paths) throw new RangeError(`fundedShareBp: ${failed} failures among ${paths} paths`);
    out.push(Number(truncDiv(BigInt(paths - failed) * 10_000n, BigInt(paths))));
  }
  return out;
}

const PRICE_LEVEL_SCALE = 10n ** BigInt(PRICE_LEVEL_DECIMALS);

/** A stored price level as an integer scaled by 10^9 ("1.025000000" → 1025000000n). It must be above 0. */
export function parsePriceLevel(level: string): bigint {
  if (!PriceLevel.safeParse(level).success) throw new RangeError(`not a price level: "${level}"`);
  const scaled = BigInt(level.replace(".", ""));
  if (scaled <= 0n) throw new RangeError(`a price level must be above 0: "${level}"`);
  return scaled;
}

/** Nominal cents in today's cents at a price level: `roundDivHalfAway(cents × 10^9, level × 10^9)` (C43). */
export function deflateCents(cents: bigint, level: string): bigint {
  return roundDivHalfAway(cents * PRICE_LEVEL_SCALE, parsePriceLevel(level));
}

export interface DeflateYearRowOptions {
  /**
   * The total at the start of the year in today's cents: the previous row's `ending.totalReal` (the
   * table's `startingTotal` for the first row). Without it the start is the row's own nominal start
   * (ending total − growth − contributions − surplus saved + withdrawals) deflated at `cpiStart`.
   */
  startTotalRealCents?: bigint;
  /** The bucket of each account in column order (`YearTable.accounts`); `byBucket` is then the sum of the deflated accounts. */
  accountBuckets?: readonly PlanBucket[];
}

/**
 * The today's-dollars view of a nominal year row (strategies §3.11, seams C43), the same on the
 * server and in the browser. Every flow is deflated at `cpiStart` and every ending balance at
 * `cpiEnd`, each with `deflateCents`. The ending total is the row's own `totalReal` (the engine's
 * figure, so a percentile table still ends at the reported percentile) and every other total is
 * the deflated total. A group whose nominal parts sum to its nominal total is kept summing with
 * `addUp`: income, spending funded, withdrawals and RMDs by account and by bucket, the federal tax
 * and income tax, taxable income, and the ending balances. Growth is the plug of the roll-forward
 * in today's dollars, `totalReal − (start + contributions + surplus saved − withdrawals)`, so the
 * row adds up in both units. Rates, ages, flags, events and the price levels are copied.
 */
export function deflateYearRow(row: YearRow, options: DeflateYearRowOptions = {}): YearRow {
  const startLevel = parsePriceLevel(row.cpiStart);
  const endLevel = parsePriceLevel(row.cpiEnd);
  const flowOf = (cents: string) => roundDivHalfAway(BigInt(cents) * PRICE_LEVEL_SCALE, startLevel);
  const balanceOf = (cents: string) => roundDivHalfAway(BigInt(cents) * PRICE_LEVEL_SCALE, endLevel);
  const flow = (cents: string) => flowOf(cents).toString();
  const strings = (values: readonly bigint[]) => values.map((v) => v.toString());
  const sumOf = (values: readonly string[]) => values.reduce((sum, v) => sum + BigInt(v), 0n);
  /** Parts deflated one by one, then added up to the deflated total when the nominal parts sum to the nominal total. */
  const group = (nominalTotal: string, realTotal: bigint, nominalParts: readonly string[], deflate: (c: string) => bigint): bigint[] => {
    const real = nominalParts.map(deflate);
    return sumOf(nominalParts) === BigInt(nominalTotal) ? addUp(realTotal, real) : real;
  };
  const buckets = options.accountBuckets;
  if (buckets !== undefined && (buckets.length !== row.withdrawals.byAccount.length || buckets.length !== row.ending.byAccount.length)) {
    throw new RangeError(`deflateYearRow: ${buckets.length} account buckets for ${row.ending.byAccount.length} accounts`);
  }
  /** By bucket: the sums of the deflated accounts when the nominal row says the same, else its own group. */
  const byBucket = (nominal: ByBucket, nominalAccounts: readonly string[], realAccounts: readonly bigint[], nominalTotal: string, realTotal: bigint, deflate: (c: string) => bigint): ByBucket => {
    const keys = PlanBucket.options;
    if (buckets !== undefined) {
      const sums = (values: readonly bigint[]) => keys.map((k) => values.reduce((sum, v, i) => (buckets[i] === k ? sum + v : sum), 0n));
      const nominalSums = sums(nominalAccounts.map((c) => BigInt(c)));
      if (keys.every((k, i) => nominalSums[i] === BigInt(nominal[k]))) {
        const real = sums(realAccounts);
        return { taxable: real[0]!.toString(), pre_tax: real[1]!.toString(), roth: real[2]!.toString(), hsa: real[3]!.toString(), cash: real[4]!.toString() };
      }
    }
    const real = strings(group(nominalTotal, realTotal, keys.map((k) => nominal[k]), deflate));
    return { taxable: real[0]!, pre_tax: real[1]!, roth: real[2]!, hsa: real[3]!, cash: real[4]! };
  };

  // Income: wages, each person's benefit, pensions and annuities, rental, other.
  const inc = row.income;
  const people = inc.socialSecurity.length;
  const incomeTotal = flowOf(inc.total);
  const incomeParts = strings(group(inc.total, incomeTotal, [inc.wages, ...inc.socialSecurity, inc.pensionAnnuity, inc.rental, inc.other], flowOf));
  const income: YearRow["income"] = {
    wages: incomeParts[0]!,
    socialSecurity: incomeParts.slice(1, 1 + people),
    socialSecurityParts: inc.socialSecurityParts.map((p) => ({ spousal: flow(p.spousal), survivor: flow(p.survivor), withheld: flow(p.withheld) })),
    pensionAnnuity: incomeParts[1 + people]!,
    rental: incomeParts[2 + people]!,
    other: incomeParts[3 + people]!,
    total: incomeTotal.toString(),
  };

  const contributions = { employee: flow(row.contributions.employee), employer: flow(row.contributions.employer) };

  // Spending: funded = core + healthcare + long-term care + goals.
  const sp = row.spending;
  const funded = flowOf(sp.funded);
  const spendingParts = strings(group(sp.funded, funded, [sp.core, sp.healthcare, sp.longTermCare, sp.goals], flowOf));
  const spending: YearRow["spending"] = {
    planned: flow(sp.planned),
    funded: funded.toString(),
    core: spendingParts[0]!,
    healthcare: spendingParts[1]!,
    longTermCare: spendingParts[2]!,
    goals: spendingParts[3]!,
    floor: flow(sp.floor),
    shortfall: flow(sp.shortfall),
  };
  if (sp.ruleGross !== undefined) spending.ruleGross = flow(sp.ruleGross);

  // Withdrawals and RMDs.
  const wd = row.withdrawals;
  const withdrawalsTotal = flowOf(wd.total);
  const withdrawalsByAccount = group(wd.total, withdrawalsTotal, wd.byAccount, flowOf);
  const rmdTotal = flowOf(wd.rmdTotal);
  const withdrawals: YearRow["withdrawals"] = {
    byAccount: strings(withdrawalsByAccount),
    byBucket: byBucket(wd.byBucket, wd.byAccount, withdrawalsByAccount, wd.total, withdrawalsTotal, flowOf),
    total: withdrawalsTotal.toString(),
    rmdByAccount: strings(group(wd.rmdTotal, rmdTotal, wd.rmdByAccount, flowOf)),
    rmdTotal: rmdTotal.toString(),
  };

  // Tax (seams C37): total = income tax + NIIT + the two additional taxes; income tax = ordinary + capital gains.
  const tx = row.tax;
  const totalFederal = flowOf(tx.totalFederalCents);
  const [incomeTax, niit, earlyPenalty, hsaPenalty] = group(
    tx.totalFederalCents,
    totalFederal,
    [tx.incomeTaxCents, tx.niitCents, tx.earlyPenaltyCents, tx.hsaPenaltyCents],
    flowOf,
  ) as [bigint, bigint, bigint, bigint];
  const [ordinaryTax, capitalGainsTax] = group(tx.incomeTaxCents, incomeTax, [tx.ordinaryTaxCents, tx.capitalGainsTaxCents], flowOf) as [bigint, bigint];
  const taxableIncome = flowOf(tx.taxableIncomeCents);
  const [ordinaryTaxable, gainsAt0, gainsAt15, gainsAt20] = group(
    tx.taxableIncomeCents,
    taxableIncome,
    [tx.ordinaryTaxableCents, tx.gainsAt0Cents, tx.gainsAt15Cents, tx.gainsAt20Cents],
    flowOf,
  ) as [bigint, bigint, bigint, bigint];
  const tax: YearRow["tax"] = {
    filingStatus: tx.filingStatus,
    totalFederalCents: totalFederal.toString(),
    incomeTaxCents: incomeTax.toString(),
    ordinaryTaxCents: ordinaryTax.toString(),
    capitalGainsTaxCents: capitalGainsTax.toString(),
    niitCents: niit.toString(),
    earlyPenaltyCents: earlyPenalty.toString(),
    hsaPenaltyCents: hsaPenalty.toString(),
    payrollTaxCents: flow(tx.payrollTaxCents),
    agiCents: flow(tx.agiCents),
    taxableIncomeCents: taxableIncome.toString(),
    ordinaryTaxableCents: ordinaryTaxable.toString(),
    taxableSocialSecurityCents: flow(tx.taxableSocialSecurityCents),
    standardDeductionCents: flow(tx.standardDeductionCents),
    seniorDeductionCents: flow(tx.seniorDeductionCents),
    gainsAt0Cents: gainsAt0.toString(),
    gainsAt15Cents: gainsAt15.toString(),
    gainsAt20Cents: gainsAt20.toString(),
    capitalLossCarryoverCents: flow(tx.capitalLossCarryoverCents),
    magiIrmaaCents: flow(tx.magiIrmaaCents),
    magiAcaCents: flow(tx.magiAcaCents),
    bracketRateBp: tx.bracketRateBp,
    nextGainRateBp: tx.nextGainRateBp,
  };

  // Ending balances: the total is the engine's own today's-dollars figure.
  const en = row.ending;
  const totalReal = BigInt(en.totalReal);
  const endingByAccount = group(en.total, totalReal, en.byAccount, balanceOf);
  const ending: YearRow["ending"] = {
    byAccount: strings(endingByAccount),
    basisByAccount: en.basisByAccount.map((c) => balanceOf(c).toString()),
    byBucket: byBucket(en.byBucket, en.byAccount, endingByAccount, en.total, totalReal, balanceOf),
    total: en.totalReal,
    totalReal: en.totalReal,
  };

  // Growth: the plug of the roll-forward in today's dollars (strategies §3.11 item 6).
  const contributionsNominal = BigInt(row.contributions.employee) + BigInt(row.contributions.employer);
  const startNominal = BigInt(en.total) - BigInt(row.growth) - contributionsNominal - BigInt(row.surplusSaved) + BigInt(wd.total);
  const startReal = options.startTotalRealCents ?? flowOf(startNominal.toString());
  const surplusSaved = flowOf(row.surplusSaved);
  const contributionsReal = BigInt(contributions.employee) + BigInt(contributions.employer);
  const growth = totalReal - (startReal + contributionsReal + surplusSaved - withdrawalsTotal);

  return {
    year: row.year,
    yearFractionPpm: row.yearFractionPpm,
    ages: [...row.ages],
    alive: [...row.alive],
    phase: row.phase,
    filingStatus: row.filingStatus,
    cpiStart: row.cpiStart,
    cpiEnd: row.cpiEnd,
    inflationBp: row.inflationBp,
    portfolioReturnBp: row.portfolioReturnBp,
    income,
    contributions,
    spending,
    strategy: { ...row.strategy, events: [...row.strategy.events] },
    withdrawals,
    conversions: flow(row.conversions),
    investment: {
      realizedGains: flow(row.investment.realizedGains),
      dividends: flow(row.investment.dividends),
      coupons: flow(row.investment.coupons),
    },
    tax,
    surplusSaved: surplusSaved.toString(),
    growth: growth.toString(),
    ending,
    failed: row.failed,
  };
}

/**
 * The today's-dollars view of a whole table: each row deflated with the previous row's
 * `ending.totalReal` as its start (the starting total for the first row, deflated at its `cpiStart`,
 * which is 1 at the plan start) and the accounts' buckets, so the roll-forward holds across rows.
 */
export function deflateYearTable(table: YearTable): YearTable {
  const accountBuckets = table.accounts.map((a) => a.bucket);
  const first = table.rows[0];
  let start = first === undefined ? 0n : deflateCents(BigInt(table.startingTotal), first.cpiStart);
  const rows = table.rows.map((row) => {
    const real = deflateYearRow(row, { startTotalRealCents: start, accountBuckets });
    start = BigInt(row.ending.totalReal);
    return real;
  });
  return { ...table, deathYears: [...table.deathYears], accounts: table.accounts.map((a) => ({ ...a })), rows };
}

// ---- The path story (strategies-outputs-web §3.12): computed in the browser from a stored table ----

/** What the Results page says about one path (§3.12); nothing of it is stored. */
export interface PathStory {
  outcome: "funded" | "failed";
  /** The first year whose floor was not funded, and the ages of the people alive in it. */
  failureYear?: number;
  failureAges?: number[];
  endingRealCents: string;
  /** The first year each bucket ended at zero after holding money, in that order (ties in `PlanBucket` order). */
  depletion: Array<{ bucket: PlanBucket; year: number }>;
  /** The annualized real portfolio return over the first 10 drawdown years, this path's and the median path's; absent without a drawdown year. */
  first10: { realReturnBp?: number; medianRealReturnBp?: number };
  events: { cuts: number; raises: number; freezes: number; topUps: number; bandFloors: number; bandCeilings: number };
  /** Drawdown years whose funded spending fell below the plan (planned + goals), or had a shortfall. */
  belowPlanYears: number;
  /** The year of the largest federal tax (the first on a tie). */
  peakTax: { year: number; cents: string };
}

/** `floor(x^(1/n))` for `x ≥ 0` and a whole `n ≥ 1`: integer Newton iteration from above. */
function nthRootFloor(x: bigint, n: number): bigint {
  if (x < 2n || n === 1) return x;
  const k = BigInt(n);
  let y = 1n << BigInt(Math.ceil(x.toString(2).length / n));
  for (;;) {
    const next = ((k - 1n) * y + x / y ** (k - 1n)) / k;
    if (next >= y) return y;
    y = next;
  }
}

const ROOT_SCALE = 10n ** 12n;
const BP = 10_000n;

/**
 * The geometric mean real return of rows, in basis points truncated toward zero (C44: a ratio
 * computed outside the engine truncates). The real factor of a year is
 * `(1 + portfolioReturnBp ÷ 10000) × cpiStart ÷ cpiEnd`; the mean is the n-th root of the product,
 * all in integers. Undefined for no rows or a year that lost everything.
 */
export function realReturnBp(rows: readonly YearRow[]): number | undefined {
  if (rows.length === 0) return undefined;
  let num = 1n;
  let den = 1n;
  for (const row of rows) {
    const gross = BP + BigInt(row.portfolioReturnBp);
    if (gross <= 0n) return undefined;
    num *= gross * parsePriceLevel(row.cpiStart);
    den *= BP * parsePriceLevel(row.cpiEnd);
  }
  const n = rows.length;
  const g = nthRootFloor((num * ROOT_SCALE ** BigInt(n)) / den, n);
  return Number(((g - ROOT_SCALE) * BP) / ROOT_SCALE);
}

const firstTen = (table: YearTable) => table.rows.filter((r) => r.phase !== "accumulation").slice(0, 10);

/**
 * The path story of a stored table (§3.12), pure and integer-only. `medianTable` is the stored
 * 50th-percentile table, for the comparison of the first ten drawdown years.
 *
 * A bucket "held money" once a row shows a withdrawal from it or an ending balance in it; it is
 * depleted in the first row at or after that whose ending balance is 0. A drawdown year is below
 * plan when it has a shortfall or its funded spending is more than one cent short of planned
 * spending plus goals (the cent absorbs the rounding of three separately rounded figures).
 */
export function pathStory(table: YearTable, medianTable?: YearTable): PathStory {
  const rows = table.rows;
  const last = rows[rows.length - 1];
  if (last === undefined) throw new RangeError("pathStory: the table has no row");
  const failedRow = rows.find((r) => r.failed);
  const held: Record<PlanBucket, boolean> = { taxable: false, pre_tax: false, roth: false, hsa: false, cash: false };
  const depleted = new Set<PlanBucket>();
  const depletion: PathStory["depletion"] = [];
  const events = { cuts: 0, raises: 0, freezes: 0, topUps: 0, bandFloors: 0, bandCeilings: 0 };
  let belowPlanYears = 0;
  let peak = { year: rows[0]!.year, cents: BigInt(rows[0]!.tax.totalFederalCents) };
  for (const row of rows) {
    for (const bucket of PlanBucket.options) {
      const ending = BigInt(row.ending.byBucket[bucket]);
      if (BigInt(row.withdrawals.byBucket[bucket]) > 0n || ending > 0n) held[bucket] = true;
      if (held[bucket] && ending === 0n && !depleted.has(bucket)) {
        depleted.add(bucket);
        depletion.push({ bucket, year: row.year });
      }
    }
    for (const e of row.strategy.events) {
      if (e === "cut") events.cuts++;
      else if (e === "raise") events.raises++;
      else if (e === "freeze") events.freezes++;
      else if (e === "topped_up") events.topUps++;
      else if (e === "band_floor") events.bandFloors++;
      else if (e === "band_ceiling") events.bandCeilings++;
    }
    if (row.phase !== "accumulation") {
      const sp = row.spending;
      if (BigInt(sp.shortfall) > 0n || BigInt(sp.funded) + 1n < BigInt(sp.planned) + BigInt(sp.goals)) belowPlanYears++;
    }
    const tax = BigInt(row.tax.totalFederalCents);
    if (tax > peak.cents) peak = { year: row.year, cents: tax };
  }
  const story: PathStory = {
    outcome: failedRow === undefined ? "funded" : "failed",
    endingRealCents: last.ending.totalReal,
    depletion,
    first10: {},
    events,
    belowPlanYears,
    peakTax: { year: peak.year, cents: peak.cents.toString() },
  };
  if (failedRow !== undefined) {
    story.failureYear = failedRow.year;
    story.failureAges = failedRow.ages.filter((_, i) => failedRow.alive[i] === true);
  }
  const own = realReturnBp(firstTen(table));
  if (own !== undefined) story.first10.realReturnBp = own;
  if (medianTable !== undefined) {
    const median = realReturnBp(firstTen(medianTable));
    if (median !== undefined) story.first10.medianRealReturnBp = median;
  }
  return story;
}
