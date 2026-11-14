import type {
  ClassWeights,
  ReturnModelConfigInput,
  SimInput,
  SimInputAccount,
  SimInputContribution,
  SimInputConversion,
  SimInputIncome,
  StrategyConfigInput,
} from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { assessInto } from "../assess.js";
import { CASH_TOL } from "../constants.js";
import { ASSESS_MAX_CALLS, type EngineHooks, TAX_FUNCTIONS, createAssessment } from "../hooks.js";
import { AC, AC_REC, SP, SP_REC, YEAR_FLAG, YR, YR_REC, createPathDetail, simulatePath } from "../loop.js";
import { W, fixedModel } from "../loopTestKit.js";
import { prepare, validateInput } from "../prepare.js";
import { type PathState, createPathState } from "../state.js";
import { decideSpending } from "../strategies/decide.js";
import { account, buildSimInput, cashAccount, incomeStream } from "../testing/simInput.js";
import { fixedSocialSecurity } from "../testing/stubs.js";
import { createPlanWithdrawals } from "./plan.js";
import { buildTiers, createWithdrawalTiers, fill } from "./tiers.js";

// Build step 19: WD-19 (the solver's cost and contract), WD-20 (net increasing along the order)
// and WD-21 (the cash identity) on seeded random household-years, against the real tax function
// (strategies-outputs-web §3.7 and §7.2; seams F4, C27). Every household runs the production hooks
// and `TAX_FUNCTIONS` through the loop; Social Security is a random stated amount
// (`fixedSocialSecurity`).
//
// The households: one or two people aged 50 to 92, every account kind (cash, a joint taxable
// account, pre-tax IRAs and 401(k)s, Roth accounts with and without an entered basis, HSAs), cash
// reserves, wages until a retirement inside the plan, employee contributions, pensions, rental
// income, goals, healthcare in and out of base, long-term care, Roth conversions, all five
// strategies, first years of 1 to 12 months, the yields of the tax-drag file or none, payroll tax
// on or off, both rebalancing modes, fixed returns that move. Plans run 1 to 4 years.

