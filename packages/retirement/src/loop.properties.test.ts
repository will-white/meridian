import {
  type ClassWeights,
  type ReturnModelConfigInput,
  SimInput,
  type SimInputAccount,
  type SimInputContribution,
  type SimInputConversion,
  type SimInputIncome,
  type SimInputSocialSecurityPerson,
  type StrategyConfigInput,
} from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { CASH_TOL } from "./constants.js";
import { EngineInvariantError } from "./errors.js";
import { type EngineHooks, TAX_FUNCTIONS } from "./hooks.js";
import { AC, AC_REC, type PathDetail, SP, SP_REC, YEAR_FLAG, YR, YR_REC, createPathDetail, simulatePath } from "./loop.js";
import { W, ZERO_YIELDS, ac, afterTrades, fixedModel, runPath, sp, yr } from "./loopTestKit.js";
import { type PreparedRun, TREATMENT, prepare, validateInput } from "./prepare.js";
import { decideSpending } from "./strategies/decide.js";
import { PATH_FLAG, type PathState, createPathState } from "./state.js";
import { RB_REC, SO, SO_REC, TAX_IN, TAX_OUT, TI, TO } from "./tax/layout.js";
import { TRADE_FLOWS_ONLY } from "./trades.js";
import { account, buildSimInput, cashAccount, incomeStream } from "./testing/simInput.js";
import { createEngineHooks } from "./withdrawals/index.js";
import {
  bracketTaxInto,
  fixedContributionLimitsInto,
  fixedSocialSecurity,
  flatPayrollTaxInto,
  flatTaxInto,
  noPayrollTaxInto,
  orderWithdrawals,
  rmdByDivisor,
  stubHooks,
  stubTaxFunctions,
  unlimitedContributionsInto,
} from "./testing/stubs.js";

// Build step 16, T45: the loop's contract guards and its invariants (engine-and-returns §3.9, §3.11
// and §7 T45; seams §2.3). "cola never falls" of the design is replaced by the price-level
// identity cpi[t + 1] = cpi[t] × priceFactor[t]: the engine's cost-of-living index is not built
// (seams C20), the tax area's COLA is pinned by its own tests (H9, J1).

function invariantCode(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof EngineInvariantError) return e.code;
    throw e;
  }
  return undefined;
}

