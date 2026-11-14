/**
 * `prepareStrategies(input)`: the tables the spending hook reads (strategies-outputs-web §2.1 and
 * §4.3; seams C1, C35, C47). Built once by the engine's `prepare()` on every thread; read through
 * `YearView.strategies`. Money is float64 dollars a year in today's dollars unless a name says
 * otherwise; one entry per plan year where an array is per year, and `[i × Y + t]` for person i.
 *
 * Basis points are divided by 10,000 and cents by 100 here and nowhere else (§4.1). The month
 * windows of the frozen input (`spending.startMonth`, each person's `preMedicareFrom` and
 * `medicareFrom`) become full-year rates through the clock's `yearShare`, so the hooks never see a
 * month.
 */

import {
  type SimInput,
  type StrategyConfig,
  type StrategyKind,
  StrategyConfig as StrategyConfigSchema,
  type VpwParams,
  vpwParams,
} from "@meridian/shared";
import { type PlanClock, monthIndex, planClock, yearShare } from "../clock.js";
import { powInt } from "../detmath.js";
import { EngineInputError } from "../errors.js";
import { centsToDollars } from "../units.js";

/** The strategy kinds by index (§2.1 `kind`). */
export const STRATEGY = {
  constant_dollar: 0,
  fixed_percentage: 1,
  guardrails: 2,
  vpw: 3,
  floor_ceiling: 4,
} as const satisfies Record<StrategyKind, number>;
export type StrategyIndex = (typeof STRATEGY)[StrategyKind];

/** Guyton and Klinger's parameters as fractions and whole years (§3.4 (c)). */
export interface GuardrailParams {
  /** The capital-preservation band above the initial rate and the prosperity band below it. */
  readonly upper: number;
  readonly lower: number;
  /** The cut and the raise, of the portfolio-funded part of the plan. */
  readonly cut: number;
  readonly raise: number;
  /** 1: skip the inflation raise after a losing year while the rate is above the initial rate. */
  readonly skipAfterLoss: 0 | 1;
  /** No cut while `yearsRemaining ≤ cutoffYears`. */
  readonly cutoffYears: number;
  /** The horizon age of a person under table mortality. */
  readonly planningAge: number;
}

/** Floor and ceiling (§3.4 (e)): the percentage (NaN = derive from the plan) and the band. */
export interface FloorCeilingParams {
  readonly rate: number;
  readonly floor: number;
  readonly ceiling: number;
}

export interface StrategyTables {
  readonly kind: StrategyIndex;
  /** Y plan years and P people. */
  readonly years: number;
  readonly personCount: number;
  readonly startYear: number;
  /** Base core spending, dollars a year. */
  readonly base: number;
  /** `essentialAnnualCents ÷ baseAnnualCents`, 0 when the base is 0. */
  readonly essentialShare: number;
  /** `survivorBp ÷ 10000`: the base after the first death of a couple. */
  readonly survivorShare: number;
  /** Phase multiplier of each plan year: the last phase with `fromYear ≤ year`, 1 when none. */
  readonly phase: Float64Array;
  /** The share of each plan year in which core spending runs (the window from `spending.startMonth`). */
  readonly coreShare: Float64Array;
  /** Dated goals of each plan year: in today's dollars (to be indexed) and as quoted in their year's dollars. */
  readonly goalReal: Float64Array;
  readonly goalNominal: Float64Array;
  /**
   * Healthcare per person and plan year, the pre-Medicare and Medicare amounts already multiplied
   * by the shares of their windows and by `(1 + realGrowthBp / 10000)^t`. `healthcare` holds every
   * entry and is the HSA's qualified cap; `healthcareSpend` only the entries with `inBase` false,
   * the part added to spending (seams C35, plan decision 9).
   */
  readonly healthcare: Float64Array;
  readonly healthcareSpend: Float64Array;
  /** Long-term care reserve per person in today's dollars (0 = none) and its `lastYears`. */
  readonly ltcReserve: Float64Array;
  readonly ltcYears: Int16Array;
  /** `fixed_percentage`: the rate a year. */
  readonly fixedRate: number;
  readonly gk: GuardrailParams;
  readonly vpw: VpwParams;
  readonly fc: FloorCeilingParams;
  /** `birthYear + (fixed life-expectancy age, or gk.planningAge under table mortality)`. */
  readonly horizonYear: Int16Array;
  /** The default order's cash reserve, today's dollars. */
  readonly cashReserve: number;
}

