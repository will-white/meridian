/**
 * Test doubles for the year loop (engine-and-returns §4.3 and §7; seams §2.5, C30): stub tax-area
 * functions written to the real slot layouts (layout.ts), so a loop test can replace any member of
 * the injectable `TaxFunctions` record, and the reference withdrawal solver of engine-and-returns
 * §3.9, which stands in for the strategies area's `planWithdrawals` until build step 19.
 *
 * None of these is law. "Stub tax" in the engine's cases is 20% of ordinary income plus 10% of
 * gains and qualified dividends (`flatTaxInto(0.2, 0.1)`); Social Security is not taxed by a stub;
 * the additional taxes on early distributions are 0 unless a stub is given rates.
 *
 * Every stub follows the real functions' period convention (seams §2.6, C23): amounts in and out
 * are the period's, and `TI.YEAR_FRACTION` (f, a full year outside (0, 1)) annualizes inside the
 * tax stub exactly as `federalTaxInto` does (`f × T(x / f)`), so the loop never scales a result.
 */

import { CASH_TOL } from "../constants.js";
import { type AssessFn, type Assessment, type EngineHooks, type TaxFunctions, type YearView, ASSESS_MAX_CALLS, TAX_FUNCTIONS, createAssessment } from "../hooks.js";
import { TREATMENT } from "../prepare.js";
import { decideSpending } from "../strategies/decide.js";
import type { SpendDecision } from "../strategies/types.js";
import { CL, PT, PT_REC, SO, SO_REC, TAX_OUT, TI, TO } from "../tax/layout.js";

type FederalTaxInto = TaxFunctions["federalTaxInto"];

function annualFraction(x: Float64Array): number {
  const f = x[TI.YEAR_FRACTION]!;
  return f > 0 && f < 1 ? f : 1;
}

/** Ordinary income as the stubs count it: every ordinary line less the adjustments (Social Security excluded). */
function ordinaryOf(x: Float64Array): number {
  return (
    x[TI.WAGES]! +
    x[TI.PENSION]! +
    x[TI.INTEREST]! +
    (x[TI.ORD_DIV]! - x[TI.QUAL_DIV]!) +
    x[TI.TRAD_DIST]! +
    x[TI.ROTH_CONV]! +
    x[TI.ROTH_TAXABLE]! +
    x[TI.HSA_TAXABLE]! +
    x[TI.RENTAL]! +
    x[TI.OTHER_ORD]! -
    x[TI.ADJUSTMENTS]!
  );
}

export interface StubTaxOptions {
  /** Rates on `PEN10_BASE` and `PEN20_BASE` (default 0: the stubs charge no additional tax). */
  readonly pen10Rate?: number;
  readonly pen20Rate?: number;
}

/**
 * A stub federal tax on the `TI` / `TO` layouts: `ordinaryTax(annual ordinary income)` plus
 * `gainRate` × (qualified dividends + net gains above the loss carried in), annualized with f.
 * A net loss is carried out whole (`LOSS_CARRY_OUT`; the stub does not deduct it from ordinary
 * income).
 */