describe("T45 contract guards", () => {
  // One person, a cash account of 100,000, spending 40,000, no tax: the year needs 40,000 from cash.
  const input = buildSimInput({
    people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 65 } }],
    accounts: [cashAccount("cash", "10000000")],
    spending: { baseAnnualCents: "4000000" },
    tax: ZERO_YIELDS,
  });
  const run = prepare(input);
  const hook = (planWithdrawals: EngineHooks["planWithdrawals"]): EngineHooks => ({ decideSpending, planWithdrawals });
  const simulate = (h: EngineHooks) => {
    const ps = createPathState(run, h, stubTaxFunctions({ federalTaxInto: flatTaxInto(0, 0) }));
    simulatePath(ps, 0);
    return ps;
  };

  it("T45 a withdrawal above available (or not a number) raises withdrawal_out_of_range", () => {
    expect(invariantCode(() => simulate(hook((v, _d, _a, w) => void (w[0] = v.available[0]! + 1))))).toBe("withdrawal_out_of_range");
    expect(invariantCode(() => simulate(hook((_v, _d, _a, w) => void (w[0] = Number.NaN))))).toBe("withdrawal_out_of_range");
    expect(invariantCode(() => simulate(hook((_v, _d, _a, w) => void (w[0] = -1))))).toBe("withdrawal_out_of_range");
    // Within the half-cent tolerance the loop takes the whole account.
    expect(invariantCode(() => simulate(hook((v, _d, _a, w) => void (w[0] = v.available[0]! + CASH_TOL / 2))))).toBeUndefined();
  });

  it("T45 a record net below −CASH_TOL while money remains raises withdrawal_short", () => {
    expect(invariantCode(() => simulate(hook(() => undefined)))).toBe("withdrawal_short");
    expect(invariantCode(() => simulate(hook((_v, _d, _a, w) => void (w[0] = 39999.99))))).toBe("withdrawal_short");
  });

  it("T45 a 25th assess call in one year raises assess_calls; 24 are allowed", () => {
    const calls = (n: number) =>
      hook((v, _d, assess, w) => {
        const out = { net: 0, tax: 0, otherCharges: 0, taxResult: new Float64Array(32) };
        for (let k = 0; k < n; k++) assess(w, out);
        w[0] = 40000 < v.available[0]! ? 40000 : v.available[0]!;
      });
    expect(invariantCode(() => simulate(calls(25)))).toBe("assess_calls");
    expect(invariantCode(() => simulate(calls(24)))).toBeUndefined();
  });

  it("T45 a hook that stops with a positive net: grossup_not_converged and the surplus saved", () => {
    // Takes 41,000 where 40,000 is needed: 1,000 is saved to the cash account (the surplus account).
    const { ps, detail } = runPath(input, { hooks: hook((_v, _d, _a, w) => void (w[0] = 41000)), tax: { federalTaxInto: flatTaxInto(0, 0) } });
    expect(ps.flags & PATH_FLAG.NOT_CONVERGED).toBe(PATH_FLAG.NOT_CONVERGED);
    expect(yr(detail, 0, YR.FLAGS) & YEAR_FLAG.NOT_CONVERGED).toBe(YEAR_FLAG.NOT_CONVERGED);
    expect(sp(detail, 0, SP.SURPLUS)).toBeCloseTo(1000, 9);
    expect(afterTrades(detail, 0, 0)[2]).toBeCloseTo(100000 - 41000 + 1000, 9);
    // The reference solver converges on the same household.
    const ref = runPath(input, { tax: { federalTaxInto: flatTaxInto(0, 0) } });
    expect(ref.ps.flags & PATH_FLAG.NOT_CONVERGED).toBe(0);
  });

  it("T45 the reference solver that is cut off returns the smallest amount found with net ≥ 0", () => {
    // Pre-tax only, 20% tax: W = 50,000 exactly in 3 calls; cut off after 2 calls the hook takes all of the bracket's top (net > 0).
    const pre = buildSimInput({
      people: [{ birthYear: 1962, longevity: { mode: "fixed", age: 65 } }],
      accounts: [account("ira", "pre_tax", "10000000")],
      spending: { baseAnnualCents: "4000000" },
      tax: ZERO_YIELDS,
    });
    const cut = runPath(pre, { hooks: { decideSpending, planWithdrawals: orderWithdrawals(undefined, 2) }, tax: { federalTaxInto: flatTaxInto(0.2, 0) } });
    expect(ac(cut.detail, 0, 0, AC.WITHDRAWAL)).toBeCloseTo(100000, 9);
    expect(cut.ps.flags & PATH_FLAG.NOT_CONVERGED).toBe(PATH_FLAG.NOT_CONVERGED);
    expect(sp(cut.detail, 0, SP.SURPLUS)).toBeCloseTo(100000 * 0.8 - 40000, 6);
  });
});

// ---------------------------------------------------------------------------------------------
// The property test: 300 seeded random households on the stub hooks.

/** mulberry32: a small seeded generator for the test's households (not the engine's). */
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

const MIXES: readonly ClassWeights[] = [
  W(6000, 0, 4000, 0),
  W(10000, 0, 0, 0),
  W(5000, 2000, 2000, 500, 300, 200),
  W(0, 0, 10000, 0),
  W(3000, 1000, 3000, 3000),
  W(2000, 0, 2000, 6000),
  W(7000, 1500, 1000, 500),
];

const month = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

interface Household {
  readonly input: SimInput;
  readonly tax: Parameters<typeof stubTaxFunctions>[0];
}

