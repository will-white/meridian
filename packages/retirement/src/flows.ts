/**
 * The recurring flows of a frozen input as month-share tables (seams §2.2, C15, C16, C26, C39):
 * income streams, contributions and scheduled Roth conversions. `prepare()` compiles them once per
 * thread; the loop evaluates one plan year with `incomeYearInto`, `contributionsYearInto` and
 * `conversionsYearInto`, which allocate nothing.
 *
 * Money is float64 dollars of the period (plan year t's months, seams §2.2), nominal once the
 * price-level terms are applied. A flow with a month window `[from, to)` pays
 * `annual × index × (months of the window inside the period) / 12` (C15); a dated lump (a
 * conversion) is never scaled by the period. The tables hold everything that does not depend on
 * the path; the price level `cpi[t]` (the path's level at the start of plan year t, `cpi[0] = 1`)
 * is applied by the year functions.
 *
 * **Income streams (C16).** With `t0` the plan year of the stream's first month inside the plan:
 * `amount(t) = annual × months(t)/12 × D × growth(t)`, where `D = cpi[t0]` for a stream in today's
 * dollars and 1 for a nominal one (a nominal stream starts at its quoted amount in its first year),
 * and the growth since `t0` is `cpi[t]/cpi[t0] × (1 + realGrowthBp/10000)^(t − t0)` for salary,
 * part-time, rental and other income, and the stream's `cola` for a pension or annuity: `cpi[t] /
 * cpi[t0]` (`cpi`), 1 (`none`), `(1 + bp/10000)^(t − t0)` (`fixed`). The price-level part is always
 * `cpi[t]^a × cpi[t0]^b` with `a ∈ {0, 1}`, `b ∈ {−1, 0, 1}` (`cpiNow`, `cpiStart`); the rest is
 * the `period` table.
 *
 * **Contributions (C26).** The year-0 annual amount scales with the salary paid in the period to
 * `scaleWith` (one person or the household) divided by `salaryBasisCents`, so it follows raises
 * and stops with the salary; `scaleWith: "inflation"` pays `annual × cpi[t] × (months before
 * endMonth in the period) / 12`. Salary months at or after `endMonth` never count. The caps of the
 * tax area (3.10) depend on the path's indexed limits and are applied by the loop, by the owner
 * and the `LIMIT` group compiled here.
 *
 * **Conversions (C39).** Per person and plan year, the amount in today's dollars (× `cpi[t]`) or as
 * quoted; never scaled by the period. The loop takes it pro rata from the person's pre-tax accounts
 * after the RMDs and deposits it in the person's `target` Roth account; a person who has died
 * converts nothing (warning `conversion_after_death`).
 */

import type { AccountType, PersonId, PlanBucket, PlanIncomeKind, SimInput } from "@meridian/shared";
import { type PlanClock, monthIndex, monthsInPeriod, periodStart, yearOfMonth } from "./clock.js";
import { EngineInputError } from "./errors.js";
import { centsToDollars } from "./units.js";

const BP = 10000;
/** A stream's yearly real growth in basis points: the profile's widest range (shared `SimInputIncome`). */
const STREAM_GROWTH_BP = [-500, 1000] as const;
/** A pension's fixed COLA in basis points (shared `Cola`). */
const COLA_BP = [0, 1000] as const;

/**
 * The months of the first drawdown year before `spending.startMonth` (the Stage A review's
 * engine-01): plan year `t`, the month number `until` (startMonth) and the months `months` of the
 * period before it; `t = −1` when the drawdown starts with a period (startMonth at or before the
 * period's first month, or outside the plan). These are accumulation months: their flows pay
 * their own tax and living costs and stay out of the year's net (plan decision 7, seams C52).
 */
export interface PreStart {
  readonly t: number;
  readonly until: number;
  readonly months: number;
}

/** The pre-start months of a frozen input (`PreStart`). */
export function preStartOf(input: SimInput, clock: PlanClock): PreStart {
  const until = monthIndex(input.spending.startMonth);
  const t = yearOfMonth(until) - clock.startYear;
  const months = t >= 0 && t < clock.years ? until - periodStart(clock, t) : 0;
  return months > 0 ? { t, until, months } : { t: -1, until, months: 0 };
}