function stubTax(ordinaryTax: (annualOrdinary: number) => number, marginal: (annualOrdinary: number) => number, gainRate: number, o: StubTaxOptions): FederalTaxInto {
  const pen10 = o.pen10Rate ?? 0;
  const pen20 = o.pen20Rate ?? 0;
  return (_t: Float64Array, _o: number, x: Float64Array, r: Float64Array): void => {
    const f = annualFraction(x);
    const ordinary = ordinaryOf(x);
    const net = x[TI.ST_GAIN]! + x[TI.LT_GAIN]! - x[TI.LOSS_CARRY_IN]!;
    const gains = net > 0 ? net : 0;
    const pref = x[TI.QUAL_DIV]! + gains;
    const ordTax = f * ordinaryTax((ordinary > 0 ? ordinary : 0) / f);
    const cgTax = gainRate * pref;
    const p10 = pen10 * x[TI.PEN10_BASE]!;
    const p20 = pen20 * x[TI.PEN20_BASE]!;
    for (let k = 0; k < TAX_OUT; k++) r[k] = 0;
    const agi = ordinary + pref + x[TI.SS_GROSS]!;
    r[TO.ORD_TAX] = ordTax;
    r[TO.CG_TAX] = cgTax;
    r[TO.INCOME_TAX] = ordTax + cgTax;
    r[TO.PEN10] = p10;
    r[TO.PEN20] = p20;
    r[TO.TOTAL] = ordTax + cgTax + p10 + p20;
    r[TO.AGI] = agi;
    r[TO.TAXABLE_INCOME] = (ordinary > 0 ? ordinary : 0) + pref;
    r[TO.ORD_TAXABLE] = ordinary > 0 ? ordinary : 0;
    r[TO.PREF_INCOME] = pref;
    r[TO.LOSS_CARRY_OUT] = net < 0 ? -net : 0;
    r[TO.LOSS_USED] = net < 0 ? x[TI.ST_GAIN]! + x[TI.LT_GAIN]! : x[TI.LOSS_CARRY_IN]!;
    r[TO.BRACKET_RATE] = marginal((ordinary > 0 ? ordinary : 0) / f);
    r[TO.ROOM_IN_BRACKET] = Number.POSITIVE_INFINITY;
    r[TO.MAGI_IRMAA] = agi + x[TI.TAX_EXEMPT_INTEREST]!;
    r[TO.MAGI_ACA] = agi + x[TI.TAX_EXEMPT_INTEREST]!;
  };
}

/** `ordinaryRate` of ordinary income plus `gainRate` of qualified dividends and gains ("stub tax" = `flatTaxInto(0.2, 0.1)`). */
export function flatTaxInto(ordinaryRate: number, gainRate: number, o: StubTaxOptions = {}): FederalTaxInto {
  return stubTax(
    (x) => ordinaryRate * x,
    () => ordinaryRate,
    gainRate,
    o,
  );
}

/** `lowRate` of annual ordinary income up to `threshold`, `highRate` above, plus `gainRate` of qualified dividends and gains; annualized with f. */
export function bracketTaxInto(threshold: number, lowRate: number, highRate: number, gainRate = 0, o: StubTaxOptions = {}): FederalTaxInto {
  return stubTax(
    (x) => (x <= threshold ? lowRate * x : lowRate * threshold + highRate * (x - threshold)),
    (x) => (x < threshold ? lowRate : highRate),
    gainRate,
    o,
  );
}

/** No tax at all. */
export const noTaxInto: FederalTaxInto = flatTaxInto(0, 0);

type Rmd = TaxFunctions["requiredMinimumDistribution"];

/**
 * RMD = balance ÷ `divisor` from age `fromAge` on (× f = the period's months ÷ 12 in a partial
 * year, at most the balance), as the real function's period rule, in the record form the loop
 * calls (`out[a]` from `balances[a]`).
 */
export function rmdByDivisor(divisor: number, fromAge: number): Rmd {
  return (balances, a, age, _startAge, _spouseAge, periodMonths, _tables, out): void => {
    const balance = balances[a]!;
    if (!(balance > 0) || age < fromAge) {
      out[a] = 0;
      return;
    }
    const f = periodMonths > 0 && periodMonths < 12 ? periodMonths / 12 : 1;
    const x = (balance / divisor) * f;
    out[a] = x < balance ? x : balance;
  };
}

/** No RMD. */
export const noRmd: Rmd = (_balances, a, _age, _startAge, _spouseAge, _periodMonths, _tables, out): void => {
  out[a] = 0;
};

type SocialSecurityYear = TaxFunctions["socialSecurityYear"];

/**
 * Social Security of `amounts[i]` nominal dollars a year per person, paid for the months of the
 * period while the person is alive (`year ≤ deathYear`), not indexed.
 */