/** A random but valid household (the generator's draws decide every field; `h` seeds it). */
function household(h: number): Household {
  const rnd = generator(0x5eed0000 + h);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const chance = (p: number) => rnd() < p;
  const cents = (dollars: number) => String(Math.round(dollars * 100));

  const startYear = pick([2026, 2027]);
  const startMonth = int(1, 12);
  const planStart = month(startYear, startMonth);
  const P = chance(0.55) ? 2 : 1;
  const ids = ["p1", "p2"] as const;
  const people = Array.from({ length: P }, () => {
    const birthYear = int(1950, 1980);
    const birthMonth = int(1, 12);
    const ageNow = startYear - birthYear;
    const retireYear = int(startYear - 3, startYear + 12);
    const longevity = chance(0.2)
      ? ({ mode: "mortality", sex: pick(["female", "male"] as const), adjustYears: 0, maxAge: int(Math.max(95, ageNow + 2), 100) } as const)
      : ({ mode: "fixed", age: int(Math.max(70, ageNow + 1), Math.max(70, ageNow + 1) + 22) } as const);
    return { birthYear, birthMonth, retirementMonth: month(retireYear, int(1, 12)), longevity };
  });

  const accounts: SimInputAccount[] = [];
  const mix = () => pick(MIXES);
  const glide = () => (chance(0.3) ? { glidePath: [{ year: startYear + int(1, 4), weights: mix() }, { year: startYear + int(8, 20), weights: mix() }] } : {});
  const fee = () => ({ expenseRatioPpm: chance(0.5) ? int(0, 8000) : 0 });
  people.forEach((_, i) => {
    const owner = ids[i]!;
    if (chance(0.75)) accounts.push(account(`pre${i}`, "pre_tax", cents(int(0, 900) * 1000), { owner, type: pick(["401k", "ira"] as const), allocation: mix(), ...glide(), ...fee() }));
    if (chance(0.6)) {
      const balance = int(0, 400) * 1000;
      accounts.push(account(`roth${i}`, "roth", cents(balance), { owner, type: pick(["roth", "401k"] as const), allocation: mix(), ...(chance(0.5) ? { rothContributionBasisCents: cents(balance * rnd()) } : {}), ...fee() }));
    }
    if (chance(0.3)) accounts.push(account(`hsa${i}`, "hsa", cents(int(0, 60) * 1000), { owner, allocation: mix() }));
    if (chance(0.15)) {
      const balance = int(0, 300) * 1000;
      accounts.push(account(`own${i}`, "taxable", cents(balance), { owner, allocation: mix(), basisCents: cents(balance * rnd() * 1.3), ...glide() }));
    }
  });
  if (chance(0.7)) {
    const balance = int(0, 1200) * 1000;
    accounts.push(account("joint", "taxable", cents(balance), { allocation: mix(), basisCents: cents(balance * rnd() * 1.2), ...glide(), ...fee() }));
  }
  if (chance(0.6)) accounts.push(cashAccount("cash", cents(int(0, 100) * 1000)));

  const incomes: SimInputIncome[] = [];
  const contributions: SimInputContribution[] = [];
  const salaries: number[] = [];
  people.forEach((p, i) => {
    const personId = ids[i]!;
    if (p.retirementMonth > planStart && chance(0.85)) {
      const annual = int(30, 220) * 1000;
      salaries[i] = annual;
      incomes.push(incomeStream(`salary${i}`, "salary", cents(annual), planStart, { personId, endMonth: p.retirementMonth, realGrowthBp: int(0, 200) }));
      const pre = accounts.find((a) => a.id === `pre${i}`);
      if (pre !== undefined && chance(0.8)) {
        contributions.push({ accountId: pre.id, employeeAnnualCents: cents(int(0, 30) * 1000), employerAnnualCents: cents(int(0, 12) * 1000), scaleWith: personId, salaryBasisCents: cents(annual), endMonth: p.retirementMonth });
      }
      const roth = accounts.find((a) => a.id === `roth${i}`);
      if (roth !== undefined && chance(0.5)) {
        contributions.push({ accountId: roth.id, employeeAnnualCents: cents(int(1, 12) * 1000), employerAnnualCents: "0", scaleWith: "inflation", endMonth: p.retirementMonth });
      }
      const hsa = accounts.find((a) => a.id === `hsa${i}`);
      if (hsa !== undefined && chance(0.7)) {
        contributions.push({ accountId: hsa.id, employeeAnnualCents: cents(int(1, 9) * 1000), employerAnnualCents: cents(int(0, 2) * 1000), scaleWith: personId, salaryBasisCents: cents(annual), endMonth: p.retirementMonth });
      }
    }
    if (chance(0.35)) {
      const cola = pick([{ mode: "none" as const }, { mode: "cpi" as const }, { mode: "fixed" as const, bp: int(0, 300) }]);
      incomes.push(
        incomeStream(`pension${i}`, pick(["pension", "annuity"] as const), cents(int(5, 40) * 1000), month(startYear + int(0, 15), int(1, 12)), {
          personId,
          dollars: pick(["today", "nominal"] as const),
          cola,
          survivorBp: pick([0, 5000, 10000]),
          taxableBp: pick([10000, 10000, 6000, 0]),
        }),
      );
    }
  });
  const joint = accounts.find((a) => a.id === "joint");
  if (joint !== undefined && salaries.some((s) => s !== undefined) && chance(0.5)) {
    const basis = salaries.reduce((x, s) => x + (s ?? 0), 0);
    contributions.push({ accountId: "joint", employeeAnnualCents: cents(int(1, 20) * 1000), employerAnnualCents: "0", scaleWith: "household", salaryBasisCents: cents(basis), endMonth: month(startYear + 10, 1) });
  }
  if (chance(0.2)) incomes.push(incomeStream("rental", "rental", cents(int(5, 30) * 1000), planStart, { taxableBp: pick([10000, 7000]) }));
  if (chance(0.2)) incomes.push(incomeStream("other", "other", cents(int(1, 20) * 1000), month(startYear + int(0, 5), 1), { endMonth: month(startYear + int(6, 20), 1), taxableBp: pick([0, 10000]) }));

  const endYearGuess = Math.max(...people.map((p) => p.birthYear + (p.longevity.mode === "fixed" ? p.longevity.age : p.longevity.maxAge)));
  const lastYear = Math.min(endYearGuess, startYear + 20);
  const conversions: SimInputConversion[] = [];
  people.forEach((_, i) => {
    if (!accounts.some((a) => a.id === `roth${i}`) || !accounts.some((a) => a.id === `pre${i}`) || !chance(0.4)) return;
    const years = new Set<number>();
    for (let k = int(1, 4); k > 0; k--) years.add(int(startYear, Math.min(lastYear, startYear + 12)));
    for (const year of years) conversions.push({ year, personId: ids[i]!, amountCents: cents(int(5, 60) * 1000), dollars: pick(["today", "nominal"] as const) });
  });

  const firstRetire = people.map((p) => p.retirementMonth).sort()[0]!;
  const base = int(20, 150) * 1000;
  const strategies: StrategyConfigInput[] = [{ kind: "constant_dollar" }, { kind: "fixed_percentage", rateBp: int(300, 600) }, { kind: "guardrails" }, { kind: "vpw" }, { kind: "floor_ceiling" }];
  const goals = chance(0.4)
    ? [{ id: "g1", name: "goal", year: int(startYear, lastYear), amountCents: cents(int(5, 60) * 1000), dollars: pick(["today", "nominal"] as const) }]
    : [];
  const healthcare = chance(0.4)
    ? people.map((p, i) => ({
        personId: ids[i]!,
        preMedicareAnnualCents: cents(int(2, 15) * 1000),
        preMedicareFrom: planStart,
        medicareFrom: month(p.birthYear + 65, p.birthMonth) > planStart ? month(p.birthYear + 65, p.birthMonth) : planStart,
        medicareAnnualCents: cents(int(2, 8) * 1000),
        realGrowthBp: int(0, 200),
        inBase: chance(0.5),
      }))
    : [];
  const models: ReturnModelConfigInput[] = [
    { kind: "bootstrap", meanBlockYears: int(1, 15) },
    { kind: "parametric", preset: pick(["historical", "conservative"] as const) },
    { kind: "historical", cohorts: "wrap" },
    fixedModel([rnd() * 0.3 - 0.1, rnd() * 0.12 - 0.03, rnd() * 0.06, rnd() * 0.08 - 0.01], [rnd() * 0.3 - 0.15, rnd() * 0.1, rnd() * 0.05, rnd() * 0.06]),
  ];
  const input = buildSimInput({
    startYear,
    startMonth,
    people,
    accounts,
    incomes,
    contributions,
    rothConversions: conversions,
    spending: {
      baseAnnualCents: cents(base),
      essentialAnnualCents: cents(base * rnd()),
      startMonth: firstRetire > planStart ? firstRetire : planStart,
      survivorBp: int(5000, 10000),
      phases: chance(0.2) ? [{ fromYear: startYear + int(5, 15), multiplierBp: int(6000, 12000) }] : [],
      goals,
      healthcare,
    },
    strategy: pick(strategies),
    returnModel: pick(models),
    paths: 100,
    seed: h,
    portfolio: { taxableRebalance: pick(["full", "flows_only"] as const) },
    tax: { includePayrollTax: chance(0.5), capLossCarryInCents: chance(0.2) ? cents(int(1, 30) * 1000) : "0" },
    state: pick(["CO", "CA"]),
  });
  const pens = { pen10Rate: 0.1, pen20Rate: 0.2 };
  const tax = {
    federalTaxInto: chance(0.5) ? flatTaxInto(rnd() * 0.35, rnd() * 0.2, pens) : bracketTaxInto(int(20, 150) * 1000, rnd() * 0.15, 0.15 + rnd() * 0.25, rnd() * 0.2, pens),
    requiredMinimumDistribution: rmdByDivisor(int(18, 27), int(70, 75)),
    socialSecurityYear: fixedSocialSecurity([chance(0.7) ? int(0, 40) * 1000 : 0, chance(0.7) ? int(0, 30) * 1000 : 0]),
    employeePayrollTaxInto: chance(0.5) ? flatPayrollTaxInto(0.0765) : noPayrollTaxInto,
    // Test figures, not law: small round limits so that the caps bind in some households.
    contributionLimitsInto: chance(0.5) ? fixedContributionLimitsInto({ deferral: 20000, catchUp: 5000, additions: 50000, ira: 5000, hsa: 6000 }) : unlimitedContributionsInto,
  };
  return { input, tax };
}