// The schema's defaults fill the parameters of the kinds that are not chosen, so every table has
// the same shape.
const DEFAULTS = {
  fixed_percentage: StrategyConfigSchema.parse({ kind: "fixed_percentage" }) as Extract<StrategyConfig, { kind: "fixed_percentage" }>,
  guardrails: StrategyConfigSchema.parse({ kind: "guardrails" }) as Extract<StrategyConfig, { kind: "guardrails" }>,
  vpw: StrategyConfigSchema.parse({ kind: "vpw" }) as Extract<StrategyConfig, { kind: "vpw" }>,
  floor_ceiling: StrategyConfigSchema.parse({ kind: "floor_ceiling" }) as Extract<StrategyConfig, { kind: "floor_ceiling" }>,
};

const BP = 10000;
/** Healthcare's yearly real growth in basis points: the profile's range (shared `SimInputHealthcare`). */
const HEALTHCARE_GROWTH_BP = [0, 1000] as const;
/** Long-term care's `lastYears`: the profile's range (shared `SimInputSpending`). */
const MAX_CARE_YEARS = 10;

function spendingError(message: string): EngineInputError {
  return new EngineInputError("spending_invalid", message);
}

/**
 * Builds the strategy tables of a frozen input. Throws `EngineInputError` on a malformed spending
 * block: `person_missing` (an entry names a person the household does not have), `spending_invalid`
 * (essential above base, a goal outside the plan, phases out of year order, a healthcare growth rate
 * outside 0 to 1,000 bp, two long-term care entries for one person, `lastYears` outside 1 to 10),
 * `plan_invalid` and `horizon_too_long` (the clock). The ranges are the shared schema's, checked
 * again for an input that did not pass it (seams C13).
 */
