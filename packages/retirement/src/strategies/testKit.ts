/**
 * Test support for the strategies (not exported from the package): a mutable `SpendingView` the
 * cases fill by hand, standing in for the loop's `YearView` until build step 16.
 */

import type { StrategyTables } from "./prepare.js";
import type { SpendingView } from "./types.js";

export interface TestView extends SpendingView {
  t: number;
  year: number;
  cpi: number;
  phase: 0 | 1;
  readonly alive: Uint8Array;
  readonly retired: Uint8Array;
  readonly age: Int16Array;
  readonly yearsToDeath: Int16Array;
  drawdownStart: number;
  portfolioStart: number;
  wages: number;
  guaranteedIncome: number;
  otherIncome: number;
  prevPortfolioReturn: number;
  prevInflation: number;
  stockShare: number;
}

export interface TestViewFields {
  t?: number;
  cpi?: number;
  phase?: 0 | 1;
  alive?: number[];
  retired?: number[];
  age?: number[];
  yearsToDeath?: number[];
  drawdownStart?: number;
  portfolioStart?: number;
  wages?: number;
  guaranteedIncome?: number;
  otherIncome?: number;
  prevPortfolioReturn?: number;
  prevInflation?: number;
  stockShare?: number;
}

/** A view of plan year `t` (default 0): everyone alive, retired, 65 and 30 years from death; a drawdown year from 0; no income. */
export function testView(tb: StrategyTables, f: TestViewFields = {}): TestView {
  const P = tb.personCount;
  const fill = (values: number[] | undefined, dflt: number) => Array.from({ length: P }, (_, i) => values?.[i] ?? dflt);
  const t = f.t ?? 0;
  return {
    t,
    year: tb.startYear + t,
    cpi: f.cpi ?? 1,
    phase: f.phase ?? 1,
    alive: Uint8Array.from(fill(f.alive, 1)),
    retired: Uint8Array.from(fill(f.retired, 1)),
    age: Int16Array.from(fill(f.age, 65)),
    yearsToDeath: Int16Array.from(fill(f.yearsToDeath, 30)),
    drawdownStart: f.drawdownStart ?? 0,
    portfolioStart: f.portfolioStart ?? 0,
    wages: f.wages ?? 0,
    guaranteedIncome: f.guaranteedIncome ?? 0,
    otherIncome: f.otherIncome ?? 0,
    prevPortfolioReturn: f.prevPortfolioReturn ?? Number.NaN,
    prevInflation: f.prevInflation ?? Number.NaN,
    stockShare: f.stockShare ?? 0.6,
    strategies: tb,
  };
}

/** `base^n` by repeated multiplication (a price level of n years at a constant rate). */
export function level(base: number, n: number): number {
  let x = 1;
  for (let i = 0; i < n; i++) x *= base;
  return x;
}