interface Stats {
  households: number;
  pathYears: number;
  drawdownYears: number;
  /** First drawdown years with months before spending.startMonth (engine-01). */
  preStartYears: number;
  taxableFlowsOnlyYears: number;
  capped: number;
  failed: number;
  deaths: number;
  gross: number;
}

function createStats(): Stats {
  return { households: 0, pathYears: 0, drawdownYears: 0, preStartYears: 0, taxableFlowsOnlyYears: 0, capped: 0, failed: 0, deaths: 0, gross: 0 };
}

/**
 * Simulates path 0 and one other path of household `h` with detail and checks every path-year:
 * balances and basis ≥ 0 and finite; the cash identity in drawdown years; returns on the
 * after-trade balances; totalReal; the price level; success ⇒ no shortfall; flows_only never sells
 * beyond the flow. `year` is called for every path-year with its row for checks of its own.
 */
function checkPaths(h: number, run: PreparedRun, ps: PathState, detail: PathDetail, stats: Stats, year: (t: number, where: string) => void = () => undefined): void {
  const A = run.accountCount;
  stats.households++;
  for (const k of run.paths > 1 ? [0, 1 + (h % (run.paths - 1))] : [0]) {
    simulatePath(ps, k, detail);
    const where = (t: number) => `household ${h}, path ${k}, plan year ${t}`;
    for (let t = 0; t < detail.rows; t++) {
      stats.pathYears++;
      const y = (slot: number) => detail.year[t * YR_REC + slot]!;
      const s = (slot: number) => detail.spending[t * SP_REC + slot]!;
      const a = (acct: number, slot: number) => detail.account[(t * A + acct) * AC_REC + slot]!;
      // Finite and non-negative.
      for (let i = 0; i < A * 3; i++) {
        const o = t * A * 3 + i;
        for (const [arr, name] of [[detail.afterTrades, "after trades"], [detail.end, "end"], [detail.endBasis, "basis"]] as const) {
          const x = arr[o]!;
          if (!Number.isFinite(x) || x < -1e-6) throw new Error(`${where(t)}: ${name} ${x} at ${i}`);
        }
        if (run.treatment[Math.floor(i / 3)] !== TREATMENT.taxable && detail.endBasis[o] !== 0) throw new Error(`${where(t)}: basis outside a taxable account`);
      }
      for (const slot of [YR.CASH_INCOME, YR.RMD_TOTAL, YR.WITHDRAWAL_TOTAL, YR.TAX, YR.NET, YR.PAYROLL, YR.EMPLOYEE, YR.EMPLOYER, YR.END_TOTAL, YR.END_TOTAL_REAL]) {
        if (!Number.isFinite(y(slot))) throw new Error(`${where(t)}: year slot ${slot} is ${y(slot)}`);
      }
      // Flows within their bounds; flows_only never sells beyond the net outflow.
      for (let acct = 0; acct < A; acct++) {
        if (a(acct, AC.RMD) > a(acct, AC.START) + 1e-9 || a(acct, AC.WITHDRAWAL) > a(acct, AC.AVAILABLE) + 1e-9) throw new Error(`${where(t)}: RMD or withdrawal beyond the account`);
        if (run.tradeMode === TRADE_FLOWS_ONLY && run.treatment[acct] === TREATMENT.taxable) {
          stats.taxableFlowsOnlyYears++;
          const netOut = a(acct, AC.WITHDRAWAL) + a(acct, AC.RMD) + a(acct, AC.CONV_OUT) - a(acct, AC.DEPOSIT) - a(acct, AC.CONV_IN);
          if (a(acct, AC.SOLD) > Math.max(0, netOut) + 1e-6) throw new Error(`${where(t)}: flows_only sold ${a(acct, AC.SOLD)} for a flow of ${netOut}`);
          if (netOut > 1e-9 && a(acct, AC.BOUGHT) > 1e-9) throw new Error(`${where(t)}: flows_only bought on an outflow`);
        }
      }
      // The cash identity of a drawdown year (strategies-outputs-web §3.8 with C27's payroll term and
      // F2's other charges). The first drawdown year's months before spending.startMonth pay their
      // own tax and keep their take-home (engine-01): TAX_BASELINE and PRE_START_CASH, 0 otherwise.
      if (y(YR.PHASE) === 1 && t !== run.drawdownStart && (y(YR.TAX_BASELINE) !== 0 || y(YR.PRE_START_CASH) !== 0)) {
        throw new Error(`${where(t)}: a pre-start baseline outside the first drawdown year`);
      }
      if (y(YR.PHASE) === 1 && y(YR.PRE_START_CASH) !== 0) stats.preStartYears++;
      if (y(YR.PHASE) === 1 && (y(YR.FLAGS) & YEAR_FLAG.UNPAID_TAX) === 0) {
        stats.drawdownYears++;
        const sources = y(YR.CASH_INCOME) + y(YR.RMD_TOTAL) + y(YR.WITHDRAWAL_TOTAL);
        const uses =
          s(SP.FUNDED) + y(YR.TAX) - y(YR.TAX_BASELINE) + y(YR.OTHER_CHARGES) + y(YR.EMPLOYEE) + y(YR.PAYROLL) + s(SP.SURPLUS) + y(YR.PRE_START_CASH);
        if (Math.abs(sources - uses) > 0.01) throw new Error(`${where(t)}: sources ${sources} against uses ${uses}`);
        if (!Number.isNaN(s(SP.GROSS))) stats.gross++;
      }
      if (y(YR.CONTRIBUTION_EXCESS) > 0) stats.capped++;
      // Returns apply to the after-trade balances: Σ end = Σ after × growth × fund cost.
      let expected = 0;
      for (let acct = 0; acct < A; acct++) {
        const fee = t === 0 ? run.feeFirst[acct]! : run.fee[acct]!;
        for (let j = 0; j < 3; j++) expected += detail.afterTrades[(t * A + acct) * 3 + j]! * detail.growth[t * 3 + j]! * fee;
      }
      if (Math.abs(expected - y(YR.END_TOTAL)) > 1e-7 * Math.max(1, expected)) throw new Error(`${where(t)}: end ${y(YR.END_TOTAL)} against ${expected}`);
      if (y(YR.END_TOTAL_REAL) !== y(YR.END_TOTAL) / y(YR.CPI_END)) throw new Error(`${where(t)}: totalReal`);
      if (y(YR.CPI_END) !== y(YR.CPI_START) * detail.priceFactor[t]!) throw new Error(`${where(t)}: price level`);
      if (ps.totalReal[t] !== y(YR.END_TOTAL_REAL) || ps.totalNominal[t] !== y(YR.END_TOTAL)) throw new Error(`${where(t)}: the path arrays`);
      year(t, where(t));
    }
    // Path totals.
    if (ps.flags & PATH_FLAG.SUCCESS) expect(ps.shortfallReal, `household ${h} path ${k}`).toBe(0);
    else stats.failed++;
    if (run.personCount === 2 && ps.deathIdx[0] !== ps.deathIdx[1]) stats.deaths++;
    for (let k2 = 0; k2 < 2 * RB_REC; k2++) if (!(ps.roth[k2]! >= -1e-6)) throw new Error(`household ${h}: Roth record ${ps.roth[k2]}`);
    expect(ps.endReal).toBe(ps.endNominal / ps.cpi[ps.endIdx + 1]!);
  }
}

