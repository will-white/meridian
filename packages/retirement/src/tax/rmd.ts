/**
 * Required minimum distributions (tax-rmd-ss §3.8, decisions 28 to 31; seams C36).
 *
 * The divisor is Publication 590-B's Uniform Lifetime table (Table III), or its Joint Life and Last
 * Survivor table (Table II) while the owner has a living spouse more than ten years younger. Start
 * ages come from the start-age rows of `rmd/uniform-lifetime.json` by birth year. Ages are those
 * attained in the calendar year (`year − birthYear`). In plan year 0 the opening balance stands in
 * for the prior 31 December balance and the amount is `f ×` the full-year figure; the result is
 * never more than the balance.
 *
 * The tables are compiled once into typed arrays (`compileRmdTables`); the lookups allocate
 * nothing. Every function takes the compiled tables last, defaulting to the bundled data.
 */

import { loadTaxData, type TaxData } from "./taxData.js";

/** The RMD tables as typed arrays, compiled once from the data files. */
export interface RmdTables {
  /** Table III: `uniform[age − uniformFirstAge]`, ages `uniformFirstAge` … `uniformLastAge` (the last row is "and over"). */
  readonly uniform: Float64Array;
  readonly uniformFirstAge: number;
  readonly uniformLastAge: number;
  /** Table II as a square: `joint[(a − jointFirstAge) × jointSize + (b − jointFirstAge)]`; null in the fallback (no rows). */
  readonly joint: Float64Array | null;
  readonly jointFirstAge: number;
  readonly jointLastAge: number;
  readonly jointSize: number;
  /** Table II applies when the owner is more than this many years older than a living spouse. */
  readonly spouseGapYears: number;
  /** Start-age rows `[last birth year, start age]`, ascending; a birth year uses the first row at or after it. */
  readonly startAgeRows: ReadonlyArray<readonly [number, number]>;
}

/** Compiles the RMD tables of a validated data bundle (the loader has checked their shapes). */
export function compileRmdTables(data: TaxData): RmdTables {
  const u = data.uniform;
  const j = data.joint;
  const size = j.lastAge - j.firstAge + 1;
  let joint: Float64Array | null = null;
  if (j.rows.length > 0) {
    joint = new Float64Array(size * size);
    for (let a = 0; a < size; a++) {
      const row = j.rows[a] as readonly number[];
      for (let b = 0; b < size; b++) joint[a * size + b] = row[b] as number;
    }
  }
  return Object.freeze({
    uniform: Float64Array.from(u.divisors),
    uniformFirstAge: u.firstAge,
    uniformLastAge: u.lastAge,
    joint,
    jointFirstAge: j.firstAge,
    jointLastAge: j.lastAge,
    jointSize: size,
    spouseGapYears: u.jointTableSpouseGapYears,
    startAgeRows: u.startAge.map((r) => [r[0], r[1]] as const),
  });
}

let bundled: RmdTables | undefined;

/** The tables of the bundled data, compiled on first use. */
export function defaultRmdTables(): RmdTables {
  bundled ??= compileRmdTables(loadTaxData());
  return bundled;
}

function clampInt(x: number, lo: number, hi: number): number {
  const i = Math.floor(x);
  return i < lo ? lo : i > hi ? hi : i;
}

/** The age at which RMDs start for a birth year: 72 (born 1950 or earlier), 73 (1951 to 1959), 75 (1960 and later). */
export function rmdStartAge(birthYear: number, tables: RmdTables = defaultRmdTables()): number {
  const rows = tables.startAgeRows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as readonly [number, number];
    if (birthYear <= row[0]) return row[1];
  }
  return (rows[rows.length - 1] as readonly [number, number])[1];
}

/** The calendar year of the first RMD (decision 30: taken in the year the start age is reached, never deferred). */
export function firstRmdYear(birthYear: number, tables: RmdTables = defaultRmdTables()): number {
  return birthYear + rmdStartAge(birthYear, tables);
}

/**
 * The distribution period for an owner aged `age` in the year. With a living spouse (`spouseAge ≥
 * 0`) more than `spouseGapYears` younger, Table II at `(min(age, 120), clamp(spouseAge, 20, 120))`;
 * otherwise, or when Table II is not installed, Table III at `clamp(age, 72, 120)`. `spouseAge` is
 * −1 when there is no living spouse.
 */
export function rmdDivisor(age: number, spouseAge: number, tables: RmdTables = defaultRmdTables()): number {
  const joint = tables.joint;
  if (joint !== null && spouseAge >= 0 && age - spouseAge > tables.spouseGapYears) {
    const a = clampInt(age, tables.jointFirstAge, tables.jointLastAge) - tables.jointFirstAge;
    const b = clampInt(spouseAge, tables.jointFirstAge, tables.jointLastAge) - tables.jointFirstAge;
    return joint[a * tables.jointSize + b] as number;
  }
  return tables.uniform[clampInt(age, tables.uniformFirstAge, tables.uniformLastAge) - tables.uniformFirstAge] as number;
}

/**
 * The RMD for a year, unrounded: 0 when `age < startAge` or the balance is not positive, else
 * `priorYearEndBalance ÷ rmdDivisor(age, spouseAge) × f`, capped at the balance. `f` is
 * `yearFraction` in plan year 0 (`firstYearMonths / 12`, applied to the opening balance) and 1
 * otherwise; as in `TI.YEAR_FRACTION`, a value outside (0, 1) means a full year. Called per
 * pre-tax account with the account's balance, the amounts sum to the owner's total (one divisor
 * per owner, seams C36); the caller must not multiply by `f` again.
 */
export function requiredMinimumDistribution(
  priorYearEndBalance: number,
  age: number,
  startAge: number,
  spouseAge: number,
  yearFraction = 1,
  tables: RmdTables = defaultRmdTables(),
): number {
  if (!(priorYearEndBalance > 0) || age < startAge) return 0;
  const f = yearFraction > 0 && yearFraction < 1 ? yearFraction : 1;
  const amount = (priorYearEndBalance / rmdDivisor(age, spouseAge, tables)) * f;
  return amount < priorYearEndBalance ? amount : priorYearEndBalance;
}