/** How an income stream counts: wages (earned), pensions and annuities, rental, other ordinary income. */
export const INCOME = { WAGES: 0, PENSION: 1, RENTAL: 2, OTHER: 3 } as const;
export type IncomeClass = (typeof INCOME)[keyof typeof INCOME];

const INCOME_CLASS: Record<PlanIncomeKind, IncomeClass> = {
  salary: INCOME.WAGES,
  part_time: INCOME.WAGES,
  pension: INCOME.PENSION,
  annuity: INCOME.PENSION,
  rental: INCOME.RENTAL,
  other: INCOME.OTHER,
};

/** The kinds whose income is earned (wages): their `earned` flag must be true, every other kind's false. */
const EARNED_KINDS: ReadonlySet<PlanIncomeKind> = new Set(["salary", "part_time"]);

/** The income streams of a run (`S` streams, `Y` plan years). Treat every array as read-only. */
export interface IncomeTables {
  readonly count: number;
  readonly years: number;
  readonly ids: readonly string[];
  /** `INCOME` class of each stream. */
  readonly kind: Uint8Array;
  /** The owner's person index; −1 for a household stream (paid while anyone is alive). */
  readonly person: Int8Array;
  /** `t0`: the plan year of the stream's first month inside the plan (`years` when it never pays). */
  readonly firstYear: Int16Array;
  /** 1: the amount is multiplied by `cpi[t]`. */
  readonly cpiNow: Uint8Array;
  /** 1: × `cpi[t0]`; −1: ÷ `cpi[t0]`; 0: neither. */
  readonly cpiStart: Int8Array;
  /** `survivorBp / 10000`: the share that continues to the surviving spouse after the owner's death. */
  readonly survivorShare: Float64Array;
  /** `taxableBp / 10000` (read for streams that are not wages). */
  readonly taxableShare: Float64Array;
  /** `count × years` at `s × years + t`: `annual × months / 12 × real growth`, dollars before the price-level terms. */
  readonly period: Float64Array;
  /** The first drawdown year's months before `spending.startMonth` (`preStartOf`). */
  readonly preStart: PreStart;
  /** `count`: the `period` value of plan year `preStart.t` for the months before `preStart.until` only (0 when there are none). */
  readonly prePeriod: Float64Array;
  /** Per person: the index of that person's `salary` stream, −1 when there is none. */
  readonly salaryOf: Int16Array;
}

/** The employee amount's tax kind, from the account's bucket (C26). */
export const CONTRIB = {
  /** Pre-tax and HSA accounts: reduces the owner's taxable wages. */
  PRE_TAX: 0,
  /** Roth accounts: adds to the owner's Roth contribution basis. */
  ROTH: 1,
  /** Taxable and cash accounts: after-tax money. */
  AFTER_TAX: 2,
} as const;
export type ContributionKind = (typeof CONTRIB)[keyof typeof CONTRIB];

/**
 * The limit group of a contribution (tax-rmd-ss §3.10): the deferral and annual-additions limits
 * of an employer plan (accounts of type `401k`, pre-tax or Roth), the IRA limit (accounts of type
 * `ira` and `roth`), the HSA limit (bucket `hsa`), or none (taxable and cash accounts, and an
 * account of any other type).
 */
export const LIMIT = { NONE: 0, EMPLOYER_PLAN: 1, IRA: 2, HSA: 3 } as const;
export type LimitGroup = (typeof LIMIT)[keyof typeof LIMIT];

const CONTRIB_KIND: Record<PlanBucket, ContributionKind> = {
  pre_tax: CONTRIB.PRE_TAX,
  hsa: CONTRIB.PRE_TAX,
  roth: CONTRIB.ROTH,
  taxable: CONTRIB.AFTER_TAX,
  cash: CONTRIB.AFTER_TAX,
};

/** The limit group of an account (see `LIMIT`). */
export function limitGroupOf(bucket: PlanBucket, type: AccountType | undefined): LimitGroup {
  if (bucket === "hsa") return LIMIT.HSA;
  if (bucket !== "pre_tax" && bucket !== "roth") return LIMIT.NONE;
  if (type === "401k") return LIMIT.EMPLOYER_PLAN;
  return type === "ira" || type === "roth" ? LIMIT.IRA : LIMIT.NONE;
}

