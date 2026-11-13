// R3: the 4% rule on the historical record (r3.md), in the engine's convention (complete cohorts,
// withdrawal at the start of the year) and in the Trinity study's (return first, then the
// withdrawal at the year-end price level). Written from r3.md alone.

export interface ReturnRow {
  readonly year: number;
  readonly stocks: number;
  readonly bonds: number;
  readonly bills: number;
  readonly inflation: number;
}

/** The pinned data file (r3.md §1, seams.md §8 D2). */
export const DATA_SHA256 = "ded29a465fec10fd2877b7f3cbe91c86e1133b336623f4de62ce510a44965e8c";

/** Validation rows of r3.md §1: year → stocks, bonds, bills, inflation. */
const VALIDATION: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [1928, 0.438112, 0.008355, 0.0308, -0.011561],
  [1966, -0.09971, 0.029079, 0.048557, 0.034591],
  [1974, -0.259018, 0.019886, 0.078458, 0.123377],
  [2008, -0.365523, 0.201013, 0.014, 0.000914],
];

/** Parses `year,stocks,bonds,bills,inflation` and refuses a file that is not the pinned series. */
export function parseReturns(text: string): ReturnRow[] {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines[0] !== "year,stocks,bonds,bills,inflation") throw new Error("us-annual-returns.csv: unexpected header");
  const rows = lines.slice(1).map((line) => {
    const [year, stocks, bonds, bills, inflation] = line.split(",").map(Number);
    if ([year, stocks, bonds, bills, inflation].some((v) => v === undefined || !Number.isFinite(v))) {
      throw new Error(`us-annual-returns.csv: bad row ${line}`);
    }
    return { year: year as number, stocks: stocks as number, bonds: bonds as number, bills: bills as number, inflation: inflation as number };
  });
  if (rows.length !== 98 || rows[0]?.year !== 1928 || rows[97]?.year !== 2025) throw new Error("us-annual-returns.csv: expected 98 rows, 1928 to 2025");
  rows.forEach((r, i) => {
    if (r.year !== 1928 + i) throw new Error(`us-annual-returns.csv: year ${r.year} out of order`);
  });
  for (const [year, ...values] of VALIDATION) {
    const r = rows[year - 1928] as ReturnRow;
    const got = [r.stocks, r.bonds, r.bills, r.inflation];
    if (got.some((v, i) => v !== values[i])) {
      throw new Error(`us-annual-returns.csv: ${year} is ${got.join(", ")}, expected ${values.join(", ")} (the "Nominal vs Real Data" sheet?)`);
    }
  }
  return rows;
}

export interface CohortPath {
  readonly startYear: number;
  /** First failing plan-year index (0 = 2027), or −1 when every year is funded. */
  readonly failIndex: number;
  readonly shortfallReal: number;
  readonly endNominal: number;
  readonly cpiEnd: number;
  readonly endReal: number;
  /** Year by year, for the path tables (r3.md §3). */
  readonly years: ReadonlyArray<{
    readonly dataYear: number;
    readonly start: number;
    readonly need: number;
    readonly shortfall: number;
    readonly portfolioReturn: number;
    readonly end: number;
    readonly inflation: number;
  }>;
}

export const R3_PLAN_YEARS = 30;
export const R3_START_BALANCE = 1_000_000;
export const R3_BASE_SPENDING = 40_000;

/**
 * The engine's convention (r3.md §2): at the start of each year the need 40,000 × cpi[t] is
 * withdrawn (all that is left when the balance is short), then the rebalanced account earns the
 * year's return, then the price level moves with the same row's inflation.
 */
export function cohortPath(rows: readonly ReturnRow[], start: number, stockShare: number): CohortPath {
  let balance = R3_START_BALANCE;
  let cpi = 1;
  let failIndex = -1;
  let shortfallReal = 0;
  const years: Array<CohortPath["years"][number]> = [];
  for (let t = 0; t < R3_PLAN_YEARS; t++) {
    const row = rows[start + t];
    if (row === undefined) throw new RangeError(`start row ${start} runs past the record`);
    const begin = balance;
    const need = R3_BASE_SPENDING * cpi;
    let shortfall = 0;
    if (balance >= need) balance -= need;
    else {
      shortfall = need - balance;
      balance = 0;
      if (failIndex < 0) failIndex = t;
      shortfallReal += shortfall / cpi;
    }
    const portfolioReturn = stockShare * row.stocks + (1 - stockShare) * row.bonds;
    balance = balance * (1 + portfolioReturn);
    cpi = cpi * (1 + row.inflation);
    years.push({ dataYear: row.year, start: begin, need, shortfall, portfolioReturn, end: balance, inflation: row.inflation });
  }
  return { startYear: (rows[start] as ReturnRow).year, failIndex, shortfallReal, endNominal: balance, cpiEnd: cpi, endReal: balance / cpi, years };
}

/**
 * The Trinity study's convention (r3.md §2): each year the balance first earns the year's return,
 * then 40,000 × the price level at that year's end is withdrawn; a window fails when a withdrawal
 * exceeds the balance.
 */
export function trinityWindowSucceeds(rows: readonly ReturnRow[], start: number, stockShare: number): boolean {
  let balance = R3_START_BALANCE;
  let cpi = 1;
  for (let t = 0; t < R3_PLAN_YEARS; t++) {
    const row = rows[start + t];
    if (row === undefined) throw new RangeError(`start row ${start} runs past the record`);
    balance = balance * (1 + (stockShare * row.stocks + (1 - stockShare) * row.bonds));
    cpi = cpi * (1 + row.inflation);
    const withdrawal = R3_BASE_SPENDING * cpi;
    if (withdrawal > balance) return false;
    balance -= withdrawal;
  }
  return true;
}

/** Rank rule of r3.md §2 and r4.md §2: ending wealth in today's dollars in cents, then the failing year (never last), then the path index. */
export function rankOrder(endRealCents: ArrayLike<number>, failIndex: ArrayLike<number>): Int32Array {
  const n = endRealCents.length;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const failKey = (i: number): number => {
    const f = failIndex[i] as number;
    return f < 0 ? Number.MAX_SAFE_INTEGER : f;
  };
  order.sort((a, b) => (endRealCents[a] as number) - (endRealCents[b] as number) || failKey(a) - failKey(b) || a - b);
  return order;
}

/** The rank of the p-th percentile: `max(0, ceil(p × N ÷ 100) − 1)`. */
export const percentileRank = (p: number, n: number): number => Math.max(0, Math.ceil((p * n) / 100) - 1);
