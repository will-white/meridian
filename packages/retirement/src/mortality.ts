/**
 * Mortality, the horizon and the death draws (engine-and-returns decision 18 and §3.6; seams C14,
 * C28; plan decision 11, G4).
 *
 * Ages are whole years attained in the calendar year: `age(t) = startYear + t − birthYear`.
 *
 * - **Fixed** (`longevity.mode = "fixed"`): alive through the calendar year in which `age` is
 *   attained; `deathIdx = max(0, birthYear + age − startYear)`.
 * - **Mortality** (`longevity.mode = "mortality"`, C28): the table is read at `age − adjustYears`
 *   (+2 = two years healthier), death is certain in the year `maxAge` is attained, and the horizon
 *   ends there (which is how the resolver computes `plan.endYear`). A person who attains age a in a
 *   calendar year is a − 1 for part of it and a for the rest, so the calendar-year probability is
 *   `qCal(a) = min(1, qScale · (q[a−1] + q[a]) / 2)` for 1 ≤ a ≤ M and 1 above M (q[M] = 1);
 *   qScale is the internal constant 1 (C28). The cumulative death probability by plan year is
 *   `S_{−1} = 1`, `S_t = S_{t−1} · (1 − qCal)^{f_t}`, `cdf[t] = 1 − S_t` (exactly 1 once qCal is 1),
 *   with `f_0 = firstYearMonths / 12` and `f_t = 1` after (C14: the year-0 death probability is
 *   `1 − (1 − q)^f`). Per path one uniform per person, `uniformAt(MORTALITY, 0, person)`, is
 *   inverted: `deathIdx` is the first t with `cdf[t] > u` (strict).
 *
 * A person is alive during the whole of the death year and gone from the next (deaths take effect
 * at the year's end; the survivor files single from the following year, L2). The horizon is
 * `Y = 1 + max_i(last possible deathIdx_i)`, at most 120 years (`horizon_too_long`).
 *
 * Tables: the SSA period life table by sex when `ssa-period-life-table.csv` is installed (D4), with
 * q[119] = 1; until then the IRS Table 2010CM (unisex; D3) with `q[x] = 1 − lx[x+1]/lx[x]` and
 * q[109] = 1, under which `sex` has no effect and the run carries `mortality_fallback_table`.
 */

import type { Longevity, MortalityTableId } from "@meridian/shared";
import { detPow } from "./detmath.js";
import { EngineInputError } from "./errors.js";
import { LIFE_2010CM_LX, LIFE_SSA_FEMALE_QX, LIFE_SSA_MALE_QX } from "./generated/data.js";
import { MAX_PLAN_YEARS, firstYearFraction } from "./models/market.js";
import { PURPOSE, type RngKey, uniformAt } from "./rng.js";
import type { EngineWarning } from "./warning.js";

/** The engine's mortality multiplier: an internal constant (C28), not an input. */
export const Q_SCALE = 1;

export type LifeTableId = Exclude<MortalityTableId, "fixed">;

export interface LifeTable {
  readonly id: LifeTableId;
  /** q[x], the probability of dying within a year at exact age x, for x = 0 … M; q[M] = 1. */
  readonly q: Float64Array;
  /** M, the table's last age. */
  readonly lastAge: number;
}

export interface LifeTables {
  /** IRS Table 2010CM, unisex. */
  readonly fallback: LifeTable;
  /** The SSA period table's columns, or null while it is not installed. */
  readonly female: LifeTable | null;
  readonly male: LifeTable | null;
}

/** A table from survivors l_x at ages 0 … M + 1: `q[x] = 1 − l[x+1]/l[x]` for x < M and q[M] = 1. */
export function tableFromLx(lx: ArrayLike<number>, id: LifeTableId): LifeTable {
  if (lx.length < 3) throw new RangeError("a life table needs at least three ages");
  const lastAge = lx.length - 2;
  const q = new Float64Array(lastAge + 1);
  for (let x = 0; x < lastAge; x++) q[x] = 1 - lx[x + 1]! / lx[x]!;
  q[lastAge] = 1;
  return { id, q, lastAge };
}