describe("T45 invariants over 300 seeded random households (stub hooks)", () => {
  it("T45 every path-year: balances and basis ≥ 0 and finite; the cash identity in drawdown years; returns on the after-trade balances; totalReal; the price level; success ⇒ no shortfall; flows_only never sells beyond the flow", () => {
    const stats = createStats();
    for (let h = 0; h < 300; h++) {
      const { input, tax } = household(h);
      const issues = validateInput(input);
      expect(issues, `household ${h}`).toEqual([]);
      const run = prepare(input);
      checkPaths(h, run, createPathState(run, stubHooks(), stubTaxFunctions(tax)), createPathDetail(run), stats);
    }
    // The households exercise what the invariants are about.
    expect(stats.households).toBe(300);
    expect(stats.drawdownYears).toBeGreaterThan(5000);
    expect(stats.preStartYears).toBeGreaterThan(20);
    expect(stats.taxableFlowsOnlyYears).toBeGreaterThan(500);
    expect(stats.capped).toBeGreaterThan(10);
    expect(stats.failed).toBeGreaterThan(10);
    expect(stats.deaths).toBeGreaterThan(50);
    expect(stats.gross).toBeGreaterThan(500);
  });
});

/**
 * Random Social Security entries for `input`'s people (build step 17): none, an estimate claimed
 * at 62 to 70, or a benefit already in pay since an age of 62 or more before the plan starts.
 * A separate generator, so the households' own draws are unchanged.
 */