/** mulberry32: the test's own seeded generator (not the engine's). */
function generator(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIXES: readonly ClassWeights[] = [W(6000, 0, 4000, 0), W(10000, 0, 0, 0), W(5000, 2000, 2000, 500, 300, 200), W(0, 0, 10000, 0), W(3000, 1000, 3000, 3000), W(2000, 0, 2000, 6000)];
const month = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

interface Household {
  readonly input: SimInput;
  readonly ss: number[];
}

function household(h: number): Household {
  const rnd = generator(0x19190000 + h);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const chance = (p: number) => rnd() < p;
  const cents = (dollars: number) => String(Math.round(dollars * 100));

  const startYear = pick([2026, 2027]);
  const startMonth = chance(0.25) ? int(2, 12) : 1;
  const planStart = month(startYear, startMonth);
  const ids = ["p1", "p2"] as const;
  const P = chance(0.5) ? 2 : 1;
  const ages = Array.from({ length: P }, () => int(50, 92));
  const lives = ages.map((age) => age + int(0, 3));
  const lastYear = Math.max(...ages.map((age, i) => startYear - age + lives[i]!));
  const people = ages.map((age, i) => {
    const working = age < 70 && chance(0.25);
    return {
      birthYear: startYear - age,
      birthMonth: int(1, 12),
      retirementMonth: working ? month(startYear + int(0, lastYear - startYear), int(1, 12)) : month(startYear - int(0, 10), int(1, 12)),
      longevity: { mode: "fixed", age: lives[i]! } as const,
    };
  });
  const firstRetire = people.map((p) => p.retirementMonth).sort()[0]!;

  const accounts: SimInputAccount[] = [];
  if (chance(0.7)) accounts.push(cashAccount("cash", cents(int(0, 100) * 1000)));
  if (chance(0.6)) {
    const balance = int(0, 800) * 1000;
    accounts.push(account("joint", "taxable", cents(balance), { allocation: pick(MIXES), basisCents: cents(balance * rnd() * 1.3) }));
  }
  people.forEach((_, i) => {
    const owner = ids[i]!;
    if (chance(0.8)) accounts.push(account(`pre${i}`, "pre_tax", cents(int(0, 1500) * 1000), { owner, type: pick(["401k", "ira"] as const), allocation: pick(MIXES) }));
    if (chance(0.6)) {
      const balance = int(0, 400) * 1000;
      accounts.push(account(`roth${i}`, "roth", cents(balance), { owner, type: "roth", allocation: pick(MIXES), ...(chance(0.6) ? { rothContributionBasisCents: cents(balance * rnd()) } : {}) }));
    }
    if (chance(0.3)) accounts.push(account(`hsa${i}`, "hsa", cents(int(0, 60) * 1000), { owner, type: "hsa", allocation: pick(MIXES) }));
  });

  const incomes: SimInputIncome[] = [];
  const contributions: SimInputContribution[] = [];
  people.forEach((p, i) => {
    const personId = ids[i]!;
    if (p.retirementMonth > planStart) {
      const annual = int(30, 200) * 1000;
      incomes.push(incomeStream(`salary${i}`, "salary", cents(annual), planStart, { personId, endMonth: p.retirementMonth }));
      const pre = accounts.find((a) => a.id === `pre${i}`);
      if (pre !== undefined && chance(0.6)) {
        contributions.push({ accountId: pre.id, employeeAnnualCents: cents(int(0, 25) * 1000), employerAnnualCents: cents(int(0, 8) * 1000), scaleWith: personId, salaryBasisCents: cents(annual), endMonth: p.retirementMonth });
      }
    }
    if (chance(0.35)) {
      incomes.push(
        incomeStream(`pension${i}`, pick(["pension", "annuity"] as const), cents(int(5, 40) * 1000), month(startYear + int(-5, 2), int(1, 12)), {
          personId,
          dollars: pick(["today", "nominal"] as const),
          cola: pick([{ mode: "none" as const }, { mode: "cpi" as const }]),
          taxableBp: pick([10000, 10000, 6000]),
        }),
      );
    }
  });
  if (chance(0.15)) incomes.push(incomeStream("rental", "rental", cents(int(5, 30) * 1000), planStart, { taxableBp: 10000 }));

  const conversions: SimInputConversion[] = [];
  people.forEach((_, i) => {
    if (accounts.some((a) => a.id === `roth${i}`) && accounts.some((a) => a.id === `pre${i}`) && chance(0.25)) {
      conversions.push({ year: startYear + int(0, lastYear - startYear), personId: ids[i]!, amountCents: cents(int(5, 80) * 1000), dollars: "nominal" });
    }
  });

  const base = int(20, 200) * 1000;
  const strategies: StrategyConfigInput[] = [{ kind: "constant_dollar" }, { kind: "fixed_percentage", rateBp: int(300, 600) }, { kind: "guardrails" }, { kind: "vpw" }, { kind: "floor_ceiling" }];
  const models: ReturnModelConfigInput[] = [
    fixedModel([0, 0, 0, 0]),
    fixedModel([rnd() * 0.3 - 0.1, rnd() * 0.12 - 0.03, rnd() * 0.06, rnd() * 0.06 - 0.01], [rnd() * 0.3 - 0.15, rnd() * 0.1, rnd() * 0.05, rnd() * 0.05]),
  ];
  const input = buildSimInput({
    startYear,
    startMonth,
    people,
    accounts: accounts.length > 0 ? accounts : [cashAccount("cash", "0")],
    incomes,
    contributions,
    rothConversions: conversions,
    spending: {
      baseAnnualCents: cents(base),
      essentialAnnualCents: cents(base * rnd()),
      startMonth: firstRetire > planStart ? firstRetire : planStart,
      survivorBp: int(5000, 10000),
      goals: chance(0.3) ? [{ id: "g", name: "goal", year: startYear + int(0, lastYear - startYear), amountCents: cents(int(5, 60) * 1000), dollars: "today" }] : [],
      healthcare: chance(0.4)
        ? people.map((_, i) => ({ personId: ids[i]!, preMedicareAnnualCents: cents(int(2, 15) * 1000), preMedicareFrom: planStart, medicareFrom: planStart, medicareAnnualCents: cents(int(2, 8) * 1000), realGrowthBp: 0, inBase: chance(0.5) }))
        : [],
      longTermCare: chance(0.1) ? [{ personId: "p1", reserveCents: cents(int(20, 100) * 1000), lastYears: int(1, 2) }] : [],
    },
    strategy: pick(strategies),
    cashReserveCents: chance(0.4) ? cents(int(0, 50) * 1000) : "0",
    returnModel: pick(models),
    portfolio: { taxableRebalance: pick(["full", "flows_only"] as const) },
    tax: {
      includePayrollTax: chance(0.5),
      ...(chance(0.5) ? {} : { taxDrag: { us_stock: { dividendYieldBp: 0 }, intl_stock: { dividendYieldBp: 0 }, real_estate: { dividendYieldBp: 0 }, other: { dividendYieldBp: 0 }, bonds: { interestSpreadBp: 0 } } }),
      ...(chance(0.15) ? { capLossCarryInCents: cents(int(1, 30) * 1000) } : {}),
    },
    state: pick(["CO", "CA"]),
  });
  return { input, ss: [chance(0.6) ? int(0, 50) * 1000 : 0, chance(0.6) ? int(0, 30) * 1000 : 0] };
}

interface Sweep {
  years: number;
  drawdownYears: number;
  calls: number[];
  /** Years whose withdrawal came from the solver (more than the two bracketing calls). */
  solved: number;
  contractFailures: string[];
  identityRows: number;
  identityFailures: string[];
  monotoneYears: number;
  monotoneFailures: string[];
  gross: number;
  topUps: number;
  short: number;
  surplus: number;
}

/**
 * Runs household `h` through the loop with the production hooks and `TAX_FUNCTIONS`; checks every
 * year (WD-19, WD-21) and, while `sweep.monotoneYears < monotoneWanted`, probes net along the
 * order at 50 points of each year with something to take (WD-20).
 */
function runHousehold(h: number, sweep: Sweep, monotoneWanted: number): void {
  const { input, ss } = household(h);
  expect(validateInput(input), `household ${h}`).toEqual([]);
  const run = prepare(input);
  const A = run.accountCount;
  const planner = createPlanWithdrawals();
  const tiers = createWithdrawalTiers(A);
  const wProbe = new Float64Array(A);
  const out = createAssessment();
  let ps: PathState | null = null;
  const hooks: EngineHooks = {
    decideSpending,
    planWithdrawals(view, decision, assess, w) {
      if (sweep.monotoneYears < monotoneWanted && ps !== null) {
        buildTiers(view, decision, tiers);
        const total = tiers.total;
        if (total > 1) {
          sweep.monotoneYears++;
          // net(x) along the order, uncounted (assessInto is assess without the call counter).
          const net = (x: number) => {
            fill(tiers, x, wProbe);
            assessInto(ps!, wProbe, true, out);
            return out.net;
          };
          for (let k = 0; k < 50; k++) {
            const x = ((total - 1) * k) / 49;
            const a = net(x);
            const b = net(x + 1);
            if (!(b > a)) sweep.monotoneFailures.push(`household ${h} year ${view.t}: net(${x + 1}) = ${b} ≤ net(${x}) = ${a}`);
          }
        }
      }
      planner(view, decision, assess, w);
    },
  };
  ps = createPathState(run, hooks, { ...TAX_FUNCTIONS, socialSecurityYear: fixedSocialSecurity(ss) });
  const detail = createPathDetail(run);
  simulatePath(ps, 0, detail);
  for (let t = 0; t < detail.rows; t++) {
    const y = (slot: number) => detail.year[t * YR_REC + slot]!;
    const s = (slot: number) => detail.spending[t * SP_REC + slot]!;
    let available = 0;
    for (let a = 0; a < A; a++) available += detail.account[(t * A + a) * AC_REC + AC.AVAILABLE]!;
    const where = `household ${h}, plan year ${t}`;
    sweep.years++;
    const calls = y(YR.ASSESS_CALLS);
    sweep.calls.push(calls);
    if (calls > 2) sweep.solved++;
    // WD-19: within the limit, and the year ends converged, at the rule's withdrawal with net ≥ 0,
    // with nothing withdrawn and net ≥ 0, or with everything drawn.
    const net = y(YR.NET);
    const taken = y(YR.WITHDRAWAL_TOTAL);
    const gross = s(SP.GROSS);
    const isGross = !Number.isNaN(gross);
    let wd = 0;
    if (isGross) {
      sweep.gross++;
      const rule = gross * y(YR.YEAR_FRACTION) + s(SP.LUMP) - y(YR.RMD_TOTAL);
      wd = rule > 0 ? Math.min(rule, available) : 0;
      if (taken > wd + CASH_TOL) sweep.topUps++;
    }
    const converged = Math.abs(net) <= CASH_TOL;
    const atRule = net >= -CASH_TOL && taken <= (isGross ? wd : 0) + CASH_TOL;
    const everything = taken >= available - CASH_TOL;
    if (everything && net < -CASH_TOL) sweep.short++;
    if (atRule && net > CASH_TOL) sweep.surplus++;
    if (calls > ASSESS_MAX_CALLS || !(converged || atRule || everything)) sweep.contractFailures.push(`${where}: calls ${calls}, net ${net}, taken ${taken}, wd ${wd}, available ${available}`);
    if ((y(YR.FLAGS) & YEAR_FLAG.NOT_CONVERGED) !== 0) sweep.contractFailures.push(`${where}: not converged`);
    // WD-21: income + withdrawals = tax + contributions + payroll tax + funded + surplus (drawdown rows, C52).
    if (y(YR.PHASE) === 1) {
      sweep.drawdownYears++;
      if ((y(YR.FLAGS) & YEAR_FLAG.UNPAID_TAX) === 0) {
        sweep.identityRows++;
        const sources = y(YR.CASH_INCOME) + y(YR.RMD_TOTAL) + taken;
        const uses = y(YR.TAX) + y(YR.OTHER_CHARGES) + y(YR.EMPLOYEE) + y(YR.PAYROLL) + s(SP.FUNDED) + s(SP.SURPLUS);
        if (!(Math.abs(sources - uses) <= CASH_TOL)) sweep.identityFailures.push(`${where}: sources ${sources} against uses ${uses}`);
      }
    }
  }
}

function newSweep(): Sweep {
  return { years: 0, drawdownYears: 0, calls: [], solved: 0, contractFailures: [], identityRows: 0, identityFailures: [], monotoneYears: 0, monotoneFailures: [], gross: 0, topUps: 0, short: 0, surplus: 0 };
}

let swept: Sweep | null = null;
/** The sweep, run once for the suite: households until 5,000 household-years, the first 1,000 years with something to take probed for WD-20. */
function theSweep(): Sweep {
  if (swept === null) {
    const sweep = newSweep();
    for (let h = 0; sweep.years < 5000; h++) runHousehold(h, sweep, 1000);
    swept = sweep;
  }
  return swept;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("WD-19 to WD-21 on seeded random household-years (real tax function)", () => {

  it("WD-19 5,000 household-years: never more than 24 assess calls; each ends with |net| ≤ 0.005, or a surplus and no withdrawal beyond wd, or everything drawn; never not converged", () => {
    const sweep = theSweep();
    const sorted = [...sweep.calls].sort((a, b) => a - b);
    expect(sweep.years).toBeGreaterThanOrEqual(5000);
    expect(sweep.contractFailures).toEqual([]);
    expect(sorted[sorted.length - 1]!).toBeLessThanOrEqual(ASSESS_MAX_CALLS);
    // The sweep covers what the contract is about.
    expect(sweep.solved).toBeGreaterThan(1000);
    expect(sweep.gross).toBeGreaterThan(500);
    expect(sweep.topUps).toBeGreaterThan(50);
    expect(sweep.short).toBeGreaterThan(50);
    expect(sweep.surplus).toBeGreaterThan(200);
  });

  it("WD-19 the measured cost: under 3 assess calls a year on average, under 5 in a year that is solved; the 99th percentile 7", () => {
    // Measured when the test was written: 5,001 household-years (4,917 in drawdown, 1,830 gross
    // years, 358 top-ups, 136 short, 2,229 with a surplus): 2.73 calls a year on average; 2,555
    // years entered the solver (more than the two bracketing calls), 4.35 calls on average among
    // them; the 99th percentile 7; two years needed 10 and 12 (a root among short linear pieces of
    // the real tax function, where the Illinois step closes the bracket in small steps). Calls
    // per year: 1: 2,376; 2: 70; 3: 1,085; 4: 162; 5: 813; 6: 322; 7: 164; 8: 7; 10: 1; 12: 1. The
    // design's scratch measurement (39,838 years): 2.71, 4.45, 7 at the 99th percentile, 10 at most.
    const sweep = theSweep();
    const sorted = [...sweep.calls].sort((a, b) => a - b);
    const solvedCalls = sweep.calls.filter((c) => c > 2);
    expect(mean(sweep.calls)).toBeLessThan(3);
    expect(mean(solvedCalls)).toBeLessThan(5);
    expect(sorted[Math.floor(0.99 * (sorted.length - 1))]!).toBeLessThanOrEqual(7);
    expect(sorted[sorted.length - 1]!).toBeLessThanOrEqual(12);
  });

  it("WD-20 monotonicity: for 1,000 household-years, net(x + 1) > net(x) at 50 points along the order", () => {
    const sweep = theSweep();
    expect(sweep.monotoneYears).toBe(1000);
    expect(sweep.monotoneFailures).toEqual([]);
  });

  it("WD-21 the cash identity on 1,000 or more drawdown rows: income + withdrawals = tax + contributions + payroll tax + funded + surplus, within 0.005", () => {
    const sweep = theSweep();
    expect(sweep.identityRows).toBeGreaterThanOrEqual(1000);
    expect(sweep.identityFailures).toEqual([]);
  });
});