/** A table from q_x at ages 0 … M as published; the engine sets q[M] = 1. */
export function tableFromQx(qx: ArrayLike<number>, id: LifeTableId): LifeTable {
  if (qx.length < 2) throw new RangeError("a life table needs at least two ages");
  const q = Float64Array.from(qx);
  q[q.length - 1] = 1;
  return { id, q, lastAge: q.length - 1 };
}

export function buildLifeTables(lx2010cm: ArrayLike<number>, ssaMaleQx: ArrayLike<number> | null, ssaFemaleQx: ArrayLike<number> | null): LifeTables {
  const installed = ssaMaleQx !== null && ssaFemaleQx !== null;
  return {
    fallback: tableFromLx(lx2010cm, "irs_2010cm_fallback"),
    male: installed ? tableFromQx(ssaMaleQx, "ssa_period") : null,
    female: installed ? tableFromQx(ssaFemaleQx, "ssa_period") : null,
  };
}

/** The tables of this data version (D3, and D4 once installed). */
export const LIFE_TABLES: LifeTables = buildLifeTables(LIFE_2010CM_LX, LIFE_SSA_MALE_QX, LIFE_SSA_FEMALE_QX);

/** The table a person of this sex uses, and whether it is the unisex fallback. */
export function lifeTableFor(sex: "female" | "male", tables: LifeTables = LIFE_TABLES): { table: LifeTable; fallback: boolean } {
  const own = sex === "female" ? tables.female : tables.male;
  return own === null ? { table: tables.fallback, fallback: true } : { table: own, fallback: false };
}

/**
 * The probability of dying during the calendar year in which `age` is attained (§3.6 `qCal`), on a
 * table whose last age is `lastAge`: `min(1, qScale · (q[a−1] + q[a]) / 2)` for 1 ≤ a ≤ M, 1 above M.
 * A table age below 1 (only reachable with a large `adjustYears` at a young age) is read at 1.
 */
export function calendarDeathProbability(q: ArrayLike<number>, lastAge: number, qScale: number, age: number): number {
  if (age > lastAge) return 1;
  const a = age < 1 ? 1 : age;
  return Math.min(1, (qScale * (q[a - 1]! + q[a]!)) / 2);
}

/** The first plan year t (0 … years − 1) with `cdf[offset + t] > u`; the last year when none is. */
export function deathIndexFromCdf(cdf: ArrayLike<number>, offset: number, years: number, u: number): number {
  for (let t = 0; t < years; t++) if (cdf[offset + t]! > u) return t;
  return years - 1;
}

/** Whether a person whose death year is `deathIdx` is alive during plan year t (deaths take effect at the year's end). */
export function aliveInYear(deathIdx: number, t: number): boolean {
  return t <= deathIdx;
}

export interface MortalityPerson {
  readonly birthYear: number;
  readonly longevity: Longevity;
}

export interface MortalityPlan {
  readonly startYear: number;
  readonly firstYearMonths: number;
}

export interface CompiledMortality {
  readonly people: number;
  /** The horizon Y: 1 + the latest possible death index. */
  readonly years: number;
  /** Every person has a fixed life expectancy (decides the historical model's cohorts and paths). */
  readonly allFixed: boolean;
  /** `SimSummary.mortalityTable`. */
  readonly table: MortalityTableId;
  /** Per person: the last possible death index (the fixed age's year, or the year `maxAge` is attained). */
  readonly lastIndex: Int16Array;
  /** Per person: the fixed death index, −1 for a table person. */
  readonly fixedIndex: Int16Array;
  /** Per person and plan year (`person * years + t`): the cumulative death probability; NaN for a fixed person. */
  readonly cdf: Float64Array;
  readonly warnings: readonly EngineWarning[];
  /** Writes each person's death index of path k into `out[0 … people − 1]`. */
  drawDeaths(key: RngKey, pathIndex: number, out: Int16Array): void;
}

