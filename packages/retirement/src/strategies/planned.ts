/**
 * Planned spending of a plan year (`plannedYear`, strategies-outputs-web §3.2 and decision 10;
 * seams C35). Pure; writes into a `PlannedYear` record and allocates nothing.
 *
 * With `s` = the survivor share when the household has two people and exactly one is alive, else 1,
 * and `cpi` the price level at the start of the year (today = 1):
 *
 * - `corePlanned = base × phase[t] × s × coreShare[t] × cpi`; `essentialCore = essentialShare × corePlanned`;
 * - `healthcare = cpi × Σ over living people of healthcareSpend[i][t]` (the part added to spending:
 *   entries with `inBase` false) and `healthcareCap = cpi × Σ healthcare[i][t]` (every entry, the
 *   HSA's qualified cap, C35);
 * - `goals = goalReal[t] × cpi + goalNominal[t]`;
 * - long-term care, for each living person i with a reserve: `d = yearsToDeath[i]` (0 in the year
 *   of death) and `k = min(ltcYears[i], d + t − drawdownStart + 1)`, the care years that fall in
 *   the drawdown (constant along a path). When `d < k` the year is a care year and
 *   `longTermCare += reserve × cpi ÷ k`. Set aside at the start of the year:
 *   `reserved += reserve × cpi × min(k, d + 1) ÷ k` (the whole reserve until care starts, then the
 *   part not yet spent). A person whose care years all fall before the drawdown (k ≤ 0) sets
 *   nothing aside;
 * - `spendable = max(0, portfolioStart − reserved)`, the `P` of every percentage rule.
 *
 * `yearsToDeath` is read here and nowhere else in the strategies: a rule sees only `spendable`.
 */

import { doubleFields } from "../doubleFields.js";
import type { StrategyTables } from "./prepare.js";

export interface PlannedYear {
  /** Planned core spending, nominal dollars a year. */
  corePlanned: number;
  /** Its essential part. */
  essentialCore: number;
  /** Healthcare added to spending (entries not included in base), nominal dollars a year. */
  healthcare: number;
  /** All healthcare, the HSA's qualified cap (C35), nominal dollars a year. */
  healthcareCap: number;
  /** Long-term care spent this year, nominal dollars a year. */
  longTermCare: number;
  /** Dated goals of the year, nominal dollars (a lump, never scaled by f). */
  goals: number;
  /** Long-term care money still set aside at the start of the year, nominal dollars. */
  reserved: number;
  /** `P`: the portfolio at the start of the year less what is set aside, at least 0. */
  spendable: number;
}

export function createPlannedYear(): PlannedYear {
  const py: PlannedYear = { corePlanned: 0, essentialCore: 0, healthcare: 0, healthcareCap: 0, longTermCare: 0, goals: 0, reserved: 0, spendable: 0 };
  return doubleFields(py, ["corePlanned", "essentialCore", "healthcare", "healthcareCap", "longTermCare", "goals", "reserved", "spendable"]);
}

/**
 * What planned spending reads: the strategy tables and six numbers of the year. The loop's view has
 * every field, so the spending hook passes the view itself and no double crosses a call boundary
 * (a double passed to or returned from a call V8 does not inline is boxed: engine-and-returns
 * §4.3's zero-allocation rule).
 */
export interface PlannedInput {
  readonly strategies: StrategyTables;
  readonly t: number;
  readonly cpi: number;
  readonly alive: ArrayLike<number>;
  readonly yearsToDeath: ArrayLike<number>;
  readonly drawdownStart: number;
  readonly portfolioStart: number;
}

const SOURCE = {
  strategies: undefined as unknown as StrategyTables,
  t: 0,
  cpi: 1.5,
  alive: new Uint8Array(0) as ArrayLike<number>,
  yearsToDeath: new Int16Array(0) as ArrayLike<number>,
  drawdownStart: 0,
  portfolioStart: 1.5,
};

/** §4.3's signature, for callers without a view (the year table recomputes the planned lines with it). */
export function plannedYear(
  tb: StrategyTables,
  t: number,
  cpi: number,
  alive: ArrayLike<number>,
  yearsToDeath: ArrayLike<number>,
  drawdownStart: number,
  portfolioStart: number,
  out: PlannedYear,
): void {
  SOURCE.strategies = tb;
  SOURCE.t = t;
  SOURCE.cpi = cpi;
  SOURCE.alive = alive;
  SOURCE.yearsToDeath = yearsToDeath;
  SOURCE.drawdownStart = drawdownStart;
  SOURCE.portfolioStart = portfolioStart;
  plannedYearOf(SOURCE, out);
}

/** Planned spending of the year `src` describes (the spending hook passes its view). */
export function plannedYearOf(src: PlannedInput, out: PlannedYear): void {
  const tb = src.strategies;
  const t = src.t;
  const cpi = src.cpi;
  const alive = src.alive;
  const yearsToDeath = src.yearsToDeath;
  const drawdownStart = src.drawdownStart;
  const portfolioStart = src.portfolioStart;
  const Y = tb.years;
  const P = tb.personCount;
  let living = 0;
  let health = 0;
  let healthCap = 0;
  let care = 0;
  let reserved = 0;
  for (let i = 0; i < P; i++) {
    if (alive[i] === 0) continue;
    living++;
    health += tb.healthcareSpend[i * Y + t]!;
    healthCap += tb.healthcare[i * Y + t]!;
    const reserve = tb.ltcReserve[i]!;
    if (reserve > 0) {
      const d = yearsToDeath[i]!;
      const span = d + t - drawdownStart + 1;
      const k = tb.ltcYears[i]! < span ? tb.ltcYears[i]! : span;
      if (k > 0) {
        const indexed = reserve * cpi;
        if (d < k) care += indexed / k;
        reserved += (indexed * (k < d + 1 ? k : d + 1)) / k;
      }
    }
  }
  const s = P === 2 && living === 1 ? tb.survivorShare : 1;
  const core = tb.base * tb.phase[t]! * s * tb.coreShare[t]! * cpi;
  out.corePlanned = core;
  out.essentialCore = tb.essentialShare * core;
  out.healthcare = health * cpi;
  out.healthcareCap = healthCap * cpi;
  out.longTermCare = care;
  out.goals = tb.goalReal[t]! * cpi + tb.goalNominal[t]!;
  out.reserved = reserved;
  out.spendable = portfolioStart > reserved ? portfolioStart - reserved : 0;
}