/** The contributions of a run (`C` entries). Treat every array as read-only. */
export interface ContributionTables {
  readonly count: number;
  readonly years: number;
  readonly personCount: number;
  /** The account index each entry deposits into. */
  readonly account: Int16Array;
  /** The account's owner at the plan start (−1 joint). */
  readonly owner: Int8Array;
  /** `CONTRIB` kind of the employee amount. */
  readonly kind: Uint8Array;
  /** `LIMIT` group. */
  readonly limit: Uint8Array;
  /** The year-0 annual amounts, dollars. */
  readonly employee0: Float64Array;
  readonly employer0: Float64Array;
  /** 1: `scaleWith` is `inflation`. */
  readonly byInflation: Uint8Array;
  /**
   * Salary-scaled entries, `count × personCount × years` at `(c × P + p) × Y + t`: person p's salary
   * paid in the period before its price-level terms (months before `endMonth` only) ÷
   * `salaryBasis`; 0 for a person `scaleWith` does not name.
   */
  readonly salaryShare: Float64Array;
  /** Inflation-scaled entries, `count × years`: months of the period before `endMonth`, ÷ 12. */
  readonly inflationShare: Float64Array;
  /** `salaryShare` and `inflationShare` of plan year `preStart.t` for its months before `spending.startMonth` (`count × personCount` and `count`). */
  readonly preSalaryShare: Float64Array;
  readonly preInflationShare: Float64Array;
}

/** Scheduled Roth conversions by person and plan year (C39). */
export interface ConversionTables {
  readonly count: number;
  readonly years: number;
  readonly personCount: number;
  /** Per person: the Roth account index conversions go to (the largest starting balance, ties by id); −1 when the person converts nothing. */
  readonly target: Int16Array;
  /** `personCount × years` at `i × Y + t`: amounts in today's dollars (× `cpi[t]`) and as quoted. */
  readonly real: Float64Array;
  readonly nominal: Float64Array;
}

/** Slots of one year's income record (`incomeYearInto`), period dollars. */
export const IY = {
  /** Gross wages of person 0 and person 1 (before any deferral). */
  WAGES0: 0,
  WAGES1: 1,
  /** The taxable parts of pensions and annuities, of rental income and of other income. */
  PENSION: 2,
  RENTAL: 3,
  OTHER_ORD: 4,
  /** The parts of non-wage streams that are not taxable. */
  EXEMPT: 5,
  /** Every stream's whole amount: the year's cash income from streams. */
  CASH: 6,
  /** Pensions and annuities, whole (the view's guaranteed income before Social Security). */
  GUARANTEED: 7,
  /** Rental and other income, whole (the view's other income). */
  OTHER: 8,
  /** Rental income, whole (the year table's rental line; `OTHER − RENTAL_CASH` is its other line). */
  RENTAL_CASH: 9,
} as const;
export const IY_REC = 10;

function incomeInvalid(message: string): EngineInputError {
  return new EngineInputError("income_invalid", message);
}

function personIndexOf(input: SimInput, id: PersonId, where: string): number {
  const i = input.household.people.findIndex((p) => p.id === id);
  if (i < 0) throw new EngineInputError("person_missing", `${where} names ${id}, who is not in the household`);
  return i;
}

/** The window's months as month numbers: `[from, to)`, `to = Infinity` when open. */
function windowOf(startMonth: string, endMonth: string | undefined): { from: number; to: number } {
  return { from: monthIndex(startMonth), to: endMonth === undefined ? Infinity : monthIndex(endMonth) };
}

/** The plan year of month `from`, at least 0 (a window that starts before the plan starts with it). */
function firstPlanYear(clock: PlanClock, from: number): number {
  const t = yearOfMonth(from) - clock.startYear;
  return t < 0 ? 0 : t > clock.years ? clock.years : t;
}

/**
 * The income streams of a frozen input. Errors: `person_missing` (an owner the household does not
 * have), `income_invalid` (a window that does not end after it starts, an earned stream without an
 * owner or with a survivor share, an `earned` flag that does not match the kind, two salaries for
 * one person, a growth rate outside the profile's range), `month_invalid`.
 */