/** The cumulative death probabilities of one table person over `years` plan years, into `out[offset …]`. */
export function fillDeathCdf(
  table: LifeTable,
  person: { birthYear: number; adjustYears: number; maxAge: number },
  plan: MortalityPlan,
  years: number,
  out: Float64Array,
  offset = 0,
  qScale: number = Q_SCALE,
): void {
  const f = firstYearFraction(plan.firstYearMonths);
  let survival = 1;
  for (let t = 0; t < years; t++) {
    const age = plan.startYear + t - person.birthYear;
    const qc = age >= person.maxAge ? 1 : calendarDeathProbability(table.q, table.lastAge, qScale, age - person.adjustYears);
    if (qc >= 1) {
      survival = 0;
    } else {
      survival *= t === 0 && f < 1 ? detPow(1 - qc, f) : 1 - qc;
    }
    out[offset + t] = survival === 0 ? 1 : 1 - survival;
  }
}

const FALLBACK_MESSAGE =
  "Life expectancy draws use the IRS 2010 table for both sexes (Table 2010CM) because the Social Security table is not installed; sex has no effect.";

export function compileMortality(people: readonly MortalityPerson[], plan: MortalityPlan, tables: LifeTables = LIFE_TABLES): CompiledMortality {
  const count = people.length;
  if (count < 1 || count > 2) throw new RangeError(`a household has one or two people, got ${count}`);
  firstYearFraction(plan.firstYearMonths);
  const lastIndex = new Int16Array(count);
  const fixedIndex = new Int16Array(count).fill(-1);
  let years = 0;
  let allFixed = true;
  for (let i = 0; i < count; i++) {
    const p = people[i]!;
    const lastAge = p.longevity.mode === "fixed" ? p.longevity.age : p.longevity.maxAge;
    const last = Math.max(0, p.birthYear + lastAge - plan.startYear);
    lastIndex[i] = Math.min(last, MAX_PLAN_YEARS);
    if (p.longevity.mode === "fixed") fixedIndex[i] = lastIndex[i]!;
    else allFixed = false;
    years = Math.max(years, last + 1);
  }
  if (years > MAX_PLAN_YEARS) {
    throw new EngineInputError("horizon_too_long", `A plan cannot run for more than ${MAX_PLAN_YEARS} years; this one runs ${years}`);
  }

  const cdf = new Float64Array(count * years).fill(Number.NaN);
  let usedFallback = false;
  let usedSsa = false;
  for (let i = 0; i < count; i++) {
    const p = people[i]!;
    if (p.longevity.mode === "fixed") continue;
    const { table, fallback } = lifeTableFor(p.longevity.sex, tables);
    if (fallback) usedFallback = true;
    else usedSsa = true;
    fillDeathCdf(table, { birthYear: p.birthYear, adjustYears: p.longevity.adjustYears, maxAge: p.longevity.maxAge }, plan, years, cdf, i * years);
  }
  const table: MortalityTableId = allFixed ? "fixed" : usedFallback || !usedSsa ? "irs_2010cm_fallback" : "ssa_period";
  const warnings: EngineWarning[] = usedFallback ? [{ code: "mortality_fallback_table", message: FALLBACK_MESSAGE }] : [];

  return {
    people: count,
    years,
    allFixed,
    table,
    lastIndex,
    fixedIndex,
    cdf,
    warnings,
    drawDeaths(key: RngKey, pathIndex: number, out: Int16Array): void {
      for (let i = 0; i < count; i++) {
        const fixed = fixedIndex[i]!;
        out[i] = fixed >= 0 ? fixed : deathIndexFromCdf(cdf, i * years, years, uniformAt(key, pathIndex, PURPOSE.MORTALITY, 0, i));
      }
    },
  };
}