export function prepareStrategies(input: SimInput, clock: PlanClock = planClock(input.plan)): StrategyTables {
  const Y = clock.years;
  const people = input.household.people;
  const P = people.length;
  const personIndex = (id: string, where: string): number => {
    const i = people.findIndex((p) => p.id === id);
    if (i < 0) throw new EngineInputError("person_missing", `${where} names ${id}, who is not in the household`);
    return i;
  };
  const sp = input.spending;

  const base = centsToDollars(sp.baseAnnualCents);
  const essential = centsToDollars(sp.essentialAnnualCents);
  if (essential > base) throw spendingError(`essential spending (${sp.essentialAnnualCents} cents) is above base spending (${sp.baseAnnualCents} cents)`);

  // The multiplier of a year is the last phase with fromYear ≤ year (§2.1): read by year, never
  // by array order, so the years must strictly ascend (the schema's refinement, here for an input
  // that did not pass it; seams C13).
  sp.phases.forEach((p, k) => {
    if (k > 0 && !(p.fromYear > sp.phases[k - 1]!.fromYear)) {
      throw spendingError(`the spending phases must run in strictly ascending years; ${p.fromYear} follows ${sp.phases[k - 1]!.fromYear}`);
    }
  });
  const phase = new Float64Array(Y);
  const coreShare = new Float64Array(Y);
  const coreFrom = monthIndex(sp.startMonth);
  for (let t = 0; t < Y; t++) {
    const year = clock.startYear + t;
    let multiplier = 1;
    for (const p of sp.phases) if (p.fromYear <= year) multiplier = p.multiplierBp / BP;
    phase[t] = multiplier;
    coreShare[t] = yearShare(clock, t, coreFrom, Infinity);
  }

  const goalReal = new Float64Array(Y);
  const goalNominal = new Float64Array(Y);
  for (const g of sp.goals) {
    const t = g.year - clock.startYear;
    if (t < 0 || t >= Y) throw spendingError(`the goal ${g.id} in ${g.year} is outside the plan's years ${clock.startYear} to ${clock.startYear + Y - 1}`);
    const amount = centsToDollars(g.amountCents);
    if (g.dollars === "today") goalReal[t] = goalReal[t]! + amount;
    else goalNominal[t] = goalNominal[t]! + amount;
  }

  const healthcare = new Float64Array(P * Y);
  const healthcareSpend = new Float64Array(P * Y);
  for (const h of sp.healthcare) {
    const i = personIndex(h.personId, "a healthcare entry");
    if (!Number.isInteger(h.realGrowthBp) || h.realGrowthBp < HEALTHCARE_GROWTH_BP[0] || h.realGrowthBp > HEALTHCARE_GROWTH_BP[1]) {
      throw spendingError(`healthcare for ${h.personId} grows by ${h.realGrowthBp} bp a year; it must be ${HEALTHCARE_GROWTH_BP[0]} to ${HEALTHCARE_GROWTH_BP[1]} (the profile's range)`);
    }
    const growth = 1 + h.realGrowthBp / BP;
    const pre = centsToDollars(h.preMedicareAnnualCents);
    const medicare = centsToDollars(h.medicareAnnualCents);
    const preFrom = monthIndex(h.preMedicareFrom);
    const medicareFrom = monthIndex(h.medicareFrom);
    for (let t = 0; t < Y; t++) {
      const amount = (pre * yearShare(clock, t, preFrom, medicareFrom) + medicare * yearShare(clock, t, medicareFrom, Infinity)) * powInt(growth, t);
      healthcare[i * Y + t] = healthcare[i * Y + t]! + amount;
      if (!h.inBase) healthcareSpend[i * Y + t] = healthcareSpend[i * Y + t]! + amount;
    }
  }

  const ltcReserve = new Float64Array(P);
  const ltcYears = new Int16Array(P);
  for (const c of sp.longTermCare) {
    const i = personIndex(c.personId, "a long-term care entry");
    if (ltcYears[i] !== 0) throw spendingError(`two long-term care entries for ${c.personId}`);
    if (!Number.isInteger(c.lastYears) || c.lastYears < 1 || c.lastYears > MAX_CARE_YEARS) {
      throw spendingError(`long-term care for ${c.personId} covers ${c.lastYears} years; it must be 1 to ${MAX_CARE_YEARS} (the profile's range)`);
    }
    ltcReserve[i] = centsToDollars(c.reserveCents);
    ltcYears[i] = c.lastYears;
  }

  const config = input.settings.strategy;
  const fixedCfg = config.kind === "fixed_percentage" ? config : DEFAULTS.fixed_percentage;
  const gkCfg = config.kind === "guardrails" ? config : DEFAULTS.guardrails;
  const vpwCfg = config.kind === "vpw" ? config : DEFAULTS.vpw;
  const fcCfg = config.kind === "floor_ceiling" ? config : DEFAULTS.floor_ceiling;
  const gk: GuardrailParams = {
    upper: gkCfg.upperBandBp / BP,
    lower: gkCfg.lowerBandBp / BP,
    cut: gkCfg.cutBp / BP,
    raise: gkCfg.raiseBp / BP,
    skipAfterLoss: gkCfg.skipInflationAfterLoss ? 1 : 0,
    cutoffYears: gkCfg.preservationCutoffYears,
    planningAge: gkCfg.planningAge,
  };
  const fc: FloorCeilingParams = {
    rate: fcCfg.rateBp === undefined ? Number.NaN : fcCfg.rateBp / BP,
    floor: fcCfg.floorBp / BP,
    ceiling: fcCfg.ceilingBp / BP,
  };

  const horizonYear = new Int16Array(P);
  people.forEach((p, i) => {
    horizonYear[i] = p.birthYear + (p.longevity.mode === "fixed" ? p.longevity.age : gk.planningAge);
  });

  return {
    kind: STRATEGY[config.kind],
    years: Y,
    personCount: P,
    startYear: clock.startYear,
    base,
    essentialShare: base > 0 ? essential / base : 0,
    survivorShare: sp.survivorBp / BP,
    phase,
    coreShare,
    goalReal,
    goalNominal,
    healthcare,
    healthcareSpend,
    ltcReserve,
    ltcYears,
    fixedRate: fixedCfg.rateBp / BP,
    gk,
    vpw: vpwParams(vpwCfg),
    fc,
    horizonYear,
    cashReserve: centsToDollars(input.settings.withdrawalOrder.cashReserveCents),
  };
}