export function compileIncomes(input: SimInput, clock: PlanClock): IncomeTables {
  const Y = clock.years;
  const P = input.household.people.length;
  const streams = input.incomes;
  const S = streams.length;
  const kind = new Uint8Array(S);
  const person = new Int8Array(S);
  const firstYear = new Int16Array(S);
  const cpiNow = new Uint8Array(S);
  const cpiStart = new Int8Array(S);
  const survivorShare = new Float64Array(S);
  const taxableShare = new Float64Array(S);
  const period = new Float64Array(S * Y);
  const preStart = preStartOf(input, clock);
  const prePeriod = new Float64Array(S);
  const salaryOf = new Int16Array(P).fill(-1);
  const seen = new Set<string>();

  streams.forEach((s, k) => {
    if (seen.has(s.id)) throw incomeInvalid(`two income streams have the id ${s.id}`);
    seen.add(s.id);
    const cls = INCOME_CLASS[s.kind];
    if (s.earned !== EARNED_KINDS.has(s.kind)) throw incomeInvalid(`income ${s.id}: a ${s.kind} stream ${s.earned ? "is not" : "is"} earned income`);
    const owner = s.personId === undefined ? -1 : personIndexOf(input, s.personId, `income ${s.id}`);
    if (s.earned && owner < 0) throw incomeInvalid(`income ${s.id}: wages belong to a person`);
    if (s.earned && s.survivorBp !== 0) throw incomeInvalid(`income ${s.id}: wages stop at the earner's death; the survivor share must be 0`);
    if (s.kind === "salary") {
      if (salaryOf[owner]! >= 0) throw incomeInvalid(`income ${s.id}: ${s.personId} has a second salary`);
      salaryOf[owner] = k;
    }
    const { from, to } = windowOf(s.startMonth, s.endMonth);
    if (!(to > from)) throw incomeInvalid(`income ${s.id}: the window ends (${s.endMonth}) before it starts (${s.startMonth})`);
    const t0 = firstPlanYear(clock, from);
    const today = s.dollars === "today";

    let growthRate: number;
    let indexed: boolean;
    if (cls === INCOME.PENSION) {
      indexed = s.cola.mode === "cpi";
      growthRate = s.cola.mode === "fixed" ? s.cola.bp / BP : 0;
    } else {
      indexed = true;
      growthRate = s.realGrowthBp / BP;
    }
    // The profile's ranges (shared `SimInputIncome`, `Cola`), checked again for an input that did
    // not pass the schema (seams C13): a growth beyond them could carry an amount past what the
    // stored cents series hold.
    const growthBp = cls === INCOME.PENSION ? (s.cola.mode === "fixed" ? s.cola.bp : 0) : s.realGrowthBp;
    const [minBp, maxBp] = cls === INCOME.PENSION ? COLA_BP : STREAM_GROWTH_BP;
    if (!Number.isInteger(growthBp) || growthBp < minBp || growthBp > maxBp) {
      throw incomeInvalid(`income ${s.id}: a growth of ${growthBp} bp a year; it must be ${minBp} to ${maxBp} (the profile's range)`);
    }
    // cpi[t]^a × cpi[t0]^b: today and indexed → cpi[t]; today, not indexed → cpi[t0];
    // nominal and indexed → cpi[t] / cpi[t0]; nominal, not indexed → 1.
    cpiNow[k] = indexed ? 1 : 0;
    cpiStart[k] = today ? (indexed ? 0 : 1) : indexed ? -1 : 0;

    kind[k] = cls;
    person[k] = owner;
    firstYear[k] = t0;
    survivorShare[k] = s.survivorBp / BP;
    taxableShare[k] = s.taxableBp / BP;
    const annual = centsToDollars(s.annualCents);
    const growth = 1 + growthRate;
    let real = 1;
    for (let t = t0; t < Y; t++) {
      if (t > t0) real *= growth;
      const months = monthsInPeriod(clock, t, from, to);
      if (months > 0) period[k * Y + t] = (annual * months * real) / 12;
      if (t === preStart.t) {
        const before = monthsInPeriod(clock, t, from, to < preStart.until ? to : preStart.until);
        if (before > 0) prePeriod[k] = (annual * before * real) / 12;
      }
    }
  });

  return { count: S, years: Y, ids: streams.map((s) => s.id), kind, person, firstYear, cpiNow, cpiStart, survivorShare, taxableShare, period, preStart, prePeriod, salaryOf };
}

/**
 * The contributions of a frozen input, with account ids replaced by indices (`accountIndex`).
 * Errors: `unknown_account`, `person_missing`, `contribution_invalid` (a salary-scaled entry
 * without a positive `salaryBasisCents` or without a salary to scale with), `month_invalid`.
 */