function withSocialSecurity(input: SimInput, h: number): SimInput {
  const rnd = generator(0x55000000 + h);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const startIndex = input.plan.startYear * 12 + (Number(input.plan.startMonth.slice(5, 7)) - 1);
  const people: SimInputSocialSecurityPerson[] = input.household.people.map((p) => {
    const birthIndex = p.birthYear * 12 + p.birthMonth - 1;
    const monthlyCents = String(int(500, 4000) * 100);
    const at = (index: number) => month(Math.floor(index / 12), (index % 12) + 1);
    const r = rnd();
    if (r < 0.15) return { personId: p.id, mode: "none" };
    if (r < 0.4 && startIndex - birthIndex > 744) {
      const started = int(birthIndex + 744, Math.min(startIndex - 1, birthIndex + 840));
      return { personId: p.id, mode: "receiving", monthlyCents, asOfYear: input.plan.startYear, startedMonth: at(started), ...(rnd() < 0.5 ? { monthlyAtFraCents: monthlyCents } : {}) };
    }
    const claimAgeMonths = int(744, 840);
    return { personId: p.id, mode: "estimate", monthlyAtFraCents: monthlyCents, asOfYear: int(2016, input.plan.startYear), claimMonth: at(birthIndex + claimAgeMonths), claimAgeMonths };
  });
  return SimInput.parse({ ...input, socialSecurity: { people, spousal: rnd() < 0.8, survivor: rnd() < 0.8 } });
}

