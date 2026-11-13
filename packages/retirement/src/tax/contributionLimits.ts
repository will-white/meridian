/**
 * Contribution limits (tax-rmd-ss §3.10, decisions 41 and 42; seams C26; plan decision 5).
 *
 * The hot-path functions read one program record (`p` at offset `o`, filled by `fillPathTables`
 * with the year's published or indexed limits) and return the limit for the plan year's period in
 * dollars. Ages are whole years attained by 31 December (`year − birthYear`, decision 27).
 *
 * The period rule (C14, C26 "× f in year 0") is applied here, not by the caller: with
 * `f = periodMonths / 12` (the convention of `TI.YEAR_FRACTION`: a value outside (0, 1) means a full
 * year) the deferral, annual-additions and IRA limits are the full-year limit × `f`, and the HSA
 * limit counts the months of the period before the month the owner turns 65
 * (`hsaMonthsBefore65`), which in year 0 is the same as `f` × the share of the period before 65.
 * The area design's formula `clamp(birthIndex + 780 − 12 × year, 0, 12)` counts calendar months
 * and then × `f`; for an owner who turns 65 inside a partial first year that counts the months
 * from January twice, so the months are counted inside the period instead (equal for every full
 * year).
 *
 * `contributionLimit` is the allocating form for the resolver's `contribution_over_limit` warning
 * (and `PlannerEnv.contributionLimit`): the same functions on a published year's record, in cents.
 */

import { dollarsToCentsBigInt } from "../units.js";
import { compileTaxLaw, fillYearAtFactors } from "./compile.js";
import { PR, PROG_REC, TAX_REC } from "./layout.js";
import { MONTHS_65 } from "./penalties.js";
import { loadTaxData, type TaxData } from "./taxData.js";

/** The year fraction as `TI.YEAR_FRACTION` reads it: a value outside (0, 1) is a full year. */
function periodFraction(f: number): number {
  return f > 0 && f < 1 ? f : 1;
}

/**
 * The elective deferral limit of one owner for the period: `DEFERRAL` plus the catch-up
 * (`CATCHUP6063` at 60 to 63, else `CATCHUP50` from 50), × `f`. One limit is shared by all of the
 * owner's accounts of type `401k`, pre-tax and Roth.
 */
export function employeeDeferralLimit(p: Float64Array, o: number, age: number, f: number): number {
  const catchUp = age >= 60 && age <= 63 ? p[o + PR.CATCHUP6063]! : age >= 50 ? p[o + PR.CATCHUP50]! : 0;
  return (p[o + PR.DEFERRAL]! + catchUp) * periodFraction(f);
}

/** The §415(c) annual-additions limit (employee plus employer, catch-up excluded) for the period, × `f`. */
export function annualAdditionsLimit(p: Float64Array, o: number, f: number): number {
  return p[o + PR.ANNUAL_ADD]! * periodFraction(f);
}

/**
 * The IRA limit of one owner for the period: `IRA` plus `IRA_CATCHUP` from 50, × `f`, shared by the
 * owner's accounts of type `ira` and `roth`. The caller also caps it at the household's wages of the
 * period; no income test applies (tax-rmd-ss §8.2 `ira_deduction_limits`).
 */
export function iraLimit(p: Float64Array, o: number, age: number, f: number): number {
  return (p[o + PR.IRA]! + (age >= 50 ? p[o + PR.IRA_CATCHUP]! : 0)) * periodFraction(f);
}

/**
 * The months of a period before the month the owner turns 65 (Medicare; no HSA contributions from
 * then on): `clamp(birthIndex + 780 − periodStart, 0, periodMonths)`, with the month numbers of
 * clock.ts (`birthIndex` from `birthMonthIndex`).
 */
export function hsaMonthsBefore65(birthIndex: number, periodStart: number, periodMonths: number): number {
  const m = birthIndex + MONTHS_65 - periodStart;
  return m <= 0 ? 0 : m >= periodMonths ? periodMonths : m;
}

/**
 * The HSA limit of one owner for the period: (`HSA_FAMILY` or `HSA_SELF`, plus `HSA_CATCHUP` from 55)
 * × `monthsBefore65 / 12`, where `monthsBefore65` counts months of this period (`hsaMonthsBefore65`).
 * The plan does not know the coverage tier, so the engine passes `family = true`.
 */
export function hsaLimit(p: Float64Array, o: number, age: number, family: boolean, monthsBefore65: number): number {
  const base = family ? p[o + PR.HSA_FAMILY]! : p[o + PR.HSA_SELF]!;
  return ((base + (age >= 55 ? p[o + PR.HSA_CATCHUP]! : 0)) * monthsBefore65) / 12;
}

// ---------------------------------------------------------------------------------------------
// contributionLimit: the allocating form, in cents

export type ContributionLimitKind = "employer_plan" | "ira" | "hsa_family";

const PROGRAM_RECORDS = new WeakMap<TaxData, Map<number, Float64Array>>();

/** The program record of a published year (current law, nothing indexed), cached per data bundle. */
function publishedProgram(data: TaxData, year: number): Float64Array {
  let byYear = PROGRAM_RECORDS.get(data);
  if (!byYear) {
    byYear = new Map();
    PROGRAM_RECORDS.set(data, byYear);
  }
  let prog = byYear.get(year);
  if (!prog) {
    const law = compileTaxLaw(data, { startYear: year, years: 1, ruleSetId: "current_law" });
    prog = new Float64Array(PROG_REC);
    fillYearAtFactors(law, 0, 1, 1, 0, new Float64Array(2 * TAX_REC), prog);
    byYear.set(year, prog);
  }
  return prog;
}

/**
 * The full-year limit in cents for an owner of `age` (attained by year end) in a published tax
 * year: `employer_plan` is the deferral limit, `ira` the IRA limit, `hsa_family` the family HSA
 * limit with the age-55 catch-up and no proration; `null` for a year before the first or after the
 * last published year. A pending limit (decision 42) is the carried amount the year file holds.
 */
export function contributionLimit(year: number, age: number, kind: ContributionLimitKind, data: TaxData = loadTaxData()): bigint | null {
  if (!Number.isInteger(year)) throw new RangeError(`year must be an integer, got ${year}`);
  if (!Number.isInteger(age) || age < 0) throw new RangeError(`age must be a whole number of years, got ${age}`);
  if (year < data.firstTaxYear || year > data.lastPublishedYear) return null;
  const p = publishedProgram(data, year);
  const dollars = kind === "employer_plan" ? employeeDeferralLimit(p, 0, age, 1) : kind === "ira" ? iraLimit(p, 0, age, 1) : hsaLimit(p, 0, age, true, 12);
  return dollarsToCentsBigInt(dollars);
}
