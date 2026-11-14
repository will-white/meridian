/**
 * Test support for the year loop's suites (not exported from the package): run one path with
 * detail, and read a year, an account or a holding back from the `PathDetail`.
 */

import type { ClassWeights, ReturnModelConfigInput, TaxSettingsInput } from "@meridian/shared";
import { type EngineHooks, type TaxFunctions, TAX_FUNCTIONS } from "./hooks.js";
import { AC, AC_REC, type PathDetail, SP, SP_REC, YR, YR_REC, createPathDetail, simulatePath } from "./loop.js";
import { type PreparedRun, prepare } from "./prepare.js";
import { type PathState, createPathState } from "./state.js";
import { SO_REC, TAX_IN, TAX_OUT, TY_REC } from "./tax/layout.js";
import { orderWithdrawals, stubHooks, stubTaxFunctions } from "./testing/stubs.js";
import { decideSpending } from "./strategies/decide.js";
import type { SimInput } from "@meridian/shared";

/** Six-class weights in basis points: US stock, international stock, bonds, cash, real estate, other. */
export function W(us: number, intl: number, bonds: number, cash: number, realEstate = 0, other = 0): ClassWeights {
  return { us_stock: us, intl_stock: intl, bonds, cash, real_estate: realEstate, other };
}

/** "Yields 0" (engine-and-returns §7's default): no dividend, no bond spread, no gain distribution in any class. */
export const ZERO_YIELDS: TaxSettingsInput = {
  includePayrollTax: false,
  taxDrag: {
    us_stock: { dividendYieldBp: 0 },
    intl_stock: { dividendYieldBp: 0 },
    real_estate: { dividendYieldBp: 0 },
    other: { dividendYieldBp: 0 },
    bonds: { interestSpreadBp: 0 },
  },
};

/** The fixed model with rows of simple rates (fractions; each to the nearest ppm). */
export function fixedModel(...rows: ReadonlyArray<readonly [number, number, number, number]>): ReturnModelConfigInput {
  const ppm = (x: number) => Math.round(x * 1_000_000);
  return { kind: "fixed", series: rows.map(([s, b, c, i]) => ({ stocksPpm: ppm(s), bondsPpm: ppm(b), billsPpm: ppm(c), inflationPpm: ppm(i) })) };
}

export interface LoopRun {
  readonly run: PreparedRun;
  readonly ps: PathState;
  readonly detail: PathDetail;
}

/** Prepares `input` (or takes a prepared run), simulates path `k` with detail. */
export function runPath(input: SimInput | PreparedRun, o: { tax?: Partial<TaxFunctions>; hooks?: EngineHooks; path?: number } = {}): LoopRun {
  const run = "clock" in input ? input : prepare(input);
  const ps = createPathState(run, o.hooks ?? stubHooks(), stubTaxFunctions(o.tax));
  const detail = createPathDetail(run);
  simulatePath(ps, o.path ?? 0, detail);
  return { run, ps, detail };
}

/**
 * Prepares `input` (or takes a prepared run), simulates path `k` with detail on the tax area's real
 * functions (`TAX_FUNCTIONS`; `o.tax` replaces members), the production record of build step 17.
 */
export function runRealPath(input: SimInput | PreparedRun, o: { tax?: Partial<TaxFunctions>; hooks?: EngineHooks; path?: number } = {}): LoopRun {
  const run = "clock" in input ? input : prepare(input);
  const ps = createPathState(run, o.hooks ?? stubHooks(), { ...TAX_FUNCTIONS, ...o.tax });
  const detail = createPathDetail(run);
  simulatePath(ps, o.path ?? 0, detail);
  return { run, ps, detail };
}

/**
 * Hooks with the strategies area's `decideSpending` and a withdrawal hook that takes, in the plan
 * years `byYear` lists, exactly the amounts given per account (each at most what is available),
 * and in every other year runs the reference order solver.
 */
export function fixedWithdrawalHooks(byYear: Readonly<Record<number, readonly number[]>>): EngineHooks {
  const solver = orderWithdrawals();
  return {
    decideSpending,
    planWithdrawals(view, decision, assess, w) {
      const row = byYear[view.t];
      if (row === undefined) {
        solver(view, decision, assess, w);
        return;
      }
      for (let a = 0; a < view.accountCount; a++) {
        const x = row[a] ?? 0;
        w[a] = x < view.available[a]! ? x : view.available[a]!;
      }
    },
  };
}

/** A copy of `run` with account `a`'s starting basis by simulated asset (the frozen input carries one basis per account, seams C18 (b)). */
export function withBasis(run: PreparedRun, a: number, basis: readonly [number, number, number]): PreparedRun {
  const basis0 = Float64Array.from(run.basis0);
  basis0.set(basis, a * 3);
  return { ...run, basis0 };
}

export const yr = (d: PathDetail, t: number, slot: number): number => d.year[t * YR_REC + slot]!;
export const sp = (d: PathDetail, t: number, slot: number): number => d.spending[t * SP_REC + slot]!;
export const ac = (d: PathDetail, t: number, a: number, slot: number): number => d.account[(t * d.accounts + a) * AC_REC + slot]!;
export const ti = (d: PathDetail, t: number, slot: number): number => d.taxIn[t * TAX_IN + slot]!;
export const to = (d: PathDetail, t: number, slot: number): number => d.taxOut[t * TAX_OUT + slot]!;
export const so = (d: PathDetail, t: number, slot: number): number => d.socialSecurity[t * SO_REC + slot]!;
export const ty = (d: PathDetail, t: number, a: number, slot: number): number => d.yields[(t * d.accounts + a) * TY_REC + slot]!;
const triple = (arr: Float64Array, d: PathDetail, t: number, a: number): number[] => {
  const o = (t * d.accounts + a) * 3;
  return [arr[o]!, arr[o + 1]!, arr[o + 2]!];
};
export const afterTrades = (d: PathDetail, t: number, a: number): number[] => triple(d.afterTrades, d, t, a);
export const endOf = (d: PathDetail, t: number, a: number): number[] => triple(d.end, d, t, a);
export const basisOf = (d: PathDetail, t: number, a: number): number[] => triple(d.endBasis, d, t, a);

export { AC, SP, YR };