describe("T45 invariants over 300 seeded random households on the real tax functions (build step 17)", () => {
  it("T45 the same invariants with TAX_FUNCTIONS, random Social Security and the law of each year; the tax input in its bounds; filing status and benefits follow the deaths", () => {
    const stats = createStats();
    const real = { benefitYears: 0, rmdYears: 0, penaltyYears: 0, singleAfterDeath: 0, partYears: 0, notConverged: 0 };
    for (let h = 0; h < 300; h++) {
      const input = withSocialSecurity(household(h).input, h);
      expect(validateInput(input), `household ${h}`).toEqual([]);
      const run = prepare(input);
      const ps = createPathState(run, stubHooks(), TAX_FUNCTIONS);
      const detail = createPathDetail(run);
      const P = run.personCount;
      checkPaths(h, run, ps, detail, stats, (t, where) => {
        const x = (slot: number) => detail.taxIn[t * TAX_IN + slot]!;
        const r = (slot: number) => detail.taxOut[t * TAX_OUT + slot]!;
        const y = (slot: number) => detail.year[t * YR_REC + slot]!;
        // The period's amounts and f go in (C23); nothing is negative but the gains.
        if (x(TI.YEAR_FRACTION) !== y(YR.YEAR_FRACTION)) throw new Error(`${where}: YEAR_FRACTION ${x(TI.YEAR_FRACTION)}`);
        for (let slot = 0; slot < TI.N_AGED; slot++) {
          if (slot === TI.ST_GAIN || slot === TI.LT_GAIN) continue;
          if (!(x(slot) >= 0)) throw new Error(`${where}: tax input ${slot} is ${x(slot)}`);
        }
        if (!(r(TO.TOTAL) >= 0) || Math.abs(r(TO.TOTAL) - y(YR.TAX)) > 0) throw new Error(`${where}: tax ${r(TO.TOTAL)} against ${y(YR.TAX)}`);
        if (x(TI.TRAD_DIST) + 1e-6 < y(YR.RMD_TOTAL)) throw new Error(`${where}: TRAD_DIST below the RMDs`);
        if (Math.abs(x(TI.ROTH_CONV) - y(YR.CONVERSIONS)) > 1e-6) throw new Error(`${where}: ROTH_CONV ${x(TI.ROTH_CONV)} against ${y(YR.CONVERSIONS)}`);
        // L2: joint while both are alive, single from the year after a first death; benefits only while alive.
        let living = 0;
        for (let i = 0; i < P; i++) {
          const alive = detail.alive[t * P + i]!;
          living += alive;
          const benefit = detail.socialSecurity[t * SO_REC + SO.BENEFIT + i]!;
          if (!(benefit >= 0) || (alive === 0 && benefit !== 0)) throw new Error(`${where}: benefit ${benefit} of person ${i} (alive ${alive})`);
          if (benefit > 0) real.benefitYears++;
        }
        if (y(YR.FILING_STATUS) !== (living === 2 ? 1 : 0)) throw new Error(`${where}: filing status ${y(YR.FILING_STATUS)} with ${living} living`);
        if (P === 2 && living === 1) real.singleAfterDeath++;
        if (Math.abs(x(TI.SS_GROSS) - detail.socialSecurity[t * SO_REC + SO.BENEFIT]! - detail.socialSecurity[t * SO_REC + SO.BENEFIT + 1]!) > 1e-9) throw new Error(`${where}: SS_GROSS`);
        if (y(YR.RMD_TOTAL) > 0) real.rmdYears++;
        if (r(TO.PEN10) + r(TO.PEN20) > 0) real.penaltyYears++;
        if (y(YR.YEAR_FRACTION) < 1) real.partYears++;
        if ((y(YR.FLAGS) & YEAR_FLAG.NOT_CONVERGED) !== 0) real.notConverged++;
      });
    }
    expect(stats.households).toBe(300);
    expect(stats.drawdownYears).toBeGreaterThan(5000);
    expect(stats.preStartYears).toBeGreaterThan(20);
    expect(stats.failed).toBeGreaterThan(10);
    expect(stats.deaths).toBeGreaterThan(50);
    expect(real.benefitYears).toBeGreaterThan(5000);
    expect(real.rmdYears).toBeGreaterThan(1000);
    expect(real.penaltyYears).toBeGreaterThan(50);
    expect(real.singleAfterDeath).toBeGreaterThan(500);
    expect(real.partYears).toBeGreaterThan(200);
    // The reference order solver converges within its 24 calls in every year on the real function
    // (13,606 path-years, 11,601 in drawdown, 5,433 with an RMD, 200 with an additional tax, 1,451
    // capped, 317 paths with a first death, as measured when the test was written).
    expect(real.notConverged).toBe(0);
  });
});