export function compileContributions(
  input: SimInput,
  clock: PlanClock,
  incomes: IncomeTables,
  accountIndex: ReadonlyMap<string, number>,
  accountOwner: Int8Array,
): ContributionTables {
  const Y = clock.years;
  const P = input.household.people.length;
  const entries = input.contributions;
  const C = entries.length;
  const account = new Int16Array(C);
  const owner = new Int8Array(C);
  const kind = new Uint8Array(C);
  const limit = new Uint8Array(C);
  const employee0 = new Float64Array(C);
  const employer0 = new Float64Array(C);
  const byInflation = new Uint8Array(C);
  const salaryShare = new Float64Array(C * P * Y);
  const inflationShare = new Float64Array(C * Y);
  const pre = incomes.preStart;
  const preSalaryShare = new Float64Array(C * P);
  const preInflationShare = new Float64Array(C);

  entries.forEach((e, c) => {
    const a = accountIndex.get(e.accountId);
    if (a === undefined) throw new EngineInputError("unknown_account", `a contribution names the account ${e.accountId}, which is not in the plan`);
    const acct = input.accounts[a]!;
    account[c] = a;
    owner[c] = accountOwner[a]!;
    kind[c] = CONTRIB_KIND[acct.bucket];
    limit[c] = limitGroupOf(acct.bucket, acct.type);
    employee0[c] = centsToDollars(e.employeeAnnualCents);
    employer0[c] = centsToDollars(e.employerAnnualCents);
    const end = monthIndex(e.endMonth);

    if (e.scaleWith === "inflation") {
      byInflation[c] = 1;
      for (let t = 0; t < Y; t++) inflationShare[c * Y + t] = monthsInPeriod(clock, t, -Infinity, end) / 12;
      if (pre.t >= 0) preInflationShare[c] = monthsInPeriod(clock, pre.t, -Infinity, end < pre.until ? end : pre.until) / 12;
      return;
    }
    const scaled = e.scaleWith === "household" ? input.household.people.map((_, i) => i) : [personIndexOf(input, e.scaleWith, `the contribution to ${e.accountId}`)];
    if (e.salaryBasisCents === undefined || !(centsToDollars(e.salaryBasisCents) > 0)) {
      throw new EngineInputError("contribution_invalid", `the contribution to ${e.accountId} scales with ${e.scaleWith}'s salary but has no positive salaryBasisCents`);
    }
    const basis = centsToDollars(e.salaryBasisCents);
    let anySalary = false;
    for (const p of scaled) {
      const s = incomes.salaryOf[p]!;
      if (s < 0) continue;
      anySalary = true;
      const stream = input.incomes[s]!;
      const { from, to } = windowOf(stream.startMonth, stream.endMonth);
      const t0 = incomes.firstYear[s]!;
      const growth = 1 + stream.realGrowthBp / BP;
      const annual = centsToDollars(stream.annualCents);
      let real = 1;
      for (let t = t0; t < Y; t++) {
        if (t > t0) real *= growth;
        const stop = to < end ? to : end;
        const months = monthsInPeriod(clock, t, from, stop);
        if (months > 0) salaryShare[(c * P + p) * Y + t] = (annual * months * real) / 12 / basis;
        if (t === pre.t) {
          const before = monthsInPeriod(clock, t, from, stop < pre.until ? stop : pre.until);
          if (before > 0) preSalaryShare[c * P + p] = (annual * before * real) / 12 / basis;
        }
      }
    }
    if (!anySalary) throw new EngineInputError("contribution_invalid", `the contribution to ${e.accountId} scales with ${e.scaleWith}'s salary, and there is none`);
  });

  return { count: C, years: Y, personCount: P, account, owner, kind, limit, employee0, employer0, byInflation, salaryShare, inflationShare, preSalaryShare, preInflationShare };
}

/**
 * The scheduled conversions of a frozen input. `rothTarget[i]` is person i's Roth account (or −1).
 * Errors: `person_missing`, `conversion_invalid` (a year outside the plan, two entries for one
 * person and year), `conversion_no_roth` (a person with a conversion and no Roth account).
 */