export function fixedSocialSecurity(amounts: readonly number[]): SocialSecurityYear {
  const a0 = amounts[0] ?? 0;
  const a1 = amounts[1] ?? 0;
  return (_plan, _st, year, _periodStart, periodMonths, _prog, _progOff, deathYears, _wages, _wagesOff, out): void => {
    for (let k = 0; k < SO_REC; k++) out[k] = 0;
    const m = periodMonths / 12;
    if (year <= deathYears[0]! && a0 > 0) {
      out[SO.BENEFIT] = a0 * m;
      out[SO.MONTHS_PAID] = periodMonths;
    }
    if (year <= deathYears[1]! && a1 > 0) {
      out[SO.BENEFIT + 1] = a1 * m;
      out[SO.MONTHS_PAID + 1] = periodMonths;
    }
  };
}

/** No Social Security. */
export const noSocialSecurity: SocialSecurityYear = fixedSocialSecurity([]);

type PayrollInto = TaxFunctions["employeePayrollTaxInto"];

/** `rate` of each person's gross wages (no wage base, no threshold): `PT.TOTAL` and `PT.MEDICARE`. */
export function flatPayrollTaxInto(rate: number): PayrollInto {
  return (_p, _o, wages, wagesOff, _status, _periodMonths, out): void => {
    const wages0 = wages[wagesOff]!;
    const wages1 = wages[wagesOff + 1]!;
    for (let k = 0; k < PT_REC; k++) out[k] = 0;
    const x = rate * ((wages0 > 0 ? wages0 : 0) + (wages1 > 0 ? wages1 : 0));
    out[PT.MEDICARE] = x;
    out[PT.TOTAL] = x;
  };
}

/** No payroll tax. */
export const noPayrollTaxInto: PayrollInto = flatPayrollTaxInto(0);

type LimitsInto = TaxFunctions["contributionLimitsInto"];

/** No contribution limit (`+Infinity` in every `CL` slot). */
export const unlimitedContributionsInto: LimitsInto = (_p, _o, _age, _periodMonths, _family, _months, out): void => {
  out[CL.EMPLOYEE_DEFERRAL] = Number.POSITIVE_INFINITY;
  out[CL.ANNUAL_ADDITIONS] = Number.POSITIVE_INFINITY;
  out[CL.IRA] = Number.POSITIVE_INFINITY;
  out[CL.HSA] = Number.POSITIVE_INFINITY;
};

/**
 * Fixed annual limits: the deferral (plus `catchUp` from 50), the annual additions and the IRA
 * limit × f (the period's months ÷ 12); the HSA limit × the months before 65 / 12. Test figures, not law.
 */
export function fixedContributionLimitsInto(l: { deferral: number; catchUp?: number; additions: number; ira: number; hsa: number }): LimitsInto {
  const catchUp = l.catchUp ?? 0;
  return (_p, _o, age, periodMonths, _family, months, out): void => {
    const g = periodMonths > 0 && periodMonths < 12 ? periodMonths / 12 : 1;
    out[CL.EMPLOYEE_DEFERRAL] = (l.deferral + (age >= 50 ? catchUp : 0)) * g;
    out[CL.ANNUAL_ADDITIONS] = l.additions * g;
    out[CL.IRA] = l.ira * g;
    out[CL.HSA] = (l.hsa * months) / 12;
  };
}

/**
 * The tax record with the engine's default stubs: `flatTaxInto(0.2, 0.1)`, no RMD, no Social
 * Security, no payroll tax, no contribution limit; the Roth ordering, the penalty bases, the HSA
 * split, the taxable yields and `fillPathTables` stay the tax area's (pure arithmetic on the
 * records, no law figure of their own). `over` replaces any member.
 */
export function stubTaxFunctions(over: Partial<TaxFunctions> = {}): TaxFunctions {
  return {
    ...TAX_FUNCTIONS,
    federalTaxInto: flatTaxInto(0.2, 0.1),
    requiredMinimumDistribution: noRmd,
    socialSecurityYear: noSocialSecurity,
    employeePayrollTaxInto: noPayrollTaxInto,
    contributionLimitsInto: unlimitedContributionsInto,
    ...over,
  };
}

/** The stub order of engine-and-returns §7: cash → taxable → pre-tax → Roth → HSA. */
export const DEFAULT_STUB_ORDER: readonly number[] = [TREATMENT.cash, TREATMENT.taxable, TREATMENT.pre_tax, TREATMENT.roth, TREATMENT.hsa];