describe("T45 invariants over 300 seeded random households on the production hooks (build step 19)", () => {
  it("T45 the same invariants with createEngineHooks() (the default order) and TAX_FUNCTIONS; the order converges in every year within the call limit", () => {
    const stats = createStats();
    const real = { notConverged: 0, years: 0, calls: 0, solved: 0, maxCalls: 0 };
    for (let h = 0; h < 300; h++) {
      const input = withSocialSecurity(household(h).input, h);
      const run = prepare(input);
      const ps = createPathState(run, createEngineHooks(), TAX_FUNCTIONS);
      const detail = createPathDetail(run);
      checkPaths(h, run, ps, detail, stats, (t) => {
        const y = (slot: number) => detail.year[t * YR_REC + slot]!;
        real.years++;
        const calls = y(YR.ASSESS_CALLS);
        real.calls += calls;
        if (calls > 2) real.solved++;
        if (calls > real.maxCalls) real.maxCalls = calls;
        if ((y(YR.FLAGS) & YEAR_FLAG.NOT_CONVERGED) !== 0) real.notConverged++;
      });
    }
    expect(stats.households).toBe(300);
    expect(stats.drawdownYears).toBeGreaterThan(5000);
    expect(stats.preStartYears).toBeGreaterThan(20);
    expect(stats.failed).toBeGreaterThan(10);
    expect(stats.deaths).toBeGreaterThan(50);
    // Measured when the test was written: 13,606 path-years (11,601 in drawdown), 4,149 of them
    // solved (more than the two bracketing calls); 2.05 calls a year on average, at most 10.
    expect(real.notConverged).toBe(0);
    expect(real.maxCalls).toBeLessThanOrEqual(24);
    expect(real.calls / real.years).toBeLessThan(3);
  });
});
