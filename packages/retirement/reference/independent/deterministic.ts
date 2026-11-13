// The deterministic year loop of the reference sheets R1 and R2 (r1.md §2, r2.md §2): fixed
// markets, one path, every rule written out by hand from the sheets. Nothing here is shared with
// packages/retirement/src: the trades, the basis arithmetic, the withdrawal tiers, the gross-up (a
// bisection of 200 halvings) and the tax are this file's own.

import { lawFor, type Filing, type YearLaw } from "./law.js";
import { socialSecurityChain, monthIndex, type SsPerson, type SsYear } from "./socialSecurity.js";
import { federalTax, type TaxDetail, type TaxInput } from "./tax.js";

export type Asset = "stocks" | "bonds" | "bills";
export const ASSETS: readonly Asset[] = ["stocks", "bonds", "bills"];
export type Bucket = "cash" | "taxable" | "pre_tax" | "roth" | "hsa";
export const BUCKETS: readonly Bucket[] = ["cash", "taxable", "pre_tax", "roth", "hsa"];

export interface PersonSpec {
  readonly id: string;
  readonly birthYear: number;
  readonly birthMonth: number;
  /** Fixed longevity: alive through this calendar year, gone from the next. */
  readonly lastAliveYear: number;
}

export interface AccountSpec {
  readonly id: string;
  readonly bucket: Bucket;
  /** "joint" or a person id. */
  readonly owner: string;
  readonly balance: number;
  /** Taxable accounts only: the one basis the frozen input carries. */
  readonly basis: number;
  /** Allocation over the three simulated assets (us_stock → stocks, bonds → bonds, cash → bills). */
  readonly weights: Readonly<Record<Asset, number>>;
}

export interface Scenario {
  readonly id: "r1" | "r2";
  readonly startYear: number;
  readonly endYear: number;
  readonly persons: readonly PersonSpec[];
  readonly accounts: readonly AccountSpec[];
  /** The fixed model: one row of simple annual rates repeated every year. */
  readonly returns: Readonly<Record<Asset, number>>;
  readonly inflation: number;
  /** Nominal pensions with no increase, fully taxable, paid while the owner lives. */
  readonly pensions: ReadonlyArray<{ readonly personId: string; readonly annual: number }>;
  readonly socialSecurity: readonly SsPerson[];
  readonly spending: {
    /** Core spending in today's dollars. */
    readonly base: number;
    readonly phases: ReadonlyArray<{ readonly fromYear: number; readonly multiplier: number }>;
    /** Share of core spending after the first death. */
    readonly survivorShare: number;
    /** Dated goals in today's dollars, never scaled. */
    readonly goals: ReadonlyArray<{ readonly year: number; readonly amount: number }>;
    /** Healthcare per living person, today's dollars (0 for none). */
    readonly healthcarePerPerson: number;
    readonly longTermCare: ReadonlyArray<{ readonly personId: string; readonly reserve: number; readonly lastYears: number }>;
  };
  readonly conversions: ReadonlyArray<{
    readonly personId: string;
    readonly year: number;
    readonly amount: number;
    readonly dollars: "nominal" | "today";
  }>;
  /** Cash reserve in today's dollars. */
  readonly cashReserve: number;
  /** Taxable accounts: dividend yield of stocks, its qualified share, the bond spread over the previous bill return. */
  readonly dividendYield: number;
  readonly qualifiedShare: number;
  readonly bondSpread: number;
  /** Basis reset share of a joint account at the first death (0.5: not a community-property state). */
  readonly jointBasisShare: number;
}

/** Uniform Lifetime divisors (Publication 590-B, Appendix B, Table III), the ages the sheets list. */
const UNIFORM: Readonly<Record<number, number>> = {
  73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4,
  82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2,
};

/** RMD start age by birth year: 73 for 1951 to 1959, 75 for 1960 and later (the sheets' §2.7). */
function rmdStartAge(birthYear: number): number {
  if (birthYear >= 1960) return 75;
  if (birthYear >= 1951) return 73;
  throw new RangeError(`no RMD start age transcribed for birth year ${birthYear}`);
}