export function compileConversions(input: SimInput, clock: PlanClock, rothTarget: Int16Array): ConversionTables {
  const Y = clock.years;
  const P = input.household.people.length;
  const real = new Float64Array(P * Y);
  const nominal = new Float64Array(P * Y);
  const target = new Int16Array(P).fill(-1);
  const seen = new Set<string>();
  for (const v of input.rothConversions) {
    const i = personIndexOf(input, v.personId, `the conversion of ${v.year}`);
    const t = v.year - clock.startYear;
    if (t < 0 || t >= Y) throw new EngineInputError("conversion_invalid", `the conversion of ${v.year} for ${v.personId} is outside the plan's years ${clock.startYear} to ${clock.startYear + Y - 1}`);
    const key = `${i}:${t}`;
    if (seen.has(key)) throw new EngineInputError("conversion_invalid", `two conversions for ${v.personId} in ${v.year}`);
    seen.add(key);
    if (rothTarget[i]! < 0) throw new EngineInputError("conversion_no_roth", `${v.personId} has a conversion in ${v.year} and no Roth account to receive it`);
    target[i] = rothTarget[i]!;
    const amount = centsToDollars(v.amountCents);
    if (v.dollars === "today") real[i * Y + t] = amount;
    else nominal[i * Y + t] = amount;
  }
  return { count: input.rothConversions.length, years: Y, personCount: P, target, real, nominal };
}

/**
 * Plan year t's stream income: each stream's nominal amount for the period in `amounts[s]` and the
 * sums in `out` (`IY` slots). `cpi[0 … t]` is the path's price level; `alive[i]` is 1 while person i
 * is alive this year (deaths take effect at the year's end). A person's stream pays in full while
 * the person is alive and `survivorShare` of it while only the spouse is; a household stream pays
 * while anyone is alive. Wages are gross; the other kinds split into their taxable share and the
 * exempt rest. Allocates nothing.
 */
export function incomeYearInto(inc: IncomeTables, t: number, cpi: ArrayLike<number>, alive: ArrayLike<number>, amounts: Float64Array, out: Float64Array): void {
  streamsInto(inc, inc.period, inc.years, t, t, cpi, alive, amounts, out);
}

/**
 * The stream income of the first drawdown year's months before `spending.startMonth`
 * (`inc.preStart`), as `incomeYearInto` gives the whole period: the same people alive, price
 * level and survivor shares, over `inc.prePeriod`. Call it only when `inc.preStart.t ≥ 0`.
 * Allocates nothing.
 */
export function incomePreStartInto(inc: IncomeTables, cpi: ArrayLike<number>, alive: ArrayLike<number>, amounts: Float64Array, out: Float64Array): void {
  streamsInto(inc, inc.prePeriod, 1, 0, inc.preStart.t, cpi, alive, amounts, out);
}

/** The streams of plan year t from the table's entries `table[s × stride + column]`. */
function streamsInto(
  inc: IncomeTables,
  table: Float64Array,
  stride: number,
  column: number,
  t: number,
  cpi: ArrayLike<number>,
  alive: ArrayLike<number>,
  amounts: Float64Array,
  out: Float64Array,
): void {
  for (let k = 0; k < IY_REC; k++) out[k] = 0;
  const P = alive.length;
  let anyAlive = false;
  for (let i = 0; i < P; i++) if (alive[i] === 1) anyAlive = true;
  for (let s = 0; s < inc.count; s++) {
    let x = 0;
    const base = table[s * stride + column]!;
    if (base > 0) {
      const owner = inc.person[s]!;
      let share = 0;
      if (owner < 0) share = anyAlive ? 1 : 0;
      else if (alive[owner] === 1) share = 1;
      else if (P === 2 && alive[1 - owner] === 1) share = inc.survivorShare[s]!;
      if (share > 0) {
        // The price-level terms cpi[t]^cpiNow × cpi[t0]^cpiStart, written out: a double returned
        // from a call V8 does not inline is boxed, and this runs for every stream of every path-year.
        x = base * share;
        if (inc.cpiNow[s] === 1) x *= cpi[t]!;
        const b = inc.cpiStart[s]!;
        if (b !== 0) x = b > 0 ? x * cpi[inc.firstYear[s]!]! : x / cpi[inc.firstYear[s]!]!;
      }
    }
    amounts[s] = x;
    if (x === 0) continue;
    out[IY.CASH] = out[IY.CASH]! + x;
    const cls = inc.kind[s]!;
    if (cls === INCOME.WAGES) {
      const slot = inc.person[s] === 1 ? IY.WAGES1 : IY.WAGES0;
      out[slot] = out[slot]! + x;
      continue;
    }
    const taxable = x * inc.taxableShare[s]!;
    out[IY.EXEMPT] = out[IY.EXEMPT]! + (x - taxable);
    if (cls === INCOME.PENSION) {
      out[IY.PENSION] = out[IY.PENSION]! + taxable;
      out[IY.GUARANTEED] = out[IY.GUARANTEED]! + x;
    } else {
      const slot = cls === INCOME.RENTAL ? IY.RENTAL : IY.OTHER_ORD;
      out[slot] = out[slot]! + taxable;
      out[IY.OTHER] = out[IY.OTHER]! + x;
      if (cls === INCOME.RENTAL) out[IY.RENTAL_CASH] = out[IY.RENTAL_CASH]! + x;
    }
  }
}

