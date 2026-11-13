// Federal income tax law for the independent calculator: my own transcription of the figures the
// reference sheets state (r1.md §2.10, r2.md §2.10), not a copy of packages/retirement/data.
//
// Source named by the sheets: Rev. Proc. 2026-35, sections 3.01 (Tables 1 and 3), 3.03 and 3.15
// (www.irs.gov, retrieved 2026-11-10, SHA-256 87b383c6ce6e616fd006a61f5eed46fe67099b9c23fb1e1c42ff5359474513b8),
// for tax year 2027. Statutory amounts that are not indexed (the senior deduction and its phase-out,
// the Social Security base amounts, the net investment income tax, the capital-loss limit) are the
// sheets' "Not indexed" paragraph.

export type Filing = "joint" | "single";

/** The seven ordinary rates, lowest bracket first. */
export const RATES: readonly number[] = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];

interface IndexedFigures {
  /** Lower bounds of the 12% to 37% brackets (the 10% bracket starts at 0). */
  readonly bracketFrom: readonly number[];
  readonly standard: number;
  /** Additional standard deduction for each filer 65 or older. */
  readonly aged: number;
  /** Taxable income up to which gains and qualified dividends are taxed at 0%. */
  readonly max0: number;
  /** ... and at 15%. */
  readonly max15: number;
}

/** Tax year 2027, the last published year. */
export const LAW_2027: Readonly<Record<Filing, IndexedFigures>> = {
  joint: {
    bracketFrom: [25_600, 104_050, 218_250, 416_650, 529_100, 793_650],
    standard: 33_200,
    aged: 1_700,
    max0: 102_100,
    max15: 633_600,
  },
  single: {
    bracketFrom: [12_800, 52_025, 109_125, 208_325, 264_550, 661_375],
    standard: 16_600,
    aged: 2_100,
    max0: 51_050,
    max15: 563_200,
  },
};

/** The statute's rounding steps for indexing after 2027 (joint / single, sheets §2.10). */
const STEPS: Readonly<Record<Filing, { bracket: number; standard: number; aged: number; max0: number; max15: number }>> = {
  joint: { bracket: 50, standard: 100, aged: 50, max0: 50, max15: 50 },
  single: { bracket: 25, standard: 50, aged: 50, max0: 25, max15: 50 },
};

/** Fixed by statute, not indexed. */
export const STATUTORY = {
  seniorEach: 6_000,
  seniorPhaseOutRate: 0.06,
  seniorPhaseOutStart: { joint: 150_000, single: 75_000 } as Readonly<Record<Filing, number>>,
  /** The senior deduction exists for these tax years only under current_law. */
  seniorYears: [2027, 2028] as readonly number[],
  ssBase: { joint: [32_000, 44_000], single: [25_000, 34_000] } as Readonly<Record<Filing, readonly [number, number]>>,
  niitRate: 0.038,
  niitThreshold: { joint: 250_000, single: 200_000 } as Readonly<Record<Filing, number>>,
  capitalLossLimit: 3_000,
  earlyPenaltyRate: 0.1,
  hsaPenaltyRate: 0.2,
} as const;

export const LAST_PUBLISHED_YEAR = 2027;

/** The law of one tax year and filing status, every threshold already indexed. */
export interface YearLaw {
  readonly year: number;
  readonly filing: Filing;
  /** F, the indexing factor from 2027 (1 in 2027). */
  readonly factor: number;
  /** thr_0 = 0 < thr_1 < … < thr_6. */
  readonly thresholds: readonly number[];
  readonly standard: number;
  readonly aged: number;
  readonly max0: number;
  readonly max15: number;
  /** 6,000 in 2027 and 2028, 0 afterwards. */
  readonly seniorEach: number;
}

/** `v_Y = v_2027 + floor(v_2027 × (F_Y − 1) / step + 1e−9) × step`, always from the 2027 value. */
export function indexValue(v2027: number, factor: number, step: number): number {
  return v2027 + Math.floor((v2027 * (factor - 1)) / step + 1e-9) * step;
}

/**
 * The law for `year` given F_year (the product of (1 + inflation) over the plan years 2027 to
 * year − 1, by repeated float64 multiplication; 1 for 2027).
 */
export function lawFor(year: number, filing: Filing, factor: number): YearLaw {
  if (year < LAST_PUBLISHED_YEAR) throw new RangeError(`no law transcribed before ${LAST_PUBLISHED_YEAR}: ${year}`);
  const base = LAW_2027[filing];
  const step = STEPS[filing];
  const f = year === LAST_PUBLISHED_YEAR ? 1 : factor;
  return {
    year,
    filing,
    factor: f,
    thresholds: [0, ...base.bracketFrom.map((v) => indexValue(v, f, step.bracket))],
    standard: indexValue(base.standard, f, step.standard),
    aged: indexValue(base.aged, f, step.aged),
    max0: indexValue(base.max0, f, step.max0),
    max15: indexValue(base.max15, f, step.max15),
    seniorEach: STATUTORY.seniorYears.includes(year) ? STATUTORY.seniorEach : 0,
  };
}

/** The rate schedule: `base_i + (z − thr_i) × rate_i` for the largest i with thr_i < z. */
export function schedule(law: YearLaw, z: number): number {
  if (z <= 0) return 0;
  let base = 0;
  let i = 0;
  for (let k = 1; k < law.thresholds.length; k++) {
    const thr = law.thresholds[k] as number;
    if (!(thr < z)) break;
    base += (thr - (law.thresholds[k - 1] as number)) * (RATES[k - 1] as number);
    i = k;
  }
  return base + (z - (law.thresholds[i] as number)) * (RATES[i] as number);
}

/** Index of the bracket that holds z (0 for z ≤ the first threshold). */
export function bracketIndex(law: YearLaw, z: number): number {
  let i = 0;
  for (let k = 1; k < law.thresholds.length; k++) if ((law.thresholds[k] as number) < z) i = k;
  return i;
}
