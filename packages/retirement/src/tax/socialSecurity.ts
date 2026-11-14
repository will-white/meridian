/**
 * Social Security benefits (tax-rmd-ss §3.9, decisions 32 to 40; seams C20, C21, C37).
 *
 * A benefit is the person's PIA times an age factor, paid month by month: `socialSecurityYear`
 * returns the benefits of a plan year's period (the months the plan covers, not twelve months
 * times f; C21), and the loop does not scale them again. The PIA receives each January's COLA,
 * truncated to the dime (SSA rounding, decision 33); every benefit is truncated to the dime and the
 * month's payment to the dollar. The COLA itself has one owner, this area (C20): `fillPathTables`
 * writes it into the program table with `roundCola` (path inflation rounded to 0.1%, never
 * negative, measured against the last level that produced one; the published 2026 and 2027 values
 * before that), and `compileSsPlan` carries a statement's amount to the plan start with the history
 * of `ss/rules.json`, the year files and the same rule for the stale years.
 *
 * Every constant of a rule is read from `data/ss/rules.json` (`compileSsRules`); fractions are kept
 * as integers on a common denominator, so each factor is one division of exact integers (decision
 * 32). `SS_RULES` lists the rules with the figures they rest on, and `ssRuleVerification` reads the
 * figures' verification marks. No figure of this module is `primary` (www.ssa.gov refuses
 * automated requests, plan decision 11), and the rules coded here without a data figure (SSA
 * rounding, deemed filing, the January rule, the order of the widow(er)'s limit, the earnings
 * test's credit-back) are unverified (seams §9 item 1).
 *
 * The hot-path functions (`resetSsState`, `socialSecurityYear`) allocate nothing and write only
 * their state and output records; the compile and preview functions allocate and may throw.
 */

import type { SimInput, SocialSecurityParts, SocialSecurityPreviewRequest, SocialSecurityPreviewResponse } from "@meridian/shared";
import { monthIndex } from "../clock.js";
import { EngineInputError } from "../errors.js";
import { centsToDollars, dollarsToCents, ratioToBp } from "../units.js";
import { PR, SO, SO_REC, SS, SS_REC } from "./layout.js";
import { birthMonthIndex } from "./penalties.js";
import { loadTaxData, type TaxData, type VerificationStatus } from "./taxData.js";

// ---------------------------------------------------------------------------------------------
// Full retirement ages

/** Months of age at a birth-year table row: the first row whose year is at or after `birthYear`. */
function birthYearRow(rows: ReadonlyArray<readonly [number, number]>, birthYear: number): number {
  for (const [year, months] of rows) if (birthYear <= year) return months;
  return (rows[rows.length - 1] as readonly [number, number])[1];
}

/** Full retirement age in months for a retirement or spousal benefit (780 = 65, 792 = 66, 804 = 67). */
export function fraMonths(birthYear: number, data: TaxData = loadTaxData()): number {
  return birthYearRow(data.ss.retirementFraMonths, birthYear);
}

/** Full retirement age in months for a widow(er)'s benefit: the retirement table read two birth years earlier. */
export function survivorFraMonths(birthYear: number, data: TaxData = loadTaxData()): number {
  return birthYearRow(data.ss.retirementFraMonths, birthYear - data.ss.survivorFraBirthYearShift);
}

// ---------------------------------------------------------------------------------------------
// The rule constants of ss/rules.json, compiled

/** The constants of `ss/rules.json` as integers, compiled once (`compileSsRules`). */
export interface SsRules {
  readonly fraRows: ReadonlyArray<readonly [number, number]>;
  readonly survivorShift: number;
  /** 744: the first month of a retirement benefit (claims are clamped to [earliest, latest]). */
  readonly earliestRetirementMonths: number;
  /** 840: delayed credits stop. */
  readonly latestCreditMonths: number;
  /** Early reduction: `(min(m, firstMonths) × earlyFirst + max(0, m − firstMonths) × earlyLater) / earlyDen`. */
  readonly earlyFirstMonths: number;
  readonly earlyFirst: number;
  readonly earlyLater: number;
  readonly earlyDen: number;
  /** The spousal reduction, the same way. */
  readonly spousalFirstMonths: number;
  readonly spousalFirst: number;
  readonly spousalLater: number;
  readonly spousalDen: number;
  /** A delayed credit per month: `delayedNum / delayedDen`. */
  readonly delayedNum: number;
  readonly delayedDen: number;
  /** The spousal benefit's share of the partner's PIA. */
  readonly spousalShareNum: number;
  readonly spousalShareDen: number;
  /** 720: the first month of a widow(er)'s benefit. */
  readonly survivorEarliestMonths: number;
  /** The widow(er)'s reduction at the earliest age (28.5%). */
  readonly maxReductionNum: number;
  readonly maxReductionDen: number;
  /** The widow(er)'s limit, a share of the deceased's PIA (82.5%). */
  readonly widowLimitNum: number;
  readonly widowLimitDen: number;
  /** Earnings test: the share of the excess withheld before the year of full retirement age (1/2), and in it (1/3). */
  readonly withholdUnderNum: number;
  readonly withholdUnderDen: number;
  readonly withholdFraNum: number;
  readonly withholdFraDen: number;
  /** A COLA is rounded to a multiple of this (0.001). */
  readonly colaStep: number;
  /** The same constants as a record (`RU` slots) for the hot path, which reads typed arrays only. */
  readonly table: Float64Array;
}

/**
 * Slots of the rules record (`SsRules.table`, and the head of `SsPlan.table`). The hot path reads
 * numbers from typed arrays only, so its code sees one shape whatever plans a thread has run
 * (a property read on objects of several shapes can keep doubles boxed, which allocates).
 */
const RU = {
  EARLIEST: 0,
  LATEST: 1,
  EARLY_FIRST_MONTHS: 2,
  EARLY_FIRST: 3,
  EARLY_LATER: 4,
  EARLY_DEN: 5,
  SPOUSAL_FIRST_MONTHS: 6,
  SPOUSAL_FIRST: 7,
  SPOUSAL_LATER: 8,
  SPOUSAL_DEN: 9,
  DELAYED_NUM: 10,
  DELAYED_DEN: 11,
  SHARE_NUM: 12,
  SHARE_DEN: 13,
  SURVIVOR_EARLIEST: 14,
  MAX_REDUCTION_NUM: 15,
  MAX_REDUCTION_DEN: 16,
  WIDOW_LIMIT_NUM: 17,
  WIDOW_LIMIT_DEN: 18,
  WITHHOLD_UNDER_NUM: 19,
  WITHHOLD_UNDER_DEN: 20,
  WITHHOLD_FRA_NUM: 21,
  WITHHOLD_FRA_DEN: 22,
} as const;
const RU_REC = 23;