/**
 * Plan year t's contributions before the caps, nominal dollars of the period, into
 * `employee[c]` and `employer[c]`. A salary-scaled entry follows the salary paid to the living
 * people it names (`inc` gives each salary's price-level terms); an inflation-scaled entry pays
 * while its account's owner is alive (a joint account: while anyone is). Allocates nothing.
 */
export function contributionsYearInto(
  ct: ContributionTables,
  inc: IncomeTables,
  t: number,
  cpi: ArrayLike<number>,
  alive: ArrayLike<number>,
  employee: Float64Array,
  employer: Float64Array,
): void {
  contributionsInto(ct, inc, ct.salaryShare, ct.inflationShare, ct.years, t, t, cpi, alive, employee, employer);
}

/**
 * The contributions of the first drawdown year's months before `spending.startMonth`
 * (`inc.preStart`), before the caps, as `contributionsYearInto` gives the whole period. Call it
 * only when `inc.preStart.t ≥ 0`. Allocates nothing.
 */
export function contributionsPreStartInto(
  ct: ContributionTables,
  inc: IncomeTables,
  cpi: ArrayLike<number>,
  alive: ArrayLike<number>,
  employee: Float64Array,
  employer: Float64Array,
): void {
  contributionsInto(ct, inc, ct.preSalaryShare, ct.preInflationShare, 1, 0, inc.preStart.t, cpi, alive, employee, employer);
}

/** The contributions of plan year t from the share tables' entries at `(c × P + p) × stride + column` and `c × stride + column`. */
function contributionsInto(
  ct: ContributionTables,
  inc: IncomeTables,
  salaryShare: Float64Array,
  inflationShare: Float64Array,
  stride: number,
  column: number,
  t: number,
  cpi: ArrayLike<number>,
  alive: ArrayLike<number>,
  employee: Float64Array,
  employer: Float64Array,
): void {
  const P = ct.personCount;
  for (let c = 0; c < ct.count; c++) {
    let scale = 0;
    if (ct.byInflation[c] === 1) {
      const o = ct.owner[c]!;
      let paying = o >= 0 ? alive[o] === 1 : false;
      if (o < 0) for (let i = 0; i < P; i++) if (alive[i] === 1) paying = true;
      if (paying) scale = cpi[t]! * inflationShare[c * stride + column]!;
    } else {
      for (let p = 0; p < P; p++) {
        let x = salaryShare[(c * P + p) * stride + column]!;
        if (!(x > 0) || alive[p] !== 1) continue;
        // The salary's price-level terms, as in incomeYearInto.
        const s = inc.salaryOf[p]!;
        if (inc.cpiNow[s] === 1) x *= cpi[t]!;
        const b = inc.cpiStart[s]!;
        if (b !== 0) x = b > 0 ? x * cpi[inc.firstYear[s]!]! : x / cpi[inc.firstYear[s]!]!;
        scale += x;
      }
    }
    employee[c] = ct.employee0[c]! * scale;
    employer[c] = ct.employer0[c]! * scale;
  }
}

/**
 * Plan year t's scheduled conversion of each person, nominal dollars (`out[i]`), whether or not the
 * person is alive: the loop skips a dead person's amount and counts `conversion_after_death`.
 * Allocates nothing.
 */
export function conversionsYearInto(cv: ConversionTables, t: number, cpi: ArrayLike<number>, out: Float64Array): void {
  const Y = cv.years;
  for (let i = 0; i < cv.personCount; i++) out[i] = cv.real[i * Y + t]! * cpi[t]! + cv.nominal[i * Y + t]!;
}