function divisor(age: number): number {
  const d = UNIFORM[age];
  if (d === undefined) throw new RangeError(`no Uniform Lifetime divisor transcribed for age ${age}`);
  return d;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export interface YearRow {
  readonly year: number;
  readonly t: number;
  readonly ages: string;
  readonly filing: Filing;
  readonly cpiStart: number;
  readonly cpiEnd: number;
  readonly ss: Readonly<Record<string, number>>;
  readonly pension: number;
  readonly incomeTotal: number;
  readonly planned: number;
  readonly healthcare: number;
  readonly longTermCare: number;
  readonly goals: number;
  readonly floor: number;
  readonly funded: number;
  readonly core: number;
  readonly shortfall: number;
  readonly surplus: number;
  readonly withdrawals: Readonly<Record<string, number>>;
  readonly rmd: Readonly<Record<string, number>>;
  readonly withdrawalsTotal: number;
  readonly rmdTotal: number;
  readonly conversions: number;
  readonly realizedGains: number;
  readonly dividends: number;
  readonly qualifiedDividends: number;
  readonly coupons: number;
  readonly interestCarried: number;
  readonly tax: TaxDetail;
  readonly law: YearLaw;
  readonly ending: Readonly<Record<string, number>>;
  /** Taxable accounts: basis by asset after the year, before a death-year reset. */
  readonly basis: Readonly<Record<string, Readonly<Record<Asset, number>>>>;
  readonly endTotal: number;
  readonly endTotalReal: number;
  readonly growth: number;
  readonly withdrawalRate: number;
  readonly portfolioReturn: number;
  readonly startTotal: number;
}

export interface RunResult {
  readonly scenario: Scenario;
  readonly rows: readonly YearRow[];
  readonly ss: readonly SsYear[];
  readonly startTotal: number;
  readonly endNominal: number;
  readonly endReal: number;
  readonly success: boolean;
  /** First year whose floor was not funded, or −1. */
  readonly depletionYear: number;
  readonly lifetimeShortfallReal: number;
  readonly lifetimeFundedReal: number;
  readonly lifetimeTaxReal: number;
  /** Largest number of tax evaluations in one year (net(0), net(all) and the bisection). */
  readonly maxEvaluations: number;
}

interface TaxableState {
  bal: Record<Asset, number>;
  basis: Record<Asset, number>;
}

/** Trades of one taxable account: the flow and the rebalancing in one list (sheets §2.2). */
function taxableTrades(state: TaxableState, weights: Readonly<Record<Asset, number>>, withdrawal: number) {
  const value = state.bal.stocks + state.bal.bonds + state.bal.bills;
  const after = value - withdrawal;
  const bal = { ...state.bal };
  const basis = { ...state.basis };
  let gains = 0;
  for (const a of ASSETS) {
    const target = weights[a] * after;
    const v = bal[a];
    if (v > target) {
      const s = v - target;
      const k = basis[a];
      gains += s * (1 - k / v);
      basis[a] = k - (s * k) / v;
      bal[a] = target;
    } else if (v < target) {
      basis[a] += target - v;
      bal[a] = target;
    }
  }
  return { bal, basis, gains };
}

interface Tier {
  readonly caps: ReadonlyArray<{ readonly id: string; readonly cap: number }>;
  readonly total: number;
  /** Which kind of money the tier is: decides how a withdrawal from it is taxed. */
  readonly kind: "cash" | "hsa_qualified" | "taxable" | "pre_tax" | "roth_free" | "hsa_taxable";
}

/** `fill(x)`: whole tiers in order until x ends inside one, which is drawn pro rata. */
function fill(tiers: readonly Tier[], x: number) {
  const amount: Record<string, number> = {};
  const byKind: Record<Tier["kind"], Record<string, number>> = {
    cash: {}, hsa_qualified: {}, taxable: {}, pre_tax: {}, roth_free: {}, hsa_taxable: {},
  };
  let rest = x;
  for (const tier of tiers) {
    if (rest <= 0) break;
    if (tier.total <= 0) continue;
    const whole = rest >= tier.total;
    for (const { id, cap } of tier.caps) {
      const take = whole ? cap : (cap * rest) / tier.total;
      amount[id] = (amount[id] ?? 0) + take;
      byKind[tier.kind][id] = (byKind[tier.kind][id] ?? 0) + take;
    }
    rest = whole ? rest - tier.total : 0;
  }
  return { amount, byKind };
}

export function runDeterministic(s: Scenario): RunResult {
  const years = s.endYear - s.startYear + 1;
  const persons = new Map(s.persons.map((p) => [p.id, p]));
  const person = (id: string): PersonSpec => {
    const p = persons.get(id);
    if (p === undefined) throw new RangeError(`unknown person ${id}`);
    return p;
  };
  const inflation = Array.from({ length: years }, () => s.inflation);
  const ssChain = socialSecurityChain(s.socialSecurity, s.startYear, s.endYear, inflation);

  // Price level and the indexing factor: cpi[0] = 1, cpi[t+1] = cpi[t] × (1 + inflation).
  const cpi: number[] = [1];
  for (let t = 0; t < years; t++) cpi.push((cpi[t] as number) * (1 + (inflation[t] as number)));

  // Balances. Taxable accounts by asset with basis; the bill slice starts at basis = value and the
  // rest of the account's basis is shared across stocks and bonds by value (r2.md §2.2).
  const balance = new Map<string, number>();
  const taxable = new Map<string, TaxableState>();
  for (const a of s.accounts) {
    balance.set(a.id, a.balance);
    if (a.bucket === "taxable") {
      const bal = { stocks: a.balance * a.weights.stocks, bonds: a.balance * a.weights.bonds, bills: a.balance * a.weights.bills };
      const rest = Math.max(0, a.basis - bal.bills);
      const sb = bal.stocks + bal.bonds;
      taxable.set(a.id, {
        bal,
        basis: { stocks: sb > 0 ? (rest * bal.stocks) / sb : 0, bonds: sb > 0 ? (rest * bal.bonds) / sb : 0, bills: bal.bills },
      });
    }
  }
  const startTotal = s.accounts.reduce((sum, a) => sum + a.balance, 0);
  const startBalance = new Map(s.accounts.map((a) => [a.id, a.balance]));
  // The Roth five-year clock: an existing Roth with a balance at the plan start counts as first funded five years before.
  const rothFirstFunded = new Map<string, number>();
  for (const a of s.accounts) {
    if (a.bucket === "roth" && a.balance > 0) rothFirstFunded.set(a.owner, s.startYear - 5);
  }
  const surplusAccount = [...s.accounts]
    .filter((a) => a.bucket === "taxable")
    .sort((x, y) => y.balance - x.balance || (x.id < y.id ? -1 : 1))[0];

  let interestCarried = 0;
  let prevBill = s.returns.bills; // the model's first row stands in for the year before 2027
  let previousTotal = startTotal;
  let maxEvaluations = 0;
  const rows: YearRow[] = [];
  let depletionYear = -1;
  let lifetimeShortfallReal = 0;
  let lifetimeFundedReal = 0;
  let lifetimeTaxReal = 0;

  for (let t = 0; t < years; t++) {
    const year = s.startYear + t;
    const cpiStart = cpi[t] as number;
    const alive = (id: string): boolean => year <= person(id).lastAliveYear;
    const living = s.persons.filter((p) => alive(p.id));
    const ownerOf = (a: AccountSpec): string => {
      if (a.owner === "joint" || alive(a.owner)) return a.owner;
      const heir = living[0];
      if (heir === undefined) throw new RangeError("nobody alive");
      return heir.id;
    };
    const filing: Filing = living.length === 2 ? "joint" : "single";
    const nAged = living.filter((p) => year - p.birthYear >= 65).length;
    const ages = s.persons.map((p) => (alive(p.id) ? String(year - p.birthYear) : "–")).join(" / ");
    const law = lawFor(year, filing, cpiStart);

    // 1. Income.
    const ssYear = ssChain[t] as SsYear;
    const ss: Record<string, number> = {};
    for (const p of s.persons) ss[p.id] = ssYear.annual[p.id] ?? 0;
    const benefits = Object.values(ss).reduce((sum, v) => sum + v, 0);
    const pension = s.pensions.reduce((sum, p) => sum + (alive(p.personId) ? p.annual : 0), 0);
    const incomeTotal = benefits + pension;

    // 3. Spending need (constant_dollar).
    const phase = s.spending.phases.reduce((m, p) => (p.fromYear <= year ? p.multiplier : m), 1);
    const share = s.persons.length === 2 && living.length < 2 ? s.spending.survivorShare : 1;
    const core = s.spending.base * (phase * share) * cpiStart;
    const healthcare = living.reduce((sum) => sum + s.spending.healthcarePerPerson * cpiStart, 0);
    const longTermCare = s.spending.longTermCare.reduce((sum, c) => {
      const p = person(c.personId);
      const inCare = alive(p.id) && year > p.lastAliveYear - c.lastYears;
      return sum + (inCare ? (c.reserve / c.lastYears) * cpiStart : 0);
    }, 0);
    const goals = s.spending.goals.reduce((sum, g) => sum + (g.year === year ? g.amount * cpiStart : 0), 0);
    const need = core + healthcare + longTermCare + goals;
    const planned = core + healthcare + longTermCare;

    // 4. RMDs, then the scheduled conversion.
    const rmd: Record<string, number> = {};
    for (const a of s.accounts) {
      if (a.bucket !== "pre_tax") continue;
      const owner = person(ownerOf(a));
      const age = year - owner.birthYear;
      const bal = balance.get(a.id) as number;
      rmd[a.id] = age >= rmdStartAge(owner.birthYear) && bal > 0 ? Math.min(bal, bal / divisor(age)) : 0;
    }
    const convOut: Record<string, number> = {};
    const convIn: Record<string, number> = {};
    let conversions = 0;
    for (const c of s.conversions) {
      if (c.year !== year) continue;
      if (!alive(c.personId)) throw new RangeError("a conversion after death is not exercised by the sheets");
      const amount = c.dollars === "today" ? c.amount * cpiStart : c.amount;
      const sources = s.accounts.filter((a) => a.bucket === "pre_tax" && ownerOf(a) === c.personId);
      const room = sources.reduce((sum, a) => sum + (balance.get(a.id) as number) - (rmd[a.id] as number), 0);
      if (amount > room) throw new RangeError("a conversion larger than the pre-tax balance is not exercised by the sheets");
      for (const a of sources) {
        const part = (amount * ((balance.get(a.id) as number) - (rmd[a.id] as number))) / room;
        convOut[a.id] = (convOut[a.id] ?? 0) + part;
      }
      const target = s.accounts
        .filter((a) => a.bucket === "roth" && ownerOf(a) === c.personId)
        .sort((x, y) => (startBalance.get(y.id) as number) - (startBalance.get(x.id) as number) || (x.id < y.id ? -1 : 1))[0];
      if (target === undefined) throw new RangeError("a conversion with no Roth account is not exercised by the sheets");
      convIn[target.id] = (convIn[target.id] ?? 0) + amount;
      if (!rothFirstFunded.has(c.personId)) rothFirstFunded.set(c.personId, year);
      conversions += amount;
    }
    const available: Record<string, number> = {};
    for (const a of s.accounts) available[a.id] = (balance.get(a.id) as number) - (rmd[a.id] ?? 0) - (convOut[a.id] ?? 0);

    // Early-distribution shares of the period (a full year starts at month index 12 × year).
    const periodStart = monthIndex(year, 1);
    const earlyShare = (a: AccountSpec, months: number): number => {
      const owner = ownerOf(a);
      if (owner === "joint") return 0;
      const p = person(owner);
      return clamp01((monthIndex(p.birthYear, p.birthMonth) + months - periodStart) / 12);
    };

    // 5. Tiers of the default order.
    const ofBucket = (b: Bucket) => s.accounts.filter((a) => a.bucket === b);
    const avail = (a: AccountSpec): number => available[a.id] as number;
    const cashAccounts = ofBucket("cash");
    const cashTotal = cashAccounts.reduce((sum, a) => sum + avail(a), 0);
    const reserve = s.cashReserve * cpiStart;
    const aboveReserve = Math.max(0, cashTotal - reserve);
    const hsaLiving = ofBucket("hsa").filter((a) => alive(a.owner) || ownerOf(a) !== a.owner);
    const hsaTotal = hsaLiving.reduce((sum, a) => sum + avail(a), 0);
    const hsaQualified = Math.min(hsaTotal, healthcare);
    for (const a of ofBucket("roth")) {
      if (avail(a) <= 0) continue;
      const owner = ownerOf(a);
      const funded = rothFirstFunded.get(owner);
      if (earlyShare(a, 714) > 0 || funded === undefined || year < funded + 5) {
        throw new RangeError(`${a.id}: a Roth withdrawal that is not wholly free is not exercised by the sheets`);
      }
    }
    const tier = (kind: Tier["kind"], caps: Array<{ id: string; cap: number }>): Tier => ({
      kind,
      caps,
      total: caps.reduce((sum, c) => sum + c.cap, 0),
    });
    const preTax = ofBucket("pre_tax");
    if (preTax.some((a) => earlyShare(a, 714) > 0 && avail(a) > 0)) {
      throw new RangeError("an early pre-tax withdrawal is not exercised by the sheets");
    }
    const tiers: Tier[] = [
      tier("cash", cashAccounts.map((a) => ({ id: a.id, cap: cashTotal > 0 ? (avail(a) * aboveReserve) / cashTotal : 0 }))),
      tier("hsa_qualified", hsaLiving.map((a) => ({ id: a.id, cap: hsaTotal > 0 ? (avail(a) * hsaQualified) / hsaTotal : 0 }))),
      tier("taxable", ofBucket("taxable").map((a) => ({ id: a.id, cap: avail(a) }))),
      tier("pre_tax", preTax.map((a) => ({ id: a.id, cap: avail(a) }))),
      tier("roth_free", ofBucket("roth").map((a) => ({ id: a.id, cap: avail(a) }))),
      tier("cash", cashAccounts.map((a) => ({ id: a.id, cap: cashTotal > 0 ? avail(a) - (avail(a) * aboveReserve) / cashTotal : 0 }))),
      // Tiers 7 and 8 (early pre-tax, Roth beyond the free part) are empty: refused above.
      tier(
        "hsa_taxable",
        ofBucket("hsa").map((a) => {
          const q = hsaLiving.includes(a) && hsaTotal > 0 ? (avail(a) * hsaQualified) / hsaTotal : 0;
          return { id: a.id, cap: avail(a) - q };
        }),
      ),
    ];
    const everything = tiers.reduce((sum, tr) => sum + tr.total, 0);
    const rmdTotal = Object.values(rmd).reduce((sum, v) => sum + v, 0);

    // The year's totals for a withdrawal x: trades, investment income and the tax.
    let evaluations = 0;
    const evaluate = (x: number) => {
      evaluations++;
      const drawn = fill(tiers, x);
      let gains = 0;
      let dividends = 0;
      let coupons = 0;
      const trades = new Map<string, ReturnType<typeof taxableTrades>>();
      for (const a of ofBucket("taxable")) {
        const tr = taxableTrades(taxable.get(a.id) as TaxableState, a.weights, drawn.amount[a.id] ?? 0);
        trades.set(a.id, tr);
        gains += tr.gains;
        dividends += s.dividendYield * tr.bal.stocks;
        coupons += Math.max(0, prevBill + s.bondSpread) * tr.bal.bonds;
      }
      const preTaxExtra = Object.values(drawn.byKind.pre_tax).reduce((sum, v) => sum + v, 0);
      let hsaTaxable = 0;
      let hsaEarlyBase = 0;
      for (const a of ofBucket("hsa")) {
        const v = drawn.byKind.hsa_taxable[a.id] ?? 0;
        hsaTaxable += v;
        hsaEarlyBase += v * earlyShare(a, 780);
      }
      const qualifiedDividends = dividends * s.qualifiedShare;
      const input: TaxInput = {
        ordinaryNonInvestment: pension + rmdTotal + preTaxExtra + conversions + hsaTaxable,
        interest: coupons + interestCarried,
        qualifiedDividends,
        ordinaryDividends: dividends - qualifiedDividends,
        gains,
        benefits,
        nAged,
        earlyBase: 0,
        hsaEarlyBase,
      };
      const tax = federalTax(law, input);
      const net = incomeTotal + rmdTotal + x - need - tax.totalFederalTax;
      return { x, drawn, trades, gains, dividends, qualifiedDividends, coupons, tax, net };
    };

    // The gross-up: nothing if net(0) ≥ 0; everything (and a shortfall) if net(everything) ≤ 0;
    // otherwise the root of net(x) = 0 by bisection, 200 halvings, keeping net ≥ 0 at the upper end.
    let chosen = evaluate(0);
    let surplus = 0;
    let shortfall = 0;
    if (chosen.net >= 0) {
      surplus = chosen.net;
    } else {
      const top = evaluate(everything);
      if (top.net <= 0) {
        chosen = top;
        shortfall = Math.min(need, -top.net);
      } else {
        let lo = 0;
        let hi = everything;
        for (let k = 0; k < 200; k++) {
          const mid = lo + (hi - lo) / 2;
          if (evaluate(mid).net >= 0) hi = mid;
          else lo = mid;
        }
        chosen = evaluate(hi);
      }
    }
    maxEvaluations = Math.max(maxEvaluations, evaluations);

    // 6, 7. Trades, the surplus deposit, investment income to basis, returns.
    const growth = (a: Asset): number => 1 + s.returns[a];
    const withdrawals: Record<string, number> = {};
    const ending: Record<string, number> = {};
    const basisOut: Record<string, Record<Asset, number>> = {};
    let nextInterest = 0;
    for (const a of s.accounts) {
      const drawnHere = chosen.drawn.amount[a.id] ?? 0;
      withdrawals[a.id] = drawnHere + (rmd[a.id] ?? 0);
      if (a.bucket === "taxable") {
        const tr = chosen.trades.get(a.id) as ReturnType<typeof taxableTrades>;
        const bal = { ...tr.bal };
        const basis = { ...tr.basis };
        basis.stocks += s.dividendYield * tr.bal.stocks;
        basis.bonds += Math.max(0, prevBill + s.bondSpread) * tr.bal.bonds;
        if (surplus > 0 && surplusAccount !== undefined && surplusAccount.id === a.id) {
          for (const k of ASSETS) {
            bal[k] += surplus * a.weights[k];
            basis[k] += surplus * a.weights[k];
          }
        }
        const billInterest = bal.bills * s.returns.bills;
        nextInterest += billInterest;
        basis.bills += billInterest;
        const end = { stocks: bal.stocks * growth("stocks"), bonds: bal.bonds * growth("bonds"), bills: bal.bills * growth("bills") };
        taxable.set(a.id, { bal: end, basis });
        basisOut[a.id] = { ...basis };
        ending[a.id] = end.stocks + end.bonds + end.bills;
      } else {
        const after = (balance.get(a.id) as number) - (withdrawals[a.id] as number) - (convOut[a.id] ?? 0) + (convIn[a.id] ?? 0);
        if (a.bucket === "cash") nextInterest += after * a.weights.bills * s.returns.bills;
        let end = 0;
        for (const k of ASSETS) end += a.weights[k] * after * growth(k);
        ending[a.id] = end;
      }
      balance.set(a.id, ending[a.id] as number);
    }
    if (surplus > 0 && surplusAccount === undefined) throw new RangeError("a surplus with no taxable account is not exercised by the sheets");

    const endTotal = s.accounts.reduce((sum, a) => sum + (ending[a.id] as number), 0);
    const cpiEnd = cpi[t + 1] as number;
    const withdrawalsTotal = s.accounts.reduce((sum, a) => sum + (withdrawals[a.id] as number), 0);
    const growthAmount = endTotal - (previousTotal + surplus - withdrawalsTotal);
    const funded = need - shortfall;
    let coreFunded = core;
    if (shortfall > 0) {
      let left = funded;
      for (const part of [healthcare, longTermCare, goals]) left -= Math.min(left, part);
      coreFunded = left;
      if (depletionYear < 0) depletionYear = year;
    }
    lifetimeShortfallReal += shortfall / cpiStart;
    lifetimeFundedReal += funded / cpiStart;
    lifetimeTaxReal += chosen.tax.totalFederalTax / cpiStart;

    rows.push({
      year,
      t,
      ages,
      filing,
      cpiStart,
      cpiEnd,
      ss,
      pension,
      incomeTotal,
      planned,
      healthcare,
      longTermCare,
      goals,
      floor: need,
      funded,
      core: coreFunded,
      shortfall,
      surplus,
      withdrawals,
      rmd,
      withdrawalsTotal,
      rmdTotal,
      conversions,
      realizedGains: chosen.gains,
      dividends: chosen.dividends,
      qualifiedDividends: chosen.qualifiedDividends,
      coupons: chosen.coupons,
      interestCarried,
      tax: chosen.tax,
      law,
      ending,
      basis: basisOut,
      endTotal,
      endTotalReal: endTotal / cpiEnd,
      growth: growthAmount,
      withdrawalRate: previousTotal !== 0 ? (withdrawalsTotal - surplus) / previousTotal : 0,
      portfolioReturn: endTotal - growthAmount !== 0 ? growthAmount / (endTotal - growthAmount) : 0,
      startTotal: previousTotal,
    });

    // 8. A death at the year end: the basis of taxable accounts moves toward value (r2.md §2.12).
    for (const p of s.persons) {
      if (p.lastAliveYear !== year) continue;
      const survivor = s.persons.find((q) => q.id !== p.id && q.lastAliveYear > year);
      if (survivor === undefined) continue;
      for (const a of ofBucket("taxable")) {
        const share = a.owner === "joint" ? s.jointBasisShare : a.owner === p.id ? 1 : 0;
        const st = taxable.get(a.id) as TaxableState;
        for (const k of ASSETS) st.basis[k] = st.basis[k] + share * (st.bal[k] - st.basis[k]);
      }
      const funded = rothFirstFunded.get(p.id);
      const own = rothFirstFunded.get(survivor.id);
      if (funded !== undefined) rothFirstFunded.set(survivor.id, own === undefined ? funded : Math.min(own, funded));
    }

    interestCarried = nextInterest;
    prevBill = s.returns.bills;
    previousTotal = endTotal;
  }

  const last = rows[rows.length - 1] as YearRow;
  return {
    scenario: s,
    rows,
    ss: ssChain,
    startTotal,
    endNominal: last.endTotal,
    endReal: last.endTotalReal,
    success: depletionYear < 0,
    depletionYear,
    lifetimeShortfallReal,
    lifetimeFundedReal,
    lifetimeTaxReal,
    maxEvaluations,
  };
}

export type { YearLaw };