function parseFraction(f: string): [number, number] {
  const [n, d] = f.split("/").map(Number);
  return [n as number, d as number];
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** Two fractions on their least common denominator: `[numerator 1, numerator 2, denominator]`. */
function commonDenominator(a: string, b: string): [number, number, number] {
  const [n1, d1] = parseFraction(a);
  const [n2, d2] = parseFraction(b);
  const den = (d1 / gcd(d1, d2)) * d2;
  return [n1 * (den / d1), n2 * (den / d2), den];
}

/** The rule constants of a validated data bundle (the loader has checked that every fraction lies in (0, 1]). */
export function compileSsRules(data: TaxData): SsRules {
  const ss = data.ss;
  const [earlyFirst, earlyLater, earlyDen] = commonDenominator(ss.earlyReduction.first, ss.earlyReduction.later);
  const [spousalFirst, spousalLater, spousalDen] = commonDenominator(ss.spousalReduction.first, ss.spousalReduction.later);
  const [delayedNum, delayedDen] = parseFraction(ss.delayedCreditPerMonth);
  const [spousalShareNum, spousalShareDen] = parseFraction(ss.spousalShare);
  const [maxReductionNum, maxReductionDen] = parseFraction(ss.survivor.maxReduction);
  const [widowLimitNum, widowLimitDen] = parseFraction(ss.survivor.widowLimitShare);
  const [withholdUnderNum, withholdUnderDen] = parseFraction(ss.earningsTest.withholdUnderFra);
  const [withholdFraNum, withholdFraDen] = parseFraction(ss.earningsTest.withholdFraYear);
  const table = new Float64Array(RU_REC);
  table[RU.EARLIEST] = ss.earliestRetirementMonths;
  table[RU.LATEST] = ss.latestCreditMonths;
  table[RU.EARLY_FIRST_MONTHS] = ss.earlyReduction.firstMonths;
  table[RU.EARLY_FIRST] = earlyFirst;
  table[RU.EARLY_LATER] = earlyLater;
  table[RU.EARLY_DEN] = earlyDen;
  table[RU.SPOUSAL_FIRST_MONTHS] = ss.spousalReduction.firstMonths;
  table[RU.SPOUSAL_FIRST] = spousalFirst;
  table[RU.SPOUSAL_LATER] = spousalLater;
  table[RU.SPOUSAL_DEN] = spousalDen;
  table[RU.DELAYED_NUM] = delayedNum;
  table[RU.DELAYED_DEN] = delayedDen;
  table[RU.SHARE_NUM] = spousalShareNum;
  table[RU.SHARE_DEN] = spousalShareDen;
  table[RU.SURVIVOR_EARLIEST] = ss.survivor.earliestMonths;
  table[RU.MAX_REDUCTION_NUM] = maxReductionNum;
  table[RU.MAX_REDUCTION_DEN] = maxReductionDen;
  table[RU.WIDOW_LIMIT_NUM] = widowLimitNum;
  table[RU.WIDOW_LIMIT_DEN] = widowLimitDen;
  table[RU.WITHHOLD_UNDER_NUM] = withholdUnderNum;
  table[RU.WITHHOLD_UNDER_DEN] = withholdUnderDen;
  table[RU.WITHHOLD_FRA_NUM] = withholdFraNum;
  table[RU.WITHHOLD_FRA_DEN] = withholdFraDen;
  return Object.freeze({
    fraRows: ss.retirementFraMonths.map((r) => [r[0], r[1]] as const),
    survivorShift: ss.survivorFraBirthYearShift,
    earliestRetirementMonths: ss.earliestRetirementMonths,
    latestCreditMonths: ss.latestCreditMonths,
    earlyFirstMonths: ss.earlyReduction.firstMonths,
    earlyFirst,
    earlyLater,
    earlyDen,
    spousalFirstMonths: ss.spousalReduction.firstMonths,
    spousalFirst,
    spousalLater,
    spousalDen,
    delayedNum,
    delayedDen,
    spousalShareNum,
    spousalShareDen,
    survivorEarliestMonths: ss.survivor.earliestMonths,
    maxReductionNum,
    maxReductionDen,
    widowLimitNum,
    widowLimitDen,
    withholdUnderNum,
    withholdUnderDen,
    withholdFraNum,
    withholdFraDen,
    colaStep: ss.colaStep,
    table,
  });
}

let bundledRules: SsRules | undefined;

/** The rules of the bundled data, compiled on first use. */
export function defaultSsRules(): SsRules {
  bundledRules ??= compileSsRules(loadTaxData());
  return bundledRules;
}

// ---------------------------------------------------------------------------------------------
// Factors and SSA rounding (§3.9.3, §3.9.6)

/** Truncation to the dime (the PIA after a COLA, every benefit): `floor(z × 10 + 1e−9) / 10`. */
export function floorDime(z: number): number {
  return Math.floor(z * 10 + 1e-9) / 10;
}

/** Truncation to the dollar (the month's payment): `floor(z + 1e−9)`. */
export function floorDollar(z: number): number {
  return Math.floor(z + 1e-9);
}

/**
 * A COLA from a rise `raw` of the price level: the nearest multiple of `colaStep` (0.1%), a half
 * step rounding up, never negative (§3.9.6). The `1e−9` guard (in steps) makes an exact half step
 * round up although its float64 form lies just below it: a rise of 0.05% is 0.000499999999999945
 * after `1.0005 − 1` and gives 0.1% (H9).
 */
export function roundCola(raw: number, colaStep: number): number {
  const per = Math.round(1 / colaStep);
  const c = Math.floor(raw * per + 0.5 + 1e-9) / per;
  return c > 0 ? c : 0;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// The factors on a rules record `t` (RU slots at offset 0): one formula each, shared by the
// exported functions and the hot path.

function retirementFactorAt(t: Float64Array, claimMonths: number, fra: number): number {
  const c = clamp(claimMonths, t[RU.EARLIEST]!, t[RU.LATEST]!);
  if (c < fra) {
    const m = fra - c;
    const firstMonths = t[RU.EARLY_FIRST_MONTHS]!;
    const first = m < firstMonths ? m : firstMonths;
    const den = t[RU.EARLY_DEN]!;
    return (den - (first * t[RU.EARLY_FIRST]! + (m - first) * t[RU.EARLY_LATER]!)) / den;
  }
  const den = t[RU.DELAYED_DEN]!;
  return (den + (c - fra) * t[RU.DELAYED_NUM]!) / den;
}

function spousalFactorAt(t: Float64Array, ageMonths: number, fra: number): number {
  const earliest = t[RU.EARLIEST]!;
  const a = ageMonths > earliest ? ageMonths : earliest;
  const e = fra > a ? fra - a : 0;
  const firstMonths = t[RU.SPOUSAL_FIRST_MONTHS]!;
  const first = e < firstMonths ? e : firstMonths;
  const den = t[RU.SPOUSAL_DEN]!;
  return (den - (first * t[RU.SPOUSAL_FIRST]! + (e - first) * t[RU.SPOUSAL_LATER]!)) / den;
}

function survivorFactorAt(t: Float64Array, ageMonths: number, survivorFra: number): number {
  const earliest = t[RU.SURVIVOR_EARLIEST]!;
  const span = survivorFra - earliest;
  if (!(span > 0)) return 1;
  const a = ageMonths > earliest ? ageMonths : earliest;
  const k = survivorFra > a ? survivorFra - a : 0;
  const den = t[RU.MAX_REDUCTION_DEN]! * span;
  return (den - t[RU.MAX_REDUCTION_NUM]! * k) / den;
}

/** `1 + credits × delayed credit`, as one division. */
function creditFactorAt(t: Float64Array, credits: number): number {
  const den = t[RU.DELAYED_DEN]!;
  return (den + credits * t[RU.DELAYED_NUM]!) / den;
}

/**
 * The factor of a retirement benefit claimed at `claimMonths` of age (clamped to [744, 840]) with
 * full retirement age `fra`: early, `1 − (min(m, 36) × 5/900 + max(0, m − 36) × 5/1200)` with
 * `m = fra − claim`; otherwise `1 + (claim − fra) / 150`. For 804: 7/10 at 62 … 31/25 at 70.
 */
export function retirementFactor(claimMonths: number, fra: number, r: SsRules = defaultSsRules()): number {
  return retirementFactorAt(r.table, claimMonths, fra);
}

/** `amount ÷ retirementFactor(claimMonths, fra)` as one division of the rational (1,400 ÷ 7/10 is exactly 2,000). */
function divideByRetirementFactor(amount: number, claimMonths: number, fra: number, r: SsRules): number {
  const c = clamp(claimMonths, r.earliestRetirementMonths, r.latestCreditMonths);
  if (c < fra) {
    const m = fra - c;
    const first = m < r.earlyFirstMonths ? m : r.earlyFirstMonths;
    return (amount * r.earlyDen) / (r.earlyDen - (first * r.earlyFirst + (m - first) * r.earlyLater));
  }
  return (amount * r.delayedDen) / (r.delayedDen + (c - fra) * r.delayedNum);
}

/** The factor of a spousal benefit starting at `ageMonths` (at least 744): `e = max(0, fra − age)`, 25/36 of 1% for 36 months, then 5/12 of 1%; no credits. */
export function spousalFactor(ageMonths: number, fra: number, r: SsRules = defaultSsRules()): number {
  return spousalFactorAt(r.table, ageMonths, fra);
}

/** The factor of a widow(er)'s benefit starting at `ageMonths` (at least 720): linear from 71.5% at 60 to 1 at survivor full retirement age. */
export function survivorFactor(ageMonths: number, survivorFra: number, r: SsRules = defaultSsRules()): number {
  return survivorFactorAt(r.table, ageMonths, survivorFra);
}

// ---------------------------------------------------------------------------------------------
// The plan (§3.9.4)

export type SsMode = "none" | "estimate" | "receiving";

/** One person's benefit as the engine reads it: dollars a month, months as plan-clock numbers (clock.ts). */
export interface SsPersonInput {
  mode: SsMode;
  birthYear: number;
  /** 1 to 12. */
  birthMonth: number;
  /** `estimate`: the benefit at full retirement age; `receiving`: optional, used unchanged when given. */
  monthlyAtFra?: number;
  /** `receiving`: the current benefit. */
  monthly?: number;
  /** The year of the statement the amounts are quoted in (`estimate` and `receiving`). */
  asOfYear?: number;
  /** `estimate`: 744 to 840. */
  claimAgeMonths?: number;
  /** `receiving`: the month number of `startedMonth`. */
  startedIndex?: number;
}

export interface SsPerson {
  readonly mode: SsMode;
  /** Month number of the birth month: an age of `a` months is reached at `birthIndex + a`. */
  readonly birthIndex: number;
  readonly fra: number;
  readonly survivorFra: number;
  readonly fraIndex: number;
  /** The claim age in months (744 to 840); `fra` for mode `none`. */
  readonly claimAge: number;
  /** The first month in pay; `+Infinity` for mode `none`. */
  readonly claimIndex: number;
  readonly claimYear: number;
  /** Delayed credits earned by the claim: `max(0, claimAge − fra)`. */
  readonly totalCreditMonths: number;
  /** The PIA in dollars a month in the plan's first year (the statement's amount carried by the COLAs to `startYear`). */
  readonly piaAtStart: number;
}

export interface SsCompileWarning {
  readonly code: "ss_statement_old";
  readonly message: string;
}

export interface SsPlan {
  readonly people: readonly SsPerson[];
  readonly spousal: boolean;
  readonly survivor: boolean;
  readonly startYear: number;
  readonly rules: SsRules;
  readonly warnings: readonly SsCompileWarning[];
  /** What the hot path reads: the rules record (RU), the plan's switches (PL) and two person records (SP). */
  readonly table: Float64Array;
}

/** The plan's switches in `SsPlan.table`, after the rules record. */
const PL = { SPOUSAL: RU_REC, SURVIVOR: RU_REC + 1, START_YEAR: RU_REC + 2, PERSON_REC: RU_REC + 3 } as const;
/** Person i's record in `SsPlan.table` starts at `PERSON0 + i × table[PL.PERSON_REC]`. */
const PERSON0 = RU_REC + 4;
/** Slots of a person record; `PRESENT` is 0 for the missing second person of a one-person household. */
const SP = {
  PRESENT: 0,
  /** 0 none, 1 estimate, 2 receiving. */
  MODE: 1,
  BIRTH: 2,
  FRA: 3,
  SURVIVOR_FRA: 4,
  FRA_INDEX: 5,
  CLAIM_AGE: 6,
  CLAIM_INDEX: 7,
  CLAIM_YEAR: 8,
  CREDITS: 9,
  PIA_AT_START: 10,
  /**
   * `retirementFactor(c, fra)` for every claim month `c` from the earliest (744) to the latest (840),
   * at `FACTOR0 + c − 744`: the own factor in pay is always one of them (an early claim credited
   * back is a later claim; a delayed claim with k credits is a claim at `fra + k`), so the hot path
   * reads it instead of computing it.
   */
  FACTOR0: 11,
} as const;

function planTable(rules: SsRules, people: readonly SsPerson[], spousal: boolean, survivor: boolean, startYear: number): Float64Array {
  const t = new Float64Array(planRec(rules));
  t.set(rules.table, 0);
  t[PL.SPOUSAL] = spousal ? 1 : 0;
  t[PL.SURVIVOR] = survivor ? 1 : 0;
  t[PL.START_YEAR] = startYear;
  const rec = personRec(rules);
  t[PL.PERSON_REC] = rec;
  people.forEach((p, i) => {
    const o = PERSON0 + i * rec;
    t[o + SP.PRESENT] = 1;
    t[o + SP.MODE] = p.mode === "none" ? 0 : p.mode === "estimate" ? 1 : 2;
    t[o + SP.BIRTH] = p.birthIndex;
    t[o + SP.FRA] = p.fra;
    t[o + SP.SURVIVOR_FRA] = p.survivorFra;
    t[o + SP.FRA_INDEX] = p.fraIndex;
    t[o + SP.CLAIM_AGE] = p.claimAge;
    t[o + SP.CLAIM_INDEX] = p.claimIndex;
    t[o + SP.CLAIM_YEAR] = p.claimYear;
    t[o + SP.CREDITS] = p.totalCreditMonths;
    t[o + SP.PIA_AT_START] = p.piaAtStart;
    for (let c = rules.earliestRetirementMonths; c <= rules.latestCreditMonths; c++) {
      t[o + SP.FACTOR0 + c - rules.earliestRetirementMonths] = retirementFactorAt(rules.table, c, p.fra);
    }
  });
  return t;
}

/** Slots of one person record: the fixed slots and one factor per claim month. */
function personRec(rules: SsRules): number {
  return SP.FACTOR0 + rules.latestCreditMonths - rules.earliestRetirementMonths + 1;
}

function planRec(rules: SsRules): number {
  return PERSON0 + 2 * personRec(rules);
}

/** The COLA first paid in January of each year: the history, the year files, then the stale-data rule through `toYear`. */
function colaByYear(data: TaxData, toYear: number): { firstYear: number; cola: Map<number, number> } {
  const cola = new Map<number, number>();
  for (const [y, v] of Object.entries(data.ss.colaHistory)) cola.set(Number(y), v);
  for (const [y, rec] of data.years) cola.set(y, rec.socialSecurity.cola);
  // After the last published year: the stale-data inflation, rounded as fillPathTables does.
  let P = 1;
  let H = 1;
  for (let y = data.lastPublishedYear + 1; y <= toYear; y++) {
    P = P * (1 + data.rules.staleInflation);
    const c = roundCola(P / H - 1, data.ss.colaStep);
    if (c > 0) H = P;
    cola.set(y, c);
  }
  const history = Object.keys(data.ss.colaHistory).map(Number);
  const firstYear = history.length > 0 ? Math.min(...history) : data.firstTaxYear;
  return { firstYear, cola };
}

function nonNegative(x: number | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/**
 * Compiles a household's benefits once per run (inside `prepare`, seams C12): per person the full
 * retirement ages, the claim month and age, the delayed credits and the PIA carried from the
 * statement year to `startYear`. `estimate`: the claim at `claimAgeMonths`, the PIA the amount
 * entered. `receiving`: the claim at `startedIndex` (its age clamped to [744, 840]), the PIA
 * `monthlyAtFra` when given, else `monthly ÷ retirementFactor(claimAge, fra)`. The carry applies
 * `PIA ← floorDime(PIA × (1 + COLA_y))` for each year after the statement year through
 * `startYear`; a statement older than the COLA history (before 2016) is treated as the history's
 * first year minus one, with the warning `ss_statement_old`, and one after `startYear` as
 * `startYear`. A malformed person throws `RangeError` (`ssPersonInputs` checks a `SimInput` first).
 */
export function compileSsPlan(
  people: readonly SsPersonInput[],
  o: { spousal: boolean; survivor: boolean; startYear: number },
  data: TaxData = loadTaxData(),
): SsPlan {
  if (people.length < 1 || people.length > 2) throw new RangeError(`compileSsPlan: one or two people, got ${people.length}`);
  if (!Number.isInteger(o.startYear)) throw new RangeError(`compileSsPlan: startYear must be an integer, got ${o.startYear}`);
  const rules = data === loadTaxData() ? defaultSsRules() : compileSsRules(data);
  const { firstYear, cola } = colaByYear(data, o.startYear);
  const minAsOf = firstYear - 1;
  const warnings: SsCompileWarning[] = [];
  const compiled = people.map((p, i): SsPerson => {
    if (!Number.isInteger(p.birthYear) || !Number.isInteger(p.birthMonth) || p.birthMonth < 1 || p.birthMonth > 12) {
      throw new RangeError(`compileSsPlan: person ${i + 1} needs a whole birth year and a birth month 1 to 12`);
    }
    const birthIndex = birthMonthIndex(p.birthYear, p.birthMonth);
    const fra = birthYearRow(rules.fraRows, p.birthYear);
    const survivorFra = birthYearRow(rules.fraRows, p.birthYear - rules.survivorShift);
    const fraIndex = birthIndex + fra;
    if (p.mode === "none") {
      return Object.freeze({ mode: p.mode, birthIndex, fra, survivorFra, fraIndex, claimAge: fra, claimIndex: Infinity, claimYear: Infinity, totalCreditMonths: 0, piaAtStart: 0 });
    }
    if (!Number.isInteger(p.asOfYear)) throw new RangeError(`compileSsPlan: person ${i + 1} needs the statement year asOfYear`);
    let claimAge: number;
    let claimIndex: number;
    let piaBase: number;
    if (p.mode === "estimate") {
      const c = p.claimAgeMonths;
      if (c === undefined || !Number.isInteger(c) || c < rules.earliestRetirementMonths || c > rules.latestCreditMonths) {
        throw new RangeError(`compileSsPlan: person ${i + 1} needs a claim age of ${rules.earliestRetirementMonths} to ${rules.latestCreditMonths} months`);
      }
      if (!nonNegative(p.monthlyAtFra)) throw new RangeError(`compileSsPlan: person ${i + 1} needs a non-negative monthlyAtFra`);
      claimAge = c;
      claimIndex = birthIndex + claimAge;
      piaBase = p.monthlyAtFra;
    } else {
      const started = p.startedIndex;
      if (started === undefined || !Number.isInteger(started)) throw new RangeError(`compileSsPlan: person ${i + 1} needs the month the benefit started`);
      claimIndex = started;
      claimAge = clamp(claimIndex - birthIndex, rules.earliestRetirementMonths, rules.latestCreditMonths);
      if (p.monthlyAtFra !== undefined) {
        if (!nonNegative(p.monthlyAtFra)) throw new RangeError(`compileSsPlan: person ${i + 1} has a negative monthlyAtFra`);
        piaBase = p.monthlyAtFra;
      } else {
        if (!nonNegative(p.monthly)) throw new RangeError(`compileSsPlan: person ${i + 1} needs a non-negative current benefit`);
        piaBase = divideByRetirementFactor(p.monthly, claimAge, fra, rules);
      }
    }
    let asOf = p.asOfYear as number;
    if (asOf < minAsOf) {
      warnings.push({
        code: "ss_statement_old",
        message: `Person ${i + 1}'s Social Security benefit is from a ${asOf} statement; the cost-of-living history in the data starts in ${firstYear}, so the amount is treated as ${minAsOf}'s and indexed from there.`,
      });
      asOf = minAsOf;
    }
    let pia = piaBase;
    for (let y = asOf + 1; y <= o.startYear; y++) pia = floorDime(pia * (1 + (cola.get(y) ?? 0)));
    return Object.freeze({
      mode: p.mode,
      birthIndex,
      fra,
      survivorFra,
      fraIndex,
      claimAge,
      claimIndex,
      claimYear: Math.floor(claimIndex / 12),
      totalCreditMonths: claimAge > fra ? claimAge - fra : 0,
      piaAtStart: pia,
    });
  });
  return Object.freeze({
    people: Object.freeze(compiled),
    spousal: o.spousal,
    survivor: o.survivor,
    startYear: o.startYear,
    rules,
    warnings: Object.freeze(warnings),
    table: planTable(rules, compiled, o.spousal, o.survivor, o.startYear),
  });
}

function ssInvalid(message: string): EngineInputError {
  return new EngineInputError("social_security_invalid", message);
}

/**
 * The household's benefits from the frozen input, in the order of `household.people` (person 0,
 * person 1), converted once from cents (units.ts). A person without an entry has mode `none`.
 * Errors: `person_missing` (an entry for someone not in the household) and
 * `social_security_invalid` (two entries for one person, a claim age outside 744 to 840, or a
 * `claimMonth` that is not the birth month plus `claimAgeMonths`).
 */
export function ssPersonInputs(input: SimInput): SsPersonInput[] {
  const people = input.household.people;
  const entries = new Map<string, SimInput["socialSecurity"]["people"][number]>();
  for (const e of input.socialSecurity.people) {
    if (!people.some((p) => p.id === e.personId)) throw new EngineInputError("person_missing", `socialSecurity names ${e.personId}, who is not in the household`);
    if (entries.has(e.personId)) throw ssInvalid(`socialSecurity has two entries for ${e.personId}`);
    entries.set(e.personId, e);
  }
  return people.map((p): SsPersonInput => {
    const e = entries.get(p.id);
    const base = { birthYear: p.birthYear, birthMonth: p.birthMonth };
    if (e === undefined || e.mode === "none") return { mode: "none", ...base };
    if (e.mode === "estimate") {
      if (e.claimAgeMonths < 744 || e.claimAgeMonths > 840) throw ssInvalid(`${p.id}: a claim age of ${e.claimAgeMonths} months is outside 62 to 70 years`);
      if (monthIndex(e.claimMonth) !== birthMonthIndex(p.birthYear, p.birthMonth) + e.claimAgeMonths) {
        throw ssInvalid(`${p.id}: the claim month ${e.claimMonth} is not the birth month plus ${e.claimAgeMonths} months`);
      }
      return { mode: "estimate", ...base, monthlyAtFra: centsToDollars(e.monthlyAtFraCents), asOfYear: e.asOfYear, claimAgeMonths: e.claimAgeMonths };
    }
    const out: SsPersonInput = { mode: "receiving", ...base, monthly: centsToDollars(e.monthlyCents), asOfYear: e.asOfYear, startedIndex: monthIndex(e.startedMonth) };
    if (e.monthlyAtFraCents !== undefined) out.monthlyAtFra = centsToDollars(e.monthlyAtFraCents);
    return out;
  });
}

// ---------------------------------------------------------------------------------------------
// State (§3.9.5) and the month's payment (§3.9.7). Everything below reads the plan through its
// table `tb` (rules at 0, switches at PL, person i at PERSON0 + i × PL.PERSON_REC).

/** The start of each path: `PIA_i = piaAtStart_i`, no months withheld, the three fixed factors −1. */
export function resetSsState(plan: SsPlan, st: Float64Array): void {
  const tb = plan.table;
  const rec = tb[PL.PERSON_REC]!;
  for (let i = 0; i < 2; i++) {
    st[SS.PIA + i] = tb[PERSON0 + i * rec + SP.PIA_AT_START]!;
    st[SS.ARF_MONTHS + i] = 0;
    st[SS.SPOUSAL_FACTOR + i] = -1;
    st[SS.SURVIVOR_FACTOR + i] = -1;
    st[SS.DECEASED_FACTOR + i] = -1;
  }
  for (let k = SS.RESERVED0; k < SS_REC; k++) st[k] = 0;
}

/** Scratch of one month's evaluation: own benefit, spousal part, widow(er)'s benefit (each in dimes). */
const PAY = new Float64Array(3);
/** Scratch of a run of months: payments, months with a payment, spousal parts, survivor parts (dollars). */
const ACC = new Float64Array(4);

/**
 * The deceased's own factor, fixed once after the death (§3.9.7): when they had claimed, the factor
 * in pay in the December of the death with every credit counted (and the earnings-test months
 * credited when past full retirement age); when not, 1 before full retirement age, else the
 * credits earned up to the January after the death (at most to 70).
 */
function deceasedFactor(tb: Float64Array, o: number, arfMonths: number, deathYear: number): number {
  const december = 12 * deathYear + 11;
  const claimAge = tb[o + SP.CLAIM_AGE]!;
  const fra = tb[o + SP.FRA]!;
  const fraIndex = tb[o + SP.FRA_INDEX]!;
  if (tb[o + SP.CLAIM_INDEX]! <= december) {
    if (claimAge < fra) {
      const credited = december >= fraIndex ? claimAge + arfMonths : claimAge;
      return retirementFactorAt(tb, credited < fra ? credited : fra, fra);
    }
    return creditFactorAt(tb, tb[o + SP.CREDITS]!);
  }
  const january = 12 * (deathYear + 1);
  if (january <= fraIndex) return 1;
  const months = january - fraIndex;
  const cap = tb[RU.LATEST]! - fra;
  return creditFactorAt(tb, months < cap ? months : cap);
}

/*
 * The per-month functions below call nothing but Math and the store* helpers, which compute and
 * store the factors fixed once per path: the own factor is read from the person's factor table,
 * and SSA's truncations are written out (`Math.floor(z × 10 + 1e−9) / 10` is floorDime,
 * `Math.floor(z + 1e−9)` floorDollar). A double that crosses a call V8 does not inline is boxed,
 * and whether V8 inlines a helper depends on what else the thread has run (measured: after plans
 * of other shapes, about 70 bytes a year were allocated through floorDime and the credit factor).
 */
function storeSpousalFactor(st: Float64Array, slot: number, tb: Float64Array, ageMonths: number, fra: number): void {
  st[slot] = spousalFactorAt(tb, ageMonths, fra);
}
function storeSurvivorFactor(st: Float64Array, slot: number, tb: Float64Array, ageMonths: number, survivorFra: number): void {
  st[slot] = survivorFactorAt(tb, ageMonths, survivorFra);
}
function storeDeceasedFactor(st: Float64Array, slot: number, tb: Float64Array, o: number, arfMonths: number, deathYear: number): void {
  st[slot] = deceasedFactor(tb, o, arfMonths, deathYear);
}

/** Writes PAY for person i in month m: own benefit, spousal part, widow(er)'s benefit (each truncated to the dime). */
function evaluate(tb: Float64Array, st: Float64Array, i: number, m: number, deathYear0: number, deathYear1: number): void {
  const rec = tb[PL.PERSON_REC]!;
  const o = PERSON0 + i * rec;
  const year = Math.floor(m / 12);
  const claimIndex = tb[o + SP.CLAIM_INDEX]!;
  let own = 0;
  let factor = 0;
  if (m >= claimIndex) {
    // The own factor in pay (step 1 of §3.9.7) as the claim month it equals.
    const claimAge = tb[o + SP.CLAIM_AGE]!;
    const fra = tb[o + SP.FRA]!;
    let c: number;
    if (claimAge < fra) {
      // An early claim; from full retirement age the months withheld by the earnings test are credited back.
      const credited = m >= tb[o + SP.FRA_INDEX]! ? claimAge + st[SS.ARF_MONTHS + i]! : claimAge;
      c = credited < fra ? credited : fra;
    } else {
      // Credits earned in the claim year are added the following January, unless the claim is at 70.
      const total = tb[o + SP.CREDITS]!;
      const claimYear = tb[o + SP.CLAIM_YEAR]!;
      let credits = total;
      if (claimAge < tb[RU.LATEST]! && year <= claimYear) {
        credits = 12 * claimYear - tb[o + SP.FRA_INDEX]!;
        if (credits < 0) credits = 0;
        if (credits > total) credits = total;
      }
      c = fra + credits;
    }
    factor = tb[o + SP.FACTOR0 + c - tb[RU.EARLIEST]!]!;
    own = Math.floor(st[SS.PIA + i]! * factor * 10 + 1e-9) / 10;
  }
  let sp = 0;
  let wib = 0;
  const j = 1 - i;
  const oj = PERSON0 + j * rec;
  if (tb[oj + SP.PRESENT]! > 0 && tb[o + SP.MODE]! > 0 && tb[oj + SP.MODE]! > 0) {
    const deathJ = j === 0 ? deathYear0 : deathYear1;
    const birth = tb[o + SP.BIRTH]!;
    if (year <= deathJ) {
      // The spousal excess; deemed filing: from the later of the two claims.
      if (tb[PL.SPOUSAL]! > 0) {
        const claimJ = tb[oj + SP.CLAIM_INDEX]!;
        const start = claimIndex > claimJ ? claimIndex : claimJ;
        if (m >= start) {
          // Each factor is stored before it is read: a variable joining a call's result and a typed-array
          // load would be kept boxed, which allocates on every call (see the store* helpers).
          if (st[SS.SPOUSAL_FACTOR + i]! < 0) storeSpousalFactor(st, SS.SPOUSAL_FACTOR + i, tb, start - birth, tb[o + SP.FRA]!);
          const sf = st[SS.SPOUSAL_FACTOR + i]!;
          const excess = (st[SS.PIA + j]! * tb[RU.SHARE_NUM]!) / tb[RU.SHARE_DEN]! - st[SS.PIA + i]! * (factor > 1 ? factor : 1);
          if (excess > 0) sp = Math.floor(excess * sf * 10 + 1e-9) / 10;
        }
      }
    } else if (tb[PL.SURVIVOR]! > 0) {
      // The widow(er)'s benefit from the January after the death and from 60: reduced for age, then capped.
      const january = 12 * (deathJ + 1);
      const sixty = birth + tb[RU.SURVIVOR_EARLIEST]!;
      const start = january > sixty ? january : sixty;
      if (m >= start) {
        if (st[SS.SURVIVOR_FACTOR + i]! < 0) storeSurvivorFactor(st, SS.SURVIVOR_FACTOR + i, tb, start - birth, tb[o + SP.SURVIVOR_FRA]!);
        if (st[SS.DECEASED_FACTOR + j]! < 0) storeDeceasedFactor(st, SS.DECEASED_FACTOR + j, tb, oj, st[SS.ARF_MONTHS + j]!, deathJ);
        const sv = st[SS.SURVIVOR_FACTOR + i]!;
        const d = st[SS.DECEASED_FACTOR + j]!;
        const piaJ = st[SS.PIA + j]!;
        let w = piaJ * (d > 1 ? d : 1) * sv;
        if (d < 1) {
          const theirs = piaJ * d;
          const limit = (piaJ * tb[RU.WIDOW_LIMIT_NUM]!) / tb[RU.WIDOW_LIMIT_DEN]!;
          const cap = theirs > limit ? theirs : limit;
          if (w > cap) w = cap;
        }
        wib = Math.floor(w * 10 + 1e-9) / 10;
      }
    }
  }
  PAY[0] = own;
  PAY[1] = sp;
  PAY[2] = wib;
}

/**
 * The payment in dollars of `person` for month number `month`: `floorDollar(max(own + spousal,
 * widow(er)'s))` (§3.9.7). Fixes the spousal, survivor and deceased factors in the state the first
 * time they apply. The caller checks that the person is alive in the month's year; a person who
 * does not die in the plan has death year `+Infinity`. For previews and tests: the year function
 * does not call it.
 */
export function monthlyPayment(plan: SsPlan, st: Float64Array, person: 0 | 1, month: number, deathYear0: number, deathYear1: number): number {
  if (plan.people[person] === undefined) return 0;
  evaluate(plan.table, st, person, month, deathYear0, deathYear1);
  const base = PAY[0]! + PAY[1]!;
  return floorDollar(base > PAY[2]! ? base : PAY[2]!);
}

/**
 * Sums the months `[from, to)` of person i into ACC. With `shortcut`, a run in which no claim
 * (the person's or the partner's), full retirement age or 60th birthday month lies strictly inside
 * pays the same every month, so one evaluation times the month count equals the loop (§3.9.8;
 * H16). The partner's death starts a widow(er)'s benefit in a January, which is never strictly
 * inside a period: a period lies within one calendar year (the plan clock).
 */
function accumulate(tb: Float64Array, st: Float64Array, i: number, from: number, to: number, deathYear0: number, deathYear1: number, shortcut: boolean): void {
  ACC[0] = 0;
  ACC[1] = 0;
  ACC[2] = 0;
  ACC[3] = 0;
  if (!(to > from)) return;
  let uniform = shortcut;
  if (uniform) {
    const rec = tb[PL.PERSON_REC]!;
    const o = PERSON0 + i * rec;
    const claim = tb[o + SP.CLAIM_INDEX]!;
    const fraIndex = tb[o + SP.FRA_INDEX]!;
    const sixty = tb[o + SP.BIRTH]! + tb[RU.SURVIVOR_EARLIEST]!;
    const claimJ = tb[PERSON0 + (1 - i) * rec + SP.CLAIM_INDEX]!;
    uniform = !(claim > from && claim < to) && !(fraIndex > from && fraIndex < to) && !(sixty > from && sixty < to) && !(claimJ > from && claimJ < to);
  }
  const evaluations = uniform ? 1 : to - from;
  const times = uniform ? to - from : 1;
  for (let k = 0; k < evaluations; k++) {
    evaluate(tb, st, i, from + k, deathYear0, deathYear1);
    const own = PAY[0]!;
    const base = own + PAY[1]!;
    const wib = PAY[2]!;
    const pay = Math.floor((base > wib ? base : wib) + 1e-9);
    const baseDollars = Math.floor(base + 1e-9);
    ACC[0] = ACC[0]! + pay * times;
    if (pay > 0) ACC[1] = ACC[1]! + times;
    ACC[2] = ACC[2]! + (baseDollars - Math.floor(own + 1e-9)) * times;
    ACC[3] = ACC[3]! + (pay - baseDollars) * times;
  }
}

function ssYear(
  tb: Float64Array,
  st: Float64Array,
  year: number,
  periodStart: number,
  periodMonths: number,
  prog: Float64Array,
  progOff: number,
  deathYear0: number,
  deathYear1: number,
  wages0: number,
  wages1: number,
  out: Float64Array,
  shortcut: boolean,
): void {
  // 1. Each January after the plan's first year every PIA, the dead's included, takes the COLA.
  if (year > tb[PL.START_YEAR]! && periodStart % 12 === 0) {
    const cola = prog[progOff + PR.COLA]!;
    st[SS.PIA] = Math.floor(st[SS.PIA]! * (1 + cola) * 10 + 1e-9) / 10;
    st[SS.PIA + 1] = Math.floor(st[SS.PIA + 1]! * (1 + cola) * 10 + 1e-9) / 10;
  }
  const scale = prog[progOff + PR.SS_SCALE]!;
  const periodEnd = periodStart + periodMonths;
  const rec = tb[PL.PERSON_REC]!;
  for (let i = 0; i < 2; i++) {
    out[SO.BENEFIT + i] = 0;
    out[SO.SPOUSAL + i] = 0;
    out[SO.SURVIVOR + i] = 0;
    out[SO.WITHHELD + i] = 0;
    out[SO.MONTHS_PAID + i] = 0;
    const o = PERSON0 + i * rec;
    if (!(tb[o + SP.MODE]! > 0) || year > (i === 0 ? deathYear0 : deathYear1)) continue;
    // 2a. The months of the period before full retirement age.
    const fraIndex = tb[o + SP.FRA_INDEX]!;
    const split = fraIndex < periodStart ? periodStart : fraIndex > periodEnd ? periodEnd : fraIndex;
    accumulate(tb, st, i, periodStart, split, deathYear0, deathYear1, shortcut);
    const sPre = ACC[0]!;
    const nPre = ACC[1]!;
    const spousal = ACC[2]!;
    const survivor = ACC[3]!;
    // 2b. The earnings test on the person's wages of the period.
    let withheld = 0;
    let monthsWithheld = 0;
    const wages = i === 0 ? wages0 : wages1;
    if (sPre > 0 && wages > 0) {
      const f = periodMonths / 12;
      let over: number;
      let num: number;
      let den: number;
      if (year < Math.floor(fraIndex / 12)) {
        over = wages - prog[progOff + PR.ET_UNDER]! * f;
        num = tb[RU.WITHHOLD_UNDER_NUM]!;
        den = tb[RU.WITHHOLD_UNDER_DEN]!;
      } else {
        over = (wages * (split - periodStart)) / periodMonths - prog[progOff + PR.ET_FRA]! * f;
        num = tb[RU.WITHHOLD_FRA_NUM]!;
        den = tb[RU.WITHHOLD_FRA_DEN]!;
      }
      if (over > 0) {
        const w = (over * num) / den;
        withheld = w < sPre ? w : sPre;
        const months = Math.ceil(withheld / (sPre / nPre) - 1e-9);
        monthsWithheld = months < nPre ? months : nPre;
        st[SS.ARF_MONTHS + i] = st[SS.ARF_MONTHS + i]! + monthsWithheld;
      }
    }
    // 2c. The months from full retirement age on, with the withheld months already credited back.
    accumulate(tb, st, i, split, periodEnd, deathYear0, deathYear1, shortcut);
    // 2d and 3.
    out[SO.BENEFIT + i] = (sPre - withheld + ACC[0]!) * scale;
    out[SO.SPOUSAL + i] = (spousal + ACC[2]!) * scale;
    out[SO.SURVIVOR + i] = (survivor + ACC[3]!) * scale;
    out[SO.WITHHELD + i] = withheld * scale;
    out[SO.MONTHS_PAID + i] = nPre + ACC[1]! - monthsWithheld;
  }
}

/**
 * The benefits of plan year `year`'s period `[periodStart, periodStart + periodMonths)` (§3.9.8):
 * per person the sum of the months' payments, less the earnings test's withholding, times
 * `PR.SS_SCALE` (law changes and the plan's adjustment). The loop puts `out[SO.BENEFIT] +
 * out[SO.BENEFIT + 1]` into `TI.SS_GROSS` and does not scale it again (seams C21).
 *
 * - Each January after the plan's first year every PIA, the dead's included, becomes
 *   `floorDime(PIA × (1 + PR.COLA))`, once per calendar year whatever the step length.
 * - A person is paid while alive (`year ≤ deathYear`; `+Infinity` when they do not die). `wages0`
 *   and `wages1` are each person's gross wages of the period. Before the year of full retirement
 *   age the earnings test withholds `(wages − PR.ET_UNDER × f) × 1/2`, in that year
 *   `(wages × months before it / periodMonths − PR.ET_FRA × f) × 1/3`, at most the payments due
 *   before full retirement age; the months withheld are credited back from full retirement age.
 * - `out` (SO): the benefit; the spousal and survivor parts (before the earnings test); the amount
 *   withheld, each × `SS_SCALE`; and the months paid, net of the months withheld.
 *
 * Allocates nothing; writes only `st` and `out`.
 */
export function socialSecurityYear(
  plan: SsPlan,
  st: Float64Array,
  year: number,
  periodStart: number,
  periodMonths: number,
  prog: Float64Array,
  progOff: number,
  deathYear0: number,
  deathYear1: number,
  wages0: number,
  wages1: number,
  out: Float64Array,
): void {
  ssYear(plan.table, st, year, periodStart, periodMonths, prog, progOff, deathYear0, deathYear1, wages0, wages1, out, true);
}

/** `socialSecurityYear` without the shortcut: every month evaluated (the reference of H16). */
export function socialSecurityYearMonthLoop(
  plan: SsPlan,
  st: Float64Array,
  year: number,
  periodStart: number,
  periodMonths: number,
  prog: Float64Array,
  progOff: number,
  deathYear0: number,
  deathYear1: number,
  wages0: number,
  wages1: number,
  out: Float64Array,
): void {
  ssYear(plan.table, st, year, periodStart, periodMonths, prog, progOff, deathYear0, deathYear1, wages0, wages1, out, false);
}

/** One person's parts of the year's benefit in cents for the year table (seams C37): spousal, survivor, withheld. */
export function socialSecurityParts(out: Float64Array, person: 0 | 1): SocialSecurityParts {
  if (out.length < SO_REC) throw new RangeError(`socialSecurityParts: an SO record of ${SO_REC} slots is needed`);
  return {
    spousal: dollarsToCents(out[SO.SPOUSAL + person]!),
    survivor: dollarsToCents(out[SO.SURVIVOR + person]!),
    withheld: dollarsToCents(out[SO.WITHHELD + person]!),
  };
}

// ---------------------------------------------------------------------------------------------
// Preview (§3.9.9)

export interface SsPreviewClaimAge {
  readonly claimAgeMonths: number;
  readonly factor: number;
  /** Dollars a month: `floorDime(PIA × factor)`. */
  readonly monthly: number;
  /** The spousal excess the partner's record adds, dollars a month. */
  readonly spousalMonthly: number;
}

export interface SsPreviewPerson {
  readonly fraMonths: number;
  readonly survivorFraMonths: number;
  /** Dollars a month. */
  readonly piaAtStart: number;
  /** Whole claim ages 62 to 70. */
  readonly byClaimAge: readonly SsPreviewClaimAge[];
  /** The widow(er)'s benefit at survivor full retirement age, the partner claiming at their entered age. */
  readonly survivorMonthlyAtFra: number;
}

export interface SsPreview {
  readonly people: readonly SsPreviewPerson[];
}

/**
 * The benefit by claiming age for the input form (allocating): per person the full retirement
 * ages, the PIA at the plan start, and for each whole claim age 62 to 70 the factor, the monthly
 * benefit `floorDime(PIA × factor)` and the spousal excess the partner's record adds (from the
 * later of the two claims, the partner at the entered claim age), plus the widow(er)'s benefit at
 * survivor full retirement age. Every person must be an `estimate`.
 */
export function socialSecurityPreview(people: readonly SsPersonInput[], startYear: number, data: TaxData = loadTaxData()): SsPreview {
  if (people.some((p) => p.mode !== "estimate")) throw new RangeError("socialSecurityPreview: every person must be an estimate");
  const plan = compileSsPlan(people, { spousal: true, survivor: true, startYear }, data);
  const r = plan.rules;
  const previews = plan.people.map((p, i): SsPreviewPerson => {
    const q = plan.people[1 - i];
    const byClaimAge: SsPreviewClaimAge[] = [];
    for (let c = r.earliestRetirementMonths; c <= r.latestCreditMonths; c += 12) {
      const factor = retirementFactor(c, p.fra, r);
      let spousalMonthly = 0;
      if (q !== undefined) {
        const claim = p.birthIndex + c;
        const start = claim > q.claimIndex ? claim : q.claimIndex;
        const excess = (q.piaAtStart * r.spousalShareNum) / r.spousalShareDen - p.piaAtStart * (factor > 1 ? factor : 1);
        if (excess > 0) spousalMonthly = floorDime(excess * spousalFactor(start - p.birthIndex, p.fra, r));
      }
      byClaimAge.push({ claimAgeMonths: c, factor, monthly: floorDime(p.piaAtStart * factor), spousalMonthly });
    }
    let survivorMonthlyAtFra = 0;
    if (q !== undefined) {
      const d = retirementFactor(q.claimAge, q.fra, r);
      let w = q.piaAtStart * (d > 1 ? d : 1);
      if (d < 1) {
        const theirs = q.piaAtStart * d;
        const limit = (q.piaAtStart * r.widowLimitNum) / r.widowLimitDen;
        const cap = theirs > limit ? theirs : limit;
        if (w > cap) w = cap;
      }
      survivorMonthlyAtFra = floorDime(w);
    }
    return { fraMonths: p.fra, survivorFraMonths: p.survivorFra, piaAtStart: p.piaAtStart, byClaimAge, survivorMonthlyAtFra };
  });
  return { people: previews };
}

/** A factor in basis points: the engine's one boundary rule for ratios (units.ts `ratioToBp`, seams C44). */
function factorBp(factor: number): number {
  return ratioToBp(factor);
}

/** Route 24 (`POST /social-security-preview`): the preview in cents and basis points. */
export function socialSecurityPreviewView(req: SocialSecurityPreviewRequest, data: TaxData = loadTaxData()): SocialSecurityPreviewResponse {
  const people = req.people.map(
    (p): SsPersonInput => ({
      mode: "estimate",
      birthYear: p.birthYear,
      birthMonth: p.birthMonth,
      monthlyAtFra: centsToDollars(p.monthlyAtFraCents),
      asOfYear: p.asOfYear,
      claimAgeMonths: p.claimAgeMonths,
    }),
  );
  const preview = socialSecurityPreview(people, req.startYear, data);
  return {
    people: preview.people.map((p) => ({
      fraMonths: p.fraMonths,
      survivorFraMonths: p.survivorFraMonths,
      piaAtStartCents: dollarsToCents(p.piaAtStart),
      byClaimAge: p.byClaimAge.map((a) => ({
        claimAgeMonths: a.claimAgeMonths,
        factorBp: factorBp(a.factor),
        monthlyCents: dollarsToCents(a.monthly),
        spousalMonthlyCents: dollarsToCents(a.spousalMonthly),
      })),
      survivorMonthlyAtFraCents: dollarsToCents(p.survivorMonthlyAtFra),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// What each rule rests on (plan decision 11; seams §9 item 1)

export interface SsRule {
  readonly id: string;
  readonly label: string;
  /** Keys of the `verification` record of `ss/rules.json`; a key ending in `.*` stands for every key with that prefix. */
  readonly figures: readonly string[];
  /** Figures of the year files (`tax/federal-YYYY.json`), whose SSA sources are secondary (see their source notes). */
  readonly yearFileFigures?: readonly string[];
  /** A convention coded here with no figure in a data file: unverified until checked against SSA. */
  readonly codedRule?: string;
}

/** Every rule this module applies, with the figures it reads. */
export const SS_RULES: readonly SsRule[] = [
  { id: "full_retirement_age", label: "Full retirement age by birth year", figures: ["retirementFraMonths.*"] },
  {
    id: "survivor_full_retirement_age",
    label: "Survivor full retirement age: the retirement table read two birth years earlier",
    figures: ["survivorFraBirthYearShift", "retirementFraMonths.*"],
  },
  { id: "claim_window", label: "Retirement benefits from 62; delayed credits stop at 70", figures: ["earliestRetirementMonths", "latestCreditMonths"] },
  { id: "early_reduction", label: "Early reduction: 5/9 of 1% a month for 36 months, then 5/12 of 1%", figures: ["earlyReduction"] },
  { id: "delayed_credits", label: "Delayed credits: 2/3 of 1% a month to 70", figures: ["delayedCreditPerMonth", "latestCreditMonths"] },
  {
    id: "delayed_credits_january",
    label: "Credits earned in the claim year are paid from the following January, unless the claim is at 70",
    figures: [],
    codedRule: "POMS RS 00615.690, as quoted by secondary sources",
  },
  { id: "spousal_share", label: "A spousal benefit of up to half the partner's PIA", figures: ["spousalShare"] },
  { id: "spousal_reduction", label: "Spousal reduction: 25/36 of 1% a month for 36 months, then 5/12 of 1%; no delayed credits", figures: ["spousalReduction"] },
  {
    id: "spousal_excess",
    label: "Deemed filing: the spousal excess starts at the later claim and is half the partner's PIA less the own PIA times the own delayed credits",
    figures: ["spousalShare"],
    codedRule: "the Bipartisan Budget Act of 2015 (deemed filing) and SSA's dual-entitlement rule",
  },
  {
    id: "survivor_reduction",
    label: "A widow(er)'s benefit from 60, reduced linearly to 71.5% of the PIA at 60",
    figures: ["survivor.earliestMonths", "survivor.maxReduction", "survivorFraBirthYearShift"],
  },
  {
    id: "widow_limit",
    label: "The widow(er)'s limit: after an early claim by the deceased, at most the larger of their benefit and 82.5% of their PIA (reduced for age first, then capped)",
    figures: ["survivor.widowLimitShare"],
    codedRule: "the order 'reduce for age, then cap'",
  },
  {
    id: "deceased_credits",
    label: "A deceased who had not claimed leaves the delayed credits earned to the January after the death",
    figures: ["delayedCreditPerMonth", "latestCreditMonths"],
    codedRule: "the deceased's factor fixed at the December of the death",
  },
  {
    id: "earnings_test",
    label: "Earnings test: $1 of every $2 above the lower exempt amount; $1 of every $3 above the higher one in the year of full retirement age",
    figures: ["earningsTest"],
    yearFileFigures: ["socialSecurity.earningsTestUnderFra", "socialSecurity.earningsTestFraYear"],
  },
  {
    id: "earnings_test_credit_back",
    label: "Months withheld by the earnings test are credited back at full retirement age, in whole months",
    figures: [],
    codedRule: "the credit-back in whole months by recomputing the reduction",
  },
  {
    id: "cola",
    label: "COLA: the previous year's inflation rounded to 0.1%, never negative, against the last level that produced one; the published 2026 and 2027 values",
    figures: ["colaStep", "colaHistory.*"],
    yearFileFigures: ["socialSecurity.cola"],
  },
  {
    id: "ssa_rounding",
    label: "The PIA truncated to the dime after each COLA, each benefit to the dime, the monthly payment to the dollar",
    figures: [],
    codedRule: "SSA's rounding (one POMS excerpt read 'next higher' for one step)",
  },
];

export interface SsRuleVerification {
  readonly id: string;
  readonly label: string;
  /** The weakest mark among the rule's figures; `unverified` for a rule coded without a data figure. */
  readonly status: VerificationStatus;
  readonly figures: ReadonlyArray<{ key: string; status: VerificationStatus }>;
  readonly yearFileFigures: readonly string[];
  readonly codedRule: string | null;
}

const STATUS_RANK: Record<VerificationStatus, number> = { primary: 0, secondary: 1, unverified: 2 };

/**
 * Each rule of `SS_RULES` with the verification marks of the figures it reads in `ss/rules.json`,
 * and its weakest status. A rule coded without a data figure is `unverified`; the year files'
 * Social Security figures count as `secondary` (their SSA sources were not fetched). Throws when a
 * rule names a figure the data file does not mark.
 */
export function ssRuleVerification(data: TaxData = loadTaxData()): SsRuleVerification[] {
  const marks = data.ss.verification;
  const keys = Object.keys(marks);
  return SS_RULES.map((rule) => {
    const figures: Array<{ key: string; status: VerificationStatus }> = [];
    for (const f of rule.figures) {
      const matched = f.endsWith(".*") ? keys.filter((k) => k.startsWith(f.slice(0, -1))) : keys.filter((k) => k === f);
      if (matched.length === 0) throw new RangeError(`ssRuleVerification: rule ${rule.id} names ${f}, which ss/rules.json does not mark`);
      for (const k of matched) figures.push({ key: k, status: (marks[k] as { status: VerificationStatus }).status });
    }
    let status: VerificationStatus = rule.codedRule !== undefined ? "unverified" : "primary";
    if (rule.yearFileFigures !== undefined && STATUS_RANK[status] < STATUS_RANK.secondary) status = "secondary";
    for (const f of figures) if (STATUS_RANK[f.status] > STATUS_RANK[status]) status = f.status;
    return { id: rule.id, label: rule.label, status, figures, yearFileFigures: rule.yearFileFigures ?? [], codedRule: rule.codedRule ?? null };
  });
}