/**
 * The reference withdrawal hook of engine-and-returns §3.9: the amount `x` taken along the order
 * (`fill(x)` empties the accounts in treatment order, within a treatment in account order), with
 * the contract of strategies-outputs-web §3.6 for target and gross years, solved by false position
 * with the Illinois modification and a bisection fallback. Exact once both ends of the bracket lie
 * on the root's linear piece. Counts every `assess` call of the year; at the last allowed call it
 * returns the smallest amount found with `net ≥ 0`.
 *
 * `limit` caps the calls (default `ASSESS_MAX_CALLS`); a test of the loop's guards can pass more.
 */
export function orderWithdrawals(order: readonly number[] = DEFAULT_STUB_ORDER, limit = ASSESS_MAX_CALLS): EngineHooks["planWithdrawals"] {
  let seq: Int16Array = new Int16Array(0);
  let n = 0;
  const probe: Assessment = createAssessment();
  let calls = 0;
  let view: YearView | null = null;
  let assess: AssessFn | null = null;
  let out: Float64Array = new Float64Array(0);

  const fill = (x: number): void => {
    const v = view!;
    for (let a = 0; a < v.accountCount; a++) out[a] = 0;
    let left = x;
    for (let k = 0; k < n && left > 0; k++) {
      const a = seq[k]!;
      const cap = v.available[a]!;
      const take = left < cap ? left : cap;
      out[a] = take;
      left -= take;
    }
  };
  const net = (x: number): number => {
    fill(x);
    calls++;
    assess!(out, probe);
    return probe.net;
  };
  const solve = (lo0: number, hlo0: number, hi0: number, hhi0: number): number => {
    let lo = lo0;
    let hlo = hlo0;
    let hi = hi0;
    let hhi = hhi0;
    let side = 0;
    for (;;) {
      if (calls >= limit) return hi;
      let x = lo - (hlo * (hi - lo)) / (hhi - hlo);
      if (!(x > lo && x < hi)) x = (lo + hi) / 2;
      const hx = net(x);
      if (hx >= -CASH_TOL && hx <= CASH_TOL) return x;
      if (hx < 0) {
        lo = x;
        hlo = hx;
        if (side === -1) hhi /= 2;
        side = -1;
      } else {
        hi = x;
        hhi = hx;
        if (side === 1) hlo /= 2;
        side = 1;
      }
      if (hi - lo <= CASH_TOL / 2) return hi;
    }
  };

  return (v: YearView, decision: Readonly<SpendDecision>, a: AssessFn, w: Float64Array): void => {
    if (seq.length !== v.accountCount) {
      const list: number[] = [];
      for (const tr of order) for (let k = 0; k < v.accountCount; k++) if (v.treatment[k] === tr) list.push(k);
      seq = Int16Array.from(list);
    }
    n = seq.length;
    view = v;
    assess = a;
    out = w;
    calls = 0;
    let total = 0;
    for (let k = 0; k < n; k++) total += v.available[seq[k]!]!;
    let x: number;
    if (Number.isNaN(decision.gross)) {
      const h0 = net(0);
      if (h0 >= -CASH_TOL) x = 0;
      else {
        const hT = net(total);
        x = hT <= CASH_TOL ? total : solve(0, h0, total, hT);
      }
    } else {
      let rmd = 0;
      for (let k = 0; k < v.accountCount; k++) rmd += v.rmd[k]!;
      const released = decision.gross * v.yearFraction + decision.lump - rmd;
      const wd = released > 0 ? (released < total ? released : total) : 0;
      const h1 = net(wd);
      if (h1 >= -CASH_TOL || wd >= total) x = wd;
      else {
        const hT = net(total);
        x = hT <= CASH_TOL ? total : solve(wd, h1, total, hT);
      }
    }
    fill(x);
    view = null;
    assess = null;
  };
}

/** The engine's stub hooks: the strategies area's real `decideSpending` and the reference order. */
export function stubHooks(order: readonly number[] = DEFAULT_STUB_ORDER): EngineHooks {
  return { decideSpending, planWithdrawals: orderWithdrawals(order) };
}
